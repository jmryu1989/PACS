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
