"""A5 served report display reports on the real page, API and ledger (REQ-A-DISPLAY / A-BROWSER-SHOWN).

The production stack serves main.html, the bundle and report-view-observation.js over the real HTTPS entry; the reader
signs in through the real BFF and acts as a person does (row clicks, Back, scrolling the History list, Show Citations,
another tab, Log Out and a second account). The witness is PostgreSQL: every provide-prepared and client-shown entry is
read back from emr_access.access_entry and compared with what the page shows. Playwright only delays or drops external
transport (a held version read, a dropped acknowledgement); no markup or script is injected and no state is read from the
module. The page's display report is a browser report, not proof that a person read the text.

Cases:
  01 Related Source: only the version the Source shows is reported (the read provided both); Back and re-entry, a
     re-render of the same opening, add nothing.
  02 A lost acknowledgement: the next existing chance (re-entering the mode) resends the same event, and the ledger keeps
     one entry.
  03 A late answer of an earlier Source selection (A -> B -> A) is never reported; choosing another Source ends the
     shown Source's opening, so B shown again is a new display.
  04 History: only rows on screen are reported, scrolling reports the rest, Show Citations reports the evidence block,
     scrolling back adds nothing, and reopening is a new opening with new events on new provisions.
  05 Account switch: a report the first account never delivered is not sent under the second account; the second
     account's display names its own provision.
  06 A Source answer drawn while the reader's tab is in the background is reported only once the tab is visible again.
     Playwright keeps the pages of its own contexts visible (focus emulation), so this case signs in through the first
     tab of a Chromium started for it and reached with connect_over_cdp(no_defaults=True), where a tab behind another
     tab is really hidden.
  07 A Source answer drawn while Unmatched Studies (a class-based modal) covers the page is reported once the reader
     closes the modal, as the same single event.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "tests/e2e"))

from playwright.sync_api import expect  # noqa: E402
from invariants_live import psql  # noqa: E402
import test_worklist as base  # noqa: E402

EVIDENCE = ROOT / "tmp/emr-a/report-observation-browser"
OBSERVATIONS = re.compile(r"/api/studies/[0-9.]+/view-observations$")
# Six lines per version: a History row is then taller than a few lines and the 60vh list scrolls with eight versions.
LINES = "\n".join("SYN A5 HISTORY LINE %d" % n for n in range(1, 7))


class ReportObservationBrowser(base.WorklistE2E):
    # -- ledger witness -----------------------------------------------------------------------------------------------
    def ledger(self, uid, action):
        self.assertRegex(uid, r"^[0-9.]+$")
        self.assertIn(action, ("provide-prepared", "client-shown"))
        rows = psql("SELECT (payload::jsonb)::text FROM emr_access.access_entry WHERE payload::jsonb->>'branch' = 'local-read' "
                    f"AND payload::jsonb->>'action' = '{action}' AND payload::jsonb->'targets'->0->'studyId'->>'value' = '{uid}' "
                    "ORDER BY sequence;")
        return [json.loads(row) for row in rows]

    def provisions(self, uid):
        return {event["eventId"]: event for event in self.ledger(uid, "provide-prepared")}

    def shown(self, uid):
        return self.ledger(uid, "client-shown")

    def wait_ledger(self, page, read, predicate, what, timeout=15000):
        # The suite's own server wait (WorklistE2E.wait_state): 15 s, polled every 150 ms.
        deadline = time.monotonic() + timeout / 1000
        while True:
            value = read()
            if predicate(value):
                return value
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not in the ledger; last {json.dumps(value, default=str)[:600]}")
            page.wait_for_timeout(150)

    @staticmethod
    def target(event):
        t = event["targets"][0]
        return t["kind"], t["versionId"]["value"]

    # -- page ---------------------------------------------------------------------------------------------------------
    def reports(self, page):
        """Every display report the page sends, with the status of its answer (None while open or lost)."""
        sent = []

        def request(r):
            if r.method == "POST" and OBSERVATIONS.search(r.url):
                sent.append({"url": r.url, "body": r.post_data_json, "status": None, "request": r})

        def response(r):
            # A resend carries the same body as the lost one, so the answer is matched to its own request.
            for item in sent:
                if item["request"] is r.request:
                    item["status"] = r.status

        page.on("request", request)
        page.on("response", response)
        return sent

    @staticmethod
    def settle(page):
        """Two rendering steps and a task: the viewport observer's notifications for what is on screen now have run."""
        for _ in range(2):
            page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))))")

    def evidence(self, page, name, **data):
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(EVIDENCE / f"{self._testMethodName}-{name}.png"))
        if data:
            (EVIDENCE / f"{self._testMethodName}-{name}.json").write_text(json.dumps(data, indent=2, ensure_ascii=False),
                                                                          encoding="utf-8")

    def commit_version(self, fixture, action, base_version, findings):
        result = self.stack.request("POST", f"/studies/{fixture.uid}/report/commit", "doctor", {
            "action": action, "baseVersion": base_version, "findings": findings, "conclusion": "SYN A5 conclusion",
            "recommendation": ""})
        self.assertEqual(result.status, 201, result.text[:300])

    def pair(self, findings=("SYN A5 SOURCE SAVED v1", "SYN A5 SOURCE APPROVED v2")):
        """A Target and a Source of one synthetic patient; the Source has a saved v1 and an approved v2."""
        patient = "A5-" + uuid.uuid4().hex[:16]
        target, source = self.fixture(patient_id=patient), self.fixture(patient_id=patient)
        self.commit_version(source, "save", 0, findings[0])
        self.commit_version(source, "approve", 1, findings[1])
        return target, source

    def open_source(self, page, source, text):
        row = page.locator(f'#relrows tr[data-uid="{source.uid}"]')
        expect(row).to_be_visible()
        row.locator("td").first.click()
        expect(page.locator("#related-mode")).to_be_visible()
        expect(page.locator('#related-mode [data-related-source="findings"]')).to_have_text(text)

    def text_in_background(self, page, selector, text, timeout=15000):
        # A background tab paints nothing, so the locator waits (frame driven) are not used there; the DOM is read directly.
        deadline = time.monotonic() + timeout / 1000
        while page.evaluate("s => document.querySelector(s)?.textContent", selector) != text:
            if time.monotonic() >= deadline:
                self.fail(f"{selector} never showed {text!r}")
            time.sleep(0.15)

    def back(self, page):
        page.locator("#related-mode-back").click()
        expect(page.locator("#related-mode")).to_be_hidden()

    # -- cases --------------------------------------------------------------------------------------------------------
    def test_a5_01_related_source_reports_only_the_shown_version_once(self):
        target, source = self.pair()
        page = self.login()
        sent = self.reports(page)
        self.select(page, target)
        self.open_source(page, source, "SYN A5 SOURCE APPROVED v2")
        shown = self.wait_ledger(page, lambda: self.shown(source.uid), lambda v: len(v) >= 1, "the Source display")
        self.wait_ledger(page, lambda: sent, lambda v: len(v) == 1 and v[0]["status"] == 200, "the acknowledgement")
        provisions = self.provisions(source.uid)
        self.assertEqual(len(shown), 1)
        event = shown[0]
        provided = provisions[event["relatedEventId"]]
        # The read provided both stored versions; the screen shows v2 only, and only v2 is reported.
        self.assertEqual(self.target(event), ("report-version", "2"))
        self.assertEqual(event["targets"], provided["targets"])
        self.assertEqual({self.target(p) for p in provisions.values()}, {("report-version", "1"), ("report-version", "2")})
        self.assertEqual(event["userId"]["value"]["subject"], self.stack.user_ids["doctor"])
        self.assertEqual([item["body"] for item in sent],
                         [{"accessRef": event["relatedEventId"], "eventId": event["eventId"], "shownAt": event["occurredAt"]}])
        self.evidence(page, "related", shown=shown)

        # Back and re-entry show the same opening again (no new read): the same display, nothing new.
        self.back(page)
        self.open_source(page, source, "SYN A5 SOURCE APPROVED v2")
        self.settle(page)
        self.assertEqual(len(sent), 1)
        self.assertEqual([e["eventId"] for e in self.shown(source.uid)], [event["eventId"]])

    def test_a5_02_a_lost_acknowledgement_resends_the_same_event(self):
        target, source = self.pair()
        page = self.login()
        sent = self.reports(page)
        lost = []

        def drop_first_reply(route):
            if route.request.method != "POST" or lost:
                route.fallback()
                return
            # The report reaches the server and is recorded; its reply never reaches the page.
            lost.append(route.fetch().status)
            route.abort("connectionreset")

        page.route(OBSERVATIONS, drop_first_reply)
        self.select(page, target)
        self.open_source(page, source, "SYN A5 SOURCE APPROVED v2")
        first = self.wait_ledger(page, lambda: self.shown(source.uid), lambda v: len(v) == 1, "the first report")[0]
        self.wait_ledger(page, lambda: lost, lambda v: v == [200], "the dropped acknowledgement")

        # The next existing chance: the reader leaves the mode and comes back to the same Source. (A list refresh that
        # re-reads the Source is such a chance too; either one resends the same event.)
        self.back(page)
        self.open_source(page, source, "SYN A5 SOURCE APPROVED v2")
        self.wait_ledger(page, lambda: sent, lambda v: len(v) >= 2 and v[-1]["status"] == 200, "the resend")
        self.assertEqual(sent[1]["body"], sent[0]["body"], "the resend is the same event")
        self.assertEqual(sent[0]["body"]["eventId"], first["eventId"])
        self.settle(page)
        self.assertEqual([e["eventId"] for e in self.shown(source.uid)], [first["eventId"]], "the ledger keeps one entry")
        self.assertEqual(len(sent), 2, "acknowledged, the event is not sent again")
        self.evidence(page, "resent", shown=self.shown(source.uid))

    def three(self):
        """A Target and two Sources (A, B) of one synthetic patient, each Source with one approved version."""
        patient = "A5-" + uuid.uuid4().hex[:16]
        target, first, second = (self.fixture(patient_id=patient) for _ in range(3))
        for fixture, text in ((first, "SYN A5 FIRST SOURCE"), (second, "SYN A5 SECOND SOURCE")):
            self.commit_version(fixture, "approve", 0, text)
        return target, first, second

    @staticmethod
    def hold(page, uid, held):
        """Holds the first version read of `uid` after the server answered it (the answer is kept, not yet delivered)."""
        def handler(route):
            if held or route.request.method != "GET":
                route.fallback()
                return
            held.append((route, route.fetch()))
        pattern = re.compile(r"/api/studies/%s/report/versions$" % re.escape(uid))
        page.route(pattern, handler)
        return lambda: page.unroute(pattern)

    def test_a5_03_a_late_answer_of_an_earlier_selection_is_never_reported(self):
        target, first, second = self.three()
        page = self.login()
        self.reports(page)
        self.select(page, target)
        self.open_source(page, first, "SYN A5 FIRST SOURCE")
        self.wait_ledger(page, lambda: self.shown(first.uid), lambda v: len(v) == 1, "the first display of A")
        self.open_source(page, second, "SYN A5 SECOND SOURCE")
        self.wait_ledger(page, lambda: self.shown(second.uid), lambda v: len(v) == 1, "the first display of B")

        # A -> B -> A: A's read is held; the reader moves to B and back to A; then the held answer of A arrives late.
        late = []
        # The route stays until the held answer is delivered: removing the last route turns interception off, which
        # releases a paused request at once (measured: the "late" answer then arrived before B was chosen).
        release = self.hold(page, first.uid, late)
        page.locator(f'#relrows tr[data-uid="{first.uid}"] td').first.click()
        self.wait_ledger(page, lambda: late, lambda v: len(v) == 1, "the held read of A")
        page.locator(f'#relrows tr[data-uid="{second.uid}"] td').first.click()
        expect(page.locator('#related-mode [data-related-source="findings"]')).to_have_text("SYN A5 SECOND SOURCE")
        # Choosing A in between ended B's opening: B shown again is a new display of B.
        self.wait_ledger(page, lambda: self.shown(second.uid), lambda v: len(v) == 2, "B shown again")
        page.locator(f'#relrows tr[data-uid="{first.uid}"] td').first.click()
        expect(page.locator('#related-mode [data-related-source="findings"]')).to_have_text("SYN A5 FIRST SOURCE")
        current = self.wait_ledger(page, lambda: self.shown(first.uid), lambda v: len(v) == 2, "the new opening of A")[1]
        route, answer = late[0]
        late_ref = answer.json()[0]["accessRef"]
        route.fulfill(response=answer)
        release()
        self.settle(page)
        self.assertNotEqual(current["relatedEventId"], late_ref, "the shown A is the new read")
        shown = self.shown(first.uid)
        self.assertNotIn(late_ref, [e["relatedEventId"] for e in shown], "a late answer of an earlier selection is not reported")
        self.assertEqual(len(shown), 2)
        self.evidence(page, "late", first=shown, second=self.shown(second.uid))

    def tab_browser(self):
        """The first tab of a Chromium of its own, in which a tab behind another tab is hidden as in a person's browser.

        Playwright turns on focus emulation for every page of the contexts it makes, which keeps each one "visible"
        (measured, Playwright 1.60: headless and headed, another page, a second tab, a minimized window). A browser's
        own default context reached through connect_over_cdp(no_defaults=True) is left as the browser runs it, so its
        background tab is "hidden". The same Playwright Chromium build is started here; visibility is not emulated and
        nothing is injected into the page.
        """
        profile = Path(tempfile.mkdtemp(prefix="kin-a5-tabs-"))
        self.addCleanup(shutil.rmtree, profile, True)
        # The arguments Playwright's own launch gives this suite that matter here: the stack's self-signed HTTPS entry
        # (ignore_https_errors), the sandbox off as Playwright launches it, software WebGL (--enable-unsafe-swiftshader).
        args = [self.pw.chromium.executable_path, f"--user-data-dir={profile}", "--remote-debugging-port=0",
                "--no-first-run", "--no-default-browser-check", "--ignore-certificate-errors", "--no-sandbox",
                "--enable-unsafe-swiftshader", "--window-size=1600,1050", "about:blank"]
        if os.environ.get("KIN_E2E_HEADED") != "1":
            args.insert(1, "--headless=new")
        process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def stop():
            process.terminate()
            try:
                process.wait(15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(15)
        self.addCleanup(stop)
        # Port 0: the browser picks a free port and writes it to DevToolsActivePort in its profile.
        port_file, deadline = profile / "DevToolsActivePort", time.monotonic() + 30
        while not (port_file.exists() and port_file.read_text().strip()):
            if process.poll() is not None or time.monotonic() >= deadline:
                self.fail(f"the tab browser did not start (exit {process.poll()})")
            time.sleep(0.1)
        browser = self.pw.chromium.connect_over_cdp(f"http://127.0.0.1:{port_file.read_text().split()[0]}", no_defaults=True)
        self.addCleanup(browser.close)
        return browser.contexts[0].pages[0]

    @staticmethod
    def wait_visibility(page, state, timeout=15):
        # Read directly: a hidden tab runs no rendering steps, so frame-driven waits are not used.
        deadline = time.monotonic() + timeout
        while page.evaluate("document.visibilityState") != state:
            if time.monotonic() >= deadline:
                raise AssertionError(f"the tab never became {state}")
            time.sleep(0.05)

    def test_a5_06_an_answer_drawn_in_a_background_tab_is_reported_once_visible(self):
        target, first, _ = self.three()
        page = self.login_page(self.tab_browser())
        # The reader's second tab in the same window.
        other = page.context.new_page()
        other.bring_to_front()
        self.wait_visibility(page, "hidden")
        page.bring_to_front()
        self.wait_visibility(page, "visible")
        sent = self.reports(page)
        # The Source read is held before it leaves the browser and sent on while the tab is hidden. (Route.fetch, which
        # the other cases use, goes through Playwright's own HTTP client; in this browser's default context that client
        # does not accept the stack's self-signed entry.)
        held = []
        pattern = re.compile(r"/api/studies/%s/report/versions$" % re.escape(first.uid))
        page.route(pattern, lambda route: held.append(route) if not held and route.request.method == "GET" else route.fallback())
        self.select(page, target)
        page.locator(f'#relrows tr[data-uid="{first.uid}"] td').first.click()
        expect(page.locator("#related-mode")).to_be_visible()
        self.wait_ledger(page, lambda: held, lambda v: len(v) == 1, "the held Source read")
        self.assertEqual(self.provisions(first.uid), {}, "the read has not reached the server yet")
        # The reader switches to the other tab; the read goes on, and its answer arrives and is drawn in the background.
        other.bring_to_front()
        self.wait_visibility(page, "hidden")
        # The route stays until the held read is sent on (removing it first would release the read at once).
        held[0].continue_()
        page.unroute(pattern)
        self.text_in_background(page, '#related-mode [data-related-source="findings"]', "SYN A5 FIRST SOURCE")
        provisions = self.provisions(first.uid)
        self.assertEqual(len(provisions), 1, "one read of the one stored version")
        provided = next(iter(provisions))
        # A report would go out within the page's own task after the draw; two seconds of wall clock give it every
        # chance, and A4 records a report in milliseconds on this stack.
        time.sleep(2)
        hidden = {"visibilityState": page.evaluate("document.visibilityState"),
                  "findings": page.evaluate("s => document.querySelector(s)?.textContent",
                                            '#related-mode [data-related-source="findings"]'),
                  "sent": [item["body"] for item in sent], "shown": self.shown(first.uid)}
        self.assertEqual(hidden["visibilityState"], "hidden")
        self.assertEqual(sent, [], "an answer drawn in a background tab is not a display")
        self.assertEqual(hidden["shown"], [])
        # The screen shows the other tab; the page's own state is the JSON (a hidden tab paints no frame to capture).
        self.evidence(other, "background-other-tab-front", hidden=hidden)
        # The page's clock just before the reader returns: the display report must be later.
        before = page.evaluate("new Date().toISOString()")

        page.bring_to_front()
        self.wait_visibility(page, "visible")
        shown = self.wait_ledger(page, lambda: self.shown(first.uid), lambda v: len(v) == 1, "the display once visible")
        self.wait_ledger(page, lambda: sent, lambda v: len(v) == 1 and v[0]["status"] == 200, "the acknowledgement")
        event = shown[0]
        self.assertEqual(event["relatedEventId"], provided, "the display names the read the background tab drew")
        self.assertEqual(self.target(event), ("report-version", "1"))
        self.assertEqual(event["targets"], self.provisions(first.uid)[provided]["targets"])
        self.assertEqual(event["userId"]["value"]["subject"], self.stack.user_ids["doctor"])
        self.assertEqual(sent[0]["body"], {"accessRef": provided, "eventId": event["eventId"], "shownAt": event["occurredAt"]})
        self.assertGreaterEqual(event["occurredAt"], before,"reported when the tab became visible, not when drawn")
        self.settle(page)
        self.assertEqual(len(sent), 1)
        self.assertEqual(len(self.shown(first.uid)), 1)
        self.evidence(page, "background-visible", shown=shown, before=before)
        other.close()

    def history_rows_on_screen(self, page):
        return page.evaluate("""() => {
          const list = document.querySelector('#hist-body').getBoundingClientRect();
          return [...document.querySelectorAll('#hist-body .ver')].filter(row => {
            const r = row.getBoundingClientRect();
            const top = Math.max(r.top, list.top, 0), bottom = Math.min(r.bottom, list.bottom, innerHeight);
            return bottom - top > 0;
          }).map(row => row.dataset.version);
        }""")

    def test_a5_04_history_reports_rows_on_screen_evidence_and_a_reopen(self):
        fixture = self.fixture()
        for version in range(8):
            self.commit_version(fixture, "save", version, f"SYN A5 v{version + 1}\n{LINES}")
        page = self.login()
        sent = self.reports(page)
        self.select(page, fixture)
        self.open_toolbar_group(page, "#b-history")
        page.locator("#b-history").click()
        expect(page.locator("#hist-body .ver")).to_have_count(8)
        self.settle(page)
        visible = self.history_rows_on_screen(page)
        self.assertTrue(0 < len(visible) < 8, f"the list scrolls: {visible}")
        by_version = lambda events: {self.target(e)[1] for e in events if self.target(e)[0] == "report-version"}
        shown = self.wait_ledger(page, lambda: self.shown(fixture.uid), lambda v: by_version(v) == set(visible),
                                 "the rows on screen")
        self.assertEqual(len(shown), len(visible), "one event per row on screen")
        provisions = self.provisions(fixture.uid)
        opening = {e["relatedEventId"] for e in shown}
        self.assertTrue(opening <= set(provisions))
        self.evidence(page, "history-top", visible=visible, shown=shown)

        # The reader scrolls the list: the rows that come on screen are reported, each once.
        page.locator("#hist-body").hover()
        page.mouse.wheel(0, 10000)
        self.settle(page)
        bottom = self.history_rows_on_screen(page)
        self.assertTrue(set(bottom) - set(visible), f"scrolling brought other rows on screen: {visible} -> {bottom}")
        expected = set(visible) | set(bottom)
        shown = self.wait_ledger(page, lambda: self.shown(fixture.uid), lambda v: by_version(v) == expected, "the scrolled rows")
        self.assertEqual(len(shown), len(expected))

        # Show Citations: the evidence block drawn for that version is its own display.
        cited = bottom[-1]
        page.locator(f'.vcite-btn[data-version="{cited}"]').click()
        expect(page.locator(f'.vcite-host[data-version="{cited}"] h5')).to_be_visible()
        evidence = self.wait_ledger(page, lambda: [e for e in self.shown(fixture.uid) if self.target(e)[0] == "report-evidence"],
                                    lambda v: len(v) == 1, "the evidence display")[0]
        self.assertEqual(self.target(evidence), ("report-evidence", cited))
        self.evidence(page, "history-citations", evidence=evidence)

        # Scrolling back is a re-render of this opening: nothing new.
        count = len(sent)
        page.mouse.wheel(0, -10000)
        self.settle(page)
        self.assertEqual(len(sent), count)
        self.assertEqual(len(self.shown(fixture.uid)), len(expected) + 1)

        # Close and reopen: a new opening reads again, and the rows on screen are new events on the new provisions.
        page.locator("#hist-close").click()
        before = {e["eventId"] for e in self.shown(fixture.uid)}
        self.open_toolbar_group(page, "#b-history")
        page.locator("#b-history").click()
        expect(page.locator("#hist-body .ver")).to_have_count(8)
        self.settle(page)
        again = self.history_rows_on_screen(page)
        fresh = self.wait_ledger(page, lambda: [e for e in self.shown(fixture.uid) if e["eventId"] not in before],
                                 lambda v: by_version(v) == set(again), "the reopened rows")
        self.assertEqual(len(fresh), len(again))
        self.assertFalse({e["relatedEventId"] for e in fresh} & set(provisions), "the reopen names its own provisions")
        self.wait_ledger(page, lambda: [item["status"] for item in sent], lambda v: all(s == 200 for s in v), "every acknowledgement")
        self.evidence(page, "history-reopen", fresh=fresh)

    def test_a5_05_an_account_switch_never_carries_a_report_over(self):
        target, source = self.pair()
        page = self.login("doctor")
        sent = self.reports(page)
        dropped = []

        def drop_before_the_server(route):
            # The first account's report never reaches the server.
            dropped.append(route.request.post_data_json)
            route.abort("connectionreset")

        page.route(OBSERVATIONS, drop_before_the_server)
        self.select(page, target)
        self.open_source(page, source, "SYN A5 SOURCE APPROVED v2")
        self.wait_ledger(page, lambda: dropped, lambda v: len(v) >= 1, "the first account's report")
        self.assertEqual(self.shown(source.uid), [])
        # Every attempt of the first account (a list refresh may resend it) is that one event, and none reached the server.
        self.assertEqual({(d["eventId"], d["accessRef"]) for d in dropped}, {(dropped[0]["eventId"], dropped[0]["accessRef"])})
        mark = []

        def unloaded():
            # The first account's document is gone: from here on, reports reach the server again.
            page.unroute(OBSERVATIONS)
            mark.append(len(sent))

        self.sign_in_again(page, "doctor2", before_login=unloaded)
        self.select(page, target)
        self.open_source(page, source, "SYN A5 SOURCE APPROVED v2")
        shown = self.wait_ledger(page, lambda: self.shown(source.uid), lambda v: len(v) == 1, "the second account's display")
        event = shown[0]
        self.assertEqual(event["userId"]["value"]["subject"], self.stack.user_ids["doctor2"])
        provided = self.provisions(source.uid)[event["relatedEventId"]]
        self.assertEqual(provided["userId"]["value"]["subject"], self.stack.user_ids["doctor2"], "its own provision")
        # The ledger can show the entry before Playwright has delivered the page's request event to this thread, so the
        # second account's own acknowledged report is awaited in the page's traffic too.
        second = self.wait_ledger(page, lambda: sent[mark[0]:], lambda v: any(item["status"] == 200 for item in v),
                                  "the second account's report in the page's traffic")
        self.assertIn(event["eventId"], [item["body"]["eventId"] for item in second])
        self.assertNotIn(dropped[0]["eventId"], [item["body"]["eventId"] for item in second])
        self.assertNotIn(dropped[0]["accessRef"], [item["body"]["accessRef"] for item in second])
        self.settle(page)
        self.assertEqual(len(self.shown(source.uid)), 1)
        self.evidence(page, "account-switch", shown=shown)

    def test_a5_07_a_source_drawn_under_a_modal_is_reported_when_the_modal_closes(self):
        # Unmatched Studies is the page's own class-based modal (it closes by dropping .show, with no close event and no
        # change of the Source's place on screen); only an administrator opens it.
        target, source = self.pair()
        page = self.login("jmryu")
        sent = self.reports(page)
        held = []
        release = self.hold(page, source.uid, held)
        self.select(page, target)
        page.locator(f'#relrows tr[data-uid="{source.uid}"] td').first.click()
        expect(page.locator("#related-mode")).to_be_visible()
        self.wait_ledger(page, lambda: held, lambda v: len(v) == 1, "the held Source read")
        self.open_toolbar_group(page, "#m-unassigned")
        page.locator("#m-unassigned").click()
        expect(page.locator("#unmodal")).to_be_visible()
        route, answer = held[0]
        route.fulfill(response=answer)
        release()
        expect(page.locator('#related-mode [data-related-source="findings"]')).to_have_text("SYN A5 SOURCE APPROVED v2")
        self.settle(page)
        self.assertEqual(sent, [], "a Source drawn under an open modal is not a display")
        self.assertEqual(self.shown(source.uid), [])
        self.evidence(page, "under-modal")

        page.locator("#un-close").click()
        expect(page.locator("#unmodal")).to_be_hidden()
        shown = self.wait_ledger(page, lambda: self.shown(source.uid), lambda v: len(v) == 1, "the display once uncovered")
        self.wait_ledger(page, lambda: sent, lambda v: len(v) == 1 and v[0]["status"] == 200, "the acknowledgement")
        event = shown[0]
        provided = self.provisions(source.uid)[event["relatedEventId"]]
        self.assertEqual(self.target(event), ("report-version", "2"))
        self.assertEqual(event["targets"], provided["targets"])
        self.assertEqual(event["userId"]["value"]["subject"], self.stack.user_ids["jmryu"])
        self.assertEqual(provided["userId"]["value"]["subject"], self.stack.user_ids["jmryu"])
        self.assertEqual(sent[0]["body"], {"accessRef": event["relatedEventId"], "eventId": event["eventId"],
                                           "shownAt": event["occurredAt"]})
        self.settle(page)
        self.assertEqual(len(sent), 1)
        self.assertEqual(len(self.shown(source.uid)), 1)
        self.evidence(page, "uncovered", shown=shown)


def load_tests(loader, tests, pattern):
    # Only this module's cases; the inherited worklist cases run in their own module.
    return unittest.TestSuite(ReportObservationBrowser(name) for name in loader.getTestCaseNames(ReportObservationBrowser)
                              if name.startswith("test_a5_"))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
