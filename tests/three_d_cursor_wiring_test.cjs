/* REQ-D-3D-CURSOR / TEST-3D-CURSOR-WIRING-PURE.
   The loader as a whole needs OHIF, but the two decisions that must not drift are pure: how the
   flag is read, and which grid cells become pane candidates. Both are sliced out of the shipped
   config/ohif.js and run in a fresh context (tests/ct_sync_test.cjs:1-5의 관례), so this file
   asserts the bytes that are committed, not a copy of them. */
const {test}=require('node:test');
const strict=require('node:assert/strict');
// vm.runInNewContext는 다른 realm이라 배열·객체의 prototype이 host와 다르다. 구조 비교는
// JSON 왕복 뒤에 한다.
const plain=value=>JSON.parse(JSON.stringify(value===undefined?null:value));
const assert={ok:strict.ok,equal:strict.equal,
  deepEqual:(actual,expected,message)=>strict.deepEqual(plain(actual),plain(expected),message)};
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('config/ohif.js','utf8');
const slice=source.slice(source.indexOf('function kinCreateThreeDCursor'),
                         source.indexOf('function kinDicomPdfViewportGuard'));

function harness(options){
  const o=options||{};
  const scripts=[],removed=[];
  const sandbox={setTimeout,clearTimeout,Promise,Error,Array,JSON,Number,Object,console};
  const element=id=>({id,tagName:'DIV'});
  sandbox.document={
    createElement:()=>({set src(value){this._src=value;},get src(){return this._src;},
      onload:null,onerror:null}),
    head:{append(script){scripts.push(script.src);
      // 주입이 일어난 경우에만 전역이 생긴다. 성공 경로를 흉내 낸다.
      queueMicrotask(()=>{sandbox.window[script._global||'']=sandbox.window[script._global||''];script.onload&&script.onload();});}},
    querySelector:selector=>{
      const match=/\[data-viewport-uid="(.+)"\]/.exec(selector);
      if(match)return o.elements&&o.elements[match[1]]!==undefined?o.elements[match[1]]:element(match[1]);
      return selector==='#kin-viewer-layout'?element('kin-viewer-layout'):null;},
    addEventListener(){},removeEventListener(){}};
  sandbox.window={
    config:o.config,
    addEventListener(){},removeEventListener(){},
    BroadcastChannel:function(){throw new Error('no channel in this context');},
    cornerstone:{Enums:{Events:{IMAGE_RENDERED:'IMAGE_RENDERED',STACK_NEW_IMAGE:'STACK_NEW_IMAGE',
      CAMERA_MODIFIED:'CAMERA_MODIFIED'}},metaData:{get:(kind,imageId)=>(o.metaData||{})[kind+':'+imageId]||null}},
    cornerstoneTools:{ToolGroupManager:{getToolGroupForViewport:()=>({getActivePrimaryMouseButtonTool:()=>'WindowLevel'})}},
    KinThreeDCursorModel:o.modulesPresent?{}:undefined,
    KinViewerThreeDCursor:o.modulesPresent?{mount(config){sandbox.__mounted=config;
      return {state:()=>({}),refresh(){},disable:()=>Promise.resolve('settled'),stop:()=>Promise.resolve('settled')};}}:undefined};
  sandbox.fetch=async path=>({ok:true,json:async()=>path==='/api/me'
    ?{kind:'member',institution:'inst',sub:'reader'}
    :{studies:o.studies||[]}});
  sandbox.queueMicrotask=queueMicrotask;
  sandbox.removed=removed;
  const extension=vm.runInNewContext(slice+';kinCreateThreeDCursor()',sandbox);
  return {extension,scripts,sandbox};
}

const services=viewports=>({
  viewportGridService:{EVENTS:{},subscribe:()=>({unsubscribe(){}}),getActiveViewportId:()=>null,
    getState:()=>({viewports:new Map(viewports.map(v=>[v.viewportId,v]))})},
  cornerstoneViewportService:{
    getRenderingEngine:()=>({id:'engine-1'}),
    getCornerstoneViewport:id=>viewports.find(v=>v.viewportId===id)?.viewport||null}});

const stack=(id,engine)=>({type:'stack',id,getRenderingEngine:()=>({id:engine||'engine-1'})});

test('only the boolean literal true switches the extension on',()=>{
  for(const value of [undefined,null,false,'true','',0,1,{enabled:true}]){
    const config=value&&value.enabled!==undefined?{kinThreeDCursor:value}
      :value===undefined?{}:{kinThreeDCursor:{enabled:value}};
    const {extension,scripts}=harness({config});
    extension.preRegistration({servicesManager:{services:services([])}});
    if(value&&value.enabled===true){assert.deepEqual(scripts,['/worklist/hpacs-lite/three-d-cursor-model.js']);continue;}
    assert.deepEqual(scripts,[],'flag value '+JSON.stringify(value)+' must not inject anything');
  }
});

test('a missing kinThreeDCursor key is off and injects nothing',()=>{
  const {extension,scripts}=harness({config:{extensions:[]}});
  extension.preRegistration({servicesManager:{services:services([])}});
  assert.deepEqual(scripts,[]);
});

test('the shipped config commits the flag as the literal false',()=>{
  const committed=vm.runInNewContext('('+source.slice(source.indexOf('kinThreeDCursor: {'),
    source.indexOf('kinThreeDCursor: {')+source.slice(source.indexOf('kinThreeDCursor: {')).indexOf('}')+1)
    .replace('kinThreeDCursor: ','')+')');
  assert.deepEqual(committed,{enabled:false});
  // 런타임 우회 경로가 없다: 켜는 판정은 이 한 줄뿐이다.
  assert.equal(slice.split('window.config?.kinThreeDCursor?.enabled === true').length-1,1);
  for(const bypass of ['localStorage','sessionStorage','URLSearchParams','location.search'])
    assert.equal(slice.includes(bypass),false,bypass+' must not be a way in');
});

test('pane candidates drop a foreign rendering engine, a non-stack and a missing element',async()=>{
  const grid=[
    {viewportId:'ok-1',viewport:stack('ok-1')},
    {viewportId:'other-engine',viewport:stack('other-engine','engine-2')},
    {viewportId:'volume',viewport:{type:'orthographic',id:'volume',getRenderingEngine:()=>({id:'engine-1'})}},
    {viewportId:'no-viewport',viewport:null},
    {viewportId:'no-element',viewport:stack('no-element')},
    {viewportId:'throws',viewport:{type:'stack',id:'throws',getRenderingEngine(){throw new Error('detached');}}},
    {viewportId:'ok-2',viewport:stack('ok-2')}];
  const {extension,sandbox}=harness({config:{kinThreeDCursor:{enabled:true}},modulesPresent:true,
    elements:{'no-element':null}});
  extension.preRegistration({servicesManager:{services:services(grid)}});
  extension.onModeEnter();
  for(let i=0;i<20&&!sandbox.__mounted;i++)await new Promise(r=>setTimeout(r,1));
  assert.ok(sandbox.__mounted,'the controller was never mounted');
  const list=sandbox.__mounted.panes();
  assert.deepEqual(list.map(item=>item.id),['ok-1','ok-2']);
  assert.deepEqual(list.map(item=>item.element.id),['ok-1','ok-2']);
  assert.equal(list[0].viewport,grid[0].viewport);
});

test('the patient key comes from the study row and never from a DICOM tag',async()=>{
  const instance={StudyInstanceUID:'1.2.3',SeriesInstanceUID:'1.2.3.4',SOPInstanceUID:'1.2.3.4.5',
    FrameOfReferenceUID:'1.2.9',Modality:'CT',PatientID:'DICOM-PATIENT-ID',
    ImageOrientationPatient:['1','0','0','0','1','0'],ImagePositionPatient:['0','0','5'],
    PixelSpacing:['0.5','0.5'],Rows:'256',Columns:'256'};
  const {extension,sandbox}=harness({config:{kinThreeDCursor:{enabled:true}},modulesPresent:true,
    studies:[{uid:'1.2.3',sourcePatientKey:'inst|source-patient'}],
    metaData:{'instance:img-1':instance,'instance:img-2':{...instance,StudyInstanceUID:'9.9.9'}}});
  extension.preRegistration({servicesManager:{services:services([])}});
  extension.onModeEnter();
  for(let i=0;i<20&&!sandbox.__mounted;i++)await new Promise(r=>setTimeout(r,1));
  const meta=sandbox.__mounted.meta;
  const built=meta('img-1');
  assert.equal(built.sourcePatientKey,'inst|source-patient');
  assert.equal(built.PatientID,undefined,'the DICOM PatientID is not the identity boundary');
  assert.deepEqual(built.ImageOrientationPatient,[1,0,0,0,1,0]);
  assert.deepEqual(built.PixelSpacing,[0.5,0.5]);
  assert.equal(built.Rows,256);
  // 행이 없는 검사와 메타가 없는 imageId는 pane을 거절시키는 null이다.
  assert.equal(meta('img-2'),null);
  assert.equal(meta('img-missing'),null);
});
