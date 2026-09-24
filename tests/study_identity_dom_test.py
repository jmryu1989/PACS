# coding: utf-8
"""TEST-S4-U5-STUDY-IDENTITY DOM: the shipped panel and correction paths of main.html, sliced and driven in Chromium.

Two harnesses, both built from the real main.html text (tests/worklist_arrivals_dom_test.py's scanner):
  A. tests/worklist_arrivals_dom_test.py's poll harness (the real startPolling, applyObservation,
     markObservationUnavailable, renderObservation and now applyStudyIdentity/renderStudyIdentity) with the shipped
     panel markup added: cases 01-04 go through the real poll, including a stale answer after a Match (A->B->A too).
  B. the correction paths themselves (applyState, the two escaped cells, saveApp, saveModify, openModify, doMatch,
     doUnmatch, refreshOrders and the panel functions) with recorded stand-ins for api(), load() and the Order List.
Each discriminating case also runs the b6a317c code it replaces (in-test controls) and requires that old code to show
the defect, so a green run here is not a tautology. Hosted only; no server, database or clinical data.
"""
import json
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright

import worklist_arrivals_dom_test as arrivals

ROOT = Path(__file__).resolve().parents[1]
MAIN = arrivals.MAIN.replace("\r\n", "\n")
IDENTITY_JS = (ROOT / "worklist-v0" / "hpacs-lite" / "study-identity.js").read_text(encoding="utf-8")
extract_function = arrivals.extract_function


def between(source, start, end):
    head = source.index(start)
    return source[head:source.index(end, head + len(start))]


def statement(source, head):
    """A top-level `const` statement from its first line through the line that ends it."""
    start = source.index(head)
    return source[start:source.index(";\n", start) + 1]


def cell(name):
    block = between(MAIN, "    const CELL = {", "\n    };")
    return next(line for line in block.split("\n") if line.startswith("      %s: s => " % name))


PANEL = between(MAIN, '<details id="study-identity"', "</details>") + "</details>"
MODAL = between(MAIN, '<div class="modal" id="modal">', '\n  <div class="modal" id="reasonmodal">')

# The b6a317c lines each case replaces; the controls below put them back and require the old defect.
OLD_APPLY = "      if (a.ov) Object.assign(s, a.ov);"
NEW_APPLY = "      for (const key of OVERLAY_KEYS) if (overlayValue(key, a.ov?.[key])) s[key] = a.ov[key];"
OLD_CELLS = {"ts": '      ts: s => `<span class="ts ts-${s.ts}">${s.ts}</span>`,',
             "matched": '      matched: s => `<span class="mt ${s.matched}">${s.matched}</span>`,'}
NEW_RESTORE = ("          const read = studyIdentityModel ? KinStudyIdentity.tags(studyIdentityModel, s.uid) : null;\n"
               "          if (read) Object.assign(s, { id: read.id, name: read.name, sex: read.sex, birth: fmtD(read.birth),\n"
               "            age: ageOf(fmtD(read.birth), s.date), desc: read.desc });\n")
OLD_RESTORE = "          if (st.orig) Object.assign(s, st.orig);\n"
# Inside doMatch only (doUnmatch has the same line): the invalidation U5 added after an accepted Match.
MATCH_INVALIDATION = "        commitEpoch++; listLoadSequence++;\n"
# The b6a317c Modify Exam listener body, verbatim: it painted and announced before the PATCH answer.
OLD_MODIFY = """function oldModifySave() {
      const s = cur(); if (!s) return;
      const a = appState[s.uid] ??= {};
      a.orig ??= { id: s.id, name: s.name, sex: s.sex, birth: s.birth, age: s.age, desc: s.desc, ward: s.ward };
      const birth = $("#m-birth").value.trim();
      a.ov = { ...(a.ov ?? {}),
        id: $("#m-id").value.trim(), name: $("#m-name").value.trim(), sex: $("#m-sex").value,
        birth, age: ageOf(birth, s.date), desc: $("#m-desc").value.trim(), ward: $("#m-ward").value.trim() };
      Object.assign(s, a.ov);
      saveApp(s.uid, { ov: a.ov });
      $("#modal").classList.remove("show");
      render(); renderClinical(); renderRelated(); renderOrders();
      toast("검사 정보를 수정했습니다");
    }"""

for needle in (NEW_APPLY, NEW_RESTORE):
    assert MAIN.count(needle) == 1, needle
assert extract_function(MAIN, "doMatch").count(MATCH_INVALIDATION) == 1
assert extract_function(MAIN, "doUnmatch").count(NEW_RESTORE) == 1

SHARED = "\n".join([
    statement(MAIN, "    const OVERLAY_KEYS = "), statement(MAIN, "    const overlayValue = "),
    extract_function(MAIN, "ageOf"), extract_function(MAIN, "noteIdentityCorrection"),
    "async " + extract_function(MAIN, "refreshOrders"),
])


def corrections(old_match=False, old_unmatch=False):
    match = "async " + extract_function(MAIN, "doMatch")
    unmatch = "async " + extract_function(MAIN, "doUnmatch")
    if old_match:
        match = match.replace(MATCH_INVALIDATION, "")
    if old_unmatch:
        unmatch = unmatch.replace(NEW_RESTORE, OLD_RESTORE)
    return match + "\n" + unmatch


# Harness A additions: what doMatch/doUnmatch need beside the poll harness (which already has api, toast, render,
# fmtD, appState, studies, commitEpoch and the panel functions).
POLL_EXTRA = """
let listLoadSequence=0,orders=[],selectedOid=null,myInstitution='hallym',orderRefreshSequence=0,loads=[],alerts=[],orderRenders=0;
window.alert=message=>alerts.push(message);window.confirm=()=>true;
function cur(){return studies.find(s=>s.uid===selectedUid)}function curOrder(){return orders.find(o=>o.oid===selectedOid)}
function load(){loads.push({commitEpoch,listLoadSequence})}function renderOrders(){orderRenders++}
function renderClinical(){renderStudyIdentity()}function renderRelated(){}function saveOrders(){}function saveApp(){}
SHARED
CORRECTIONS
"""

LINKED = {"source": "engineering_only", "oid": "SYN-U5-E", "accession": "match", "patientId": "mismatch",
          "patientName": "match", "birth": "match", "sex": "not_comparable"}
READ_PANEL = """()=>{const q=s=>document.querySelector(s);return {hidden:q('#study-identity').hidden,open:q('#study-identity').open,
  summary:q('#study-identity-summary').textContent,summaryTitle:q('#study-identity-summary').title,
  order:q('#study-identity-order').textContent,orderTitle:q('#study-identity-order').title,
  tags:[...document.querySelectorAll('#study-identity-tags > div')].map(d=>d.textContent),
  titles:[...document.querySelectorAll('#study-identity-tags > div > span:last-child')].map(s=>s.title),
  guidance:q('#study-identity-guidance').textContent}}"""
LINKED_TAGS = ["(0020,000D) Study Instance UID: 1.2.3", "(0008,0050) Accession Number: ACC-1 · Same Value",
               "(0010,0020) Patient ID: PID-1 · Different Value", "(0010,0010) Patient Name · Alphabetic: Patient · Same Value",
               "(0010,0030) Patient Birth Date: 19800101 · Same Value", "(0010,0040) Patient Sex: O · Not Comparable",
               "(0008,1030) Study Description: Current · Not Compared"]


def row(uid="1.2.3", identity=LINKED, matched="M", oid="SYN-U5-E", **over):
    value = json.loads(json.dumps(arrivals.CURRENT))
    value.update(uid=uid, orderIdentity=identity, **over)
    value["state"].update(matched=matched, oid=oid)
    return value


def at(minute):
    return "2026-09-25T01:%02d:00.000Z" % minute


class Browser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def tearDown(self):
        self.page.close()
        self.assertEqual([], self.errors)

    def open(self, html, *scripts):
        self.errors = []
        self.page = self.browser.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.set_content(html)
        for script in scripts:
            self.page.add_script_tag(content=script)

    def panel(self):
        return self.page.evaluate(READ_PANEL)


class PollPanelDOMTest(Browser):
    """Harness A: the real poll feeds the panel."""

    def setUp(self, old_match=False, old_unmatch=False):
        self.open(arrivals.HARNESS, arrivals.ARRIVALS, IDENTITY_JS,
                  POLL_EXTRA.replace("SHARED", SHARED).replace("CORRECTIONS", corrections(old_match, old_unmatch)))
        self.page.evaluate("html=>document.body.insertAdjacentHTML('afterbegin',html)", PANEL)
        self.page.evaluate("()=>{studyObservationModel=KinStudyArrivals.observationStart();studyIdentityModel=KinStudyIdentity.start();"
                           "appState['1.2.3']={...appState['1.2.3'],matched:'M',oid:'SYN-U5-E'};studies[0].matched='M'}")

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

    def test_s4u5_01_panel_shows_server_read_tags_not_the_overlaid_row_with_marker_and_badges(self):
        self.assertTrue(self.panel()["hidden"], "nothing before an observation")
        # The worklist row object carries a display overlay; the panel must not read it.
        self.page.evaluate("()=>{studies[0].name='OVERLAY NAME';studies[0].id='OVERLAY-ID'}")
        self.poll(arrivals.reply(row(), at=at(1)))
        seen = self.panel()
        self.assertFalse(seen["hidden"])
        self.assertFalse(seen["open"], "collapsed by default")
        self.assertEqual("DICOM Identity · Patient Mismatch", seen["summary"])
        self.assertEqual("Linked Order SYN-U5-E · Engineering Only", seen["order"])
        self.assertEqual(LINKED_TAGS, seen["tags"])
        self.assertNotIn("OVERLAY", json.dumps(seen, ensure_ascii=False))
        self.assertEqual("OVERLAY NAME", self.page.evaluate("studies[0].name"))
        self.assertIn("같은 환자임을 확인한 것은 아닙니다", seen["titles"][1])
        self.assertIn("Alphabetic 그룹만 읽고", seen["titles"][3])
        # The harness row is at RS T (its report fixture), so a Different Value brings the RS guidance, not Unmatch.
        self.assertEqual(self.page.evaluate("KinStudyIdentity.guidance('T',true,false)"), seen["guidance"])
        self.assertTrue(self.page.locator("#observation-status").text_content().startswith("Observed "))

    def test_s4u5_02_failure_keeps_the_last_answer_and_a_cold_failure_invents_nothing(self):
        self.fail_next()
        cold = self.panel()
        self.assertEqual((False, "DICOM Identity · 관측 불가", "", []), (cold["hidden"], cold["summary"], cold["order"], cold["tags"]))
        self.poll(arrivals.reply(row(), at=at(2)))
        self.fail_next()
        kept = self.panel()
        self.assertTrue(kept["summary"].startswith("DICOM Identity · Patient Mismatch · 관측 불가 · 마지막 관측 "), kept["summary"])
        self.assertTrue(kept["summary"].endswith(" 기준"), kept["summary"])
        self.assertEqual(LINKED_TAGS, kept["tags"])
        self.assertEqual("Linked Order SYN-U5-E · Engineering Only", kept["order"])

    def test_s4u5_03_an_unreadable_answer_is_unknown_never_same_value(self):
        for bad in ({**LINKED, "source": "interface"}, {**LINKED, "patientId": "same"}, {**LINKED, "extra": "x"}):
            with self.subTest(bad=bad):
                self.poll(arrivals.reply(row(identity=bad), at=at(3)))
                shown = self.panel()
                self.assertEqual("Unknown", shown["order"])
                self.assertEqual("DICOM Identity", shown["summary"])
                self.assertNotIn("Same Value", json.dumps(shown, ensure_ascii=False))
        self.poll(arrivals.reply(row(uid="1.2.3", tele=True, identity=None), at=at(4)))
        self.assertEqual("Tele-received · Not Compared", self.panel()["order"])

    def test_s4u5_04_a_list_answer_requested_before_match_is_not_reinstalled_and_unmatch_clears_at_once(self):
        self.page.evaluate("()=>{appState['1.2.3']={...appState['1.2.3'],matched:'U',oid:null};studies[0].matched='U'}")
        self.poll(arrivals.reply(row(identity=None, matched="U", oid=None), at=at(1)))
        self.assertEqual("No Linked Order", self.panel()["order"])
        # An older poll is in flight when the Match answer arrives.
        self.page.evaluate("()=>{readStarted=0;holdRead()}")
        self.page.evaluate("()=>{runPoll()}")
        self.page.wait_for_function("()=>readStarted===1 && typeof releaseRead==='function'")
        self.page.evaluate("()=>{orders=[{oid:'SYN-U5-E',id:'PID-1',name:'Patient',sex:'O',birth:'1980-01-01',sched:'x',desc:'',ward:'',matched:'U',studyUid:null}];"
                           "selectedOid='SYN-U5-E';window.matchDone=doMatch()}")
        self.page.wait_for_function("()=>apiCalls.length===1")
        self.assertEqual("/match", self.page.evaluate("apiCalls[0].path"))
        self.page.evaluate("v=>settleApi(true,v)", {"rs": "W", "matched": "M", "oid": "SYN-U5-E", "ward": "", "orig": None,
                                                   "ov": {"id": "PID-1", "name": "Patient", "sex": "O", "birth": "1980-01-01", "age": 46, "desc": "", "ward": ""}})
        self.page.wait_for_function("()=>loads.length===1 && apiCalls.length===2")
        self.assertEqual("/bootstrap?states=omit", self.page.evaluate("apiCalls[1].path"))
        self.assertEqual({"commitEpoch": 5, "listLoadSequence": 1}, self.page.evaluate("loads[0]"), "invalidated before the new read")
        self.assertEqual("Unknown", self.panel()["order"], "the new link has no answer yet")
        self.page.evaluate("value=>releaseRead(value)", arrivals.reply(row(identity=None, matched="U", oid=None), at=at(2)))
        self.page.wait_for_timeout(0)
        self.page.evaluate("()=>{readResolver=null}")
        self.assertEqual("M", self.page.evaluate("appState['1.2.3'].matched"), "the older answer was dropped")
        self.assertEqual("Unknown", self.panel()["order"])
        self.page.evaluate("v=>settleApi(true,v)", {"me": {"institution": "hallym"},
                                                   "orders": [{"oid": "SYN-U5-E", "matched": "M", "studyUid": "1.2.3"}]})
        self.page.wait_for_function("()=>orders[0].studyUid==='1.2.3'")
        self.assertEqual("SYN-U5-E", self.page.evaluate("selectedOid"))
        self.poll(arrivals.reply(row(), at=at(3)))
        linked = self.panel()
        self.assertEqual(("Linked Order SYN-U5-E · Engineering Only", "DICOM Identity · Patient Mismatch"), (linked["order"], linked["summary"]))
        # Unmatch: the badge goes at once and the row returns to the server-read values, never the claimed orig.
        self.page.evaluate("()=>{studies[0].name='ORDER NAME FROM OV';window.unmatchDone=doUnmatch()}")
        self.page.wait_for_function("()=>apiCalls.length===3")
        self.page.evaluate("v=>settleApi(true,v)", {"rs": "W", "matched": "U", "oid": None, "ov": None,
                                                   "orig": {"name": "FORGED-ORIG", "id": "FORGED-ORIG-ID"}})
        self.page.wait_for_function("()=>loads.length===2")
        cleared = self.panel()
        self.assertEqual(("No Linked Order", "DICOM Identity"), (cleared["order"], cleared["summary"]))
        self.assertEqual(["Patient", "PID-1", "O", "Current"], self.page.evaluate("[studies[0].name,studies[0].id,studies[0].sex,studies[0].desc]"))
        self.assertEqual(46, self.page.evaluate("studies[0].age"), "age recomputed from the server-read birth (N-8)")
        self.assertEqual({"commitEpoch": 6, "listLoadSequence": 2}, self.page.evaluate("loads[1]"))
        self.assertEqual([], self.page.evaluate("alerts"))

    def test_s4u5_04b_control_the_old_match_answer_lets_the_older_list_answer_back_in(self):
        self.tearDown()
        self.setUp(old_match=True)
        self.page.evaluate("()=>{appState['1.2.3']={...appState['1.2.3'],matched:'U',oid:null};studies[0].matched='U'}")
        self.page.evaluate("()=>{readStarted=0;holdRead()}")
        self.page.evaluate("()=>{runPoll()}")
        self.page.wait_for_function("()=>readStarted===1 && typeof releaseRead==='function'")
        self.page.evaluate("()=>{orders=[{oid:'SYN-U5-E',id:'PID-1',name:'Patient',sex:'O',birth:'1980-01-01',sched:'x',desc:'',ward:'',matched:'U',studyUid:null}];"
                           "selectedOid='SYN-U5-E';window.matchDone=doMatch()}")
        self.page.wait_for_function("()=>apiCalls.length===1")
        self.page.evaluate("v=>settleApi(true,v)", {"rs": "W", "matched": "M", "oid": "SYN-U5-E", "ward": "", "orig": None, "ov": None})
        self.page.wait_for_function("()=>loads.length===1")
        self.page.evaluate("value=>releaseRead(value)", arrivals.reply(row(identity=None, matched="U", oid=None), at=at(2)))
        # b6a317c: the pre-match answer is merged back over the accepted Match (the wait fails if it is not).
        self.page.wait_for_function("()=>appState['1.2.3'].matched==='U'", timeout=5000)
        self.assertEqual("M", self.page.evaluate("studies[0].matched"), "the row itself was painted from the Match answer")

    def test_s4u5_06_control_the_old_unmatch_paints_the_claimed_orig(self):
        self.tearDown()
        self.setUp(old_unmatch=True)
        self.poll(arrivals.reply(row(), at=at(1)))
        self.page.evaluate("()=>{window.unmatchDone=doUnmatch()}")
        self.page.wait_for_function("()=>apiCalls.length===1")
        self.page.evaluate("v=>settleApi(true,v)", {"rs": "W", "matched": "U", "oid": None, "ov": None, "orig": {"name": "FORGED-ORIG"}})
        self.page.wait_for_function("()=>loads.length===1")
        self.assertEqual("FORGED-ORIG", self.page.evaluate("studies[0].name"), "b6a317c painted the client-claimed orig")

    def test_s4u5_04c_a_to_b_to_a_never_draws_one_study_in_the_other(self):
        other = row(uid="1.2.4", identity=None, matched="U", oid=None, id="PID-2", name="Other", acc="ACC-2", desc="Other")
        self.poll(arrivals.reply(row(), other, at=at(1)))
        a = self.panel()
        self.page.evaluate("()=>{selectedUid='1.2.4';renderStudyIdentity()}")
        b = self.panel()
        self.assertEqual("No Linked Order", b["order"])
        self.assertIn("(0010,0020) Patient ID: PID-2", b["tags"])
        self.assertNotIn("PID-1", json.dumps(b))
        self.page.evaluate("()=>{selectedUid='1.2.3';renderStudyIdentity()}")
        self.assertEqual(a, self.panel())

    def test_s4u5_05b_a_superseded_poll_answer_changes_nothing(self):
        self.page.evaluate("()=>{readStarted=0;holdRead()}")
        self.page.evaluate("()=>{runPoll()}")
        self.page.wait_for_function("()=>readStarted===1 && typeof releaseRead==='function'")
        self.page.evaluate("pollGeneration++")
        self.page.evaluate("value=>releaseRead(value)", arrivals.reply(row(), at=at(1)))
        self.page.wait_for_timeout(0)
        self.assertTrue(self.panel()["hidden"])


# Harness B: the correction paths with recorded stand-ins.
CORRECTION_PAGE = """<!doctype html><html><body>
PANEL
MODAL
<table><tbody id="rows"></tbody></table>
<script>
const $=selector=>document.querySelector(selector);
let serverMode=true,offline=false,demoMode=false,commitEpoch=0,listLoadSequence=0,selectedUid='2.25.501',selectedOid=null;
let myInstitution='hallym',orderRefreshSequence=0,studies=[],appState={},orders=[],studyIdentityModel=null;
let apiCalls=[],pending=[],toasts=[],alerts=[],loads=[],orderRenders=[];
const reportConverge=new Set();
function api(method,path,body){apiCalls.push({method,path,body:body===undefined?null:JSON.parse(JSON.stringify(body))});
  return new Promise((resolve,reject)=>pending.push({resolve,reject}))}
window.answer=(ok,value)=>{const next=pending.shift();if(!next)throw new Error('no pending api call');
  if(ok)next.resolve(value);else next.reject(Object.assign(new Error(value.message),value))};
function toast(message,kind='ok'){toasts.push({message,kind})}
window.alert=message=>alerts.push(message);window.confirm=()=>true;
function load(){loads.push({commitEpoch,listLoadSequence})}
function renderOrders(){orderRenders.push(orders.map(o=>o.oid+':'+o.matched))}
function renderRelated(){}function refreshRight(){}function saveOrders(){}
function cur(){return studies.find(s=>s.uid===selectedUid)}function curOrder(){return orders.find(o=>o.oid===selectedOid)}
function viewed(){return cur()}
ESC
FMTD
STATEKEYS
SHARED
const CELL={
CELLTS
CELLMATCHED
};
// The two lines of main.html render() that draw a row cell: CELL output as markup, everything else escaped.
function render(){$('#rows').innerHTML=studies.map(s=>'<tr data-uid="'+esc(s.uid)+'">'+['matched','ts','id','name'].map(k=>
  '<td data-k="'+k+'">'+(CELL[k]?CELL[k](s):esc(s[k]??''))+'</td>').join('')+'</tr>').join('');renderStudyIdentity()}
function renderClinical(){renderStudyIdentity()}
FUNCTIONS
MODIFYBIND
</script></body></html>"""


def correction_page(apply_state=None, cells=None, modify=None):
    functions = [apply_state or extract_function(MAIN, "applyState")]
    for name in ("saveApp", "apiFail", "preservedLocal", "mergePolledState", "syncStudy", "applyStudyIdentity",
                 "renderStudyIdentity", "openModify"):
        functions.append(extract_function(MAIN, name))
    functions.append("async " + extract_function(MAIN, "saveModify"))
    functions.append(corrections())
    if modify:
        functions.append(modify)
    cells = cells or {}
    return (CORRECTION_PAGE.replace("PANEL", PANEL).replace("MODAL", MODAL)
            .replace("ESC", statement(MAIN, "    const esc = v => "))
            .replace("FMTD", statement(MAIN, "    const fmtD = d => "))
            .replace("STATEKEYS", statement(MAIN, "    const STATE_KEYS = "))
            .replace("SHARED", SHARED)
            .replace("CELLTS", cells.get("ts", cell("ts"))).replace("CELLMATCHED", cells.get("matched", cell("matched")))
            .replace("FUNCTIONS", "\n".join(functions))
            .replace("MODIFYBIND", "$('#m-save').addEventListener('click',%s);" % ("oldModifySave" if modify else "saveModify")))


QIDO_ROW = {"uid": "2.25.501", "acc": "SYN-ACC", "id": "QIDO-ID", "name": "QIDO NAME", "birth": "19800101", "sex": "O",
            "desc": "D", "tele": False, "orderIdentity": None, "state": {}}
SETUP = """state=>{appState['2.25.501']=state;studies=[applyState({uid:'2.25.501',id:'QIDO-ID',name:'QIDO NAME',sex:'O',
  birth:'1980-01-01',date:'2026-09-25',desc:'D',ward:'',sourcePatientKey:'hallym|QIDO-ID'})];
  studyIdentityModel=KinStudyIdentity.start();render()}"""


class CorrectionDOMTest(Browser):
    """Harness B: the correction paths wait for the server and repaint only from it."""

    def start(self, state, **page):
        self.open(correction_page(**page), IDENTITY_JS)
        self.page.evaluate(SETUP, state)

    def observe(self, identity=None, matched="U", oid=None):
        self.page.evaluate("row=>applyStudyIdentity({studies:[row],owner:['hallym','sub'],observation:{observedAt:'2026-09-25T01:00:00.000Z'}})",
                           {**QIDO_ROW, "orderIdentity": identity, "state": {"matched": matched, "oid": oid}})

    def test_s4u5_05_modify_refusal_paints_nothing_keeps_the_input_and_says_the_next_step(self):
        self.start({"rs": "W", "matched": "U", "oid": None, "ov": None, "ts": "none"})
        self.page.evaluate("openModify()")
        self.page.fill("#m-name", "TYPED NAME")
        self.page.click("#m-save")
        self.page.wait_for_function("()=>apiCalls.length===1")
        before = self.page.evaluate("()=>({name:studies[0].name,toasts,show:$('#modal').classList.contains('show'),disabled:$('#m-save').disabled,row:$('#rows').textContent})")
        self.assertEqual(("QIDO NAME", [], True, True), (before["name"], before["toasts"], before["show"], before["disabled"]),
                         "nothing is painted or announced before the answer")
        self.assertNotIn("TYPED NAME", before["row"])
        call = self.page.evaluate("apiCalls[0]")
        self.assertEqual(("PATCH", "/studies/2.25.501"), (call["method"], call["path"]))
        self.assertEqual({"id": "QIDO-ID", "name": "TYPED NAME", "sex": "O", "birth": "1980-01-01", "age": 46, "desc": "D", "ward": ""}, call["body"]["ov"])
        refusal = "판독 전(RS: W)인 검사만 환자·검사 정보를 수정할 수 있습니다 (현재 RS: T)"
        self.page.evaluate("m=>answer(false,{message:m,status:400})", refusal)
        self.page.wait_for_function("()=>apiCalls.length===2")
        self.assertEqual("/studies", self.page.evaluate("apiCalls[1].path"))
        self.page.evaluate("()=>answer(true,{studies:[{uid:'2.25.501',state:{rs:'T',matched:'U',oid:null,ov:null}}]})")
        self.page.wait_for_function("()=>!$('#m-guidance').hidden")
        after = self.page.evaluate("()=>({name:studies[0].name,rs:studies[0].rs,toasts,show:$('#modal').classList.contains('show'),"
                                   "typed:$('#m-name').value,guidance:$('#m-guidance').textContent,disabled:$('#m-save').disabled,loads})")
        self.assertEqual(("QIDO NAME", "T", True, "TYPED NAME", False, []),
                         (after["name"], after["rs"], after["show"], after["typed"], after["disabled"], after["loads"]))
        self.assertEqual([{"message": "서버 저장 실패: " + refusal, "kind": "err"}], after["toasts"], "the server wording, and no success")
        self.assertEqual(self.page.evaluate("KinStudyIdentity.guidance('T',true,false)"), after["guidance"])
        self.assertIn("(현재 RS: T)", after["guidance"])

    def test_s4u5_05_modify_success_repaints_from_the_server_overlay_and_invalidates(self):
        self.start({"rs": "W", "matched": "U", "oid": None, "ov": None, "ts": "none"})
        self.page.evaluate("openModify()")
        self.page.fill("#m-name", "ACCEPTED NAME")
        self.page.click("#m-save")
        self.page.wait_for_function("()=>apiCalls.length===1")
        server_ov = {"id": "QIDO-ID", "name": "ACCEPTED NAME", "sex": "O", "birth": "1980-01-01", "age": 46, "desc": "D", "ward": "",
                     "rs": "A", "matched": "M"}
        self.page.evaluate("ov=>answer(true,{rs:'W',matched:'U',oid:null,ts:'none',ov})", server_ov)
        self.page.wait_for_function("()=>toasts.length===1")
        done = self.page.evaluate("()=>({name:studies[0].name,rs:studies[0].rs,matched:studies[0].matched,toasts,"
                                  "show:$('#modal').classList.contains('show'),loads})")
        self.assertEqual(("ACCEPTED NAME", "W", "U", False), (done["name"], done["rs"], done["matched"], done["show"]))
        self.assertEqual([{"message": "검사 정보를 수정했습니다", "kind": "ok"}], done["toasts"])
        self.assertEqual([{"commitEpoch": 1, "listLoadSequence": 1}], done["loads"])

    def test_s4u5_05c_control_the_old_modify_painted_and_announced_before_the_answer(self):
        self.start({"rs": "W", "matched": "U", "oid": None, "ov": None, "ts": "none"}, modify=OLD_MODIFY)
        self.page.evaluate("openModify()")
        self.page.fill("#m-name", "TYPED NAME")
        self.page.click("#m-save")
        self.page.wait_for_function("()=>apiCalls.length===1")
        early = self.page.evaluate("()=>({name:studies[0].name,toasts})")
        self.assertEqual("TYPED NAME", early["name"], "b6a317c painted before the answer")
        self.assertEqual([{"message": "검사 정보를 수정했습니다", "kind": "ok"}], early["toasts"])

    def test_s4u5_07_forged_overlay_keys_and_markup_never_reach_row_state_or_markup(self):
        forged = {"rs": "A", "matched": "U", "oid": None, "ts": "none",
                  "ov": {"matched": "<img data-u5-probe>", "rs": "W", "uid": "1.2.3", "sourcePatientKey": "x",
                         "ts": "<img data-u5-probe>", "name": "LEGIT OVERLAY", "id": "LEGIT-ID", "age": 46}}
        self.start(forged)
        shown = self.page.evaluate("()=>({s:studies[0],probes:document.querySelectorAll('img[data-u5-probe]').length})")
        self.assertEqual(0, shown["probes"])
        s = shown["s"]
        self.assertEqual(("A", "U", "2.25.501", "hallym|QIDO-ID", "none"), (s["rs"], s["matched"], s["uid"], s["sourcePatientKey"], s["ts"]))
        # The legitimate overlay still shows, and Copy Patient ID (which reads s.id) still copies the overlaid ID.
        self.assertEqual(("LEGIT OVERLAY", "LEGIT-ID", 46), (s["name"], s["id"], s["age"]))
        # A server value that is markup is escaped in the two cells that used to interpolate raw.
        self.page.evaluate("()=>{studies[0].matched='<img data-u5-probe>';studies[0].ts='<img data-u5-probe>';render()}")
        self.assertEqual(0, self.page.evaluate("document.querySelectorAll('img[data-u5-probe]').length"))
        self.assertIn("<img data-u5-probe>", self.page.locator('#rows td[data-k="matched"]').text_content())

    def test_s4u5_07c_control_the_old_overlay_and_cells_inject_and_repaint_row_state(self):
        forged = {"rs": "A", "matched": "U", "oid": None, "ts": "none",
                  "ov": {"matched": "<img data-u5-probe>", "rs": "W", "sourcePatientKey": "x"}}
        self.start(forged, apply_state=extract_function(MAIN, "applyState").replace(NEW_APPLY, OLD_APPLY), cells=OLD_CELLS)
        shown = self.page.evaluate("()=>({s:studies[0],probes:document.querySelectorAll('img[data-u5-probe]').length})")
        self.assertEqual(1, shown["probes"], "b6a317c rendered the stored markup")
        self.assertEqual(("W", "x"), (shown["s"]["rs"], shown["s"]["sourcePatientKey"]), "b6a317c let the overlay repaint row state")

    def test_s4u5_08_a_refused_match_reads_the_order_list_again_and_only_the_latest_answer_counts(self):
        self.start({"rs": "A", "matched": "U", "oid": None, "ov": None, "ts": "none"})
        self.observe()
        self.page.evaluate("()=>{orders=[{oid:'O-1',matched:'U',studyUid:null,id:'P',name:'N',sex:'M',birth:'1980-01-01',desc:'',ward:''}];selectedOid='O-1';window.done=doMatch()}")
        self.page.wait_for_function("()=>apiCalls.length===1")
        # The claimed original is sent in the overlay shape only (the row has no computed age, so none is sent).
        self.assertEqual({"age": 46, "orig": {"id": "QIDO-ID", "name": "QIDO NAME", "sex": "O", "birth": "1980-01-01", "desc": "D", "ward": ""}},
                         self.page.evaluate("apiCalls[0].body.patient"))
        refusal = "판독 전(RS: W)인 검사만 매칭할 수 있습니다 (현재 RS: A)"
        self.page.evaluate("m=>answer(false,{message:m,status:400})", refusal)
        self.page.wait_for_function("()=>apiCalls.length===2")
        self.assertEqual(["매칭 실패: " + refusal], self.page.evaluate("alerts"), "the existing alert, unchanged")
        self.assertEqual("/bootstrap?states=omit", self.page.evaluate("apiCalls[1].path"))
        guidance = self.panel()["guidance"]
        self.assertEqual(self.page.evaluate("KinStudyIdentity.guidance('A',true,false)"), guidance)
        for word in ("Reset", "판독 취소", "Addendum", "재작성"):
            self.assertNotIn(word, guidance)
        # A second refresh overtakes the first: the older answer changes nothing, the newer one replaces the list.
        self.page.evaluate("()=>{window.second=refreshOrders()}")
        self.page.wait_for_function("()=>apiCalls.length===3")
        self.page.evaluate("()=>answer(true,{me:{institution:'hallym'},orders:[{oid:'OLD',matched:'U',studyUid:null}]})")
        self.page.wait_for_timeout(0)
        self.assertEqual(["O-1"], self.page.evaluate("orders.map(o=>o.oid)"))
        self.page.evaluate("()=>answer(true,{me:{institution:'hallym'},orders:[{oid:'O-1',matched:'M',studyUid:'2.25.777'},{oid:'O-2',matched:'U',studyUid:null}]})")
        self.page.wait_for_function("()=>orders.length===2")
        self.assertEqual(("O-1", ["O-1:M", "O-2:U"]), (self.page.evaluate("selectedOid"), self.page.evaluate("orderRenders.at(-1)")))
        # Another institution's answer (an account switch) is refused and the list is kept; a vanished order is deselected.
        self.page.evaluate("()=>{window.third=refreshOrders()}")
        self.page.wait_for_function("()=>apiCalls.length===4")
        self.page.evaluate("()=>answer(true,{me:{institution:'kin-center'},orders:[]})")
        self.page.wait_for_function("()=>toasts.some(t=>t.kind==='err')")
        self.assertEqual(2, self.page.evaluate("orders.length"))
        self.page.evaluate("()=>{window.fourth=refreshOrders()}")
        self.page.wait_for_function("()=>apiCalls.length===5")
        self.page.evaluate("()=>answer(true,{me:{institution:'hallym'},orders:[{oid:'O-2',matched:'U',studyUid:null}]})")
        self.page.wait_for_function("()=>orders.length===1")
        self.assertIsNone(self.page.evaluate("selectedOid"))
        # Without a server it only redraws: no request and no stored list is read.
        self.page.evaluate("()=>{serverMode=false;window.reads=0;const get=Storage.prototype.getItem;"
                           "Storage.prototype.getItem=function(...a){window.reads++;return get.apply(this,a)};refreshOrders()}")
        self.page.wait_for_timeout(0)
        self.assertEqual((5, 0), (self.page.evaluate("apiCalls.length"), self.page.evaluate("window.reads")))

    def panel(self):
        return self.page.evaluate(READ_PANEL)

    def test_s4u5_09_guidance_names_unmatch_then_match_at_w_and_no_report_action_elsewhere(self):
        self.start({"rs": "W", "matched": "M", "oid": "SYN-U5-E", "ov": None, "ts": "none"})
        different = {**LINKED, "patientId": "mismatch"}
        self.observe(different, "M", "SYN-U5-E")
        self.page.evaluate("renderStudyIdentity()")
        at_w = self.panel()
        self.assertEqual("DICOM Identity · Patient Mismatch", at_w["summary"])
        self.assertTrue(at_w["guidance"].startswith("오더 연결이 잘못됐다면 Unmatch 후 올바른 오더로 Match하세요."), at_w["guidance"])
        for rs in ("T", "P", "A", "H"):
            with self.subTest(rs=rs):
                self.page.evaluate("rs=>{appState['2.25.501']={...appState['2.25.501'],rs};renderStudyIdentity()}", rs)
                guidance = self.panel()["guidance"]
                self.assertIn("(현재 RS: %s)" % rs, guidance)
                self.assertIn("판독 기록은 그대로 보존됩니다.", guidance)
                for word in ("Reset", "판독 취소", "Addendum", "추가 판독", "재작성", "Unmatch 후"):
                    self.assertNotIn(word, guidance)


if __name__ == "__main__":
    unittest.main(verbosity=2)
