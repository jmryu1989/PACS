# coding: utf-8
"""Worklist add-on frame (window.KinWorklistAddOns) on the delivered split page.

The delivered page (main.html, its bundle and every shipped asset) against the synthetic origin of report_flow_dom_test;
no stack, no product file is modified. A test add-on is the only addition: an init script pushes its install function
before the bundle runs, exactly as a feature file loaded before the bundle would.

  - the installed context reads the page (mode, roles, session, list copies) and hears onRender / onSelect / onEnd, and
    nothing after the returned remover was called;
  - with no add-on, and with an add-on that registers nothing, the page sends the same requests and shows the same list;
  - an answer that arrives after the study changed is dropped (AbortError), a document-scope request is not;
  - report.insertAtTop refuses a text from another study, and report.undoInsert is refused after the study changed or
    the field was edited again;
  - one add-on that fails to install (thrown or rejected) is reported by name and does not stop the next one.
"""
import json
import sys
import unittest

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect, sync_playwright

PROBE = "/api/syn-addon/probe"

# The test add-on: records what the context gives and what it hears. `failing` adds two broken add-ons in front of it.
ADDON = """((failing) => {
  const log = window.__synAddOn = { renders: 0, selects: [], ctx: null, off: {} };
  const list = (window.KinWorklistAddOns ||= []);
  if (failing) {
    list.push(Object.assign(() => { throw new Error('SYN thrown install'); }, { addOnName: 'SYN Thrown' }));
    list.push(Object.assign(async () => { throw new Error('SYN rejected install'); }, { addOnName: 'SYN Rejected' }));
  }
  list.push(function synProbe(ctx) {
    log.ctx = ctx;
    log.off.render = ctx.onRender(() => { log.renders++; });
    log.off.select = ctx.onSelect(uid => { log.selects.push([uid, ctx.selectedUid()]); });
    ctx.onEnd(() => { sessionStorage.setItem('syn-addon-end', String(Number(sessionStorage.getItem('syn-addon-end') || 0) + 1)); });
    const dropped = ctx.onEnd(() => { sessionStorage.setItem('syn-addon-end-removed', 'called'); });
    dropped();
  });
})(%s)"""
# An add-on that is installed and registers nothing.
INERT = "(window.KinWorklistAddOns ||= []).push(function synInert(ctx) { window.__synInert = Object.isFrozen(ctx); });"


class AddOnSite(rf.FlowSite):
    """FlowSite plus one probe route the test add-on calls; its answers are held until the case releases them."""

    def __init__(self, count=2):
        super().__init__(count)
        self.probes = []

    def api(self, route, request, method, path, query):
        if path == PROBE:
            return self.probes.append(route)
        return super().api(route, request, method, path, query)

    def release_probe(self):
        self.answer(self.probes.pop(0), 200, {"syn": "probe answer"})


class WorklistAddOns(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.runs = []

    def tearDown(self):
        for run in self.runs:
            run["context"].close()
            self.assertEqual([], run["errors"], "page errors")
            self.assertEqual([], run["site"].violations, "requests the synthetic origin does not answer")

    def start(self, script=None):
        site = AddOnSite()
        context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR", timezone_id="Asia/Seoul")
        context.route("**/*", lambda route, request: site.handle(route, request))
        page = context.new_page()
        page.set_default_timeout(10000)
        run = {"site": site, "context": context, "page": page, "errors": [], "console": []}
        page.on("pageerror", lambda error: run["errors"].append(str(error)))
        page.on("console", lambda message: run["console"].append(message.text) if message.type == "error" else None)
        if script:
            page.add_init_script(script)
        page.goto(h.MAIN_URL)
        expect(page.locator("#rows")).to_contain_text(h.PATIENT)
        self.runs.append(run)
        self.site, self.page = site, page
        return run

    def js(self, expression, arg=None):
        return self.page.evaluate(expression, arg)

    def open_study(self, patient):
        self.page.locator("#rows tr", has_text=patient).first.click()
        self.wait(f"() => studies.find(s => s.uid === selectedUid)?.name === {json.dumps(patient)}", "the study opens")
        expect(self.page.locator("#findings")).to_be_editable()

    def wait(self, predicate, what):
        try:
            self.page.wait_for_function(predicate, timeout=10000)
        except Exception:
            self.fail(f"{what}: not observed; last requests {self.site.calls[-8:]}")

    def findings(self):
        return self.page.locator("#findings").input_value()

    # ── the context reads the page and hears the page ──
    def test_the_context_reads_copies_and_hears_render_select_and_end_until_removed(self):
        self.start(ADDON % "false")
        seen = self.js("""() => { const c = window.__synAddOn.ctx; const list = c.studies(); const before = studies[0].name;
          list[0].name = 'SYN CHANGED'; const one = c.study(list[1].uid); one.name = 'SYN CHANGED';
          return { frozen: Object.isFrozen(c) && Object.isFrozen(c.report), mode: c.mode(), selected: c.selectedUid(),
            count: list.length, unchanged: studies[0].name === before && studies[1].name !== 'SYN CHANGED',
            radiologist: c.has('radiologist'), allowed: c.allowed(), sub: c.session()?.sub,
            sessionCopy: c.session() !== KinAuth.session(), renders: window.__synAddOn.renders }; }""")
        self.assertEqual({"frozen": True, "mode": "Radiology", "selected": None, "count": 2, "unchanged": True,
                          "radiologist": True, "allowed": True, "sub": h.RAD["sub"], "sessionCopy": True},
                         {k: v for k, v in seen.items() if k != "renders"})
        self.assertGreater(seen["renders"], 0, "the drawn list was announced")

        self.open_study(h.PATIENT)
        self.assertEqual([[h.UID, h.UID]], self.js("() => window.__synAddOn.selects"), "heard after the move, with the new selection")

        self.js("() => { window.__synAddOn.off.render(); window.__synAddOn.off.select(); window.__synRenders = window.__synAddOn.renders; }")
        self.open_study(h.PATIENT_B)
        self.assertEqual([[h.UID, h.UID]], self.js("() => window.__synAddOn.selects"), "nothing after the remover")
        self.assertEqual(self.js("() => window.__synRenders"), self.js("() => window.__synAddOn.renders"))

        # The page goes away: onEnd is called once; the removed one never.
        self.page.reload()
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)
        self.assertEqual(["1", None], self.js("() => [sessionStorage.getItem('syn-addon-end'), sessionStorage.getItem('syn-addon-end-removed')]"))

    def test_select_through_the_context_uses_the_page_gate(self):
        self.start(ADDON % "false")
        result = self.js(f"() => window.__synAddOn.ctx.select({json.dumps(h.UID_B)}, {{ revalidate: () => null }})")
        self.assertEqual({"status": "clear", "uid": h.UID_B}, result, "an option outside deferViewer/openSelected is not passed on")
        self.assertEqual([[h.UID_B, h.UID_B]], self.js("() => window.__synAddOn.selects"))

    def test_no_addon_and_an_inert_addon_send_the_same_requests_and_show_the_same_list(self):
        def observe(script):
            run = self.start(script)
            run["page"].wait_for_timeout(800)
            # The kinds of requests (timers decide how often a poll repeats within the window, not the add-on frame).
            return (sorted(set(run["site"].calls)), run["page"].locator("#rows").inner_text(),
                    run["page"].locator("#toast").inner_text())
        plain = observe(None)
        inert = observe(INERT)
        self.assertTrue(self.js("() => window.__synInert"), "the inert add-on was installed with a frozen context")
        self.maxDiff = None
        self.assertEqual(plain, inert)

    # ── answers after a move ──
    def test_an_answer_that_arrives_after_the_study_changed_is_dropped(self):
        self.start(ADDON % "false")
        self.open_study(h.PATIENT)
        self.js(f"""() => {{ const c = window.__synAddOn.ctx;
          window.__synStudy = c.api('GET', '/syn-addon/probe').then(v => ['answer', v], e => ['error', e.name]);
          window.__synDocument = c.api('GET', '/syn-addon/probe', undefined, undefined, c.work('document'))
            .then(v => ['answer', v.syn], e => ['error', e.name]); }}""")
        self.page.wait_for_timeout(200)
        self.assertEqual(2, len(self.site.probes), "both requests left")
        self.open_study(h.PATIENT_B)
        self.site.release_probe()
        self.site.release_probe()
        self.assertEqual(["error", "AbortError"], self.js("() => window.__synStudy"), "the study-scope answer is dropped")
        self.assertEqual(["answer", "probe answer"], self.js("() => window.__synDocument"), "a document-scope answer is kept")

    # ── text into the report ──
    def test_insert_at_top_only_for_the_selected_study_and_undo_only_while_nothing_changed(self):
        self.start(ADDON % "false")
        self.open_study(h.PATIENT)
        self.page.locator("#findings").fill("SYN typed")
        insert = "(args) => window.__synAddOn.ctx.report.insertAtTop('findings', args[0], { sourceUid: args[1] })"
        undo = "() => window.__synAddOn.ctx.report.undoInsert()"

        self.assertEqual("refused", self.js(insert, ["SYN CLINICAL B", h.UID_B])["status"], "text of another study")
        self.assertEqual("refused", self.js(insert, ["SYN CLINICAL", None])["status"], "no source")
        self.assertEqual("refused", self.js("() => window.__synAddOn.ctx.report.insertAtTop('nofield', 'x', { sourceUid: selectedUid })")["status"])
        self.assertEqual("SYN typed", self.findings())

        self.assertEqual({"status": "applied"}, self.js(insert, ["SYN CLINICAL", h.UID]))
        self.assertEqual("SYN CLINICAL\nSYN typed", self.findings())
        self.assertEqual({"status": "applied"}, self.js(undo))
        self.assertEqual("SYN typed", self.findings())
        self.assertEqual("refused", self.js(undo)["status"], "one Undo per insertion")

        # An edit after the insertion retires its Undo; the text stays.
        self.assertEqual("applied", self.js(insert, ["SYN CLINICAL", h.UID])["status"])
        self.page.locator("#findings").focus()
        self.page.keyboard.press("End")
        self.page.keyboard.type(" more")
        self.assertEqual("refused", self.js(undo)["status"])
        self.assertEqual("SYN CLINICAL\nSYN typed more", self.findings())

        # A move to another study retires it too, and A's text is refused while B is selected.
        self.page.locator("#findings").fill("SYN typed")
        self.assertEqual("applied", self.js(insert, ["SYN CLINICAL", h.UID])["status"])
        self.open_study(h.PATIENT_B)
        before_b = self.findings()
        self.assertEqual("refused", self.js(undo)["status"])
        self.assertEqual("refused", self.js(insert, ["SYN CLINICAL", h.UID])["status"])
        self.assertEqual(before_b, self.findings())
        self.assertEqual("SYN CLINICAL\nSYN typed", self.site.store[h.UID]["row"]["findings"], "A's text was saved as typed")

    # ── isolation of failures ──
    def test_a_failing_install_is_reported_by_name_and_the_next_one_is_installed(self):
        self.start(ADDON % "true")
        self.assertTrue(self.js("() => !!window.__synAddOn.ctx"), "the add-on after the failing ones was installed")
        self.wait("() => document.querySelector('#toast').textContent.includes('SYN Rejected')", "the rejected install is reported")
        logged = "\n".join(self.runs[-1]["console"])
        self.assertIn('"SYN Thrown" could not be installed', logged)
        self.assertIn('"SYN Rejected" could not be installed', logged)
        self.open_study(h.PATIENT)
        self.assertEqual([[h.UID, h.UID]], self.js("() => window.__synAddOn.selects"))


if __name__ == "__main__":
    unittest.main(argv=sys.argv[:1], verbosity=2)
