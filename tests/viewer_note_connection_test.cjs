const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function fixture(){
  const source=fs.readFileSync(require('node:path').join(__dirname,'../config/ohif.js'),'utf8');
  const scripts=[],timers=new Set();let mounts=0,stops=0;
  const window={top:{}};
  const context={window,document:{createElement:()=>({remove(){this.removed=true;}}),head:{append:s=>scripts.push(s)}},
    setTimeout:f=>{timers.add(f);return f;},clearTimeout:f=>timers.delete(f)};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function kinCreateViewerTechNote()'),source.indexOf('\nwindow.config =')),context);
  const extension=context.kinCreateViewerTechNote();extension.preRegistration({servicesManager:{services:{}}});
  const install=()=>{window.kinViewerTechNote=()=>({mount(){mounts++;return true;},stop(){stops++;}});};
  return {extension,window,scripts,timers,install,mounts:()=>mounts,stops:()=>stops};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
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
test('timeout clears failed node and reentry during pending load has one mount',async()=>{
  const f=fixture();f.extension.onModeEnter();await flush();[...f.timers][0]();await flush();
  assert.equal(f.window.kinViewerNoteConnectionState(),'failed');assert.equal(f.scripts[0].onload,null);
  f.window.kinViewerNoteReconnect();await flush();f.extension.onModeExit();f.extension.onModeEnter();
  f.install();f.scripts[1].onload();await flush();assert.equal(f.mounts(),1);assert.equal(f.scripts.length,2);
});
