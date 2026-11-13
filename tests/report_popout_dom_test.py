# coding: utf-8
"""The report pop-up window (Pop Out, Pin, Dock) and Clinical Info's Copy / Paste to Findings / Undo Paste.

The delivered split page (main.html, its bundle and every shipped asset) against the synthetic origin of the report flow
suite (report_flow_dom_test.FlowSite); no stack. The pop-up is the browser's real Document Picture-in-Picture window:
Chromium opens it for a click and Playwright sees it as a second page of the context, so typing, Approve, Pin and Dock are
driven in that window itself. The in-page box (a browser without that window) is driven with the API removed before the
page loads. One stand-in, documented where used: the Reading Workspace layout is entered by its body class.
"""
import json
import re
import time
import unittest
from pathlib import Path

import auth_logout_dom_test as h
from playwright.sync_api import expect, sync_playwright
from report_flow_dom_test import FlowSite, PATIENT_C, UID_C

ROOT = Path(__file__).resolve().parents[1]
VECTORS = json.loads((ROOT / "tests/clinical_context_vectors.json").read_text(encoding="utf-8"))
NO_PIP = "delete window.documentPictureInPicture; Object.defineProperty(window, 'documentPictureInPicture', { value: undefined });"


def clinical_answer(uid, tags=True):
    """A valid Clinical Context answer of the shared vectors for this study: no prior reports, history or Tech Note, and
    (tags=True) the two DICOM request tags of the A-PRESENT-OWNER vector, read from an instance of this study."""
    answer = json.loads(json.dumps(VECTORS["answers"]["valid"]["A-ABSENT4"]))
    answer["uid"] = uid
    if tags:
        answer["sections"]["requestTags"] = json.loads(json.dumps(
            VECTORS["answers"]["valid"]["A-PRESENT-OWNER"]["sections"]["requestTags"]))
        for item in answer["sections"]["requestTags"]["items"]:
            item["provenance"]["recordId"] = uid + ".1.1.1"
    return answer


def tags_text(answer):
    return "\n".join(f"{item['keyword']}: {item['value']}" for item in answer["sections"]["requestTags"]["items"]
                     if item["value"])


class ReportPopoutPage(unittest.TestCase):
    count = 3
    no_pip = False

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = FlowSite(self.count)
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR",
                                                timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        if self.no_pip:
            self.context.add_init_script(NO_PIP)
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.page.set_default_navigation_timeout(30000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        self.page.clock.install()

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.site.violations, "requests the synthetic origin does not answer")

    # ── the page ──
    def open(self):
        self.page.goto(h.MAIN_URL)
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)

    def open_study(self, patient):
        self.page.locator("#rows tr", has_text=patient).first.click()
        self.wait(lambda: self.selected() == patient, "the study opens")
        expect(self.page.locator("#findings")).to_be_editable()

    def selected(self):
        return self.page.evaluate("() => studies.find(s => s.uid === selectedUid)?.name ?? null")

    def wait(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                self.fail(f"{what}: not observed; last requests {self.site.calls[-8:]}")
            self.page.wait_for_timeout(20)

    def settle(self, ms=200):
        self.page.wait_for_timeout(ms)

    def state(self):
        return self.page.evaluate("() => KinReportPopout.current().state()")

    def place(self):
        return self.page.locator(".report-window-place")

    def pop_out(self):
        """Pop Out and the window it opened (the second page of the context)."""
        self.page.locator("#report-popout").click()
        self.wait(lambda: len(self.context.pages) == 2, "the pop-up window")
        pip = self.context.pages[1]
        expect(pip.locator("#findings")).to_be_visible()
        return pip

    def window_gone(self):
        self.wait(lambda: len(self.context.pages) == 1, "the pop-up window closes")

    def autosave(self, done):
        """The page's draft autosave runs on a 20 s timer: advance page time past it, then wait for the write."""
        self.page.clock.run_for(21000)
        self.wait(done, "the autosave")

    def drafts_of(self, uid):
        return [body["findings"] for u, body in self.site.flow_puts if u == uid]

    def editor_in_place(self):
        """The editor, its draft bar and Save are back in their own places in the worklist page."""
        return self.page.evaluate("""() => {
          const editor = document.getElementById('report-editor'), save = document.getElementById('b-save');
          return !!editor && editor.parentElement.classList.contains('report-compose')
            && !!save && save.parentElement.classList.contains('rfoot2') && !save.closest('.report-window-foot')
            && !!document.getElementById('draftbar')?.closest('.report-p')
            && !document.querySelector('.report-window-hold > *');
        }""")


class PopOutWindow(ReportPopoutPage):
    """A1 08-3 in the real Document Picture-in-Picture window."""

    def test_pop_out_moves_the_same_editor_and_typing_in_the_window_is_saved_as_the_draft(self):
        self.open()
        self.open_study(h.PATIENT)
        self.page.locator("#findings").fill("SYN typed before")
        before = self.page.evaluate_handle("() => document.getElementById('findings')")
        pip = self.pop_out()
        self.assertEqual("window", self.state())
        # The very same element (not a copy) is in the window, and the page's own lookup finds it there.
        self.assertTrue(self.page.evaluate("""f => f === documentPictureInPicture.window.document.getElementById('findings')
          && $('#findings') === f && !document.getElementById('findings')""", before))
        self.assertEqual("SYN typed before", pip.locator("#findings").input_value())
        for part in ("#conclusion", "#report-editor-target", "#report-editor-state", "#b-save", "#report-window-pin",
                     "#report-window-approve", "#report-window-dock"):
            expect(pip.locator(part)).to_be_attached()
        expect(self.place()).to_contain_text("Report is open in a pop-up window")
        expect(self.place().get_by_role("button", name="Bring to Front")).to_be_visible()
        expect(self.place().get_by_role("button", name="Dock")).to_be_visible()
        expect(self.page.locator("#b-approve")).to_be_visible()          # the page's own buttons stay
        expect(pip.locator("#report-window-pin")).to_have_attribute("aria-pressed", "false")
        self.assertIn(h.PATIENT, pip.title())
        pip.locator("#findings").fill("SYN typed in the window")
        pip.locator("#conclusion").fill("SYN conclusion in the window")
        self.autosave(lambda: "SYN typed in the window" in self.drafts_of(h.UID))
        self.assertEqual("SYN typed in the window", self.site.stored_of(h.UID)["findings"])
        # Save in the window is the page's Save.
        pip.locator("#b-save").click()
        self.wait(lambda: self.site.store[h.UID]["report"]["rs"] == "T", "Save from the window")
        self.assertEqual("SYN conclusion in the window", self.site.store[h.UID]["report"]["conclusion"])

    def test_pin_on_approve_moves_the_window_to_the_next_study_with_its_own_draft(self):
        self.site.store[h.UID_B]["row"] = {"findings": "SYN B kept draft", "conclusion": "", "recommendation": "",
                                           "baseVersion": 0, "citations": [], "structured": []}
        self.open()
        self.open_study(h.PATIENT)
        pip = self.pop_out()
        pip.locator("#findings").fill("SYN A approved from the window")
        pip.locator("#report-window-pin").click()
        expect(pip.locator("#report-window-pin")).to_have_attribute("aria-pressed", "true")
        pip.locator("#report-window-approve").click()
        self.wait(lambda: self.site.store[h.UID]["report"]["rs"] == "A", "the approval on the server")
        self.wait(lambda: self.selected() == h.PATIENT_B, "the move to the next study")
        self.assertEqual("SYN A approved from the window", self.site.store[h.UID]["report"]["findings"])
        self.assertEqual(2, len(self.context.pages), "Pin on: the window stays")
        expect(pip.locator("#report-editor-target")).to_contain_text(h.PATIENT_B)
        expect(pip.locator("#findings")).to_have_value("SYN B kept draft")
        self.assertEqual("window", self.state())

    def test_window_approve_that_is_refused_unknown_or_last_keeps_the_window_and_its_text(self):
        self.open()
        self.open_study(h.PATIENT_B)
        pip = self.pop_out()
        pip.locator("#findings").fill("SYN B refused text")
        self.site.store[h.UID_B]["report"]["version"] = 3
        self.site.commit_answers = [(409, {"code": "REPORT_VERSION_CONFLICT", "message": "SYN refused commit"})]
        pip.locator("#report-window-approve").click()
        self.wait(lambda: self.site.flow_commits, "the refused commit")
        self.settle(300)
        self.assertEqual((h.PATIENT_B, 2, "window"), (self.selected(), len(self.context.pages), self.state()))
        expect(pip.locator("#findings")).to_have_value("SYN B refused text")
        self.site.store[h.UID_B]["report"]["version"] = 0
        # Unknown: stored, answer lost.
        self.site.commit_answers = ["lost"]
        pip.locator("#report-window-approve").click()
        self.wait(lambda: self.site.store[h.UID_B]["report"]["rs"] == "A", "the server stored the approval")
        self.settle(500)
        self.assertEqual((h.PATIENT_B, 2, "window"), (self.selected(), len(self.context.pages), self.state()))
        # The last study of the list: approved, nothing to move to, the window stays (Pin off).
        self.page.locator("#rows tr", has_text=PATIENT_C).first.click()
        self.wait(lambda: self.selected() == PATIENT_C, "C")
        expect(pip.locator("#report-editor-target")).to_contain_text(PATIENT_C)
        pip.locator("#findings").fill("SYN C last")
        pip.locator("#report-window-approve").click()
        self.wait(lambda: self.site.store[UID_C]["report"]["rs"] == "A", "C approved")
        self.settle(300)
        self.assertEqual((PATIENT_C, 2, "window"), (self.selected(), len(self.context.pages), self.state()))
        expect(pip.locator("#findings")).to_have_value("SYN C last")

    def test_pin_off_approve_closes_the_window_behind_and_the_tab_brings_it_back_with_the_next_study(self):
        self.open()
        self.open_study(h.PATIENT)
        pip = self.pop_out()
        pip.locator("#findings").fill("SYN A pin off")
        pip.locator("#report-window-approve").click()
        self.wait(lambda: self.site.store[h.UID]["report"]["rs"] == "A", "the approval")
        self.window_gone()
        self.wait(lambda: self.selected() == h.PATIENT_B, "the next study")
        self.assertEqual("behind", self.state())
        tab = self.page.locator("#report-window-behind")
        expect(tab).to_be_visible()
        expect(tab).to_have_text("Report (behind) — bring to front")
        expect(self.page.locator("#findings")).to_be_hidden()            # waiting, hidden, not docked
        expect(self.page.locator("#report-popout")).to_be_hidden()
        tab.click()
        self.wait(lambda: len(self.context.pages) == 2, "the window again")
        pip = self.context.pages[1]
        expect(pip.locator("#report-editor-target")).to_contain_text(h.PATIENT_B)
        expect(pip.locator("#findings")).to_have_value("")
        pip.locator("#report-window-dock").click()
        self.window_gone()
        self.assertEqual("docked", self.state())
        self.assertTrue(self.editor_in_place())
        expect(self.place()).to_be_hidden()
        expect(self.page.locator("#report-popout")).to_be_visible()

    def test_dock_and_the_window_close_button_put_the_editor_back_in_its_place(self):
        self.open()
        self.open_study(h.PATIENT)
        pip = self.pop_out()
        pip.locator("#findings").fill("SYN docked text")
        self.place().get_by_role("button", name="Dock").click()
        self.window_gone()
        self.assertTrue(self.editor_in_place())
        expect(self.page.locator("#findings")).to_have_value("SYN docked text")
        # The OS close (×) is Dock, not "behind".
        pip = self.pop_out()
        pip.close()
        self.window_gone()
        self.wait(lambda: self.state() == "docked", "docked after the window's own close")
        self.assertTrue(self.editor_in_place())
        expect(self.page.locator("#report-window-behind")).to_be_hidden()
        self.page.locator("#findings").fill("SYN typed after the dock")
        self.autosave(lambda: "SYN typed after the dock" in self.drafts_of(h.UID))

    def test_choosing_another_study_asks_in_the_worklist_and_the_window_points_there(self):
        self.open()
        self.open_study(h.PATIENT)
        pip = self.pop_out()
        pip.locator("#findings").fill("SYN A unsaved")
        self.site.put_answers = ["hold"]
        self.page.clock.pause_at((self.page.evaluate("Date.now()") + 100) / 1000)
        self.page.locator("#rows tr", has_text=h.PATIENT_B).first.click()
        self.wait(lambda: self.site.held_flow_puts, "the navigation's save")
        self.site.held_flow_puts.pop(0)[0].abort("connectionreset")
        self.site.draft_read_answers = ["abort"]
        expect(self.page.locator("#report-notice")).to_be_visible()
        expect(pip.locator(".report-window-note")).to_contain_text("Confirm your choice in the worklist window")
        self.assertEqual(h.PATIENT, self.selected())
        self.page.clock.resume()
        self.page.locator("#report-notice-stay").click()
        expect(pip.locator(".report-window-note")).not_to_contain_text("Confirm your choice")
        expect(pip.locator("#findings")).to_have_value("SYN A unsaved")

    def test_a_question_about_the_report_is_asked_in_the_window_and_ends_with_its_study(self):
        for uid in (h.UID, h.UID_B):
            self.site.store[uid]["row"] = {"findings": "SYN server draft", "conclusion": "", "recommendation": "",
                                           "baseVersion": 0, "citations": [], "structured": []}
        self.open()
        self.open_study(h.PATIENT)
        pip = self.pop_out()
        question = pip.locator("dialog.report-window-confirm")
        # Asked in the window, not in the page; the question is modal there, so the editor takes no typing meanwhile.
        pip.locator("#b-draft-discard").click()
        expect(question).to_be_visible()
        self.assertEqual([], self.dialogs, "not asked in the page")
        try:
            pip.locator("#findings").fill("SYN typed while asked", timeout=1500, force=True)
        except Exception:       # Playwright may refuse a field the modal question made inert; either way nothing is typed
            pass
        self.assertEqual(("SYN server draft", 0), (pip.locator("#findings").input_value(),
                                                   self.page.evaluate("() => reportEdits")))
        question.get_by_role("button", name="Cancel").click()
        self.settle(300)
        self.assertEqual([], self.site.discards, "Cancel discards nothing")
        # A study switch ends the question unanswered.
        self.page.locator("#rows tr", has_text=h.PATIENT_B).first.click()
        self.wait(lambda: self.selected() == h.PATIENT_B, "B")
        pip.locator("#b-draft-discard").click()
        expect(question).to_be_visible()
        self.page.locator("#rows tr", has_text=PATIENT_C).first.click()
        self.wait(lambda: self.selected() == PATIENT_C, "C")
        expect(question).to_have_count(0)
        self.page.locator("#rows tr", has_text=h.PATIENT_B).first.click()
        self.wait(lambda: self.selected() == h.PATIENT_B, "B again")
        self.assertEqual([], self.site.discards)
        # Asked and answered in the window for the same study: the draft is discarded.
        pip.locator("#b-draft-discard").click()
        question.get_by_role("button", name="OK").click()
        self.wait(lambda: self.site.discards, "the discard")
        self.assertIsNone(self.site.store[h.UID_B]["row"])

    def test_a_discard_answered_after_the_related_report_gate_closed_sends_nothing(self):
        """Stand-in: the Related Report mode starting while the window's question waits is its command gate answering a
        reason (relatedCommandBlock, the page's one gate for it); the yes then discards nothing and says why."""
        self.site.store[h.UID]["row"] = {"findings": "SYN server draft", "conclusion": "", "recommendation": "",
                                         "baseVersion": 0, "citations": [], "structured": []}
        self.open()
        self.open_study(h.PATIENT)
        pip = self.pop_out()
        pip.locator("#b-draft-discard").click()
        question = pip.locator("dialog.report-window-confirm")
        expect(question).to_be_visible()
        self.page.evaluate("() => { relatedCommandBlock = () => 'SYN Related Report mode is open'; }")
        question.get_by_role("button", name="OK").click()
        expect(self.page.locator("#toast")).to_contain_text("SYN Related Report mode is open")
        self.settle(300)
        self.assertEqual([], self.site.discards)
        self.assertIsNotNone(self.site.store[h.UID]["row"])

    def test_undo_works_inside_each_window_and_stops_at_the_move(self):
        """The browser keeps one Undo history per document: Pop Out and Dock are its boundary. Typing in the window undoes
        in the window; nothing typed before the move is undone after it, so Ctrl+Z never changes text the reader did not
        just type where they are."""
        self.open()
        self.open_study(h.PATIENT)
        field = self.page.locator("#findings")
        field.click()
        field.press_sequentially("SYN-A")
        pip = self.pop_out()
        pip.locator("#findings").press("Control+z")
        expect(pip.locator("#findings")).to_have_value("SYN-A")
        pip.locator("#findings").press("End")
        pip.locator("#findings").press_sequentially(" SYN-B")
        pip.locator("#findings").press("Control+z")
        expect(pip.locator("#findings")).to_have_value("SYN-A")
        pip.locator("#findings").press_sequentially(" SYN-C")
        pip.locator("#report-window-dock").click()
        self.window_gone()
        field.press("Control+z")
        expect(field).to_have_value("SYN-A SYN-C")

    def test_finalize_key_typed_in_the_window_approves_as_in_the_page(self):
        self.open()
        self.open_study(h.PATIENT)
        pip = self.pop_out()
        pip.locator("#findings").fill("SYN finalized from the window")
        pip.locator("#findings").press("Control+s")
        self.wait(lambda: self.site.store[h.UID]["report"]["rs"] == "A", "Ctrl+S in the window approves")
        self.assertEqual("SYN finalized from the window", self.site.store[h.UID]["report"]["findings"])
        self.assertEqual(2, len(self.context.pages), "Finalize is Approve: the window stays on its study")

    def test_a_pop_out_still_opening_is_retired_by_the_reading_workspace_and_the_end(self):
        """The browser answers the window request late (held here); a Reading Workspace or the session's end meanwhile means
        neither its window nor, after a refusal, the in-page box opens. The end is called as the page's end hooks call it."""
        self.context.add_init_script("""(() => { const held = []; Object.defineProperty(window, '__synPip', { value: held });
          documentPictureInPicture.requestWindow = () => new Promise((resolve, reject) => held.push({ resolve, reject })); })();""")
        self.open()
        self.open_study(h.PATIENT)
        for retire in ("() => document.body.classList.add('reading')", "() => KinReportPopout.current().end()"):
            with self.subTest(retire=retire):
                self.page.evaluate("() => document.body.classList.remove('reading')")
                self.page.locator("#report-popout").click(force=True)
                self.wait(lambda: self.page.evaluate("() => window.__synPip.length") == 1, "the window request")
                self.page.evaluate(retire)
                self.page.evaluate("() => window.__synPip.shift().reject(new Error('SYN refused'))")
                self.settle(300)
                self.assertEqual(0, self.page.locator(".report-window-box").count())
                self.assertEqual("docked", self.state())
                self.assertTrue(self.editor_in_place())

    def test_the_reading_workspace_docks_an_open_or_behind_editor_and_disables_pop_out(self):
        self.open()
        self.open_study(h.PATIENT)
        self.pop_out()
        # Stand-in: the Reading Workspace layout is its body class (reading-workspace.js sets it when it opens).
        self.page.evaluate("() => document.body.classList.add('reading')")
        self.window_gone()
        self.wait(lambda: self.state() == "docked", "docked by the Reading Workspace")
        self.assertTrue(self.editor_in_place())
        expect(self.page.locator("#report-popout")).to_be_disabled()
        self.page.evaluate("() => document.body.classList.remove('reading')")
        pip = self.pop_out()
        pip.locator("#findings").fill("SYN A behind")
        pip.locator("#report-window-approve").click()
        self.window_gone()
        self.wait(lambda: self.state() == "behind", "behind")
        self.page.evaluate("() => document.body.classList.add('reading')")
        self.wait(lambda: self.state() == "docked", "the hidden editor is restored too")
        self.assertTrue(self.editor_in_place())
        expect(self.page.locator("#findings")).to_be_visible()

    def test_the_end_of_the_session_puts_the_editor_back_and_pop_out_stays_off(self):
        self.open()
        self.open_study(h.PATIENT)
        self.pop_out()
        # The page's session-end hooks run before it leaves: record what the editor's state was when they ran.
        self.page.evaluate("""() => addEventListener('pagehide', () => {
          sessionStorage.setItem('syn-popout-at-end', KinReportPopout.current().state()); }, { once: true })""")
        self.page.evaluate("() => document.querySelector('#logout').click()")
        self.window_gone()
        self.wait(lambda: "main.html" not in self.page.url, "the page left after Log out")
        self.assertEqual("docked", self.page.evaluate("() => sessionStorage.getItem('syn-popout-at-end')"))


class PopOutBox(ReportPopoutPage):
    """The same editor in a movable box over the page, where the browser has no always-on-top window."""
    no_pip = True

    def test_without_the_window_api_the_box_carries_the_same_editor_pin_approve_and_dock(self):
        self.open()
        self.open_study(h.PATIENT)
        self.page.locator("#report-popout").click()
        box = self.page.locator(".report-window-box")
        expect(box).to_be_visible()
        self.assertEqual(1, len(self.context.pages))
        expect(box).to_contain_text("This browser cannot keep the report above other windows.")
        self.assertEqual("box", self.state())
        box.locator("#findings").fill("SYN typed in the box")
        self.autosave(lambda: "SYN typed in the box" in self.drafts_of(h.UID))
        # Drag by its bar.
        bar = box.locator(".report-window-bar")
        start = bar.bounding_box()
        self.page.mouse.move(start["x"] + 20, start["y"] + 8)
        self.page.mouse.down()
        self.page.mouse.move(start["x"] - 300, start["y"] + 100, steps=5)
        self.page.mouse.up()
        self.assertLess(box.bounding_box()["x"], start["x"] - 200)
        box.locator("#report-window-pin").click()
        box.locator("#report-window-approve").click()
        self.wait(lambda: self.selected() == h.PATIENT_B, "the next study")
        expect(box).to_be_visible()
        expect(box.locator("#report-editor-target")).to_contain_text(h.PATIENT_B)
        box.locator("#report-window-dock").click()
        expect(box).to_have_count(0)
        self.assertTrue(self.editor_in_place())


class ClinicalInfoCopyPaste(ReportPopoutPage):
    """A1 08-6: the DICOM request tags Clinical Context shows, copied or put at the top of Findings."""

    def setUp(self):
        super().setUp()
        self.answer = clinical_answer(h.UID)
        self.site.gets[f"/api/studies/{h.UID}/clinical-context"] = (200, self.answer)
        self.site.gets[f"/api/studies/{h.UID_B}/clinical-context"] = (200, clinical_answer(h.UID_B, tags=False))
        self.text = tags_text(self.answer)

    def show(self, patient=h.PATIENT):
        self.open()
        self.open_study(patient)
        self.wait(lambda: self.page.evaluate("() => !!document.querySelector('#clinical-context-sections [data-section]')"),
                  "Clinical Context drawn")

    def test_paste_puts_the_tags_on_top_of_findings_unsaved_and_undo_removes_exactly_that(self):
        self.assertTrue(self.text.startswith("ReasonForStudy: SYN reason"))
        self.show()
        paste = self.page.locator("#clinical-paste")
        expect(paste).to_be_enabled()
        self.page.locator("#findings").fill("SYN existing line")
        writes = len(self.drafts_of(h.UID))
        paste.click()
        expect(self.page.locator("#findings")).to_have_value(self.text + "\nSYN existing line")
        status = self.page.locator("#clinical-paste-status")
        expect(status).to_contain_text("Pasted to Findings (not saved)")
        self.autosave(lambda: self.text + "\nSYN existing line" in self.drafts_of(h.UID)[writes:])
        self.page.locator("#clinical-paste-undo").click()
        expect(self.page.locator("#findings")).to_have_value("SYN existing line")
        expect(self.page.locator("#clinical-paste-undo")).to_have_count(0)
        # An edit after the paste retires Undo Paste.
        paste.click()
        expect(self.page.locator("#clinical-paste-undo")).to_be_visible()
        self.page.locator("#findings").press("End")
        self.page.locator("#findings").type("x")
        expect(self.page.locator("#clinical-paste-undo")).to_have_count(0)
        # A study switch retires it too.
        paste.click()
        self.page.locator("#rows tr", has_text=PATIENT_C).first.click()
        self.wait(lambda: self.selected() == PATIENT_C, "C")
        expect(self.page.locator("#clinical-paste-undo")).to_have_count(0)

    def test_paste_lands_in_the_pop_up_window_and_its_undo_too(self):
        self.show()
        pip = self.pop_out()
        self.page.locator("#clinical-paste").click()
        expect(pip.locator("#findings")).to_have_value(self.text)
        self.page.locator("#clinical-paste-undo").click()
        expect(pip.locator("#findings")).to_have_value("")

    def test_the_buttons_are_off_until_the_panel_shows_the_selected_studys_answer(self):
        """After a move the panel has not drawn the new study yet: nothing of the study left behind can be pasted."""
        self.show()
        # B is opened; A's answer is held so the panel is told about B but has not drawn it: the buttons are off then.
        self.site.held_gets[f"/api/studies/{h.UID_B}/clinical-context"] = []
        self.page.locator("#rows tr", has_text=h.PATIENT_B).first.click()
        self.wait(lambda: self.selected() == h.PATIENT_B, "B")
        expect(self.page.locator("#clinical-paste")).to_be_disabled()
        self.assertEqual("", self.page.locator("#findings").input_value())

    def test_without_request_tags_both_buttons_are_off_and_say_why(self):
        self.show(h.PATIENT_B)
        for button in ("#clinical-copy", "#clinical-paste"):
            expect(self.page.locator(button)).to_be_disabled()
            expect(self.page.locator(button)).to_have_attribute("title", "이 검사에는 임상 정보가 없습니다")

    def test_copy_says_copied_only_after_the_clipboard_took_it(self):
        self.context.add_init_script(h.CLIPBOARD)
        self.show()
        toast = self.page.locator("#toast")
        self.page.locator("#clinical-copy").click()
        self.wait(lambda: self.page.evaluate("() => window.__synClipboard.written.length") == 1, "the clipboard write")
        self.assertEqual(self.text, self.page.evaluate("() => window.__synClipboard.written[0].text"))
        self.settle()
        expect(toast).not_to_contain_text("Clinical info copied")
        self.page.evaluate("() => window.__synClipboard.written[0].resolve()")
        expect(toast).to_have_text("Clinical info copied")
        self.page.clock.run_for(6000)
        self.page.locator("#clinical-copy").click()
        self.wait(lambda: self.page.evaluate("() => window.__synClipboard.written.length") == 2, "the second write")
        self.page.evaluate("() => window.__synClipboard.written[1].reject(new Error('denied'))")
        expect(toast).to_contain_text("클립보드에 넣지 못했습니다")
        self.assertEqual("", self.page.locator("#findings").input_value(), "copy never touches Findings")


if __name__ == "__main__":
    unittest.main()
