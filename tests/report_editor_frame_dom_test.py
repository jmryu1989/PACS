# coding: utf-8
"""REQ-WS5/WS6/WS7 text boundary -> RISK-T4/T5/T7/T6/T3/TS08 -> TEST-REF-*.

Isolated Chromium module contract plus --page delivered HTML/bundle against synthetic HTTP; no stack.
Assertions cover public results, text, native undo, composition and visible editor state.
The optional one-line mutants run in memory, never rewrite product files. Their anchors
are mutation locations, not product-shape assertions. No new parser or byte pins.
"""
import argparse
import io
import json
import sys
import time
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

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
# A report field's visible height inside its parent (the shared scroller) and, read in the same moment, what explains it:
# both rects, every scrolled ancestor, the window scroll, focus, the field's editability, the selected study, document
# and font readiness, open dialogs and busy regions, and which ancillary notices are laid out.
FIELD_VISIBILITY = """e => {
  const box = n => { const r = n.getBoundingClientRect(); return [r.top, r.bottom, r.height]; };
  const h = e.parentElement.getBoundingClientRect(), r = e.getBoundingClientRect();
  const scrolled = [];
  for (let n = e.parentElement; n; n = n.parentElement)
    if (n.scrollTop || n.scrollHeight > n.clientHeight + 1)
      scrolled.push([n.id || n.tagName + '.' + n.classList[0], n.scrollTop, n.scrollHeight, n.clientHeight]);
  const ids = s => [...document.querySelectorAll(s)].map(n => n.id || n.tagName);
  return {visible: Math.min(h.bottom, r.bottom) - Math.max(h.top, r.top), field: box(e), parent: box(e.parentElement),
    scrolled, scrollY: window.scrollY, viewport: [innerWidth, innerHeight],
    active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
    readOnly: e.readOnly, selected: typeof selectedUid === 'undefined' ? null : selectedUid,
    ready: document.readyState, fonts: document.fonts.status, dialogs: ids('dialog[open]'), busy: ids('[aria-busy="true"]'),
    notices: ['#question-p', '#image-request-p', '#cvr-sent-p'].filter(s => document.querySelector(s)?.getClientRects().length)};
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

    def test_t5_trailing_lf_insert_redo_with_both_shortcuts(self):
        """W6EF-F07 / RISK-T5: probe5 전체 조합과 LF 끝 상용구를 실제 키로 복원한다."""
        cases = [("ab\n", 3, t) for t in ("\n", "\n\n", "\nx\n", "x\n")]
        cases += [("ab", 2, "\n"), ("ab\n\n", 4, "\n"), ("", 0, "\n"), ("a\nb", 2, "\n"),
                  ("Liver normal.\n", 14, "No hemorrhage.\nNo mass effect.\n")]
        for base, pos, text in cases:
            with self.subTest(base=base, pos=pos, text=text):
                self.open('A', findings=base)
                self.focus()
                self.capture(start=pos, end=pos)
                self.assertEqual(self.insert(text), {'status': 'applied'})
                expected = base[:pos] + text + base[pos:]
                self.assert_text(expected)
                for redo in ('Control+y', 'Control+Shift+z'):
                    self.key('Control+z'); self.assert_text(base)
                    self.key(redo); self.assert_text(expected)

    def test_t5_trailing_lf_insert_between_typing_groups(self):
        """W6EF-F07 / RISK-T5: 앞뒤 타이핑과 삽입이 각각 Undo/Redo 한 단계다."""
        for redo in ('Control+y', 'Control+Shift+z'):
            with self.subTest(redo=redo):
                self.open('A', findings='base\n')
                self.type('typed\n')
                self.capture()
                self.assertEqual(self.insert('TEMPLATE\nLINE\n'), {'status': 'applied'})
                inserted = 'base\ntyped\nTEMPLATE\nLINE\n'
                self.page.keyboard.type('after')
                self.assert_text(inserted + 'after')
                for expected in (inserted, 'base\ntyped\n', 'base\n'):
                    self.key('Control+z'); self.assert_text(expected)
                for expected in ('base\ntyped\n', inserted, inserted + 'after'):
                    self.key(redo); self.assert_text(expected)

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

    def test_different_text_opening_types_at_end_and_unvisited_capture_uses_end(self):
        """W6EF-F01: 다른 글의 숫자 커서/스크롤은 새 opening으로 옮기지 않는다."""
        for focused in (False, True):
            with self.subTest(focused=focused):
                self.open('A', findings='old\n' * 70)
                self.focus()
                self.page.evaluate("editor.element('findings').setSelectionRange(3,6); editor.element('findings').scrollTop=200")
                if not focused:
                    self.focus('after')
                self.open('B', findings='Liver normal.\nSpleen normal.')
                self.assertEqual(self.page.evaluate("[editor.element('findings').selectionStart,editor.element('findings').selectionEnd]"), [28,28])
                self.assertEqual(self.page.evaluate("document.activeElement.id"), 'findings' if focused else 'after')
                self.focus()
                self.page.keyboard.type('X')
                self.assert_text('Liver normal.\nSpleen normal.X')
        self.open('C', findings='untouched', conclusion='same')
        # 프로그램이 선택 숫자를 설정했어도 사람이 사용하지 않은 칸은 끝으로 답한다.
        self.page.evaluate("editor.element('conclusion').setSelectionRange(1,2)")
        self.capture('conclusion')
        self.assertEqual(self.insert('PASTED')['status'], 'applied')
        self.assert_text('samePASTED', 'conclusion')
        self.page.click('#findings')
        self.page.evaluate("editor.element('findings').setSelectionRange(1,2)")
        self.capture()
        self.assertEqual(self.insert('X')['status'], 'applied')
        self.assert_text('uXtouched')

    def test_drag_across_opening_cannot_select_new_text(self):
        self.open('A', findings='0123456789 abcdefghij')
        box = self.page.locator('#findings').bounding_box()
        self.page.mouse.move(box['x']+5, box['y']+8)
        self.page.mouse.down()
        self.page.mouse.move(box['x']+60, box['y']+8)
        self.open('B', findings='B' * 20)
        self.page.mouse.move(box['x']+120, box['y']+8)
        self.page.mouse.up()
        selection = self.page.evaluate("[editor.element('findings').selectionStart,editor.element('findings').selectionEnd]")
        self.assertEqual(selection[0], selection[1])
        self.capture()
        self.assertEqual(self.insert('PASTED')['status'], 'applied')
        self.assert_text('B' * 20 + 'PASTED')

    def test_authoritative_same_selection_readonly_and_history_boundary(self):
        """W6EF-F02: 강제 교체는 권한과 독립이며 같은 선택의 ticket/Undo를 폐기한다."""
        self.type('old')
        self.capture()
        self.page.evaluate("allowed=false; for(const k of ['findings','conclusion','recommendation']) editor.element(k).readOnly=true")
        texts = dict.fromkeys(FIELDS, 'server')
        self.assertEqual(self.page.evaluate("x=>editor.replaceAuthoritative(x)", texts), {'status':'switched'})
        self.assertEqual(self.read(), texts)
        self.assertEqual(self.insert('late'), {'status':'refused','reason':'stale'})
        self.assertEqual(self.page.evaluate("editor.switchStudy({uid:'A',selectionSeq:1},editor.read())"), {'status':'unchanged'})
        self.page.evaluate("allowed=true; for(const k of ['findings','conclusion','recommendation']) editor.element(k).readOnly=false")
        self.focus()
        for key in ['Control+z','Control+y'] * 3:
            self.key(key)
            self.assertEqual(self.read(), texts)
        self.type(' edit')
        self.assertEqual(self.page.evaluate("editor.replaceAuthoritative(editor.read())")['status'], 'unchanged')
        self.key('Control+z')
        self.assert_text('server')

    def test_authoritative_same_text_preserves_nodes_caret_tickets_and_undo(self):
        """W6EF-F08 / RISK-T3/T5: 같은 글 Save/Reload는 LF 정규화 뒤 완전한 무동작이다."""
        for field in FIELDS:
            for newline in ('\n', '\r\n', '\r'):
                with self.subTest(field=field, newline=repr(newline)):
                    self.open('A', **dict.fromkeys(FIELDS, 'base\n'))
                    self.type('typed', field)
                    self.page.evaluate("k => editor.element(k).setSelectionRange(2,4,'backward')", field)
                    self.capture(field)
                    self.page.evaluate("window.nodes = ['findings','conclusion','recommendation'].map(k=>editor.element(k))")
                    texts = {k: v.replace('\n', newline) for k, v in self.read().items()}
                    self.assertEqual(self.page.evaluate('t=>editor.replaceAuthoritative(t)', texts), {'status':'unchanged'})
                    self.assertTrue(self.page.evaluate("nodes.every((el,i)=>el===editor.element(['findings','conclusion','recommendation'][i]))"))
                    self.assertEqual(self.page.evaluate("k=>{const e=editor.element(k), a=editor.capture(k);return [document.activeElement.id,e.selectionStart,e.selectionEnd,e.selectionDirection,a.start,a.end]}", field), [field,2,4,'backward',2,4])
                    self.assertEqual(self.server(self.read()[field], self.read()[field]), {'status':'unchanged'})
                    self.key('Control+z'); self.assert_text('base\n', field)
                    self.key('Control+y'); self.assert_text('base\ntyped', field)
        self.focus()
        cdp = self.compose()
        self.assertEqual(self.page.evaluate('editor.replaceAuthoritative(editor.read())'), {'status':'unchanged'})
        self.assertTrue(self.page.evaluate('editor.isComposing()'))
        cdp.send('Input.insertText', {'text':'한'})

    def test_authoritative_one_changed_field_resets_history_for_all_fields(self):
        """W6EF-F08 / RISK-T4: 한 칸만 달라도 전체가 새 경계이며 옛 글은 복원되지 않는다."""
        for field in FIELDS:
            self.type('old-' + field, field)
        self.capture('findings')
        texts = self.read()
        texts['conclusion'] = 'new'
        self.assertEqual(self.page.evaluate('t=>editor.replaceAuthoritative(t)', texts), {'status':'switched'})
        self.assertEqual(self.insert('late'), {'status':'refused','reason':'stale'})
        for field in FIELDS:
            self.focus(field)
            for key in ('Control+z', 'Control+y', 'Control+Shift+z') * 3:
                self.key(key)
                self.assertEqual(self.read(), texts)

    def test_boundary_carries_visited_mark_with_unchanged_selection(self):
        """W6EF-F09 / RISK-T3: default Paste/dictation uses the visible carried caret."""
        for boundary in ('authoritative', 'reopen'):
            with self.subTest(boundary=boundary):
                self.open('A', findings='abc def', conclusion='old')
                self.focus()
                self.key('Home')
                for _ in range(3):
                    self.key('ArrowRight')
                texts = self.read()
                texts['conclusion'] = 'new'
                if boundary == 'authoritative':
                    self.assertEqual(self.page.evaluate('t=>editor.replaceAuthoritative(t)', texts), {'status':'switched'})
                else:
                    self.open('A', **texts)
                self.assertEqual(self.page.evaluate("document.activeElement.id"), 'findings')
                visible = self.page.evaluate("[editor.element('findings').selectionStart, editor.element('findings').selectionEnd]")
                self.assertEqual(visible, [3, 3])
                self.capture()
                self.assertEqual(self.page.evaluate('[at.start, at.end]'), visible)
                self.assertEqual(self.insert('PASTE'), {'status':'applied'})
                self.assert_text('abcPASTE def')

    def test_caret_mark_and_scroll_belong_to_the_study_not_the_text(self):
        """W6EF-F11 / S3-U6: the cursor place belongs to this study's text.

        Another UID (A->B, A->B->A) starts like a new text even when every byte is the same:
        visible caret, default capture and Paste at the end, scroll as for a different text.
        The same UID reopened and an authoritative replacement keep the place (W6EF-F09)."""
        text = "\n".join("line %s " % i + "x" * 100 for i in range(60))
        end = len(text)
        state = """() => { const e = editor.element('findings');
          return [document.activeElement.id, e.selectionStart, e.selectionEnd, e.selectionDirection, e.scrollTop, e.scrollLeft]; }"""

        def visit(start, stop, top, left):
            # The reader clicks into Findings, moves the caret into the middle and scrolls.
            self.page.click('#findings')
            self.page.evaluate("v => { const e = editor.element('findings'); e.setSelectionRange(v[0], v[1], 'backward'); e.scrollTop = v[2]; e.scrollLeft = v[3]; }", [start, stop, top, left])

        for focused in (False, True):
            # Reference: what a new opening of a different text shows (W6EF-F01 path).
            self.open('A', **dict.fromkeys(FIELDS, 'old\n' * 200))
            visit(300, 310, 140, 40)
            if not focused:
                self.focus('after')
            self.open('B', **dict.fromkeys(FIELDS, text))
            fresh = self.page.evaluate(state)
            self.assertEqual(fresh[:3], ['findings' if focused else 'after', end, end])
            self.assertNotEqual(fresh[4:], [140, 40])
            for boundary in ('other-uid', 'A-B-A', 'same-uid', 'authoritative'):
                with self.subTest(focused=focused, boundary=boundary):
                    self.open('A', **dict.fromkeys(FIELDS, text))
                    visit(300, 310, 140, 40)
                    if boundary == 'A-B-A':
                        self.open('B', **dict.fromkeys(FIELDS, text))
                        visit(500, 520, 200, 60)
                    if not focused:
                        self.focus('after')
                    if boundary == 'authoritative':
                        texts = dict.fromkeys(FIELDS, text)
                        texts['recommendation'] = 'server'
                        self.assertEqual(self.page.evaluate('t=>editor.replaceAuthoritative(t)', texts), {'status': 'switched'})
                    else:
                        self.open('B' if boundary == 'other-uid' else 'A', **dict.fromkeys(FIELDS, text))
                    self.capture()
                    captured = self.page.evaluate('[at.start, at.end]')
                    if boundary in ('other-uid', 'A-B-A'):
                        self.assertEqual(self.page.evaluate(state), fresh)
                        self.assertEqual(captured, [end, end])
                        # A program-set selection is not a visit; an unvisited field still answers the end.
                        self.page.evaluate("editor.element('findings').setSelectionRange(1, 2)")
                        self.capture()
                        self.assertEqual(self.page.evaluate('[at.start, at.end]'), [end, end])
                        self.assertEqual(self.insert('PASTE'), {'status': 'applied'})
                        self.assert_text(text + 'PASTE')
                    else:
                        self.assertEqual(self.page.evaluate(state),
                                         ['findings' if focused else 'after', 300, 310, 'backward', 140, 40])
                        self.assertEqual(captured, [300, 310])
                        self.assertEqual(self.insert('PASTE'), {'status': 'applied'})
                        self.assert_text(text[:300] + 'PASTE' + text[310:])

    def test_same_study_caret_carry_is_lf_only(self):
        """W6EF-F10/F13 / RISK-T3: the same-UID caret carry uses LF-only equality, no trim/NFC/NBSP folding."""
        for before, given, same in (
                ('text', 'text ', False), ('text', ' text', False), ('a b', 'a\u00a0b', False),
                ('text', 'text\n', False), ('\u00e9', 'e\u0301', False),
                ('a\nb', 'a\rb', True), ('a\nb', 'a\r\nb', True)):
            with self.subTest(given=ascii(given)):
                self.open('A', findings=before)
                self.page.click('#findings')
                self.page.evaluate("editor.element('findings').setSelectionRange(1, 1)")
                self.open('A', findings=given)
                shown = given.replace('\r\n', '\n').replace('\r', '\n')
                expected = [1, 1] if same else [len(shown), len(shown)]
                self.assertEqual(self.page.evaluate("[editor.element('findings').selectionStart, editor.element('findings').selectionEnd]"), expected)
                self.capture()
                self.assertEqual(self.page.evaluate('[at.start, at.end]'), expected)
                self.assert_text(shown)

    def test_authoritative_equality_is_lf_only(self):
        """W6EF-F10/F13 / RISK-T4: authoritative text keeps whitespace and Unicode form."""
        for before, given, same in (
                ('text', 'text ', False), ('text', ' text', False), ('a b', 'a\u00a0b', False),
                ('text', 'text\n', False), ('\u00e9', 'e\u0301', False),
                ('a\nb', 'a\rb', True), ('a\nb', 'a\r\nb', True)):
            with self.subTest(given=given):
                self.open('A', findings=before)
                texts = dict.fromkeys(FIELDS, '')
                texts['findings'] = given
                self.assertEqual(self.page.evaluate('t=>editor.replaceAuthoritative(t)', texts),
                                 {'status': 'unchanged' if same else 'switched'})
                self.assert_text(given.replace('\r\n', '\n').replace('\r', '\n'))

    def test_same_opening_equality_is_lf_only(self):
        """W6EF-F10/F13 / RISK-T4: different text needs a new opening, with no silent cleanup."""
        for before, given, same in (
                ('text', 'text ', False), ('text', ' text', False), ('a b', 'a\u00a0b', False),
                ('text', 'text\n', False), ('\u00e9', 'e\u0301', False),
                ('a\nb', 'a\rb', True), ('a\nb', 'a\r\nb', True)):
            with self.subTest(given=given):
                self.open('A', findings=before)
                texts = dict.fromkeys(FIELDS, '')
                texts['findings'] = given
                result = self.page.evaluate('x=>editor.switchStudy(x.context,x.texts)', {
                    'context': {'uid':'A', 'selectionSeq':self.seq}, 'texts':texts})
                self.assertEqual(result, {'status':'unchanged'} if same else
                                 {'status':'refused', 'reason':'same-opening'})
                self.assert_text(before)
                self.open('A', **texts)
                self.assert_text(given.replace('\r\n', '\n').replace('\r', '\n'))

    def test_authoritative_reentrant_call_refused_during_focus_and_input(self):
        """N12: 동기 페이지 listener의 권위 교체가 진행 중인 편집에 재진입할 수 있다."""
        for event in ('focus', 'input'):
            with self.subTest(event=event):
                self.open('A', findings='KEEP')
                self.focus('after')
                self.capture(start=4, end=4)
                self.page.evaluate("event=>editor.element('findings').addEventListener(event,()=>{window.reentry=editor.replaceAuthoritative({findings:'SERVER',conclusion:'',recommendation:''})},{once:true})", event)
                self.assertEqual(self.insert('X'), {'status':'applied'})
                self.assertEqual(self.page.evaluate('reentry'), {'status':'refused','reason':'busy'})
                self.assert_text('KEEPX')
                self.focus()
                self.key('Control+z'); self.assert_text('KEEP')
                self.key('Control+y'); self.assert_text('KEEPX')

    def test_authoritative_refuses_composition_then_retries_after_end(self):
        self.focus()
        cdp=self.compose()
        self.assertEqual(self.page.evaluate("editor.replaceAuthoritative({findings:'',conclusion:'',recommendation:''})"), {'status':'refused','reason':'composing'})
        self.assertTrue(self.page.evaluate('editor.isComposing()'))
        cdp.send('Input.insertText', {'text':'한'})
        self.assert_text('한')
        self.assertEqual(self.page.evaluate("editor.replaceAuthoritative({findings:'',conclusion:'',recommendation:''})")['status'],'switched')
        self.assert_text('')

    def test_recorded_insertion_replans_current_text_after_modal_and_composition(self):
        """W6EF-F03: 응답 시점의 현재 글로 계획. 거절 때 보존하고 해제 뒤 새 계획으로 재적용."""
        self.type('local later')
        self.page.evaluate("document.body.insertAdjacentHTML('beforeend','<dialog><button>OK</button></dialog>');document.querySelector('dialog').showModal()")
        self.capture(start=len('local later'),end=len('local later'))
        self.assertEqual(self.insert('\nRECORDED'), {'status':'refused','reason':'unavailable'})
        self.assert_text('local later')
        self.page.evaluate("document.querySelector('dialog').close()")
        self.focus()
        cdp=self.compose()
        self.capture(start=len(self.read()['findings']),end=len(self.read()['findings']))
        self.assertEqual(self.insert('\nRECORDED')['status'],'refused')
        cdp.send('Input.insertText', {'text':'한'})
        self.page.evaluate("window.at=editor.capture('findings',{start:editor.read('findings').length,end:editor.read('findings').length})")
        self.assertEqual(self.insert('\nRECORDED')['status'],'applied')
        self.assert_text('local later한\nRECORDED')

    def test_many_prechecks_every_field_and_clear_undo_is_per_field(self):
        """W6EF-F04: 숨김/권한/길이/낡은 ticket 하나라도 있으면 전 칸 보존."""
        for refusal in ('hidden','readonly','length','changed','composing'):
            with self.subTest(refusal=refusal):
                self.open('A', **dict.fromkeys(FIELDS,'KEEP'))
                self.page.evaluate("window.edits=['findings','conclusion','recommendation'].map(k=>({at:editor.capture(k,{start:0,end:4}),text:'REPLACED'}))")
                if refusal=='hidden': self.page.evaluate("editor.element('recommendation').style.display='none'")
                if refusal=='readonly': self.page.evaluate("editor.element('recommendation').readOnly=true")
                if refusal=='length': self.page.evaluate("editor.element('recommendation').maxLength=5")
                if refusal=='changed': self.page.evaluate("editor.element('recommendation').value='EXTERNAL'")
                cdp=None
                if refusal=='composing':
                    self.focus(); cdp=self.compose()
                before=self.read()
                self.page.evaluate("window.batchInputs=0;document.addEventListener('input',()=>batchInputs++)")
                self.assertEqual(self.page.evaluate('editor.insertMany(edits)')['status'],'refused')
                self.assertEqual(self.read(),before)
                self.assertEqual(self.page.evaluate('batchInputs'),0)
                if cdp: cdp.send('Input.insertText',{'text':'한'})
                self.page.evaluate("const e=editor.element('recommendation');e.style.display='';e.readOnly=false;e.removeAttribute('maxlength')")
        self.open('B', **dict.fromkeys(FIELDS,'KEEP'))
        self.assertEqual(self.page.evaluate("editor.insertMany(['findings','conclusion','recommendation'].map(k=>({at:editor.capture(k,{start:0,end:4}),text:''})))"), {'status':'applied'})
        self.assertEqual(self.read(),dict.fromkeys(FIELDS,''))
        self.focus()
        for field in reversed(FIELDS):
            self.key('Control+z')
            self.assert_text('KEEP',field)
        self.assertEqual(self.read(),dict.fromkeys(FIELDS,'KEEP'))

    def test_many_focus_recheck_and_native_failure_leave_all_text_intact(self):
        for failure in ('focus','native','partial'):
            with self.subTest(failure=failure):
                self.open('A', **dict.fromkeys(FIELDS,'KEEP'))
                self.focus('after')
                self.page.evaluate("allowed=true;window.edits=['findings','conclusion','recommendation'].map(k=>({at:editor.capture(k,{start:0,end:4}),text:''}))")
                if failure=='focus':
                    self.page.evaluate("editor.element('recommendation').addEventListener('focus',()=>{allowed=false},{once:true})")
                else:
                    self.page.evaluate("""failure=>{window.native=document.execCommand.bind(document);let n=0;document.execCommand=(cmd,...args)=>{
                      if(cmd==='insertText' && ++n===2) { if(failure==='partial') native(cmd,false,'BROKEN'); return false; }
                      return native(cmd,...args);
                    }}""",failure)
                result=self.page.evaluate('editor.insertMany(edits)')
                self.assertEqual(result['status'],'refused')
                self.assertEqual(result.get('historyReset',False),failure!='focus')
                self.assertEqual(self.read(),dict.fromkeys(FIELDS,'KEEP'))
                self.assertEqual(self.page.evaluate('document.activeElement.id'),'after')
                self.page.evaluate("if(window.native) document.execCommand=window.native;allowed=true")
                if failure!='focus':
                    self.focus()
                    for key in ['Control+y','Control+z','Control+Shift+z'] * 3:
                        self.key(key)
                        self.assertEqual(self.read(),dict.fromkeys(FIELDS,'KEEP'))

    def test_external_value_change_refuses_insert_and_server_without_touching_text(self):
        """W6EF-F06/R01: DOM 대입은 input revision을 올리지 않아도 감지해야 한다."""
        for kind in ('insert','server'):
            with self.subTest(kind=kind):
                self.open('A',findings='before')
                self.capture()
                self.page.evaluate("editor.element('findings').value='outside'")
                result=self.insert('X') if kind=='insert' else self.server('before','SERVER')
                self.assertEqual(result,{'status':'refused','reason':'changed'})
                self.assert_text('outside')

    def test_same_text_server_has_no_event_caret_move_or_undo_step(self):
        self.type('typed')
        self.page.evaluate("editor.element('findings').setSelectionRange(1,3,'backward');window.n=0;document.addEventListener('input',()=>n++)")
        self.capture()
        self.assertEqual(self.server('typed','typed'),{'status':'unchanged'})
        self.assertEqual(self.page.evaluate("[n,editor.element('findings').selectionStart,editor.element('findings').selectionEnd,editor.element('findings').selectionDirection]"),[0,1,3,'backward'])
        self.key('Control+z')
        self.assert_text('')

    def test_failed_native_edit_restores_live_selection(self):
        self.type('0123456789')
        self.capture(start=1,end=3)
        self.page.evaluate("editor.element('findings').setSelectionRange(5,8,'backward');document.execCommand=()=>false")
        self.assertEqual(self.insert('X'),{'status':'refused','reason':'native-edit'})
        self.assert_text('0123456789')
        self.assertEqual(self.page.evaluate("[editor.element('findings').selectionStart,editor.element('findings').selectionEnd,editor.element('findings').selectionDirection]"),[5,8,'backward'])

    def test_forged_ticket_and_invalid_range_cannot_edit(self):
        self.type('keep')
        self.capture()
        self.assertEqual(self.page.evaluate("editor.insert({...at},'FORGED')"),{'status':'refused','reason':'stale'})
        self.assert_text('keep')
        for start,end in [(-1,0),(2,1),(0,5),(0.5,2),(0,None)]:
            self.assertTrue(self.page.evaluate("r=>{try{editor.capture('findings',r);return false}catch(e){return e instanceof TypeError}}",{'start':start,'end':end}) if end is not None else self.page.evaluate("()=>{try{editor.capture('findings',{start:NaN,end:2});return false}catch(e){return e instanceof TypeError}}"))

    def test_reentrant_switch_refused_and_ancestor_scroll_restored(self):
        self.type('KEEP')
        self.capture()
        self.page.evaluate("document.addEventListener('input',()=>{window.reentry=editor.switchStudy({uid:'B',selectionSeq:9},{findings:'B',conclusion:'',recommendation:''})},{once:true})")
        self.assertEqual(self.insert('X')['status'],'applied')
        self.assertEqual(self.page.evaluate('reentry'),{'status':'refused','reason':'busy'})
        self.assert_text('KEEPX')
        # 노드 제거 시 overflow 높이 축소는 scrollTop을 제한한다. 복구 없으면 컨테이너가 점프한다.
        self.page.evaluate("document.getElementById('frame').scrollTop=999;window.outerBefore=document.getElementById('frame').scrollTop")
        before=self.page.evaluate('outerBefore')
        self.assertGreater(before,0)
        self.open('B', findings='B')
        self.assertEqual(self.page.evaluate("document.getElementById('frame').scrollTop"),before)

    def test_detached_field_is_refused_without_editing_another_field(self):
        self.type('KEEP')
        self.capture('conclusion')
        self.page.evaluate("editor.element('conclusion').remove()")
        self.assertEqual(self.insert('X'),{'status':'refused','reason':'unavailable'})
        self.assert_text('KEEP')

    def test_long_plain_text_insert_native_events_and_one_undo(self):
        """W6EF-F07: 긴 상용구도 한 편집이다. 다수 input/실행 시간 한계는 probe에서 기록."""
        for lines in (50,150,300):
            with self.subTest(lines=lines):
                self.open('A')
                self.type('before')
                self.capture(start=2,end=4)
                self.page.evaluate("window.n=0;editor.element('findings').addEventListener('input',()=>n++)")
                text=('  간유리음영 없음 <img src=x onerror=alert(1)> &amp;\t  \n'*lines)
                self.assertEqual(self.insert(text),{'status':'applied'})
                self.assert_text('be'+text+'re')
                self.assertGreater(self.page.evaluate('n'),0)
                self.page.keyboard.type('!')
                self.key('Control+z'); self.assert_text('be'+text+'re')
                self.key('Control+z'); self.assert_text('before')
                self.key('Control+y'); self.assert_text('be'+text+'re')

    def test_multiline_special_characters_are_literal(self):
        for text in ('\n\n','\n leading\ntrailing \n','a\x00b\nc','x\ud83dy\nz','\u2028\u00a0\n\u1112\u1161\u11ab👍🏽','<script>window.bad=1</script>\n& &#0;'):
            with self.subTest(text=ascii(text)):
                self.open('A')
                self.type('keep')
                self.capture()
                # JSON escape로 UTF-16 코드 단위를 브라우저 안에서 비교한다. Python 전송층은
                # 짝없는 surrogate를 응답 문자열에서 U+FFFD로 바꿀 수 있다.
                result=self.page.evaluate("json=>{const t=JSON.parse(json);const r=editor.insert(at,t);return {result:r,exact:editor.read('findings')==='keep'+t}}",json.dumps(text,ensure_ascii=True))
                self.assertEqual(result,{'result':{'status':'applied'},'exact':True})
                self.assertFalse(self.page.evaluate('!!window.bad'))
                self.key('Control+z'); self.assert_text('keep')

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

    def active(self):
        return self.page.evaluate("document.activeElement.id || document.activeElement.tagName")

    def test_write_returns_focus_and_a_hidden_field_never_keeps_it(self):
        """W6R1-02: a write focuses its fields only for the native edit and gives focus back where it was; where that
        cannot take focus (the page itself), no field keeps it. The document-wide native Undo/Redo steps through a field
        hidden from the person (aria-hidden) and would leave focus there; focus goes back where it came from."""
        self.page.evaluate("document.getElementById('recommendation').setAttribute('aria-hidden', 'true')")
        self.type("A")
        self.page.evaluate("document.activeElement.blur()")
        many = "editor.insertMany(['findings','conclusion','recommendation'].map(k => ({at: editor.capture(k), text: 'T-' + k})))"
        self.assertEqual(self.page.evaluate(many), {"status": "applied"})
        self.assertEqual(self.active(), "BODY")
        self.capture("conclusion")
        self.assertEqual(self.insert("X"), {"status": "applied"})
        self.assertEqual(self.active(), "BODY")
        self.page.focus("#before")
        self.capture("recommendation")
        self.assertEqual(self.insert("Y"), {"status": "applied"})
        self.assertEqual(self.active(), "before")
        self.focus("findings")
        hidden = set()
        for key in ["Control+z"] * 4 + ["Control+y"] * 4 + ["Control+Shift+z", "Control+z", "Control+Shift+z"]:
            self.key(key)
            hidden.add(self.read()["recommendation"])
            self.assertNotEqual(self.active(), "recommendation", key)
        self.assertEqual(hidden, {"", "T-recommendation", "T-recommendationY"})
        self.page.keyboard.type("Q")
        self.assertNotIn("Q", self.read()["recommendation"])

    def test_is_current_follows_the_opening_and_edits_not_the_moment(self):
        """W6R1-04: a request is current while its opening stands and its field has had no edit since it was taken
        (an edit later undone included); composition and edit permission are moments of a write, not of the request."""
        self.type("ab")
        self.capture()
        current = lambda: self.page.evaluate("editor.isCurrent(at)")
        self.assertTrue(current())
        self.page.evaluate("allowed = false")
        self.assertTrue(current())
        self.page.evaluate("allowed = true")
        self.focus("conclusion")
        cdp = self.compose()
        self.assertTrue(current(), "a composition in another field")
        cdp.send("Input.insertText", {"text": "한"})
        cdp.detach()
        self.assertTrue(current(), "an edit of another field")
        self.focus("findings")
        self.key("End")
        self.key("x")
        self.key("Backspace")
        self.assert_text("ab")
        self.assertFalse(current())
        self.capture()
        self.type("y")
        self.key("Control+z")
        self.assertFalse(current())
        self.capture()
        self.assertTrue(current())
        self.open("B")
        self.assertFalse(current())
        self.assertFalse(self.page.evaluate("editor.isCurrent(null)"))


# Each mutation changes one product line; unchanged context can disambiguate an anchor.
# Assertions never require these source spellings.
class ReportEditorFramePageDOM(unittest.TestCase):
    """REQ-WS5/6/7 -> RISK-UID/HISTORY/DUPLICATE-INPUT -> W6-PAGE integration.

    Actual delivered HTML, bundle, frame and session modules; only HTTP is synthetic.
    Unlike the module fixture, Recommendation is hidden as it is for the doctor.
    """
    source = SOURCE
    bundle_source = None
    html_source = None
    dictation_source = None
    session_source = None

    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        import auth_logout_dom_test as h
        from report_text_boundaries_dom_test import MultiStudySite
        self.h = h
        self.site = MultiStudySite()
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.context.route("**/report-editor-frame.js", lambda route: route.fulfill(
            body=self.source, content_type="text/javascript; charset=utf-8"))
        if self.dictation_source is not None:
            self.context.route("**/dictation.js", lambda route: route.fulfill(
                body=self.dictation_source, content_type="text/javascript; charset=utf-8"))
        if self.session_source is not None:
            self.context.route("**/dictation-session.js", lambda route: route.fulfill(
                body=self.session_source, content_type="text/javascript; charset=utf-8"))
        if self.bundle_source is not None:
            self.context.route("**/main-split.bundle.js", lambda route: route.fulfill(
                body=self.bundle_source, content_type="text/javascript; charset=utf-8"))
        if self.html_source is not None:
            self.context.route("**/main.html", lambda route: route.fulfill(
                body=self.html_source, content_type="text/html; charset=utf-8"))
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        # Full-page routing serves all shipped assets; shared-host startup is not an editor latency assertion.
        self.page.set_default_navigation_timeout(30000)
        self.addCleanup(self.context.close)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: dialog.accept())
        self.page.clock.install()
        self.page.goto(h.MAIN_URL)
        self.page.locator("#rows tr", has_text=h.PATIENT).first.click()
        self.page.wait_for_function("() => !document.querySelector('#findings').readOnly")

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])
        self.assertEqual(self.site.violations, [])

    def texts(self):
        return {k: self.page.locator('#' + k).input_value() for k in FIELDS}

    def switch(self, patient):
        # W4 decided difference (W4-PAGE-06): with unconfirmed text the move waits for that text's draft save, so the
        # switch is complete when the page has selected the study, not when the click returns.
        row = self.page.locator('#rows tr', has_text=patient).first
        uid = row.get_attribute('data-uid')
        row.click()
        self.page.wait_for_function('uid => selectedUid === uid', arg=uid)

    def keep_hold_claim(self):
        """The page claims the study's hold once two characters are typed, and its answer re-renders the report
        section (render, buttons, loadReport). Chromium ends the open typing (undo) group at that re-render, so an
        answer that lands between two keystrokes splits typing that a case asserts as one group, and its caret
        follow-up moves the shared scroller (8/20 on 8e33fb6 too). Cases that assert a typing group or a scroll
        position keep the claim unanswered here and answer it with answer_hold_claim() where the case chooses."""
        self.kept_claims = []
        self.context.route('**/api/studies/*/hold', lambda route: self.kept_claims.append(route)
                           if route.request.method == 'POST' else route.fallback())

    def answer_hold_claim(self):
        """Answer the kept claim and wait for the observable result: the page has applied the study's holder."""
        deadline = time.monotonic() + 10
        while not self.kept_claims:
            self.assertLess(time.monotonic(), deadline, 'the typing claimed the hold')
            self.page.wait_for_timeout(20)
        for route in self.kept_claims:
            route.fallback()
        self.kept_claims.clear()
        self.page.wait_for_function('() => !!appState[selectedUid]?.holder')

    def record_dictation(self):
        """Shipped controller/session + page adapter; synthetic microphone bytes and HTTP transcript. The page's own
        adapter functions are passed as the page passes them, and a click in a report field reaches this controller
        through the page's field delegation as it reaches the page's own (the click re-pin gesture)."""
        self.context.route('**/dictation', lambda route: route.fulfill(json={
            'text':'SYN delayed', 'seconds':1, 'languagePin':'ko', 'enginePin':'synthetic', 'modelPin':'synthetic'}))
        self.page.evaluate("""async () => {
          window.recorded = KinDictation.createController({
            session:KinDictationSession,
            capture:{available:()=>true,createCapture:()=>({start:async()=>{},stop:async()=>new Uint8Array(48),cancel:()=>{}})},
            env:{isSecureContext:true,navigator:{mediaDevices:{getUserMedia(){}}}}, apiBase:API,
            readContext:dictationContext, block:dictationBlock, insert:dictationInsert, current:dictationCurrent,
            busy:()=>commitInFlight||insertInFlight
          });
          onReportField('mouseup', () => recorded.fieldClicked());
          recorded.setServerCapability({available:true,maxBytes:1048576,timeoutMs:120000,
            languagePin:'ko',enginePin:'synthetic',modelPin:'synthetic'});
          await recorded.start();
        }""")
        self.assertEqual(self.page.evaluate('recorded.snapshot().state'), 'recording')

    def review_dictation(self):
        self.page.evaluate('recorded.stop()')
        self.page.wait_for_function("recorded.snapshot().state === 'review'")

    def assert_dictation_kept_for_a_repin(self, result, before):
        """HD05's edited-field contract: Insert refuses without touching the report, and the review keeps the
        transcript, asks for a re-pin and shows the field-changed notice."""
        self.assertFalse(result['inserted'])
        self.assertEqual(result['reason'], 'field-changed')
        self.assertEqual(self.texts(), before)
        snapshot = self.page.evaluate('recorded.snapshot()')
        self.assertEqual((snapshot['state'], snapshot['needsRepin'], snapshot['text']), ('review', True, 'SYN delayed'))
        self.assertEqual(self.page.evaluate("recorded.view().status"), self.page.evaluate("KinDictation.NOTICES['field-changed']"))

    def placed(self, field, text, caret):
        return self.page.evaluate("([field, text, caret]) => KinReportCitation.placeBlock(document.getElementById(field).value, "
                                  "text, caret, citationGuards(field)).text", [field, text, caret])

    def test_page_record_type_undo_refuses_late_dictation(self):
        # W6R1-04: typing then Undo leaves the same text but retires the recording's capture. The late Insert refuses
        # as for an edited field (HD05), keeps the transcript and Redo; Pin Caret re-pins and a fresh Insert inserts there.
        self.page.locator('#findings').fill('KEEP')
        self.page.locator('#findings').focus()
        self.record_dictation()
        self.page.keyboard.type('X')
        self.page.keyboard.press('Control+z')
        self.assertEqual(self.texts()['findings'], 'KEEP')
        self.review_dictation()
        before = self.texts()
        self.assert_dictation_kept_for_a_repin(self.page.evaluate('recorded.insert()'), before)
        self.page.locator('#findings').focus()
        self.page.keyboard.press('Control+y')
        self.assertEqual(self.texts()['findings'], 'KEEPX')
        self.page.keyboard.press('Control+z')
        self.assertEqual(self.texts()['findings'], 'KEEP')
        self.page.locator('#findings').evaluate('e => e.setSelectionRange(0, 0)')
        self.assertTrue(self.page.evaluate('recorded.repin().then(r => r.ok)'))
        self.assertEqual(self.page.evaluate('recorded.snapshot().pin.caret'), {'start': 0, 'end': 0})
        expected = self.placed('findings', 'SYN delayed', {'start': 0, 'end': 0})
        self.assertTrue(self.page.evaluate('recorded.insert().then(r => r.inserted)'))
        self.assertEqual(self.texts(), {**before, 'findings': expected})

    def test_page_record_type_backspace_keeps_dictation_for_a_click_repin(self):
        # W6R1-04: the same with Backspace, and the re-pin gesture is a click in the field.
        self.page.locator('#findings').fill('KEEP')
        self.page.locator('#findings').focus()
        self.record_dictation()
        self.page.keyboard.type('X')
        self.page.keyboard.press('Backspace')
        self.review_dictation()
        before = self.texts()
        self.assert_dictation_kept_for_a_repin(self.page.evaluate('recorded.insert()'), before)
        self.page.locator('#findings').click(position={'x': 12, 'y': 8})
        self.page.wait_for_function('() => recorded.snapshot().needsRepin === false')
        pin = self.page.evaluate('recorded.snapshot().pin')
        self.assertEqual(pin['field'], 'findings')
        self.assertEqual([pin['caret']['start'], pin['caret']['end']],
                         self.page.locator('#findings').evaluate('e => [e.selectionStart, e.selectionEnd]'))
        expected = self.placed('findings', 'SYN delayed', pin['caret'])
        self.assertTrue(self.page.evaluate('recorded.insert().then(r => r.inserted)'))
        self.assertEqual(self.texts(), {**before, 'findings': expected})

    def test_page_record_unchanged_accepts_original_caret(self):
        self.page.locator('#conclusion').fill('first\nlast')
        self.page.locator('#conclusion').evaluate('e=>e.setSelectionRange(0,5)')
        self.record_dictation()
        self.page.locator('#conclusion').evaluate('e=>e.setSelectionRange(e.value.length,e.value.length)')
        self.page.locator('#findings').focus()
        self.review_dictation()
        result = self.page.evaluate('recorded.insert()')
        self.assertTrue(result['inserted'])
        self.assertEqual(self.texts(), {'findings':'','conclusion':'first\nSYN delayed\nlast','recommendation':''})

    def test_page_record_switch_study_refuses_late_dictation(self):
        self.record_dictation()
        self.review_dictation()
        self.switch(self.h.PATIENT_B)
        self.switch(self.h.PATIENT)
        before = self.texts()
        self.assertIsNone(self.page.evaluate('recorded.insert()'))
        self.assertEqual(self.page.evaluate('recorded.snapshot().state'), 'cancelled')
        self.assertEqual(self.texts(), before)

    def test_page_record_explicit_repin_accepts_new_capture(self):
        self.record_dictation()
        self.page.locator('#findings').fill('changed')
        self.review_dictation()
        self.assertEqual(self.page.evaluate('recorded.insert().then(r=>r.reason)'), 'field-changed')
        self.page.locator('#conclusion').focus()
        self.assertTrue(self.page.evaluate('recorded.repin().then(r=>r.ok)'))
        self.assertTrue(self.page.evaluate('recorded.insert().then(r=>r.inserted)'))
        self.assertEqual(self.texts(), {'findings':'changed','conclusion':'SYN delayed','recommendation':''})

    def frame_text(self, **texts):
        """Replace authoritative synthetic report via the delivered page's load adapter."""
        self.page.evaluate("""texts => {
          appState[selectedUid] = {...appState[selectedUid], ...texts, draft:null};
          loadReport({force:true});
        }""", {k:texts.get(k, '') for k in FIELDS})

    def frame_capture(self, field='findings', start=None, end=None):
        self.page.evaluate("x=>{window.ticket=reportFrame.capture(x.field,x.range)}", {
            'field':field, 'range':None if start is None else {'start':start,'end':end}})

    def frame_insert(self, text):
        return self.page.evaluate('text=>reportFrame.insert(ticket,text)', text)

    def test_integrated_history_boundary(self):
        self.page.locator('#findings').focus()
        self.page.keyboard.type('PRIVATE')
        self.page.keyboard.press('Control+a')
        self.page.keyboard.press('Delete')
        self.switch(self.h.PATIENT_B)
        self.page.locator('#findings').focus()
        for key in ('Control+z','Control+z','Control+y','Control+Shift+z'):
            self.page.keyboard.press(key)
            self.assertEqual(self.texts(), dict.fromkeys(FIELDS,''))

    def test_integrated_same_opening(self):
        self.keep_hold_claim()
        self.page.locator('#findings').focus()
        self.page.keyboard.type('typed')
        same = 'reportFrame.switchStudy({uid:selectedUid,selectionSeq},reportFrame.read())'
        self.assertEqual(self.page.evaluate(same), {'status':'unchanged'})
        self.page.keyboard.press('Control+z')
        self.assertEqual(self.texts()['findings'], '')
        self.assertEqual(self.page.evaluate("reportFrame.switchStudy({uid:selectedUid,selectionSeq},{findings:'new',conclusion:'',recommendation:''})"), {'status':'refused','reason':'same-opening'})
        self.answer_hold_claim()

    def test_integrated_retired_ticket(self):
        self.frame_capture()
        self.switch(self.h.PATIENT_B)
        self.switch(self.h.PATIENT)
        self.assertEqual(self.frame_insert('LATE')['status'], 'refused')
        self.assertEqual(self.texts(), dict.fromkeys(FIELDS,''))

    def test_integrated_native_text_and_history(self):
        self.page.locator('#findings').focus()
        # Single keystrokes keep this contract independent of Chromium splitting slow typing groups.
        self.page.keyboard.type('T')
        self.frame_capture()
        text = '<b>plain</b>\nline\n'
        self.assertEqual(self.frame_insert(text), {'status':'applied'})
        self.assertEqual(self.texts()['findings'], 'T'+text)
        self.page.keyboard.type('Y')
        for expected in ('T'+text,'T',''):
            self.page.keyboard.press('Control+z')
            self.assertEqual(self.texts()['findings'], expected)
        for key, expected in [('Control+y','T'),('Control+Shift+z','T'+text),('Control+y','T'+text+'Y')]:
            self.page.keyboard.press(key)
            self.assertEqual(self.texts()['findings'], expected)

    def test_integrated_captured_selection(self):
        self.frame_text(conclusion='0123456789')
        self.page.locator('#conclusion').focus()
        self.page.locator('#conclusion').evaluate('e=>e.setSelectionRange(2,5)')
        self.frame_capture('conclusion')
        self.page.keyboard.press('End')
        self.page.locator('#b-copy').focus()
        self.assertEqual(self.frame_insert('X'), {'status':'applied'})
        self.assertEqual(self.texts()['conclusion'], '01X56789')

    def test_integrated_insert_and_clear_separate_following_typing(self):
        for clear in (False, True):
            with self.subTest(clear=clear):
                self.frame_text()
                self.page.locator('#findings').focus()
                self.page.keyboard.type('T')
                self.frame_capture(start=0 if clear else 1, end=1)
                self.assertEqual(self.frame_insert('' if clear else 'X'), {'status':'applied'})
                inserted = '' if clear else 'TX'
                self.page.keyboard.type('Y')
                for expected in (inserted, 'T', ''):
                    self.page.keyboard.press('Control+z')
                    self.assertEqual(self.texts()['findings'], expected)
                for expected in ('T', inserted, inserted+'Y'):
                    self.page.keyboard.press('Control+y')
                    self.assertEqual(self.texts()['findings'], expected)

    def test_integrated_composing_insert_and_switch(self):
        self.page.locator('#findings').focus()
        cdp = self.context.new_cdp_session(self.page)
        cdp.send('Input.imeSetComposition', {'text':'한','selectionStart':1,'selectionEnd':1})
        self.frame_capture()
        before = self.texts()
        self.assertEqual(self.frame_insert('X'), {'status':'refused','reason':'composing'})
        self.frame_capture('conclusion')
        self.assertEqual(self.frame_insert('X'), {'status':'refused','reason':'composing'})
        self.assertEqual(self.page.evaluate('reportFrame.switchStudy({uid:selectedUid,selectionSeq:selectionSeq+1},reportFrame.read())'), {'status':'refused','reason':'composing'})
        self.assertEqual(self.texts(), before)
        cdp.send('Input.insertText', {'text':'한'})
        self.frame_capture()
        self.assertEqual(self.frame_insert('X'), {'status':'applied'})
        cdp.detach()

    def test_integrated_sent_snapshot(self):
        self.frame_text(findings='ACTUAL')
        self.frame_capture()
        self.assertEqual(self.page.evaluate("reportFrame.applyServer(ticket,{sent:'invented',text:'BAD'})"), {'status':'refused','reason':'sent-mismatch'})
        self.assertEqual(self.texts()['findings'], 'ACTUAL')

    def test_integrated_permissions_and_native_failure(self):
        self.frame_text(findings='KEEP')
        self.frame_capture()
        self.page.evaluate('appState[selectedUid].prelimHidden=true')
        self.assertEqual(self.frame_insert('BAD')['status'], 'refused')
        self.page.evaluate('appState[selectedUid].prelimHidden=false')
        self.page.locator('#b-copy').focus()
        self.page.locator('#findings').evaluate("e=>e.addEventListener('focus',()=>{appState[selectedUid].prelimHidden=true},{once:true})")
        self.assertEqual(self.frame_insert('BAD')['status'], 'refused')
        self.page.evaluate('appState[selectedUid].prelimHidden=false')
        self.page.evaluate('document.execCommand=()=>false')
        self.assertEqual(self.frame_insert('BAD'), {'status':'refused','reason':'native-edit'})
        self.assertEqual(self.texts()['findings'], 'KEEP')

    def test_integrated_scroll_preserved(self):
        self.keep_hold_claim()
        self.frame_text(findings='\n'.join('long '+str(i) for i in range(100)))
        self.page.locator('#findings').focus()
        self.page.evaluate("reportFrame.element('findings').setSelectionRange(10,12); document.querySelector('.redit').scrollTop=80")
        before = self.page.locator('.redit').evaluate('e=>e.scrollTop')
        self.assertGreater(before, 0)
        self.frame_capture()
        self.assertEqual(self.frame_insert('REPLACE'), {'status':'applied'})
        self.assertEqual(self.page.locator('.redit').evaluate('e=>e.scrollTop'), before)
        self.answer_hold_claim()

    def test_integrated_focus_and_unvisited(self):
        self.frame_text(findings='old')
        self.page.locator('#findings').focus()
        self.page.locator('#findings').evaluate('e=>e.setSelectionRange(1,2)')
        self.frame_text(findings='new value', conclusion='untouched')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'findings')
        self.page.keyboard.type('X')
        self.assertEqual(self.texts()['findings'], 'new valueX')
        self.page.locator('#conclusion').evaluate('e=>e.setSelectionRange(1,2)')
        self.frame_capture('conclusion')
        self.assertEqual(self.frame_insert('TAIL'), {'status':'applied'})
        self.assertEqual(self.texts()['conclusion'], 'untouchedTAIL')

    def test_integrated_typing_and_read(self):
        self.page.locator('#findings').focus()
        self.page.keyboard.type('abc')
        self.assertEqual(self.page.evaluate('reportFrame.read()'), {'findings':'abc','conclusion':'','recommendation':''})
        self.assertEqual(self.texts()['findings'], 'abc')

    def test_integrated_hidden_and_length_refusal(self):
        self.page.locator('#findings').fill('KEEP')
        self.frame_capture('recommendation')
        self.page.locator('#recommendation').evaluate("e=>e.style.display='none'")
        self.assertEqual(self.frame_insert('BAD'), {'status':'refused','reason':'unavailable'})
        self.assertEqual(self.texts(), {'findings':'KEEP','conclusion':'','recommendation':''})
        self.frame_capture()
        self.page.locator('#findings').evaluate('e=>e.maxLength=5')
        self.assertEqual(self.frame_insert('TOO LONG'), {'status':'refused','reason':'length'})
        self.assertEqual(self.texts()['findings'], 'KEEP')

    def test_integrated_authoritative_boundary(self):
        self.page.locator('#findings').fill('old')
        self.frame_capture()
        self.frame_text(findings='server')
        self.assertEqual(self.texts()['findings'], 'server')
        self.assertEqual(self.frame_insert('late')['status'], 'refused')
        self.page.locator('#findings').focus()
        self.page.keyboard.press('Control+z')
        self.assertEqual(self.texts()['findings'], 'server')

    def test_integrated_batch_focus_precheck(self):
        self.frame_text(findings='KEEP', conclusion='KEEP', recommendation='KEEP')
        self.page.evaluate("window.batch=RFIELDS.map(k=>({at:reportFrame.capture(k,{start:0,end:4}),text:'CHANGED'}));document.querySelector('#recommendation').style.display='none';window.inputs=0;document.addEventListener('input',()=>inputs++)")
        before = self.texts()
        self.assertEqual(self.page.evaluate('reportFrame.insertMany(batch)')['status'], 'refused')
        self.assertEqual(self.texts(), before)
        self.assertEqual(self.page.evaluate('inputs'), 0)

    def test_integrated_authoritative_reentry(self):
        self.frame_text(findings='KEEP')
        self.page.locator('#b-copy').focus()
        self.frame_capture()
        self.page.locator('#findings').evaluate("e=>e.addEventListener('focus',()=>{window.reentry=reportFrame.replaceAuthoritative({findings:'BAD',conclusion:'',recommendation:''})},{once:true})")
        self.assertEqual(self.frame_insert('X'), {'status':'applied'})
        self.assertEqual(self.page.evaluate('reentry'), {'status':'refused','reason':'busy'})
        self.assertEqual(self.texts()['findings'], 'KEEPX')

    def test_integrated_equality_lf_only(self):
        for before, after in [('text',' text'), ('a b','a\u00a0b'), ('é','e\u0301')]:
            with self.subTest(after=after):
                self.frame_text(findings=before)
                self.frame_text(findings=after)
                self.assertEqual(self.texts()['findings'], after)

    def test_integrated_partial_equal_caret(self):
        self.frame_text(findings='abc def', conclusion='old')
        self.page.locator('#findings').focus()
        self.page.keyboard.press('Home')
        self.page.keyboard.press('ArrowRight')
        self.page.keyboard.press('ArrowRight')
        self.page.keyboard.press('ArrowRight')
        self.page.locator('#b-copy').focus()
        self.frame_text(findings='abc def', conclusion='new')
        self.frame_capture()
        self.assertEqual(self.frame_insert('X'), {'status':'applied'})
        self.assertEqual(self.texts()['findings'], 'abcX def')

    def test_page_f11_identical_text_a_b_a_focus_and_blur(self):
        text = 'same\ntext'
        self.page.evaluate("text => { for(const uid of studies.map(s=>s.uid)) appState[uid]={...appState[uid], findings:text, conclusion:text, recommendation:text}; loadReport({force:true}); }", text)
        for focused in (False, True):
            with self.subTest(focused=focused):
                for patient in (self.h.PATIENT_B, self.h.PATIENT):
                    self.page.locator('#findings').focus()
                    self.page.locator('#findings').evaluate("e=>e.setSelectionRange(0,2,'backward')")
                    if not focused:
                        self.page.locator('#b-copy').focus()
                    if focused:
                        uid = self.page.locator('#rows tr', has_text=patient).first.get_attribute('data-uid')
                        self.page.evaluate('uid=>select(uid)', uid)
                    else:
                        self.switch(patient)
                    got = self.page.evaluate("() => { const e=document.querySelector('#findings'), at=reportFrame.capture('findings'); return [e.value,e.selectionStart,e.selectionEnd,at.start,at.end]; }")
                    self.assertEqual(got, [text, len(text), len(text), len(text), len(text)])

    def test_page_native_input_once_final_three_field_payload_and_hold(self):
        self.page.evaluate("() => { window.events=[]; document.addEventListener('input',e=>{if(['findings','conclusion','recommendation'].includes(e.target.id)) events.push({field:e.target.id,trusted:e.isTrusted});}); }")
        self.page.locator('#findings').focus()
        self.page.keyboard.type('AB')
        self.page.locator('#findings').evaluate('e=>e.setSelectionRange(0,0)')
        self.page.evaluate("insertTemplate({findings:'F',conclusion:'C',recommendation:'R'})")
        self.assertEqual(self.texts(), {'findings':'F\nAB','conclusion':'C','recommendation':'R'})
        self.assertEqual(self.page.evaluate('events'), [
            {'field':'findings','trusted':True}, {'field':'findings','trusted':True},
            # Chromium emits separate native input for the inserted LF and the following text.
            {'field':'findings','trusted':True},
            {'field':'findings','trusted':True}, {'field':'conclusion','trusted':True},
            {'field':'recommendation','trusted':True}])
        self.page.clock.run_for(21000)
        self.page.wait_for_function("() => !document.querySelector('#b-report-template').disabled")
        self.assertTrue(self.site.holds)
        self.assertTrue(self.site.puts)
        self.assertEqual({k:self.site.puts[-1][k] for k in FIELDS}, self.texts())
        self.assertFalse(any('citation' in put or 'structure' in put for put in self.site.puts))

    def test_page_authoritative_equal_keeps_undo_partial_equal_keeps_caret(self):
        self.keep_hold_claim()
        self.page.locator('#findings').focus()
        self.page.keyboard.type('typed')
        self.page.locator('#findings').evaluate("e=>e.setSelectionRange(1,3,'backward')")
        self.page.evaluate("loadReport({force:true})")
        self.assertEqual(self.page.locator('#findings').evaluate('e=>[e.selectionStart,e.selectionEnd]'), [1,3])
        self.page.keyboard.press('Control+z')
        self.assertEqual(self.texts()['findings'], '')
        self.page.keyboard.press('Control+Shift+z')
        self.assertEqual(self.texts()['findings'], 'typed')
        self.page.locator('#findings').evaluate("e=>e.setSelectionRange(1,3,'backward')")
        self.page.evaluate("() => {appState[selectedUid].draft.conclusion='server change';loadReport({force:true});}")
        self.assertEqual(self.page.locator('#findings').evaluate('e=>[e.selectionStart,e.selectionEnd]'), [1,3])
        self.page.keyboard.press('Control+z')
        self.assertEqual(self.texts(), {'findings':'typed','conclusion':'server change','recommendation':''})
        self.answer_hold_claim()

    def test_page_many_readonly_and_composition_are_atomic(self):
        self.page.locator('#findings').fill('KEEP')
        self.page.locator('#recommendation').evaluate('e=>e.readOnly=true')
        self.assertFalse(self.page.evaluate("insertTemplate({findings:'X',conclusion:'Y',recommendation:'Z'})"))
        self.assertEqual(self.texts(), {'findings':'KEEP','conclusion':'','recommendation':''})
        self.page.locator('#recommendation').evaluate('e=>e.readOnly=false')
        self.page.locator('#conclusion').focus()
        cdp = self.context.new_cdp_session(self.page)
        cdp.send('Input.imeSetComposition', {'text':'한','selectionStart':1,'selectionEnd':1})
        before = self.texts()
        self.assertFalse(self.page.evaluate("insertTemplate({findings:'X',recommendation:'Z'})"))
        self.assertEqual(self.texts(), before)
        cdp.send('Input.insertText', {'text':'한'})
        cdp.detach()

    def test_page_single_scroll_tab_shortcut_and_thousand_lines(self):
        # Even with unavailable ancillary services, both empty sections remain readable.
        # W4X-04: one shared-host run saw -92 here and no later run did (not reproduced in 10 runs of the original
        # 20-case order). The same reading also returns the frame's geometry and readiness at that moment, so a failure
        # carries the facts that tell a pre-ready read from a steady-state defect; the 40 px bound is unchanged.
        for field in ('findings', 'conclusion'):
            fact = self.page.locator('#' + field).evaluate(FIELD_VISIBILITY)
            self.assertGreaterEqual(fact['visible'], 40, fact)
        self.page.locator('#findings').focus()
        self.page.keyboard.press('Tab')
        self.assertTrue(self.page.locator('#conclusion').evaluate('e=>e===document.activeElement'))
        self.page.keyboard.press('Shift+Tab')
        self.assertTrue(self.page.locator('#findings').evaluate('e=>e===document.activeElement'))
        text = '\n'.join('line %s 한글' % i for i in range(1000))
        self.page.keyboard.insert_text(text)
        self.assertEqual(self.texts()['findings'], text)
        sizes = self.page.locator('#findings').evaluate('e=>[e.scrollHeight,e.clientHeight,e.parentElement.scrollHeight,e.parentElement.clientHeight]')
        self.assertLessEqual(sizes[0], sizes[1] + 1)
        self.assertGreater(sizes[2], sizes[3])
        caret_end = self.page.locator('#findings').evaluate('e=>{const h=e.parentElement.getBoundingClientRect();return [e.getBoundingClientRect().bottom,h.top,h.bottom];}')
        self.assertGreater(caret_end[0], caret_end[1])
        self.assertLessEqual(caret_end[0], caret_end[2] + 8, 'The last typed line stays in the shared viewport')
        self.page.keyboard.press('Control+a')
        self.page.keyboard.insert_text('nbct')
        self.page.evaluate("templates=[{title:'SYN',shortcut:'nbct',findings:'expanded'}]")
        self.page.keyboard.press('Tab')
        self.assertEqual(self.texts()['findings'], 'expanded')
        self.assertTrue(self.page.locator('#findings').evaluate('e=>e===document.activeElement'))

    def test_page_end_during_composition_purges_history_and_late_mount(self):
        self.page.locator('#findings').focus()
        self.page.keyboard.type('private')
        cdp = self.context.new_cdp_session(self.page)
        cdp.send('Input.imeSetComposition', {'text':'한','selectionStart':1,'selectionEnd':1})
        self.page.evaluate("closeWork('ended')")
        self.assertEqual(self.texts(), dict.fromkeys(FIELDS, ''))
        self.assertIsNone(self.page.evaluate('mountReportFrame()'))
        self.page.locator('#findings').evaluate('e=>e.focus()')
        for key in ('Control+z','Control+y','Control+Shift+z'):
            self.page.keyboard.press(key)
            self.assertEqual(self.texts(), dict.fromkeys(FIELDS, ''))
        cdp.detach()

    def test_page_clipboard_answer_after_typing_and_undo_is_refused(self):
        self.keep_hold_claim()
        self.page.locator('#findings').focus()
        self.page.keyboard.type('kept')
        # The applied hold answer is the boundary that ends the 'kept' typing group before 'X'.
        self.answer_hold_claim()
        self.page.evaluate("() => Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:()=>new Promise(r=>window.clipboardReply=r)}})")
        self.page.locator('#b-paste').evaluate('e=>e.click()')
        self.page.keyboard.type('X')
        self.page.keyboard.press('Control+z')
        self.page.evaluate("clipboardReply('LATE')")
        self.assertEqual(self.texts()['findings'], 'kept')
        self.page.locator('#b-paste').evaluate('e=>e.click()')
        self.page.evaluate("clipboardReply('TAIL')")
        self.assertEqual(self.texts()['findings'], 'keptTAIL')

    def test_page_row_enter_and_context_report_focus_the_replacement_field(self):
        self.switch(self.h.PATIENT_B)
        self.switch(self.h.PATIENT)
        row = self.page.locator('#rows tr', has_text=self.h.PATIENT).first
        row.press('Enter')
        self.page.keyboard.type('ENTER')
        self.assertEqual(self.texts()['findings'], 'ENTER')
        self.switch(self.h.PATIENT_B)
        row = self.page.locator('#rows tr', has_text=self.h.PATIENT_B).first
        row.click(button='right')
        self.page.get_by_role('menuitem', name='판독문 작성으로', exact=True).click()
        self.page.keyboard.type('CONTEXT')
        self.assertEqual(self.texts()['findings'], 'CONTEXT')

    def active(self):
        return self.page.evaluate('document.activeElement.id || document.activeElement.tagName')

    def use_template(self, **fields):
        self.page.evaluate("t => { templates = [t]; renderTemplates(); }", {'title': 'SYN TEMPLATE', **fields})

    def test_page_template_native_focus_does_not_retarget_dictation(self):
        self.page.locator('#findings').focus()
        self.page.keyboard.type('typed')
        self.page.locator('#b-copy').focus()
        focused = self.active()
        self.assertTrue(self.page.evaluate("insertTemplate({findings:'F',conclusion:'C',recommendation:'R'})"))
        self.assertEqual(self.page.evaluate('dictationContext().field'), 'findings')
        self.assertEqual(self.active(), focused)
        self.assertTrue(self.page.evaluate("() => { const x=dictationContext(); return dictationInsert({...x,expectedValue:x.value,text:'SYN dictated'}); }"))
        self.assertIn('SYN dictated', self.texts()['findings'])
        self.assertEqual(self.texts()['recommendation'], 'R')
        # W6R1-03, the template list as the reader uses it: the double-click on a row leaves the page itself focused.
        # A two-field template then leaves the dictation target and keyboard focus where they were before W6: the
        # field the reader last chose (Findings) and the page, not the last field the template filled.
        self.use_template(findings='SYN T2', conclusion='SYN C2')
        expected = self.placed('conclusion', 'SYN C2', None)
        self.page.locator('#tplrows tr[data-i]').first.dblclick()
        self.assertEqual(self.texts()['conclusion'], expected)
        self.assertEqual(self.active(), 'BODY')
        self.assertEqual(self.page.evaluate('dictationContext().field'), 'findings')
        self.assertTrue(self.page.evaluate("() => { const x=dictationContext(); return dictationInsert({...x,expectedValue:x.value,text:'SYN second'}); }"))
        self.assertTrue(self.texts()['findings'].endswith('SYN second'))
        self.assertNotIn('SYN second', self.texts()['conclusion'])

    def assert_off_hidden_recommendation(self, label):
        """W6R1-02: keyboard focus and the dictation target are never the hidden Recommendation, and the next keystroke
        does not change it."""
        self.assertNotEqual(self.active(), 'recommendation', label)
        self.assertNotEqual(self.page.evaluate('dictationContext().field'), 'recommendation', label)
        hidden = self.texts()['recommendation']
        self.page.keyboard.type('k')
        self.assertEqual(self.texts()['recommendation'], hidden, label)

    def test_page_template_double_click_and_native_undo_never_focus_hidden_recommendation(self):
        # W6R1-02 on the template list as the reader uses it (the row's double-click leaves the page focused), with a
        # two-field and a three-field template, then every Undo/Redo shortcut stepping through the hidden field's edits.
        self.keep_hold_claim()
        self.page.locator('#findings').click()
        self.page.keyboard.type('A')
        for fields in ({'findings': 'SYN T2', 'conclusion': 'SYN C2'},
                       {'findings': 'SYN T3', 'conclusion': 'SYN C3', 'recommendation': 'SYN R3'}):
            self.use_template(**fields)
            self.page.locator('#tplrows tr[data-i]').first.dblclick()
            self.assertTrue(all(text in self.texts()[k] for k, text in fields.items()), fields)
            self.assertEqual(self.active(), 'BODY', 'focus stays on the page, as before W6')
            self.assert_off_hidden_recommendation('template %s' % sorted(fields))
        self.assertEqual(self.texts()['recommendation'], 'SYN R3')
        self.page.locator('#findings').click()
        values = set()
        for key in ['Control+z'] * 3 + ['Control+y'] * 3 + ['Control+Shift+z', 'Control+z', 'Control+Shift+z']:
            self.page.keyboard.press(key)
            values.add(self.texts()['recommendation'])
            self.assertNotEqual(self.active(), 'recommendation', key)
            self.assertNotEqual(self.page.evaluate('dictationContext().field'), 'recommendation', key)
        self.assertEqual(values, {'', 'SYN R3'}, 'the shortcuts did step through the hidden field')
        self.assert_off_hidden_recommendation('after Undo/Redo')
        # The hidden field stays part of the saved report.
        self.answer_hold_claim()
        self.page.clock.run_for(21000)
        self.page.wait_for_function("() => !document.querySelector('#b-report-template').disabled")
        self.assertEqual({k: self.site.puts[-1][k] for k in FIELDS}, self.texts())

    def test_page_other_writes_never_leave_focus_in_hidden_recommendation(self):
        # W6R1-02 on the other application writes: the template preview's Insert (the list's keyboard path), Clear, a
        # citation, a structured line and a dictation Insert.
        self.use_template(findings='SYN T', conclusion='SYN C', recommendation='SYN R')
        self.page.locator('#tplrows [data-tpl-preview]').first.focus()
        self.page.keyboard.press('Enter')
        self.page.wait_for_function("() => document.querySelector('#tpl-preview').classList.contains('show')")
        self.page.locator('#tpl-preview-insert').focus()
        self.page.keyboard.press('Enter')
        self.page.wait_for_function("() => !document.querySelector('#tpl-preview').classList.contains('show')")
        self.assertEqual(self.texts()['recommendation'], 'SYN R')
        self.assert_off_hidden_recommendation('template preview Insert')
        self.page.locator('#report-more > summary').click()
        self.page.locator('#b-clear').click()
        self.assertEqual(self.texts(), dict.fromkeys(FIELDS, ''))
        self.assert_off_hidden_recommendation('Clear')
        self.page.locator('#findings').fill('LOCAL')
        self.assertTrue(self.page.evaluate("request=>openCitePreview(request)", {
            'uid':self.h.UID,'findingId':'SYN-FINDING','findingRevision':1,'sourceIndex':0,
            'sourceLabel':'SYN source','linkState':'current','headRevision':None,'block':'SYN cited finding'}))
        self.page.locator('#cite-preview-insert').click()
        self.page.wait_for_function("() => !document.querySelector('#cite-preview').classList.contains('show')")
        self.assertIn('SYN cited finding', self.texts()['findings'])
        self.assert_off_hidden_recommendation('citation')
        if not self.page.locator('#b-structured').is_visible():
            self.page.locator('#report-more > summary').click()
        self.page.locator('#b-structured').click()
        self.page.locator('#struct-item').select_option('GEN-1\x00CONCLUSION')
        self.page.locator('#struct-value-text').fill('SYN result')
        self.page.locator('#struct-apply').click()
        self.page.wait_for_function("() => !document.querySelector('#structmodal').classList.contains('on')")
        self.assertIn('SYN result', self.texts()['conclusion'])
        self.assert_off_hidden_recommendation('structured line')
        self.page.locator('#conclusion').focus()
        self.record_dictation()
        self.review_dictation()
        self.assertTrue(self.page.evaluate('recorded.insert().then(r => r.inserted)'))
        self.assertIn('SYN delayed', self.texts()['conclusion'])
        self.assert_off_hidden_recommendation('dictation Insert')

    def test_page_dictation_targets_the_field_focused_after_replacement(self):
        self.switch(self.h.PATIENT_B)
        self.switch(self.h.PATIENT)
        self.page.locator('#conclusion').focus()
        self.assertTrue(self.page.evaluate("() => { const x=dictationContext(); return dictationInsert({...x,expectedValue:x.value,text:'SYN dictated'}); }"))
        self.assertEqual(self.texts(), {'findings':'','conclusion':'SYN dictated','recommendation':''})

    def test_page_w3_drawer_close_after_replacement_returns_to_a_current_field(self):
        # W6-PAGE-18 on the W3 layout: an opening replaces the three fields while focus is in the Study Panel,
        # so the drawer's remembered opener is a removed node. Closing returns focus to the current field of the
        # section the drawer was opened from (W6R1-07: Conclusion here, not the first field).
        uid_b = self.page.locator('#rows tr', has_text=self.h.PATIENT_B).first.get_attribute('data-uid')
        replacements = {
            'other study': ("uid => select(uid)", uid_b),
            'same study, changed server text': ("() => { const s = appState[selectedUid]; (s.draft ?? s).conclusion = 'server change'; loadReport({force:true}); }", None),
        }
        for label, (replace, arg) in replacements.items():
            with self.subTest(label):
                self.page.locator('#conclusion').focus()
                self.assertTrue(self.page.evaluate("() => openStudyPanel('info')"))
                self.assertTrue(self.page.evaluate("() => document.querySelector('#study-panel-host').contains(document.activeElement)"))
                self.page.evaluate("() => { window.openerField = document.querySelector('#conclusion'); }")
                self.page.evaluate(replace, arg)
                self.page.wait_for_function("() => !window.openerField.isConnected && !document.querySelector('#conclusion').readOnly")
                self.assertTrue(self.page.evaluate("() => document.querySelector('#study-panel-host').contains(document.activeElement)"))
                self.page.keyboard.press('Escape')
                self.page.wait_for_function("() => !document.querySelector('#study-panel-host .study-panel:not([hidden])')")
                active = self.page.evaluate("() => { const a = document.activeElement; return [a.id, a.isConnected, a.id === 'conclusion' && a === reportFrame.element('conclusion')]; }")
                self.assertEqual(active, ['conclusion', True, True])
                before = self.texts()
                self.page.keyboard.type('W3')
                self.assertEqual(self.texts(), {**before, 'conclusion': before['conclusion'] + 'W3'})
        self.assertEqual(self.page.evaluate('selectedUid'), uid_b)

    def test_page_frame_minimum_on_w3_layouts_with_notices_and_panel(self):
        # W6-PAGE-22 on W3's placements (portrait bands, narrow sheet, short windows) and 1366x768, with the three
        # unavailable-service notices shown below the report fields and the Study Panel closed or open (W6R1-01). The
        # shared scroller has no fixed minimum: it gives up its height before anything below it leaves the column (it
        # is down to its own padding whenever the column's content overflows), the page itself never scrolls, and the
        # footer and every notice bar stay in the window or inside a container the reader can wheel-scroll. The panel
        # never covers the scroller and each section focused shows in it. The last window is shorter than the column's
        # own rows: there the column itself scrolls.
        from study_panel_page_dom_test import assert_w6_reachable, w6_facts
        from study_panel_size_dom_test import BOUND_SIZES
        measure = """() => { const host = document.querySelector('.redit'), box = host.getBoundingClientRect(), css = getComputedStyle(host);
          const panel = document.querySelector('#study-panel-host .study-panel:not([hidden])')?.getBoundingClientRect();
          const seen = id => { const r = document.getElementById(id).getBoundingClientRect();
            return Math.min(box.bottom, r.bottom, innerHeight) - Math.max(box.top, r.top, 0); };
          const column = host.parentElement;
          return {height: box.height, least: ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((n, k) => n + parseFloat(css[k]), 0),
                  overflow: column.scrollHeight - column.clientHeight,
                  covered: !!panel && box.left < panel.right && box.right > panel.left
                    && Math.max(box.top, 0) < panel.bottom && Math.min(box.bottom, innerHeight) > panel.top,
                  findings: seen('findings'), conclusion: seen('conclusion')}; }"""
        notices = self.page.evaluate("() => ['#question-p', '#image-request-p', '#cvr-sent-p'].filter(s => document.querySelector(s).getClientRects().length).length")
        self.assertEqual(notices, 3)
        for width, height in dict.fromkeys([tuple(size) for size in BOUND_SIZES] + [(1366, 768), (1280, 540)]):
            self.page.set_viewport_size({'width': width, 'height': height})
            for opened in (False, True):
                with self.subTest(width=width, height=height, panel=opened):
                    if opened:
                        self.assertTrue(self.page.evaluate("() => openStudyPanel('info')"))
                    self.page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
                    where = '%dx%d panel=%s' % (width, height, opened)
                    fact = self.page.evaluate(measure)
                    if fact['overflow'] > 0.5:
                        self.assertLessEqual(fact['height'], fact['least'] + 0.5, '%s: the scroller did not yield %s' % (where, fact))
                    assert_w6_reachable(self, w6_facts(self.page), where)
                    for field in ('findings', 'conclusion'):
                        self.page.locator('#' + field).evaluate('e => e.focus()')
                        self.page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
                        fact = self.page.evaluate(measure)
                        if not fact[field] > 0:
                            # W4X-04 family (seen once here: scroller at its padding, conclusion -92): keep what explains it.
                            fact = {**fact, 'geometry': self.page.locator('#' + field).evaluate(FIELD_VISIBILITY)}
                        self.assertFalse(fact['covered'], fact)
                        self.assertGreater(fact[field], 0, fact)
                        assert_w6_reachable(self, w6_facts(self.page), where + ' ' + field)
                    if opened:
                        self.page.evaluate("() => studyPanel.close()")

    def test_page_composition_refuses_a_queued_study_activation(self):
        self.page.locator('#findings').focus()
        cdp = self.context.new_cdp_session(self.page)
        cdp.send('Input.imeSetComposition', {'text':'한','selectionStart':1,'selectionEnd':1})
        before = self.texts()
        writes = len(self.site.puts)
        self.page.locator('#rows tr', has_text=self.h.PATIENT_B).first.dispatch_event('click')
        self.assertEqual(self.texts(), before)
        self.assertEqual(self.page.evaluate('selectedUid'), self.h.UID)
        # W4 (W4-PAGE-06): the refused activation is said, not silent - the navigation gate's Notice - and it sends
        # nothing: the open composition is not saved as a draft on the way out.
        expect(self.page.locator('#report-notice')).to_contain_text('Not Moved')
        self.page.wait_for_timeout(300)
        self.assertEqual(writes, len(self.site.puts), 'a refused activation writes no draft')
        cdp.send('Input.insertText', {'text':'한'})
        cdp.detach()
        # W4 decided difference: the composed syllable is unconfirmed text, so the move waits for its draft save.
        self.switch(self.h.PATIENT_B)
        self.assertEqual(self.texts(), dict.fromkeys(FIELDS, ''))

    def test_page_logout_saves_template_and_hidden_recommendation_once(self):
        self.page.evaluate("insertTemplate({findings:'F',conclusion:'C',recommendation:'R'})")
        self.page.locator('#logout').click()
        self.page.wait_for_url(self.h.INDEX_URL)
        self.assertEqual(self.site.stored(), {'findings':'F','conclusion':'C','recommendation':'R'})
        self.assertEqual(len(self.site.logouts), 1)

    def test_page_logout_during_composition_saves_the_composed_text_once(self):
        # W6R1-06 (W6-PAGE-19): Log Out pressed while a Korean IME composition is open in Findings, focus left there.
        # The composition is finished first, while the page is still at work - before the logout preparation freezes
        # the save snapshot and before its panel opens - so the saved draft holds the composed syllable as the
        # reader left it; the page saves it once and logs out once.
        ended = []
        self.page.expose_function('compositionEnded', lambda fact: ended.append(fact))
        self.page.locator('#findings').click()
        self.page.keyboard.type('ab')
        cdp = self.context.new_cdp_session(self.page)
        cdp.send('Input.imeSetComposition', {'text': '한', 'selectionStart': 1, 'selectionEnd': 1})
        self.assertTrue(self.page.evaluate('reportFrame.isComposing()'))
        self.page.evaluate("""() => document.addEventListener('compositionend', event => compositionEnded({field: event.target.id,
            value: event.target.value, work: work.state(), panel: !!document.querySelector('dialog.kin-logout[open]')}), true)""")
        self.page.evaluate("document.querySelector('#logout').click()")
        self.page.wait_for_url(self.h.INDEX_URL)
        self.assertEqual(ended[:1], [{'field': 'findings', 'value': 'ab한', 'work': 'active', 'panel': False}])
        self.assertEqual(self.site.stored(), {'findings': 'ab한', 'conclusion': '', 'recommendation': ''})
        self.assertEqual(sum(put.get('findings') == 'ab한' for put in self.site.puts), 1)
        self.assertEqual(len(self.site.logouts), 1)

    def test_page_related_panel_round_trip_and_resize_keep_the_editor(self):
        # W6R1-10 (design v5 §9): in the Reading Workspace, Hide Related Panel and Show again, with a window resize in
        # between (both change the shared scroller's size), keep the text, the selection, the caret in view (or the
        # reader's own scroll) and the native history: one Ctrl+Z still removes exactly the last typing.
        self.keep_hold_claim()
        self.page.get_by_role('button', name='Reading Workspace', exact=True).click()
        toggle = self.page.locator('#reading-related-toggle')
        self.page.wait_for_function("() => document.body.classList.contains('reading')")
        text = '\n'.join('line %d' % i for i in range(60))
        self.page.locator('#findings').focus()
        self.page.keyboard.insert_text(text)
        self.page.keyboard.press('Control+Home')
        for _ in range(30):
            self.page.keyboard.press('ArrowDown')
        self.page.keyboard.type('Z')
        # W6R2-01: the caret's line box is measured as this browser lays out the field, never from an assumed font,
        # line height or padding (the CI host's fonts differ from this one). A block with the field's computed text
        # layout and content width, holding the text up to the caret plus one zero-width character, ends where the
        # caret's line ends; the same block holding only that character is one line high.
        state = """() => { const host = document.querySelector('.redit'), el = document.querySelector('#findings'), box = host.getBoundingClientRect();
          const at = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd, css = getComputedStyle(el);
          const block = document.createElement('div');
          for (const p of ['font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch', 'font-kerning',
            'font-feature-settings', 'line-height', 'letter-spacing', 'word-spacing', 'text-indent', 'text-transform', 'white-space',
            'word-break', 'overflow-wrap', 'tab-size']) block.style.setProperty(p, css.getPropertyValue(p));
          Object.assign(block.style, {position: 'absolute', left: '-10000px', top: '0', visibility: 'hidden', boxSizing: 'content-box',
            padding: '0', border: '0', margin: '0', width: (el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)) + 'px'});
          document.body.append(block);
          block.textContent = '\\u200b';
          const line = block.getBoundingClientRect().height;
          block.textContent = el.value.slice(0, at) + '\\u200b';
          const below = block.getBoundingClientRect().height;
          block.remove();
          const field = el.getBoundingClientRect(), top = box.top + host.clientTop, bottom = top + host.clientHeight;
          const end = field.top + el.clientTop + parseFloat(css.paddingTop) + below - el.scrollTop, start = end - line;
          return {value: el.value, selection: [el.selectionStart, el.selectionEnd, el.selectionDirection], top: host.scrollTop,
                  height: Math.round(box.height), line, rect: [start, end], view: [top, bottom],
                  caret: line > 0 && start >= top - 1 && end <= bottom + 1}; }"""
        frames = "() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"
        before = self.page.evaluate(state)
        self.assertTrue(before['caret'], before)
        heights = [before['height']]
        size = self.page.viewport_size
        toggle.click()
        self.page.evaluate(frames)
        heights.append(self.page.evaluate(state)['height'])
        self.page.set_viewport_size({'width': size['width'], 'height': size['height'] + 300})
        self.page.evaluate(frames)
        heights.append(self.page.evaluate(state)['height'])
        toggle.click()
        self.page.evaluate(frames)
        self.assertEqual(toggle.text_content(), 'Hide Related Panel')
        after = self.page.evaluate(state)
        heights.append(after['height'])
        self.assertGreater(len(set(heights)), 1, 'the round trip and the resize changed the scroller: %s' % heights)
        self.assertEqual((after['value'], after['selection']), (before['value'], before['selection']))
        self.assertTrue(after['caret'] or after['top'] == before['top'], after)
        self.page.locator('#findings').focus()
        self.page.keyboard.press('Control+z')
        self.assertEqual(self.texts()['findings'], text)
        self.answer_hold_claim()

    def test_page_citation_and_structure_apply_screen_matches_payload(self):
        self.page.locator('#findings').fill('LOCAL')
        self.assertTrue(self.page.evaluate("request=>openCitePreview(request)", {
            'uid':self.h.UID,'findingId':'SYN-FINDING','findingRevision':1,'sourceIndex':0,
            'sourceLabel':'SYN source','linkState':'current','headRevision':None,'block':'SYN cited finding'}))
        self.page.locator('#cite-preview-insert').click()
        self.page.wait_for_function("() => !document.querySelector('#cite-preview').classList.contains('show')")
        self.assertEqual(self.texts()['findings'], 'LOCAL\nSYN cited finding')
        self.page.locator('#report-more > summary').click()
        self.page.locator('#b-structured').click()
        self.page.locator('#struct-item').select_option('GEN-1\x00CONCLUSION')
        self.page.locator('#struct-value-text').fill('SYN result')
        self.page.locator('#struct-apply').click()
        self.page.wait_for_function("() => !document.querySelector('#structmodal').classList.contains('on')")
        self.assertEqual(self.texts()['conclusion'], 'Conclusion: SYN result')
        self.assertEqual(self.site.stored(), self.texts())
        self.assertEqual(sum('insert' in p for p in self.site.puts), 1)
        self.assertEqual(sum('structure' in p for p in self.site.puts), 1)

    def test_page_accepted_citation_refused_by_frame_is_not_resent(self):
        self.page.locator('#findings').fill('LOCAL')
        self.page.evaluate("request=>openCitePreview(request)", {
            'uid':self.h.UID,'findingId':'SYN-FINDING','findingRevision':1,'sourceIndex':0,
            'sourceLabel':'SYN source','linkState':'current','headRevision':None,'block':'SYN cited finding'})
        self.site.put_answers=['hold']
        self.page.locator('#cite-preview-insert').click()
        # Wait for the synthetic server to own the operation; the editor then becomes read-only.
        for _ in range(100):
            if self.site.held_puts: break
            self.page.wait_for_timeout(20)
        self.assertEqual(len(self.site.held_puts), 1)
        self.page.locator('#findings').evaluate('e=>e.readOnly=true')
        self.site.finish_put()
        self.page.wait_for_function("() => !document.querySelector('#cite-preview').classList.contains('show')")
        self.assertEqual(self.texts()['findings'], 'LOCAL')
        self.assertIn('화면에 넣지 못했습니다', self.page.locator('body').inner_text())
        self.page.clock.run_for(41000)
        self.assertEqual(sum('insert' in p for p in self.site.puts), 1)


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
    ("M09-no-edit-generation", "const input = () => { s.revision++; fit(writing ? null : s.el); };", "const input = () => { fit(writing ? null : s.el); };", [
        "test_t6_ts08_later_typing_and_edit_then_undo"]),
    ("M10-overwrite-new-input", "if (s.revision !== at.revision || s.el.value !== at.text) return 'changed';", "// Overwrite even after later input.", [
        "test_t6_ts08_later_typing_and_edit_then_undo"]),
    ("M11-ignore-sent", "if (typeof sent !== 'string' || (sent !== at?.text && sent !== text)) return refused('sent-mismatch');", "// Trust a mismatched sent snapshot.", [
        "test_t6_server_requires_the_actual_sent_text"]),
    ("M12-ignore-permission", " || !canEdit(at.field, admission, at)", "", [
        "test_t3_readonly_disabled_and_policy_at_apply_time"]),
    ("M13-no-focus-recheck", "        why = blocked(at, admission);", "        why = null;", [
        "test_t3_permission_changes_on_focus_and_native_failure"]),
    ("M14-reset-scroll", "for (const [el, top, left] of positions) { el.scrollTop = top; el.scrollLeft = left; }", "for (const [el] of positions) { el.scrollTop = 0; el.scrollLeft = 0; }", [
        "test_ordinary_insert_keeps_scroll_and_has_no_extra_focus_cycle"]),
    ("M15-drop-focused-field", "if (focused) focused.next.focus();", "// Drop editor focus on replacement.", [
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
    ("M22-edit-active-instead-of-target", "if (doc.activeElement !== el) return refused('unavailable');\n        el.setSelectionRange(start, end);", "// Edit whichever field still has focus.\n        el.setSelectionRange(start, end);", [
        "test_unfocusable_target_never_edits_the_active_field"]),
    ("M23-allow-truncation", "if (el.maxLength >= 0 && expected.length > el.maxLength) return refused('length');", "// Let the browser silently truncate the insertion.", [
        "test_native_length_limit_cannot_partially_apply_text"]),
    ("M24-carry-different-text-caret", "if (same) next.setSelectionRange(saved.start, saved.end, saved.direction);", "if (true) next.setSelectionRange(saved.start, saved.end, saved.direction);", [
        "test_different_text_opening_types_at_end_and_unvisited_capture_uses_end", "test_drag_across_opening_cannot_select_new_text"]),
    ("M25-unvisited-caret", "const start = range?.start ?? (s.caret ? el.selectionStart : el.value.length);", "const start = range?.start ?? el.selectionStart;", [
        "test_different_text_opening_types_at_end_and_unvisited_capture_uses_end"]),
    ("M26-authoritative-as-render", "return unchanged(texts) || open(opening, texts);", "return switchStudy(opening, texts);", [
        "test_authoritative_same_selection_readonly_and_history_boundary"]),
    ("M27-no-batch-focus-precheck", "for (const { at } of edits) {", "for (const { at } of []) {", [
        "test_many_prechecks_every_field_and_clear_undo_is_per_field"]),
    ("M28-trailing-lf-redo-loss", "const accepted = doc.execCommand('insertText', false, text);", "const accepted = doc.execCommand('insertHTML', false, text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));", [
        "test_t5_trailing_lf_insert_redo_with_both_shortcuts", "test_t5_trailing_lf_insert_between_typing_groups"]),
    ("M29-interpret-markup", "const accepted = doc.execCommand('insertText', false, text);", "const accepted = doc.execCommand('insertHTML', false, text);", [
        "test_t5_native_input_and_plain_text_newlines"]),
    ("M30-identical-authoritative-boundary", "return unchanged(texts) || open(opening, texts);", "return open(opening, texts);", [
        "test_authoritative_same_text_preserves_nodes_caret_tickets_and_undo"]),
    ("M31-authoritative-no-busy-N12", "      if (writing) return refused('busy');\n      return unchanged(texts) || open(opening, texts);", "      // Allow re-entry.\n      return unchanged(texts) || open(opening, texts);", [
        "test_authoritative_reentrant_call_refused_during_focus_and_input"]),
    ("M32-equality-trim-N15", "read(k) === lf(texts[k])", "read(k).trim() === lf(texts[k]).trim()", [
        "test_authoritative_equality_is_lf_only", "test_same_opening_equality_is_lf_only"]),
    ("M33-equality-normalize-N17", "read(k) === lf(texts[k])", "read(k).normalize() === lf(texts[k]).normalize()", [
        "test_authoritative_equality_is_lf_only", "test_same_opening_equality_is_lf_only"]),
    ("M34-discard-carried-visited-mark", "s.el = next; s.revision = 0;", "s.el = next; s.revision = 0; s.caret = false;", [
        "test_boundary_carries_visited_mark_with_unchanged_selection"]),
    ("M35-carry-to-other-study-F11", "const sameStudy = opening !== null && opening.uid === context.uid;", "const sameStudy = true;", [
        "test_caret_mark_and_scroll_belong_to_the_study_not_the_text"]),
    ("M36-new-text-caret-left-to-browser-F11", "else { s.caret = false; next.setSelectionRange(next.value.length, next.value.length); }", "else s.caret = false;", [
        "test_caret_mark_and_scroll_belong_to_the_study_not_the_text"]),
    ("M37-no-carry-in-same-study-F09", "const sameStudy = opening !== null && opening.uid === context.uid;", "const sameStudy = false;", [
        "test_caret_mark_and_scroll_belong_to_the_study_not_the_text", "test_boundary_carries_visited_mark_with_unchanged_selection",
        "test_same_study_caret_carry_is_lf_only"]),
    ("M38-carry-equality-trim-F13", "same: sameStudy && old.value === next.value", "same: sameStudy && old.value.trim() === next.value.trim()", [
        "test_same_study_caret_carry_is_lf_only"]),
    ("M39-equality-nbsp-fold-F13", "read(k) === lf(texts[k])", "read(k).replace(/\\u00a0/g, ' ') === lf(texts[k]).replace(/\\u00a0/g, ' ')", [
        "test_authoritative_equality_is_lf_only", "test_same_opening_equality_is_lf_only"]),
    # Round 2 (W6R1-02/04): the module contracts of the page fixes.
    ("M40-write-keeps-focus-W6R1-02", "if (now !== target && Object.values(states).some(s => s.el === now)) now.blur();",
     "// Leave focus in the last field written.", ["test_write_returns_focus_and_a_hidden_field_never_keeps_it"]),
    ("M41-hidden-field-keeps-focus-W6R1-02",
     "if (!hidden(s.el) || doc.activeElement !== s.el || !event.inputType?.startsWith('history')) return;", "return;",
     ["test_write_returns_focus_and_a_hidden_field_never_keeps_it"]),
    ("M42-current-ignores-edits-W6R1-04", "return !['ended', 'stale', 'changed'].includes(blocked(at));",
     "return !['ended', 'stale'].includes(blocked(at));", ["test_is_current_follows_the_opening_and_edits_not_the_moment"]),
]


PAGE_MUTANTS = [
    ('W6-PAGE-05-recording-capture', 'dictation.js',
     'if (field === undefined) editorCapture = live?.capture ?? null;',
     'editorCapture = live?.capture ?? null;', 'test_page_record_type_undo_refuses_late_dictation'),
    ('W6-PAGE-05-unchanged', 'dictation.js',
     'capture: editorCapture', 'capture: null', 'test_page_record_unchanged_accepts_original_caret'),
    ('W6-PAGE-05-switch', 'dictation-session.js',
     "else if (reason === 'select') cancel('study-changed');",
     "else if (reason === 'select') {}", 'test_page_record_switch_study_refuses_late_dictation'),
    ('W6-PAGE-05-repin', 'dictation.js',
     'if (field === undefined) editorCapture = live?.capture ?? null;',
     'if (field === undefined && !editorCapture) editorCapture = live?.capture ?? null;',
     'test_page_record_explicit_repin_accepts_new_capture'),
    ('W6-PAGE-03', 'report-templates-ui.js',
     'result = changes.length === 1 ? frame.insert(changes[0].at, changes[0].text, admission) : frame.insertMany(changes);',
     "result = {status:'unchanged'};", 'test_page_native_input_once_final_three_field_payload_and_hold'),
    ('W6-PAGE-04', 'report-templates.js', 'caretAt(k), citationGuards(k)', 'null, citationGuards(k)',
     'test_page_native_input_once_final_three_field_payload_and_hold'),
    ('W6-PAGE-05', 'report-dictation.js',
     'dictationField = { field: event.target.id, seq: selectionSeq };', 'dictationField = null;',
     'test_page_dictation_targets_the_field_focused_after_replacement'),
    ('W6-PAGE-06', 'report-editor-frame.js',
     'const sameStudy = opening !== null && opening.uid === context.uid;', 'const sameStudy = true;',
     'test_page_f11_identical_text_a_b_a_focus_and_blur'),
    ('W6-PAGE-07', 'report-editor.js', ': frame.replaceAuthoritative(texts);', ': frame.switchStudy(opening, texts);',
     'test_page_authoritative_equal_keeps_undo_partial_equal_keeps_caret'),
    ('W6-PAGE-09', 'report-draft-save.js',
     'onReportField("input", () => { work.edited(); recordReportEdit(); });',
     'onReportField("input", () => { work.edited(); });', 'test_page_native_input_once_final_three_field_payload_and_hold'),
    ('W6-PAGE-10', 'report-hold.js',
     'if (total >= HOLD_MIN_CHARS) claimHold(selectedUid);', 'if (false) claimHold(selectedUid);',
     'test_page_native_input_once_final_three_field_payload_and_hold'),
    ('W6-PAGE-11', 'report-structure-pane.js',
     'const applied = shown && shown.mode2 !== "refuse" && editReport([reportEditOf(pane.field, shown.text, shown.end)]);',
     'const applied = false;', 'test_page_citation_and_structure_apply_screen_matches_payload'),
    ('W6-PAGE-12', 'report-citation-pane.js',
     'const applied = editReport([reportEditOf(field, shown.text, shown.end)]);',
     'const applied = false;', 'test_page_citation_and_structure_apply_screen_matches_payload'),
    ('W6-PAGE-13', 'report-toolbar.js', 'const end = frame.read("findings").length;', 'const end = 0;',
     'test_page_clipboard_answer_after_typing_and_undo_is_refused'),
    # W4 moved the composition refusal into the navigation gate (leaveStudyGate); the mutant removes it there.
    ('W6-PAGE-15', 'current-study.js',
     'if (reportFrame?.isComposing()) {\n        showReportNotice({ status: "composing", uid, seq, reason });',
     'if (false) {\n        showReportNotice({ status: "composing", uid, seq, reason });',
     'test_page_composition_refuses_a_queued_study_activation'),
    # Post-W3: the drawer's fallback reads the field when the drawer closes; a kept reference is a removed node after an opening.
    ('W6-PAGE-18-drawer-fallback', 'feature-mounts.js',
     "fallbackFocus: () => [studyPanelField && $('#' + studyPanelField), $('#findings'),",
     "fallbackFocus: () => [openStudyPanel.field ??= studyPanelField && $('#' + studyPanelField), $('#findings'),",
     'test_page_w3_drawer_close_after_replacement_returns_to_a_current_field'),
    ('W6R1-07-section-return', 'feature-mounts.js',
     "fallbackFocus: () => [studyPanelField && $('#' + studyPanelField), $('#findings'),", "fallbackFocus: () => [$('#findings'),",
     'test_page_w3_drawer_close_after_replacement_returns_to_a_current_field'),
    ('W6-PAGE-19', 'work-exit.js', 'Object.assign(prep, captureReport());', '// Forget the report snapshot.',
     'test_page_logout_saves_template_and_hidden_recommendation_once'),
    ('W6-PAGE-20', 'session-end.js', 'reportFrame?.end({ uid: null, selectionSeq });', '// Keep the previous history.',
     'test_page_end_during_composition_purges_history_and_late_mount'),
    ('W6-PAGE-21', 'report-editor.js', 'if (reportFrameEnded) return null;', '// Allow a late mount.',
     'test_page_end_during_composition_purges_history_and_late_mount'),
    ('W6-PAGE-22', 'report-editor.js', 'host: document.querySelector(".redit"),', 'host: null,',
     'test_page_single_scroll_tab_shortcut_and_thousand_lines'),
    ('W6-PAGE-22-caret-follow', 'report-editor-frame.js',
     "if (follow && doc.activeElement === follow && follow.getAttribute('aria-hidden') !== 'true') revealCaret(follow);",
     "if (false) revealCaret(follow);", 'test_page_single_scroll_tab_shortcut_and_thousand_lines'),
    # Round 2 (Opus binding review of 9277ccd): each finding's fault put back.
    ('W6R1-01-hard-minimum', 'main.html', '.redit { flex: 1; overflow: auto;', '.redit { flex: 1; min-height: 200px; overflow: auto;',
     'test_page_frame_minimum_on_w3_layouts_with_notices_and_panel'),
    ('W6R1-01-column-scroll', 'main.html', '.report-p { overflow-y: auto; min-width: min-content; }', '.report-p { min-width: min-content; }',
     'test_page_frame_minimum_on_w3_layouts_with_notices_and_panel'),
    ('W6R1-02-hidden-focus-guard', 'report-editor-frame.js',
     "if (!hidden(s.el) || doc.activeElement !== s.el || !event.inputType?.startsWith('history')) return;", 'return;',
     'test_page_template_double_click_and_native_undo_never_focus_hidden_recommendation'),
    # Round 1's focus return: back to whatever was focused, a hidden field included, and nothing when that fails.
    ('W6R1-02-write-focus-return', 'report-editor-frame.js',
     "if (target?.isConnected && doc.activeElement !== target && !hidden(target)) target.focus({ preventScroll: true });\n"
     "      const now = doc.activeElement;\n"
     "      if (now !== target && Object.values(states).some(s => s.el === now)) now.blur();",
     "if (target?.isConnected && doc.activeElement !== target) target.focus({ preventScroll: true });",
     'test_page_template_double_click_and_native_undo_never_focus_hidden_recommendation'),
    ('W6R1-03-dictation-target', 'report-dictation.js',
     'if (reportFrame?.isWriting() || event.target.getAttribute("aria-hidden") === "true") return;',
     'if (event.target.getAttribute("aria-hidden") === "true") return;', 'test_page_template_native_focus_does_not_retarget_dictation'),
    ('W6R1-04-consuming-refusal', 'dictation-session.js', 'if (!pinned || live.value !== start.value', 'if (live.value !== start.value',
     'test_page_record_type_undo_refuses_late_dictation'),
    ('W6R1-06-skip-composition', 'work-exit.js', 'if (reportFrame?.isComposing()) {', 'if (false) {',
     'test_page_logout_during_composition_saves_the_composed_text_once'),
    ('W6R1-10-resize-scroll', 'report-editor-frame.js', 'host.scrollTop = top; host.scrollLeft = left;', '// Let a resize move the scroller.',
     'test_page_related_panel_round_trip_and_resize_keep_the_editor'),
]


def run_page_mutants():
    case = ReportEditorFramePageDOM
    names = sorted({row[-1] for row in PAGE_MUTANTS})
    baseline = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(case(n) for n in names))
    if not baseline.wasSuccessful() or baseline.skipped:
        print('PAGE BASELINE FAILED; no kills claimed')
        return 1
    lite = MODULE.parent
    order = json.loads((ROOT / 'scripts/main-split-order.json').read_text())['sources']
    originals = {row['file']:(lite / row['file']).read_text(encoding='utf-8') for row in order}
    killed = 0
    for row, file, old, new, name in PAGE_MUTANTS:
        source = SOURCE if file == MODULE.name else (originals[file] if file in originals else (lite / file).read_text(encoding='utf-8'))
        if source.count(old) != 1:
            raise AssertionError('PAGE mutation location not unique: ' + row)
        changed = source.replace(old, new, 1)
        case.source = changed if file == MODULE.name else SOURCE
        case.dictation_source = changed if file == 'dictation.js' else None
        case.bundle_source = ''.join(changed if item['file'] == file else originals[item['file']] for item in order)
        # Standalone session scripts are served separately from the generated bundle.
        case.session_source = changed if file == 'dictation-session.js' else None
        case.html_source = changed if file == 'main.html' else None
        output = io.StringIO()
        result = unittest.TextTestRunner(stream=output, verbosity=2).run(unittest.TestSuite([case(name)]))
        caught = result.testsRun == 1 and bool(result.failures) and not result.errors and not result.skipped
        print(row, file, 'KILLED' if caught else 'NOT PROVEN', flush=True)
        print(output.getvalue(), end='')
        killed += int(caught)
    case.source = SOURCE
    case.bundle_source = None
    case.dictation_source = None
    case.session_source = None
    case.html_source = None
    print('PAGE mutants killed: %s/%s' % (killed, len(PAGE_MUTANTS)))
    return 0 if killed == len(PAGE_MUTANTS) else 1


INTEGRATED_MODULE_CASES = [
    'test_integrated_history_boundary', 'test_integrated_same_opening', 'test_integrated_retired_ticket',
    'test_integrated_native_text_and_history', 'test_integrated_captured_selection', 'test_integrated_insert_and_clear_separate_following_typing',
    'test_integrated_composing_insert_and_switch', 'test_integrated_composing_insert_and_switch',
    'test_page_record_type_undo_refuses_late_dictation', 'test_page_record_type_undo_refuses_late_dictation',
    'test_integrated_sent_snapshot', 'test_integrated_permissions_and_native_failure', 'test_integrated_permissions_and_native_failure',
    'test_integrated_scroll_preserved', 'test_integrated_focus_and_unvisited', 'test_integrated_composing_insert_and_switch',
    'test_integrated_typing_and_read', 'test_integrated_composing_insert_and_switch',
    'test_page_single_scroll_tab_shortcut_and_thousand_lines', 'test_integrated_permissions_and_native_failure',
    'test_integrated_typing_and_read', 'test_integrated_hidden_and_length_refusal', 'test_integrated_hidden_and_length_refusal',
    'test_integrated_focus_and_unvisited', 'test_integrated_focus_and_unvisited', 'test_integrated_authoritative_boundary',
    'test_integrated_batch_focus_precheck', 'test_integrated_native_text_and_history', 'test_integrated_native_text_and_history',
    'test_page_authoritative_equal_keeps_undo_partial_equal_keeps_caret', 'test_integrated_authoritative_reentry',
    'test_integrated_equality_lf_only', 'test_integrated_equality_lf_only', 'test_integrated_partial_equal_caret',
]


def run_integrated_module_mutants(labels=()):
    """Original fa2de4f M01..M34 applied to the frame served by the actual main page."""
    case = ReportEditorFramePageDOM
    rows = list(zip(MUTANTS[:34], INTEGRATED_MODULE_CASES, strict=True))
    if labels:
        unknown = set(labels) - {row[0][0] for row in rows}
        if unknown:
            raise ValueError('Unknown integrated mutation labels: ' + ', '.join(sorted(unknown)))
        rows = [row for row in rows if row[0][0] in labels]
    baseline = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(case(n) for n in sorted({row[1] for row in rows})))
    if not baseline.wasSuccessful() or baseline.skipped:
        print('INTEGRATED MODULE BASELINE FAILED; no kills claimed')
        return 1
    killed = 0
    for (label, old, new, _), name in rows:
        if SOURCE.count(old) != 1:
            raise AssertionError('Module mutation location not unique: ' + label)
        case.source = SOURCE.replace(old, new, 1)
        output = io.StringIO()
        result = unittest.TextTestRunner(stream=output, verbosity=2).run(unittest.TestSuite([case(name)]))
        caught = result.testsRun == 1 and bool(result.failures) and not result.errors and not result.skipped
        print(label, name, 'KILLED' if caught else 'NOT PROVEN', flush=True)
        print(output.getvalue(), end='')
        killed += int(caught)
    case.source = SOURCE
    print('Integrated original module mutants killed: %s/%s' % (killed, len(rows)))
    return 0 if killed == len(rows) else 1


def run_mutants():
    killed = 0
    for label, old, new, names in MUTANTS:
        old_lines, new_lines = old.split('\n'), new.split('\n')
        if (SOURCE.count(old) != 1 or len(old_lines) != len(new_lines)
                or sum(a != b for a, b in zip(old_lines, new_lines)) != 1):
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
    parser.add_argument("--page", action="store_true", help="Run the actual delivered-page integration cases")
    parser.add_argument("--page-mutants", action="store_true")
    parser.add_argument("--integrated-module-mutants", action="store_true")
    parser.add_argument("tests", nargs="*")
    args = parser.parse_args()
    if args.integrated_module_mutants:
        return run_integrated_module_mutants(args.tests)
    if args.page_mutants:
        return run_page_mutants()
    if args.mutants:
        return run_mutants()
    case = ReportEditorFramePageDOM if args.page else ReportEditorFrameDOM
    names = args.tests or unittest.defaultTestLoader.getTestCaseNames(case)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(case(n) for n in names))
    return 0 if result.wasSuccessful() and not result.skipped else 1


if __name__ == "__main__":
    raise SystemExit(main())
