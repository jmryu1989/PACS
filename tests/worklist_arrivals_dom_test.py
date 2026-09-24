# coding: utf-8
"""IF-V11 polling integration coverage with the real main.html startPolling body."""
import json
import os
from pathlib import Path
import unittest

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MAIN = Path(os.environ.get("KIN_ARRIVALS_MAIN", ROOT / "worklist-v0" / "hpacs-lite" / "main.html")).read_text(encoding="utf-8")
ARRIVALS = (ROOT / "worklist-v0" / "hpacs-lite" / "study-arrivals.js").read_text(encoding="utf-8")


def extract_function(source, name):
    start = source.index(f"function {name}(")
    brace = source.index("{", start)
    depth, quote, escaped = 0, None, False
    for index in range(brace, len(source)):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise ValueError(name)


START_POLLING = extract_function(MAIN, "startPolling")
# The poll merges a study's server projection through one shipped rule (it is also what load() and
# the single-study PATCH answers use). Slice the real functions rather than stubbing them: this
# harness asserts that the selected study keeps its drawn version and its local draft, and that
# claim is only worth anything if the product's own rule is what produced it.
PRESERVE = extract_function(MAIN, "preservedLocal")
MERGE = extract_function(MAIN, "mergePolledState")
# S4-U1b: the poll now reports each observation to these; they are sliced, not re-described, so the
# cases below judge the shipped labels and the shipped failure rule.
OBSERVE = "\n".join(extract_function(MAIN, name) for name in ("applyObservation", "markObservationUnavailable", "renderObservation"))
# S4-U2: applyObservation/markObservationUnavailable now hand the same observation to the order
# reconciliation display. Sliced too; its model stays null here unless a case starts it
# (tests/order_reconciliation_dom_test.py does), so the cases below run the same code path as before.
ORDERS = "\n".join(extract_function(MAIN, name) for name in ("applyOrderReconciliation", "renderOrderReconciliation"))
CURRENT = {
    "uid": "1.2.3", "count": 5, "series": 2, "acc": "ACC-1", "id": "PID-1", "name": "Patient",
    "sourcePatientKey": "hospital|patient", "birth": "19800101", "date": "20260912", "sex": "O",
    "modality": "CT", "desc": "Current", "institutionName": "Hospital", "tele": False,
    "state": {"rs": "T", "ss": "Verified", "em": "N", "version": 9, "draft": "SERVER DRAFT", "holder": "reader"},
}

HARNESS = """<!doctype html><html><body>
<span id=\"observation-status\" hidden></span><details id=\"not-observed\" hidden><summary id=\"not-observed-summary\"></summary><div id=\"not-observed-list\"></div></details>
<div id=\"study-receipt\" hidden><span id=\"receipt-assignment\"></span><span id=\"receipt-observation\"></span><span id=\"receipt-gateway\"></span></div>
<details id=\"order-reconciliation\" hidden><summary id=\"order-reconciliation-summary\"></summary><div id=\"order-reconciliation-list\"></div></details>
<table><tbody id=\"rows\"></tbody></table><textarea id=\"findings\">LOCAL FINDINGS</textarea>
<textarea id=\"conclusion\">LOCAL CONCLUSION</textarea><textarea id=\"recommendation\">LOCAL RECOMMENDATION</textarea>
<script>
window.setInterval=fn=>{window.pollCallback=fn;return 7};window.clearInterval=()=>{};
const $=selector=>document.querySelector(selector);let poll=null,pollGeneration=0,pollFails=0,commitEpoch=4,commitInFlight=false,serverMode=true,offline=false,demoMode=false;
let studies=INITIAL,selectedUid='1.2.3',heldUid='1.2.3',appState={'1.2.3':{...INITIAL[0].state,version:3,draft:'LOCAL DRAFT'}};
let nextReply=null,readStarted=0,readResolver=null,toasts=[],renders=0,loadReports=0,buttonUpdates=0,observed=[];
const worklistRefresh={seconds:()=>30},favoriteList={refresh:async()=>{}},studyTagList={refresh:async()=>{}},worklistAlerts={observe:value=>observed.push(value)};
const studyPageClient={busy:false,paused:false,clear(){},read:async options=>{readStarted++;if(window.readError)throw Object.assign(new Error('synthetic observation failure'),window.readError);if(readResolver)return await new Promise(resolve=>window.releaseRead=value=>resolve(value));return structuredClone(nextReply)}};
const assertStudyOwner=()=>{},KinAuth={logout:async()=>{}},goOffline=()=>{};
function applyState(value){return value}function fmtD(value){return value}
function updateNoteSummary(){}function updateReaderAssignment(){}
// Nothing is waiting to converge in these cases; the non-empty set is exercised by
// tests/report_citation_dom_test.py, which drives the same two functions through applyPoll.
const reportConverge=new Set();
PRESERVELOCAL
MERGESTATE
// The shipped fromApi assigns through the same rule, so the rebuild path keeps it too.
function fromApi(s){appState[s.uid]=mergePolledState(s.uid,s.state);return {...s}}
// Starts null: study-arrivals.js is added after this script, and setUp starts the session model.
let studyObservationModel=null;function viewed(){return studies.find(s=>s.uid===selectedUid)}
let orderReconciliationModel=null;
OBSERVESTATE
ORDERSTATE
function syncStudy(uid){const study=studies.find(item=>item.uid===uid),state=appState[uid];if(!study||!state)return;for(const key of ['rs','ss','em','holder','version'])if(state[key]!==undefined)study[key]=state[key]}
function render(){renders++;rows.innerHTML=studies.map(s=>`<tr data-uid="${s.uid}"><td data-count>${s.count}</td><td data-series>${s.series}</td></tr>`).join('')}
function loadReport(){loadReports++}function updateReportButtons(){buttonUpdates++}function toast(message,type){toasts.push({message,type})}
START
window.runPoll=()=>pollCallback();window.start=startPolling;window.setReply=value=>{nextReply=value};window.holdRead=()=>{readResolver=true};
window.snapshot=()=>({studies:structuredClone(studies),state:structuredClone(appState['1.2.3']),toasts:structuredClone(toasts),heldUid,
 report:[findings.value,conclusion.value,recommendation.value],row:rows.textContent,renders,loadReports,buttonUpdates,pollGeneration,commitEpoch});
render();startPolling();
</script></body></html>""".replace("INITIAL", json.dumps([CURRENT], ensure_ascii=False)) \
   .replace("PRESERVELOCAL", PRESERVE).replace("MERGESTATE", MERGE).replace("START", START_POLLING) \
   .replace("OBSERVESTATE", OBSERVE).replace("ORDERSTATE", ORDERS)

OWNER = ["hospital", "reader-sub"]


def reply(*rows, at="2026-09-24T01:00:00.000Z", not_observed=None):
    # The page client's result: the rows, the owner it was read for, and the last page's observation.
    return {"studies": list(rows), "owner": OWNER, "observation": {"observedAt": at, "notObserved": not_observed}}


class WorklistArrivalsDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.set_content(HARNESS)
        self.page.add_script_tag(content=ARRIVALS)
        self.page.evaluate("()=>{studyObservationModel=KinStudyArrivals.observationStart()}")

    def tearDown(self):
        self.page.close()

    def poll(self, value):
        self.page.evaluate("value=>setReply(value)", value)
        self.page.evaluate("runPoll()")
        self.page.wait_for_function("()=>readStarted>0 && !studyPageClient.busy")
        self.page.wait_for_timeout(0)

    def changed(self, count=7, series=3, **state):
        row = json.loads(json.dumps(CURRENT))
        row["count"], row["series"] = count, series
        row["state"].update(state)
        return row

    def test_same_study_additions_update_row_once_and_preserve_selected_report_hold_and_lock_base(self):
        self.poll(reply(self.changed(version=99, draft="REMOTE DRAFT", holder="other")))
        value = self.page.evaluate("snapshot()")
        self.assertEqual((7, 3), (value["studies"][0]["count"], value["studies"][0]["series"]))
        self.assertEqual(["7", "3"], self.page.locator("#rows tr").locator("td").all_text_contents())
        self.assertEqual(3, value["state"]["version"])
        self.assertEqual("LOCAL DRAFT", value["state"]["draft"])
        self.assertEqual(["LOCAL FINDINGS", "LOCAL CONCLUSION", "LOCAL RECOMMENDATION"], value["report"])
        self.assertEqual("1.2.3", value["heldUid"])
        self.assertEqual(1, len(value["toasts"]))
        self.assertIn("추가됐습니다", value["toasts"][0]["message"])

    def test_new_study_and_added_images_share_one_notification_while_new_study_notice_remains(self):
        new_study = self.changed(count=10, series=4)
        new_study.update(uid="1.2.4", id="PID-2", sourcePatientKey="hospital|patient-2")
        self.poll(reply(self.changed(count=6, series=2), new_study))
        value = self.page.evaluate("snapshot()")
        self.assertEqual(2, len(value["studies"]))
        self.assertEqual(1, len(value["toasts"]))
        self.assertIn("새 검사 1건이 도착했습니다", value["toasts"][0]["message"])

    def test_equal_or_decreasing_counts_do_not_notify_again(self):
        self.poll(reply(self.changed(count=5, series=2)))
        self.poll(reply(self.changed(count=4, series=1)))
        self.assertEqual([], self.page.evaluate("snapshot().toasts"))
        self.assertEqual([4, 1], self.page.evaluate("[studies[0].count,studies[0].series]"))

    def test_late_poll_generation_or_commit_epoch_response_cannot_change_counts_or_notify(self):
        for invalidation in ("pollGeneration++", "commitEpoch++"):
            with self.subTest(invalidation=invalidation):
                self.page.evaluate("()=>{readStarted=0;toasts=[];holdRead()}")
                self.page.evaluate("()=>{runPoll()}")
                self.page.wait_for_function("()=>readStarted===1 && typeof releaseRead==='function'")
                self.page.evaluate(invalidation)
                self.page.evaluate("value=>releaseRead(value)", reply(self.changed(count=9, series=4)))
                self.page.wait_for_timeout(0)
                value = self.page.evaluate("snapshot()")
                self.assertEqual((5, 2), (value["studies"][0]["count"], value["studies"][0]["series"]))
                self.assertEqual([], value["toasts"])
                self.page.reload()
                self.page.set_content(HARNESS)
                self.page.add_script_tag(content=ARRIVALS)
                self.page.evaluate("()=>{studyObservationModel=KinStudyArrivals.observationStart()}")

    # ── S4-U1b: the sliced observation functions driven through the real poll ──

    def at(self, minute):
        return "2026-09-24T01:%02d:00.000Z" % minute

    def fail_next(self):
        self.page.evaluate("()=>{readStarted=0;window.readError={status:503}}")
        self.page.evaluate("runPoll()")
        self.page.wait_for_function("()=>readStarted>0")
        self.page.wait_for_timeout(0)
        self.page.evaluate("()=>{window.readError=null;readStarted=0}")

    def text(self, selector):
        return self.page.locator(selector).text_content()

    def test_s4u1b_session_changes_are_labelled_only_between_two_known_observations(self):
        self.poll(reply(self.changed(count=5, series=2), at=self.at(1)))
        self.assertTrue(self.text("#receipt-observation").startswith("KIN 보유 5건("))
        self.assertNotIn("이 세션에서 관측한 변화", self.text("#receipt-observation"))
        self.assertEqual("Institution Assigned", self.text("#receipt-assignment"))
        self.assertEqual("No Gateway Report", self.text("#receipt-gateway"))
        self.poll(reply(self.changed(count=7, series=3), at=self.at(2)))
        self.assertIn("이 세션에서 관측한 변화: 증가(", self.text("#receipt-observation"))
        self.poll(reply(self.changed(count=7, series=3), at=self.at(3)))
        self.assertIn("이 세션에서 관측한 변화 없음(", self.text("#receipt-observation"))
        # known -> unknown resets: no change label and no zero printed for the unknown count.
        self.poll(reply(self.changed(count=None, series=3), at=self.at(4)))
        self.assertTrue(self.text("#receipt-observation").startswith("KIN 보유 개수 모름("))
        self.assertNotIn("이 세션에서 관측한 변화", self.text("#receipt-observation"))
        self.poll(reply(self.changed(count=0, series=3), at=self.at(5)))
        self.assertTrue(self.text("#receipt-observation").startswith("KIN 보유 0건("))
        self.assertNotIn("이 세션에서 관측한 변화", self.text("#receipt-observation"))
        self.assertIn("Observed ", self.text("#observation-status"))
        self.assertNotIn("Needs Check", self.text("#observation-status"))

    def test_s4u1b_failed_poll_keeps_list_count_and_time_and_never_produces_not_observed(self):
        self.poll(reply(self.changed(count=5, series=2), at=self.at(1), not_observed=[]))
        before = self.page.evaluate("snapshot()")
        observed = self.text("#receipt-observation")
        self.fail_next()
        after = self.page.evaluate("snapshot()")
        self.assertEqual(before["studies"], after["studies"])
        self.assertEqual(before["row"], after["row"])
        status = self.text("#observation-status")
        self.assertTrue(status.startswith("관측 불가 · 마지막 관측 "), status)
        self.assertTrue(status.endswith(" 유지"), status)
        self.assertEqual("관측 불가 · 마지막 " + observed, self.text("#receipt-observation"))
        self.assertTrue(self.page.locator("#not-observed").is_hidden())
        self.assertEqual([], self.page.evaluate("studyObservationModel.notObserved"))
        self.assertEqual(self.at(1), self.page.evaluate("studyObservationModel.observedAt"))

    def test_s4u1b_cold_start_failure_shows_only_unavailable_and_invents_no_snapshot(self):
        self.fail_next()
        self.assertEqual("관측 불가", self.text("#observation-status"))
        self.assertEqual("관측 불가", self.text("#receipt-observation"))
        self.assertIsNone(self.page.evaluate("studyObservationModel.observedAt"))
        self.assertIsNone(self.page.evaluate("studyObservationModel.notObserved"))
        self.assertEqual(0, self.page.evaluate("studyObservationModel.rows.size"))
        self.assertTrue(self.page.locator("#not-observed").is_hidden())

    def test_s4u1b_leaving_the_list_is_not_a_decrease_but_a_consecutive_drop_needs_check(self):
        other = self.changed(count=10, series=4)
        other.update(uid="1.2.4", id="PID-2", sourcePatientKey="hospital|patient-2")
        self.poll(reply(self.changed(count=5, series=2), other, at=self.at(1)))
        self.poll(reply(self.changed(count=5, series=2), at=self.at(2)))
        back = json.loads(json.dumps(other)); back["count"] = 4
        self.poll(reply(self.changed(count=5, series=2), back, at=self.at(3)))
        self.assertIsNone(self.page.evaluate("KinStudyArrivals.studyObservation(studyObservationModel,'1.2.4').change"))
        self.assertNotIn("Needs Check", self.text("#observation-status"))
        self.poll(reply(self.changed(count=4, series=2), back, at=self.at(4)))
        self.assertIn("이 세션에서 관측한 변화: 감소(", self.text("#receipt-observation"))
        self.assertIn("Needs Check", self.text("#receipt-observation"))
        self.assertIn("Needs Check 1", self.text("#observation-status"))

    def test_s4u1b_not_observed_is_a_separate_surface_and_survives_a_failure_as_the_last_answer(self):
        absent = [{"uid": "1.2.9", "origin": "gateway", "createdAt": "2026-09-24T00:59:00.000Z"}]
        self.poll(reply(self.changed(count=5, series=2), at=self.at(1), not_observed=absent))
        self.assertTrue(self.page.locator("#not-observed").is_visible())
        self.assertEqual("Not Observed (1)", self.text("#not-observed-summary"))
        self.assertIn("1.2.9 · gateway · ", self.text("#not-observed-list"))
        self.assertEqual(["1.2.3"], self.page.evaluate("studies.map(s=>s.uid)"))
        self.assertEqual(0, self.page.locator('#rows tr[data-uid="1.2.9"]').count())
        self.assertIn("Not Observed 1", self.text("#observation-status"))
        self.fail_next()
        self.assertEqual("Not Observed (1) · 마지막 관측 기준", self.text("#not-observed-summary"))
        self.assertEqual(absent, self.page.evaluate("studyObservationModel.notObserved"))

    # ── S4-U3: the server receipt on axis C, through the same real poll ──

    def receipt_row(self, receipt, count):
        row = self.changed(count=count, series=3)
        row["gatewayReceipt"] = receipt
        return row

    def test_s4u3_receipt_rides_only_a_readable_poll_and_never_promotes_or_fails(self):
        def receipt(phase, m, n, minute, seq):
            return {"phase": phase, "successCount": m, "localCount": n, "attempt": 0, "errorCode": None,
                    "serverReceivedAt": self.at(minute), "agentSeq": seq, "epoch": "0a1b2c3d-0000-4000-8000-00000000000a"}

        # Contract test 10: no receipt is the normal label, never a failure or offline.
        self.poll(reply(self.receipt_row(None, 12), at=self.at(1)))
        self.assertEqual("No Gateway Report", self.text("#receipt-gateway"))
        # The in-place poll path (same list) updates the receipt before it renders.
        self.poll(reply(self.receipt_row(receipt("sending", 3, 12, 1, 7), 12), at=self.at(2)))
        shown = self.text("#receipt-gateway")
        self.assertTrue(shown.startswith("Gateway 보고(") and shown.endswith("): 병원 보유 12건 중 3건 전송"), shown)
        # A failed poll and an unreadable observation both keep the last receipt.
        self.fail_next()
        self.assertEqual(shown, self.text("#receipt-gateway"))
        self.poll(reply(self.receipt_row(receipt("complete", 12, 12, 3, 8), 12), at="yesterday"))
        self.assertEqual(shown, self.text("#receipt-gateway"))
        self.assertEqual(7, self.page.evaluate("studies[0].gatewayReceipt.agentSeq"))
        # Contract test 9: complete 12 of 12, then KIN actually holds 14: the session increase marker shows,
        # the receipt text stays the Gateway's M-of-N, and nothing says complete, received or failed.
        done = receipt("complete", 12, 12, 4, 9)
        self.poll(reply(self.receipt_row(done, 12), at=self.at(4)))
        self.poll(reply(self.receipt_row(done, 14), at=self.at(5)))
        self.assertIn("이 세션에서 관측한 변화: 증가(", self.text("#receipt-observation"))
        shown = self.text("#receipt-gateway")
        self.assertTrue(shown.endswith("): 병원 보유 12건 중 12건 전송"), shown)
        for banned in ("완료", "complete", "received", "실패", "오프라인", "offline"):
            self.assertNotIn(banned, shown + self.text("#receipt-observation"))
        self.assertEqual(done, self.page.evaluate("studies[0].gatewayReceipt"))
        # The rebuild path (a new study arrives) carries the receipt through fromApi too.
        other = self.receipt_row(None, 2)
        other.update(uid="1.2.4", id="PID-2", sourcePatientKey="hospital|patient-2")
        self.poll(reply(self.receipt_row(done, 14), other, at=self.at(6)))
        self.assertEqual([done, None], self.page.evaluate("studies.map(s=>s.gatewayReceipt)"))
        self.assertTrue(self.text("#receipt-gateway").endswith("): 병원 보유 12건 중 12건 전송"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
