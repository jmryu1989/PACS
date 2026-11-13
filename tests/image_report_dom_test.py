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

    def write_of(self, uid, body, account):
        refused = self.preconditions_of(uid, body, account)
        if refused:
            return refused
        st, head = self.store[uid], self.store[uid]["report"].get("drawings", [])
        stored = self.draw[uid] if st["row"] else None
        if "drawingIds" in body and sorted(body["drawingIds"]) != sorted(stored["ids"] if stored else []):
            return 409, {"code": "REPORT_DRAFT_CONFLICT", "message": "SYN drawing ids"}
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
                drawn = {"removed": remove, "ids": draw["ids"]}
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
        untouched = not draw or sorted(draw["seed"]) == sorted(draw["ids"])
        empty = all(not body[k] for k in FIELDS)
        if empty and (drawn is None or untouched):
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
        bound = [] if body.get("action") == "reset" else self.effective(self.draw[uid] if self.store[uid]["row"] else None, head)
        status, answer = super().commit_of(uid, body, account)
        if status == 200:
            self.store[uid]["report"]["drawings"] = bound
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
            draw = self.draw[uid] if st["row"] else None
            return route.fulfill(json={"version": st["report"]["version"], "head": [self.meta(i) for i in head],
                                       "draft": {"ids": draw["ids"] if draw else [],
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
        self.assertNotIn("drawingIds", body, "no drawing yet: the write names none")
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


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *sys.argv[1:]])
