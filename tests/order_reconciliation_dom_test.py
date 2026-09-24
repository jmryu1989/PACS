# coding: utf-8
"""TEST-S4-U2-ORDER-RECONCILIATION DOM: the shipped order display driven through the real poll.

The harness is tests/worklist_arrivals_dom_test.py's: the real startPolling, applyObservation,
markObservationUnavailable and renderObservation sliced from main.html, now with the two S4-U2
functions sliced beside them. This file only starts the order model and asserts what it renders.
Hosted only (Chromium); nothing here runs against a server, a database or clinical data.
"""
import json
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright

import worklist_arrivals_dom_test as arrivals

ROOT = Path(__file__).resolve().parents[1]
ORDERS_JS = (ROOT / "worklist-v0" / "hpacs-lite" / "order-reconciliation.js").read_text(encoding="utf-8")
VECTORS = json.loads((ROOT / "tests" / "order_reconciliation_vectors.json").read_text(encoding="utf-8"))
READ = {case["name"]: case["value"] for case in VECTORS["read"]}
FULL_ROWS = next(case["rows"] for case in VECTORS["transitions"] if case["name"] == "observed_full")
HEAD = "Order Reconciliation · " + VECTORS["marker"]
PHRASE = VECTORS["phrases"]["orderWithoutImages"]
UNAVAILABLE = VECTORS["phrases"]["observationUnavailable"]
# What main.html's Order List array can hold offline (localStorage seed). It must never reach this surface.
OFFLINE_SEED = [{"oid": "O-OFFLINE-SEED", "id": "P-1001", "name": "KIM CHULSOO", "sched": "2026-09-24 09:10",
                 "matched": "U", "studyUid": None}]
ABSENT = object()


def reply(answer=ABSENT, at="2026-09-24T01:00:00.000Z"):
    observation = {"observedAt": at, "notObserved": []}
    if answer is not ABSENT:
        observation["orderReconciliation"] = answer
    return {"studies": [json.loads(json.dumps(arrivals.CURRENT))], "owner": arrivals.OWNER, "observation": observation}


class OrderReconciliationDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.errors = []
        self.page = self.browser.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.set_content(arrivals.HARNESS)
        self.page.add_script_tag(content=arrivals.ARRIVALS)
        self.page.add_script_tag(content=ORDERS_JS)
        self.page.evaluate("seed=>{window.orders=seed}", OFFLINE_SEED)
        self.page.evaluate("()=>{studyObservationModel=KinStudyArrivals.observationStart();"
                           "orderReconciliationModel=KinOrderReconciliation.start()}")

    def tearDown(self):
        self.page.close()
        self.assertEqual([], self.errors)

    def poll(self, value):
        self.page.evaluate("()=>{readStarted=0}")
        self.page.evaluate("value=>setReply(value)", value)
        self.page.evaluate("runPoll()")
        self.page.wait_for_function("()=>readStarted>0 && !studyPageClient.busy")
        self.page.wait_for_timeout(0)

    def fail_next(self):
        self.page.evaluate("()=>{readStarted=0;window.readError={status:503}}")
        self.page.evaluate("runPoll()")
        self.page.wait_for_function("()=>readStarted>0")
        self.page.wait_for_timeout(0)
        self.page.evaluate("()=>{window.readError=null;readStarted=0}")

    def view(self):
        return self.page.evaluate("""()=>({hidden:document.querySelector('#order-reconciliation').hidden,
          summary:document.querySelector('#order-reconciliation-summary').textContent,
          title:document.querySelector('#order-reconciliation-summary').title,
          rows:[...document.querySelectorAll('#order-reconciliation-list > div')].map(d=>d.textContent),
          titles:[...document.querySelectorAll('#order-reconciliation-list > div')].map(d=>d.title),
          status:document.querySelector('#observation-status').textContent})""")

    def test_s4u2_01_answer_renders_with_the_marker_one_phrase_and_no_patient_field(self):
        cold = self.view()
        self.assertTrue(cold["hidden"])
        self.assertEqual(("", []), (cold["summary"], cold["rows"]))
        self.poll(reply(READ["full"]))
        seen = self.view()
        self.assertFalse(seen["hidden"])
        self.assertTrue(seen["summary"].startswith(HEAD + " · Orders 5 · " + PHRASE + " 3 · Observed "), seen["summary"])
        self.assertIn("엔지니어링 확인 전용", seen["title"])
        self.assertEqual(FULL_ROWS, seen["rows"])
        self.assertTrue(all(seen["titles"]))
        # Visible text only (the Korean tooltip says what the surface must NOT be used as).
        text = json.dumps([seen["summary"], *seen["rows"]], ensure_ascii=False)
        for leak in ("KIM CHULSOO", "09:10", "P-1001", "O-OFFLINE-SEED", "Patient", "Scheduled", "예정", "완료"):
            self.assertNotIn(leak, text)
        # The U1b status line is still the U1b line: the order answer did not replace or fold into it.
        self.assertTrue(seen["status"].startswith("Observed "), seen["status"])

    def test_s4u2_02_failure_keeps_the_last_answer_and_only_adds_unavailable(self):
        self.poll(reply(READ["full"]))
        self.fail_next()
        failed = self.view()
        self.assertTrue(failed["summary"].startswith(HEAD + " · " + UNAVAILABLE + " · 마지막 관측 "), failed["summary"])
        self.assertTrue(failed["summary"].endswith(" 기준"))
        self.assertNotIn(PHRASE, failed["summary"])
        self.assertEqual(FULL_ROWS, failed["rows"])
        self.assertTrue(failed["status"].startswith(UNAVAILABLE), failed["status"])
        self.poll(reply(READ["empty"], at="2026-09-24T01:05:00.000Z"))
        recovered = self.view()
        self.assertTrue(recovered["summary"].startswith(HEAD + " · Orders 0 · Observed "), recovered["summary"])
        self.assertEqual([], recovered["rows"])

    def test_s4u2_03_cold_failure_and_an_absent_answer_invent_nothing(self):
        self.fail_next()
        cold = self.view()
        self.assertFalse(cold["hidden"])
        self.assertEqual((HEAD + " · " + UNAVAILABLE, []), (cold["summary"], cold["rows"]))
        self.poll(reply())
        unknown = self.view()
        self.assertTrue(unknown["summary"].startswith(HEAD + " · Unknown · Observed "), unknown["summary"])
        self.assertEqual([], unknown["rows"])   # never [] from the server and never the offline Order List

    def test_s4u2_04_unreadable_answer_is_unavailable_and_keeps_the_last(self):
        self.poll(reply(READ["full"]))
        for bad in ("other_source", "absent_with_candidates", "unlinked_row_with_patient_field"):
            with self.subTest(bad=bad):
                self.poll(reply(READ[bad], at="2026-09-24T01:02:00.000Z"))
                kept = self.view()
                self.assertTrue(kept["summary"].startswith(HEAD + " · " + UNAVAILABLE + " · 마지막 관측 "), kept["summary"])
                self.assertEqual(FULL_ROWS, kept["rows"])
                self.assertNotIn("SYNTHETIC", json.dumps(kept))

    def test_s4u2_05_a_superseded_poll_answer_changes_nothing(self):
        self.page.evaluate("()=>{readStarted=0;holdRead()}")
        self.page.evaluate("()=>{runPoll()}")
        self.page.wait_for_function("()=>readStarted===1 && typeof releaseRead==='function'")
        self.page.evaluate("pollGeneration++")
        self.page.evaluate("value=>releaseRead(value)", reply(READ["full"]))
        self.page.wait_for_timeout(0)
        late = self.view()
        self.assertTrue(late["hidden"])
        self.assertEqual(("", []), (late["summary"], late["rows"]))

    def test_s4u2_06_the_offline_order_list_is_not_an_input(self):
        only = {"source": "engineering_only", "orders": [{"oid": "SYN-ONLY", "link": "unlinked", "accession": "absent", "candidates": []}]}
        self.poll(reply(only))
        rows = self.view()["rows"]
        self.assertEqual(["SYN-ONLY · Unlinked · " + PHRASE + " · No Accession"], rows)
        self.assertEqual(OFFLINE_SEED, self.page.evaluate("()=>window.orders"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
