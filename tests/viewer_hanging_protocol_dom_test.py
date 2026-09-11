# coding: utf-8
"""REQ-D03-HP / RISK-D03-IDENTITY/STALE/LOSS / TEST-VIEWER-HANGING-PROTOCOL-DOM."""
from pathlib import Path
import json
import unittest

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "worklist-v0" / "hpacs-lite" / "hanging-protocol-model.js"
VIEWER = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-hanging-protocol.js"

HARNESS = r"""
<div id="host"></div><textarea id="report">KEEP REPORT</textarea>
<script>
window.BroadcastChannel=undefined;
const owner={institution:'hospital',subject:'reader'};
const studies=[{uid:'1.2.1',sourcePatientKey:'hospital|patient',date:'20260912',modality:'CT',desc:'Head CT'},
 {uid:'1.2.2',sourcePatientKey:'hospital|patient',date:'20250912',modality:'CT',desc:'Old Head CT'}];
const image=()=>({RetrieveAETitle:'ARCHIVE',BodyPartExamined:'HEAD',Laterality:'L'});
const sets=[
 {displaySetInstanceUID:'ds-current',StudyInstanceUID:'1.2.1',SeriesInstanceUID:'1.2.1.1',SeriesNumber:1,SeriesDescription:'Brain Axial',Modality:'CT',images:[image(),image()]},
 {displaySetInstanceUID:'ds-related',StudyInstanceUID:'1.2.2',SeriesInstanceUID:'1.2.2.1',SeriesNumber:1,SeriesDescription:'Brain Prior',Modality:'CT',images:[image(),image()]}
];
let layoutVersion=0,layoutRows=1,layoutCols=1,setCalls=[],failAfterMutation=false;
const viewports=new Map([['old',{viewportId:'old',x:0,y:0,width:1,height:1,displaySetInstanceUIDs:['ds-current']}]])
const grid={getState:()=>({layout:{numRows:layoutRows,numCols:layoutCols,layoutType:'grid',version:layoutVersion},activeViewportId:[...viewports.keys()][0],viewports}),
 setLayout:async value=>{setCalls.push(value);layoutVersion++;layoutRows=value.numRows;layoutCols=value.numCols;const next=[];for(let i=0;i<value.numRows*value.numCols;i++)next.push(value.findOrCreateViewport(i));viewports.clear();next.forEach((v,i)=>viewports.set(v.viewportOptions.viewportId,{viewportId:v.viewportOptions.viewportId,x:(i%value.numCols)/value.numCols,y:Math.floor(i/value.numCols)/value.numRows,width:1/value.numCols,height:1/value.numRows,displaySetInstanceUIDs:v.displaySetInstanceUIDs}));if(failAfterMutation){failAfterMutation=false;throw Error('synthetic native failure');}}};
let camera={scale:1},properties={voiRange:{lower:-100,upper:200}};
const viewport={type:'stack',getCurrentImageId:()=>'/studies/1.2.1/series/1.2.1.1/instances/1',getCurrentImageIdIndex:()=>0,getCamera:()=>camera,getProperties:()=>properties};
const services={viewportGridService:grid,displaySetService:{getActiveDisplaySets:()=>sets},cornerstoneViewportService:{getCornerstoneViewport:()=>viewport}};
let accessResolve=null,holdAccess=false;
const access=()=>holdAccess?new Promise(resolve=>accessResolve=()=>resolve({studies,displaySets:sets})):Promise.resolve({studies,displaySets:sets});
const responses=[],requests=[];
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
async function fetcher(url,options={}){requests.push({url,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});
 if(url==='/api/me')return response({kind:'member',institution:'hospital',sub:'reader'});
 if(responses.length)return responses.shift();throw Error('BLOCKED NETWORK '+url);}
window.__mount=()=>window.hp=KinViewerHangingProtocol.mount({services,host:document.querySelector('#host'),owner,access,fetcher});
</script>
"""

def rule(name="Brain CT"):
    return {"id":"11111111-1111-4111-8111-111111111111","name":name,"enabled":True,
      "match":{"modality":"CT","retrieveAE":None,"bodyPart":None,"description":{"operator":"contains","value":"Head"}},
      "selectors":[
        {"alias":"Current","role":"current","historical":False,"modality":"CT","retrieveAE":"ARCHIVE","bodyPart":"HEAD","description":None,"laterality":"L","order":"ascending","occurrence":1},
        {"alias":"Related","role":"related","historical":True,"modality":"CT","retrieveAE":"ARCHIVE","bodyPart":"HEAD","description":None,"laterality":"L","order":"ascending","occurrence":1}],
      "layout":{"rows":2,"cols":2,"cells":["Current","Related",None,"Current"]}}

def library(name="Brain CT"):
    return {"version":1,"activeRuleId":"11111111-1111-4111-8111-111111111111","rules":[rule(name)]}

class ViewerHangingProtocolDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()

    def setUp(self):
        self.page=self.browser.new_page()
        self.page.route('https://hp.test/**',lambda route:route.fulfill(body=HARNESS,content_type='text/html') if route.request.url=='https://hp.test/' else route.abort())
        self.page.goto('https://hp.test/');self.page.add_script_tag(path=str(MODEL));self.page.add_script_tag(path=str(VIEWER))

    def tearDown(self):self.page.close()

    def seed(self,value=None):
        self.page.evaluate("value=>localStorage.setItem(KinHangingProtocolModel.ownerKey(owner),JSON.stringify(value))",value or library())
        self.page.evaluate('__mount()')

    def test_form_crud_order_and_explicit_local_save_reopen_without_auto_apply(self):
        self.seed();expect(self.page.get_by_label('Hanging Protocol Rule')).to_have_value(library()['activeRuleId'])
        self.page.get_by_label('Name').fill('Edited Protocol');self.page.get_by_label('Name').dispatch_event('change')
        self.assertEqual([],self.page.evaluate('setCalls'))
        self.assertEqual('Brain CT',self.page.evaluate("JSON.parse(localStorage.getItem(KinHangingProtocolModel.ownerKey(owner))).rules[0].name"))
        self.page.locator('#kin-hp-save-local').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('이 브라우저')
        self.assertEqual('Edited Protocol',self.page.evaluate("JSON.parse(localStorage.getItem(KinHangingProtocolModel.ownerKey(owner))).rules[0].name"))
        self.page.locator('#kin-hp-duplicate').click();self.assertEqual(2,self.page.locator('#kin-hp-rule option').count())
        self.page.locator('#kin-hp-up').click();self.page.locator('#kin-hp-delete').click();self.assertEqual(1,self.page.locator('#kin-hp-rule option').count())
        before=self.page.evaluate('setCalls.length');self.page.evaluate('hp.end();document.querySelector("#host").textContent="";__mount()')
        self.assertEqual(before,self.page.evaluate('setCalls.length'),"saved local rules reopen as drafts and never auto-apply")
        expect(self.page.get_by_label('Name')).to_have_value('Edited Protocol')

    def test_apply_resolves_all_cells_and_vacancy_but_no_match_and_dirty_are_non_destructive(self):
        self.seed();before=self.page.input_value('#report');self.page.locator('#kin-hp-apply').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied')
        result=self.page.evaluate("()=>({calls:setCalls.length,cells:[...viewports.values()].map(v=>v.displaySetInstanceUIDs),report:document.querySelector('#report').value})")
        self.assertEqual(1,result['calls']);self.assertEqual([['ds-current'],['ds-related'],[],['ds-current']],result['cells']);self.assertEqual(before,result['report'])
        vacancy=self.page.evaluate("()=>setCalls[0].findOrCreateViewport(2)")
        self.assertEqual([],vacancy['displaySetInstanceUIDs']);self.assertTrue(vacancy['viewportOptions']['allowUnmatchedView'])
        self.page.evaluate("sets.splice(1);layoutVersion=0;setCalls=[]")
        self.page.locator('#kin-hp-apply').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('현재 배치를 유지')
        self.assertEqual(0,self.page.evaluate('setCalls.length'))
        self.page.evaluate("sets.push({displaySetInstanceUID:'ds-related',StudyInstanceUID:'1.2.2',SeriesInstanceUID:'1.2.2.1',SeriesNumber:1,SeriesDescription:'Brain Prior',Modality:'CT',images:[image(),image()]});window.kinViewerJobWorkspaceState=()=>({dirty:true,busy:false})")
        self.page.locator('#kin-hp-apply').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('저장하지 않은 영상 작업')
        self.assertEqual(0,self.page.evaluate('setCalls.length'))

    def test_late_access_and_changed_layout_or_draft_do_not_apply(self):
        self.seed();self.page.evaluate('holdAccess=true');self.page.locator('#kin-hp-apply').click();self.page.wait_for_function('typeof accessResolve==="function"')
        self.page.evaluate('camera={scale:2}');self.page.evaluate('accessResolve()');expect(self.page.locator('#kin-hp-status')).to_contain_text('변경되어 적용하지 않았습니다')
        self.assertEqual(0,self.page.evaluate('setCalls.length'))
        self.page.evaluate('holdAccess=true');self.page.locator('#kin-hp-apply').click();self.page.wait_for_function('typeof accessResolve==="function"')
        self.page.get_by_label('Name').fill('Changed While Waiting');self.page.get_by_label('Name').dispatch_event('change');self.page.evaluate('accessResolve()')
        expect(self.page.locator('#kin-hp-status')).to_contain_text('변경되어 적용하지 않았습니다');self.assertEqual(0,self.page.evaluate('setCalls.length'))

    def test_native_rejection_rolls_back_only_the_controller_target(self):
        self.seed();before=self.page.evaluate("()=>[...viewports.values()].map(v=>({id:v.viewportId,sets:v.displaySetInstanceUIDs}))")
        self.page.evaluate('failAfterMutation=true');self.page.locator('#kin-hp-apply').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('synthetic native failure')
        after=self.page.evaluate("()=>[...viewports.values()].map(v=>({id:v.viewportId,sets:v.displaySetInstanceUIDs}))")
        self.assertEqual(before,after);self.assertEqual(2,self.page.evaluate('setCalls.length'),"one target attempt and one bounded rollback")

    def test_account_load_save_reset_use_owner_revision_cas_and_never_apply(self):
        self.page.evaluate('(value)=>responses.push(response({owner,revision:3,value}))',library('Account Rule'));self.page.evaluate('__mount()')
        self.page.locator('#kin-hp-load-account').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('Apply를 눌러')
        self.assertEqual([],self.page.evaluate('setCalls'));expect(self.page.get_by_label('Name')).to_have_value('Account Rule')
        self.page.get_by_label('Name').fill('Saved Rule');self.page.get_by_label('Name').dispatch_event('change')
        self.page.evaluate('(value)=>responses.push(response({owner,revision:4,value}))',library('Saved Rule'))
        self.page.locator('#kin-hp-save-account').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('계정에 규칙을 저장')
        put=self.page.evaluate("requests.find(r=>r.url==='/api/hanging-protocols'&&r.method==='PUT').body")
        self.assertEqual({'institution':'hospital','subject':'reader'},put['expectedOwner']);self.assertEqual(3,put['revision']);self.assertEqual('Saved Rule',put['value']['rules'][0]['name'])
        self.page.evaluate("responses.push(response({owner,revision:5,value:null}))");self.page.locator('#kin-hp-reset-account').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('현재 초안과 화면은 유지')
        reset=self.page.evaluate("requests.filter(r=>r.url==='/api/hanging-protocols'&&r.method==='PUT').at(-1).body")
        self.assertEqual({'expectedOwner':{'institution':'hospital','subject':'reader'},'revision':4,'value':None},reset)
        self.assertEqual('Saved Rule',self.page.input_value('#host input'))

    def test_import_is_strict_draft_only_and_contains_no_patient_snapshot(self):
        self.page.evaluate('__mount()');payload=library('Imported Rule')
        self.page.locator('#kin-hp-import').set_input_files({'name':'rules.json','mimeType':'application/json','buffer':json.dumps(payload).encode()})
        expect(self.page.locator('#kin-hp-status')).to_contain_text('초안으로 가져왔습니다');expect(self.page.get_by_label('Name')).to_have_value('Imported Rule')
        self.assertEqual([],self.page.evaluate('setCalls'));self.assertIsNone(self.page.evaluate('localStorage.getItem(KinHangingProtocolModel.ownerKey(owner))'))
        bad={**payload,'patientId':'must-not-import'}
        self.page.locator('#kin-hp-import').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':json.dumps(bad).encode()})
        expect(self.page.locator('#kin-hp-status')).to_contain_text('형식이 잘못')

    def test_repeated_add_selector_keeps_ascii_aliases_and_saves_strictly(self):
        self.seed();add=self.page.get_by_role('button',name='Add Selector',exact=True);add.click();add=self.page.get_by_role('button',name='Add Selector',exact=True);add.click()
        aliases=self.page.locator('label').filter(has_text='Alias (ASCII').locator('input').evaluate_all('nodes=>nodes.map(node=>node.value)')
        self.assertEqual(['Current','Related','Series','Series2'],aliases);expect(self.page.get_by_role('button',name='Add Selector',exact=True)).to_be_disabled()
        self.page.locator('#kin-hp-save-local').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('이 브라우저')
        self.assertTrue(self.page.evaluate("()=>Boolean(KinHangingProtocolModel.normalize(JSON.parse(localStorage.getItem(KinHangingProtocolModel.ownerKey(owner)))))"))

    def test_delete_last_rule_can_save_empty_local_and_account_library(self):
        self.seed();self.page.evaluate('(value)=>responses.push(response({owner,revision:7,value}))',library())
        self.page.locator('#kin-hp-load-account').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('Apply를 눌러')
        self.page.locator('#kin-hp-delete').click();expect(self.page.locator('#kin-hp-apply')).to_be_disabled();expect(self.page.locator('#kin-hp-delete')).to_be_disabled()
        for selector in ['#kin-hp-save-local','#kin-hp-save-account','#kin-hp-reset-account','#kin-hp-export']:expect(self.page.locator(selector)).to_be_enabled()
        self.page.locator('#kin-hp-save-local').click();stored=self.page.evaluate("()=>JSON.parse(localStorage.getItem(KinHangingProtocolModel.ownerKey(owner)))")
        self.assertEqual({'version':1,'activeRuleId':None,'rules':[]},stored)
        self.page.evaluate("responses.push(response({owner,revision:8,value:{version:1,activeRuleId:null,rules:[]}}))")
        self.page.locator('#kin-hp-save-account').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('계정에 규칙을 저장')
        body=self.page.evaluate("requests.filter(r=>r.url==='/api/hanging-protocols'&&r.method==='PUT').at(-1).body")
        self.assertEqual({'version':1,'activeRuleId':None,'rules':[]},body['value']);self.assertEqual(7,body['revision'])

    def test_first_match_skips_nonmatching_selected_rule_and_reapplies_vacancy(self):
        value=library();other=rule('Not applicable');other['id']='22222222-2222-4222-8222-222222222222';other['match']['modality']='MR'
        value['rules'].insert(0,other);value['activeRuleId']=other['id'];self.seed(value)
        self.page.evaluate("services.cornerstoneViewportService.getCornerstoneViewport=id=>viewports.get(id)?.displaySetInstanceUIDs.length?viewport:undefined")
        for expected_calls in [1,2]:
            self.page.locator('#kin-hp-apply-first').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied: Brain CT')
            self.assertEqual(expected_calls,self.page.evaluate('setCalls.length'))
            self.assertEqual([['ds-current'],['ds-related'],[],['ds-current']],self.page.evaluate('[...viewports.values()].map(v=>v.displaySetInstanceUIDs)'))

    def test_corrupt_storage_is_reported_without_overwriting_it(self):
        self.page.evaluate("localStorage.setItem(KinHangingProtocolModel.ownerKey(owner),'{}');__mount()")
        expect(self.page.locator('#kin-hp-status')).to_contain_text('손상')
        self.assertEqual('{}',self.page.evaluate('localStorage.getItem(KinHangingProtocolModel.ownerKey(owner))'))

    def test_delayed_import_cannot_replace_newer_edits_or_retired_editor(self):
        self.seed()
        self.page.evaluate("""value=>{window.importText=JSON.stringify(value);window.originalFileText=File.prototype.text;
            File.prototype.text=function(){return new Promise(resolve=>window.releaseImport=()=>resolve(importText));};}""",library('Imported'))
        self.page.locator('#kin-hp-import').set_input_files({'name':'hp.json','mimeType':'application/json','buffer':b'{}'})
        self.page.get_by_label('Name').fill('Newer');self.page.get_by_label('Name').dispatch_event('change')
        self.page.evaluate('releaseImport()');expect(self.page.locator('#kin-hp-status')).to_contain_text('편집 중')
        expect(self.page.get_by_label('Name')).to_have_value('Newer')
        self.page.locator('#kin-hp-import').set_input_files({'name':'hp.json','mimeType':'application/json','buffer':b'{}'})
        self.page.evaluate('() => {hp.end();releaseImport();File.prototype.text=originalFileText;}')
        expect(self.page.get_by_label('Name')).to_have_value('Newer');self.assertEqual('Newer',self.page.evaluate('hp.read().rules[0].name'))

if __name__=='__main__':unittest.main(verbosity=2)
