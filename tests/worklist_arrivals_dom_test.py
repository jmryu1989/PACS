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
CURRENT = {
    "uid": "1.2.3", "count": 5, "series": 2, "acc": "ACC-1", "id": "PID-1", "name": "Patient",
    "sourcePatientKey": "hospital|patient", "birth": "19800101", "date": "20260912", "sex": "O",
    "modality": "CT", "desc": "Current", "institutionName": "Hospital", "tele": False,
    "state": {"rs": "T", "ss": "Verified", "em": "N", "version": 9, "draft": "SERVER DRAFT", "holder": "reader"},
}

HARNESS = """<!doctype html><html><body>
<table><tbody id=\"rows\"></tbody></table><textarea id=\"findings\">LOCAL FINDINGS</textarea>
<textarea id=\"conclusion\">LOCAL CONCLUSION</textarea><textarea id=\"recommendation\">LOCAL RECOMMENDATION</textarea>
<script>
window.setInterval=fn=>{window.pollCallback=fn;return 7};window.clearInterval=()=>{};
const $=selector=>document.querySelector(selector);let poll=null,pollGeneration=0,pollFails=0,commitEpoch=4,commitInFlight=false,serverMode=true,offline=false,demoMode=false;
let studies=INITIAL,selectedUid='1.2.3',heldUid='1.2.3',appState={'1.2.3':{...INITIAL[0].state,version:3,draft:'LOCAL DRAFT'}};
let nextReply=null,readStarted=0,readResolver=null,toasts=[],renders=0,loadReports=0,buttonUpdates=0,observed=[];
const worklistRefresh={seconds:()=>30},favoriteList={refresh:async()=>{}},studyTagList={refresh:async()=>{}},worklistAlerts={observe:value=>observed.push(value)};
const studyPageClient={busy:false,paused:false,clear(){},read:async options=>{readStarted++;if(readResolver)return await new Promise(resolve=>window.releaseRead=value=>resolve(value));return structuredClone(nextReply)}};
const assertStudyOwner=()=>{},KinAuth={logout:async()=>{}},goOffline=()=>{};
function applyState(value){return value}function fmtD(value){return value}
function updateNoteSummary(){}function updateReaderAssignment(){}
function fromApi(s){appState[s.uid]={...appState[s.uid],...s.state};return {...s}}
function syncStudy(uid){const study=studies.find(item=>item.uid===uid),state=appState[uid];if(!study||!state)return;for(const key of ['rs','ss','em','holder','version'])if(state[key]!==undefined)study[key]=state[key]}
function render(){renders++;rows.innerHTML=studies.map(s=>`<tr data-uid="${s.uid}"><td data-count>${s.count}</td><td data-series>${s.series}</td></tr>`).join('')}
function loadReport(){loadReports++}function updateReportButtons(){buttonUpdates++}function toast(message,type){toasts.push({message,type})}
START
window.runPoll=()=>pollCallback();window.start=startPolling;window.setReply=value=>{nextReply=value};window.holdRead=()=>{readResolver=true};
window.snapshot=()=>({studies:structuredClone(studies),state:structuredClone(appState['1.2.3']),toasts:structuredClone(toasts),heldUid,
 report:[findings.value,conclusion.value,recommendation.value],row:rows.textContent,renders,loadReports,buttonUpdates,pollGeneration,commitEpoch});
render();startPolling();
</script></body></html>""".replace("INITIAL", json.dumps([CURRENT], ensure_ascii=False)).replace("START", START_POLLING)


def reply(*rows):
    return {"studies": list(rows)}


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
