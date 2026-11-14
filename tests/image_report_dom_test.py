# coding: utf-8
"""Image Report (worklist-v0/hpacs-lite/image-report.js) on the delivered split page.

The delivered page (main.html, its bundle and every shipped asset) against the synthetic origin of report_flow_dom_test;
no stack, no product file is modified. DrawingSite adds the draft's drawing rules of the server (attach / remove ride the
draft write; a commit binds the draft's drawings to the version) and the reads the window uses.

  - the entry is `Image Report` next to Pop Out in the editor title row; the window has the backgrounds, tools, colors,
    Undo, Clear, Attach to Report and Close; without a key image Saved image is off and says so;
  - drawing: Ellipse / Pen / Line marks by dragging, Undo and Clear on the shown background only; each background keeps its
    own marks; Text places the Text field's words where the drawing is pressed (nothing opens; Enter changes no label);
  - Attach to Report is one draft write with the draft revision, the editor's text and the drawing; the attached drawing is
    listed in the window and under Conclusion; Remove is one draft write too;
  - marks not yet attached come back for the same study, not for another, and not after the report was committed;
  - a report that does not take edits shows the window view only;
  - a saved image is the study's key image (its item, revision and frame go with the drawing).
"""
import base64
import re
import sys
import unittest
import uuid
import zlib
import struct

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect

FIELDS = rf.FIELDS
KEY_ID = "00000000-0000-4000-8000-0000000000a1"


def png(w, h_, shade=0x80):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    raw = b"".join(b"\x00" + bytes([shade]) * (w * 3) for _ in range(h_))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h_, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


class DrawingSite(rf.FlowSite):
    """FlowSite plus the server's drawing rules: the draft's { seed, ids }, the version's list, the reads."""

    def __init__(self, count=2):
        super().__init__(count)
        self.pictures = {}                      # drawing id -> {background, source, png}
        self.draw = {uid: None for uid, _, _ in self.flow}   # the draft's {seed, ids} (None: untouched)
        self.keys = {uid: [] for uid, _, _ in self.flow}     # the study's key images (viewer items)
        self.drawing_writes = []                # bodies of draft writes that carried an attach or a remove
        self.drawings_down = False              # the attached-drawings list read fails (503) while set
        self.frame_reads = []

    @staticmethod
    def effective(draw, head):
        if not draw:
            return list(head)
        kept = [i for i in draw["ids"] if i not in draw["seed"] or i in head]
        return kept + [i for i in head if i not in draw["seed"] and i not in kept]

    def meta(self, drawing_id):
        p = self.pictures[drawing_id]
        return {"id": drawing_id, "background": p["background"], "source": p["source"], "width": 640, "height": 440,
                "sha256": "0" * 64, "author": "syn", "createdAt": "2026-10-03T00:00:00.000Z"}

    GATE = (409, {"code": "REPORT_DRAWINGS_CONFLICT", "message": "SYN drawings gate"})

    def names(self, uid, body, final=None):
        """The server's gate: `drawingIds` is my draft's list by presence and by ids (null or absent: no list), and for a
        commit `expectedEffectiveDrawingIds` is the list the version would hold (absent: only when it would hold none)."""
        stored = self.draw[uid] if self.store[uid]["row"] else None
        named = body.get("drawingIds")
        if (stored is None) != (named is None) or (stored is not None and sorted(named) != sorted(stored["ids"])):
            return False
        shown = body.get("expectedEffectiveDrawingIds")
        return final is None or (not final if shown is None else sorted(shown) == sorted(final))

    def write_of(self, uid, body, account):
        refused = self.preconditions_of(uid, body, account)
        if refused:
            return refused
        st, head = self.store[uid], self.store[uid]["report"].get("drawings", [])
        stored = self.draw[uid] if st["row"] else None
        if not self.names(uid, body):
            return self.GATE
        attach, remove = body.get("drawing"), body.get("removeDrawing")
        drawn, draw = None, stored
        if attach is not None or remove is not None:
            self.drawing_writes.append(body)
            draw = {"seed": list(stored["seed"]), "ids": list(stored["ids"])} if stored else {"seed": list(head), "ids": list(head)}
            shown = self.effective(draw, head)
            if remove is not None:
                if remove not in shown:
                    return 409, {"code": "REPORT_DRAWING_STALE", "message": "SYN stale"}
                draw["ids"].remove(remove)
                if sorted(draw["seed"]) == sorted(draw["ids"]):
                    draw = None   # no change of the head's drawings is stored as none
                drawn = {"removed": remove, "ids": draw["ids"] if draw else None}
            else:
                key = lambda b, s: b if b != "image" else ("image", s and s.get("keyImageId"), s and s.get("frame"))
                same = [i for i in shown if key(self.pictures[i]["background"], self.pictures[i]["source"]) == key(attach["background"], attach.get("source"))]
                if [i for i in same if i != attach.get("replaces")]:
                    return 409, {"code": "REPORT_DRAWING_STALE", "message": "SYN same background"}
                if attach.get("replaces"):
                    draw["ids"].remove(attach["replaces"])
                new = str(uuid.uuid4())
                self.pictures[new] = {"background": attach["background"], "source": attach.get("source"),
                                      "png": attach["png"]}
                draw["ids"].append(new)
                drawn = {"added": new, "ids": draw["ids"], **({"replaced": attach["replaces"]} if attach.get("replaces") else {})}
        empty = all(not body[k] for k in FIELDS)
        if empty and ((drawn is None and not isinstance(body.get("drawingIds"), list)) or (drawn is not None and not draw)):
            status, answer = super().write_of(uid, body, account)
            self.draw[uid] = None
        else:
            st["revs"] += 1
            st["row"] = {**{k: body[k] for k in FIELDS}, "baseVersion": body["baseVersion"],
                         "citations": list(body["citationIds"]), "structured": list(body["structureIds"])}
            self.draw[uid] = draw
            if draw:
                st["row"]["drawings"] = list(draw["ids"])
            status, answer = 200, self.envelope_of(uid, account)
        return status, ({**answer, "drawn": drawn} if drawn is not None else answer)

    def commit_of(self, uid, body, account):
        head = self.store[uid]["report"].get("drawings", [])
        reset = body.get("action") == "reset"
        bound = [] if reset else self.effective(self.draw[uid] if self.store[uid]["row"] else None, head)
        # After the revision and version checks, before anything is written (Reset names no list of the version).
        if (not self.preconditions_of(uid, body, account) and body.get("baseVersion") == self.store[uid]["report"]["version"]
                and not self.names(uid, body, None if reset else bound)):
            return self.GATE
        status, answer = super().commit_of(uid, body, account)
        if status == 200:
            self.store[uid]["report"]["drawings"] = bound
            self.store[uid]["versions"][-1]["drawings"] = [{"id": i} for i in bound]
            self.draw[uid] = None
        return status, answer

    def handle(self, route, request):
        path = request.url.split("?")[0].split("://", 1)[-1].split("/", 1)[-1]
        if request.method == "GET" and re.fullmatch(r"instances/[0-9a-f-]+/frames/\d+/preview", path):
            self.frame_reads.append("/" + path)
            return route.fulfill(status=200, body=png(64, 48, 0x40), content_type="image/png")
        return super().handle(route, request)

    def api(self, route, request, method, path, query):
        found = re.fullmatch(r"/api/studies/([^/]+)/(report/drawings(?:/[^/]+)?|viewer-items)", path)
        if method == "POST" and path == "/api/dicom/lookup":
            return route.fulfill(json={"id": "aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee"})
        ended = re.fullmatch(r"/api/studies/([^/]+)/draft", path)
        if method == "DELETE" and ended and ended.group(1) in self.store:
            # The discard names the list of the draft it ends: the gate, after the revision check.
            account, refused = self.authenticate(request)
            body = request.post_data_json
            if not refused and not self.preconditions_of(ended.group(1), body, account) and not self.names(ended.group(1), body):
                self.discards.append(body)
                return self.answer(route, *self.GATE)
        if not found or found.group(1) not in self.store or method != "GET":
            return super().api(route, request, method, path, query)
        account, refused = self.authenticate(request)
        if refused:
            return self.refuse(route, *refused)
        uid, what = found.groups()
        st = self.store[uid]
        head = st["report"].get("drawings", [])
        if what == "viewer-items":
            return route.fulfill(json={"items": self.keys[uid], "nextCursor": None})
        if what == "report/drawings":
            if self.drawings_down:
                return route.fulfill(status=503, json={"code": "SYN_DOWN", "message": "SYN drawings list down"})
            draw = self.draw[uid] if st["row"] else None
            return route.fulfill(json={"version": st["report"]["version"], "head": [self.meta(i) for i in head],
                                       "draft": {**({"ids": draw["ids"]} if draw else {}),
                                                 "drawings": [self.meta(i) for i in self.effective(draw, head)]} if st["row"] else None,
                                       "draftRevision": self.revision_of(uid)})
        drawing_id = what.rsplit("/", 1)[-1]
        if drawing_id not in self.pictures:
            return route.fulfill(status=404, json={"code": "SYN", "message": "SYN not found"})
        return route.fulfill(json={**self.meta(drawing_id), "png": self.pictures[drawing_id]["png"]})


class ImageReportPage(unittest.TestCase):
    """The Image Report window on the delivered page; only HTTP is synthetic. Browser, page and helpers are the flow suite's."""
    count = 2
    bundle_source = html_source = asset_source = None
    setUpClass = rf.ReportFlowPage.__dict__["setUpClass"]
    tearDownClass = rf.ReportFlowPage.__dict__["tearDownClass"]
    tearDown = rf.ReportFlowPage.tearDown
    open, row, pick, open_study, type = (rf.ReportFlowPage.open, rf.ReportFlowPage.row, rf.ReportFlowPage.pick,
                                         rf.ReportFlowPage.open_study, rf.ReportFlowPage.type)
    selected, wait, settle = rf.ReportFlowPage.selected, rf.ReportFlowPage.wait, rf.ReportFlowPage.settle

    def setUp(self):
        rf.ReportFlowPage.setUp(self)
        self.site = DrawingSite(self.count)

    # ── driving ──
    def open_window(self):
        self.page.locator("#report-image-report").click()
        expect(self.page.locator("#image-report")).to_be_visible()
        self.wait(lambda: "drawings" in " ".join(p for _, p in self.site.calls), "the window reads the attached drawings")
        self.settle()

    def choose(self, label):
        self.page.locator("#image-report label", has_text=re.compile("^\\s*" + re.escape(label) + "$")).locator("input").check()

    def drag(self, x0, y0, x1, y1):
        box = self.page.locator("#image-report-canvas").bounding_box()
        at = lambda fx, fy: (box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
        self.page.mouse.move(*at(x0, y0))
        self.page.mouse.down()
        for step in range(1, 6):
            self.page.mouse.move(*at(x0 + (x1 - x0) * step / 5, y0 + (y1 - y0) * step / 5))
        self.page.mouse.up()

    def press(self, x, y):
        box = self.page.locator("#image-report-canvas").bounding_box()
        self.page.mouse.click(box["x"] + box["width"] * x, box["y"] + box["height"] * y)

    def marks(self):
        label = self.page.locator("#image-report-canvas").get_attribute("aria-label") or ""
        found = re.search(r"(\d+) marks", label)
        return int(found.group(1)) if found else -1

    def attach(self):
        before = len(self.site.drawing_writes)
        self.page.locator("#image-report-attach").click()
        self.wait(lambda: len(self.site.drawing_writes) > before, "the attach is sent")
        self.wait(lambda: "Attached to the report draft" in (self.page.locator("#image-report-status").text_content() or ""), "the attach is shown")
        return self.site.drawing_writes[-1]

    # ── the server's state before the page opens the study ──
    def drawing(self):
        new = str(uuid.uuid4())
        self.site.pictures[new] = {"background": "breast", "source": None, "png": base64.b64encode(png(64, 48)).decode()}
        return new

    def stored(self, text="", ids=None, head=(), rs="W"):
        """A saved version holding the drawings `head` (rs T or A; none for W), and my draft: its text and its own
        drawing list `ids` (None: no list)."""
        st = self.site.store[h.UID]
        if rs != "W":
            texts = {**{k: "" for k in FIELDS}, "findings": "SYN saved"}
            st["report"] = {"version": 1, "rs": rs, **texts, "drawings": list(head)}
            st["versions"] = [{"version": 1, "action": "approve" if rs == "A" else "save", "author": "syn-earlier", "reason": None,
                               **texts, "drawings": [{"id": i} for i in head]}]
        st["revs"] = 1
        st["row"] = {**{k: "" for k in FIELDS}, "findings": text, "baseVersion": st["report"]["version"], "citations": [], "structured": []}
        if ids is not None:
            self.site.draw[h.UID] = {"seed": list(head), "ids": list(ids)}
            st["row"]["drawings"] = list(ids)
        return st

    def clear(self):
        self.page.evaluate("() => { const more = document.querySelector('#report-more'); if (more) more.open = true; }")
        self.page.locator("#b-clear").click()

    # ── cases ──
    def test_entry_and_window_controls(self):
        self.open()
        self.open_study(h.PATIENT)
        head = self.page.locator(".report-editor-head")
        button = head.locator("#report-image-report")
        expect(button).to_be_visible()
        expect(button).to_have_text("Image Report")
        # Right after Pop Out in the title row.
        self.assertEqual(self.page.evaluate("() => document.querySelector('#report-popout').nextElementSibling?.id"), "report-image-report")
        self.open_window()
        dialog = self.page.locator("#image-report")
        expect(dialog.locator("h2")).to_have_text("Image Report")
        expect(dialog.locator(".ir-study")).to_contain_text(h.PATIENT)
        for label in ("Breast diagram", "Thyroid diagram", "Saved image (this study)", "Pen", "Line", "Ellipse", "Text",
                      "Black", "Red", "Blue", "Green", "Yellow"):
            expect(dialog.locator("label", has_text=label).first).to_be_visible()
        for name in ("Undo", "Clear", "Attach to Report", "Close"):
            expect(dialog.get_by_role("button", name=name)).to_be_visible()
        expect(dialog.get_by_role("textbox", name="Text")).to_be_visible()
        # No key image in this study: Saved image is off and says so.
        expect(dialog.locator("label", has_text="Saved image (this study)").locator("input")).to_be_disabled()
        expect(dialog).to_contain_text("이 검사에 저장된 영상이 없습니다")
        expect(self.page.locator("#image-report-attached figure")).to_have_count(0)
        self.page.keyboard.press("Escape")
        expect(dialog).to_be_hidden()

    def test_marks_undo_clear_and_each_background_keeps_its_own(self):
        self.open()
        self.open_study(h.PATIENT)
        self.open_window()
        self.choose("Breast diagram")
        self.choose("Ellipse")
        self.drag(0.15, 0.6, 0.3, 0.75)
        self.assertEqual(self.marks(), 1)
        self.page.locator("#image-report-undo").click()
        self.assertEqual(self.marks(), 0)
        self.drag(0.15, 0.3, 0.25, 0.4)
        self.choose("Pen")
        self.drag(0.6, 0.3, 0.7, 0.5)
        self.assertEqual(self.marks(), 2)
        self.choose("Thyroid diagram")
        self.assertEqual(self.marks(), 0, "the thyroid diagram has no marks of the breast diagram")
        self.choose("Line")
        self.drag(0.4, 0.4, 0.5, 0.6)
        self.assertEqual(self.marks(), 1)
        self.page.locator("#image-report-clear").click()
        self.assertEqual(self.marks(), 0)
        self.choose("Breast diagram")
        self.assertEqual(self.marks(), 2, "the breast diagram kept its own marks")

    def test_text_places_the_fields_words_and_enter_changes_no_label(self):
        self.open()
        self.open_study(h.PATIENT)
        self.open_window()
        self.choose("Red")
        self.choose("Ellipse")
        self.drag(0.15, 0.3, 0.25, 0.4)
        self.choose("Text")
        self.press(0.3, 0.35)
        self.assertEqual(self.marks(), 1, "an empty Text field places nothing")
        expect(self.page.locator("#image-report-status")).to_contain_text("Text")
        field = self.page.locator("#image-report-text")
        field.fill("1.2 cm mass")
        self.press(0.3, 0.35)
        self.assertEqual(self.marks(), 2)
        expect(self.page.locator("#image-report input[type=text]:not(#image-report-text)")).to_have_count(0)
        field.fill("Mass 1.5 cm")
        field.press("Enter")
        self.assertEqual(self.marks(), 2, "Enter only ends typing")
        body = self.attach()
        texts = [s.get("text") for s in body["drawing"]["strokes"] if s["tool"] == "text"]
        self.assertEqual(texts, ["1.2 cm mass"], "the placed label still reads what was placed")
        self.assertEqual({s["color"] for s in body["drawing"]["strokes"]}, {"#e0242b"})

    def test_attach_and_remove_are_draft_writes_and_are_listed(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN typed findings")
        self.open_window()
        self.choose("Ellipse")
        self.drag(0.15, 0.3, 0.25, 0.4)
        body = self.attach()
        self.assertEqual(body["expectedRevision"], self.site.revision_of(h.UID).rsplit(":", 1)[0] + ":" + str(self.site.store[h.UID]["revs"] - 1))
        self.assertEqual(body["findings"], "SYN typed findings", "the editor's text goes with the drawing")
        self.assertIn("drawingIds", body)
        self.assertIsNone(body["drawingIds"], "no drawing yet: the write names 'no list' (null), not an empty list")
        self.assertEqual(body["drawing"]["background"], "breast")
        self.assertNotIn("source", body["drawing"])
        self.assertTrue(base64.b64decode(body["drawing"]["png"]).startswith(b"\x89PNG"))
        for stroke in body["drawing"]["strokes"]:
            self.assertTrue(all(0 <= v <= 1 for p in stroke["points"] for v in p))
        expect(self.page.locator("#image-report-attached figure")).to_have_count(1)
        expect(self.page.locator("#image-report").locator("strong", has_text="Attached to this report: 1")).to_be_visible()
        expect(self.page.locator("#report-image-attached")).to_be_visible()
        expect(self.page.locator("#report-image-attached figure")).to_have_count(1)
        # Attach the same diagram again: it replaces the attached one (named in the request).
        self.drag(0.6, 0.3, 0.7, 0.4)
        first = self.site.store[h.UID]["row"]["drawings"][0]
        again = self.attach()
        self.assertEqual(again["drawing"].get("replaces"), first)
        self.assertEqual(again["drawingIds"], [first])
        expect(self.page.locator("#image-report-attached figure")).to_have_count(1)
        # Remove.
        current = self.site.store[h.UID]["row"]["drawings"][0]
        before = len(self.site.drawing_writes)
        self.page.locator(f"#image-report-attached button[data-drawing='{current}']").click()
        self.wait(lambda: len(self.site.drawing_writes) > before, "the remove is sent")
        self.assertEqual(self.site.drawing_writes[-1]["removeDrawing"], current)
        expect(self.page.locator("#image-report-attached figure")).to_have_count(0)
        self.page.locator("#image-report-close").click()
        self.wait(lambda: self.page.locator("#report-image-attached").is_hidden(), "the editor strip follows")

    def test_marks_come_back_for_the_same_study_only_and_not_after_a_commit(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN text")
        self.open_window()
        self.choose("Ellipse")
        self.drag(0.15, 0.3, 0.25, 0.4)
        self.page.locator("#image-report-close").click()
        self.open_window()
        self.assertEqual(self.marks(), 1, "closed and opened again: the marks are still there")
        self.page.locator("#image-report-close").click()
        self.open_study(h.PATIENT_B)
        self.open_window()
        expect(self.page.locator("#image-report .ir-study")).to_contain_text(h.PATIENT_B)
        self.assertEqual(self.marks(), 0, "another study shows none of them")
        self.page.locator("#image-report-close").click()
        self.open_study(h.PATIENT)
        self.open_window()
        self.assertEqual(self.marks(), 1)
        self.page.locator("#image-report-close").click()
        self.page.locator("#b-save").click()
        self.wait(lambda: self.site.flow_commits, "the report is saved")
        self.wait(lambda: self.site.store[h.UID]["report"]["version"] == 1, "a version is made")
        self.settle(300)
        self.open_window()
        self.assertEqual(self.marks(), 0, "after a commit the old marks are not brought back")

    def test_a_report_that_takes_no_edits_shows_the_window_view_only(self):
        self.site.unverified.add(h.UID)
        self.open()
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, "the study opens")
        self.open_window()
        expect(self.page.locator("#image-report-readonly")).to_contain_text("View only")
        expect(self.page.locator("#image-report-attach")).to_be_disabled()
        self.drag(0.15, 0.3, 0.25, 0.4)
        self.assertEqual(self.marks(), 0)
        self.assertEqual(self.site.drawing_writes, [])

    def test_a_saved_image_is_the_studys_key_image_and_its_frame_goes_with_the_drawing(self):
        self.site.keys[h.UID] = [{"id": KEY_ID, "studyUid": h.UID, "revision": 2, "hidden": False,
                                  "item": {"kind": "key", "seriesUid": "1.2.3.4", "sopUid": "1.2.3.4.5", "frame": 3, "title": "SYN key"}}]
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN text")
        self.open_window()
        saved = self.page.locator("#image-report label", has_text="Saved image (this study)").locator("input")
        expect(saved).to_be_enabled()
        saved.check()
        self.wait(lambda: self.site.frame_reads, "the key image frame is read")
        self.assertTrue(self.site.frame_reads[-1].endswith("/frames/2/preview"), "frame 3 is index 2")
        self.settle(200)
        self.choose("Line")
        self.drag(0.9, 0.1, 0.5, 0.8)
        self.assertEqual(self.marks(), 1)
        body = self.attach()
        self.assertEqual(body["drawing"]["background"], "image")
        self.assertEqual(body["drawing"]["source"], {"keyImageId": KEY_ID, "keyImageRevision": 2, "frame": 3})
        self.choose("Thyroid diagram")
        self.assertEqual(self.marks(), 0, "the line on the saved image is not on the diagram")

    def test_discard_and_clear_take_the_drawings_with_the_draft(self):
        self.open()
        self.open_study(h.PATIENT)
        self.open_window()
        self.choose("Ellipse")
        self.drag(0.15, 0.3, 0.25, 0.4)
        self.attach()   # no text typed: the drawing alone is the draft
        self.page.locator("#image-report-close").click()
        expect(self.page.locator("#report-image-attached figure")).to_have_count(1)
        # Clear of a draft that holds a drawing ends the whole draft through the draft discard (one question).
        self.page.evaluate("() => { const more = document.querySelector('#report-more'); if (more) more.open = true; }")
        before = len(self.site.discards)
        self.page.locator("#b-clear").click()
        self.wait(lambda: len(self.site.discards) > before, "the draft is discarded")
        self.assertTrue(any("그림" in message for message in self.dialogs), self.dialogs)
        self.assertIsNone(self.site.store[h.UID]["row"])
        self.wait(lambda: self.page.locator("#report-image-attached").is_hidden(), "the editor strip follows the discard")
        # Discard Draft of a draft with text and a drawing: the strip follows too.
        self.type("SYN text")
        self.open_window()
        self.choose("Thyroid diagram")
        self.choose("Pen")
        self.drag(0.4, 0.4, 0.5, 0.5)
        self.attach()
        self.page.locator("#image-report-close").click()
        expect(self.page.locator("#report-image-attached figure")).to_have_count(1)
        self.page.evaluate("() => discardDraft({ asked: true })")
        self.wait(lambda: self.site.store[h.UID]["row"] is None, "the draft is discarded")
        self.wait(lambda: self.page.locator("#report-image-attached").is_hidden(), "the editor strip follows the discard")

    def test_marks_drawn_before_a_draft_end_with_that_draft(self):
        self.open()
        self.open_study(h.PATIENT)
        self.open_window()
        self.choose("Ellipse")
        self.drag(0.15, 0.3, 0.25, 0.4)
        self.page.locator("#image-report-close").click()
        writes = len(self.site.flow_puts)
        self.type("SYN text after the marks")
        self.page.clock.run_for(30000)
        self.wait(lambda: len(self.site.flow_puts) > writes, "the draft is saved")
        self.wait(lambda: self.site.store[h.UID]["row"] is not None, "a draft exists")
        self.page.evaluate("() => discardDraft({ asked: true })")
        self.wait(lambda: self.site.store[h.UID]["row"] is None, "the draft is discarded")
        self.settle(200)
        self.open_window()
        self.assertEqual(self.marks(), 0, "the marks went with the draft the person discarded")

    def test_clear_ends_a_draft_that_only_removes_a_saved_drawing(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN saved with a drawing")
        self.open_window()
        self.choose("Ellipse")
        self.drag(0.15, 0.3, 0.25, 0.4)
        self.attach()
        self.page.locator("#image-report-close").click()
        self.page.locator("#b-save").click()
        self.wait(lambda: self.site.store[h.UID]["report"]["version"] == 1, "a version holds the drawing")
        saved = self.site.store[h.UID]["report"]["drawings"]
        self.assertEqual(len(saved), 1)
        self.settle(300)
        self.open_window()
        expect(self.page.locator("#image-report-attached figure")).to_have_count(1)
        before = len(self.site.drawing_writes)
        self.page.locator(f"#image-report-attached button[data-drawing='{saved[0]}']").click()
        self.wait(lambda: len(self.site.drawing_writes) > before, "the remove is sent")
        self.wait(lambda: (self.site.store[h.UID]["row"] or {}).get("drawings") == [], "the removal is the draft")
        self.page.locator("#image-report-close").click()
        discards = len(self.site.discards)
        self.page.evaluate("() => { const more = document.querySelector('#report-more'); if (more) more.open = true; }")
        self.page.locator("#b-clear").click()
        self.wait(lambda: len(self.site.discards) > discards, "Clear discards the removal draft")
        self.assertIsNone(self.site.store[h.UID]["row"])
        self.assertEqual(self.site.store[h.UID]["report"]["drawings"], saved, "the saved version keeps its drawing")

    def test_a_draft_kept_for_its_drawing_list_is_still_a_draft_after_its_text_is_deleted(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN saved with a drawing")
        self.open_window()
        self.choose("Ellipse")
        self.drag(0.15, 0.3, 0.25, 0.4)
        self.attach()
        self.page.locator("#image-report-close").click()
        self.page.locator("#b-save").click()
        self.wait(lambda: self.site.store[h.UID]["report"]["version"] == 1, "a version holds the drawing")
        saved = self.site.store[h.UID]["report"]["drawings"]
        self.settle(300)
        self.open_window()
        before = len(self.site.drawing_writes)
        self.page.locator(f"#image-report-attached button[data-drawing='{saved[0]}']").click()
        self.wait(lambda: len(self.site.drawing_writes) > before, "the remove is sent")
        st = self.site.store[h.UID]
        self.wait(lambda: (st["row"] or {}).get("drawings") == [], "the removal is the draft")
        self.page.locator("#image-report-close").click()
        self.settle(200)
        # The person deletes the text by hand (not Clear); the save names the draft's empty list, so the server keeps the draft.
        self.type("")
        state = self.page.evaluate("""async () => {
          const uid = selectedUid, outcome = await saveReportDraft(uid);
          return { outcome, draft: appState[uid].draft ?? null };
        }""")
        self.assertEqual(state["outcome"], "saved")
        body = self.site.flow_puts[-1][1]
        self.assertEqual((body["findings"], body.get("drawingIds")), ("", []))
        self.assertEqual((st["row"]["findings"], st["row"]["drawings"]), ("", []), "the removal draft stays without text")
        self.assertIsNotNone(state["draft"], "the page took the draft the server keeps for no draft")
        # So Clear still ends it: the removal is undone, the saved version keeps its drawing.
        discards = len(self.site.discards)
        self.page.evaluate("() => { const more = document.querySelector('#report-more'); if (more) more.open = true; }")
        self.page.locator("#b-clear").click()
        self.wait(lambda: len(self.site.discards) > discards, "Clear discards the draft kept for its drawing list")
        self.assertIsNone(st["row"])
        self.assertEqual(st["report"]["drawings"], saved, "the saved version keeps its drawing")

    def test_log_out_does_not_save_the_text_onto_a_draft_that_lost_the_removal(self):
        # A saved version holds one drawing; my draft removes it (an empty list of its own) and holds the saved text.
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN saved with a drawing")
        self.open_window()
        self.choose("Ellipse")
        self.drag(0.15, 0.3, 0.25, 0.4)
        self.attach()
        self.page.locator("#image-report-close").click()
        self.page.locator("#b-save").click()
        self.wait(lambda: self.site.store[h.UID]["report"]["version"] == 1, "a version holds the drawing")
        saved = self.site.store[h.UID]["report"]["drawings"]
        self.settle(300)
        self.open_window()
        before = len(self.site.drawing_writes)
        self.page.locator(f"#image-report-attached button[data-drawing='{saved[0]}']").click()
        self.wait(lambda: len(self.site.drawing_writes) > before, "the remove is sent")
        st = self.site.store[h.UID]
        self.wait(lambda: (st["row"] or {}).get("drawings") == [], "the removal is the draft")
        self.page.locator("#image-report-close").click()
        self.settle(200)
        shown = dict(st["row"])
        # I type on; that text is not saved yet.
        self.type("SYN saved with a drawing, and more")
        # Meanwhile the draft became the same earlier text without the removal (it was discarded and written again in
        # another window): two revisions on, no drawing list.
        st["revs"] += 2
        st["row"] = {k: v for k, v in shown.items() if k != "drawings"}
        self.site.draw[h.UID] = None
        puts = len(self.site.flow_puts)
        self.page.evaluate("() => document.querySelector('#logout').click()")
        expect(self.page.locator("dialog.kin-logout h2")).to_have_text("Draft Not Saved")
        self.settle(300)
        sent = [body for uid, body in self.site.flow_puts[puts:] if uid == h.UID]
        # One preservation write, naming the empty list on the revision this page stood on; after the read, nothing more.
        self.assertEqual([body.get("drawingIds") for body in sent], [[]], "a write went out on the draft that lost the removal")
        self.assertEqual(st["row"]["findings"], "SYN saved with a drawing", "the server draft was written over")
        self.assertNotIn("drawings", st["row"])
        self.assertEqual(self.site.logouts, [], "the log out went on")
        self.assertEqual(self.page.locator("#findings").input_value(), "SYN saved with a drawing, and more")

    # ── the drawings gate: a version is made only from the drawings this page showed ──
    def test_a_save_after_another_window_attached_a_drawing_waits_for_the_reader(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN text")
        self.assertEqual(self.page.evaluate("() => saveReportDraft(selectedUid)"), "saved")
        st = self.site.store[h.UID]
        # Another window of mine attaches a drawing: one revision on, the same text, a list this page has not seen.
        other = self.drawing()
        st["revs"] += 1
        st["row"]["drawings"] = [other]
        self.site.draw[h.UID] = {"seed": [], "ids": [other]}
        self.page.locator("#b-save").click()
        expect(self.page.locator("#draftmsg")).to_contain_text("서버의 초안이 이 화면과 다릅니다")
        self.settle(300)
        self.assertEqual(len(self.site.flow_commits), 1, "the save was sent again on the draft with the unseen drawing")
        self.assertEqual(st["report"]["version"], 0, "a version was made with a drawing this page did not show")
        # Before the reader chooses, the drawing is shown where attached drawings are; the notice says what the choice keeps.
        expect(self.page.locator("#report-image-attached figure")).to_have_count(1)
        expect(self.page.locator("#draftmsg")).to_contain_text("Keep This Text는 글만 남깁니다")
        self.page.locator("#b-draft-keep").click()
        self.settle(300)
        self.page.locator("#b-save").click()
        self.wait(lambda: st["report"]["version"] == 1, "the save goes through after the choice")
        body = self.site.flow_commits[-1][1]
        self.assertEqual((body.get("drawingIds"), body.get("expectedEffectiveDrawingIds")), ([other], [other]))
        self.assertEqual(st["report"]["drawings"], [other])

    def test_a_commit_while_the_drawings_could_not_be_read_is_refused_and_recovered_on_the_same_notice(self):
        held = self.drawing()
        st = self.stored(text="SYN text with a drawing", ids=[held])
        self.site.drawings_down = True
        self.open()
        self.open_study(h.PATIENT)
        self.settle(300)
        # The page knows the draft (its text is in the editor) and could not read the attached drawings: none is shown.
        expect(self.page.locator("#report-image-attached")).to_be_hidden()
        self.assertEqual(self.page.evaluate("() => draftClient.lists(selectedUid)?.drawings"), [held])
        self.site.drawings_down = False
        self.page.locator("#b-save").click()
        self.wait(lambda: len(self.site.flow_commits) == 1, "the save is sent")
        first = self.site.flow_commits[0][1]
        # It names the draft's list and no list of the version (none was shown): the server refuses, nothing is made.
        self.assertEqual(first.get("drawingIds"), [held])
        self.assertNotIn("expectedEffectiveDrawingIds", first)
        expect(self.page.locator("#draftmsg")).to_contain_text("판독문에 붙은 그림이 이 화면이 본 것과 다릅니다")
        self.assertEqual(st["report"]["version"], 0, "a version was made from a drawing the page had not shown")
        # The same notice reads the drawings again; with them shown the reader chooses and saves.
        expect(self.page.locator("#report-image-attached figure")).to_have_count(1)
        self.page.locator("#b-draft-keep").click()
        self.settle(300)
        self.page.locator("#b-save").click()
        self.wait(lambda: st["report"]["version"] == 1, "the save goes through once the drawing was shown")
        self.assertEqual(self.site.flow_commits[-1][1].get("expectedEffectiveDrawingIds"), [held])
        self.assertEqual(st["report"]["drawings"], [held])
        self.assertEqual(len(self.site.flow_commits), 2, "the page sent a commit by itself in between")

    def test_clear_reads_the_draft_first_when_its_drawing_list_is_not_known(self):
        # A saved version holds one drawing; my draft only removes it (no text, an empty list of its own).
        saved = self.drawing()
        st = self.stored(ids=[], head=[saved], rs="T")
        self.site.draft_read_answers = ["abort"] * 8      # the whole draft read fails for now
        self.open()
        self.open_study(h.PATIENT)
        self.settle(300)
        self.assertIsNone(self.page.evaluate("() => draftClient.lists(selectedUid)"), "the page has not read the draft's lists")
        # Clear cannot tell whether there is a draft: it reads first, and a read that fails changes nothing and says so.
        self.clear()
        expect(self.page.get_by_text("서버의 초안을 확인하지 못해 비우지 않았습니다").first).to_be_visible()
        self.settle(300)
        self.assertEqual((len(self.site.discards), len(self.site.flow_puts)), (0, 0))
        self.assertEqual(st["row"]["drawings"], [], "the removal draft is as it was")
        # The next Clear reads the draft, finds the removal and ends it - the saved version keeps its drawing.
        self.site.draft_read_answers.clear()
        self.clear()
        self.wait(lambda: len(self.site.discards) == 1, "Clear discards the removal draft once it has read it")
        self.assertEqual(self.site.discards[0].get("drawingIds"), [], "the discard names the list of the draft it ends")
        self.assertIsNone(st["row"])
        self.assertEqual(st["report"]["drawings"], [saved])

    def test_a_stale_draft_that_only_removes_a_drawing_takes_its_base_again(self):
        saved = self.drawing()
        st = self.stored(ids=[], head=[saved], rs="A")
        self.open()
        self.open_study(h.PATIENT)
        self.settle(300)
        newer = {"version": 2, "updatedBy": "syn-other", "findings": "SYN newer approved text", "conclusion": "", "recommendation": ""}
        self.site.commit_answers = [(409, {"code": "REPORT_DRAFT_STALE", "message": "SYN stale draft", "head": newer, "draftBaseVersion": 1})]
        self.page.evaluate("() => { commitReport('addendum'); }")
        expect(self.page.locator("#stalemodal")).to_have_class(re.compile(r"\bshow\b"))
        puts = len(self.site.flow_puts)
        self.page.locator("#stale-rebase").click()
        self.wait(lambda: len(self.site.flow_puts) > puts, "the draft without text takes the new base")
        body = self.site.flow_puts[-1][1]
        self.assertEqual((body["findings"], body["baseVersion"], body.get("drawingIds")), ("", 2, []))
        self.wait(lambda: st["row"]["baseVersion"] == 2, "the server holds the draft on the new base")
        self.assertEqual(st["row"]["drawings"], [], "the removal is kept with it")
        expect(self.page.locator("#stalemodal")).not_to_have_class(re.compile(r"\bshow\b"))

    def test_a_remove_whose_answer_is_lost_and_that_ended_the_draft_leaves_no_conflict(self):
        self.open()
        self.open_study(h.PATIENT)
        self.open_window()
        self.choose("Ellipse")
        self.drag(0.15, 0.3, 0.25, 0.4)
        self.attach()
        st = self.site.store[h.UID]
        only = st["row"]["drawings"][0]
        self.site.put_answers = ["lost"]            # the server removes it - the draft without text ends - and the answer is lost
        before = len(self.site.drawing_writes)
        self.page.locator(f"#image-report-attached button[data-drawing='{only}']").click()
        self.wait(lambda: len(self.site.drawing_writes) > before, "the remove is sent")
        self.wait(lambda: "Removed from the report draft" in (self.page.locator("#image-report-status").text_content() or ""),
                  "the remove is found by its exact result")
        self.assertIsNone(st["row"], "the server ended the draft")
        self.assertEqual(self.page.evaluate("() => [!!draftClient.conflict(selectedUid), draftClient.uncertain(selectedUid)]"), [False, False])
        self.assertEqual(len(self.site.drawing_writes), before + 1, "the remove was sent a second time")
        expect(self.page.locator("#image-report-attached figure")).to_have_count(0)

    def test_a_lost_commit_answer_is_this_commit_only_with_the_drawings_it_named(self):
        # A saved version holds one drawing; my draft removes it and keeps the saved text. Save names an empty final list.
        saved = self.drawing()
        st = self.stored(text="SYN saved", ids=[], head=[saved], rs="T")
        self.open()
        self.open_study(h.PATIENT)
        self.settle(300)
        expect(self.page.locator("#report-image-attached")).to_be_hidden()
        self.site.commit_answers = ["hold"]
        self.page.locator("#b-save").click()
        self.wait(lambda: len(self.site.held_flow_commits) == 1, "the save reached the server")
        route, _, body, account = self.site.held_flow_commits.pop(0)
        self.assertEqual((body.get("drawingIds"), body.get("expectedEffectiveDrawingIds")), ([], []))
        # The answer is lost, and the version that stands on that base is not this commit: the same text, by the same
        # author (another window), with the drawing still attached.
        st["revs"] += 1
        st["row"] = None
        self.site.draw[h.UID] = None
        st["report"] = {**st["report"], "version": 2}
        st["versions"].append({"version": 2, "action": "save", "author": h.owner_of(account)["author"], "reason": None,
                               **{k: st["report"].get(k, "") for k in FIELDS}, "drawings": [{"id": saved}]})
        route.abort("connectionreset")
        self.wait(lambda: self.page.evaluate("() => !reportUnknownCommits.has(selectedUid)"), "the page read what the server holds")
        self.assertEqual(self.page.evaluate("() => appState[selectedUid].version"), 1,
                         "a version with the same text and other drawings was taken as this commit")

    def test_a_lost_commit_answer_is_found_as_the_version_it_made(self):
        saved = self.drawing()
        st = self.stored(text="SYN saved", ids=[], head=[saved], rs="T")
        self.open()
        self.open_study(h.PATIENT)
        self.settle(300)
        self.site.commit_answers = ["lost"]         # the server makes the version (no drawing) and the answer is lost
        self.page.locator("#b-save").click()
        self.wait(lambda: st["report"]["version"] == 2, "the server made the version")
        self.wait(lambda: self.page.evaluate("() => appState[selectedUid].version") == 2, "the page found its commit by the version")
        self.assertEqual(st["report"]["drawings"], [])
        self.assertFalse(self.page.evaluate("() => reportUnknownCommits.has(selectedUid)"))

    def test_the_editor_strip_shows_only_the_selected_studys_drawings(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN text")
        self.open_window()
        self.choose("Ellipse")
        self.drag(0.15, 0.3, 0.25, 0.4)
        self.attach()
        self.page.locator("#image-report-close").click()
        expect(self.page.locator("#report-image-attached figure")).to_have_count(1)
        self.open_study(h.PATIENT_B)
        expect(self.page.locator("#report-image-attached")).to_be_hidden()
        expect(self.page.locator("#report-image-attached figure")).to_have_count(0)
        self.open_study(h.PATIENT)
        expect(self.page.locator("#report-image-attached figure")).to_have_count(1)

if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *sys.argv[1:]])
