# coding: utf-8
"""Worklist request and approval columns on the shipped page: ReqDate, ReqDept, ReqDoc, Pt Class (after Name) and Confirm
(after RS), their filters, a stored layout from before these columns, and the column chooser.

The page boots through its own boot() against the in-test server of multi_institution_worklist_dom_test.py; nothing of the
page is cut out or replaced. Cells are read by the position of their visible header. Expected values are written here from
the stub rows (synthetic SYN-* data), never computed by product code. Times are shown in the browser's zone (Asia/Seoul).
"""
import json
import re
import unittest

from playwright.sync_api import expect
import multi_institution_worklist_dom_test as harness
from multi_institution_worklist_dom_test import Server, SESSION_A, layout_key, row, until


def request_row(uid, pid, *, req_date=None, dept=None, doc=None, pt=None, rs="W", approved_at=None, confirm=None):
    body = row(uid, pid, rs=rs)
    body.update({"reqDate": req_date, "reqDept": dept, "reqDoc": doc, "ptClass": pt})
    body["state"].update({"approvedAt": approved_at, "confirm": confirm})
    return body


ROWS = [
    # Matched order values (the server already chose the order first, then the DICOM physician for ReqDoc).
    request_row("2.25.901", "SYN-RC-01", req_date="2026-11-12T00:40:00.000Z", dept="Neurology", doc="SYN PARK JIHOON", pt="Outpatient"),
    request_row("2.25.902", "SYN-RC-02", req_date="2026-11-11T05:00:00.000Z", dept="Orthopedics", doc="SYN SEO JUNHO", pt="Inpatient",
                rs="A", approved_at="2026-11-12T22:31:00.000Z", confirm="2026-11-12"),
    request_row("2.25.903", "SYN-RC-03", req_date="2026-11-12T01:50:00.000Z", dept="Emergency Medicine", doc="SYN YOON JAEHO", pt="ER"),
    # An approval stored before its time was kept: the stored date is shown, and the row is still Confirmed.
    request_row("2.25.904", "SYN-RC-04", dept="Neurology", doc="SYN LEE JUNHO", pt="ICU", rs="A", confirm="2026-10-01"),
    # Approved with neither value stored: blank cell, still Confirmed.
    request_row("2.25.905", "SYN-RC-05", rs="A"),
    # No order and no physician tag: every request cell blank; an In Progress report is Not Confirmed.
    request_row("2.25.906", "SYN-RC-06", rs="T"),
]
IDS = ["SYN-RC-01", "SYN-RC-02", "SYN-RC-03", "SYN-RC-04", "SYN-RC-05", "SYN-RC-06"]
DEFAULT_HEADS = ["No", "Assigned Reader", "RS", "Confirm", "StudyDate", "ID", "Name", "ReqDate", "ReqDept", "ReqDoc", "Pt Class",
                 "Age", "StudyDesc", "Modality", "Hospital"]


class WorklistRequestColumnsDOM(unittest.TestCase):
    # The harness's browser and boot only; that file's own cases are not run again here.
    setUpClass = classmethod(harness.MultiInstitutionWorklist.setUpClass.__func__)
    tearDownClass = classmethod(harness.MultiInstitutionWorklist.tearDownClass.__func__)
    boot = harness.MultiInstitutionWorklist.boot

    def select(self, screen, title, value):
        screen.filter_box(title).select_option(value)

    def type(self, screen, title, value):
        screen.filter_box(title).fill(value)

    def test_rc01_default_columns_and_cells(self):
        screen = self.boot(Server(rows=ROWS))
        screen.wait_rows(IDS)
        self.assertEqual(DEFAULT_HEADS, screen.heads())
        self.assertEqual({"SYN-RC-01": "2026-11-12 09:40", "SYN-RC-02": "2026-11-11 14:00", "SYN-RC-03": "2026-11-12 10:50",
                          "SYN-RC-04": "", "SYN-RC-05": "", "SYN-RC-06": ""}, screen.cells_by_id("ReqDate"))
        self.assertEqual({"SYN-RC-01": "Neurology", "SYN-RC-02": "Orthopedics", "SYN-RC-03": "Emergency Medicine",
                          "SYN-RC-04": "Neurology", "SYN-RC-05": "", "SYN-RC-06": ""}, screen.cells_by_id("ReqDept"))
        self.assertEqual({"SYN-RC-01": "SYN PARK JIHOON", "SYN-RC-02": "SYN SEO JUNHO", "SYN-RC-03": "SYN YOON JAEHO",
                          "SYN-RC-04": "SYN LEE JUNHO", "SYN-RC-05": "", "SYN-RC-06": ""}, screen.cells_by_id("ReqDoc"))
        self.assertEqual({"SYN-RC-01": "Outpatient", "SYN-RC-02": "Inpatient", "SYN-RC-03": "ER", "SYN-RC-04": "ICU",
                          "SYN-RC-05": "", "SYN-RC-06": ""}, screen.cells_by_id("Pt Class"))
        # Approval time in the browser's zone; the stored date of an older approval as it is; nothing for the others.
        self.assertEqual({"SYN-RC-01": "", "SYN-RC-02": "2026-11-13 07:31", "SYN-RC-03": "", "SYN-RC-04": "2026-10-01",
                          "SYN-RC-05": "", "SYN-RC-06": ""}, screen.cells_by_id("Confirm"))
        screen.finish()

    def test_rc02_filters_narrow_the_rows(self):
        screen = self.boot(Server(rows=ROWS))
        screen.wait_rows(IDS)
        options = screen.filter_box("ReqDept").locator("option").all_inner_texts()
        self.assertEqual(["", "Emergency Medicine", "Neurology", "Orthopedics"], options)
        self.select(screen, "ReqDept", "Neurology")
        screen.wait_rows(["SYN-RC-01", "SYN-RC-04"])
        self.type(screen, "ReqDoc", "park")
        screen.wait_rows(["SYN-RC-01"])
        self.type(screen, "ReqDoc", "")
        screen.wait_rows(["SYN-RC-01", "SYN-RC-04"])
        self.select(screen, "ReqDept", "")
        screen.wait_rows(IDS)
        self.assertEqual(["", "Outpatient", "Inpatient", "ER", "ICU"], screen.filter_box("Pt Class").locator("option").all_inner_texts())
        self.select(screen, "Pt Class", "ER")
        screen.wait_rows(["SYN-RC-03"])
        self.select(screen, "Pt Class", "")
        self.type(screen, "ReqDate", "2026-11-12")
        screen.wait_rows(["SYN-RC-01", "SYN-RC-03"])
        self.type(screen, "ReqDate", "2026-11-12 10")
        screen.wait_rows(["SYN-RC-03"])
        self.type(screen, "ReqDate", "")
        screen.wait_rows(IDS)
        self.assertEqual(["", "Confirmed", "Not Confirmed"], screen.filter_box("Confirm").locator("option").all_inner_texts())
        # An older approval without a stored time, and one with nothing stored, are Confirmed all the same.
        self.select(screen, "Confirm", "Confirmed")
        screen.wait_rows(["SYN-RC-02", "SYN-RC-04", "SYN-RC-05"])
        self.select(screen, "Confirm", "Not Confirmed")
        screen.wait_rows(["SYN-RC-01", "SYN-RC-03", "SYN-RC-06"])
        self.select(screen, "Confirm", "")
        screen.wait_rows(IDS)
        screen.finish()

    def test_rc03_department_choices_follow_the_list_and_stay_text(self):
        server = Server(rows=ROWS[:2])
        screen = self.boot(server)
        screen.wait_rows(["SYN-RC-01", "SYN-RC-02"])
        self.assertEqual(["", "Neurology", "Orthopedics"], screen.filter_box("ReqDept").locator("option").all_inner_texts())
        self.select(screen, "ReqDept", "Orthopedics")
        screen.wait_rows(["SYN-RC-02"])
        # A department that arrives with a later list joins the choices; the chosen one stays chosen.
        server.rows = ROWS[:2] + [request_row("2.25.907", "SYN-RC-07", dept="<img src=x onerror=window.synXss=1>")]
        screen.refresh()
        until(lambda: "<img src=x onerror=window.synXss=1>" in screen.filter_box("ReqDept").locator("option").all_inner_texts(),
              10, "new department listed")
        self.assertEqual("Orthopedics", screen.filter_box("ReqDept").input_value())
        screen.wait_rows(["SYN-RC-02"])
        self.select(screen, "ReqDept", "<img src=x onerror=window.synXss=1>")
        screen.wait_rows(["SYN-RC-07"])
        self.assertEqual("<img src=x onerror=window.synXss=1>", screen.cells_by_id("ReqDept")["SYN-RC-07"])
        screen.finish()

    @staticmethod
    def compound(name, join, rules):
        return {"id": 600 + len(name), "name": name, "mode": "Radiology", "days": -1, "quick": "",
                "cols": {"$compound": {"version": 1, "join": join, "rules": rules}}, "sortKey": None, "sortDir": 0, "isDefault": False}

    def apply_saved(self, screen, name):
        screen.menu("Filters").get_by_role("button", name=re.compile("^" + re.escape(name) + ", ")).click()

    def test_rc05_saved_compound_searches_on_confirm_and_a_department_no_longer_listed(self):
        filters = [self.compound("SYN CONFIRMED", "and", [{"field": "confirm", "op": "eq", "value": "Confirmed"}]),
                   self.compound("SYN NOT CONFIRMED", "and", [{"field": "confirm", "op": "eq", "value": "Not Confirmed"}]),
                   # A department that no loaded row has: the search stays valid and its other branch still matches.
                   self.compound("SYN GONE DEPT", "or", [{"field": "reqDept", "op": "eq", "value": "SYN Closed Clinic"},
                                                         {"field": "id", "op": "eq", "value": "SYN-RC-06"}])]
        screen = self.boot(Server(rows=ROWS, filters=filters))
        screen.wait_rows(IDS)
        self.apply_saved(screen, "SYN CONFIRMED")
        screen.wait_rows(["SYN-RC-02", "SYN-RC-04", "SYN-RC-05"])
        self.apply_saved(screen, "SYN NOT CONFIRMED")
        screen.wait_rows(["SYN-RC-01", "SYN-RC-03", "SYN-RC-06"])
        self.apply_saved(screen, "SYN GONE DEPT")
        screen.wait_rows(["SYN-RC-06"])
        self.assertNotIn("복합 조건 오류", screen.filter_line())
        screen.finish()

    def test_rc04_a_stored_layout_gains_the_columns_at_their_places(self):
        # A browser layout saved before these columns: the user's order (Name before ID) and hidden Age are kept;
        # the request columns join after Name, Confirm after RS; the other columns stay where they were.
        stored = {"version": 1, "modes": {
            "Radiology": {"order": ["name", "id", "rs", "date", "modality", "age"], "hidden": ["age"]},
            "Technician": {"order": [], "hidden": []}}}
        screen = self.boot(Server(rows=ROWS), storage={layout_key(SESSION_A): json.dumps(stored)})
        screen.wait_rows(IDS)
        self.assertEqual(["Name", "ReqDate", "ReqDept", "ReqDoc", "Pt Class", "ID", "RS", "Confirm", "StudyDate", "Modality"],
                         screen.heads()[:10])
        self.assertNotIn("Age", screen.heads())
        # The column chooser lists them in the same order; one can be turned off and on again.
        screen.page.get_by_role("button", name="Choose columns", exact=True).click()
        picker = screen.page.locator("#column-picker")
        labels = [t.strip() for t in picker.locator("label").all_inner_texts()]
        self.assertEqual(["Name (Required)", "ReqDate", "ReqDept", "ReqDoc", "Pt Class", "ID (Required)", "RS", "Confirm"], labels[:8])
        picker.get_by_role("checkbox", name="Pt Class", exact=True).uncheck()
        picker.get_by_role("button", name="Close", exact=True).click()
        until(lambda: "Pt Class" not in screen.heads(), 5, "Pt Class hidden")
        saved = json.loads(screen.page.evaluate("key => localStorage.getItem(key)", layout_key(SESSION_A)))
        self.assertEqual(["name", "reqDate", "reqDept", "reqDoc", "ptClass", "id", "rs", "confirm"], saved["modes"]["Radiology"]["order"][:8])
        self.assertEqual(["age", "ptClass"], saved["modes"]["Radiology"]["hidden"])
        screen.finish()


if __name__ == "__main__":
    unittest.main()
