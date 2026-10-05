"""U5S-REQ-26 -> U5S-RISK-SESSION/WRITE/APPLY -> clinician viewer negative controls.

Only browser-served copies are mutated. Every anchor must match once; the same
probe must pass on the shipped copy and fail at its named behaviour assertion.
Setup, browser errors, timeouts and unrelated assertions are never accepted kills.
"""
import argparse
import copy
import io
import json
import unittest
from unittest.mock import patch

import clinician_viewer_dom_test as h

KEY = "    return row && typeof row.sourcePatientKey === 'string' && row.sourcePatientKey ? row.sourcePatientKey : null;\n"
CLICK = "    if (otherUid !== null && (!other || other.uid === row.uid || patientKey(row) === null || patientKey(other) !== patientKey(row))) {\n"
VALID = "    const valid = ticket => !ended && ticket === generation && (!current() || current().study === scope);\n"
ASKED = "    const asked = (ticket, seq, policy) => valid(ticket) && seq === readSequence && readPolicy() === policy;\n"
FRAME = ("      if (readOnly()) { frameMatch(r); recheckShown(); }\n"
         "      // Switching display sets briefly removes the viewport. Mode exit, not\n"
         "      // that loading gap, owns teardown of drafts and in-flight commands.\n"
         "      if (!r) return;\n")
MUTANTS = [
    ('name-key','patient_key','home',[(KEY,"    return row && row.name ? row.name : null;\n")]),
    ('id-key','patient_key','home',[(KEY,"    return row && row.id ? row.id : null;\n")]),
    ('no-click-check','click_check','home',[(CLICK,"    if (otherUid !== null && !other) {\n")]),
    ('policy-off','policy','config',[("    const nativeAuthoringClosed = () => ended || !writer();\n", "    const nativeAuthoringClosed = () => false;\n")]),
    ('modules-open','modules','config',[("    writer: () => state() === 'writer',", "    writer: () => true,"),(
        "    // S5-U2b: saved jobs are written and read on writer routes; only a /me that answered writer mounts the Job panel.\n    kinViewerSession.decide().then(session => { if (session === 'writer') connect(ticket); }).catch(e => {",
        "    kinViewerSession.decide().then(() => { connect(ticket); }).catch(e => {")]),
    ('gate-as-before','unconfirmed','config',[("          if (response.ok) note(await response.json());",
        "          if (response.ok) note(await response.json()); else note({kind:'member',sub:'SYN-CLIN-SUB',institution:'SYN-INST-A',roles:['radiologist']});")]),
    ('no-version-pin','version','config',[("(version !== null && page.reportVersion !== version) ||",'')]),
    ('uid-only','aba','config',[(VALID,"    const valid = ticket => !ended;\n"),(ASKED,"    const asked = () => !ended;\n")]),
    ('no-boundary','boundary','config',[("      if (next === 'read-only') clinicianBoundary(own);\n",'')]),
    ('no-final-check','final','config',[("\n        .then(page => confirmShown(ticket, seq, study, page, null), error => confirmShown(ticket, seq, study, null, error))",'')]),
    ('frame-bound-check','frameless','config',[(FRAME,FRAME.replace("      if (readOnly()) { frameMatch(r); recheckShown(); }\n",'')+"      if (readOnly()) { frameMatch(r); recheckShown(); }\n")]),
]


class Probe(h.ClinicianViewerDOMTest):
    def test_patient_key(self):
        self.open_home()
        self.assertEqual([h.P1,h.P2],self.pick(h.A)['candidates'],'CV-NC-patient_key')

    def test_click_check(self):
        self.open_home();self.pick(h.A)
        self.page.evaluate(f"window.synStale=document.querySelector('#compare-list li[data-uid=\"{h.P2}\"] button')")
        next(row for row in self.rows if row['uid']==h.P2)['sourcePatientKey']=h.patient(h.INST_A,'OTHER')
        self.page.locator('#refresh').click()
        self.wait_until(lambda:self.page.evaluate(h.COMPARE_VIEW)['candidates']==[h.P1],'updated candidates')
        self.page.evaluate('synStale.click()');self.settle()
        self.assertEqual([],self.viewer_opens,'CV-NC-click_check')

    def test_policy(self):
        self.open_viewer();self.wait_panel('ready',h.VA)
        self.assertEqual('false',self.page.evaluate("synAdd('ArrowAnnotate')"),'CV-NC-policy')

    def test_modules(self):
        self.open_viewer();self.wait_panel('ready',h.VA);self.modules_settled();self.settle()
        self.page.evaluate('synReenter()');self.modules_settled();self.settle()
        self.assertEqual([],self.page.evaluate('synMounted'),'CV-NC-modules')

    def test_unconfirmed(self):
        self.me_status=503;self.open_viewer()
        self.wait_until(lambda:self.me_requests>=3,'failed member checks');self.settle()
        self.assertEqual(('unconfirmed',[]),(self.session(),self.page.evaluate('synMounted')),'CV-NC-unconfirmed')

    def test_version(self):
        self.open_viewer(study=h.VQ)
        self.wait_until(lambda:len([r for r in self.reads() if r[0]==h.VQ])==2,'both source pages')
        self.settle()
        self.assertEqual(('failed',[]),(self.panel()['state'],self.panel()['rows']),'CV-NC-version')

    def test_aba(self):
        self.hold_items={h.VA};self.open_viewer(uncancellable=True)
        self.wait_until(lambda:bool(self.held_items),'old A read')
        old=self.held_items.pop()[1];self.hold_items=set()
        self.page.evaluate('study=>synSwitch(study)',h.VP);self.wait_panel('ready',h.VP)
        self.page.evaluate('study=>synSwitch(study)',h.VA);self.wait_panel('ready',h.VA)
        self.release(old,{'uid':h.VA,'final':True,'reportVersion':4,'items':[h.key_item(61,'SYN-OLD-A')],'nextCursor':None})
        self.assertNotIn('SYN-OLD-A',str(self.panel()['rows']),'CV-NC-aba')

    def test_boundary(self):
        self.writer_open();self.wait_until(lambda:'SYN writer' in str(self.panel()['rows']),'writer rows')
        self.hold_items={h.VA};self.me=h.MIXED_NOW_CLINICIAN
        self.page.evaluate('ids=>synEnter(ids)',h.LATER)
        self.wait_until(lambda:self.session()=='read-only','clinician-only role');self.settle()
        self.assertEqual([],self.panel()['rows'],'CV-NC-boundary')

    def test_final(self):
        self.open_viewer();self.wait_panel('ready',h.VA);before=self.probes()
        self.items[h.VA]='withheld';self.focus()
        self.wait_until(lambda:self.probes()>before,'the final report recheck');self.settle()
        self.assertEqual(('withheld',[]),(self.panel()['state'],self.panel()['rows']),'CV-NC-final')

    def test_frameless(self):
        self.open_viewer();self.wait_panel('ready',h.VA);self.frameless(True);self.settle()
        self.assertEqual('unmatched',self.panel()['frame'],'CV-NC-frameless')


def run(name, home, config):
    stream=io.StringIO()
    with patch.object(h,'CONFIG',config),patch.dict(h.SHIPPED,{'clinician.js':home}):
        result=unittest.TextTestRunner(stream=stream,verbosity=2).run(unittest.TestSuite([Probe('test_'+name)]))
    return result,stream.getvalue()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--anchors-only',action='store_true');args=parser.parse_args()
    copies=[]
    for mutant,case,kind,replacements in MUTANTS:
        source=h.SHIPPED['clinician.js'] if kind=='home' else h.CONFIG
        for old,new in replacements:
            if source.count(old)!=1:raise AssertionError(f'{mutant}: anchor matches {source.count(old)}, expected one')
            source=source.replace(old,new,1)
        copies.append((mutant,case,kind,source))
    if args.anchors_only:
        print('CLINICIAN-MUTANTS anchors',len(copies));return 0
    for case in dict.fromkeys(row[1] for row in copies):
        result,log=run(case,h.SHIPPED['clinician.js'],h.CONFIG);print(log,end='')
        if not result.wasSuccessful() or result.skipped:return 1
    killed=[]; survived=[]
    for mutant,case,kind,source in copies:
        result,log=run(case,source if kind=='home' else h.SHIPPED['clinician.js'],source if kind=='config' else h.CONFIG)
        print(log,end='')
        if result.errors or result.skipped or len(result.failures)!=1 or 'CV-NC-'+case not in result.failures[0][1]:
            print('NOT KILLED BY NAMED ASSERTION',mutant);survived.append(mutant);continue
        killed.append(mutant);print('CLINICIAN-MUTANT KILLED',mutant,'CV-NC-'+case)
    print(json.dumps({'baseline_probes':len(set(row[1] for row in copies)),'killed':killed,'survived':survived}));return int(bool(survived))


if __name__=='__main__':raise SystemExit(main())
