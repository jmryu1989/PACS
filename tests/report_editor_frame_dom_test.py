# coding: utf-8
"""REQ-WS5/WS6/WS7 text boundary -> RISK-T4/T5/T7/T6/T3/TS08 -> TEST-REF-*.

Isolated Chromium, shipped module only; no main.html slices, stack or network.
Assertions cover public results, text, native undo, composition and visible editor state.
The optional one-line mutants run in memory, never rewrite product files. Their anchors
are mutation locations, not product-shape assertions. No new parser or byte pins.
"""
import argparse
import io
import sys
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "worklist-v0/hpacs-lite/report-editor-frame.js"
SOURCE = MODULE.read_text(encoding="utf-8")
FIELDS = ("findings", "conclusion", "recommendation")
HTML = """<!doctype html><meta charset="utf-8"><style>
body { margin: 0; } #frame { margin: 30px; height: 230px; overflow: auto; }
textarea { display: block; width: 240px; height: 80px; white-space: pre; }
</style><button id="before">Before</button><div id="frame">
<textarea id="findings" aria-label="Findings"></textarea>
<textarea id="conclusion" aria-label="Conclusion"></textarea>
<textarea id="recommendation" aria-label="Recommendation"></textarea>
</div><button id="after">After</button>"""
BOOT = """() => {
  window.allowed = true;
  window.editor = KinReportEditorFrame.create({
    fields: Object.fromEntries(['findings','conclusion','recommendation'].map(k => [k, document.getElementById(k)])),
    canEdit: () => allowed
  });
}"""


class ReportEditorFrameDOM(unittest.TestCase):
    source = SOURCE

    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()
        print("Chromium " + cls.browser.version, flush=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 900, "height": 700}, locale="ko-KR")
        self.context.route("**/*", lambda route: route.abort())
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.set_content(HTML)
        self.page.add_script_tag(content=self.source)
        self.page.evaluate(BOOT)
        self.seq = 0
        self.open("A")

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def open(self, uid, **texts):
        self.seq += 1
        result = self.page.evaluate("x => editor.switchStudy(x.context, x.texts)", {
            "context": {"uid": uid, "selectionSeq": self.seq},
            "texts": {k: texts.get(k, "") for k in FIELDS},
        })
        self.assertEqual(result, {"status": "switched"})

    def read(self):
        return self.page.evaluate("editor.read()")

    def focus(self, field="findings"):
        self.page.focus("#" + field)

    def type(self, text, field="findings"):
        self.focus(field)
        self.page.keyboard.type(text)

    def capture(self, field="findings", start=None, end=None):
        self.page.evaluate("x => { window.at = editor.capture(x.field, x.range); }", {
            "field": field, "range": None if start is None else {"start": start, "end": end},
        })

    def insert(self, text):
        return self.page.evaluate("text => editor.insert(at, text)", text)

    def server(self, sent, text):
        return self.page.evaluate("x => editor.applyServer(at, x)", {"sent": sent, "text": text})

    def key(self, key):
        self.page.keyboard.press(key)

    def compose(self, text="한"):
        cdp = self.context.new_cdp_session(self.page)
        cdp.send("Input.imeSetComposition", {"text": text, "selectionStart": len(text), "selectionEnd": len(text)})
        return cdp

    def assert_text(self, text, field="findings"):
        self.assertEqual(self.read()[field], text)
        self.assertEqual(self.page.locator("#" + field).input_value(), text)

    def test_t4_empty_study_boundary_all_fields(self):
        """TEST-REF-T4a: native clear -> same empty B; reads after EVERY key are safe."""
        for field in FIELDS:
            with self.subTest(field=field):
                self.open("A")
                self.type("A-PRIVATE-" + field, field)
                self.key("Control+a")
                self.key("Delete")
                self.assert_text("", field)
                self.open("B")
                self.focus(field)
                for key in ["Control+z", "Control+y", "Control+Shift+z"] * 6:
                    self.key(key)
                    self.assertEqual(self.read(), dict.fromkeys(FIELDS, ""))
                self.type("B-CURRENT", field)
                for key in ["Control+z"] * 6 + ["Control+y", "Control+Shift+z"] * 6:
                    self.key(key)
                    values = self.read()
                    self.assertIn(values[field], ("", "B-CURRENT"))
                    self.assertTrue(all("A-PRIVATE" not in value for value in values.values()))

    def test_t4_reopen_same_uid_and_mixed_history(self):
        """TEST-REF-T4b: all three old nodes contain history, A -> B -> A/new opening."""
        for field in FIELDS:
            self.type("A-OLD-" + field, field)
            self.capture(field, 0, len(self.read()[field]))
            self.assertEqual(self.insert(""), {"status": "applied"})
        self.page.evaluate("window.oldRequest = editor.capture('conclusion')")
        self.open("B", findings="B-base", conclusion="B-base", recommendation="B-base")
        for field in FIELDS:
            self.focus(field)
            self.key("End")
            self.page.keyboard.type("-B-new")
        self.open("A", findings="A-shown", conclusion="A-shown", recommendation="A-shown")
        self.assertEqual(self.page.evaluate("editor.insert(oldRequest, 'late')")['status'], 'refused')
        for field in FIELDS:
            self.focus(field)
            for key in ["Control+z", "Control+y", "Control+Shift+z"] * 5:
                self.key(key)
                self.assertEqual(self.read(), dict.fromkeys(FIELDS, "A-shown"))
        self.type("NEW", "conclusion")
        for key in ["Control+z"] * 8 + ["Control+Shift+z"] * 8:
            self.key(key)
            self.assertTrue(all("A-OLD" not in v and "B-" not in v for v in self.read().values()))

    def test_t4_new_sequence_same_text_has_no_old_history(self):
        self.type("SAME")
        self.open("A", findings="SAME")
        self.focus()
        self.key("Control+z")
        self.assert_text("SAME")
        self.key("Control+y")
        self.assert_text("SAME")

    def test_t5_each_insertion_kind_undo_redo(self):
        """TEST-REF-T5a: each consumer uses range insertion, server/structure uses sent text."""
        for kind in ("shortcut", "template", "dictation", "citation", "paste", "clear", "server", "structure"):
            for field in FIELDS:
                with self.subTest(kind=kind, field=field):
                    self.open(kind)
                    self.type("typed", field)
                    start, end = (0, 5) if kind in ("clear", "shortcut") else (5, 5)
                    self.capture(field, start, end)
                    text = "" if kind == "clear" else "INSERT"
                    expected = "typed"[:start] + text + "typed"[end:]
                    if kind in ("server", "structure"):
                        expected = "SERVER"
                        result = self.server(expected if kind == "structure" else "typed", expected)
                    else:
                        result = self.insert(text)
                    self.assertEqual(result, {"status": "applied"})
                    self.assert_text(expected, field)
                    self.key("Control+z")
                    self.assert_text("typed", field)
                    self.key("Control+z")
                    self.assert_text("", field)
                    self.key("Control+y")
                    self.assert_text("typed", field)
                    self.key("Control+Shift+z")
                    self.assert_text(expected, field)

    def test_t5_typing_after_insert_and_consecutive_inserts(self):
        """TEST-REF-T5b: both ends of the undo step, including deletion and consecutive edits."""
        for clear in (False, True):
            with self.subTest(clear=clear):
                self.open("A")
                self.type("abc")
                self.capture(start=0 if clear else 3, end=3)
                self.assertEqual(self.insert("" if clear else "X"), {"status": "applied"})
                inserted = "" if clear else "abcX"
                self.page.keyboard.type("Y")
                self.key("Control+z")
                self.assert_text(inserted)
                self.key("Control+z")
                self.assert_text("abc")
                self.key("Control+z")
                self.assert_text("")
                for expected in ("abc", inserted, inserted + "Y"):
                    self.key("Control+y")
                    self.assert_text(expected)
        self.open("C")
        for text in ("one", "two", "three"):
            self.capture()
            self.assertEqual(self.insert(text), {"status": "applied"})
        for text in ("onetwo", "one", ""):
            self.key("Control+z")
            self.assert_text(text)

    def test_t5_native_input_and_plain_text_newlines(self):
        self.type("abc")
        self.capture(start=1, end=2)
        self.page.evaluate("window.inputs = []; document.addEventListener('input', e => inputs.push([e.isTrusted, editor.read('findings')]));")
        self.assertEqual(self.insert("<b>x</b>\r\ny\rz"), {"status": "applied"})
        expected = "a<b>x</b>\ny\nzc"
        self.assert_text(expected)
        # Chromium emits several native input events for one multiline command; one Undo is the contract.
        inputs = self.page.evaluate("inputs")
        self.assertTrue(inputs)
        self.assertTrue(all(event == [True, expected] for event in inputs))
        self.key("Control+z")
        self.assert_text("abc")

    def test_t7_composing_tab_skips_shortcut_and_navigates(self):
        """TEST-REF-T7: Tab itself commits Chromium composition before focusout, no second CDP commit."""
        self.page.evaluate("""() => {
          window.events = []; window.expansions = [];
          for (const type of ['compositionstart','compositionupdate','input','keydown','compositionend','focusout'])
            document.addEventListener(type, e => events.push({type, id:e.target.id, composing:e.isComposing, key:e.key}), true);
          document.addEventListener('keydown', e => {
            if (e.key !== 'Tab' || e.shiftKey || e.target.id !== 'findings') return;
            const at = editor.capture('findings', {start:2,end:e.target.value.length});
            const result = editor.insert(at, 'EXPANDED');
            expansions.push(result);
            if (result.status === 'applied') e.preventDefault();
          });
        }""")
        self.type("x\n")
        self.compose("흉부")
        self.assertTrue(self.page.evaluate("editor.isComposing('findings')"))
        self.key("Tab")
        self.assertEqual(self.page.evaluate("expansions"), [{"status": "refused", "reason": "composing"}])
        self.assertEqual(self.read(), {"findings": "x\n흉부", "conclusion": "", "recommendation": ""})
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "conclusion")
        self.assertFalse(self.page.evaluate("editor.isComposing()"))
        events = self.page.evaluate("events")
        tab = next(i for i, e in enumerate(events) if e.get("key") == "Tab")
        end = next(i for i, e in enumerate(events) if e["type"] == "compositionend")
        blur = next(i for i, e in enumerate(events) if e["type"] == "focusout")
        self.assertTrue(events[tab]["composing"])
        self.assertLess(tab, end)
        self.assertLess(end, blur)
        self.assertEqual(sum(e['type'] == 'compositionend' for e in events), 1)

    def test_t7_ordinary_tab_and_shift_tab(self):
        self.focus("before")
        for field in (*FIELDS, "after"):
            self.key("Tab")
            self.assertEqual(self.page.evaluate("document.activeElement.id"), field)
        for field in (*reversed(FIELDS), "before"):
            self.key("Shift+Tab")
            self.assertEqual(self.page.evaluate("document.activeElement.id"), field)
        self.assertEqual(self.read(), dict.fromkeys(FIELDS, ""))

    def test_t6_server_during_composition_each_field(self):
        for field in FIELDS:
            with self.subTest(field=field):
                self.open("A")
                self.type("before-after", field)
                self.page.evaluate("k => editor.element(k).setSelectionRange(7,7)", field)
                self.capture(field)
                cdp = self.compose()
                self.assertTrue(self.page.evaluate("k => editor.isComposing(k)", field))
                before = self.read()
                self.assertEqual(self.server("before-after", "SERVER")['status'], 'refused')
                self.assertEqual(self.read(), before)
                cdp.send("Input.insertText", {"text": "한"})
                self.assert_text("before-한after", field)
                self.assertFalse(self.page.evaluate("editor.isComposing()"))
                self.assertEqual(self.server("before-after", "SERVER")['status'], 'refused')
                self.assert_text("before-한after", field)
                self.assertEqual(self.page.evaluate("k => editor.element(k).selectionStart", field), 8)
                cdp.detach()

    def test_t6_composition_in_another_field_is_not_committed_by_insertion(self):
        self.capture("conclusion")
        self.focus()
        cdp = self.compose()
        self.assertEqual(self.insert("OTHER"), {"status": "refused", "reason": "composing"})
        self.assertTrue(self.page.evaluate("editor.isComposing('findings')"))
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "findings")
        cdp.send("Input.insertText", {"text": "한"})
        self.assertEqual(self.read(), {"findings": "한", "conclusion": "", "recommendation": ""})

    def test_t6_ts08_later_typing_and_edit_then_undo(self):
        for kind in ("server", "structure", "insert"):
            for field in FIELDS:
                with self.subTest(kind=kind, field=field):
                    self.open("A")
                    self.type("sent", field)
                    self.capture(field)
                    self.page.keyboard.type(" later")
                    result = self.insert("PASTE") if kind == "insert" else self.server("STRUCTURED" if kind == "structure" else "sent", "STRUCTURED")
                    self.assertEqual(result['status'], 'refused')
                    self.assert_text("sent later", field)
        self.open("B", findings="same")
        self.focus()
        self.key("End")
        self.capture()
        self.page.keyboard.type(" edit")
        self.key("Control+z")
        self.assert_text("same")
        self.assertEqual(self.server("same", "STALE")['status'], 'refused')
        self.assert_text("same")

    def test_t6_server_requires_the_actual_sent_text(self):
        self.type("actual")
        self.capture()
        self.assertEqual(self.server("invented", "replace"), {"status": "refused", "reason": "sent-mismatch"})
        self.assert_text("actual")

    def test_t3_captured_position_survives_caret_and_focus_move(self):
        self.type("0123456789", "conclusion")
        self.page.evaluate("editor.element('conclusion').setSelectionRange(2,5,'backward')")
        self.capture("conclusion")
        self.key("End")
        self.focus("after")
        self.assertEqual(self.insert("PASTE"), {"status": "applied"})
        self.assert_text("01PASTE56789", "conclusion")
        self.assert_text("")
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "after")
        self.focus("conclusion")
        self.key("Control+z")
        self.assert_text("0123456789", "conclusion")

    def test_t3_readonly_disabled_and_policy_at_apply_time(self):
        for field in FIELDS:
            for lock in ("readOnly", "disabled", "policy"):
                with self.subTest(field=field, lock=lock):
                    self.open("A")
                    self.page.evaluate("() => { allowed=true; for (const k of ['findings','conclusion','recommendation']) { editor.element(k).readOnly=false; editor.element(k).disabled=false; } }")
                    self.type("mine", field)
                    self.capture(field)
                    self.page.evaluate("x => { if (x.lock === 'policy') allowed=false; else editor.element(x.field)[x.lock]=true; }", {"field":field,"lock":lock})
                    self.assertEqual(self.insert("forbidden"), {"status": "refused", "reason": "readonly"})
                    self.assertEqual(self.server("mine", "forbidden")['status'], 'refused')
                    self.assert_text("mine", field)

    def test_t3_permission_changes_on_focus_and_native_failure(self):
        self.type("mine")
        self.capture()
        self.focus("after")
        self.page.evaluate("editor.element('findings').addEventListener('focus', () => { allowed=false; }, {once:true})")
        self.assertEqual(self.insert("forbidden")['status'], 'refused')
        self.assert_text("mine")
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "after")
        self.page.evaluate("allowed=true; document.execCommand = () => false")
        self.assertEqual(self.insert("unsupported"), {"status": "refused", "reason": "native-edit"})
        self.assert_text("mine")

    def test_t3_requests_retired_on_different_study_and_same_uid_reopening(self):
        self.open("A", findings="A")
        self.focus()
        self.capture()
        self.open("B", findings="A")
        self.assertEqual(self.insert("OLD")['status'], 'refused')
        self.assertEqual(self.server("A", "OLD")['status'], 'refused')
        self.open("A", findings="A")
        self.assertEqual(self.insert("OLD")['status'], 'refused')
        self.assert_text("A")

    def test_unfocusable_target_never_edits_the_active_field(self):
        self.type("KEEP", "findings")
        self.capture("recommendation")
        self.page.evaluate("editor.element('recommendation').style.display='none'")
        result = self.insert("WRONG")
        self.assertEqual(self.read(), {"findings":"KEEP", "conclusion":"", "recommendation":""})
        self.assertEqual(result, {"status": "refused", "reason": "unavailable"})
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "findings")

    def test_native_length_limit_cannot_partially_apply_text(self):
        self.type("mine")
        self.capture()
        self.page.evaluate("editor.element('findings').maxLength=6")
        result = self.insert("TOO LONG")
        self.assert_text("mine")
        self.assertEqual(result, {"status": "refused", "reason": "length"})
        self.key("Control+z")
        self.assert_text("")

    def test_ordinary_same_opening_preserves_history_selection_and_composition(self):
        self.type("typed")
        self.page.evaluate("editor.element('findings').setSelectionRange(1,3,'backward')")
        self.assertEqual(self.page.evaluate("editor.switchStudy({uid:'A',selectionSeq:1}, editor.read())"), {"status": "unchanged"})
        self.assertEqual(self.page.evaluate("[editor.element('findings').selectionStart,editor.element('findings').selectionEnd,editor.element('findings').selectionDirection]"), [1,3,'backward'])
        self.key("Control+z")
        self.assert_text("")
        cdp = self.compose()
        self.assertEqual(self.page.evaluate("editor.switchStudy({uid:'A',selectionSeq:1}, editor.read())")['status'], 'unchanged')
        self.assertTrue(self.page.evaluate("editor.isComposing()"))
        self.assertEqual(self.page.evaluate("editor.switchStudy({uid:'B',selectionSeq:2}, editor.read())"), {"status": "refused", "reason": "composing"})
        cdp.send("Input.insertText", {"text": "한"})
        self.assert_text("한")

    def test_ordinary_new_opening_preserves_visible_caret_focus_scroll(self):
        text = "\n".join("long " + str(i) + " x" * 100 for i in range(80))
        self.open("A", **dict.fromkeys(FIELDS, text))
        self.focus("conclusion")
        self.page.evaluate("""() => {
          for (const k of ['findings','conclusion','recommendation']) {
            const el = editor.element(k); el.setSelectionRange(300,310,'backward'); el.scrollTop=140; el.scrollLeft=40;
          }
          document.getElementById('frame').scrollTop=12;
          window.visibleState = () => ({focus:document.activeElement.id, outer:document.getElementById('frame').scrollTop,
            fields: ['findings','conclusion','recommendation'].map(k => { const e=editor.element(k), r=e.getBoundingClientRect();
              return [e.value,e.selectionStart,e.selectionEnd,e.selectionDirection,e.scrollTop,e.scrollLeft,r.x,r.y,r.width,r.height]; })});
        }""")
        before = self.page.evaluate("visibleState()")
        self.assertGreater(before['fields'][1][4], 0)
        self.assertGreater(before['fields'][1][5], 0)
        self.assertGreater(before['outer'], 0)
        self.open("A", **dict.fromkeys(FIELDS, text))
        self.assertEqual(self.page.evaluate("visibleState()"), before)

    def test_ordinary_typing_is_native_and_synchronous(self):
        self.focus()
        self.page.evaluate("""() => {
          window.typed = []; window.focusChanges = []; window.originalField=editor.element('findings');
          document.addEventListener('input', e => typed.push({value:editor.read('findings'), trusted:e.isTrusted, composing:e.isComposing}));
          document.addEventListener('focusin', e => focusChanges.push(e.target.id));
        }""")
        self.page.keyboard.type("abcdefghijklmnopqrstuvwxyz0123456789", delay=0)
        observed = self.page.evaluate("typed")
        text = "abcdefghijklmnopqrstuvwxyz0123456789"
        self.assertEqual([x['value'] for x in observed], [text[:i] for i in range(1, len(text)+1)])
        self.assertTrue(all(x['trusted'] and not x['composing'] for x in observed))
        self.assertTrue(self.page.evaluate("originalField === editor.element('findings')"))
        self.assertEqual(self.page.evaluate("focusChanges"), [])
        self.key("Control+z")
        self.assert_text("")

    def test_ordinary_insert_keeps_scroll_and_has_no_extra_focus_cycle(self):
        text = "\n".join("line %s " % i + "x" * 100 for i in range(60))
        self.open("A", findings=text)
        self.focus()
        self.page.evaluate("editor.element('findings').setSelectionRange(1,2); editor.element('findings').scrollTop=140; editor.element('findings').scrollLeft=30; window.focusChanges=[]; document.addEventListener('focusin', e=>focusChanges.push(e.target.id));")
        self.capture()
        self.assertEqual(self.insert("REPLACE"), {"status": "applied"})
        self.assertEqual(self.page.evaluate("[editor.element('findings').scrollTop,editor.element('findings').scrollLeft,document.activeElement.id]"), [140,30,'findings'])
        self.assertEqual(self.page.evaluate("focusChanges"), [])
        self.assertEqual(self.page.evaluate("editor.element('findings').selectionStart"), 8)

    def test_same_opening_cannot_bypass_safe_apply(self):
        self.type("mine")
        self.assertEqual(self.page.evaluate("editor.switchStudy({uid:'A',selectionSeq:1}, {findings:'overwrite',conclusion:'',recommendation:''})"), {"status":"refused","reason":"same-opening"})
        self.assert_text("mine")

    def test_browser_fact_value_and_set_range_text_do_not_supply_undo_steps(self):
        """Negative controls justify using native insertion instead of value/setRangeText."""
        for expression in ("e.value='abcX'", "e.setRangeText('X',3,3,'end')"):
            with self.subTest(expression=expression):
                self.open("fact")
                self.type("abc")
                self.page.evaluate("() => { const e=editor.element('findings'); " + expression + "; }")
                self.key("Control+z")
                self.assert_text("abcX")

    def test_browser_fact_history_is_document_wide(self):
        self.type("first", "findings")
        self.type("second", "conclusion")
        self.focus("findings")
        self.key("Control+z")
        self.assert_text("first")
        self.assert_text("", "conclusion")
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "conclusion")


# Each mutation changes one product line; assertions never require these source spellings.
MUTANTS = [
    ("M01-reuse-node", "old.replaceWith(next);", "old.value = next.value; s.el = old;", [
        "test_t4_empty_study_boundary_all_fields", "test_t4_reopen_same_uid_and_mixed_history",
        "test_t4_new_sequence_same_text_has_no_old_history"]),
    ("M02-reset-current-opening", "if (opening && opening.uid === context.uid", "if (false && opening && opening.uid === context.uid", [
        "test_ordinary_same_opening_preserves_history_selection_and_composition", "test_same_opening_cannot_bypass_safe_apply"]),
    ("M03-uid-only-request", "at.opening !== opening", "at.opening?.uid !== opening.uid", [
        "test_t3_requests_retired_on_different_study_and_same_uid_reopening"]),
    ("M04-value-assignment", "const accepted = doc.execCommand('insertText', false, text);", "const accepted = (el.value = expected, true);", [
        "test_t5_each_insertion_kind_undo_redo", "test_t5_native_input_and_plain_text_newlines"]),
    ("M05-live-caret", "el.setSelectionRange(start, end);", "// Use the live caret instead of the requested range.", [
        "test_t3_captured_position_survives_caret_and_focus_move"]),
    ("M06-merge-following-typing", "el.setSelectionRange(start + text.length, start + text.length);", "// Leave the typing group open.", [
        "test_t5_typing_after_insert_and_consecutive_inserts"]),
    ("M07-write-during-composition", "if (isComposing()) return 'composing';", "// Allow a native edit during composition.", [
        "test_t7_composing_tab_skips_shortcut_and_navigates"]),
    ("M08-commit-other-composition", "if (isComposing()) return 'composing';", "if (state(at.field).composing) return 'composing';", [
        "test_t6_composition_in_another_field_is_not_committed_by_insertion"]),
    ("M09-no-edit-generation", "const input = () => { s.revision++; };", "const input = () => {};", [
        "test_t6_ts08_later_typing_and_edit_then_undo"]),
    ("M10-overwrite-new-input", "if (s.revision !== at.revision || s.el.value !== at.text) return 'changed';", "// Overwrite even after later input.", [
        "test_t6_ts08_later_typing_and_edit_then_undo"]),
    ("M11-ignore-sent", "if (typeof sent !== 'string' || (sent !== at?.text && sent !== text)) return refused('sent-mismatch');", "// Trust a mismatched sent snapshot.", [
        "test_t6_server_requires_the_actual_sent_text"]),
    ("M12-ignore-permission", " || !canEdit(at.field)", "", [
        "test_t3_readonly_disabled_and_policy_at_apply_time"]),
    ("M13-no-focus-recheck", "        why = blocked(at);", "        why = null;", [
        "test_t3_permission_changes_on_focus_and_native_failure"]),
    ("M14-reset-scroll", "for (const [el, top, left] of positions) { el.scrollTop = top; el.scrollLeft = left; }", "for (const [el] of positions) { el.scrollTop = 0; el.scrollLeft = 0; }", [
        "test_ordinary_insert_keeps_scroll_and_has_no_extra_focus_cycle"]),
    ("M15-drop-focused-field", "if (focused) focused.next.focus({ preventScroll: true });", "// Drop editor focus on replacement.", [
        "test_ordinary_new_opening_preserves_visible_caret_focus_scroll"]),
    ("M16-interrupt-composition", "if (isComposing()) return refused('composing');", "// Replace the active composing field.", [
        "test_ordinary_same_opening_preserves_history_selection_and_composition"]),
    ("M17-swallow-typing", "s.el.addEventListener('input', input);", "s.el.addEventListener('input', input); s.el.addEventListener('beforeinput', e => e.preventDefault());", [
        "test_ordinary_typing_is_native_and_synchronous"]),
    ("M18-composition-never-ends", "const end = () => { s.composing = false; };", "const end = () => { s.composing = true; };", [
        "test_t6_server_during_composition_each_field"]),
    ("M19-trap-tab", "s.el.addEventListener('input', input);", "s.el.addEventListener('input', input); s.el.addEventListener('keydown', e => { if (e.key === 'Tab') e.preventDefault(); });", [
        "test_t7_ordinary_tab_and_shift_tab"]),
    ("M20-native-failure-is-success", "if (!accepted || !applied) return refused('native-edit');", "if (!accepted || !applied) return { status: 'applied' };", [
        "test_t3_permission_changes_on_focus_and_native_failure"]),
    ("M21-hide-current-text", "return name === undefined ? Object.fromEntries(names.map(k => [k, state(k).el.value])) : state(name).el.value;", "return name === undefined ? Object.fromEntries(names.map(k => [k, ''])) : '';", [
        "test_browser_fact_value_and_set_range_text_do_not_supply_undo_steps", "test_browser_fact_history_is_document_wide"]),
    ("M22-edit-active-instead-of-target", "if (doc.activeElement !== el) return refused('unavailable');", "// Edit whichever field still has focus.", [
        "test_unfocusable_target_never_edits_the_active_field"]),
    ("M23-allow-truncation", "if (el.maxLength >= 0 && expected.length > el.maxLength) return refused('length');", "// Let the browser silently truncate the insertion.", [
        "test_native_length_limit_cannot_partially_apply_text"]),
]


def run_mutants():
    killed = 0
    for label, old, new, names in MUTANTS:
        if SOURCE.count(old) != 1 or '\n' in old or '\n' in new:
            raise AssertionError("Mutation location must be unique and one line: " + label)
        ReportEditorFrameDOM.source = SOURCE.replace(old, new, 1)
        output = io.StringIO()
        result = unittest.TextTestRunner(stream=output, verbosity=2).run(
            unittest.TestSuite(ReportEditorFrameDOM(n) for n in names))
        print(label + ": " + old + " -> " + new)
        print(output.getvalue(), end="")
        failed = {case.id().split(' (', 1)[0].rsplit('.', 1)[-1] for case, _ in result.failures}
        caught = result.testsRun == len(names) and failed == set(names) and not result.errors and not result.skipped
        print(label + (" KILLED (every designated test asserted)" if caught else " NOT PROVEN"), flush=True)
        killed += int(caught)
    ReportEditorFrameDOM.source = SOURCE
    print("Mutants killed: %s/%s" % (killed, len(MUTANTS)))
    return 0 if killed == len(MUTANTS) else 1


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mutants", action="store_true")
    parser.add_argument("tests", nargs="*")
    args = parser.parse_args()
    if args.mutants:
        return run_mutants()
    names = args.tests or unittest.defaultTestLoader.getTestCaseNames(ReportEditorFrameDOM)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(ReportEditorFrameDOM(n) for n in names))
    return 0 if result.wasSuccessful() and not result.skipped else 1


if __name__ == "__main__":
    raise SystemExit(main())
