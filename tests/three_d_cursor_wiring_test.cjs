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

const deferred=()=>{let resolve,reject;
  const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});
  return {promise,resolve,reject};};

/* 컨트롤러 계약(worklist-v0/hpacs-lite/viewer-three-d-cursor.js:637-680)의 disable/stop만
   합성한다. 'settled'·'idle'은 정상 종료, 'unsettled'는 취소할 수 없는 native 요청이 남았다는
   뜻이고, 'throw'는 동기 예외, 'reject'는 거절, 'pending'은 아직 끝나지 않은 종료다. 순수 Node
   VM 어댑터이므로 실제 native의 늦은 영상 변경을 재현하지 않는다. */
function controller(spec,sink){
  const calls=[],gates={};
  const answer=kind=>{
    calls.push(kind);
    const plan=spec[kind]||'settled';
    if(plan==='throw')throw new Error(kind+' threw');
    if(plan==='reject')return Promise.reject(new Error(kind+' rejected'));
    if(plan==='pending'){const gate=deferred();gates[kind]=gate;return gate.promise;}
    return Promise.resolve(plan);
  };
  const made={calls,gates,state:()=>({}),refresh(){},
    disable:()=>answer('disable'),stop:()=>answer('stop')};
  sink.push(made);
  return made;
}

function harness(options){
  const o=options||{};
  const scripts=[],removed=[],controllers=[],winListeners={},channels=[],studyGates=[];
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
    // 세션 종료 세 경로를 실제 호스트 함수로 부르려면 window 리스너와 채널이 있어야 한다.
    addEventListener(type,handler){(winListeners[type]||(winListeners[type]=[])).push(handler);},
    removeEventListener(type,handler){const list=winListeners[type]||[];
      const at=list.indexOf(handler);if(at>=0)list.splice(at,1);},
    BroadcastChannel:o.channel
      ?function(name){this.name=name;this.onmessage=null;this.closed=false;
        this.close=()=>{this.closed=true;};channels.push(this);}
      :function(){throw new Error('no channel in this context');},
    cornerstone:{Enums:{Events:{IMAGE_RENDERED:'IMAGE_RENDERED',STACK_NEW_IMAGE:'STACK_NEW_IMAGE',
      CAMERA_MODIFIED:'CAMERA_MODIFIED'}},metaData:{get:(kind,imageId)=>(o.metaData||{})[kind+':'+imageId]||null}},
    cornerstoneTools:{ToolGroupManager:{getToolGroupForViewport:()=>({getActivePrimaryMouseButtonTool:()=>'WindowLevel'})}},
    KinThreeDCursorModel:o.modulesPresent?{}:undefined,
    KinViewerThreeDCursor:o.modulesPresent?{mount(config){sandbox.__mounted=config;
      return controller((o.controllers||[])[controllers.length]||{},controllers);}}:undefined};
  sandbox.fetch=async path=>({ok:true,json:async()=>{
    if(path==='/api/me')return {kind:'member',institution:'inst',sub:'reader'};
    // studyGate를 켜면 /api/studies 응답을 시험이 직접 늦출 수 있다.
    if(o.studyGate){const gate=deferred();studyGates.push(gate);return gate.promise;}
    return {studies:o.studies||[]};}});
  sandbox.queueMicrotask=queueMicrotask;
  sandbox.removed=removed;
  sandbox.__controllers=controllers;
  sandbox.__windowListeners=winListeners;
  sandbox.__channels=channels;
  sandbox.__studyGates=studyGates;
  const extension=vm.runInNewContext(slice+';kinCreateThreeDCursor()',sandbox);
  return {extension,scripts,sandbox};
}

const idle=async ticks=>{for(let i=0;i<(ticks||40);i++)await new Promise(r=>setTimeout(r,0));};
async function waitFor(check,label){
  for(let i=0;i<400;i++){if(check())return;await new Promise(r=>setTimeout(r,1));}
  throw new Error('시간 안에 일어나지 않았다: '+label);
}

const services=viewports=>({
  // grid 구독도 호스트가 해제해야 하는 리스너다. 한 개를 두어 재진입 뒤 개수가 늘지 않음을 본다.
  viewportGridService:{EVENTS:{GRID_STATE_CHANGED:'gridStateChanged'},
    subscribe:()=>({unsubscribe(){}}),getActiveViewportId:()=>null,
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

/* C-B9-01. 검수기록 §13: retire()가 disable/stop을 비동기로 던져두고 그 promise도 반환값도
   보지 않아, 종료가 끝나기 전이나 미완료로 끝난 뒤에도 새 컨트롤러가 mount됐다. 아래는 그
   경계를 고정 호스트 함수만 추출해 합성 어댑터로 확인한다. 실제 native 요청의 뒤늦은 영상
   변경을 재현하지 않는다. */
const status=sandbox=>sandbox.window.kinViewerThreeDCursorState();
async function started(options){
  const o=Object.assign({config:{kinThreeDCursor:{enabled:true}},modulesPresent:true},options||{});
  const made=harness(o);
  made.extension.preRegistration({servicesManager:{services:services(o.grid||[])}});
  made.extension.onModeEnter();
  await waitFor(()=>made.sandbox.__controllers.length===1,'첫 mount');
  return made;
}

test('소스 추출 앵커는 각각 정확히 한 번이다',()=>{
  for(const anchor of ['function kinCreateThreeDCursor','function kinDicomPdfViewportGuard'])
    assert.equal(source.split(anchor).length-1,1,anchor+' 앵커가 한 번이 아니다');
  assert.ok(slice.length>1000&&slice.includes('onModeExit'),'추출한 조각이 호스트 전체가 아니다');
});

test('이전 disable이 끝나기 전에는 어떤 진입도 새 컨트롤러를 만들지 않는다 (M1)',async()=>{
  const {extension,sandbox}=await started({controllers:[{disable:'pending'}]});
  assert.equal(status(sandbox).listeners,4);
  extension.onModeExit();
  extension.onModeEnter(); extension.onModeEnter();
  await idle();
  assert.equal(sandbox.__controllers.length,1,'종료가 pending인데 새 컨트롤러가 생겼다');
  assert.equal(status(sandbox).mounted,false);
  assert.equal(status(sandbox).listeners,0,'종료 중에는 이전 리스너가 남지 않는다');
  assert.deepEqual(sandbox.__controllers[0].calls,['disable']);
  // 정상 settled로 끝나면 가장 나중 진입 요청 하나만 재개한다(다시 enter를 요구하지 않는다).
  sandbox.__controllers[0].gates.disable.resolve('settled');
  await waitFor(()=>sandbox.__controllers.length===2,'종료 뒤 재진입');
  await idle();
  assert.equal(sandbox.__controllers.length,2,'대기하던 진입이 컨트롤러를 둘 만들었다');
  assert.deepEqual(sandbox.__controllers[0].calls,['disable','stop']);
  assert.equal(status(sandbox).blocked,false);
  assert.equal(status(sandbox).mounts,2);
  assert.equal(status(sandbox).listeners,4,'리스너가 중복되지 않는다');
});

test('이전 stop이 끝나기 전에는 새 컨트롤러를 만들지 않는다 (M1)',async()=>{
  const {extension,sandbox}=await started({controllers:[{disable:'settled',stop:'pending'}]});
  extension.onModeExit();
  await idle();
  extension.onModeEnter();
  await idle();
  assert.deepEqual(sandbox.__controllers[0].calls,['disable','stop']);
  assert.equal(sandbox.__controllers.length,1,'stop이 pending인데 새 컨트롤러가 생겼다');
  sandbox.__controllers[0].gates.stop.resolve('settled');
  await waitFor(()=>sandbox.__controllers.length===2,'stop 완료 뒤 재진입');
  assert.equal(status(sandbox).blocked,false);
  assert.equal(status(sandbox).listeners,4);
});

const failures=[
  {label:'disable이 unsettled를 돌려주면',spec:{disable:'unsettled'},guard:'M2'},
  {label:'stop이 unsettled를 돌려주면',spec:{stop:'unsettled'},guard:'M3'},
  {label:'disable이 동기 예외를 던지면',spec:{disable:'throw'},guard:'M4'},
  {label:'disable이 reject하면',spec:{disable:'reject'},guard:'M4'},
  {label:'stop이 동기 예외를 던지면',spec:{stop:'throw'},guard:'M4'},
  {label:'stop이 reject하면',spec:{stop:'reject'},guard:'M4'}];
for(const item of failures)
  test(item.label+' 그 창의 재마운트를 영구히 막는다 ('+item.guard+')',async()=>{
    const {extension,sandbox}=await started({controllers:[item.spec]});
    extension.onModeExit();
    await idle();
    assert.equal(status(sandbox).blocked,true,'미완료 종료가 창을 막지 않았다');
    // 필요한 정리는 오류 뒤에도 시도하되, 그 성공이 기존 차단을 지우지 않는다.
    assert.deepEqual(sandbox.__controllers[0].calls,['disable','stop']);
    extension.onModeEnter(); extension.onModeEnter();
    await idle();
    assert.equal(sandbox.__controllers.length,1,'차단된 창에서 컨트롤러 교체로 회복했다');
    assert.equal(status(sandbox).mounted,false);
    assert.equal(status(sandbox).mounts,1);
    assert.equal(status(sandbox).blocked,true,'뒤따른 정리 성공이 차단을 지웠다');
  });

test('정상 settled 종료 뒤에는 다시 진입할 수 있다',async()=>{
  const {extension,sandbox}=await started({});
  extension.onModeExit();
  await idle();
  assert.deepEqual(sandbox.__controllers[0].calls,['disable','stop']);
  assert.equal(status(sandbox).blocked,false);
  extension.onModeEnter();
  await waitFor(()=>sandbox.__controllers.length===2,'정상 종료 뒤 재진입');
  assert.equal(status(sandbox).mounted,true);
  assert.equal(status(sandbox).listeners,4);
});

test('반복 exit/enter에서 늦게 끝난 이전 종료가 새 상태를 바꾸지 않는다 (M1·M5)',async()=>{
  const {extension,sandbox}=await started({controllers:[{disable:'pending'},{stop:'pending'}]});
  extension.onModeExit();          // 1번 컨트롤러의 disable이 대기한다
  extension.onModeEnter();
  await idle();
  assert.equal(sandbox.__controllers.length,1);
  sandbox.__controllers[0].gates.disable.resolve('settled');
  await waitFor(()=>sandbox.__controllers.length===2,'첫 종료 뒤 재마운트');
  extension.onModeExit();          // 2번 컨트롤러의 stop이 대기한다
  await idle();
  assert.equal(status(sandbox).mounted,false);
  assert.equal(status(sandbox).listeners,0);
  sandbox.__controllers[1].gates.stop.resolve('settled');
  await idle();
  // 늦은 이전 종료의 완료는 mount를 만들지도, 차단을 세우지도 않는다.
  assert.equal(sandbox.__controllers.length,2);
  assert.equal(status(sandbox).mounts,2);
  assert.equal(status(sandbox).blocked,false);
  extension.onModeEnter();
  await waitFor(()=>sandbox.__controllers.length===3,'두 번째 종료 뒤 재진입');
  assert.equal(status(sandbox).listeners,4);
});

test('늦게 도착한 이전 진입이 최신 검사 목록을 덮지 않는다 (M5)',async()=>{
  const instance={StudyInstanceUID:'1.2.3',SeriesInstanceUID:'1.2.3.4',SOPInstanceUID:'1.2.3.4.5',
    FrameOfReferenceUID:'1.2.9',Modality:'CT',ImageOrientationPatient:['1','0','0','0','1','0'],
    ImagePositionPatient:['0','0','5'],PixelSpacing:['0.5','0.5'],Rows:'256',Columns:'256'};
  const {extension,sandbox}=harness({config:{kinThreeDCursor:{enabled:true}},modulesPresent:true,
    studyGate:true,metaData:{'instance:img-1':instance}});
  extension.preRegistration({servicesManager:{services:services([])}});
  extension.onModeEnter();
  await waitFor(()=>sandbox.__studyGates.length===1,'첫 진입의 검사 요청');
  extension.onModeExit();
  extension.onModeEnter();
  await waitFor(()=>sandbox.__studyGates.length===2,'최신 진입의 검사 요청');
  sandbox.__studyGates[1].resolve({studies:[{uid:'1.2.3',sourcePatientKey:'inst|new'}]});
  await waitFor(()=>sandbox.__controllers.length===1,'최신 진입의 mount');
  sandbox.__studyGates[0].resolve({studies:[{uid:'1.2.3',sourcePatientKey:'inst|stale'}]});
  await idle();
  assert.equal(sandbox.__mounted.meta('img-1').sourcePatientKey,'inst|new',
    '늦은 이전 진입이 rows를 덮었다');
  assert.equal(sandbox.__controllers.length,1);
});

const endings=[
  {label:'BroadcastChannel session-ended',fire:sandbox=>{
    assert.equal(sandbox.__channels.length,1,'세션 채널이 열리지 않았다');
    sandbox.__channels[0].onmessage({data:{type:'session-ended'}});}},
  {label:'storage kin-session-ended',fire:sandbox=>{
    for(const handler of (sandbox.__windowListeners.storage||[]).slice())handler({key:'kin-session-ended'});}},
  {label:'pagehide',fire:sandbox=>{
    for(const handler of (sandbox.__windowListeners.pagehide||[]).slice())handler({});}}];
for(const item of endings)
  test('종료가 pending인 상태의 '+item.label+' 뒤 ended가 유지되고 재진입하지 않는다',async()=>{
    const {extension,sandbox}=await started({channel:true,controllers:[{disable:'pending'}]});
    assert.equal(status(sandbox).ended,false);
    item.fire(sandbox);
    assert.equal(status(sandbox).ended,true);
    assert.equal(status(sandbox).mounted,false);
    assert.equal(status(sandbox).listeners,0);
    await idle();
    assert.deepEqual(sandbox.__controllers[0].calls,['disable']);
    // 남은 두 경로를 더 밟아도 ended는 단조롭고 컨트롤러는 늘지 않는다.
    for(const other of endings)if(other!==item&&other.label!=='BroadcastChannel session-ended')other.fire(sandbox);
    extension.onModeEnter();
    await idle();
    assert.equal(status(sandbox).ended,true);
    assert.equal(sandbox.__controllers.length,1,'세션 종료 뒤에 새 컨트롤러가 생겼다');
    sandbox.__controllers[0].gates.disable.resolve('settled');
    await idle();
    extension.onModeEnter();
    await idle();
    assert.equal(sandbox.__controllers.length,1,'종료가 끝난 뒤에도 세션은 다시 열리지 않는다');
    assert.equal(status(sandbox).mounts,1);
    assert.equal(sandbox.__channels[0].closed,true,'세션 채널이 닫히지 않았다');
  });
