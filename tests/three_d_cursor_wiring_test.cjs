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
  const calls=[],gates={},stateCalls=[];
  const answer=kind=>{
    calls.push(kind);
    const plan=spec[kind]||'settled';
    if(plan==='throw')throw new Error(kind+' threw');
    if(plan==='reject')return Promise.reject(new Error(kind+' rejected'));
    if(plan==='pending'){const gate=deferred();gates[kind]=gate;return gate.promise;}
    return Promise.resolve(plan);
  };
  /* state()는 컨트롤러가 호스트에게 자기 오염(poisoned)을 말하는 유일한 창구다(컨트롤러
     :682-687). 'throw'는 그 창구 자체가 막힌 경우다. 호출 기록은 calls와 섞지 않는다. */
  const made={calls,gates,stateCalls,refresh(){},
    state:()=>{stateCalls.push('state');
      if(spec.state==='throw')throw new Error('state threw');
      return spec.state===undefined?{}:spec.state;},
    disable:()=>answer('disable'),stop:()=>answer('stop')};
  sink.push(made);
  return made;
}

/* 실제 컨트롤러를 태울 수 있을 만큼만의 노드다. append/remove/contains/listener/rect까지만
   있고 레이아웃은 없다. 기존 시험이 보던 것(id, tagName)은 그대로 둔다. */
function node(id){
  const self={id,tagName:'DIV',style:{},dataset:{},attributes:{},listeners:{},children:[],
    parentElement:null,isConnected:true,textContent:'',
    setAttribute(name,value){self.attributes[name]=String(value);},
    getAttribute(name){return Object.prototype.hasOwnProperty.call(self.attributes,name)?self.attributes[name]:null;},
    addEventListener(type,handler){(self.listeners[type]||(self.listeners[type]=[])).push(handler);},
    removeEventListener(type,handler){const list=self.listeners[type]||[];
      const at=list.indexOf(handler);if(at>=0)list.splice(at,1);},
    append(...kids){for(const kid of kids){if(kid&&typeof kid==='object'){kid.parentElement=self;self.children.push(kid);}}},
    remove(){const parent=self.parentElement;
      if(parent){const at=parent.children.indexOf(self);if(at>=0)parent.children.splice(at,1);}
      self.parentElement=null;self.isConnected=false;},
    contains(other){return other===self||self.children.some(kid=>kid.contains&&kid.contains(other));},
    getBoundingClientRect:()=>({left:0,top:0,width:600,height:400,right:600,bottom:400}),
    get firstElementChild(){return self.children[0]||null;},
    // 시험이 사용자의 클릭을 그대로 밀어 넣는 통로. 컨트롤러가 붙인 진짜 핸들러를 부른다.
    fire(type,event){for(const handler of (self.listeners[type]||[]).slice())handler(event||{});
      return (self.listeners[type]||[]).length;}};
  return self;
}

function harness(options){
  const o=options||{};
  const scripts=[],removed=[],controllers=[],winListeners={},channels=[],studyGates=[];
  const sandbox={setTimeout,clearTimeout,Promise,Error,Array,JSON,Number,Object,console};
  const element=id=>node(id);
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
    KinThreeDCursorModel:(o.modulesPresent||o.real)?{}:undefined,
    // o.real이 있으면 합성 컨트롤러 대신 출하되는 실제 모듈의 mount 결과를 준다.
    KinViewerThreeDCursor:(o.modulesPresent||o.real)?{mount(config){sandbox.__mounted=config;
      if(!o.real)return controller((o.controllers||[])[controllers.length]||{},controllers);
      const made=o.real(config);controllers.push(made);return made;}}:undefined};
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

/* C-B9-01 수정2 (독립검토 B1). 패널의 토글은 호스트를 거치지 않고 스스로 disable('off')을
   부르고 그 반환값을 버린다. 그 종료가 busy 중에 일어나 drain이 'unsettled'로 끝나면 기록은
   컨트롤러 안 poisoned에만 남고, 늦게 끝난 요청이 정리된 뒤의 호스트 disable·stop은 'idle'을
   돌려주므로 반환값만 읽는 호스트는 그 미완료를 보지 못한다. 아래 두 시험은 그 경계를
   전사하지 않고 출하되는 컨트롤러 모듈 자체를 실행해 확인한다: 호스트는 위와 같은
   config/ohif.js 조각이고, 컨트롤러는 require로 불러온 shipped 파일이며, disable/drain/
   poisoned/stop의 상태 기계는 실제로 돈다. 합성인 것은 주변 장치(문서·pane·viewport)와
   mount가 이미 노출하는 주입 값(tick·시도 횟수)뿐이다. 실제 native 요청은 재현하지 않고,
   끝나지 않는 setImageIdIndex가 그 자리를 대신한다. */
const realModule=require('../worklist-v0/hpacs-lite/viewer-three-d-cursor.js');
// drain은 짧게, navigation은 시험이 풀어줄 때까지 기다리게 한다(둘 다 mount의 주입값이다).
const realKnobs={drainAttempts:3,confirmAttempts:3,navigationAttempts:100000,
  tick:()=>new Promise(resolve=>setTimeout(resolve,0))};
const realDoc=()=>{const created=[];
  return {created,createElement:()=>{const made=node('');created.push(made);return made;},
    addEventListener(){},removeEventListener(){}};};
function realSeries(prefix,seriesUid,count,gap){
  const ids=[],meta={};
  for(let k=0;k<count;k++){
    const imageId=prefix+':'+k;ids.push(imageId);
    meta['instance:'+imageId]={StudyInstanceUID:'1.2.3',SeriesInstanceUID:seriesUid,
      SOPInstanceUID:seriesUid+'.'+(k+1),FrameOfReferenceUID:'1.2.9',Modality:'CT',
      ImageOrientationPatient:[1,0,0,0,1,0],ImagePositionPatient:[0,0,gap*k],
      PixelSpacing:[1,1],Rows:64,Columns:64};
  }
  return {ids,meta};
}
/* 고정된 StackViewport의 최소 모습. setImageIdIndex는 시험이 풀어줄 때까지 끝나지 않는
   요청이고, 그것이 이 시험에서 취소할 수 없는 native 요청의 자리다. */
function realViewport(id,ids,gap,index){
  const gates=[];
  const self={type:'stack',id,viewportStatus:'ready',index,gates,
    getRenderingEngine:()=>({id:'engine-1'}),
    getImageIds:()=>ids,
    getCurrentImageIdIndex:()=>self.index,
    getCurrentImageId:()=>ids[self.index],
    getCornerstoneImage:()=>({imageId:ids[self.index]}),
    // 첫 장의 원점이 [0,0,0]이고 화소 간격이 1 mm라 캔버스 좌표가 곧 현재 단면 위의 mm다.
    canvasToWorld:point=>[point[0],point[1],gap*self.index],
    worldToCanvas:world=>[world[0],world[1]],
    setImageIdIndex(next){const gate=deferred();gates.push(gate);
      return gate.promise.then(()=>{self.index=next;});}};
  return self;
}
// 호스트가 실제로 무엇을 돌려받았는지 남기는 기록지다. 판정은 그대로 컨트롤러가 한다.
function recorded(real,calls){
  const log=(name,value)=>{calls.push([name,value]);return value;};
  return {real,refresh:()=>real.refresh(),state:()=>real.state(),
    disable:reason=>Promise.resolve(real.disable(reason)).then(
      value=>log('disable',value),error=>{log('disable','threw');throw error;}),
    stop:()=>Promise.resolve(real.stop()).then(
      value=>log('stop',value),error=>{log('stop','threw');throw error;})};
}
async function realStarted(){
  const a=realSeries('ct-a','1.2.3.4',5,5),b=realSeries('ct-b','1.2.3.9',5,5);
  const viewportA=realViewport('pane-a',a.ids,5,0),viewportB=realViewport('pane-b',b.ids,5,3);
  const elementA=node('pane-a'),elementB=node('pane-b');
  const calls=[],docs=[];
  const made=harness({config:{kinThreeDCursor:{enabled:true}},
    studies:[{uid:'1.2.3',sourcePatientKey:'inst|patient'}],
    metaData:Object.assign({},a.meta,b.meta),
    elements:{'pane-a':elementA,'pane-b':elementB},
    real:config=>{const doc=realDoc();docs.push(doc);
      return recorded(realModule.mount(Object.assign({},config,{document:doc},realKnobs)),calls);}});
  made.extension.preRegistration({servicesManager:{services:services([
    {viewportId:'pane-a',viewport:viewportA},{viewportId:'pane-b',viewport:viewportB}])}});
  made.extension.onModeEnter();
  await waitFor(()=>made.sandbox.__controllers.length===1,'실제 컨트롤러 mount');
  const toggleOf=at=>{
    const found=docs[at].created.find(item=>item.id==='kin-3d-cursor-toggle');
    assert.ok(found,'패널 토글 버튼이 만들어지지 않았다');
    return found;};
  return {extension:made.extension,sandbox:made.sandbox,calls,docs,toggleOf,
    viewportA,viewportB,elementA,elementB,
    real:()=>made.sandbox.__controllers[made.sandbox.__controllers.length-1].real};
}

test('패널이 스스로 미완료 종료를 낸 뒤 호스트 종료가 idle이어도 그 창은 영구히 막힌다 (M6, 실제 컨트롤러)',async()=>{
  const it=await realStarted();
  const real=it.real(),toggle=it.toggleOf(0);
  // 1) 사용자가 패널 버튼으로 켠다.
  toggle.fire('click',{});
  assert.equal(real.state().enabled,true,'실제 컨트롤러가 켜지지 않았다');
  assert.equal((it.elementA.listeners.click||[]).length,1,'pane에 컨트롤러의 클릭 처리기가 없다');
  // 2) pane을 클릭해 실제 run을 시작한다. 대상 pane의 영상 요청은 끝나지 않는다.
  it.elementA.fire('click',{clientX:10,clientY:10});
  await waitFor(()=>it.viewportB.gates.length===1,'대상 pane의 영상 요청');
  assert.equal(real.state().busy,true,'run이 진행 중이 아니다');
  // 3) run이 진행 중인데 사용자가 같은 버튼으로 끈다. 이 경로는 반환값을 버린다.
  toggle.fire('click',{});
  await waitFor(()=>real.state().poisoned,'패널 자체 종료의 미완료(poisoned)');
  assert.equal(real.state().teardown,'unsettled');
  // 4) 늦게 끝난 요청이 정리된다. 컨트롤러의 poisoned는 남지만 teardown 기록은 덮인다.
  it.viewportB.gates[0].resolve();
  await waitFor(()=>real.state().busy===false,'늦은 요청의 정리');
  await idle();
  // 5) 모드 이탈. 호스트가 보는 반환값은 미완료가 아니다.
  it.extension.onModeExit();
  await idle();
  assert.deepEqual(it.calls,[['disable','idle'],['stop','idle']],
    '이 회귀의 전제(호스트가 idle만 본다)가 성립하지 않는다');
  assert.equal(real.state().poisoned,true,'컨트롤러의 오염이 사라졌다');
  assert.equal(status(it.sandbox).blocked,true,
    '컨트롤러의 미완료 종료가 창 단위 기억으로 올라가지 않았다');
  // 6) 같은 뷰어 창에서 다시 진입해도 새 컨트롤러로 회복되지 않는다.
  it.extension.onModeEnter(); it.extension.onModeEnter();
  await idle();
  assert.equal(it.sandbox.__controllers.length,1,'오염된 창에서 컨트롤러 교체로 회복했다');
  assert.equal(status(it.sandbox).mounted,false);
  assert.equal(status(it.sandbox).mounts,1);
  assert.equal(status(it.sandbox).blocked,true);
});

test('패널로 정상 종료한 뒤에는 같은 창에서 다시 진입할 수 있다 (실제 컨트롤러)',async()=>{
  const it=await realStarted();
  const real=it.real(),toggle=it.toggleOf(0);
  toggle.fire('click',{});
  assert.equal(real.state().enabled,true);
  toggle.fire('click',{});
  await waitFor(()=>real.state().teardown==='settled','패널의 정상 종료');
  assert.equal(real.state().poisoned,false);
  it.extension.onModeExit();
  await idle();
  assert.deepEqual(it.calls,[['disable','idle'],['stop','idle']]);
  assert.equal(status(it.sandbox).blocked,false,'정상 종료가 창을 막았다');
  it.extension.onModeEnter();
  await waitFor(()=>it.sandbox.__controllers.length===2,'정상 종료 뒤 재진입');
  assert.equal(status(it.sandbox).mounted,true);
  assert.equal(status(it.sandbox).mounts,2);
});

test('teardown이 idle이어도 컨트롤러가 오염돼 있으면 그 창을 막는다 (M6)',async()=>{
  const {extension,sandbox}=await started({controllers:[{state:{poisoned:true,teardown:'idle'}}]});
  extension.onModeExit();
  await idle();
  assert.deepEqual(sandbox.__controllers[0].calls,['disable','stop']);
  assert.equal(status(sandbox).blocked,true,'이전 컨트롤러의 오염을 이어받지 않았다');
  extension.onModeEnter();
  await idle();
  assert.equal(sandbox.__controllers.length,1);
  assert.equal(status(sandbox).mounts,1);
});

test('컨트롤러 상태를 읽지 못하면 재마운트를 허용하지 않는다 (M6)',async()=>{
  const {extension,sandbox}=await started({controllers:[{state:'throw'}]});
  extension.onModeExit();
  await idle();
  // 상태를 못 읽어도 정리 자체는 계속 시도한다.
  assert.deepEqual(sandbox.__controllers[0].calls,['disable','stop']);
  assert.ok(sandbox.__controllers[0].stateCalls.length>=1,'상태를 읽으려는 시도가 없었다');
  assert.equal(status(sandbox).blocked,true,'상태 읽기 실패가 조용히 재마운트를 허용했다');
  extension.onModeEnter();
  await idle();
  assert.equal(sandbox.__controllers.length,1);
  assert.equal(status(sandbox).mounts,1);
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
