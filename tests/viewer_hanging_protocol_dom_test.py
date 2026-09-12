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
window.unhandled=[];window.addEventListener('unhandledrejection',event=>{unhandled.push(String(event.reason));event.preventDefault();});
const owner={institution:'hospital',subject:'reader'};
const studies=[{uid:'1.2.1',sourcePatientKey:'hospital|patient',date:'20260912',modality:'CT',desc:'Head CT'},
 {uid:'1.2.2',sourcePatientKey:'hospital|patient',date:'20250912',modality:'CT',desc:'Old Head CT'}];
const image=()=>({RetrieveAETitle:'ARCHIVE',BodyPartExamined:'HEAD',Laterality:'L'});
const sets=[
 {displaySetInstanceUID:'ds-current',StudyInstanceUID:'1.2.1',SeriesInstanceUID:'1.2.1.1',SeriesNumber:1,SeriesDescription:'Brain Axial',Modality:'CT',images:[image(),image()]},
 {displaySetInstanceUID:'ds-related',StudyInstanceUID:'1.2.2',SeriesInstanceUID:'1.2.2.1',SeriesNumber:1,SeriesDescription:'Brain Prior',Modality:'CT',images:[image(),image()]}
];
let layoutVersion=0,layoutRows=1,layoutCols=1,setCalls=[],failAfterMutation=false,hpSubscribers=[],activeViewportId=null,holdLayout=false,holdLayoutCount=0,layoutResolve=null,heldLayouts=[],delayTarget=false,targetResolve=null,rejectBeforeTarget=false;
const viewports=new Map([['old',{viewportId:'old',x:0,y:0,width:1,height:1,isReady:true,displaySetInstanceUIDs:['ds-current']}]])
const grid={EVENTS:{GRID:'grid'},subscribe:(_,fn)=>{hpSubscribers.push(fn);return{unsubscribe(){hpSubscribers=hpSubscribers.filter(x=>x!==fn)}}},getState:()=>({layout:{numRows:layoutRows,numCols:layoutCols,layoutType:'grid',version:layoutVersion},activeViewportId:activeViewportId||[...viewports.keys()][0],viewports}),
 setLayout:async value=>{setCalls.push(value);const next=[];for(let i=0;i<value.numRows*value.numCols;i++)next.push(value.findOrCreateViewport(i));const install=()=>{layoutVersion++;layoutRows=value.numRows;layoutCols=value.numCols;viewports.clear();next.forEach((v,i)=>{viewports.set(v.viewportOptions.viewportId,{viewportId:v.viewportOptions.viewportId,x:(i%value.numCols)/value.numCols,y:Math.floor(i/value.numCols)/value.numRows,width:1/value.numCols,height:1/value.numRows,isReady:true,displaySetInstanceUIDs:v.displaySetInstanceUIDs,options:v.viewportOptions});window.installPlane(v.viewportOptions.viewportId,v.viewportOptions);});};if(delayTarget){delayTarget=false;targetResolve=install;if(rejectBeforeTarget){rejectBeforeTarget=false;throw Error('synthetic deferred dispatch failure');}return;}install();const shouldHold=holdLayout||holdLayoutCount>0;if(holdLayoutCount>0)holdLayoutCount--;if(shouldHold)await new Promise((resolve,reject)=>{layoutResolve=resolve;heldLayouts.push({resolve,reject});});if(failAfterMutation){failAfterMutation=false;throw Error('synthetic native failure');}}};
let camera={scale:1},properties={voiRange:{lower:-100,upper:200}};
const viewport={type:'stack',getCurrentImageId:()=>'/studies/1.2.1/series/1.2.1.1/instances/1',getCurrentImageIdIndex:()=>0,getCamera:()=>camera,getProperties:()=>properties};
const services={viewportGridService:grid,displaySetService:{EVENTS:{CHANGED:'changed'},subscribe:(_,fn)=>{hpSubscribers.push(fn);return{unsubscribe(){hpSubscribers=hpSubscribers.filter(x=>x!==fn)}}},getActiveDisplaySets:()=>sets},cornerstoneViewportService:{getCornerstoneViewport:()=>viewport}};
window.emitHP=()=>hpSubscribers.slice().forEach(fn=>fn());
let accessResolve=null,holdAccess=false;
const access=()=>holdAccess?new Promise(resolve=>accessResolve=()=>resolve({studies,displaySets:sets})):Promise.resolve({studies,displaySets:sets});
const responses=[],requests=[];
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
async function fetcher(url,options={}){requests.push({url,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});
 if(url==='/api/me')return response({kind:'member',institution:'hospital',sub:'reader'});
 if(responses.length)return responses.shift();throw Error('BLOCKED NETWORK '+url);}
window.__mount=()=>window.hp=KinViewerHangingProtocol.mount({services,host:document.querySelector('#host'),owner,access,fetcher});
// Native orientation presets in patient space. The stub honours the requested orientation the
// way cornerstone does, so a cell that asked for a plane can be checked against real geometry.
const PLANES={axial:{viewPlaneNormal:[0,0,-1],viewUp:[0,-1,0]},sagittal:{viewPlaneNormal:[1,0,0],viewUp:[0,0,1]},coronal:{viewPlaneNormal:[0,1,0],viewUp:[0,0,1]}};
const planeViewports=new Map();
// The cache holds one loaded volume of the current series, as it does after a real load. The
// knobs below reproduce the three ways a native plane can come up wrong.
window.volumeLoaded=true;window.volumeSeries=null;window.planeNormalOverride=null;
const volumeFrames=()=>(window.volumeSeries||sets[0].images.map(i=>i.SOPInstanceUID)).map(sop=>'frame-'+sop);
const cachedVolume=()=>{const imageIds=volumeFrames();return {volumeId:'volume-1',imageIds,framesLoaded:imageIds.length,loadStatus:{loaded:window.volumeLoaded}};};
window.cornerstone={cache:{getVolume:id=>id==='volume-1'?cachedVolume():null},
  metaData:{get:(_,id)=>({SOPInstanceUID:String(id).slice('frame-'.length)})}};
const actors=[{actor:{}}];
function makePlane(options){
  const preset=PLANES[options.orientation];
  return {type:'orthographic',getCurrentImageId:()=>null,getCurrentImageIdIndex:()=>null,getVolumeId:()=>'volume-1',getActors:()=>actors,
    getProperties:()=>properties,render(){},
    camera:{viewPlaneNormal:[...(window.planeNormalOverride||preset.viewPlaneNormal)],viewUp:[...preset.viewUp],
      focalPoint:[0,0,0],position:[0,0,100],parallelScale:100,flipHorizontal:false,flipVertical:false},
    getCamera(){return structuredClone(this.camera);},
    setCamera(next){this.camera={...this.camera,...structuredClone(next)};}};
}
// Rebuilding a viewport on an orientation preset is what native does, so a plane instance never
// survives a layout change with the camera the user left on it.
window.installPlane=(id,options)=>{if(options.viewportType==='volume')planeViewports.set(id,makePlane(options));else planeViewports.delete(id);};
window.useNativeViewportTypes=()=>{services.cornerstoneViewportService.getCornerstoneViewport=id=>
  planeViewports.get(id)||(viewports.has(id)?viewport:undefined);};
window.planeCameras=()=>[...viewports.keys()].map(id=>planeViewports.get(id)?.getCamera()||null);
window.ctSlices=count=>Array.from({length:count},(_,n)=>({...image(),SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',SOPInstanceUID:'1.2.9.'+(n+1),
  Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2',FrameOfReferenceUID:'1.2.9.0',
  Rows:512,Columns:512,PixelSpacing:[0.7,0.7],ImageOrientationPatient:[1,0,0,0,1,0],ImagePositionPatient:[-150,-150,n*2.5]}));
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

def plane(alias,orientation):
    return {"alias":alias,"view":"mpr","orientation":orientation}

def mpr_library(name="Three Plane CT"):
    """One eligible CT volume shown as three explicitly oriented cells plus a vacancy."""
    value=library(name);current=value["rules"][0]
    current["selectors"]=[current["selectors"][0]]
    current["layout"]={"rows":2,"cols":2,"cells":[plane("Current","axial"),plane("Current","sagittal"),
                                                  plane("Current","coronal"),None]}
    stack=rule("Plain Stack");stack["id"]="22222222-2222-4222-8222-222222222222"
    stack["selectors"]=[stack["selectors"][0]]
    stack["layout"]={"rows":1,"cols":1,"cells":["Current"]}
    value["rules"].append(stack)
    return value

def navigation_library():
    value=library("First CT")
    disabled=rule("Disabled");disabled["id"]="22222222-2222-4222-8222-222222222222";disabled["enabled"]=False
    missed=rule("MR only");missed["id"]="33333333-3333-4333-8333-333333333333";missed["match"]["modality"]="MR"
    last=rule("Last CT");last["id"]="44444444-4444-4444-8444-444444444444"
    value["rules"]=[value["rules"][0],disabled,missed,last]
    return value

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

    def test_previous_next_use_success_cursor_skip_rules_and_do_not_wrap(self):
        self.seed(navigation_library())
        self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: First CT')
        self.page.select_option('#kin-hp-rule','44444444-4444-4444-8444-444444444444');expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: First CT')
        self.page.evaluate("camera={scale:9};activeViewportId=[...viewports.keys()].at(-1);layoutVersion++;emitHP()")
        expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: First CT')
        self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: Last CT')
        calls=self.page.evaluate('setCalls.length');self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('저장 순서의 끝')
        self.assertEqual(calls,self.page.evaluate('setCalls.length'))
        self.page.locator('#kin-hp-previous').click();expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: First CT')
        self.page.evaluate("hp.end();document.querySelector('#host').textContent='';__mount()")
        self.page.locator('#kin-hp-previous').click();expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: Last CT')

    def test_navigation_failure_dirty_and_manual_source_change_do_not_advance_stale_cursor(self):
        self.seed(navigation_library());self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_contain_text('First CT')
        self.page.evaluate('failAfterMutation=true');self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('synthetic native failure')
        self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_contain_text('Last CT')
        self.page.evaluate("[...viewports.values()][0].displaySetInstanceUIDs=['ds-related']")
        self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_contain_text('First CT')
        self.page.evaluate("window.kinViewerJobWorkspaceState=()=>({dirty:true,busy:false})");calls=self.page.evaluate('setCalls.length');self.page.locator('#kin-hp-previous').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('저장하지 않은')
        self.assertEqual(calls,self.page.evaluate('setCalls.length'))
        self.page.evaluate("window.kinViewerJobWorkspaceState=()=>({dirty:false,busy:false});[...viewports.values()][0].displaySetInstanceUIDs=['ds-related'];emitHP()")
        expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None')
        self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_contain_text('First CT')
        self.page.evaluate("sets[0].images.push(image());emitHP()")
        expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None')

    def test_import_and_empty_account_load_invalidate_applied_cursor_without_applying(self):
        self.seed(navigation_library());self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_contain_text('First CT')
        calls=self.page.evaluate('setCalls.length');payload=navigation_library();payload['rules'][0]['name']='Imported First'
        self.page.locator('#kin-hp-import').set_input_files({'name':'rules.json','mimeType':'application/json','buffer':json.dumps(payload).encode()})
        expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None');self.assertEqual(calls,self.page.evaluate('setCalls.length'))
        self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_contain_text('Imported First')
        self.page.evaluate("responses.push(response({owner,revision:9,value:null}))");self.page.locator('#kin-hp-load-account').click()
        expect(self.page.locator('#kin-hp-status')).to_contain_text('저장된 Hanging Protocol이 없습니다')
        expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None');self.assertEqual(calls+1,self.page.evaluate('setCalls.length'))

    def test_navigation_late_frame_change_rejects_without_setting_cursor(self):
        self.seed(navigation_library());self.page.evaluate('holdAccess=true');self.page.locator('#kin-hp-next').click();self.page.wait_for_function('typeof accessResolve==="function"')
        self.page.evaluate('camera={scale:7};accessResolve()');expect(self.page.locator('#kin-hp-status')).to_contain_text('변경되어 적용하지 않았습니다')
        expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None');self.assertEqual(0,self.page.evaluate('setCalls.length'))
        self.page.evaluate('holdAccess=true');self.page.locator('#kin-hp-previous').click();self.page.wait_for_function('typeof accessResolve==="function"')
        self.page.evaluate('hp.end();accessResolve()');expect(self.page.locator('#kin-hp-previous')).to_be_disabled()
        expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None');self.assertEqual(0,self.page.evaluate('setCalls.length'))

    def test_edit_during_native_layout_completion_cannot_advance_applied_cursor(self):
        self.seed(navigation_library());self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_contain_text('First CT')
        self.page.evaluate('holdLayout=true');self.page.locator('#kin-hp-next').click();self.page.wait_for_function('typeof layoutResolve==="function"')
        self.page.evaluate("()=>{const input=[...document.querySelectorAll('input')].find(value=>value.labels?.[0]?.textContent==='Name');input.value='Changed During Layout';input.dispatchEvent(new Event('change'));layoutResolve();}")
        expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None');expect(self.page.locator('#kin-hp-status')).not_to_contain_text('Applied: Last CT')

    def test_resolved_native_dispatch_waits_for_observable_target_before_success(self):
        self.seed(navigation_library());self.page.evaluate('delayTarget=true');self.page.locator('#kin-hp-next').click();self.page.wait_for_function('typeof targetResolve==="function"')
        expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None')
        self.page.evaluate('targetResolve()');expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: First CT')

    def test_native_layout_resolving_after_apply_timeout_cannot_advance_cursor_or_leave_pending_status(self):
        self.seed(navigation_library());self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_contain_text('First CT')
        self.page.evaluate("()=>{window.realSetTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>realSetTimeout(fn,ms===10000?10:ms===2000?15:ms,...args);holdLayout=true;}")
        self.page.locator('#kin-hp-next').click();self.page.wait_for_function('heldLayouts.length===2')
        expect(self.page.locator('#kin-hp-status')).to_contain_text('뷰어 창을 닫은 뒤 다시 열어 주세요');expect(self.page.locator('#kin-hp-status')).not_to_contain_text('확인 중')
        expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None');expect(self.page.locator('#kin-hp-next')).to_be_disabled();expect(self.page.get_by_label('Name')).to_be_enabled()
        calls=self.page.evaluate("setCalls.length");self.page.evaluate("document.querySelector('#kin-hp-next').click()");self.assertEqual(calls,self.page.evaluate('setCalls.length'))
        self.page.evaluate("heldLayouts.forEach(item=>item.reject(Error('late native rejection')))");self.page.wait_for_timeout(30);self.assertEqual([],self.page.evaluate('unhandled'))

    def test_access_provider_ignoring_abort_cannot_dispatch_layout_after_timeout(self):
        self.seed(navigation_library());self.page.evaluate("()=>{window.realSetTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>realSetTimeout(fn,ms===10000?10:ms,...args);holdAccess=true;}")
        self.page.locator('#kin-hp-next').click();self.page.wait_for_function('typeof accessResolve==="function"');expect(self.page.locator('#kin-hp-status')).to_contain_text('응답 시간이 지나')
        expect(self.page.locator('#kin-hp-next')).to_be_enabled();self.page.evaluate('accessResolve()');self.page.wait_for_timeout(30)
        self.assertEqual(0,self.page.evaluate('setCalls.length'));expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None');self.assertEqual([],self.page.evaluate('unhandled'))

    def test_confirmed_restore_still_quarantines_an_unsettled_original_native_call(self):
        self.seed(navigation_library());self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_contain_text('First CT')
        before=self.page.evaluate("()=>[...viewports.values()].map(value=>[value.viewportId,value.displaySetInstanceUIDs])")
        self.page.evaluate("()=>{window.realSetTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>realSetTimeout(fn,ms===10000?10:ms,...args);holdLayoutCount=1;}")
        self.page.locator('#kin-hp-next').click();self.page.wait_for_function('heldLayouts.length===1');expect(self.page.locator('#kin-hp-status')).to_contain_text('뷰어 창을 닫은 뒤 다시 열어 주세요')
        self.assertEqual(before,self.page.evaluate("()=>[...viewports.values()].map(value=>[value.viewportId,value.displaySetInstanceUIDs])"));expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None')
        expect(self.page.locator('#kin-hp-next')).to_be_disabled();expect(self.page.get_by_label('Name')).to_be_enabled();calls=self.page.evaluate('setCalls.length')
        self.page.evaluate("heldLayouts[0].reject(Error('late original rejection'));document.querySelector('#kin-hp-next').click()");self.page.wait_for_timeout(30)
        self.assertEqual(calls,self.page.evaluate('setCalls.length'));expect(self.page.locator('#kin-hp-next')).to_be_disabled();self.assertEqual([],self.page.evaluate('unhandled'))

    def test_rejected_dispatch_that_commits_late_is_restored_only_without_intervening_input(self):
        self.seed(navigation_library());self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_contain_text('First CT')
        before=self.page.evaluate("()=>[...viewports.values()].map(value=>[value.viewportId,value.displaySetInstanceUIDs])")
        self.page.evaluate('delayTarget=true;rejectBeforeTarget=true');self.page.locator('#kin-hp-next').click();self.page.wait_for_function('typeof targetResolve==="function"')
        self.page.evaluate('lateInstall=targetResolve;delayTarget=true;lateInstall()');self.page.wait_for_function('setCalls.length===3&&targetResolve!==lateInstall');self.page.evaluate('targetResolve()')
        expect(self.page.locator('#kin-hp-status')).to_contain_text('synthetic deferred dispatch failure');expect(self.page.locator('#kin-hp-applied')).to_contain_text('First CT')
        self.assertEqual(before,self.page.evaluate("()=>[...viewports.values()].map(value=>[value.viewportId,value.displaySetInstanceUIDs])"));self.assertEqual(3,self.page.evaluate('setCalls.length'))

    def test_rejected_dispatch_never_restores_over_intervening_camera_input(self):
        self.seed(navigation_library());self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_contain_text('First CT')
        self.page.evaluate('delayTarget=true;rejectBeforeTarget=true');self.page.locator('#kin-hp-next').click();self.page.wait_for_function('typeof targetResolve==="function"');self.page.evaluate("camera={scale:77};document.dispatchEvent(new WheelEvent('wheel'));targetResolve()")
        expect(self.page.locator('#kin-hp-status')).to_contain_text('복원 완료를 확인하지 못했습니다');expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None')
        self.assertEqual(2,self.page.evaluate('setCalls.length'));self.assertEqual(77,self.page.evaluate('camera.scale'))

    def test_rejected_dispatch_never_restores_when_input_follows_late_target_in_same_turn(self):
        self.seed(navigation_library());self.page.locator('#kin-hp-next').click();expect(self.page.locator('#kin-hp-applied')).to_contain_text('First CT')
        self.page.evaluate('delayTarget=true;rejectBeforeTarget=true');self.page.locator('#kin-hp-next').click();self.page.wait_for_function('typeof targetResolve==="function"')
        self.page.evaluate("targetResolve();camera={scale:88};document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'}))")
        expect(self.page.locator('#kin-hp-status')).to_contain_text('복원 완료를 확인하지 못했습니다');expect(self.page.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None')
        self.assertEqual(2,self.page.evaluate('setCalls.length'));self.assertEqual(88,self.page.evaluate('camera.scale'))

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

    def test_plane_cells_open_one_volume_as_three_oriented_viewports(self):
        self.seed(mpr_library());self.page.evaluate("sets[0].images=ctSlices(3);useNativeViewportTypes()")
        before=self.page.input_value('#report');self.page.locator('#kin-hp-apply').click()
        expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied')
        requested=self.page.evaluate("()=>[0,1,2,3].map(index=>setCalls[0].findOrCreateViewport(index))")
        for index,orientation in enumerate(['axial','sagittal','coronal']):
            options=requested[index]['viewportOptions']
            self.assertEqual(['ds-current'],requested[index]['displaySetInstanceUIDs'],"every plane shows the same one volume")
            self.assertEqual('volume',options['viewportType']);self.assertEqual('mpr',options['toolGroupId'])
            self.assertEqual(orientation,options['orientation']);self.assertEqual(options['viewportId'],options['id'])
        self.assertEqual([],requested[3]['displaySetInstanceUIDs'])
        self.assertEqual('stack',requested[3]['viewportOptions']['viewportType'])
        self.assertNotIn('id',requested[3]['viewportOptions'],"an ordinary cell keeps its original options")
        self.assertEqual(4,len(self.page.evaluate('[...viewports.values()]')),"three planes are three cells in a 2x2 grid")
        normals=self.page.evaluate("""()=>[...viewports.values()].slice(0,3).map(v=>
          services.cornerstoneViewportService.getCornerstoneViewport(v.viewportId).getCamera().viewPlaneNormal)""")
        self.assertEqual([[0,0,-1],[1,0,0],[0,1,0]],normals)
        for a,b in [(0,1),(0,2),(1,2)]:
            self.assertEqual(0,sum(x*y for x,y in zip(normals[a],normals[b])),"the three planes stay orthogonal")
        self.assertEqual(before,self.page.input_value('#report'))

    def test_plane_cells_on_an_unsupported_source_keep_the_previous_screen(self):
        self.seed(mpr_library());self.page.evaluate("useNativeViewportTypes()")
        before=self.page.evaluate("()=>[...viewports.values()].map(v=>[v.viewportId,v.displaySetInstanceUIDs])")
        for source in ["sets[0].images=ctSlices(1)",
                       "sets[0].images=[ctSlices(1)[0],ctSlices(1)[0]]",
                       "sets[0].images=ctSlices(3);sets[0].Modality='MR'",
                       "sets[0].images=ctSlices(3);sets.push({...sets[0],displaySetInstanceUID:'split'})"]:
            self.page.evaluate("sets[0].Modality='CT';sets.length=2;"+source)
            self.page.locator('#kin-hp-apply').click()
            expect(self.page.locator('#kin-hp-status')).to_contain_text('현재 배치를 유지')
            self.assertEqual(0,self.page.evaluate('setCalls.length'),source)
            self.assertEqual(before,self.page.evaluate("()=>[...viewports.values()].map(v=>[v.viewportId,v.displaySetInstanceUIDs])"),source)
        self.page.evaluate("sets[0].Modality='CT';sets.length=2;sets[0].images=ctSlices(3)")
        self.page.locator('#kin-hp-apply').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied')
        self.assertEqual(1,self.page.evaluate('setCalls.length'))

    def test_a_plane_screen_this_rule_built_can_be_replaced_but_a_foreign_one_cannot(self):
        self.seed(mpr_library());self.page.evaluate("sets[0].images=ctSlices(3);useNativeViewportTypes()")
        self.page.locator('#kin-hp-apply').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied')
        self.page.select_option('#kin-hp-rule','22222222-2222-4222-8222-222222222222')
        self.page.locator('#kin-hp-apply').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied: Plain Stack')
        cells=self.page.evaluate("()=>[...viewports.values()].map(v=>[v.displaySetInstanceUIDs,v.options.viewportType])")
        self.assertEqual([[['ds-current'],'stack']],cells,"a plane screen this rule built is replaced, not quarantined")
        # A non-stack screen this controller did not build stays unknown and is refused.
        self.page.evaluate("""window.foreign={type:'orthographic',getCamera:()=>camera,getProperties:()=>properties,
          getCurrentImageId:()=>null,getCurrentImageIdIndex:()=>null};
          services.cornerstoneViewportService.getCornerstoneViewport=()=>foreign""")
        calls=self.page.evaluate('setCalls.length');self.page.locator('#kin-hp-apply').click()
        expect(self.page.locator('#kin-hp-status')).to_contain_text('현재 배치를 유지합니다')
        self.assertEqual(calls,self.page.evaluate('setCalls.length'))

    def test_a_plane_cell_is_not_applied_until_its_volume_is_really_loaded(self):
        self.seed(mpr_library());self.page.evaluate("sets[0].images=ctSlices(4);useNativeViewportTypes();volumeLoaded=false")
        self.page.locator('#kin-hp-apply').click();self.page.wait_for_timeout(400)
        self.assertEqual(1,self.page.evaluate('setCalls.length'),"the layout request is made once")
        self.assertNotIn('Applied',self.page.text_content('#kin-hp-status'),
                         "an orthographic viewport without its volume is not a successful apply")
        self.assertEqual('Applied Protocol: None',self.page.text_content('#kin-hp-applied'))
        self.page.evaluate("volumeLoaded=true")
        expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied')
        self.assertEqual('Applied Protocol: Three Plane CT',self.page.text_content('#kin-hp-applied'))

    def test_an_orthographic_cell_on_the_wrong_volume_or_plane_keeps_the_previous_screen(self):
        self.seed(mpr_library());self.page.evaluate("sets[0].images=ctSlices(4);useNativeViewportTypes()")
        before=self.page.evaluate("()=>[...viewports.values()].map(v=>[v.viewportId,v.displaySetInstanceUIDs])")
        for knob in ["planeNormalOverride=[0.5773,0.5773,0.5773]",
                     "volumeSeries=['1.2.8.1','1.2.8.2','1.2.8.3','1.2.8.4']"]:
            self.page.evaluate("planeNormalOverride=null;volumeSeries=null;"+knob)
            self.page.locator('#kin-hp-apply').click()
            expect(self.page.locator('#kin-hp-status')).to_contain_text('이전 화면')
            self.assertEqual('Applied Protocol: None',self.page.text_content('#kin-hp-applied'),knob)
            self.assertEqual(before,self.page.evaluate("()=>[...viewports.values()].map(v=>[v.viewportId,v.displaySetInstanceUIDs])"),knob)
        self.page.evaluate("planeNormalOverride=null;volumeSeries=null")
        self.page.locator('#kin-hp-apply').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied')

    def test_a_failed_apply_restores_the_plane_camera_the_user_was_working_in(self):
        self.seed(mpr_library());self.page.evaluate("sets[0].images=ctSlices(4);useNativeViewportTypes()")
        self.page.locator('#kin-hp-apply').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied')
        # The user rotates the three planes with the Crosshairs tool of toolGroup 'mpr'.
        adjusted=self.page.evaluate("""()=>{const rotated={viewPlaneNormal:[0.5773,0.5773,0.5773],viewUp:[0,0,1],
            focalPoint:[3,4,5],position:[13,14,15],parallelScale:42,flipHorizontal:true,flipVertical:false};
          for(const id of viewports.keys()){const v=planeViewports.get(id);if(v)v.setCamera(rotated);}
          return planeCameras();}""")
        self.assertEqual(3,len([value for value in adjusted if value]),"three planes carry the user's own camera")
        self.page.select_option('#kin-hp-rule','22222222-2222-4222-8222-222222222222')
        self.page.evaluate('failAfterMutation=true')
        self.page.locator('#kin-hp-apply').click()
        expect(self.page.locator('#kin-hp-status')).to_contain_text('synthetic native failure')
        self.assertEqual(adjusted,self.page.evaluate('planeCameras()'),
                         "the rollback restores the user's actual camera, not the recorded orientation")
        self.assertEqual([0.5773,0.5773,0.5773],self.page.evaluate('planeCameras()[0].viewPlaneNormal'))

    def test_an_owned_plane_without_a_readable_camera_refuses_before_any_mutation(self):
        self.seed(mpr_library());self.page.evaluate("sets[0].images=ctSlices(4);useNativeViewportTypes()")
        self.page.locator('#kin-hp-apply').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied')
        calls=self.page.evaluate('setCalls.length')
        self.page.evaluate("()=>{for(const v of planeViewports.values())v.getCamera=()=>({viewPlaneNormal:[0,0,-1]});}")
        self.page.select_option('#kin-hp-rule','22222222-2222-4222-8222-222222222222')
        self.page.locator('#kin-hp-apply').click()
        expect(self.page.locator('#kin-hp-status')).to_contain_text('현재 배치를 유지합니다')
        self.assertEqual(calls,self.page.evaluate('setCalls.length'),
                         "a screen we could not snapshot is refused before the layout is destroyed")

    def test_editor_offers_plane_cells_per_selector_and_saves_them_strictly(self):
        self.seed()
        options=self.page.get_by_label('Cell 1').locator('option').evaluate_all('nodes=>nodes.map(node=>[node.value,node.textContent])')
        self.assertIn(['Current','Current'],options)
        self.assertIn(['Current|mpr|axial','Current · MPR Axial'],options)
        self.assertEqual(['','Current','Current|mpr|axial','Current|mpr|sagittal','Current|mpr|coronal',
                          'Related','Related|mpr|axial','Related|mpr|sagittal','Related|mpr|coronal'],
                         [value for value,_ in options])
        for index,orientation in [(1,'axial'),(2,'sagittal'),(3,'coronal')]:
            self.page.get_by_label('Cell '+str(index)).select_option('Current|mpr|'+orientation)
        self.page.locator('#kin-hp-save-local').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('이 브라우저')
        stored=self.page.evaluate("()=>JSON.parse(localStorage.getItem(KinHangingProtocolModel.ownerKey(owner))).rules[0].layout.cells")
        self.assertEqual([{'alias':'Current','view':'mpr','orientation':'axial'},
                          {'alias':'Current','view':'mpr','orientation':'sagittal'},
                          {'alias':'Current','view':'mpr','orientation':'coronal'},'Current'],stored)
        # Reopening the saved rule shows the same per-cell choice, and renaming the alias follows it.
        self.page.evaluate("hp.end();document.querySelector('#host').textContent='';__mount()")
        expect(self.page.get_by_label('Cell 2')).to_have_value('Current|mpr|sagittal')
        alias=self.page.locator('label').filter(has_text='Alias (ASCII').locator('input').first
        alias.fill('Volume1');alias.dispatch_event('change')
        expect(self.page.get_by_label('Cell 2')).to_have_value('Volume1|mpr|sagittal')
        self.page.locator('#kin-hp-save-local').click();expect(self.page.locator('#kin-hp-status')).to_contain_text('이 브라우저')

if __name__=='__main__':unittest.main(verbosity=2)
