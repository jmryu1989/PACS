const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function fixture(standalone=false,identityReady=true,optionalReady=true){
  const source=fs.readFileSync(require('node:path').join(__dirname,'../config/ohif.js'),'utf8');
  const scripts=[],timers=new Set();let mounts=0,stops=0;
  const window={top:{}};
  // Isolate required note/identity/dock failures from independently tested
  // optional MPR modules. New unseeded dependencies still fail this harness.
  window.KinWorkspaceShortcuts={};window.KinViewerWindows={};
  if(optionalReady){
    for(const name of ['KinVolumeOrientation','KinVolumeDisplay','KinVolumeMarks','KinVolumePreferences','KinVolumeCrosshair','KinVolumeBatch','KinVolumeBatchScout','KinVolumeCurved','KinVolumePath'])window[name]={};
    for(const name of ['kinCreateVolumeOrientation','kinCreateVolumeDisplay','kinCreateVolumeSync','kinCreateVolumeProgressive','kinCreateVolumeMarks','kinCreateVolumePreferences','kinCreateVolumeCrosshair','kinRenderVolumeScout','kinCreateVolumeBatch','kinCreateVolumeCurved','kinCreateVolumePath'])window[name]=()=>{};
  }
  // Note/dock cases isolate their asset; the identity dependency has its own
  // failure/retry case below instead of being mistaken for the note script.
  if(identityReady)window.KinViewerIdentity={};
  if(standalone)window.top=window;
  // S5-U2b-R-001 F02: the bridge connects only after a /me answered writer (kinViewerSession.decide). This fixture's
  // session is a radiologist, and the shared session judgement is loaded with the bridge.
  const context={window,document:{querySelector:()=>null,createElement:()=>({remove(){this.removed=true;}}),head:{append:s=>scripts.push(s)}},
    setTimeout:f=>{timers.add(f);return f;},clearTimeout:f=>timers.delete(f),
    fetch:async()=>({status:200,ok:true,json:async()=>({kind:'member',sub:'reader',roles:['radiologist']})})};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function kinViewerClinicianOnly('),source.indexOf('function kinCreateViewerLayout()'))+
    source.slice(source.indexOf('function kinCreateViewerTechNote()'),source.indexOf('\nwindow.config =')),context);
  const extension=context.kinCreateViewerTechNote();extension.preRegistration({servicesManager:{services:{}}});
  // S5-U2b-X5-R-001 F01: the bridge is handed the document's session (kinViewerSession.writeModule); `handed` keeps what it got.
  const install=()=>{window.kinViewerTechNote=(services,session)=>{handed=session;return {mount(){mounts++;return true;},stop(){stops++;}};};};
  let handed;
  return {extension,window,scripts,timers,install,mounts:()=>mounts,stops:()=>stops,handed:()=>handed,
    session:()=>vm.runInContext('kinViewerSession',context)};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('all optional MPR asset failures still allow exactly one note bridge mount',async()=>{
  const f=fixture(false,true,false);f.extension.onModeEnter();await flush();
  const optional=f.scripts.filter(s=>s.src?.includes('volume-'));assert.ok(optional.length>0);
  assert.equal(f.scripts.some(s=>s.src?.endsWith('/viewer-tech-note.js')),false);
  for(const script of optional)script.onerror();await flush();
  assert.ok(optional.every(s=>s.removed&&s.onload===null));
  const bridge=f.scripts.find(s=>s.src?.endsWith('/viewer-tech-note.js'));assert.ok(bridge);
  f.install();bridge.onload();await flush();assert.equal(f.window.kinViewerNoteConnectionState(),'ready');assert.equal(f.mounts(),1);
  f.extension.onModeExit();assert.equal(f.stops(),1);assert.equal(f.timers.size,0);
});
test('identity asset failure retries before loading and mounting note bridge',async()=>{
  const f=fixture(false,false);f.extension.onModeEnter();await flush();
  const identity=f.scripts.find(s=>s.src?.endsWith('/viewer-identity.js'));assert.ok(identity);
  assert.equal(f.scripts.some(s=>s.src?.endsWith('/viewer-tech-note.js')),false);
  identity.onerror();await flush();assert.equal(f.window.kinViewerNoteConnectionState(),'failed');assert.equal(f.mounts(),0);
  f.window.kinViewerNoteReconnect();await flush();
  const retry=f.scripts.filter(s=>s.src?.endsWith('/viewer-identity.js')).at(-1);assert.notEqual(retry,identity);
  f.window.KinViewerIdentity={};retry.onload();await flush();
  const bridge=f.scripts.find(s=>s.src?.endsWith('/viewer-tech-note.js'));assert.ok(bridge);
  f.install();bridge.onload();await flush();assert.equal(f.mounts(),1);
  f.extension.onModeExit();assert.equal(f.stops(),1);assert.equal(f.timers.size,0);
});
test('standalone dock asset failure retries without mounting a partial bridge',async()=>{
  const f=fixture(true);f.window.KinTechNote=()=>{};f.extension.onModeEnter();await flush();
  const dock=f.scripts.find(s=>s.src?.endsWith('/viewer-workspace-dock.js'));assert.ok(dock);
  dock.onerror();await flush();assert.equal(f.window.kinViewerNoteConnectionState(),'failed');assert.equal(f.mounts(),0);
  f.window.kinViewerNoteReconnect();await flush();
  const retry=f.scripts.filter(s=>s.src?.endsWith('/viewer-workspace-dock.js')).at(-1);assert.notEqual(retry,dock);
  f.window.KinViewerWorkspaceDock=()=>{};retry.onload();await flush();
  const bridge=f.scripts.find(s=>s.src?.endsWith('/viewer-tech-note.js'));assert.ok(bridge);f.install();bridge.onload();await flush();assert.equal(f.mounts(),1);
  f.extension.onModeExit();assert.equal(f.stops(),1);assert.equal(f.timers.size,0);
});
test('failed asset retries once, mounts once and ignores repeated ready retries',async()=>{
  const f=fixture();f.extension.onModeEnter();await flush();assert.equal(f.scripts.length,1);
  f.scripts[0].onerror();await flush();assert.equal(f.window.kinViewerNoteConnectionState(),'failed');
  assert.equal(f.scripts[0].removed,true);assert.equal(f.timers.size,0);
  f.window.kinViewerNoteReconnect();f.window.kinViewerNoteReconnect();await flush();assert.equal(f.scripts.length,2);
  f.install();f.scripts[1].onload();await flush();assert.equal(f.mounts(),1);
  f.window.kinViewerNoteReconnect();await flush();assert.equal(f.mounts(),1);
  f.extension.onModeExit();assert.equal(f.stops(),1);assert.equal(f.window.kinViewerNoteConnectionState(),'stopped');
});
test('late load after exit never mounts; reentry mounts only current lifecycle',async()=>{
  const f=fixture();f.extension.onModeEnter();await flush();f.extension.onModeExit();
  f.install();f.scripts[0].onload();await flush();assert.equal(f.mounts(),0);
  f.window.kinViewerNoteReconnect();await flush();assert.equal(f.mounts(),0);
  f.extension.onModeEnter();await flush();assert.equal(f.mounts(),1);assert.equal(f.scripts.length,1);
});
test('S5-U2b-X5-R-001 F01: the bridge gets the document session; the document end keeps it in place until mode exit, clinician-only stops it',async()=>{
  for(const [end,stopped,state] of [['refused',0,'refused'],['clinician-only',1,'read-only']]){
    const f=fixture();f.extension.onModeEnter();await flush();
    f.install();f.scripts[0].onload();await flush();
    assert.equal(f.window.kinViewerNoteConnectionState(),'ready',end);assert.equal(f.mounts(),1);
    const session=f.session();assert.equal(f.handed(),session.writeModule,end);
    if(end==='refused')session.refuse();else session.note({kind:'member',sub:'reader',roles:['clinician']});
    // The real bridge ends itself in place through writeModule.onEnd (viewer-tech-note.js); the gate keeps it for mode exit and
    // names why. Clinician-only is still taken down by the gate.
    assert.deepEqual([f.stops(),f.window.kinViewerNoteConnectionState(),session.state()],[stopped,state,state],end);
    f.window.kinViewerNoteReconnect();await flush();assert.equal(f.mounts(),1,end);
    f.extension.onModeExit();assert.equal(f.stops(),1,end);
    // A mode entry of the ended or read-only document connects nothing.
    f.extension.onModeEnter();await flush();assert.deepEqual([f.mounts(),f.window.kinViewerNoteConnectionState()],[1,state],end);
  }
});
test('timeout clears failed node and reentry during pending load has one mount',async()=>{
  const f=fixture();f.extension.onModeEnter();await flush();[...f.timers][0]();await flush();
  assert.equal(f.window.kinViewerNoteConnectionState(),'failed');assert.equal(f.scripts[0].onload,null);
  f.window.kinViewerNoteReconnect();await flush();f.extension.onModeExit();f.extension.onModeEnter();
  f.install();f.scripts[1].onload();await flush();assert.equal(f.mounts(),1);assert.equal(f.scripts.length,2);
});

/* S5-U2c fix4 (Astra S5-U2c-C-R-001 F01) at the bridge's own requests (viewer-tech-note.js raw()): fix3's rule for the viewer
 * document's session. A 401, or a /me answer of another account than the document's first one, reaching a bridge that let its
 * request go — the viewer shows other studies (live() false, the bridge not ended yet), the document refused this account first
 * (another panel's /me 403 ends the bridge in place), or mode exit stopped it — ends the document's login ('unauthorized' /
 * 'account-changed', promoted once over the refusal); the bridge applies none of it, one that ended or stopped shows nothing new, and
 * the write modules' in-place end (enders) is not run again. The shipped bridge is mounted standalone in a vm realm with a minimal
 * DOM and its dependencies as loaded (tests/clinician_viewer_dom_test.py REAL_NOTE_DEPS; the patient copy, toolbar preferences
 * and volume projection, tested on their own, stand in), handed the shipped kinViewerSession.writeModule. The transport holds the
 * requests a case names and does not honour the bridge's abort, so an answer already on the wire still arrives. */
const NOTE_SOURCE=fs.readFileSync(require('node:path').join(__dirname,'../worklist-v0/hpacs-lite/viewer-tech-note.js'),'utf8');
const NOTE_STUDY='1.2.840.99.1',NOTE_OTHER_STUDY='1.2.840.99.2';
const NOTE_FIRST={kind:'member',institution:'SYN-INST',sub:'SYN-READER-1',roles:['radiologist']},NOTE_OTHER={...NOTE_FIRST,sub:'SYN-READER-2'};
// viewer-tech-note.js end(), connect() and raw() wording.
const NOTE_ENDED='세션이나 영상창이 변경되었습니다. 뷰어를 새로 여세요.',NOTE_READY='선택한 영상 칸의 검사 메모 · Control+Alt+6',NOTE_DROPPED='영상창이 변경되었습니다';
const NOTE_LATE={'401':[401,{message:'SYN unauthorized'},'unauthorized'],'another account':[200,NOTE_OTHER,'account-changed']};
const noteTick=async(n=20)=>{for(let i=0;i<n;i++)await new Promise(resolve=>setImmediate(resolve));};
function noteSession(){
  const source=fs.readFileSync(require('node:path').join(__dirname,'../config/ohif.js'),'utf8');
  const context=vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function kinViewerClinicianOnly('),source.indexOf('function kinCreateViewerLayout()')),context);
  return vm.runInContext('kinViewerSession',context);
}
const noteElement=tag=>{const children=[];return {tagName:tag,children,style:{},dataset:{},textContent:'',hidden:false,disabled:false,id:'',title:'',
  append:(...items)=>{children.push(...items);},prepend:(...items)=>{children.unshift(...items);},after(){},remove(){},setAttribute(){},removeAttribute(){},
  getAttribute:()=>null,hasAttribute:()=>false,querySelector:()=>null,querySelectorAll:()=>[],focus(){},scrollIntoView(){},getClientRects:()=>[]};};
// A writer document (NOTE_FIRST confirmed by the other panels) with the bridge connected; `hold(url)` names the requests the case answers.
async function noteWorld(source=NOTE_SOURCE){
  const session=noteSession(),reasons=[],held=[],log=[];
  assert.equal(session.note(NOTE_FIRST),'writer');
  session.onEnded(reason=>{reasons.push(reason);});
  // Another write module of the document: its in-place end runs once, at the document's first refusal or end.
  let enders=0;session.writeModule.onEnd(()=>{enders++;});
  let hold=()=>false,noteApi=null;
  const response=(status,body,bad)=>({status,ok:status>=200&&status<300,json:async()=>{if(bad)throw new SyntaxError('SYN not JSON');return JSON.parse(JSON.stringify(body));}});
  const answer=url=>url==='/api/me'?response(200,NOTE_FIRST):url==='/api/syn-note'?response(200,{ok:true}):response(404,{message:'SYN not here'});
  const fetch=async url=>{log.push(url);if(!hold(url))return answer(url);return new Promise(resolve=>{held.push({url,release:(status,body,bad)=>resolve(response(status,body,bad))});});};
  const host=noteElement('details');host.append(noteElement('summary'));
  const sandbox={document:{createElement:noteElement,head:noteElement('head'),activeElement:null,querySelector:s=>s==='#kin-viewer-layout'?host:null,
      querySelectorAll:()=>[],addEventListener(){},removeEventListener(){}},
    location:{search:'?StudyInstanceUIDs='+NOTE_STUDY,hash:'',origin:'https://kin.test'},fetch,crypto,AbortController,URL,URLSearchParams,
    setTimeout:(callback,ms)=>{const timer=setTimeout(callback,ms);timer.unref();return timer;},clearTimeout,
    // The bridge's 500 ms check never runs on its own here: a case that leaves the screen sees the answer before any tick would end it.
    setInterval:()=>0,clearInterval(){},addEventListener(){},removeEventListener(){},
    KinViewerWindows:{connect:()=>({dispose(){}})},KinViewerWorkspaceDock:()=>null,
    KinWorkspaceShortcuts:{read:()=>({image:'Control+Alt+2',report:'Control+Alt+4',note:'Control+Alt+6',tools:'Control+Alt+7',nativeTools:'Control+Alt+9'}),display:value=>String(value),action:()=>null},
    // The note editor keeps the api the bridge hands it: /me before and after each note request, as the real editor's requests do.
    KinTechNote:options=>{noteApi=options.api;return {open(){},dispose(){}};}};
  sandbox.window=sandbox.top=sandbox;
  vm.runInContext(source,vm.createContext(sandbox),{filename:'viewer-tech-note.js'});
  sandbox.kinCreateViewerPatientCopy=()=>({refresh(){},tracked:()=>false,end(){},dispose(){}});
  sandbox.kinCreateViewerToolbarPreferences=()=>({dispose(){}});
  sandbox.kinCreateVolumeProjection=()=>({dispose(){}});
  const bridge=sandbox.kinViewerTechNote({},session.writeModule);
  assert.equal(bridge.mount(),true);await noteTick();
  const find=(root,match)=>match(root)?root:root.children.map(c=>find(c,match)).find(Boolean)||null;
  const status=()=>find(host,e=>e.id==='kin-viewer-note-status').textContent;
  assert.equal(status(),NOTE_READY,'the bridge works for the document\'s account');
  return {session,reasons,held,log,enders:()=>enders,holdWhen:fn=>{hold=fn;},sandbox,bridge,status,
    // Everything the bridge shows (texts, disabled and hidden controls), as one comparable value.
    view:()=>JSON.stringify(host),request:()=>noteApi('GET','/syn-note').then(()=>'sent',error=>error.message)};
}
// A note request held at the /me the editor's api asks first, or at the note request itself. Its pending outcome is handed back
// inside an object: an async function that returned it would itself wait for it.
async function noteHeld(w,at){
  w.holdWhen(at==='/me'?url=>url==='/api/me':url=>url==='/api/syn-note');
  const outcome=w.request();await noteTick();
  assert.deepEqual([w.held.length,w.held[0].url],[1,at==='/me'?'/api/me':'/api/syn-note'],at);
  w.holdWhen(()=>false);
  return {outcome};
}
// How the bridge lets the held request go: the viewer shows other studies (the bridge not ended), the document refuses this account
// (another panel's /me 403, which ends the bridge in place), or mode exit stops the bridge.
function noteLetGo(w,drop){
  if(drop==='screen')w.sandbox.location.search='?StudyInstanceUIDs='+NOTE_OTHER_STUDY;
  else if(drop==='refusal')w.session.refuse('forbidden');
  else w.bridge.stop();
}
test('S5-U2c fix4 (a)(b): a late 401 or another account reaching a Tech Note bridge that let its request go is the document\'s end; the bridge applies none of it',async()=>{
  for(const drop of ['screen','refusal','exit'])for(const late of ['401','another account'])for(const at of late==='401'?['/me','note request']:['/me']){
    const label=[drop,late,at].join(' / ');
    const w=await noteWorld();
    const {outcome}=await noteHeld(w,at);
    noteLetGo(w,drop);await noteTick();
    assert.deepEqual([w.session.state(),w.reasons.join(),w.enders()],drop==='refusal'?['refused','forbidden',1]:['writer','',0],label);
    const [status,body,reason]=NOTE_LATE[late];
    const seen=w.view(),asked=w.log.length;
    w.held[0].release(status,body);
    assert.equal(await outcome,NOTE_DROPPED,label+': nothing of the answer is used');await noteTick();
    assert.deepEqual([w.session.state(),w.reasons.join(),w.enders(),w.log.length],['refused',drop==='refusal'?'forbidden,'+reason:reason,1,asked],label);
    if(drop==='screen')assert.equal(w.status(),NOTE_ENDED,label+': the document\'s end reaches the bridge still mounted');
    else assert.equal(w.view(),seen,label+': the bridge that had ended or stopped shows nothing new');
    const later=[];w.session.onEnded(r=>{later.push(r);});
    assert.deepEqual([later.join(),w.enders(),w.session.writeModule.answer(NOTE_FIRST)],[reason,1,false],label);
  }
});
test('S5-U2c fix4 (c): what else a dropped answer says changes nothing, and the answers the bridge uses go as before',async()=>{
  // Off the screen it was asked for: a dropped /me of the document's own account (a writer, or clinician-only) gives no verdict; a
  // dropped /me 403, 500 or body that is not JSON, and a dropped note request's 403, end nothing. Back on that screen a note is sent.
  for(const [at,status,body,bad,label] of [['/me',200,NOTE_FIRST,false,'same account'],['/me',200,{...NOTE_FIRST,roles:['clinician']},false,'same account, clinician-only'],
    ['/me',403,{message:'SYN forbidden'},false,'/me 403'],['/me',500,{message:'SYN'},false,'/me 500'],['/me',200,null,true,'/me not JSON'],
    ['note request',403,{message:'SYN forbidden'},false,'note 403']]){
    const w=await noteWorld();
    const {outcome}=await noteHeld(w,at);
    noteLetGo(w,'screen');
    w.held[0].release(status,body,bad);
    assert.equal(await outcome,NOTE_DROPPED,label);await noteTick();
    assert.deepEqual([w.session.state(),w.reasons.join(),w.enders()],['writer','',0],label);
    w.sandbox.location.search='?StudyInstanceUIDs='+NOTE_STUDY;
    assert.equal(await w.request(),'sent',label+': the bridge works again on its screen');
  }
  // The answers the bridge uses: the note request's /me answering 401, 403 or another account ends the document with that reason
  // once (the bridge in place, nothing more asked); the same account sends the note.
  for(const [status,body,reason,said] of [[401,{message:'SYN'},'unauthorized','메모 계정 또는 접근 권한을 확인하세요'],
    [403,{message:'SYN'},'forbidden','메모 계정 또는 접근 권한을 확인하세요'],[200,NOTE_OTHER,'account-changed','메모 계정이 변경되었습니다']]){
    const w=await noteWorld();
    const {outcome}=await noteHeld(w,'/me'),asked=w.log.length;
    w.held[0].release(status,body);
    assert.equal(await outcome,said,reason);await noteTick();
    assert.deepEqual([w.session.state(),w.reasons.join(),w.enders(),w.status(),w.log.length],['refused',reason,1,NOTE_ENDED,asked],reason);
  }
  const same=await noteWorld();
  const {outcome}=await noteHeld(same,'/me');
  same.held[0].release(200,NOTE_FIRST);
  assert.equal(await outcome,'sent');
  assert.deepEqual([same.session.state(),same.reasons.join(),same.enders(),same.status(),same.log.slice(-3)],
    ['writer','',0,NOTE_READY,['/api/me','/api/syn-note','/api/me']]);
});
test('S5-U2c fix4 control: with the bridge dropping those answers unread (the file before fix4), the late 401 or account is lost',async()=>{
  const kept="if(!live()){if(r.status===401)session?.refuse('unauthorized');else if(path==='/me'&&r.ok)session?.sameAccount(await r.json().catch(()=>null));throw new Error('영상창이 변경되었습니다');}";
  assert.equal(NOTE_SOURCE.split(kept).length-1,1);
  const unkept=NOTE_SOURCE.replace(kept,"if(!live())throw new Error('영상창이 변경되었습니다');");
  for(const [drop,late,at,before] of [['screen','401','/me',['writer','',0]],['screen','401','note request',['writer','',0]],
    ['refusal','401','/me',['refused','forbidden',1]],['exit','another account','/me',['writer','',0]]]){
    const w=await noteWorld(unkept);
    const {outcome}=await noteHeld(w,at);
    noteLetGo(w,drop);await noteTick();
    w.held[0].release(...NOTE_LATE[late].slice(0,2));await outcome;await noteTick();
    assert.deepEqual([w.session.state(),w.reasons.join(),w.enders()],before,[drop,late,at].join(' / '));
  }
});

// The Job panel's cases of the same rule (tests/viewer_jobs_session_test.cjs) run in this process too, so the existing hosted
// Validate step for this file executes them; `node --test tests/viewer_jobs_session_test.cjs` runs them alone.
require('./viewer_jobs_session_test.cjs');
