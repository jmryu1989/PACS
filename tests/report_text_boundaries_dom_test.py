# coding: utf-8
"""U5S-REQ-04/13/17/22/23 -> U5S-RISK-DRAFT/APPLY/SUCCESS -> U5CLI-F01/F02/F05/F06/F07/F08/F09/F10, U5VW-F03 (main's half).

Real pages and public controls, using the existing DOM harness read-only. The fixture adds
independent stored drafts for study B; no product function is replaced or inspected.

Round 4 (U5CLI-F09/F10): text that this document's own controls put into the report editor (Paste, Clear, a template,
its shortcut, a dictation, a structured line, a quoted finding) is kept and saved - or asked about - like typed text;
a command that changes no text of this document (a refused or unconfirmed Approve, Save or Discard Draft, a refused
insertion) writes nothing and asks nothing; text typed while a save is out is not confirmed by that save; a study the
server no longer accepts is announced once and its text kept; the logout preparation's notice is a lease.
Stand-ins added here, named: the clipboard (the harness's), the media devices of a dictation (an audio context, a
worklet node and a microphone stream - nothing else of the browser), and the server's answers for a dictation, a
findings list, an insertion and a discard.
"""
import contextlib
import re
import unittest

import auth_logout_dom_test as h
from playwright.sync_api import expect

# The media devices a dictation records from. The capture ends with a short silent PCM buffer when Stop is pressed.
MEDIA = """(() => {
  class FakeAudioContext {
    constructor() { this.sampleRate = 16000; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    async resume() {}
    async close() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class FakeWorkletNode {
    constructor() {
      const node = this;
      this.port = { onmessage: null, close() {}, postMessage(message) {
        if (message && message.type === 'stop') Promise.resolve().then(() => node.port.onmessage &&
          node.port.onmessage({ data: { type: 'pcm', buffer: new Uint8Array(3200).buffer } }));
      } };
    }
    connect() {}
    disconnect() {}
  }
  const stream = () => {
    const track = { readyState: 'live', addEventListener() {}, removeEventListener() {}, stop() { this.readyState = 'ended'; } };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  Object.defineProperty(window, 'AudioContext', { configurable: true, writable: true, value: FakeAudioContext });
  Object.defineProperty(window, 'AudioWorkletNode', { configurable: true, writable: true, value: FakeWorkletNode });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream() } });
})();"""
DICTATION = {"available": True, "maxBytes": 1048576, "timeoutMs": 30000, "languagePin": "ko", "enginePin": "SYN-ENGINE",
             "modelPin": "SYN-MODEL"}
DICTATED = "SYN dictated sentence."
TEMPLATE = {"title": "SYN TEMPLATE", "shortcut": "synsc", "modality": "", "bodypart": "",
            "findings": "SYN template findings", "conclusion": "SYN template conclusion", "recommendation": ""}
FINDING = {"id": "11111111-1111-4111-8111-111111111111", "studyUid": h.UID, "revision": 1, "hidden": False,
           "authorActor": h.RAD["actor"], "updatedAt": "2026-10-03T00:00:00.000Z",
           "item": {"title": "SYN finding title", "text": "SYN finding text", "primary": 0, "sources": [
               {"itemId": "22222222-2222-4222-8222-222222222222", "revision": 1, "studyUid": h.UID, "seriesUid": "1.2.826.1",
                "sopUid": "1.2.826.1.1", "frame": 1, "kind": "arrow", "label": "SYN mark"}]},
           "links": [{"itemId": "22222222-2222-4222-8222-222222222222", "linkState": "current", "headRevision": 1}]}
SAVED_REPORT = {"version": 1, "rs": "T", "findings": "SYN-SAVED-V1 report", "conclusion": "", "recommendation": ""}
EMPTY = dict.fromkeys(h.FIELDS, "")


class Amended:
    """A route whose JSON answer the fixture amends before it is sent; the harness's handler still decides the answer."""

    def __init__(self, route, amend):
        self._route, self._amend = route, amend

    def __getattr__(self, name):
        return getattr(self._route, name)

    def fulfill(self, **kwargs):
        if isinstance(kwargs.get("json"), dict):
            kwargs["json"] = self._amend(dict(kwargs["json"]))
        return self._route.fulfill(**kwargs)


class MultiStudySite(h.Site):
    def __init__(self):
        super().__init__()
        self.second_study = True
        self.current_uid = h.UID
        self.other_state = ({}, {}, {"version": 0, "rs": "W"})
        self.bootstrap_states = None
        self.hidden = set()             # studies the list no longer shows (access removed, another institution)
        self.discard_answers = []       # DELETE draft of UID: (status, body) | "abort" | "lost" (done, answer lost)
        self.templates, self.dictation, self.findings = [], None, None
        self.dictations, self.sids = [], 0

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        body["studies"] = [row for row in body["studies"] if row["uid"] not in self.hidden]
        body["pagination"]["total"] = len(body["studies"])
        return body

    def write(self, body, account):
        """An insertion or a structured line is recorded with the same write: the server names the new id."""
        status, answer = super().write(body, account)
        row = self.rows.get(account["actor"])
        if status != 200 or row is None:
            return status, answer
        if "insert" in body:
            self.cids += 1
            row["citations"].append(f"SYN-CID-{self.cids}")
            return 200, {**self.envelope(account), "inserted": {"cid": row["citations"][-1],
                                                                 "insertedAt": "2026-10-03T00:00:00.000Z"}}
        if "structure" in body:
            self.sids += 1
            replaced = body["structure"].get("replacesSid")
            row["structured"] = [sid for sid in row["structured"] if sid != replaced] + [f"SYN-SID-{self.sids}"]
            return 200, {**self.envelope(account), "applied": {"sid": row["structured"][-1]}}
        return status, answer

    @contextlib.contextmanager
    def study(self, uid):
        previous = self.current_uid
        swap = uid != previous
        if swap:
            current = (self.revs, self.rows, self.report)
            self.revs, self.rows, self.report = self.other_state
            self.other_state = current
            self.current_uid = uid
        try:
            yield
        finally:
            if swap:
                current = (self.revs, self.rows, self.report)
                self.revs, self.rows, self.report = self.other_state
                self.other_state = current
                self.current_uid = previous

    def envelope(self, account):
        return {**super().envelope(account), "uid": self.current_uid}

    def study_row(self, account, uid=h.UID, name=h.PATIENT, patient="SYN-P-001"):
        with self.study(uid):
            row = super().study_row(account, uid, name, patient)
            row["state"] = self.state(account)
            return row

    def api(self, route, request, method, path, query):
        if method == "GET" and path == "/api/bootstrap" and (self.templates or self.dictation):
            route = Amended(route, lambda body: {**body, "templates": self.templates, "dictation": self.dictation})
        if method == "POST" and path == f"/api/studies/{h.UID}/dictation":
            self.dictations.append(request.headers.get("x-kin-session"))
            return route.fulfill(json={"text": DICTATED, "seconds": 0.1, "languagePin": DICTATION["languagePin"],
                                       "enginePin": DICTATION["enginePin"], "modelPin": DICTATION["modelPin"]})
        if method == "GET" and path == f"/api/studies/{h.UID}/findings" and self.findings is not None:
            return route.fulfill(json={"items": self.findings, "nextCursor": None}, headers={"X-KIN-Finding-Schema": "2"})
        if method == "DELETE" and path == f"/api/studies/{h.UID}/draft" and self.discard_answers:
            reply = self.discard_answers.pop(0)
            self.discards.append(request.post_data_json)
            if reply == "lost":             # the server discards the draft; its answer reaches nobody
                account = self.sessions[self.cookie]
                self.revs[account["actor"]] = self.revs.get(account["actor"], 0) + 1
                self.rows.pop(account["actor"], None)
            return route.abort("connectionreset") if reply in ("abort", "lost") else self.answer(route, *reply)
        if method == "GET" and path == "/api/bootstrap" and (self.bootstrap_states is not None or "states=omit" not in query):
            states = self.bootstrap_states
            if states is None:
                states = {h.UID: self.state(h.RAD)}
                with self.study(h.UID_B):
                    states[h.UID_B] = self.state(h.RAD)
            return route.fulfill(json={"states": states, "orders": [], "filters": [], "templates": [],
                "me": {"institution": h.INSTITUTION, "institutionName": "SYN Hospital A"}, "institutions": []})
        match = re.match(r"/api/studies/([^/]+)/", path)
        uid = match.group(1) if match else h.UID
        if uid == h.UID_B:
            # Playwright may dispatch another request while fulfill yields. Restore the fixture's study before
            # yielding, so another request (or the test's next server write) cannot accidentally use B's storage.
            actions = []
            class Answer:
                deferred = True
                def __getattr__(self, name):
                    return getattr(route, name)
                def fulfill(self, **kwargs):
                    return actions.append(("fulfill", kwargs)) if self.deferred else route.fulfill(**kwargs)
                def abort(self, error_code="failed"):
                    return actions.append(("abort", {"error_code": error_code})) if self.deferred else route.abort(error_code)
            answer = Answer()
            with self.study(uid):
                result = super().api(answer, request, method, path.replace(h.UID_B, h.UID), query)
            answer.deferred = False
            for action, kwargs in actions:
                getattr(route, action)(**kwargs)
            return result
        return super().api(route, request, method, path, query)

    def stored_for(self, uid):
        with self.study(uid):
            return self.stored()


class ReportTextBoundaries(h.LogoutDOMTest):
    def setUp(self):
        super().setUp()
        self.site = MultiStudySite()

    def switch(self, patient):
        self.page.locator("#rows tr", has_text=patient).first.click()

    def prepare_conflict(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.write({"findings": "SYN other document", "conclusion": "", "recommendation": "",
                         "baseVersion": 0, "citationIds": [], "structureIds": [],
                         "expectedOwner": h.owner_of(h.RAD), "expectedRevision": "SYNEPOCH1:0"}, h.RAD)
        self.page.clock.run_for(21000)
        expect(self.page.locator("#b-draft-keep")).to_be_visible()

    def test_held_write_of_a_and_unsent_b_finish_on_one_logout_click(self):
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["hold"]
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: self.site.held_puts, "A write")
        self.page.fill("#findings", "SYN B latest")
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Saving Draft")
        self.page.wait_for_timeout(300)
        self.assertEqual([], self.site.logouts)
        self.site.finish_put()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))
        self.assertEqual("SYN B latest", self.site.stored_for(h.UID_B)["findings"])
        self.assertEqual((1, []), (len(self.site.logouts), self.dialogs))

    def test_unknown_previous_study_is_named_and_retained_until_retry(self):
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["abort"]
        self.site.draft_read_answers = ["abort"] * 10
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: len(self.site.draft_reads) >= 2, "uncertain A read")
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.UID)
        expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.PATIENT)
        self.assertEqual(([], None), (self.site.logouts, self.site.stored_for(h.UID)))
        self.site.draft_read_answers = []
        self.panel_button("Retry").click()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))

    def test_refused_previous_study_survives_back_to_editing(self):
        self.open_main()
        self.select_and_type()
        self.site.put_answers = [(403, {"code": "SYN_REFUSED"})] * 2
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: len(self.site.puts) == 1, "refused A write")
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.UID)
        self.assertEqual([], self.site.logouts)
        self.panel_button("Back to Editing").click()
        self.switch(h.PATIENT)
        self.assertEqual(h.FIELDS, self.editor())

    def test_conflicted_previous_study_needs_explicit_choice(self):
        self.prepare_conflict()
        self.page.fill("#findings", "SYN latest after conflict")
        self.switch(h.PATIENT_B)
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.UID)
        self.assertEqual([], self.site.logouts)
        self.panel_button("Overwrite Server Draft").click()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual("SYN latest after conflict", self.site.stored_for(h.UID)["findings"])

    def test_session_end_recovers_all_studies_for_each_unconfirmed_outcome(self):
        for outcome in ("hold", "abort", "refused", "conflict"):
            with self.subTest(outcome=outcome):
                self.fresh_context()
                self.site = MultiStudySite()
                if outcome == "conflict":
                    self.prepare_conflict()
                else:
                    self.open_main()
                    self.select_and_type()
                    self.site.put_answers = [(403, {"code": "SYN_REFUSED"})] if outcome == "refused" else [outcome]
                    if outcome == "abort":
                        self.site.draft_read_answers = ["abort"]
                self.switch(h.PATIENT_B)
                self.wait_until(lambda: self.site.puts, "A write")
                self.page.fill("#findings", "SYN B recovery")
                self.site.ended.add(self.site.cookie)
                if outcome == "hold":
                    self.site.refuse(self.site.held_puts.pop()[0], 401, "AUTH_SESSION_ENDED")
                else:
                    self.page.evaluate("""session => {
                      const channel = new BroadcastChannel('kin-session');
                      channel.postMessage({type:'session-ended',session,operation:1,status:'ending'}); channel.close();
                    }""", self.site.cookie)
                expect(self.panel_title()).to_have_text("Session Ended")
                expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.UID)
                expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.UID_B)
                expect(self.page.locator("dialog.kin-logout")).not_to_contain_text(h.PATIENT)
                self.assertEqual([], self.site.logouts)
                self.site.account = h.RAD
                self.panel_button("Recover Draft").click()
                if outcome == "conflict":
                    self.panel_button("Overwrite Server Draft").click()
                self.page.wait_for_url(h.INDEX_URL)
                self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))
                self.assertEqual("SYN B recovery", self.site.stored_for(h.UID_B)["findings"])
                self.assertNotIn(self.site.cookie, self.site.ended)

    def test_conflict_then_typing_switch_and_keep_sends_latest_text(self):
        self.prepare_conflict()
        latest = "SYN latest typed after conflict"
        self.page.fill("#findings", latest)
        self.switch(h.PATIENT_B)
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value(latest)
        self.page.locator("#b-draft-keep").click()
        self.wait_until(lambda: self.site.stored_for(h.UID)["findings"] == latest, "latest text stored")
        self.assertEqual(latest, self.site.puts[-1]["findings"])
        self.assertEqual([], self.dialogs)

    def test_offline_typing_survives_study_change_and_cannot_be_logged_out_as_saved(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.list_answers = [(500, {"code": "SYN_OUTAGE"})] * 2
        self.page.clock.run_for(61000)
        expect(self.page.locator("#dbstat")).to_contain_text("서버 연결 끊김")
        latest = "SYN typed offline"
        self.page.fill("#findings", latest)
        self.switch(h.PATIENT_B)
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value(latest)
        expect(self.page.locator("#draftmsg")).not_to_contain_text("자동 저장됨")
        self.switch(h.PATIENT_B)
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        self.assertEqual([], self.site.logouts)
        self.assertNotEqual(latest, self.site.stored_for(h.UID)["findings"])

    def test_insertion_defers_sending_but_keeps_subsequent_typing(self):
        self.open_main()
        for part in ("citations", "structure"):
            self.site.gets[f"/api/studies/{h.UID}/report/{part}"] = (200, {
                "version": 0, "draftRevision": "SYNEPOCH1:0", "head": [], "draft": []})
        self.select_and_type()
        self.page.locator("#report-more > summary").click()
        self.page.locator("#b-structured").click()
        self.page.locator("#struct-value-text").fill("SYN technique")
        self.site.put_answers = ["hold"]
        self.page.locator("#struct-apply").click()
        self.wait_until(lambda: self.site.held_puts, "structured insertion")
        # The busy non-modal insertion panel may cover the fields; dispatch real input and row controls.
        latest = "SYN typed while insertion is out"
        self.page.locator("#findings").evaluate("(el, text) => { el.value=text; el.dispatchEvent(new Event('input',{bubbles:true})); }", latest)
        self.page.locator("#rows tr", has_text=h.PATIENT_B).first.evaluate("el => el.click()")
        self.page.locator("#rows tr", has_text=h.PATIENT).first.evaluate("el => el.click()")
        expect(self.page.locator("#findings")).to_have_value(latest)
        self.assertEqual(1, len(self.site.puts), "study switching must not send over the pending insertion")
        self.site.finish_put(status=503)
        self.page.wait_for_timeout(100)
        self.log_out_main()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(latest, self.site.stored_for(h.UID)["findings"])

    def test_conflict_clear_keeps_the_empty_edit_on_study_change(self):
        self.prepare_conflict()
        for field in h.FIELDS:
            self.page.fill("#" + field, "")
        self.switch(h.PATIENT_B)
        self.switch(h.PATIENT)
        self.assertEqual(dict.fromkeys(h.FIELDS, ""), self.editor())
        self.page.locator("#b-draft-keep").click()
        self.wait_until(lambda: self.site.stored_for(h.UID) is None, "explicit empty draft")

    def test_unselected_text_warns_before_navigation_away(self):
        self.open_main()
        self.select_and_type()
        self.site.put_answers = [(403, {"code": "SYN_REFUSED"})]
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: self.site.puts, "A refused")
        # Observe the browser event contract without destroying the captured document.
        cancelled = self.page.evaluate("""() => {
          const event = new Event('beforeunload', {cancelable: true});
          window.dispatchEvent(event); return event.defaultPrevented;
        }""")
        self.assertTrue(cancelled)

    def test_demo_navigation_still_keeps_its_local_draft(self):
        self.context.add_init_script("sessionStorage.setItem('kin-demo','1')")
        self.page.goto(h.MAIN_URL)
        self.page.locator("#rows tr", has_text="KIM CHULSOO").first.click()
        self.page.fill("#findings", "SYN demo local draft")
        self.page.evaluate("window.dispatchEvent(new Event('beforeunload', {cancelable:true}))")
        drafts = self.page.evaluate("Object.values(JSON.parse(localStorage.getItem('kin-app'))).map(row => row.draft)")
        self.assertTrue(any(d and d.get('findings') == 'SYN demo local draft' for d in drafts))
        self.assertEqual([], self.site.puts)

    def test_two_documents_have_distinct_preparations_and_matching_resume(self):
        self.open_main()
        self.select_and_type()
        other = self.open_main(self.watch(self.context.new_page()))
        self.select_and_type(other, fields=h.MORE)
        self.site.put_answers = ["hold", "hold"]
        self.log_out_main()
        self.wait_until(lambda: len(self.site.held_puts) == 1, "first preparation")
        self.log_out_main(other)
        self.wait_until(lambda: len(self.site.held_puts) == 2, "second preparation")
        first = next(p for p in self.posts() if p["type"] == "session-preparing")
        second = next(p for p in self.posts(other) if p["type"] == "session-preparing")
        self.assertNotEqual(first["preparation"], second["preparation"])
        self.assertEqual(first["session"], second["session"])
        self.panel_button("Back to Editing").click()
        resumed = next(p for p in self.posts() if p["type"] == "session-resumed")
        self.assertEqual(first["preparation"], resumed["preparation"])
        self.assertNotEqual(second["preparation"], resumed["preparation"])
        self.assertEqual("preparing", self.screen(other)["state"])

    def go_offline(self, elapsed=61000):
        self.site.list_answers = [(500, {"code": "SYN_OUTAGE"})] * 2
        self.page.clock.run_for(elapsed)
        expect(self.page.locator("#dbstat")).to_contain_text("서버 연결 끊김")

    def test_reconnect_keeps_and_saves_unselected_offline_text(self):
        for bootstrap in ("omitted", "included"):
            with self.subTest(bootstrap=bootstrap):
                self.fresh_context()
                self.site = MultiStudySite()
                self.page.clock.install()
                self.open_main()
                self.select_and_type()
                self.go_offline()
                latest = "SYN offline unselected text"
                self.page.fill("#findings", latest)
                self.switch(h.PATIENT_B)
                if bootstrap == "included":
                    self.site.bootstrap_states = {h.UID: self.site.state(h.RAD)}
                self.page.clock.run_for(16000)
                expect(self.page.locator("#dbstat")).to_contain_text("DB Connected")
                self.wait_until(lambda: self.site.stored_for(h.UID)["findings"] == latest, "A saved without reselecting")
                self.switch(h.PATIENT)
                self.assertEqual({**h.FIELDS, "findings": latest}, self.editor())
                self.assertEqual([], self.dialogs)

    def test_late_refresh_and_poll_merge_facts_without_losing_unconfirmed_text(self):
        for arrival in ("refresh", "poll", "poll with arrival"):
            with self.subTest(arrival=arrival):
                self.fresh_context()
                self.site = MultiStudySite()
                self.page.clock.install()
                self.open_main()
                self.site.held_lists = []
                if arrival == "refresh":
                    self.refresh()
                else:
                    self.page.clock.run_for(31000)
                self.wait_until(lambda: self.site.held_lists, "list read held before editing")
                route, account = self.site.held_lists.pop()
                self.site.held_lists = None
                self.select_and_type()
                self.site.put_answers = ["hold"]
                self.switch(h.PATIENT_B)
                self.wait_until(lambda: self.site.held_puts, "unconfirmed A write")
                self.site.write({**h.MORE, "baseVersion": 0, "citationIds": [], "structureIds": [],
                    "expectedOwner": h.owner_of(h.RAD), "expectedRevision": "SYNEPOCH1:0"}, h.RAD)
                self.site.report.update(version=4, rs="T")
                body = self.site.list_body(account, rename="SYN PATIENT UPDATED")
                body["studies"][0]["count"] = 42
                if arrival == "poll with arrival":
                    body["studies"].append({**body["studies"][0], "uid": h.UID + ".3", "name": "SYN NEW ARRIVAL"})
                    body["studies"].sort(key=lambda row: row["uid"])
                    body["pagination"]["total"] += 1
                self.site.answer(route, 200, body)
                patient = h.PATIENT if arrival == "poll" else "SYN PATIENT UPDATED"
                row = self.page.locator("#rows tr", has_text=patient).first
                expect(row.get_by_role("cell", name="42", exact=True)).to_be_visible()
                expect(row.get_by_role("cell", name="T", exact=True)).to_be_visible()
                row.click()
                self.assertEqual(h.FIELDS, self.editor())
                self.assertEqual("SYNEPOCH1:0", self.site.puts[0]["expectedRevision"])
                self.site.finish_put()
                expect(self.page.locator("#b-draft-keep")).to_be_visible()
                self.assertEqual(h.FIELDS, self.editor())
                self.page.locator("#b-draft-keep").click()
                self.wait_until(lambda: self.site.stored_for(h.UID) == h.FIELDS, "explicitly kept A text")
                self.assertEqual((0, "SYNEPOCH1:1"),
                                 (self.site.puts[-1]["baseVersion"], self.site.puts[-1]["expectedRevision"]))

    def test_reconnect_preserves_open_conflict_and_latest_attempt(self):
        self.prepare_conflict()
        latest = "SYN conflict typed offline"
        self.go_offline(41000)
        self.page.fill("#findings", latest)
        self.switch(h.PATIENT_B)
        self.site.bootstrap_states = {h.UID: self.site.state(h.RAD)}
        puts = len(self.site.puts)
        self.page.clock.run_for(16000)
        expect(self.page.locator("#dbstat")).to_contain_text("DB Connected")
        self.assertEqual(puts, len(self.site.puts), "reconnect cannot resolve another document's conflict")
        self.assertEqual("SYN other document", self.site.stored_for(h.UID)["findings"])
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value(latest)
        expect(self.page.locator("#b-draft-keep")).to_be_visible()
        self.page.locator("#b-draft-keep").click()
        self.wait_until(lambda: self.site.stored_for(h.UID)["findings"] == latest, "latest conflict attempt stored")

    def test_reconnect_keeps_unknown_outcome_until_authoritative_read(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["abort"]
        self.site.draft_read_answers = ["abort"] * 20
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: self.site.puts and len(self.site.draft_reads) >= 2, "A uncertain")
        self.go_offline()
        self.site.bootstrap_states = {h.UID: self.site.state(h.RAD)}
        puts = len(self.site.puts)
        self.page.clock.run_for(16000)
        expect(self.page.locator("#dbstat")).to_contain_text("DB Connected")
        self.assertEqual(puts, len(self.site.puts), "bootstrap is not an authoritative draft confirmation")
        self.switch(h.PATIENT)
        self.assertEqual(h.FIELDS, self.editor())
        self.site.draft_read_answers = []
        self.log_out_main()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))

    def test_legacy_demo_text_never_becomes_an_authenticated_draft(self):
        self.context.add_init_script("""localStorage.setItem('kin-app', JSON.stringify({
            '""" + h.UID + """': {draft: {findings:'SYN DEMO PRIVATE', conclusion:'', recommendation:'', baseVersion:0}}
        }));""")
        self.open_main()
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value("")
        self.assertEqual([], self.site.puts)
        backups = self.page.evaluate("Object.keys(localStorage).filter(k => k.startsWith('kin-app-backup-')).map(k => localStorage[k])")
        self.assertTrue(any("SYN DEMO PRIVATE" in value for value in backups))

    def other_document_saves(self, page, text):
        page.locator("#rows tr", has_text=h.PATIENT).first.click()
        page.fill("#findings", text)
        page.locator("#rows tr", has_text=h.PATIENT_B).first.click()
        self.wait_until(lambda: self.site.stored_for(h.UID) and self.site.stored_for(h.UID)["findings"] == text,
                        "other document's draft stored", page=page)

    def test_idle_document_observes_other_drafts_without_writes_warnings_or_logout_questions(self):
        for selected in (False, True):
            with self.subTest(study_stays_selected=selected):
                self.fresh_context()
                self.site = MultiStudySite()
                self.page.clock.install()
                a = self.open_main()
                self.switch(h.PATIENT)
                expect(a.locator("#findings")).to_be_editable()
                if not selected:
                    self.switch(h.PATIENT_B)
                b = self.watch(self.context.new_page())
                b.clock.install()
                self.open_main(b)
                sent, toasts = [], []
                a.on("request", lambda r: sent.append(r.post_data_json) if r.method == "PUT" else None)
                a.expose_function("observe_toast", lambda text: toasts.append(text))
                a.evaluate("""() => new MutationObserver(() => {
                    const node = document.querySelector('#toast');
                    if (node.textContent.trim()) window.observe_toast(node.textContent);
                }).observe(document.querySelector('#toast'), {childList:true, subtree:true, characterData:true})""")
                self.other_document_saves(b, "SYN other v1")
                self.refresh(a)
                a.wait_for_timeout(150)
                self.other_document_saves(b, "SYN other v2")
                for _ in range(4):
                    a.clock.run_for(21000)
                    a.wait_for_timeout(150)
                cancelled = a.evaluate("""() => {
                    const e = new Event('beforeunload', {cancelable:true});
                    window.dispatchEvent(e); return e.defaultPrevented;
                }""")
                self.assertFalse(cancelled, "server observations must not prompt on leaving")
                self.switch(h.PATIENT)
                expect(a.locator("#findings")).to_have_value("SYN other v2")
                self.assertEqual(([], []), (sent, toasts))
                self.log_out_main(a)
                a.wait_for_url(h.INDEX_URL)
                self.assertEqual(([], [], 1), (sent, self.dialogs, len(self.site.logouts)))

    def test_observed_draft_is_the_baseline_of_the_next_real_edit(self):
        self.page.clock.install()
        a = self.open_main()
        self.switch(h.PATIENT)
        self.switch(h.PATIENT_B)
        b = self.watch(self.context.new_page())
        b.clock.install()
        self.open_main(b)
        self.other_document_saves(b, "SYN server v1")
        self.refresh(a)
        self.other_document_saves(b, "SYN server v2")
        self.refresh(a)
        self.switch(h.PATIENT)
        expect(a.locator("#findings")).to_have_value("SYN server v2")
        a.fill("#findings", "SYN my first edit after observation")
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: self.site.stored_for(h.UID)["findings"] == "SYN my first edit after observation",
                        "new edit saved on observed revision")
        self.assertEqual("SYNEPOCH1:2", self.site.puts[-1]["expectedRevision"])
        self.assertEqual([], self.dialogs)

    def test_real_edit_in_otherwise_idle_document_keeps_its_conflict_and_text(self):
        self.page.clock.install()
        a = self.open_main()
        self.select_and_type()
        self.site.put_answers = [(500, {"message": "SYN refused"})]
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: len(self.site.puts) == 1, "local switch write refused")
        b = self.watch(self.context.new_page())
        b.clock.install()
        self.open_main(b)
        self.other_document_saves(b, "SYN other v1")
        self.refresh(a)
        self.other_document_saves(b, "SYN other v2")
        for _ in range(3):
            a.clock.run_for(21000)
            a.wait_for_timeout(150)
        self.switch(h.PATIENT)
        self.assertEqual(h.FIELDS, self.editor())
        expect(a.locator("#b-draft-keep")).to_be_visible()
        self.assertEqual("SYN other v2", self.site.stored_for(h.UID)["findings"])
        self.switch(h.PATIENT_B)
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        expect(a.locator("dialog.kin-logout")).to_contain_text(h.PATIENT)
        self.assertEqual([], self.site.logouts)
        self.panel_button("Overwrite Server Draft").click()
        a.wait_for_url(h.INDEX_URL)
        self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))

    def test_version_conflict_load_latest_replaces_text_and_next_save_base(self):
        self.context.add_init_script(h.CLIPBOARD)
        self.open_main()
        self.select_and_type()
        self.site.report = {"version": 1, "rs": "T", "findings": "SYN server report v1",
                            "conclusion": "", "recommendation": ""}
        self.site.commit_answers = [(409, {"message": "그 사이 다른 사용자가 저장했습니다 (v1)"})]
        self.dialog_answers = [True]
        self.page.locator("#b-save").click()
        expect(self.page.locator("#findings")).to_have_value("SYN server report v1")
        self.assertEqual("\n\n".join(h.FIELDS.values()), self.page.evaluate("window.__synClipboard.written[0].text"))
        self.page.locator("#b-save").click()
        self.wait_until(lambda: len(self.site.commits) == 2, "next Save")
        self.assertEqual((1, "SYN server report v1"),
                         (self.site.commits[-1]["baseVersion"], self.site.commits[-1]["findings"]))

    def test_load_server_draft_replaces_conflict_and_does_not_resend_discarded_text(self):
        self.prepare_conflict()
        self.site.report.update(version=2, rs="T", findings="SYN final v2")
        self.site.rows[h.RAD["actor"]]["baseVersion"] = 2
        self.page.locator("#b-draft-load").click()
        expect(self.page.locator("#findings")).to_have_value("SYN other document")
        expect(self.page.locator("#b-draft-keep")).not_to_be_visible()
        puts = len(self.site.puts)
        self.page.clock.run_for(21000)
        self.assertEqual(puts, len(self.site.puts))
        self.page.locator("#b-save").click()
        self.wait_until(lambda: self.site.commits, "Save after server replacement")
        self.assertEqual((2, "SYN other document"),
                         (self.site.commits[-1]["baseVersion"], self.site.commits[-1]["findings"]))

    def test_discard_draft_takes_server_report_version(self):
        self.open_main()
        self.select_and_type()
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: self.site.stored_for(h.UID) == h.FIELDS, "draft saved")
        self.switch(h.PATIENT)
        self.site.report.update(version=3, rs="T", findings="SYN final v3")
        self.dialog_answers = [True]
        self.page.locator("#b-draft-discard").click()
        expect(self.page.locator("#findings")).to_have_value("SYN final v3")
        self.page.locator("#b-save").click()
        self.wait_until(lambda: self.site.commits, "Save after discard")
        self.assertEqual(3, self.site.commits[-1]["baseVersion"])

    def test_logout_saves_second_study_and_only_offers_first_failure(self):
        for action in ("Retry", "Discard and Log Out"):
            with self.subTest(action=action):
                self.fresh_context()
                self.site = MultiStudySite()
                self.open_main()
                self.select_and_type()
                self.site.put_answers = [(500, {"message": "SYN refused"})] * 2
                self.switch(h.PATIENT_B)
                self.wait_until(lambda: len(self.site.puts) == 1, "A refused")
                self.page.fill("#findings", "SYN B safe")
                self.log_out_main()
                expect(self.panel_title()).to_have_text("Draft Not Saved")
                self.assertEqual({"findings": "SYN B safe", "conclusion": "", "recommendation": ""},
                                 self.site.stored_for(h.UID_B))
                panel = self.page.locator("dialog.kin-logout")
                expect(panel).to_contain_text(h.PATIENT)
                expect(panel).not_to_contain_text(h.PATIENT_B)
                expect(panel).to_contain_text("받아들이지 않았습니다")
                self.assertEqual(3, len(self.site.puts))
                if action == "Discard and Log Out":
                    self.dialog_answers = [True]
                self.panel_button(action).click()
                self.page.wait_for_url(h.INDEX_URL)
                self.assertEqual("SYN B safe", self.site.stored_for(h.UID_B)["findings"])
                self.assertEqual(1, sum(p["findings"] == "SYN B safe" for p in self.site.puts))
                if action == "Retry":
                    self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))
                else:
                    self.assertIsNone(self.site.stored_for(h.UID))
                    self.assertIn("1건", self.dialogs[-1])
                    self.assertIn(h.PATIENT, self.dialogs[-1])
                    self.assertNotIn(h.PATIENT_B, self.dialogs[-1])

    def test_logout_lists_each_remaining_study_with_its_own_reason(self):
        self.open_main()
        self.select_and_type()
        self.site.put_answers = [(500, {"message": "SYN refused"})] * 2 + [
            (409, {"code": "REPORT_HELD", "message": "SYN held"})]
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: len(self.site.puts) == 1, "A refused")
        self.page.fill("#findings", "SYN B held")
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        lines = self.page.locator("dialog.kin-logout").inner_text().splitlines()
        self.assertTrue(any(h.PATIENT in line and "받아들이지 않았습니다" in line for line in lines))
        self.assertTrue(any(h.PATIENT_B in line and "다른 판독의" in line for line in lines))
        self.assertEqual((3, []), (len(self.site.puts), self.site.logouts))

    # ── round 4: U5CLI-F09 / F10, the reviewer's unverified paths, the preparation lease ──
    def collect_notices(self, page=None):
        """Every notice the page shows from now on, as (text, shown as an error)."""
        page = page or self.page
        notices = []
        page.expose_function("syn_notice", lambda text, error: notices.append((text, error)))
        page.evaluate("""() => new MutationObserver(() => {
            const node = document.querySelector('#toast');
            if (node.textContent.trim() && node.classList.contains('show'))
              window.syn_notice(node.textContent, node.classList.contains('err'));
        }).observe(document.querySelector('#toast'), {childList: true, subtree: true, characterData: true, attributes: true})""")
        return notices

    def leaving_asks(self, page=None):
        """Whether the page would ask before the browser leaves it (the beforeunload contract)."""
        return (page or self.page).evaluate("""() => {
            const event = new Event('beforeunload', {cancelable: true});
            window.dispatchEvent(event); return event.defaultPrevented;
        }""")

    def report_menu(self, control):
        """A control of the report toolbar; some sit in the More menu."""
        if not self.page.locator(control).is_visible():
            self.page.locator("#report-more > summary").click()
        return self.page.locator(control)

    def paste(self, text):
        reads = self.page.evaluate("() => window.__synClipboard.reads.length")
        self.report_menu("#b-paste").click()
        self.wait_until(lambda: self.page.evaluate("() => window.__synClipboard.reads.length") == reads + 1, "the clipboard read")
        self.page.evaluate("([index, text]) => window.__synClipboard.reads[index].resolve(text)", [reads, text])

    def open_untouched(self, report=None, draft=None):
        """A new document on study A with nothing typed. `draft` is a draft the reader stored earlier."""
        self.fresh_context()
        self.site = MultiStudySite()
        if report:
            self.site.report = dict(report)
        if draft:
            self.site.write({**draft, "baseVersion": self.site.report["version"], "citationIds": [], "structureIds": [],
                             "expectedOwner": h.owner_of(h.RAD), "expectedRevision": "SYNEPOCH1:0"}, h.RAD)
        for part in ("citations", "structure"):
            self.site.gets[f"/api/studies/{h.UID}/report/{part}"] = (200, {
                "version": self.site.report["version"], "draftRevision": self.site.revision(h.RAD["actor"]),
                "head": [], "draft": []})
        self.context.add_init_script(h.CLIPBOARD)
        self.context.add_init_script(MEDIA)
        self.page.clock.install()

    def select_untouched(self):
        self.open_main()
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_be_editable()

    def cross(self, boundary, saved):
        """Take the page across one boundary at which unsaved editor text was lost; `saved` is what the server must
        hold afterwards (study A's stored draft)."""
        if boundary == "poll":
            self.page.clock.run_for(31000)      # the autosave (20 s), then the list poll (30 s)
            self.wait_until(lambda: self.site.stored_for(h.UID) == saved, "the autosave")
            self.page.wait_for_timeout(300)
        elif boundary == "study switch":
            self.switch(h.PATIENT_B)
            self.wait_until(lambda: self.site.stored_for(h.UID) == saved, "the save on leaving the study")
            self.switch(h.PATIENT)
        elif boundary == "refresh":
            self.refresh()
            self.page.wait_for_timeout(400)

    BOUNDARIES = ("poll", "study switch", "refresh", "log out", "log out, save refused")

    def end_at(self, boundary, saved, kept):
        """Log out after the boundary: the text is stored, or - when the server refuses it - the person is asked."""
        if boundary == "log out, save refused":
            self.site.put_answers = [(403, {"statusCode": 403, "message": "SYN refused"})] * 2
            self.log_out_main()
            expect(self.panel_title()).to_have_text("Draft Not Saved")
            expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.PATIENT)
            self.assertEqual(([], kept), (self.site.logouts, self.editor()), "refused: nothing ends, the text stays")
            return
        self.log_out_main()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual((saved, 1), (self.site.stored_for(h.UID), len(self.site.logouts)))

    def test_pasted_text_in_an_untouched_study_is_saved_or_asked_at_every_boundary(self):
        pasted = {**EMPTY, "findings": "SYN-PASTED report text"}
        for boundary in self.BOUNDARIES:
            with self.subTest(boundary=boundary):
                self.open_untouched()
                self.select_untouched()
                self.paste(pasted["findings"])
                expect(self.page.locator("#findings")).to_have_value(pasted["findings"])
                self.cross(boundary, pasted)
                self.assertEqual(pasted, self.editor(), "the pasted text is no longer in the editor")
                self.end_at(boundary, pasted, pasted)
                self.assertEqual([], self.dialogs, "nothing is asked on the way")

    def test_a_cleared_draft_in_an_untouched_study_is_saved_or_asked_at_every_boundary(self):
        for boundary in self.BOUNDARIES:
            with self.subTest(boundary=boundary):
                self.open_untouched(draft=h.FIELDS)
                self.select_untouched()
                expect(self.page.locator("#findings")).to_have_value(h.FIELDS["findings"])
                asked = len(self.dialogs)
                self.dialog_answers = [True]
                self.report_menu("#b-clear").click()
                self.assertEqual(EMPTY, self.editor())
                # The cleared draft is the reader's edit: the server's draft row goes, and the old text does not come back.
                self.cross(boundary, None)
                self.assertEqual(EMPTY, self.editor(), "the cleared text came back")
                self.end_at(boundary, None, EMPTY)
                self.assertEqual(asked + 1, len(self.dialogs), "only Clear's own confirmation was asked")
                if boundary == "log out, save refused":
                    self.assertEqual(h.FIELDS, self.site.stored_for(h.UID), "the refused clear changed nothing on the server")

    def insert_template(self):
        self.page.locator("#tplrows tr", has_text=TEMPLATE["title"]).first.dblclick()
        return TEMPLATE["findings"]

    def insert_shortcut(self):
        # The typed shortcut is saved first, so what follows is the expansion alone.
        typed = {**EMPTY, "findings": TEMPLATE["shortcut"]}
        self.page.fill("#findings", typed["findings"])
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored_for(h.UID) == typed, "the typed shortcut autosaved")
        self.page.wait_for_timeout(300)
        self.page.locator("#findings").evaluate("el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }")
        self.page.keyboard.press("Tab")
        return TEMPLATE["findings"]

    def insert_dictation(self):
        self.page.locator("#b-dictate").click()
        self.page.locator("#dictation-stop").click()
        self.page.locator("#dictation-insert").click()
        self.assertEqual([self.site.cookie], self.site.dictations, "one recognition request, bound to the session")
        return DICTATED

    def insert_structured(self):
        self.report_menu("#b-structured").click()
        self.page.locator("#struct-value-text").fill("SYN technique")
        self.page.locator("#struct-apply").click()
        return "SYN technique"

    def insert_citation(self):
        self.page.locator("#reading-findings-open").click()
        self.page.locator("#reading-findings-list").get_by_role("button", name="Insert into Report").first.click()
        self.page.locator("#cite-preview-insert").click()
        return FINDING["item"]["text"]

    def test_each_insertion_by_a_control_is_recorded_like_typed_text(self):
        for kind in ("template", "shortcut", "dictation", "structured", "citation"):
            with self.subTest(insertion=kind):
                self.open_untouched()
                self.site.templates, self.site.dictation, self.site.findings = [TEMPLATE], DICTATION, [FINDING]
                self.select_untouched()
                inserted = getattr(self, "insert_" + kind)()
                expect(self.page.locator("#findings")).to_have_value(re.compile(re.escape(inserted)))
                shown = self.editor()
                # Nothing is typed after the insertion. The autosave stores exactly what the control put there and the
                # list poll does not replace it.
                self.page.clock.run_for(31000)
                self.wait_until(lambda: self.site.stored_for(h.UID) == shown, "the inserted text stored")
                self.page.wait_for_timeout(300)
                self.assertEqual(shown, self.editor(), "the poll replaced the inserted text")
                self.log_out_main()
                self.page.wait_for_url(h.INDEX_URL)
                self.assertEqual((shown, []), (self.site.stored_for(h.UID), self.dialogs))

    def test_text_typed_while_a_save_is_out_is_not_confirmed_by_that_save(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["hold"]
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.held_puts, "the autosave is out")
        later = {**h.FIELDS, "findings": h.FIELDS["findings"] + " SYN typed while the save was out"}
        self.page.fill("#findings", later["findings"])
        self.assertEqual(200, self.site.finish_put())
        self.wait_until(lambda: self.site.stored_for(h.UID) == h.FIELDS, "the earlier text stored")
        self.page.wait_for_timeout(300)
        # The server now holds the earlier text. A list read brings it; the later text is still this document's.
        self.refresh()
        self.page.wait_for_timeout(400)
        self.assertEqual(later, self.editor(), "the list read replaced text typed while the save was out")
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored_for(h.UID) == later, "the later text stored by the next autosave")
        # Saved text is said to be saved, with the time it was.
        expect(self.page.locator("#draftmsg")).to_contain_text(re.compile(r"\d{2}:\d{2}"))
        self.assertFalse(self.leaving_asks(), "everything is stored: leaving asks nothing")
        self.assertEqual([], self.dialogs)

    def test_a_refused_or_unconfirmed_approve_or_save_of_an_unedited_study_writes_and_asks_nothing(self):
        cases = (("Approve refused for a newer version", "#b-approve", (409, {"message": "그 사이 다른 사용자가 저장했습니다 (v2)"}), [False]),
                 ("Save refused", "#b-save", (500, {"message": "SYN commit refused"}), []),
                 ("Save of unknown outcome", "#b-save", (502, {"message": "SYN gateway"}), []))
        for label, control, answer, answers in cases:
            with self.subTest(command=label):
                self.open_untouched(report=SAVED_REPORT)
                self.select_untouched()
                expect(self.page.locator("#findings")).to_have_value(SAVED_REPORT["findings"])
                self.site.commit_answers = [answer]
                self.dialog_answers = list(answers)
                self.page.locator(control).click()
                self.wait_until(lambda: len(self.site.commits) == 1, "the command reached the server")
                self.page.wait_for_timeout(400)
                for _ in range(2):
                    self.page.clock.run_for(21000)
                    self.page.wait_for_timeout(200)
                self.assertEqual(([], None), (self.site.puts, self.site.stored_for(h.UID)),
                                 "nobody typed: the saved report was written as a draft")
                self.assertFalse(self.leaving_asks(), "nobody typed: leaving asks nothing")
                self.log_out_main()
                self.page.wait_for_url(h.INDEX_URL)
                self.assertEqual(([], 1), (self.site.puts, len(self.site.logouts)), "Log out is one press, nothing to save")

    def test_a_failed_discard_of_an_unedited_draft_is_not_sent_again(self):
        cases = (("refused", (403, {"statusCode": 403, "message": "SYN discard refused"}), h.FIELDS),
                 ("unknown outcome, not done", "abort", h.FIELDS),
                 ("unknown outcome, done on the server", "lost", None))
        for label, reply, stored in cases:
            with self.subTest(discard=label):
                self.open_untouched(draft=h.FIELDS)
                self.select_untouched()
                expect(self.page.locator("#b-draft-discard")).to_be_visible()
                self.site.discard_answers = [reply]
                self.dialog_answers = [True]
                self.page.locator("#b-draft-discard").click()
                self.wait_until(lambda: len(self.site.discards) == 1, "the discard reached the server")
                self.page.wait_for_timeout(500)
                for _ in range(2):
                    self.page.clock.run_for(21000)
                    self.page.wait_for_timeout(250)
                self.assertEqual(([], stored), (self.site.puts, self.site.stored_for(h.UID)),
                                 "the draft the reader was discarding was written again")
                # The screen follows the server: the draft is still shown while it exists, and gone once it is gone.
                self.assertEqual(stored or EMPTY, self.editor())
                self.assertFalse(self.leaving_asks(), "nothing typed: leaving asks nothing")
                self.log_out_main()
                self.page.wait_for_url(h.INDEX_URL)
                self.assertEqual(([], 1), (self.site.puts, len(self.site.logouts)))

    def test_a_refused_insertion_into_an_unedited_study_leaves_no_draft(self):
        self.open_untouched(report=SAVED_REPORT)
        self.select_untouched()
        expect(self.page.locator("#findings")).to_have_value(SAVED_REPORT["findings"])
        self.report_menu("#b-structured").click()
        self.page.locator("#struct-value-text").fill("SYN technique")
        self.site.put_answers = [(403, {"statusCode": 403, "message": "SYN structure refused"})]
        self.page.locator("#struct-apply").click()
        self.wait_until(lambda: len(self.site.puts) == 1, "the refused insertion")
        self.page.wait_for_timeout(300)
        saved = {k: SAVED_REPORT[k] for k in h.FIELDS}
        self.assertEqual(saved, self.editor(), "a refused insertion changes no text")
        for _ in range(2):
            self.page.clock.run_for(21000)
            self.page.wait_for_timeout(200)
        self.assertEqual((1, None), (len(self.site.puts), self.site.stored_for(h.UID)),
                         "the saved report was written as a draft after a refused insertion")
        self.assertFalse(self.leaving_asks())
        self.log_out_main()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual((1, 1), (len(self.site.puts), len(self.site.logouts)))

    def test_a_study_the_server_no_longer_accepts_is_announced_once_and_its_text_kept(self):
        self.page.clock.install()
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        self.site.put_answers = [(403, {"statusCode": 403, "message": "SYN no access to this study"})] * 10
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: len(self.site.puts) == 1, "A refused on leaving it")
        self.site.hidden = {h.UID}          # the study left this reader's list (access removed, another institution)
        for _ in range(4):
            self.page.clock.run_for(21000)
            self.page.wait_for_timeout(200)
        expect(self.page.locator("#rows")).not_to_contain_text(h.PATIENT)
        self.assertEqual(1, len(self.site.puts), "the refused text was sent again by itself")
        self.assertEqual(1, len([text for text, error in notices if error]), notices)
        # The text is kept: Log out asks, naming the study by the only name it still has.
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.UID)
        self.assertEqual([], self.site.logouts)
        self.site.put_answers = []
        self.panel_button("Retry").click()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))

    def test_a_passing_save_failure_is_retried_without_repeating_the_notice(self):
        self.page.clock.install()
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        self.site.put_answers = [(500, {"statusCode": 500, "message": "SYN passing failure"})] * 3
        for _ in range(3):
            self.page.clock.run_for(20500)
            self.page.wait_for_timeout(200)
        self.assertEqual(3, len(self.site.puts), "a failure that may pass is tried again")
        self.assertEqual(1, len([text for text, error in notices if error]), notices)
        self.page.clock.run_for(20500)
        self.wait_until(lambda: self.site.stored_for(h.UID) == h.FIELDS, "stored once the server accepts")
        self.assertEqual(h.FIELDS, self.editor())

    def test_load_latest_without_that_study_in_the_answer_keeps_the_text_and_says_so(self):
        self.context.add_init_script(h.CLIPBOARD)
        self.site.bootstrap_states = {}     # the study is no longer among this reader's states
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        refusal = "그 사이 다른 사용자가 저장했습니다 (v1)"
        self.site.report = {"version": 1, "rs": "T", "findings": "SYN server report v1", "conclusion": "", "recommendation": ""}
        self.site.commit_answers = [(409, {"message": refusal})]
        self.dialog_answers = [True]
        reads = self.site.count("GET", "/api/bootstrap")
        self.page.locator("#b-save").click()
        self.wait_until(lambda: self.site.count("GET", "/api/bootstrap") > reads, "the read of the latest report")
        self.wait_until(lambda: any(error and text != refusal for text, error in notices), "the failed load is said")
        self.assertEqual(h.FIELDS, self.editor(), "the text the reader was writing stays")
        expect(self.page.locator("#b-save")).to_be_enabled()
        self.assertTrue(self.leaving_asks(), "the unsaved text is still this document's")
        # (tearDown: no page error - the failure is handled, not thrown)

    def save_and_leave_before_the_answer(self):
        """Save of study A is out; the reader moves to study B; then the server accepts the Save (what the harness
        answers for an unheld commit). The write of leaving A stood behind the Save."""
        self.site.commit_answers = ["hold"]
        self.page.locator("#b-save").click()
        self.wait_until(lambda: self.site.held_commits, "Save is out")
        self.switch(h.PATIENT_B)
        self.page.wait_for_timeout(200)
        route, body = self.site.held_commits.pop(), self.site.commits[-1]
        self.site.revs[h.RAD["actor"]] = self.site.revs.get(h.RAD["actor"], 0) + 1
        self.site.rows.pop(h.RAD["actor"], None)
        self.site.report = {"version": 1, "rs": "T", **{k: body.get(k, "") for k in h.FIELDS}}
        route.fulfill(json={**self.site.envelope(h.RAD), "state": self.site.state(h.RAD)})
        row = self.page.locator("#rows tr", has_text=h.PATIENT).first
        expect(row.get_by_role("cell", name="T", exact=True)).to_be_visible()

    def test_a_save_accepted_after_the_study_was_left_is_not_reported_as_failed(self):
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        self.save_and_leave_before_the_answer()
        self.page.wait_for_timeout(600)
        self.assertEqual([], [text for text, error in notices if error], "an accepted Save was shown as a failure")
        # The page stands on the saved version: the next Save names it.
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value(h.FIELDS["findings"])
        self.page.locator("#b-save").click()
        self.wait_until(lambda: len(self.site.commits) == 2, "the next Save")
        self.assertEqual(1, self.site.commits[-1]["baseVersion"])

    def test_a_refused_write_left_behind_an_accepted_save_is_not_a_failure_and_not_sent_again(self):
        self.page.clock.install()
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        self.site.put_answers = [(403, {"statusCode": 403, "message": "SYN refused"})]
        self.save_and_leave_before_the_answer()
        self.wait_until(lambda: len(self.site.puts) == 1, "the write of leaving the study, refused")
        self.page.wait_for_timeout(300)
        for _ in range(2):
            self.page.clock.run_for(21000)
            self.page.wait_for_timeout(200)
        # The Save stored that text as the report: nothing of this document is unconfirmed, whatever became of the write.
        self.assertEqual((1, None), (len(self.site.puts), self.site.stored_for(h.UID)), "the saved report was sent again as a draft")
        self.assertEqual([], [text for text, error in notices if error], "the reader was told of a failure that lost nothing")
        self.assertFalse(self.leaving_asks())
        self.log_out_main()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual((1, 1), (len(self.site.puts), len(self.site.logouts)))

    def test_text_typed_while_a_save_or_approve_is_out_is_kept_when_the_server_accepts_it(self):
        for control, rs in (("#b-save", "T"), ("#b-approve", "A")):
            with self.subTest(command=control):
                self.fresh_context()
                self.site = MultiStudySite()
                self.page.clock.install()
                self.open_main()
                self.select_and_type()
                self.site.commit_answers = ["hold"]
                self.page.locator(control).click()
                self.wait_until(lambda: self.site.held_commits, "the command is out")
                later = {**h.FIELDS, "findings": h.FIELDS["findings"] + " SYN typed while the command was out"}
                self.page.locator("#findings").press_sequentially(" SYN typed while the command was out")
                # The server accepts the command as it was sent (what the harness answers for an unheld commit).
                route, body = self.site.held_commits.pop(), self.site.commits[-1]
                self.site.revs[h.RAD["actor"]] = self.site.revs.get(h.RAD["actor"], 0) + 1
                self.site.rows.pop(h.RAD["actor"], None)
                self.site.report = {"version": 1, "rs": rs, **{k: body.get(k, "") for k in h.FIELDS}}
                route.fulfill(json={**self.site.envelope(h.RAD), "state": self.site.state(h.RAD)})
                row = self.page.locator("#rows tr", has_text=h.PATIENT).first
                expect(row.get_by_role("cell", name=rs, exact=True)).to_be_visible()
                # The command carried the earlier text and that is what was saved; the later text is still on screen.
                self.assertEqual(h.FIELDS, {k: self.site.report[k] for k in h.FIELDS})
                self.assertEqual(later, self.editor(), "the accepted command redrew the editor over text typed meanwhile")
                self.assertTrue(self.leaving_asks(), "the later text is not stored anywhere yet: leaving asks")
                self.refresh()
                self.page.wait_for_timeout(400)
                self.assertEqual(later, self.editor(), "the list read replaced the later text")
                # It is this document's unconfirmed text on the accepted version: the next autosave stores it as a draft.
                self.page.clock.run_for(21000)
                self.wait_until(lambda: self.site.stored_for(h.UID) == later, "the later text stored as a draft")
                self.assertEqual(1, self.site.puts[-1]["baseVersion"], "the draft stands on the version just accepted")
                self.assertEqual(h.FIELDS, {k: self.site.report[k] for k in h.FIELDS}, "the saved report is untouched")
                self.assertEqual([], self.dialogs)

    def preparing(self, page=None):
        return [post for post in self.posts(page) if post["type"] == "session-preparing"]

    def test_the_preparation_notice_is_a_lease_renewed_while_it_lives_and_released_when_the_document_goes(self):
        for ending in ("Back to Editing", "the document goes away", "Log out completes"):
            with self.subTest(ending=ending):
                self.fresh_context()
                self.site = MultiStudySite()
                self.page.clock.install()
                self.open_main()
                session = self.site.cookie
                self.select_and_type()
                self.site.put_answers = ["hold"]
                self.site.logout_answers = ["hold"]
                self.log_out_main()
                self.wait_until(lambda: self.site.held_puts, "the preparation's save")
                first = self.preparing()[0]
                self.assertEqual(session, first["session"])
                # While the preparation lives its notice is posted again every 2 s, unchanged.
                self.page.clock.run_for(6100)
                renewed = self.preparing()
                self.assertGreaterEqual(len(renewed), 4, "the first notice and three renewals in six seconds")
                self.assertEqual([first] * len(renewed), renewed, "a renewal is the same notice, the same preparation")
                self.assertEqual("preparing", self.screen()["state"])
                if ending == "Back to Editing":
                    self.panel_button("Back to Editing").click()
                    resumed = [post for post in self.posts() if post["type"] == "session-resumed"]
                    self.assertEqual([{"type": "session-resumed", "session": session, "preparation": first["preparation"]}],
                                     resumed)
                elif ending == "the document goes away":
                    # The browser's notice that this document is being left (a closed tab, a navigation).
                    self.page.evaluate("() => window.dispatchEvent(new PageTransitionEvent('pagehide'))")
                    resumed = [post for post in self.posts() if post["type"] == "session-resumed"]
                    self.assertEqual([{"type": "session-resumed", "session": session, "preparation": first["preparation"]}],
                                     resumed, "the viewers are released at once, not after their lease runs out")
                    continue
                else:
                    self.assertEqual(200, self.site.finish_put())
                    self.wait_until(lambda: self.site.held_logouts, "the real end")
                count = len(self.preparing())
                self.page.clock.run_for(6100)
                self.assertEqual(count, len(self.preparing()), "no renewal after the preparation ended")
                if ending == "Log out completes":
                    self.assertEqual([], [post for post in self.posts() if post["type"] == "session-resumed"])
                    self.assertEqual("session-ended", self.posts()[-1]["type"])

    def test_a_document_that_is_not_preparing_posts_no_release_when_it_goes(self):
        self.open_main()
        self.select_and_type()
        self.page.evaluate("() => window.dispatchEvent(new PageTransitionEvent('pagehide'))")
        self.assertEqual([], self.posts())

    def test_closing_the_preparing_tab_tells_the_other_documents_of_the_session_to_resume(self):
        self.open_main()
        session = self.site.cookie
        self.select_and_type()
        # Another document of the same session listens on the session channel, as a viewer does.
        other = self.open_main(self.watch(self.context.new_page()))
        other.evaluate("""() => { window.__synHeard = []; window.__synChannel = new BroadcastChannel('kin-session');
            window.__synChannel.onmessage = event => window.__synHeard.push(event.data); }""")
        heard = lambda: other.evaluate("() => window.__synHeard")
        self.site.put_answers = ["hold"]
        self.log_out_main()
        self.wait_until(lambda: heard(), "the pause notice", page=other)
        paused = heard()[0]
        self.assertEqual(("session-preparing", session), (paused["type"], paused["session"]))
        self.page.close()                   # the tab is closed in the middle of its preparation
        self.page = other
        released = lambda: [notice for notice in heard() if notice["type"] == "session-resumed"]
        self.wait_until(released, "the release notice", page=other)
        self.assertEqual([{"type": "session-resumed", "session": session, "preparation": paused["preparation"]}], released())
        self.assertEqual("active", self.screen(other)["state"], "the session itself is untouched")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ReportTextBoundaries(name) for name in ReportTextBoundaries.__dict__ if name.startswith('test_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
