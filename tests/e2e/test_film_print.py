# coding: utf-8
"""Film / DICOM Print on the served stack: a radiologist opens Print Images from the report's More menu for a synthetic
CT and prints one 2 x 2 film to a synthetic film printer that reports its Print Job DONE (Printed), to one that takes
the film and never answers the completion inquiry (Sending, Sent, No answer - result unknown; never Printed), and sends
the same film's layout image to a synthetic DICOM device (Stored on the device; nothing stored in this archive).

The printers and the device are tests/film_print_scp.py on this machine; the API reaches them at host.docker.internal
(docker-compose.film-print.yml, which also shortens the completion wait). Run in CI:
`python tests/measurement_ci.py --profile film-print`; on a development stack (with that overlay):
`python tests/e2e/test_film_print.py`. Synthetic only: a run-unique study; cleanup removes the peers, the jobs and
their audit rows.
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from playwright.sync_api import expect

from test_worklist import WorklistE2E
from test_prior_selection import synthetic_ct
from invariants_live import AUDIT_GUARD_OFF, AUDIT_GUARD_ON, ROOT, psql

HOST = os.environ.get("KIN_FILM_PRINT_TEST_HOST", "host.docker.internal")


def free_port():
    with socket.socket() as s:
        s.bind(("0.0.0.0", 0))
        return s.getsockname()[1]


class FilmPrintE2E(WorklistE2E):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.logs = Path(tempfile.mkdtemp(prefix="kin-film-print-"))
        cls.ports = {"done": free_port(), "silent": free_port(), "store": free_port()}
        cls.aets = {"done": "SYNPRA" + uuid.uuid4().hex[:6].upper(), "silent": "SYNPRB" + uuid.uuid4().hex[:6].upper(),
                    "store": "SYNDEV" + uuid.uuid4().hex[:6].upper()}
        cls.scp = subprocess.Popen([sys.executable, "-u", str(ROOT / "tests/film_print_scp.py"), "--bind", "0.0.0.0", "--log-dir", str(cls.logs),
                                    *(f"{cls.aets[m]}:{cls.ports[m]}:{m}" for m in ("done", "silent", "store"))],
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for _ in range(3):
            line = cls.scp.stdout.readline()
            if not line.startswith("listening"):
                raise RuntimeError("the synthetic printers did not start: " + line)

    @classmethod
    def tearDownClass(cls):
        cls.scp.terminate()
        try:
            cls.scp.wait(10)
        except subprocess.TimeoutExpired:
            cls.scp.kill()
        super().tearDownClass()

    def received(self, mode):
        path = self.logs / f"{self.aets[mode]}.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    def register(self, name, mode, kind):
        body = {"name": name, "aet": self.aets[mode], "host": HOST, "port": self.ports[mode]}
        if kind == "printer":
            body.update(kind="printer", filmSizes=["14INX17IN", "8INX10IN"])
        answer = self.stack.request("POST", "/admin/dicom-peers", "jmryu", body)
        self.assertIn(answer.status, (200, 201), answer.text)
        peer = answer.body["peer"]
        self.addCleanup(lambda: self.stack.request("DELETE", "/admin/dicom-peers/" + peer["id"], "jmryu"))
        return peer

    def statuses(self, page):
        return page.locator("#film-print-status li").all_inner_texts()

    def press(self, page, final, timeout=60000):
        page.locator("#film-print-go").click()
        expect(page.locator("#film-print-status")).to_contain_text(final, timeout=timeout)
        return self.statuses(page)

    def test_film_01_printed_no_answer_and_stored_on_the_device(self):
        """Live: Printed only when the printer reports DONE; a printer silent after taking the film is No answer, never
        Printed; the layout image goes to the device as a Secondary Capture of the study and not into this archive."""
        fixture = synthetic_ct(self.stack, "FILM-" + uuid.uuid4().hex[:12], "current", "20260801", slices=6)
        def cleanup():
            if not re.fullmatch(r"[0-9.]+", fixture.uid): raise RuntimeError("Refusing an unexpected synthetic value in SQL")
            psql(f"""BEGIN; DELETE FROM "FilmPrintJob" WHERE "studyUid"='{fixture.uid}'; {AUDIT_GUARD_OFF}
              DELETE FROM "AuditLog" WHERE target='{fixture.uid}' AND action='film-print.job'; {AUDIT_GUARD_ON} COMMIT;""")
        self.addCleanup(cleanup)
        printer_a = self.register("SYN Film Printer A", "done", "printer")
        printer_b = self.register("SYN Film Printer B", "silent", "printer")
        device = self.register("SYN Workstation", "store", "store")
        counts = lambda: next(s["count"] for s in self.stack.request("GET", "/studies?uids=" + fixture.uid, "doctor").body["studies"] if s["uid"] == fixture.uid)
        held = counts()

        work = self.login()
        self.select(work, fixture)
        self.open_toolbar_group(work, "#b-film-print")
        work.locator("#b-film-print").click()
        dialog = work.locator("#film-print")
        expect(dialog).to_be_visible()
        work.locator("#film-print-format").select_option("2x2")
        expect(work.locator("#film-print-film .fp-cell")).to_have_count(4)
        # The preview shows this CT's own images (the same rendering the printer gets), one per filled cell.
        expect(work.locator("#film-print-film .fp-cell img")).to_have_count(4, timeout=30000)
        expect(work.locator("#film-print-film-of")).to_have_text("Film 1 of 2")

        # Printer A: Sending, Sent, Printed.
        expect(work.locator("#film-print-to-printer")).to_be_checked()
        work.locator("#film-print-target").select_option(printer_a["id"])
        lines = self.press(work, "Printed")
        self.assertEqual(["Sending", "Sent", "Printed"], [s.split(" ")[0] for s in lines])
        got = self.received("done")
        kinds = [e["kind"] for e in got]
        self.assertEqual(["N-CREATE", "N-CREATE", "N-SET", "N-SET", "N-SET", "N-SET", "N-ACTION", "N-GET"], kinds[:8])
        box = got[1]["attributes"]
        self.assertEqual(("STANDARD\\2,2", "14INX17IN", "PORTRAIT"), (box["ImageDisplayFormat"], box["FilmSizeID"], box["FilmOrientation"]))
        for entry in got[2:6]:
            image = entry["attributes"]["BasicGrayscaleImageSequence"][0]
            self.assertEqual(("MONOCHROME2", "8"), (image["PhotometricInterpretation"], image["BitsAllocated"]))
            self.assertLessEqual((int(image["Columns"]), int(image["Rows"])), (1050, 1275))
            self.assertGreater(image["PixelData"]["sum"], 0, "a rendered CT image, not an empty box")

        # Printer B: takes the film, never reports completion.
        work.locator("#film-print-target").select_option(printer_b["id"])
        expect(work.locator("#film-print-status li")).to_have_count(0)
        lines = self.press(work, "No answer — result unknown", timeout=90000)
        self.assertEqual(["Sending", "Sent", "No"], [s.split(" ")[0] for s in lines])
        self.assertFalse(any("Printed" in s for s in lines))
        self.assertIn("N-ACTION", [e["kind"] for e in self.received("silent")])

        # The DICOM device: the layout image of the same film.
        work.locator("#film-print-to-device").check()
        expect(work.locator("#film-print-go")).to_have_text("Send")
        work.locator("#film-print-target").select_option(device["id"])
        lines = self.press(work, "Stored on the device")
        self.assertEqual(["Sending", "Sent", "Stored"], [s.split(" ")[0] for s in lines])
        stored = [e for e in self.received("store") if e["kind"] == "C-STORE"]
        self.assertEqual(1, len(stored))
        a = stored[0]["attributes"]
        self.assertEqual((fixture.uid, "Print layout 2x2", "1.2.840.10008.5.1.4.1.1.7", "2550", "2100"),
                         (a["StudyInstanceUID"], a["SeriesDescription"], a["SOPClassUID"], a["Rows"], a["Columns"]))
        self.assertEqual(held, counts(), "the layout image is not stored in this archive")

        rows = psql(f"""SELECT destination || '|' || state FROM "FilmPrintJob" WHERE "studyUid"='{fixture.uid}' ORDER BY "createdAt";""")
        self.assertEqual(["printer|printed", "printer|no-answer", "device|stored"], [r for r in rows if r])
        work.locator("#film-print-close").click()
        expect(dialog).to_be_hidden()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(FilmPrintE2E(name) for name in loader.getTestCaseNames(FilmPrintE2E) if name.startswith("test_film_"))


if __name__ == "__main__": unittest.main(verbosity=2)
