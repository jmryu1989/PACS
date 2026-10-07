# coding: utf-8
"""REQ-S7-RL-SMALL-WINDOW / REQ-S7-RL-CLINICAL-SPILL / REQ-S7-RL-NO-DRIFT
-> RISK-S7-RL-HIDDEN-ROW / RISK-S7-RL-OFFSCREEN-PRIOR / RISK-S7-RL-STORED-SIZE / RISK-S7-RL-CLINICAL-COVER /
   RISK-S7-RL-DEFAULT-DRIFT / RISK-S7-RL-REDESIGN
-> TEST-S7-RL-DOM (RelatedLayoutDOMTest, hosted measurements step) and the R-EQ record (RelatedLayoutEquivalence, local).

The shipped worklist page boots through the S7-U3b harness (tests/multi_institution_worklist_dom_test.py: its Server, row()
and boot(), imported and never edited here) and is looked at the way a user looks at it in a small landscape window
(900x600 and its neighbours): what is visible, what a pointer at the visible centre reaches, what the wheel, Tab and the
arrow keys bring into view, and whether the document itself had to scroll (a user cannot scroll it: the page keeps it
fixed, so anything reachable only by moving the document is not reachable). Landmarks are found by role, accessible name
and visible text; an area is "the smallest element holding two landmarks" (the Related list holds the "Related Exam" title
and the Related table, the Related panel holds the list/report separator and that table, the Clinical Info column holds its
heading and Copy Patient ID). No id, class, data-* attribute, stylesheet text or page function is read or called.

"Text is visible" is judged on the TEXT, not on its element: the first line box of a text node (Range client rect) is cut
by the viewport and by every ancestor that clips (overflow other than visible), and at least 8px of it must remain with
its own element under the centre of what remains (T8). An element whose padding is on screen while its letters are cut
off is not visible text (Astra RL-DIAG-F01). Each T8 cross-checks itself against the element's IntersectionObserver
rectangle; a disagreement is a tool error, never a pass.

Cases (the RL ids are test-plan section 3 of the S7-RELATED-LAYOUT diagnosis, PACS-docs c66135d):
  fc1..fc6, fc8 harness fitness: related rows in server mode, no undeclared write, the main.html override is read once
       per process (so other pages are measured in child processes), a window resize re-applies the layout, a stored
       layout is restored for the harness session, the Clinical Context region shows, and a page-level route for the
       report history answers before the harness route (the five prior report states). FC-7 (reading text size through
       the harness) is not available - the Appearance control stays disabled without its account answer - so the 16px
       preserving variant PV-03 is not part of this module.
  rl01 900x600, each prior report state (no related exam chosen, loading, failure, no report, report shown), with and
       without the hidden-filter notice: reading-target label visible, Modality select whole, the notice whole with 2px
       of the list below it, Related Report visible, the first body text line T8, the Findings value reachable inside the
       prior report pane, the keyboard help reachable, every Related panel landmark inside the window, no sideways scroll
       of the Related list, document never scrolled.
  rl02 900x600 a related row: the wheel over the list brings it under the pointer, below the sticky header, inside the
       table; a click on it opens it.
  rl03 the Clinical Info column draws only inside itself (every text line it holds stays inside its box) and the
       neighbouring controls are not under it; each of its controls is reachable inside the column (900x600, 1366x768).
  rl04 keyboard: More Filters -> Tab reaches a related row, the arrow keys and End move to visible rows.
  rl05 a stored 400px list height: capped in the small window without being rewritten, back at 400px in a large one;
       a drag in the small window stores what is visible; Reset Layout.
  rl05b (S7-U5 H1) a stored list height capped while the View group is open (a layout applied inside it) is back in full
       once the group is closed, with no window resize, and the capped height is not stored.
  rl07 900x700, 1024x600, 1366x600, 1024x700, Technician at 900x600, Layout: Portrait at 900x600, 900x500 (no overlap
       only). 1024x700 (D390) is a window whose work row lands in the band the hosted Linux fonts exposed at 900x700
       (292px there, 270px here): about 300px with either font set, where a short-row rule that ends at 286px lets the
       table slide under the prior report pane, so a Windows run sees that failure too.
  rl09 no related exam, 60 related exams (page buttons), long literal descriptions, no reading target.
  rl10 (D383) portrait windows where the Related panel sits at its 286px minimum (900x1200, 768x1024): the opened related
       row (three rows, 60 rows, a portrait layout stored at the drag minimums) is whole in the window, on top at points
       across its whole box (what a user sees and clicks, which the viewport ratio alone does not show) and a click at its
       centre reaches it; with no related exam the table's message is visible text (T8); in every prior report state the
       first body text line is T8; the list, the separator and the prior report pane stay inside the panel in that order.
       The hidden-filter notice case is not part of it (follow-up S7-RL-NOTICE-PORTRAIT).
  rl12 (S7-U5 S4 GEO) Image Findings open in the Reading Workspace (1366x768 as is and with the report's button row at
       the window's bottom edge, 1280x720, 1920x1080, 900x1200, 768x1024): the panel is apart from Approve, Save, Prelim,
       Dictate and its own toggle, each of them whole and on top, its Close reachable, and the first Related row apart
       from it and clickable.
  RelatedLayoutEquivalence rl06/rl08: work rows of 360px or more (1600x1050, 1366x768, 1920x1080, 1280x800, 1024x768),
       portrait (900x1400, 900x1200, 768x1024) and the report window at 900x600/900x700 lay out exactly as on the
       implementation base. Why a fixed-commit comparison (AGENTS 1-B 14): this unit's requirement there IS sameness with
       the base, so the base page (read from the fixed commit by its LF sha256, tests/report_actions_dom_test.py
       fixed_file) and this page are booted alike in child processes and their landmark rectangles compared (+-0.5px).
       Where the base drew Clinical Info text outside its column (the defect fixed here) the visible part is compared
       inside the column only. One exception (EQ_EXCEPTION, D383): at 900x1200 and 768x1024 the landmarks inside the
       Related panel (table, separator, Related Report, first body text line) may move, each for the reason written next
       to it; the panel's own box and everything outside it are still compared. Not in CI: a hosted checkout may lack the
       commit; it is recorded once at the candidate.

Measurements are printed as `RL-MEASURE {json}` lines next to the assertions; they are observations, not pass evidence.
KIN_MULTI_INSTITUTION_MAIN (the harness override) points the page at a copy for the local mutant runs. Synthetic data only
(SYN-* names); no server, no network, no credentials.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import multi_institution_worklist_dom_test as harness  # noqa: E402  (imported, never edited: S7-DEMO-ROWS owns it)

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
SMALL = (900, 600)
LARGE = (1600, 1050)
PORTRAIT_MIN = [(900, 1200), (768, 1024)]   # portrait windows where the Related panel sits at its 286px minimum

PID = "SYN-RL-01"
CURRENT_DESC, REPORT_DESC, NOREPORT_DESC, CT_DESC = "SYN RL CURRENT CT", "SYN RL PRIOR MR", "SYN RL PRIOR MR NO REPORT", "SYN RL PRIOR CT"
REPORT_UID = "2.25.7002"
FINDINGS = "SYN RL prior findings first line"
VERSIONS = [{"action": "approve", "version": 1, "findings": FINDINGS, "conclusion": "SYN RL prior conclusion",
             "recommendation": "SYN RL prior recommendation", "author": "syn-reader-a@synthetic.test"}]


def rows(extra=()):
    return [harness.row("2.25.7001", PID, date="20261005", rs="W", modality="CT", desc=CURRENT_DESC),
            harness.row(REPORT_UID, PID, date="20260905", rs="A", modality="MR", desc=REPORT_DESC),
            harness.row("2.25.7003", PID, date="20260805", rs="W", modality="MR", desc=NOREPORT_DESC),
            harness.row("2.25.7004", PID, date="20260705", rs="W", modality="CT", desc=CT_DESC),
            harness.row("2.25.7100", "SYN-RL-OTHER", date="20261004", modality="CT", desc="SYN RL OTHER PATIENT"), *extra]


# What the prior report pane says first in each state (the page's own sentences; Findings is the first section heading).
STATES = {"unselected": "Related Exam을 선택하세요", "loading": "승인 판독문 불러오는 중…", "failure": "판독문 조회 실패",
          "none": "판독문 없음", "shown": "Findings"}
NOTICE = "열람 중인 검사는 필터 밖입니다"
HELP = "↑/↓ · Home/End 이동 · Enter 미리보기 · Tab 영상 버튼"
SEPARATOR = "드래그하여 Related 목록과 이전 판독문 높이 조절"
LAYOUT_KEY = "kin-workspace:v1:" + json.dumps([harness.SESSION_A["institution"], harness.SESSION_A["sub"]], separators=(",", ":"))

# Geometry helpers evaluated in the page. They read layout (client rects, IntersectionObserver, elementFromPoint and the
# computed overflow that decides whether a box clips), never the page's names or code.
TOOLS = r"""
const io = el => new Promise(done => { const o = new IntersectionObserver(es => { o.disconnect(); const e = es[0];
  done({ratio: e.intersectionRatio, rect: [e.intersectionRect.left, e.intersectionRect.top, e.intersectionRect.right, e.intersectionRect.bottom],
        box: [e.boundingClientRect.left, e.boundingClientRect.top, e.boundingClientRect.right, e.boundingClientRect.bottom]}); }); o.observe(el); });
const within = (hit, el) => !!hit && (hit === el || el.contains(hit));
const centre = r => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
const hits = (el, r) => r[2] - r[0] > 0 && r[3] - r[1] > 0 && within(document.elementFromPoint(...centre(r)), el);
const clip = (start, r) => {
  let [l, t, rr, b] = [Math.max(r[0], 0), Math.max(r[1], 0), Math.min(r[2], innerWidth), Math.min(r[3], innerHeight)];
  // The body's overflow belongs to the viewport, which the line above already applied.
  for (let e = start; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    const s = getComputedStyle(e), box = e.getBoundingClientRect();
    const pl = box.left + e.clientLeft, pt = box.top + e.clientTop;
    if (s.overflowX !== 'visible') { l = Math.max(l, pl); rr = Math.min(rr, pl + e.clientWidth); }
    if (s.overflowY !== 'visible') { t = Math.max(t, pt); b = Math.min(b, pt + e.clientHeight); }
  }
  return [l, t, Math.max(l, rr), Math.max(t, b)];
};
const firstRect = node => { const range = document.createRange(); range.selectNodeContents(node);
  const r = [...range.getClientRects()].find(x => x.width > 0 && x.height > 0); return r ? [r.left, r.top, r.right, r.bottom] : null; };
const texts = root => { const out = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.trim()) out.push(n); return out; };
const exposure = async node => {
  const line = firstRect(node); if (!line) return null;
  const el = node.parentElement, cut = clip(el, line), own = await io(el);
  const h = cut[3] - cut[1], w = cut[2] - cut[0];
  // Tool self-check: what survives of the line must lie inside what the browser reports visible of its element.
  const agrees = h <= 0 || w <= 0 || (cut[0] >= own.rect[0] - 0.5 && cut[1] >= own.rect[1] - 0.5 && cut[2] <= own.rect[2] + 0.5 && cut[3] <= own.rect[3] + 0.5);
  return {text: node.nodeValue.trim(), line, cut, h, w, hit: h > 0 && w > 0 && hits(el, cut), element_visible_h: own.rect[3] - own.rect[1], agrees};
};
const docScroll = () => [document.scrollingElement.scrollTop, document.scrollingElement.scrollLeft];
"""


def js(page, body, arg=None):
    return page.evaluate("async (arg) => {" + TOOLS + body + "}", arg)


def measure(tag, **values):
    print("RL-MEASURE " + json.dumps({"case": tag, **values}, ensure_ascii=False, default=str))


def centre_of_box(b):
    return (b[0] + b[2]) / 2, (b[1] + b[3]) / 2


class Window:
    """One booted page and the landmarks a user finds on it."""

    def __init__(self, case, screen):
        self.case, self.screen, self.page = case, screen, screen.page
        page = self.page
        self.related_table = page.get_by_role("table").filter(
            has=page.get_by_role("columnheader", name="Viewing", exact=True)).filter(
            has=page.get_by_role("columnheader", name="StudyDesc", exact=True)).filter(
            # the worklist also has Viewing and StudyDesc; Name is the column no worklist layout can hide
            has_not=page.get_by_role("columnheader", name="Name", exact=True))
        self.separator = page.get_by_role("separator", name=SEPARATOR, exact=True)
        self.title = page.get_by_text("Related Exam", exact=True)
        self.select = page.get_by_role("combobox", name="관련 검사 Modality", exact=True)
        self.notice = page.get_by_text(NOTICE, exact=True)
        self.help = page.get_by_text(HELP, exact=True)
        self.reading_target = page.get_by_role("button", name="Reading Target", exact=True)
        self.list_region = self.region(self.title, self.related_table)
        self.target_label = self.list_region.get_by_text(re.compile(r"^판독 대상( · |을 선택하세요$)"))
        self.panel = self.region(self.separator, self.related_table)
        self.report_head = self.panel.get_by_text("Related Report", exact=True)
        self.clinical = self.region(page.get_by_role("heading", name=re.compile(r"^Clinical Info")),
                                    page.get_by_role("button", name="Copy Patient ID", exact=True))

    def region(self, a, b):
        # The deepest element holding both landmarks (document order puts it last among its ancestors).
        return self.page.locator("*").filter(has=a).filter(has=b).last

    def worklist_row(self, desc):
        return self.screen.table().get_by_role("row").filter(has=self.page.get_by_role("cell", name=desc, exact=True))

    def related_row(self, desc):
        return self.related_table.get_by_role("row").filter(has=self.page.get_by_role("cell", name=desc, exact=True))

    def visible(self, locator):
        return js(self.page, "return await io(arg);", locator.element_handle())

    def pointable(self, locator):
        return js(self.page, "const v = await io(arg); return v.ratio > 0 && hits(arg, v.rect);", locator.element_handle())

    def doc_scroll(self):
        return js(self.page, "return docScroll();")

    def first_line(self):
        """The first text under the Related Report head line in the Related panel: the status sentence or Findings."""
        return js(self.page, """
          const [panel] = arg, nodes = texts(panel), at = nodes.findIndex(n => n.nodeValue.trim() === 'Related Report');
          if (at < 0) return null;
          const head = firstRect(nodes[at]);
          for (const n of nodes.slice(at + 1)) { const r = firstRect(n); if (r && r[1] >= head[3] - 0.01) return await exposure(n); }
          return null;""", [self.panel.element_handle()])

    def prior_pane(self):
        """The smallest element holding the Related Report head text and the first text below it (an element handle)."""
        return self.page.evaluate_handle("async (arg) => {" + TOOLS + """
          const [panel] = arg, nodes = texts(panel), at = nodes.findIndex(n => n.nodeValue.trim() === 'Related Report');
          const head = firstRect(nodes[at]);
          const below = nodes.slice(at + 1).find(n => { const r = firstRect(n); return r && r[1] >= head[3] - 0.01; });
          let e = nodes[at].parentElement; while (!e.contains(below)) e = e.parentElement; return e; }""",
                                        [self.panel.element_handle()])

    def menu_button(self, name):
        """A button in the View menu (the page keeps layout controls there)."""
        self.screen.menu("View").get_by_role("button", name=name, exact=True).click()
        self.screen.menu("View", open_=False)

    def text_exposure(self, locator):
        return js(self.page, "return await exposure(texts(arg)[0]);", locator.element_handle())

    def scroll_into_view(self, locator):
        # What a user's wheel or focus move does inside the scroll containers; the document must not have to move.
        locator.evaluate("e => e.scrollIntoView({block: 'nearest', inline: 'nearest'})")

    # ── assertions ──
    def assert_no_document_scroll(self, what):
        self.case.assertEqual([0, 0], self.doc_scroll(), f"{what}: the document scrolled (a user cannot scroll it back)")

    def assert_t8(self, tag, expected):
        line = self.first_line()
        measure(tag, first_line=line)
        self.case.assertIsNotNone(line, f"{tag}: no text under the Related Report head")
        self.case.assertTrue(line["agrees"], f"{tag}: line tool disagrees with IntersectionObserver {line}")
        self.case.assertTrue(line["text"].startswith(expected), f"{tag}: state not reached, first text {line['text']!r}")
        self.case.assertTrue(line["h"] >= 8 and line["hit"], f"{tag}: first body text line T8 - {line['h']:.1f}px visible, hit {line['hit']}")

    def assert_context(self, tag, state, notice):
        """RL-01: everything the reader needs to know what the prior report pane shows, at once, without moving the page."""
        page, case = self.page, self.case
        self.assert_no_document_scroll(f"{tag} before")
        if state != "no-target":
            case.assertGreater(self.visible(self.target_label)["ratio"], 0, f"{tag}: reading-target label visible")
        case.assertGreaterEqual(self.visible(self.select)["ratio"], 0.999, f"{tag}: Modality select whole")
        if notice:
            seen, area = self.visible(self.notice), self.visible(self.list_region)
            measure(tag, notice=seen, list_visible=area["rect"])
            case.assertGreaterEqual(seen["ratio"], 0.999, f"{tag}: hidden-filter notice whole (V1)")
            case.assertGreaterEqual(area["rect"][3] - seen["rect"][3], 2 - 0.01, f"{tag}: 2px of the list below the notice")
        case.assertGreater(self.visible(self.report_head)["ratio"], 0, f"{tag}: Related Report visible")
        self.assert_t8(tag, STATES["unselected"] if state == "no-target" else STATES[state])
        height = page.evaluate("() => innerHeight")
        for name, locator in (("Related panel", self.panel), ("separator", self.separator), ("Related Report", self.report_head)):
            box = locator.bounding_box()
            case.assertLessEqual(box["y"] + box["height"], height + 0.5, f"{tag}: {name} inside the window (viewport bottom)")
        # No sideways scroll of the list: a horizontal wheel over the title leaves it where it is.
        before = self.visible(self.title)["box"]
        page.mouse.move(*self.centre_of(self.title))
        page.mouse.wheel(160, 0)
        page.wait_for_timeout(120)
        case.assertAlmostEqual(before[0], self.visible(self.title)["box"][0], delta=0.5, msg=f"{tag}: the Related list scrolled sideways")
        # Reachable inside their panes (S): the keyboard help, and in the shown state the Findings value.
        reach = [("keyboard help", self.help)] + ([("Findings value", page.get_by_text(FINDINGS, exact=True))] if state == "shown" else [])
        for name, locator in reach:
            case.assertIsNotNone(js(page, "return firstRect(texts(arg)[0]);", locator.element_handle()), f"{tag}: {name} rendered")
            self.scroll_into_view(locator)
            self.assert_no_document_scroll(f"{tag} {name}")
            line = self.text_exposure(locator)
            measure(tag, reach=name, line=line)
            case.assertTrue(line["h"] >= 8 and line["hit"], f"{tag}: {name} S - {line['h']:.1f}px after scrolling its pane")
        self.scroll_into_view(self.title)
        self.scroll_into_view(self.report_head)
        self.assert_no_document_scroll(f"{tag} after")

    def centre_of(self, locator):
        r = self.visible(locator)["rect"]
        return (r[0] + r[2]) / 2, (r[1] + r[3]) / 2

    def assert_row_pointer(self, tag, desc):
        """RL-02: a related row comes under the pointer by the wheel over the list, below the sticky header, and opens."""
        page, case, row = self.page, self.case, self.related_row(desc)
        # The wheel scrolls what is under the pointer: first over the list's own top line until the table stops moving
        # (the list is at its end, or does not scroll at all), then over the table in small steps.
        for _ in range(12):
            if self.pointable(row):
                break
            before = self.visible(self.related_table)["box"][1]
            top = self.visible(self.list_region)["rect"]
            page.mouse.move((top[0] + top[2]) / 2, top[1] + 3)
            page.mouse.wheel(0, 40)
            page.wait_for_timeout(60)
            if abs(self.visible(self.related_table)["box"][1] - before) < 0.5:
                break
        for _ in range(60):
            if self.pointable(row) or self.visible(self.related_table)["ratio"] <= 0:
                break
            page.mouse.move(*self.centre_of(self.related_table))
            page.mouse.wheel(0, 10)
            page.wait_for_timeout(40)
        self.assert_no_document_scroll(f"{tag} wheel")
        seen = self.visible(row)
        measure(tag, row=seen, table=self.visible(self.related_table))
        case.assertTrue(self.pointable(row), f"{tag}: row P (its visible centre reaches the row)")
        header = self.visible(self.related_table.get_by_role("row").first)
        case.assertGreaterEqual(seen["box"][1], header["box"][3] - 1, f"{tag}: row below the sticky header")
        table = self.visible(self.related_table)["rect"]
        r = seen["rect"]
        case.assertTrue(r[0] >= table[0] - 0.5 and r[1] >= table[1] - 0.5 and r[2] <= table[2] + 0.5 and r[3] <= table[3] + 0.5,
                        f"{tag}: row inside the visible table {r} {table}")
        # A click where the user sees the row (Playwright's own click would scroll the document to centre the 600px row).
        page.mouse.click(*self.centre_of(row))
        harness.until(lambda: "열람 중" in row.get_by_role("cell").first.inner_text(), 5, f"{tag} row opened")
        self.assert_no_document_scroll(f"{tag} click")

    def covered_points(self, locator):
        """Points across the element's whole box (3 across x 5 down, the outer ones 5% in from its edges) where the
        pointer reaches something else: a part painted over, or outside the window. Empty = the user sees all of it."""
        return js(self.page, """
          const b = (await io(arg)).box, out = [];
          for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.05, 0.25, 0.5, 0.75, 0.95]) {
            const x = b[0] + (b[2] - b[0]) * fx, y = b[1] + (b[3] - b[1]) * fy;
            if (!within(document.elementFromPoint(x, y), arg)) out.push([x, y]); }
          return out;""", locator.element_handle())

    def assert_row_whole_on_top(self, tag, row):
        """RL-10: the row is whole in the window, on top at every sampled point, and a click at its centre lands on it."""
        page, case = self.page, self.case
        self.assert_no_document_scroll(f"{tag} before")
        seen, covered = self.visible(row), self.covered_points(row)
        measure(tag, row=seen, covered=covered, table=self.visible(self.related_table))
        case.assertGreaterEqual(seen["ratio"], 0.999, f"{tag}: row whole in the window")
        case.assertEqual([], covered, f"{tag}: points of the row under another element")
        case.assertGreaterEqual(self.visible(self.select)["ratio"], 0.999, f"{tag}: Modality select whole")
        handle = row.element_handle()
        handle.evaluate("r => { r.landed = null; document.addEventListener('click', e => { r.landed = r.contains(e.target); }, {capture: true, once: true}); }")
        page.mouse.click(*centre_of_box(seen["box"]))
        case.assertTrue(handle.evaluate("r => r.landed"), f"{tag}: a click at the row's centre reached the row")
        harness.until(lambda: "열람 중" in row.get_by_role("cell").first.inner_text(), 5, f"{tag} row still opened")
        self.assert_no_document_scroll(f"{tag} click")

    def assert_panel_stacked(self, tag):
        """The list, the separator and the prior report pane follow each other inside the Related panel's own box."""
        panel, lst, sep = self.panel.bounding_box(), self.list_region.bounding_box(), self.separator.bounding_box()
        prior = self.prior_pane().bounding_box()
        measure(tag, panel=panel, list=lst, separator=sep, prior=prior)
        self.case.assertGreaterEqual(lst["y"], panel["y"] - 0.5, f"{tag}: list inside the panel (top)")
        self.case.assertLessEqual(lst["y"] + lst["height"], sep["y"] + 0.5, f"{tag}: list above the separator")
        self.case.assertGreaterEqual(prior["y"], sep["y"] + sep["height"] - 0.5, f"{tag}: prior report pane below the separator")
        self.case.assertLessEqual(prior["y"] + prior["height"], panel["y"] + panel["height"] + 0.5,
                                  f"{tag}: prior report pane inside the panel (bottom)")

    def assert_clinical_contained(self, tag):
        """RL-03: Clinical Info text stays inside its column, and the controls next to it are not under it."""
        page, case = self.page, self.case
        column = self.clinical.bounding_box()
        box = [column["x"], column["y"], column["x"] + column["width"], column["y"] + column["height"]]
        outside = js(page, """
          const [col, box] = arg, out = [];
          for (const n of texts(col)) { const r = firstRect(n); if (!r) continue; const c = clip(n.parentElement, r);
            if (c[2] - c[0] <= 0 || c[3] - c[1] <= 0) continue;
            if (c[0] < box[0] - 0.5 || c[1] < box[1] - 0.5 || c[2] > box[2] + 0.5 || c[3] > box[3] + 0.5) out.push([n.nodeValue.trim().slice(0, 40), c]); }
          return out;""", [self.clinical.element_handle(), box])
        measure(tag, clinical_column=box, drawn_outside=outside)
        case.assertEqual([], outside, f"{tag}: Clinical Info text drawn outside its column")
        neighbours = [("Reading Target", self.reading_target), ("Related Exam title", self.title),
                      ("Related table header", self.related_table.get_by_role("row").first),
                      ("Approve", page.get_by_role("button", name="Approve", exact=True))]
        for name, locator in neighbours:
            if not locator.count() or not locator.is_visible():
                continue
            covered = js(page, """
              const [el, col] = arg, v = await io(el), out = [];
              if (v.ratio <= 0) return out;
              for (const fx of [0.25, 0.5, 0.75]) for (const fy of [0.25, 0.5, 0.75]) {
                const x = v.rect[0] + (v.rect[2] - v.rect[0]) * fx, y = v.rect[1] + (v.rect[3] - v.rect[1]) * fy;
                if (within(document.elementFromPoint(x, y), col)) out.push([x, y]); }
              return out;""", [locator.element_handle(), self.clinical.element_handle()])
            case.assertEqual([], covered, f"{tag}: {name} under the Clinical Info column at {covered}")

    def assert_clinical_reachable(self, tag):
        page, case = self.page, self.case
        controls = [page.get_by_role("button", name="Copy Patient ID", exact=True),
                    page.get_by_role("button", name="Source SR", exact=True),
                    page.get_by_role("button", name="Tech Note", exact=True),
                    page.get_by_role("region", name="Clinical Context", exact=True).get_by_role("button", name="Refresh", exact=True)]
        for locator in controls:
            self.scroll_into_view(locator)
            self.assert_no_document_scroll(f"{tag} {locator}")
            case.assertTrue(self.pointable(locator), f"{tag}: {locator} reachable inside the Clinical Info column")


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = harness.sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def boot(self, server, **options):
        screen = harness.MultiInstitutionWorklist.boot(self, server, **options)
        return Window(self, screen)

    def open_state(self, state, *, size=SMALL, row_set=None, notice=False, storage=None):
        """Boot large, choose the reading target (and the related exam), then shrink the window - the way the live cases do."""
        server = harness.Server(rows=row_set or rows())
        w = self.boot(server, viewport=LARGE, storage=storage)
        held, served = [], []

        def versions(route):
            served.append(state)
            if state == "loading":
                held.append(route)
            elif state == "failure":
                route.fulfill(status=503, json={"message": "SYN RL failure"})
            else:
                route.fulfill(status=200, json=VERSIONS)
        w.page.route(f"**/api/studies/{REPORT_UID}/report/versions", versions)
        self.addCleanup(lambda: [r.abort() for r in held])
        w.held, w.served = held, served
        if state != "no-target":
            w.worklist_row(CURRENT_DESC).click()
            harness.until(lambda: w.target_label.inner_text().startswith("판독 대상 · "), 10, "reading target chosen")
        if state in ("loading", "failure", "shown"):
            w.related_row(REPORT_DESC).click()
        elif state == "none":
            w.related_row(NOREPORT_DESC).click()
        if state not in ("unselected", "no-target"):
            harness.until(lambda: "열람 중" in w.related_row(REPORT_DESC if state != "none" else NOREPORT_DESC).get_by_role("cell").first.inner_text(),
                          10, f"{state} related exam opened")
        w.page.set_viewport_size({"width": size[0], "height": size[1]})
        w.page.wait_for_timeout(150)
        if notice:
            w.select.select_option(label="CT")  # the viewed related exam is MR: it leaves the filter
            harness.until(lambda: w.notice.is_visible(), 5, "hidden-filter notice")
        if state != "no-target" and state != "unselected":
            harness.until(lambda: w.first_line() and w.first_line()["text"].startswith(STATES[state]), 5, f"{state} prior report state")
        return w


class RelatedLayoutDOMTest(Base):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        # The CI step's --file list is the harness step's list; this line is what the cases really served (CI-RL-01 check).
        print("S7-RELATED-LAYOUT served page files: " + json.dumps(sorted(harness.SERVED)))

    # ── harness fitness (test-plan section 2) ───────────────────────────────────────────────────────────────────────
    def test_fc1_fc2_related_rows_without_undeclared_writes(self):
        w = self.open_state("shown")
        self.assertEqual(3, w.related_table.get_by_role("row").count() - 1, "FC-1 three related rows of the same patient")
        unanswered = sorted({e["path"] for e in w.screen.server.ledger if e["status"] == 404 and e["path"].startswith("/api/")})
        print("FC-2 unanswered GETs (404, not failures): " + json.dumps(unanswered))
        w.screen.finish()

    def test_fc3_the_page_override_is_read_once_per_process(self):
        with tempfile.TemporaryDirectory() as folder:
            copy = Path(folder) / "main.html"
            copy.write_bytes((harness.HPACS / "main.html").read_bytes())
            child = subprocess.run([sys.executable, "-B", "-c", "import sys; sys.path.insert(0, sys.argv[1]); "
                                    "import multi_institution_worklist_dom_test as h; print(h.MAIN)", str(TESTS)],
                                   capture_output=True, text=True, env={**os.environ, "KIN_MULTI_INSTITUTION_MAIN": str(copy)}, timeout=120)
        self.assertEqual(0, child.returncode, child.stderr)
        self.assertEqual(str(copy), child.stdout.strip(), "FC-3 the override names the page of the whole process")
        print("FC-3 child process page: " + child.stdout.strip())

    def test_fc4_fc5_resize_reapplies_and_stored_layout_restores(self):
        stored = {"version": 1, "mode": "auto", "portrait": {}, "landscape": {"prior": 400}}
        w = self.boot(harness.Server(rows=rows()), viewport=LARGE, storage={LAYOUT_KEY: json.dumps(stored)})
        harness.expect(w.page.get_by_text("배치 복원됨 · 이 브라우저", exact=True)).to_be_visible()
        self.assertAlmostEqual(400, w.list_region.bounding_box()["height"], delta=1, msg="FC-5 stored list height applied")
        w.page.set_viewport_size({"width": 900, "height": 1200})
        harness.until(lambda: w.panel.bounding_box()["width"] >= 800, 5, "FC-4 portrait: the Related panel spans the column")
        w.page.set_viewport_size({"width": 900, "height": 600})
        harness.until(lambda: w.panel.bounding_box()["width"] < 300, 5, "FC-4 landscape again: the Related panel beside the report")
        w.screen.finish()

    def test_fc6_fc8_clinical_context_and_the_five_prior_report_states(self):
        for state in STATES:
            w = self.open_state(state)
            if state == "unselected":
                region = w.page.get_by_role("region", name="Clinical Context", exact=True)
                harness.expect(region).to_be_visible()
                self.assertGreater(region.bounding_box()["height"], 0, "FC-6 Clinical Context has height")
            line = w.first_line()
            self.assertTrue(line and line["text"].startswith(STATES[state]), f"FC-8 {state}: {line}")
            asked = state in ("loading", "failure", "shown")
            self.assertEqual([state] if asked else [], w.served, f"FC-8 {state}: the page route answered")
            self.assertFalse([e for e in w.screen.server.ledger if e["path"].endswith("/report/versions")],
                             f"FC-8 {state}: the harness route was not asked")
            w.screen.finish()

    # ── RL-01 ───────────────────────────────────────────────────────────────────────────────────────────────────────
    def test_rl01_small_window_context_visible(self):
        for state in STATES:
            for notice in ((False,) if state == "unselected" else (False, True)):
                with self.subTest(state=state, notice=notice):
                    w = self.open_state(state, notice=notice)
                    w.assert_context(f"RL-01 {state}{' notice' if notice else ''}", state, notice)
                    w.screen.finish()

    # ── RL-02 ───────────────────────────────────────────────────────────────────────────────────────────────────────
    def test_rl02_small_window_row_pointer(self):
        w = self.open_state("unselected")
        w.assert_row_pointer("RL-02", CT_DESC)
        w.screen.finish()

    # ── RL-03 ───────────────────────────────────────────────────────────────────────────────────────────────────────
    def test_rl03_clinical_column_contained(self):
        for size in (SMALL, (1366, 768)):
            with self.subTest(size=size):
                w = self.open_state("unselected", size=size)
                harness.expect(w.page.get_by_role("region", name="Clinical Context", exact=True)).to_be_visible()
                w.assert_clinical_contained(f"RL-03 {size[0]}x{size[1]}")
                w.assert_clinical_reachable(f"RL-03 {size[0]}x{size[1]}")
                w.screen.finish()

    # ── RL-04 ───────────────────────────────────────────────────────────────────────────────────────────────────────
    def test_rl04_small_window_keyboard_rows(self):
        w = self.open_state("unselected")
        page = w.page
        related = w.related_table.get_by_role("row")
        focused = lambda: page.evaluate("rs => rs.indexOf(document.activeElement)", related.element_handles())  # noqa: E731
        page.get_by_role("button", name="More Filters", exact=True).focus()
        steps = [("Tab", lambda i: i >= 1), ("ArrowDown", None), ("End", lambda i: i == related.count() - 1)]
        last = None
        for key, expected in steps:
            page.keyboard.press(key)
            page.wait_for_timeout(80)
            at = focused()
            self.assertGreaterEqual(at, 1, f"RL-04 {key}: focus on a related row")
            if expected:
                self.assertTrue(expected(at), f"RL-04 {key}: focus row {at}")
            else:
                self.assertEqual(last + 1, at, f"RL-04 {key}: next row")
            last = at
            row = related.nth(at)
            w.assert_no_document_scroll(f"RL-04 {key}")
            self.assertTrue(w.pointable(row), f"RL-04 {key}: focused row V and P")
        w.screen.finish()

    # ── RL-05 ───────────────────────────────────────────────────────────────────────────────────────────────────────
    def stored_prior(self, w):
        return json.loads(w.page.evaluate("k => localStorage.getItem(k)", LAYOUT_KEY) or "{}").get("landscape", {}).get("prior")

    def test_rl05_stored_size_short_window(self):
        stored = {"version": 1, "mode": "auto", "portrait": {}, "landscape": {"prior": 400}}
        w = self.open_state("unselected", size=LARGE, storage={LAYOUT_KEY: json.dumps(stored)})
        self.assertAlmostEqual(400, w.list_region.bounding_box()["height"], delta=1, msg="RL-05 stored 400px at 1600x1050")
        w.page.set_viewport_size({"width": SMALL[0], "height": SMALL[1]})
        w.page.wait_for_timeout(150)
        w.assert_context("RL-05 stored", "unselected", False)
        self.assertEqual(400, self.stored_prior(w), "RL-05 the small window did not rewrite the stored size")
        w.page.set_viewport_size({"width": LARGE[0], "height": LARGE[1]})
        harness.until(lambda: abs(w.list_region.bounding_box()["height"] - 400) <= 1, 5, "RL-05 400px again at 1600x1050")
        w.page.set_viewport_size({"width": SMALL[0], "height": SMALL[1]})
        w.page.wait_for_timeout(150)
        w.assert_row_pointer("RL-05 stored", CT_DESC)
        # A drag in the small window: what is visible is what is stored.
        w.scroll_into_view(w.title)
        box = w.separator.bounding_box()
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        w.page.mouse.move(x, y)
        w.page.mouse.down()
        w.page.mouse.move(x, y - 30, steps=4)
        w.page.mouse.move(x, y + 30, steps=4)
        w.page.mouse.up()
        w.page.wait_for_timeout(150)
        w.assert_context("RL-05 dragged", "none", False)   # the row opened above has no report
        harness.until(lambda: self.stored_prior(w) is not None and abs(self.stored_prior(w) - w.list_region.bounding_box()["height"]) <= 1,
                      5, "RL-05 stored size = visible list height")
        measure("RL-05 dragged", stored=self.stored_prior(w), visible=w.list_region.bounding_box()["height"])
        w.menu_button("Reset Layout")
        w.page.wait_for_timeout(150)
        w.assert_context("RL-05 reset", "none", False)
        w.screen.finish()

    def test_rl05b_stored_size_back_when_the_work_area_grows_without_a_resize(self):
        """RL-05b (S7-U5 H1, review of 8c2cf37 F-02): an open View group is a second toolbar row in the flow, so the work
        area is smaller while it is open, and a layout applied then (Layout: Portrait, then Layout: Landscape, pressed
        inside the group) fits the stored list height into that smaller space. Closing the group gives the space back
        with the window unchanged: the stored size comes back - the Related list is as tall as before the group opened -
        and the squeezed height was never stored. The stored height is larger than any window, so it is always capped."""
        stored = {"version": 1, "mode": "auto", "portrait": {}, "landscape": {"prior": 5000}}
        w = self.boot(harness.Server(rows=rows()), viewport=LARGE, storage={LAYOUT_KEY: json.dumps(stored)})
        harness.expect(w.page.get_by_text("배치 복원됨 · 이 브라우저", exact=True)).to_be_visible()
        before = w.list_region.bounding_box()["height"]
        # The layout button is named by what it shows (Layout: Auto -> Portrait -> Landscape).
        toggle = w.screen.menu("View").get_by_role("button").filter(has_text=re.compile(r"^Layout: "))
        for shown in ("Layout: Portrait", "Layout: Landscape"):
            toggle.click()
            harness.expect(toggle).to_have_text(shown)
        w.page.wait_for_timeout(150)
        squeezed = w.list_region.bounding_box()["height"]
        measure("RL-05b", before=before, squeezed=squeezed)
        self.assertLess(squeezed, before - 1, "RL-05b precondition: the open View group leaves the list less room")
        w.screen.menu("View", open_=False)
        harness.until(lambda: abs(w.list_region.bounding_box()["height"] - before) <= 1, 5,
                      "RL-05b the stored size back once the closed View group gave the space back (window unchanged)")
        self.assertEqual(5000, self.stored_prior(w), "RL-05b the squeezed height was stored")
        w.screen.finish()

    # ── RL-07 ───────────────────────────────────────────────────────────────────────────────────────────────────────
    def test_rl07_window_variants(self):
        for size in ((900, 700), (1024, 600), (1366, 600), (1024, 700)):
            for state, notice in (("unselected", False), ("shown", True)):
                with self.subTest(size=size, state=state):
                    w = self.open_state(state, size=size, notice=notice)
                    tag = f"RL-07 {size[0]}x{size[1]} {state}"
                    w.assert_context(tag, state, notice)
                    w.assert_clinical_contained(tag)
                    w.screen.finish()
            with self.subTest(size=size, case="row"):
                w = self.open_state("unselected", size=size)
                w.assert_row_pointer(f"RL-07 {size[0]}x{size[1]}", CT_DESC)
                w.screen.finish()
        with self.subTest(case="Technician"):
            w = self.open_state("unselected")
            w.page.get_by_text("Technician", exact=True).first.click()
            w.page.wait_for_timeout(200)
            w.assert_clinical_contained("RL-07 Technician 900x600")
            w.screen.finish()
        with self.subTest(case="Layout: Portrait"):
            w = self.open_state("unselected")
            w.menu_button("화면 배치 auto")  # Layout: Auto -> Portrait; its accessible name is the Korean label
            harness.until(lambda: w.panel.bounding_box()["width"] >= 800, 5, "Layout: Portrait applied")
            row = w.related_row(CT_DESC)
            w.scroll_into_view(row)
            w.assert_no_document_scroll("RL-07 Portrait row")
            self.assertTrue(w.pointable(row), "RL-07 Portrait: row S in the scrolling right column")
            w.screen.finish()
        with self.subTest(case="900x500"):
            w = self.open_state("unselected", size=(900, 500))
            page = w.page
            list_box, sep_box = w.list_region.bounding_box(), w.separator.bounding_box()
            prior = w.prior_pane()
            prior_box = prior.bounding_box()
            measure("RL-07 900x500", list=list_box, separator=sep_box, prior=prior_box)
            self.assertLessEqual(list_box["y"] + list_box["height"], sep_box["y"] + 0.5, "RL-07 900x500: list above the separator")
            self.assertGreaterEqual(prior_box["y"], sep_box["y"] + sep_box["height"] - 0.5, "RL-07 900x500: prior pane below it")
            # N: every sampled point of each pane belongs to that pane.
            for name, area in (("list", w.list_region.element_handle()), ("prior report", prior)):
                stray = js(page, """
                  const [el] = arg, v = await io(el), out = [];
                  for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.1, 0.3, 0.5, 0.7, 0.9]) {
                    const x = v.rect[0] + (v.rect[2] - v.rect[0]) * fx, y = v.rect[1] + (v.rect[3] - v.rect[1]) * fy;
                    if (!within(document.elementFromPoint(x, y), el)) out.push([x, y]); }
                  return out;""", [area])
                self.assertEqual([], stray, f"RL-07 900x500: points of the {name} pane covered by another pane")
            w.assert_no_document_scroll("RL-07 900x500")
            w.screen.finish()

    # ── RL-09 ───────────────────────────────────────────────────────────────────────────────────────────────────────
    def test_rl09_content_variants(self):
        with self.subTest(case="no related exam"):
            only = [harness.row("2.25.7001", PID, date="20261005", rs="W", modality="CT", desc=CURRENT_DESC)]
            w = self.open_state("unselected", row_set=only)
            harness.expect(w.related_table.get_by_text("관련 검사 없음", exact=True)).to_be_visible()
            w.assert_context("RL-09 no related", "unselected", False)
            w.screen.finish()
        with self.subTest(case="60 related exams"):
            many = [harness.row(f"2.25.78{i:02d}", PID, date=f"2025{1 + i % 12:02d}{1 + i % 28:02d}", rs="W", modality="CT",
                                desc=f"SYN RL MANY {i:02d}") for i in range(60)]
            w = self.open_state("unselected", row_set=rows(many))
            nxt = w.page.get_by_role("button", name="Next", exact=True)
            harness.expect(nxt).to_be_attached()
            w.assert_context("RL-09 60 related", "unselected", False)
            w.scroll_into_view(nxt)
            w.assert_no_document_scroll("RL-09 page button")
            self.assertTrue(w.pointable(nxt), "RL-09 60 related: page button S and P")
            w.scroll_into_view(w.title)
            w.assert_row_pointer("RL-09 60 related", CT_DESC)
            w.screen.finish()
        with self.subTest(case="long literal descriptions"):
            literal = "SYN RL LONG <b>literal</b> & \"quoted\" " + "x" * 160
            long_rows = rows([harness.row("2.25.7200", PID, date="20250101", rs="W", modality="CT", desc=literal)])
            w = self.open_state("unselected", row_set=long_rows)
            w.assert_context("RL-09 long literal", "unselected", False)
            w.assert_row_pointer("RL-09 long literal", CT_DESC)
            w.screen.finish()
        with self.subTest(case="no reading target"):
            w = self.open_state("no-target")
            harness.expect(w.target_label).to_have_text("판독 대상을 선택하세요")
            w.assert_context("RL-09 no reading target", "no-target", False)
            w.screen.finish()

    # ── RL-10 (D383) ────────────────────────────────────────────────────────────────────────────────────────────────
    def test_rl10_portrait_selected_row_whole_and_on_top(self):
        many = [harness.row(f"2.25.78{i:02d}", PID, date=f"2025{1 + i % 12:02d}{1 + i % 28:02d}", rs="W", modality="CT",
                            desc=f"SYN RL MANY {i:02d}") for i in range(60)]
        only = [harness.row("2.25.7001", PID, date="20261005", rs="W", modality="CT", desc=CURRENT_DESC)]
        # A portrait layout stored at the panel's and the list's drag minimums.
        stored = {"version": 1, "mode": "auto", "portrait": {"related": 286, "prior": 150}, "landscape": {}}
        for size in PORTRAIT_MIN:
            name = f"{size[0]}x{size[1]}"
            cases = [("rows", dict(state="shown")), ("60 rows", dict(state="shown", row_set=rows(many))),
                     ("stored size", dict(state="shown", storage={LAYOUT_KEY: json.dumps(stored)})),
                     ("no related exam", dict(state="unselected", row_set=only))]
            for label, options in cases:
                with self.subTest(size=name, case=label):
                    w = self.open_state(size=size, **options)
                    tag = f"RL-10 {name} {label}"
                    if label == "no related exam":
                        # No row to select: the table's message says so. Its cell is taller than an exam row and scrolls
                        # inside the table, so it is judged as visible text (T8, on top), not as a whole row.
                        message = w.related_table.get_by_text("관련 검사 없음", exact=True)
                        harness.expect(message).to_be_visible()
                        w.assert_no_document_scroll(tag)
                        line = w.text_exposure(message)
                        measure(tag, message=line)
                        self.assertTrue(line["agrees"], f"{tag}: line tool disagrees with IntersectionObserver {line}")
                        self.assertTrue(line["h"] >= 8 and line["hit"], f"{tag}: the message T8 - {line['h']:.1f}px visible, hit {line['hit']}")
                    else:
                        w.assert_row_whole_on_top(tag, w.related_row(REPORT_DESC))
                    w.assert_panel_stacked(tag)
                    w.screen.finish()
            # The prior report pane at its portrait floor still shows what it holds, in every state.
            for state in STATES:
                with self.subTest(size=name, state=state):
                    w = self.open_state(state, size=size)
                    tag = f"RL-10 {name} {state}"
                    w.assert_no_document_scroll(tag)
                    w.assert_t8(tag, STATES[state])
                    w.assert_panel_stacked(tag)
                    w.screen.finish()

    # ── RL-11 (S7-U5 fix-up D; triage M, stop-rule counterexample 4) ─────────────────────────────────────────────────
    # The Reading Workspace sizes the Related list itself (reading-workspace.js); its table kept only 40px under the fixed
    # rows, less than its sticky header and one row, so the header covered the row a click aimed at (six live modules).
    # Supported windows, landscape and portrait, the narrow stacked layout included.
    READING_SIZES = [(1280, 720), (1366, 768), (1024, 768), (1600, 1050), (1920, 1080), (900, 1200), (768, 1024), (900, 1400)]

    def open_reading(self, size, row_set=None, target=CURRENT_DESC):
        """Boot large, choose the reading target, open the Reading Workspace, then size the window."""
        w = self.boot(harness.Server(rows=row_set or rows()), viewport=LARGE)
        # The workspace's viewer frame: an empty document here (the viewer is not what this case measures).
        w.page.route("**/ohif/**", lambda route: route.fulfill(status=200, content_type="text/html",
                                                               body="<!doctype html><title>SYN viewer</title>"))
        w.worklist_row(target).click()
        harness.until(lambda: w.target_label.inner_text().startswith("판독 대상 · "), 10, "reading target chosen")
        w.page.get_by_role("button", name="Reading Workspace", exact=True).click()
        harness.until(lambda: w.page.evaluate("() => document.body.classList.contains('reading')"), 10, "reading workspace open")
        w.page.set_viewport_size({"width": size[0], "height": size[1]})
        w.page.wait_for_timeout(150)
        return w

    def table_floor(self, w):
        """The table's own scroll box against its header and its first row, from layout."""
        return js(w.page, """
          const t = arg, grid = t.parentElement, head = t.tHead.getBoundingClientRect(), row = t.tBodies[0].rows[0].getBoundingClientRect();
          return {box: grid.clientHeight, head: head.height, row: row.height};""", w.related_table.element_handle())

    def test_rl11_reading_workspace_header_never_covers_a_row(self):
        many = [harness.row(f"2.25.79{i:02d}", PID, date=f"2025{1 + i % 12:02d}{1 + i % 28:02d}", rs="W", modality="CT",
                            desc=f"SYN RL READ {i:02d}") for i in range(30)]
        for size in self.READING_SIZES:
            name = f"{size[0]}x{size[1]}"
            for label, row_set, targets in [("rows", None, [REPORT_DESC, NOREPORT_DESC, CT_DESC, REPORT_DESC]),
                                            ("30 rows", rows(many), ["SYN RL READ 00", "SYN RL READ 17", "SYN RL READ 29", "SYN RL READ 03"])]:
                with self.subTest(size=name, case=label):
                    w = self.open_reading(size, row_set)
                    tag = f"RL-11 {name} {label}"
                    floor = self.table_floor(w)
                    measure(tag, floor=floor)
                    self.assertGreaterEqual(floor["box"] + 0.5, floor["head"] + floor["row"],
                                            f"{tag}: the table shows its header and one whole row")
                    for desc in targets:
                        row = w.related_row(desc)
                        # A wheel or a focus move brings it in (down the list, then back up); then it must be whole and on top.
                        w.scroll_into_view(row)
                        self.assert_row_on_top_in_its_table(w, f"{tag} {desc}", row)
                    w.screen.finish()

    def test_rl11b_related_rows_that_change_without_a_resize_are_measured_again(self):
        """RL-11b (integration review F05): inside the Reading Workspace at a fixed window size the Related rows change
        while nothing is resized - Previous Study from a patient with no other study to one with three (0 -> 3), then a
        Modality filter that matches none (3 -> the one-line notice, which is taller than a row), then all again (0 -> 3).
        After each change the table's floor follows what it now shows: its header and one whole row (the notice included,
        so the reader can read it), and a click on a row lands on that row."""
        for size in [(1366, 768), (1920, 1080), (900, 1200)]:
            name = f"{size[0]}x{size[1]}"
            with self.subTest(size=name):
                w = self.open_reading(size, target="SYN RL OTHER PATIENT")
                tag = f"RL-11b {name}"
                harness.expect(w.related_table).to_contain_text("관련 검사 없음")
                w.page.get_by_role("button", name="Previous Study", exact=True).click()
                harness.until(lambda: w.related_row(NOREPORT_DESC).count() == 1, 10, f"{tag}: the other study's related rows")
                for step, choose, shown in (("filtered to none", "Unspecified", "조건에 맞는 관련 검사 없음"),
                                            ("all again", "All Modalities", NOREPORT_DESC)):
                    w.select.select_option(label=choose)
                    harness.expect(w.related_table).to_contain_text(shown)
                    w.page.wait_for_timeout(300)
                    floor = self.table_floor(w)
                    measure(f"{tag} {step}", floor=floor)
                    self.assertGreaterEqual(floor["box"] + 0.5, floor["head"] + floor["row"],
                                            f"{tag} {step}: the table shows its header and one whole row")
                row = w.related_row(NOREPORT_DESC)
                w.scroll_into_view(row)
                self.assert_row_on_top_in_its_table(w, f"{tag} {NOREPORT_DESC}", row)
                w.screen.finish()

    def assert_row_on_top_in_its_table(self, w, tag, row):
        """In the Reading Workspace the Related table is wider than its column and scrolls sideways, so a row is judged
        inside the table's own visible box: its full height below the sticky header and above the box's bottom, every
        sampled point of its visible width on the row itself (nothing painted over it), and a click there reaches it."""
        seen = js(w.page, """
          const r = arg, grid = r.closest('table').parentElement, g = grid.getBoundingClientRect(), b = r.getBoundingClientRect();
          const head = r.closest('table').tHead.getBoundingClientRect();
          const left = Math.max(b.left, g.left + grid.clientLeft), right = Math.min(b.right, g.left + grid.clientLeft + grid.clientWidth);
          const top = g.top + grid.clientTop, bottom = top + grid.clientHeight, covered = [];
          for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.1, 0.5, 0.9]) {
            const x = left + (right - left) * fx, y = b.top + b.height * fy;
            if (!within(document.elementFromPoint(x, y), r)) covered.push([x, y]); }
          return {row: [b.left, b.top, b.right, b.bottom], head: head.bottom, box: [top, bottom], width: right - left, covered,
                  centre: [(left + right) / 2, (b.top + b.bottom) / 2]};""", row.element_handle())
        measure(tag, seen=seen)
        self.assertGreaterEqual(seen["row"][1] + 0.5, seen["head"], f"{tag}: the row starts below the table header")
        self.assertLessEqual(seen["row"][3], seen["box"][1] + 0.5, f"{tag}: the row ends inside the table's box")
        self.assertGreater(seen["width"], 40, f"{tag}: the row is visible across the table's width")
        self.assertEqual([], seen["covered"], f"{tag}: points of the row under another element")
        handle = row.element_handle()
        handle.evaluate("r => { r.landed = null; document.addEventListener('click', e => { r.landed = r.contains(e.target); }, {capture: true, once: true}); }")
        w.page.mouse.click(*seen["centre"])
        self.assertTrue(handle.evaluate("r => r.landed"), f"{tag}: a click at the row reached the row")
        harness.until(lambda: "열람 중" in row.get_by_role("cell").first.inner_text(), 5, f"{tag} row opened")

    # ── RL-12 (S7-U5 S4 GEO) ────────────────────────────────────────────────────────────────────────────────────────────
    # Image Findings open in the Reading Workspace. After fix-up D raised the table floor, the hosted fonts put the report's
    # button row at 736-764 of a 768px window and the panel, fixed above a 12px inset with no room left below the report's
    # fields, sat on Approve/Save/Prelim/Dictate. `long` reads a study whose description wraps the report's target line, so
    # the row starts below the window and is brought up to its bottom edge, as a reader's wheel over the column does: the
    # hosted position, whatever this machine's fonts. 1280x720 reaches it without that.
    LONG_DESC = " ".join(["SYN RL CURRENT CT CHEST ABDOMEN PELVIS WITH CONTRAST ARTERIAL AND PORTAL VENOUS PHASE FOLLOW UP"] * 2)
    FINDINGS_CASES = [((1366, 768), False), ((1366, 768), True), ((1280, 720), False), ((1920, 1080), False),
                      ((900, 1200), False), ((768, 1024), False)]
    REPORT_BUTTONS = ("Approve", "Save", "Prelim", "Dictate")

    def test_rl12_image_findings_never_covers_the_report_buttons_or_the_first_related_row(self):
        long_rows = [harness.row("2.25.7001", PID, date="20261005", rs="W", modality="CT", desc=self.LONG_DESC)] + rows()[1:]
        for size, long in self.FINDINGS_CASES:
            name = f"{size[0]}x{size[1]}" + (" long description" if long else "")
            with self.subTest(case=name):
                w = self.open_reading(size, long_rows, self.LONG_DESC) if long else self.open_reading(size)
                page, tag = w.page, f"RL-12 {name}"
                toggle = page.get_by_role("button", name="Image Findings", exact=True)
                toggle.click()
                panel = page.get_by_role("region", name="Image Findings", exact=True)
                harness.expect(panel).to_be_visible()
                buttons = [(label, page.get_by_role("button", name=label, exact=True)) for label in self.REPORT_BUTTONS]
                # What a wheel over the column does when the row is below the window (the stacked portrait layout too).
                w.scroll_into_view(buttons[-1][1])
                page.wait_for_timeout(150)
                w.assert_no_document_scroll(f"{tag} buttons in view")
                box = w.visible(panel)["box"]
                row = w.related_table.get_by_role("row").nth(1)
                measure(tag, panel=box, toggle=w.visible(toggle)["box"], row=w.visible(row)["box"],
                        buttons={label: w.visible(button)["box"] for label, button in buttons})
                apart = lambda b: b[2] <= box[0] + 0.5 or b[0] >= box[2] - 0.5 or b[3] <= box[1] + 0.5 or b[1] >= box[3] - 0.5
                # The panel itself still shows its title line and Close, so docking did not shrink it out of use.
                self.assertTrue(w.pointable(panel.get_by_role("button", name="Close Image Findings", exact=True)),
                                f"{tag}: Close Image Findings reachable")
                for label, control in buttons:
                    seen = w.visible(control)
                    self.assertTrue(apart(seen["box"]), f"{tag}: the panel {box} lies over {label} {seen['box']}")
                    self.assertGreaterEqual(seen["ratio"], 0.999, f"{tag}: {label} whole in the window")
                    self.assertEqual([], w.covered_points(control), f"{tag}: points of {label} under another element")
                # The toggle scrolls with its column (out of view once the button row is brought up); the panel is
                # never what hides it.
                self.assertTrue(apart(w.visible(toggle)["box"]), f"{tag}: the panel lies over its own toggle")
                self.assertTrue(apart(w.visible(row)["box"]), f"{tag}: the panel lies over the first Related row")
                self.assert_row_on_top_in_its_table(w, f"{tag} first Related row", row)
                w.screen.finish()


# ── RelatedLayoutEquivalence (R-EQ; local record, not in CI) ────────────────────────────────────────────────────────
BASE_SHA = "0856c1bda1b4a66a5abf59467f4926b7e75c8d78"   # implementation base B (S7-AUDIT-STORE merge)
BASE_MAIN_LF_SHA256 = "e84b8aad22f70bb1f7044e25351018ec3d6f9f55beb87ae8fb7149f6b8566223"  # main.html at B, from git show
REL_MAIN = "worklist-v0/hpacs-lite/main.html"
EQ_LANDSCAPE = [(1600, 1050), (1366, 768), (1920, 1080), (1280, 800), (1024, 768)]
EQ_PORTRAIT = [(900, 1400), (900, 1200), (768, 1024)]
EQ_REPORT_WINDOW = [(900, 600), (900, 700)]
# RL-06 exception (D383): where the portrait Related panel sits at its 286px minimum, its inside is re-divided so the
# selected row is whole and on top (RL-10). The table area keeps its header and one row (68px instead of 66), the list
# holds its fixed rows and that table (164px instead of 150), and the prior report pane gives the 14px (floor 116px instead
# of 130). These landmarks inside the panel move; the panel itself and everything outside it must stay as on the base.
EQ_EXCEPTION_SIZES = {f"{w}x{h}" for w, h in PORTRAIT_MIN}
EQ_EXCEPTION = {"Related table": "table area 66 -> 68px and list 150 -> 164px (header + one whole row below the fixed rows)",
                "separator": "list 150 -> 164px: the separator sits 14px lower",
                "Related Report": "the prior report pane starts 14px lower (floor 130 -> 116px)",
                "first body text line": "the prior report pane starts 14px lower (floor 130 -> 116px)"}


class _Driver:
    """open_state() needs a browser and addCleanup; a child process measuring one page has no TestCase to run in."""
    boot, open_state = Base.boot, Base.open_state

    def __init__(self, browser):
        self.browser, self.cleanups = browser, []

    def addCleanup(self, function, *args):
        self.cleanups.append((function, args))

    def close(self):
        while self.cleanups:
            function, args = self.cleanups.pop()
            function(*args)


def snapshot():
    """Child process: landmark rectangles of this process's page (harness.MAIN) for every equivalence size."""
    playwright = harness.sync_playwright().start()
    browser = playwright.chromium.launch()
    out = {"page": str(harness.MAIN), "sizes": {}}
    try:
        for size in EQ_LANDSCAPE + EQ_PORTRAIT + EQ_REPORT_WINDOW:
            for state in ("unselected", "shown"):
                driver = _Driver(browser)
                try:
                    w = driver.open_state(state, size=size)
                    out["sizes"][f"{size[0]}x{size[1]} {state}"] = landmarks(w)
                finally:
                    driver.close()
    finally:
        browser.close()
        playwright.stop()
    print("RL-SNAPSHOT " + json.dumps(out, ensure_ascii=False))


def landmarks(w):
    page = w.page
    names = {
        "Related Exam title": w.title, "Modality select": w.select, "Related table": w.related_table,
        "Related Report": w.report_head, "separator": w.separator,
        "Reading Template search": page.get_by_role("searchbox", name="상용구 검색", exact=True),
        "Show All": page.get_by_role("button", name="Show All", exact=True),
        "Clinical Info heading": page.get_by_role("heading", name=re.compile(r"^Clinical Info")),
        "Copy Patient ID": page.get_by_role("button", name="Copy Patient ID", exact=True),
        "Thumbnail tab": page.get_by_text("Thumbnail", exact=True),
        "Clinical Context heading": page.get_by_role("heading", name="Clinical Context", exact=True),
        # The report window's lower edge: the landmarks above sit at its top and would not show a shorter window.
        "Report window separator": page.get_by_role("separator", name="드래그하여 상단 패널 높이 조절", exact=True),
        # The panel's own box: the RL-06 exception re-divides its inside only.
        "Related panel": w.panel,
    }
    column = w.clinical.bounding_box()
    col = [column["x"], column["y"], column["x"] + column["width"], column["y"] + column["height"]]
    result = {"clinical column": col}
    for name, locator in names.items():
        if not locator.count() or not locator.first.is_visible():
            result[name] = None
            continue
        seen = w.visible(locator.first)
        visible = seen["rect"]
        if name in ("Clinical Info heading", "Copy Patient ID", "Clinical Context heading"):
            visible = [max(visible[0], col[0]), max(visible[1], col[1]), min(visible[2], col[2]), min(visible[3], col[3])]
        # Nothing visible is one value, whatever corner an empty rectangle reports.
        result[name] = {"box": seen["box"], "visible": visible if visible[2] > visible[0] and visible[3] > visible[1] else None}
    line = w.first_line()
    result["first body text line"] = line and {"text": line["text"], "line": line["line"], "cut": line["cut"]}
    return result


def run_snapshot(page_path, assets_sha=None):
    """Landmarks of `page_path`, or of this process's own page (the override, if one was given, else the shipped page).
    `assets_sha`: the commit whose scripts and styles the page runs with (a fixed-commit page runs with its own files)."""
    env = {**os.environ}
    env.pop("KIN_MULTI_INSTITUTION_ASSETS_SHA", None)
    if page_path:
        env["KIN_MULTI_INSTITUTION_MAIN"] = str(page_path)
    if assets_sha:
        env["KIN_MULTI_INSTITUTION_ASSETS_SHA"] = assets_sha
    child = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()), "--layout-snapshot"], capture_output=True,
                           text=True, encoding="utf-8", env=env, timeout=1500)
    lines = [ln for ln in child.stdout.splitlines() if ln.startswith("RL-SNAPSHOT ")]
    if child.returncode != 0 or len(lines) != 1:
        raise AssertionError(f"snapshot of {page_path or 'this page'} failed (exit {child.returncode}): {child.stderr[-2000:]}")
    return json.loads(lines[0][len("RL-SNAPSHOT "):])


class RelatedLayoutEquivalence(unittest.TestCase):
    def test_rl06_rl08_layout_equal_to_the_base_where_the_rules_do_not_apply(self):
        from report_actions_dom_test import fixed_file   # the fixed-commit reader shared by the DOM tests
        base_text = fixed_file(BASE_SHA, REL_MAIN, BASE_MAIN_LF_SHA256)
        with tempfile.TemporaryDirectory() as folder:
            base_page = Path(folder) / "main.html"
            base_page.write_text(base_text, encoding="utf-8", newline="\n")
            base = run_snapshot(base_page, BASE_SHA)
        cand = run_snapshot(None)
        differences, excepted = [], []
        for key, landmarks_b in base["sizes"].items():
            size = key.split()[0]
            landmarks_s = cand["sizes"][key]
            for name, b in landmarks_b.items():
                s = landmarks_s.get(name)
                if size in ("900x600", "900x700") and name not in ("Thumbnail tab", "Clinical Info heading", "Reading Template search",
                                                                   "Show All", "Report window separator"):
                    continue   # RL-08: only the report window at the short sizes
                found = (differences if size not in EQ_EXCEPTION_SIZES or name not in EQ_EXCEPTION else excepted)
                if (b is None) != (s is None):
                    found.append([key, name, b, s])
                    continue
                if b is None:
                    continue
                pairs = [(b, s)] if isinstance(b, list) else [(b[k], s[k]) for k in b if k != "text"]
                for x, y in pairs:
                    if x is None or y is None:
                        if x != y:
                            found.append([key, name, b, s])
                        continue
                    if any(abs(p - q) > 0.5 for p, q in zip(x, y)):
                        found.append([key, name, b, s])
                        break
        measure("RL-06/RL-08", compared=sorted(base["sizes"]), differences=differences,
                excepted=[[k, n, EQ_EXCEPTION[n], b, s] for k, n, b, s in excepted])
        self.assertEqual([], differences, "RL-06/RL-08 layout differs from the base where nothing should change")


if __name__ == "__main__":
    if sys.argv[1:] == ["--layout-snapshot"]:
        snapshot()
    else:
        unittest.main()
