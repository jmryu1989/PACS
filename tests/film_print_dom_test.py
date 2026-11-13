# coding: utf-8
"""Film / DICOM Print window (worklist-v0/hpacs-lite/film-print.js) on the delivered split page.

The delivered page (main.html, its bundle and every shipped asset) against the synthetic origin of report_flow_dom_test,
plus the four film print routes and the rendered previews, answered here. No stack, no product file is modified.

  - `Film / DICOM Print` in More (Print and History, after Print) and `Film Print` on the Technician bar (after Attach
    Document) open Print Images for the selected study; the layout is the server's, one box per cell of the Format,
    each filled cell showing the rendering the server named; more images than cells give Film 1 of n with ◀ ▶;
  - Destination decides the list (printers or devices) and the main button (Print / Send);
  - the result line shows the job's states in order: Sending, Sent, then Printed / No answer - result unknown (never
    Printed) / Stored on the device; changing the destination clears it and a late answer of the earlier job is not shown;
  - a print whose answer was lost is asked again with the same request id;
  - Format, Destination and the printer are kept for the next window.
"""
import base64
import hashlib
import json
import re
import struct
import sys
import unittest
import uuid
import zlib
from urllib.parse import urlparse

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect, sync_playwright

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==")


def rgb_png(colour):
    """A 1 x 1 RGB PNG of one colour."""
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00" + bytes(colour))) + chunk(b"IEND", b""))


RED = rgb_png((255, 0, 0))
PRINTER_A = {"id": "00000000-0000-4000-8000-0000000000a1", "name": "SYN Film Printer A", "aet": "SYNPRA", "filmSizes": ["8INX10IN", "10INX12IN", "11INX14IN", "14INX17IN"]}
PRINTER_B = {"id": "00000000-0000-4000-8000-0000000000b1", "name": "SYN Film Printer B", "aet": "SYNPRB", "filmSizes": ["8INX10IN", "10INX12IN", "11INX14IN", "14INX17IN"]}
DEVICE = {"id": "00000000-0000-4000-8000-0000000000d1", "name": "SYN Workstation", "aet": "SYNWS"}
SERIES = [{"uid": "1.2.826.0.1.3680043.10.7707.1.1", "number": 1, "description": "SYN AXIAL", "modality": "CT", "images": 7},
          {"uid": "1.2.826.0.1.3680043.10.7707.1.2", "number": 2, "description": "SYN CORONAL", "modality": "CT", "images": 2}]


class FilmSite(rf.FlowSite):
    """FlowSite plus the film print routes: layouts from the series' image count, jobs that follow a script."""

    def __init__(self, count=2):
        super().__init__(count)
        self.layouts, self.posts, self.rendered, self.jobs = [], [], [], {}
        self.script = ["sent", "printed"]   # the states a job reaches, one per read after its creation
        self.post_answers = []              # "lost": the job is created and the answer dropped
        self.held_job_reads = []
        self.plan_changed = False           # the next print is refused: the series changed since its preview

    def handle(self, route, request):
        url = urlparse(request.url)
        if request.method == "GET" and re.fullmatch(r"/instances/[^/]+/frames/\d+/rendered", url.path):
            self.rendered.append(url.path + "?" + url.query)
            # The first image of the series is a colour picture: the preview shows it grey, as printed.
            return route.fulfill(status=200, content_type="image/png", body=RED if url.path.startswith("/instances/00000001-") else PNG)
        return super().handle(route, request)

    def layout_of(self, body):
        series = next((s for s in SERIES if s["uid"] == body.get("seriesUid")), SERIES[0])
        columns, rows = (int(v) for v in body["format"].split("x"))
        per, film = columns * rows, body.get("film", 1)
        films = max(1, -(-series["images"] // per))
        cells = []
        for index, order in enumerate(range((film - 1) * per + 1, min(film * per, series["images"]) + 1)):
            instance = f"{order:08d}-00000000-00000000-00000000-00000000"
            cells.append({"position": index + 1, "instance": instance, "sop": f"{series['uid']}.{order}", "frame": 1, "order": order,
                          "window": None, "width": 100, "height": 100, "src": f"/instances/{instance}/frames/0/rendered?width=100&height=100"})
        plan = hashlib.sha256(json.dumps([series["uid"], body["format"], film, body["filmSize"], body["orientation"]]).encode()).hexdigest()
        return {"studyUid": body["studyUid"], "seriesUid": series["uid"], "film": film, "films": films, "plan": plan, "series": SERIES, "cells": cells}

    def view(self, job):
        return {"job": {**job, "events": [{"state": s, "at": "2026-11-14T00:00:00Z"} for s in job["states"]]}}

    def api(self, route, request, method, path, query):
        if not path.startswith("/api/film-print/"):
            return super().api(route, request, method, path, query)
        account, refused = self.authenticate(request)
        if refused:
            return self.refuse(route, *refused)
        if method == "GET" and path == "/api/film-print/destinations":
            return route.fulfill(json={"printers": [PRINTER_A, PRINTER_B], "devices": [DEVICE]})
        if method == "POST" and path == "/api/film-print/layout":
            body = request.post_data_json
            self.layouts.append(body)
            return route.fulfill(json=self.layout_of(body))
        if method == "POST" and path == "/api/film-print/jobs":
            body = request.post_data_json
            self.posts.append(body)
            if self.plan_changed:
                self.plan_changed = False
                return route.fulfill(status=409, json={"code": "FILM_PLAN_CHANGED", "message": "SYN the series changed since its preview"})
            known = next((j for j in self.jobs.values() if j["requestId"] == body["requestId"]), None)
            if not known:
                peer = next(p for p in (PRINTER_A, PRINTER_B, DEVICE) if p["id"] == body["destination"]["peerId"])
                known = {"id": str(uuid.uuid4()), "requestId": body["requestId"], "state": "sending", "states": ["sending"],
                         "script": list(self.script), "reason": None, "warnings": [], "film": body["film"], "films": 2,
                         "format": body["format"], "copies": body["copies"],
                         "destination": {"kind": body["destination"]["kind"], "peerId": peer["id"], "name": peer["name"]}}
                self.jobs[known["id"]] = known
            if self.post_answers and self.post_answers.pop(0) == "lost":
                return route.abort("connectionreset")
            return route.fulfill(json=self.view({k: v for k, v in known.items() if k != "script"}))
        found = re.fullmatch(r"/api/film-print/jobs/([^/]+)", path)
        if method == "GET" and found and found.group(1) in self.jobs:
            job = self.jobs[found.group(1)]
            if job["script"] and job["script"][0] == "hold":
                return self.held_job_reads.append((route, job))
            if job["script"]:
                state = job["script"].pop(0)
                job["state"] = state
                job["states"].append(state)
                if state == "no-answer":
                    job["reason"] = "the printer did not report completion"
            return route.fulfill(json=self.view({k: v for k, v in job.items() if k != "script"}))
        self.violations.append(f"undeclared film print request: {method} {path}")
        return route.fulfill(status=404, json={"message": "SYN not found"})


class FilmPrintWindow(unittest.TestCase):
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

    def start(self, site=None, context=None):
        site = site or FilmSite()
        context = context or self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR", timezone_id="Asia/Seoul")
        context.route("**/*", lambda route, request: site.handle(route, request))
        page = context.new_page()
        page.set_default_timeout(10000)
        run = {"site": site, "context": context, "page": page, "errors": []}
        page.on("pageerror", lambda error: run["errors"].append(str(error)))
        page.goto(h.MAIN_URL)
        expect(page.locator("#rows")).to_contain_text(h.PATIENT)
        self.runs.append(run)
        self.site, self.page = site, page
        return run

    def open_study(self, patient=h.PATIENT):
        self.page.locator("#rows tr", has_text=patient).first.click()
        self.page.wait_for_function(f"() => studies.find(s => s.uid === selectedUid)?.name === {json.dumps(patient)}")

    def open_from_more(self):
        self.page.locator("#report-more > summary").click()
        self.page.locator("#b-film-print").click()
        expect(self.page.locator("#film-print")).to_be_visible()
        expect(self.page.locator("#film-print-film-of")).to_have_text(re.compile(r"Film \d+ of \d+"))

    def statuses(self):
        return self.page.locator("#film-print-status li").all_inner_texts()

    def wait_status(self, text):
        expect(self.page.locator("#film-print-status")).to_contain_text(text)

    # ── entry points and the window ──
    def test_more_and_the_technician_bar_open_print_images_for_the_selected_study(self):
        self.start()
        self.open_study()
        ids = self.page.evaluate("[...document.querySelectorAll('#report-more-output > button')].filter(b => !b.hidden).map(b => b.id)")
        self.assertEqual("b-film-print", ids[ids.index("b-print") + 1], "Film / DICOM Print right after Print")
        expect(self.page.locator("#b-film-print")).to_have_text("Film / DICOM Print")
        self.open_from_more()
        self.assertFalse(self.page.evaluate("document.getElementById('report-more').open"), "More closes")
        expect(self.page.locator("#film-print-title")).to_have_text("Print Images")
        expect(self.page.locator("#film-print .fp-study")).to_contain_text(h.PATIENT)
        self.assertEqual(h.UID, self.site.layouts[0]["studyUid"])
        self.assertEqual({"format": "2x2", "filmSize": "14INX17IN", "orientation": "PORTRAIT", "film": 1},
                         {k: self.site.layouts[0][k] for k in ("format", "filmSize", "orientation", "film")})
        self.assertNotIn("seriesUid", self.site.layouts[0], "the server picks the first series")
        # Four boxes in two rows and two columns, each filled with the rendering the server named.
        expect(self.page.locator("#film-print-film .fp-cell")).to_have_count(4)
        expect(self.page.locator("#film-print-film .fp-cell canvas")).to_have_count(4)
        self.assertEqual(["1", "2", "3", "4"], self.page.locator("#film-print-film .fp-cell").evaluate_all("c => c.map(x => x.dataset.position)"))
        # The colour picture (pure red) is previewed grey with the print's weights: (255*299 + 500) / 1000 = 76.
        self.assertEqual([76, 76, 76, 255], self.page.evaluate("""() => [...document.querySelector('#film-print-film .fp-cell[data-position="1"] canvas')
          .getContext('2d').getImageData(0, 0, 1, 1).data]"""))
        self.assertEqual(sorted(f"/instances/{n:08d}-00000000-00000000-00000000-00000000/frames/0/rendered?width=100&height=100" for n in range(1, 5)),
                         sorted(self.site.rendered))
        expect(self.page.locator("#film-print-film-of")).to_have_text("Film 1 of 2")
        expect(self.page.locator("#film-print-series option")).to_have_count(2)
        for label in ("Format", "Film size", "Orientation", "Copies"):
            expect(self.page.locator("#film-print label", has_text=label).first).to_be_visible()
        self.page.keyboard.press("Escape")
        expect(self.page.locator("#film-print")).to_be_hidden()

        # Technician: the bar's Film Print right after Attach Document opens the same window.
        self.page.locator("[data-tab=Technician]").click()
        ids = self.page.evaluate("[...document.querySelectorAll('#ctxbtns > button')].map(b => b.id || b.textContent)")
        self.assertEqual("t-film-print", ids[ids.index("t-attach") + 1], "Film Print right after Attach Document")
        expect(self.page.locator("#t-film-print")).to_be_visible()
        expect(self.page.locator("#t-film-print")).to_have_text("Film Print")
        self.page.locator("#t-film-print").click()
        expect(self.page.locator("#film-print")).to_be_visible()
        self.page.locator("#film-print-close").click()
        expect(self.page.locator("#film-print")).to_be_hidden()

    def test_format_series_and_films(self):
        self.start()
        self.open_study()
        self.open_from_more()
        self.page.locator("#film-print-format").select_option("3x4")
        expect(self.page.locator("#film-print-film .fp-cell")).to_have_count(12)
        expect(self.page.locator("#film-print-film .fp-cell canvas")).to_have_count(7)
        expect(self.page.locator("#film-print-film-of")).to_have_text("Film 1 of 1")
        self.page.locator("#film-print-format").select_option("1x2")
        expect(self.page.locator("#film-print-film-of")).to_have_text("Film 1 of 4")
        self.page.get_by_title("Next film").click()
        expect(self.page.locator("#film-print-film-of")).to_have_text("Film 2 of 4")
        self.assertEqual((2, SERIES[0]["uid"]), (self.site.layouts[-1]["film"], self.site.layouts[-1]["seriesUid"]))
        self.page.locator("#film-print-series").select_option(SERIES[1]["uid"])
        expect(self.page.locator("#film-print-film-of")).to_have_text("Film 1 of 1")
        self.assertEqual(SERIES[1]["uid"], self.site.layouts[-1]["seriesUid"])

    def test_destination_decides_the_list_and_the_main_button(self):
        self.start()
        self.open_study()
        self.open_from_more()
        expect(self.page.locator("#film-print-to-printer")).to_be_checked()
        expect(self.page.locator("#film-print-target option")).to_have_text(["SYN Film Printer A · AE SYNPRA", "SYN Film Printer B · AE SYNPRB"])
        expect(self.page.locator("#film-print-go")).to_have_text("Print")
        self.page.locator("#film-print-to-device").check()
        expect(self.page.locator("#film-print-target option")).to_have_text(["SYN Workstation · AE SYNWS"])
        expect(self.page.locator("#film-print-go")).to_have_text("Send")
        self.page.locator("#film-print-to-printer").check()
        expect(self.page.locator("#film-print-go")).to_have_text("Print")

    # ── the result line ──
    def test_printed_follows_sending_and_sent(self):
        self.start()
        self.open_study()
        self.open_from_more()
        self.page.locator("#film-print-copies").fill("2")
        self.page.locator("#film-print-go").click()
        self.wait_status("Printed")
        self.assertEqual(["Sending", "Sent", "Printed"], [s.split(" ")[0] for s in self.statuses()])
        post = self.site.posts[0]
        self.assertEqual({"studyUid": h.UID, "seriesUid": SERIES[0]["uid"], "format": "2x2", "filmSize": "14INX17IN", "orientation": "PORTRAIT",
                          "film": 1, "copies": 2, "destination": {"kind": "printer", "peerId": PRINTER_A["id"]},
                          "plan": self.site.layout_of(self.site.layouts[-1])["plan"]},
                         {k: v for k, v in post.items() if k != "requestId"})
        expect(self.page.locator("#film-print-go")).to_be_enabled()

    def test_no_answer_is_never_printed(self):
        site = FilmSite()
        site.script = ["sent", "no-answer"]
        self.start(site)
        self.open_study()
        self.open_from_more()
        self.page.locator("#film-print-target").select_option(PRINTER_B["id"])
        self.page.locator("#film-print-go").click()
        self.wait_status("No answer — result unknown")
        lines = self.statuses()
        self.assertEqual(["Sending", "Sent", "No"], [s.split(" ")[0] for s in lines])
        self.assertIn("Check the film at the printer before printing again", lines[-1])
        self.assertFalse(any("Printed" in s for s in lines))

    def test_a_device_shows_stored_on_the_device(self):
        site = FilmSite()
        site.script = ["sent", "stored"]
        self.start(site)
        self.open_study()
        self.open_from_more()
        self.page.locator("#film-print-to-device").check()
        self.page.locator("#film-print-go").click()
        self.wait_status("Stored on the device")
        self.assertEqual(["Sending", "Sent", "Stored"], [s.split(" ")[0] for s in self.statuses()])
        self.assertEqual({"kind": "device", "peerId": DEVICE["id"]}, self.site.posts[0]["destination"])

    def test_changing_the_destination_hides_the_earlier_result_and_its_late_answer(self):
        site = FilmSite()
        site.script = ["hold"]
        self.start(site)
        self.open_study()
        self.open_from_more()
        self.page.locator("#film-print-go").click()
        expect(self.page.locator("#film-print-status")).to_contain_text("Sending")
        self.page.wait_for_timeout(1000)
        self.assertEqual(1, len(site.held_job_reads), "the job is being read")
        self.page.locator("#film-print-to-device").check()
        expect(self.page.locator("#film-print-status li")).to_have_count(0)
        route, job = site.held_job_reads.pop(0)
        job["script"] = []
        job["state"] = "printed"
        job["states"] += ["sent", "printed"]
        route.fulfill(json=site.view({k: v for k, v in job.items() if k != "script"}))
        self.page.wait_for_timeout(1500)
        expect(self.page.locator("#film-print-status li")).to_have_count(0)
        expect(self.page.locator("#film-print-go")).to_have_text("Send")

    def test_a_lost_answer_is_asked_again_with_the_same_request_id(self):
        site = FilmSite()
        site.post_answers = ["lost"]
        self.start(site)
        self.open_study()
        self.open_from_more()
        self.page.locator("#film-print-go").click()
        self.wait_status("Printed")
        self.assertEqual(2, len(site.posts))
        self.assertEqual(site.posts[0], site.posts[1], "the same request, the same request id")
        self.assertEqual(1, len(site.jobs), "one print")

    def test_a_series_changed_since_the_preview_prints_nothing_and_the_preview_is_drawn_again(self):
        site = FilmSite()
        site.plan_changed = True
        self.start(site)
        self.open_study()
        self.open_from_more()
        layouts = len(site.layouts)
        self.page.locator("#film-print-go").click()
        self.wait_status("Failed — SYN the series changed since its preview")
        expect(self.page.locator("#film-print-film-of")).to_have_text("Film 1 of 2")
        self.assertGreater(len(site.layouts), layouts, "the preview was read again")
        self.assertEqual({}, site.jobs, "nothing was printed")
        self.assertEqual(1, len(site.posts), "not asked again")
        expect(self.page.locator("#film-print-go")).to_be_enabled()

    # ── last values ──
    def test_format_destination_and_printer_are_kept_for_the_next_window(self):
        self.start()
        self.open_study()
        self.open_from_more()
        self.page.locator("#film-print-format").select_option("3x4")
        self.page.locator("#film-print-target").select_option(PRINTER_B["id"])
        self.page.locator("#film-print-close").click()
        self.open_from_more()
        expect(self.page.locator("#film-print-format")).to_have_value("3x4")
        expect(self.page.locator("#film-print-to-printer")).to_be_checked()
        expect(self.page.locator("#film-print-target")).to_have_value(PRINTER_B["id"])
        expect(self.page.locator("#film-print-film .fp-cell")).to_have_count(12)
        self.page.locator("#film-print-to-device").check()
        self.page.locator("#film-print-close").click()
        self.open_from_more()
        expect(self.page.locator("#film-print-to-device")).to_be_checked()
        expect(self.page.locator("#film-print-go")).to_have_text("Send")

    def test_without_a_selected_study_nothing_opens(self):
        self.start()
        self.page.locator("[data-tab=Technician]").click()
        self.page.evaluate("() => { selectedUid = null; }")
        self.page.locator("#t-film-print").click()
        expect(self.page.locator("#film-print")).to_be_hidden()
        expect(self.page.locator("#toast")).to_contain_text("인쇄할 검사를 먼저 고르세요")


if __name__ == "__main__":
    unittest.main(argv=sys.argv[:1], verbosity=2)
