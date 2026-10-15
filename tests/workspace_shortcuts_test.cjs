const {test}=require('node:test');
const assert=require('node:assert/strict');
const s=require('../worklist-v0/hpacs-lite/workspace-shortcuts.js');
test('TEST-WORKSPACE-SHORTCUTS rejects ambiguous, reserved and corrupt preference maps',()=>{
  assert.equal(s.valid(s.defaults),true);
  for(const key of ['KeyC','Digit8','F5','Tab','Escape','Delete','Space','Control+KeyR','Digit0',null])assert.equal(s.valid({...s.defaults,list:key}),false,String(key));
  for(const value of [{...s.defaults,list:'Digit2'},{...s.defaults,extra:'KeyQ'},null,[],{}])assert.equal(s.valid(value),false);
  assert.equal(s.valid({...s.defaults,list:'KeyQ'}),true);
});
test('remapped chord resolves exactly once and original chord no longer resolves',()=>{
  const map={...s.defaults,report:'KeyR'},event={ctrlKey:true,altKey:true,code:'KeyR'};
  assert.equal(s.action(map,event),'report');assert.equal(s.action(map,{...event,code:'Digit4'}),null);
  for(const guard of ['repeat','isComposing','defaultPrevented','shiftKey','metaKey'])assert.equal(s.action(map,{...event,[guard]:true}),null);
  assert.equal(s.action(map,{...event,getModifierState:()=>true}),null);
  assert.equal(s.action(map,{...event,ctrlKey:false}),null);
});


// REQ-WS7 -> RISK-WS7 preference loss/wrong command -> TEST-WS7-SHORTCUT-MIGRATION.
// Public model and dialog behavior; no product source-string or DOM-shape pins.
test('v1 migration preserves every valid user key and isolates corrupt actions',()=>{
  const owner=JSON.stringify(['hospital','reader']);
  const map={...s.defaults,image:'KeyI',report:'KeyR'};
  const data=new Map([['kin-workspace-shortcuts:v1:'+owner,JSON.stringify(map)]]);
  const storage={getItem:key=>data.get(key)??null};
  assert.deepEqual(s.read(storage,owner),map);
  const upgraded=s.readV2(storage,owner);
  for(const [id,key] of Object.entries(map))assert.equal(upgraded[id],'Control+Alt+'+key);
  assert.equal(upgraded.version,2);assert.equal(upgraded.finalize,'Control+KeyS');
  data.set('kin-workspace-shortcuts:v1:'+owner,JSON.stringify({...map,image:'KeyC'}));
  assert.equal(s.readV2(storage,owner).image,null);
  assert.equal(s.readV2(storage,owner).report,'Control+Alt+KeyR');
  assert.deepEqual(s.readV2(storage,'other'),s.defaultsV2);
  assert.deepEqual(s.read(storage,null),s.defaults);
  for(const raw of ['{','null',' '.repeat(4097)]){
    data.set('kin-workspace-shortcuts:v1:'+owner,raw);
    assert.ok(Object.entries(s.readV2(storage,owner)).every(([id,key])=>id==='version'||key===null));
  }
  for(const unavailable of [undefined,{getItem(){throw Error('denied');}},{getItem(){return null;}}]){
    assert.deepEqual(s.readV2(unavailable,owner),s.defaultsV2);
    assert.deepEqual(s.read(unavailable,owner),s.defaults);
  }
});
test('v2 exact shape, nullable actions and reserved browser/editing keys',()=>{
  assert.equal(s.valid(s.defaultsV2),true);
  assert.equal(s.valid({...s.defaultsV2,list:null,finalize:null}),true);
  for(const key of ['Control+KeyR','Control+KeyC','Control+Alt+KeyC','Control+Alt+Digit8','Enter','KeyQ','Control+Alt+Enter',undefined,42])
    assert.equal(s.valid({...s.defaultsV2,list:key}),false,String(key));
  for(const value of [{...s.defaultsV2,version:3},{...s.defaultsV2,extra:null},{...s.defaultsV2,list:'Control+KeyS'}])assert.equal(s.valid(value),false);
  for(const id of Object.keys(s.defaultsV2)){const value={...s.defaultsV2};delete value[id];assert.equal(s.valid(value),false,id);}
});
test('new Finalize default never steals an existing user command (Ctrl+S collision mutant)',()=>{
  const source={...s.defaultsV2,list:'Control+KeyS'};delete source.finalize;
  const {map,notices}=s.migrate(source);
  assert.equal(map.list,'Control+KeyS');assert.equal(map.finalize,null);
  assert.ok(notices.some(text=>text.includes('Worklist')&&text.includes('지정')));
  assert.equal(s.action(map,{ctrlKey:true,altKey:false,code:'KeyS'}),'list');
  assert.equal(s.migrate({...s.defaultsV2,finalize:null}).map.finalize,null);
});
test('Finalize resolves without Alt; resolution alone never prevents browser Save Page',()=>{
  let cancelled=0;const event={ctrlKey:true,altKey:false,code:'KeyS',preventDefault(){cancelled++}};
  assert.equal(s.action(s.defaultsV2,event),'finalize');assert.equal(cancelled,0);
  assert.equal(s.action(s.defaultsV2,{...event,altKey:true}),null);
  for(const guard of ['repeat','isComposing','defaultPrevented','shiftKey','metaKey'])assert.equal(s.action(s.defaultsV2,{...event,[guard]:true}),null);
  assert.equal(s.action(s.defaultsV2,{...event,keyCode:229}),null);
  assert.equal(s.action(s.defaultsV2,{...event,getModifierState:()=>true}),null);
  assert.equal(s.action({...s.defaultsV2,finalize:null},event),null);
});
test('v2 takes precedence over legacy storage; existing window snapshots keep their keys',()=>{
  const owner='reader',data=new Map(),storage={getItem:key=>data.get(key)??null};
  data.set('kin-workspace-shortcuts:v1:'+owner,JSON.stringify({...s.defaults,report:'KeyR'}));
  const opened=s.readV2(storage,owner);
  const next={...s.defaultsV2,report:'Control+Alt+KeyQ',image:null};
  data.set('kin-workspace-shortcuts:v2:'+owner,JSON.stringify(next));
  assert.deepEqual(s.readV2(storage,owner),next);
  assert.equal(opened.report,'Control+Alt+KeyR');
  assert.equal(s.read(storage,owner).report,'KeyQ');assert.equal(s.read(storage,owner).image,null);
  data.set('kin-workspace-shortcuts:v2:'+owner,'{');
  assert.equal(s.readV2(storage,owner).report,null);
});

// Minimal DOM adapter exercises the shipped dialog callbacks. Browser layout and
// keyboard focus rendering are covered by the isolated-browser consumer checks.
function dialogFixture(saved=null,storageDenied=false){
  const vm=require('node:vm'),fs=require('node:fs');
  const nodes=[];let focused=null;
  const document={createElement(tag){const n={tag,children:[],dataset:{},style:{},attrs:{},textContent:'',value:'',hidden:false,open:false,
    append(child){this.children.push(child);},setAttribute(k,v){this.attrs[k]=String(v);},removeAttribute(k){delete this.attrs[k];},
    addEventListener(k,f){this['on'+k]=f;},focus(){focused=this;},showModal(){this.open=true;},close(){this.open=false;},remove(){this.removed=true;},ownerDocument:document};nodes.push(n);return n;}};
  document.body=document.createElement('body');const host=document.createElement('div');
  let owner=JSON.stringify(['hospital','reader']),state='active',changed=null,response={owner:['hospital','reader'],revision:0,bindings:null,invalid:false};
  const requests=[],data=new Map();if(saved!==null)data.set('kin-workspace-shortcuts:v1:'+owner,JSON.stringify(saved));
  const root={document,localStorage:{getItem:k=>{if(storageDenied)throw Error('denied');return data.get(k)??null;},setItem:(k,v)=>data.set(k,v)},
    KinWorkContext:{state:()=>state,capture:()=>({}),commit:(_,run)=>run(),onInvalidate(){}},
    KinSessionTransport:{page:()=>({async request(url,options){requests.push({url,options});return {ok:true,body:structuredClone(response)};}})}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../worklist-v0/hpacs-lite/workspace-shortcuts.js'),'utf8'),{window:root,AbortController,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){}});
  const instance=root.KinWorkspaceShortcuts.create({host,owner:()=>owner,allowed:()=>true,changed:map=>{changed=map;}});
  const node=id=>{const result=nodes.find(n=>n.id===id);assert.ok(result,id);return result;};
  const press=(id,event)=>node('workspace-shortcut-'+id).onkeydown({key:'s',code:'KeyS',ctrlKey:true,altKey:false,shiftKey:false,metaKey:false,preventDefault(){},stopPropagation(){},getModifierState:()=>false,...event});
  return {node,press,data,requests,instance,changed:()=>changed,focus:()=>focused,owner:()=>owner,setOwner:v=>{owner=v;},response:v=>{response=v;},flush:()=>new Promise(resolve=>setImmediate(resolve))};
}
test('dialog has keyboard-operable Worklist/Viewer tabs, preserves draft across tabs, applies v2',async()=>{
  const f=dialogFixture({...s.defaults,report:'KeyR'});
  f.node('workspace-shortcuts-edit').onclick();await f.flush();
  assert.equal(f.node('workspace-shortcuts-tab-worklist').attrs['aria-selected'],'true');
  assert.equal(f.node('workspace-shortcuts-tab-viewer-panel').hidden,true);
  assert.equal(f.node('workspace-shortcut-finalize').value,'Control+S');
  f.node('workspace-shortcuts-tab-worklist').onkeydown({key:'ArrowRight',preventDefault(){}});
  assert.equal(f.focus(),f.node('workspace-shortcuts-tab-viewer'));
  assert.equal(f.node('workspace-shortcuts-tab-viewer-panel').hidden,false);
  f.press('image',{altKey:true,code:'KeyI'});
  f.node('workspace-shortcuts-tab-worklist').onclick();
  f.node('workspace-shortcuts-apply').onclick();
  const value=JSON.parse(f.data.get('kin-workspace-shortcuts:v2:'+f.owner()));
  assert.equal(value.version,2);assert.equal(value.image,'Control+Alt+KeyI');assert.equal(value.report,'Control+Alt+KeyR');
  assert.equal(f.instance.action({ctrlKey:true,altKey:false,code:'KeyS'}),'finalize');
  assert.equal(f.node('workspace-shortcuts-dialog').open,false);
  assert.match(f.node('workspace-shortcuts-status').textContent,/다음 열기/);
  f.instance.end();
});
test('dialog requires explicit collision resolution and retains input on another-tab/owner conflict',async()=>{
  const f=dialogFixture();f.node('workspace-shortcuts-edit').onclick();await f.flush();
  f.press('list',{});f.node('workspace-shortcuts-apply').onclick();
  assert.equal(f.node('workspace-shortcuts-dialog').open,true);assert.equal(f.data.size,0);
  f.press('finalize',{ctrlKey:false,key:'Delete',code:'Delete'});
  assert.equal(f.node('workspace-shortcut-finalize').value,'Unassigned');
  f.data.set('kin-workspace-shortcuts:v1:'+f.owner(),JSON.stringify(s.defaults));
  f.node('workspace-shortcuts-apply').onclick();assert.match(f.node('workspace-shortcuts-message').textContent,/다른 창/);
  assert.equal(f.node('workspace-shortcut-list').value,'Control+S');
  f.setOwner(JSON.stringify(['other','reader']));f.node('workspace-shortcuts-apply').onclick();assert.match(f.node('workspace-shortcuts-message').textContent,/계정/);
  f.instance.end();
});
test('account load migrates v1 key-for-key and saves v2 with the observed owner/revision',async()=>{
  const f=dialogFixture();f.response({owner:['hospital','reader'],revision:8,bindings:{...s.defaults,report:'KeyR'},invalid:false});
  f.node('workspace-shortcuts-edit').onclick();await f.flush();
  f.node('workspace-shortcuts-account-load').onclick();await f.flush();
  assert.equal(f.node('workspace-shortcut-report').value,'Control+Alt+R');
  assert.equal(f.node('workspace-shortcut-finalize').value,'Control+S');
  f.node('workspace-shortcuts-account-save').onclick();await f.flush();
  const put=f.requests.find(x=>x.options.method==='PUT'),body=JSON.parse(put.options.body);
  assert.deepEqual(body.expectedOwner,['hospital','reader']);assert.equal(body.revision,8);
  assert.equal(body.bindings.version,2);assert.equal(body.bindings.report,'Control+Alt+KeyR');
  assert.equal(body.bindings.finalize,'Control+KeyS');assert.equal(s.valid(body.bindings),true);
  f.instance.end();
});

// W4SC-R1-04/05: absence is different from an observed unreadable preference.
test('unreadable shapes and unsupported versions consistently unassign all actions with one notice',()=>{
  for(const value of ['bad',[],42,false,{version:3},{...s.defaultsV2,version:'2'},{version:null}]){
    const result=s.migrate(value);
    assert.ok(Object.entries(result.map).every(([id,key])=>id==='version'||key===null));
    assert.equal(result.notices.length,1);
    assert.match(result.notices[0],/미배정.*Shortcuts/);
  }
  assert.deepEqual(s.migrate(null),{map:s.defaultsV2,notices:[]});
});
test('dialog preserves defaults without observable storage, and names only bad actions when observed',async()=>{
  const absent=dialogFixture(null,true);
  assert.equal(absent.instance.read().report,'Control+Alt+Digit4');
  assert.equal(absent.node('workspace-shortcuts-status').textContent,'');
  absent.instance.end();
  const bad=dialogFixture({...s.defaults,image:'KeyC',report:'KeyR'});
  assert.equal(bad.instance.read().image,null);
  assert.equal(bad.instance.read().report,'Control+Alt+KeyR');
  assert.match(bad.node('workspace-shortcuts-status').textContent,/Image.*미배정/);
  bad.node('workspace-shortcuts-edit').onclick();await bad.flush();
  bad.node('workspace-shortcuts-tab-viewer').onclick();
  assert.equal(bad.node('workspace-shortcut-image').value,'Unassigned');
  bad.instance.end();
});
test('duplicate notice identifies conflicting actions and tabs even when one is hidden',async()=>{
  const f=dialogFixture();f.node('workspace-shortcuts-edit').onclick();await f.flush();
  f.node('workspace-shortcuts-tab-viewer').onclick();f.press('image',{altKey:true,code:'KeyR'});
  f.node('workspace-shortcuts-tab-worklist').onclick();f.press('report',{altKey:true,code:'KeyR'});
  f.node('workspace-shortcuts-apply').onclick();
  const message=f.node('workspace-shortcuts-message').textContent;
  assert.match(message,/Image \(Viewer\)/);assert.match(message,/Report Editor \(Worklist\)/);
  assert.equal(f.node('workspace-shortcuts-dialog').open,true);assert.equal(f.data.size,0);
  f.instance.end();
});

// W4SC-A-01/02: REQ-WS7 -> RISK-WS7 -> actionable notices without preference loss.
test('account save names hidden-tab conflicts, preserves every input and sends no PUT',async()=>{
  const f=dialogFixture();f.node('workspace-shortcuts-edit').onclick();await f.flush();
  assert.equal(f.node('workspace-shortcuts-account-save').disabled,false);
  f.node('workspace-shortcuts-tab-viewer').onclick();f.press('image',{altKey:true,code:'KeyR'});
  f.node('workspace-shortcuts-tab-worklist').onclick();f.press('report',{altKey:true,code:'KeyR'});
  assert.equal(f.node('workspace-shortcuts-tab-viewer-panel').hidden,true);
  const inputs=()=>Object.keys(s.defaultsV2).filter(id=>id!=='version').map(id=>{
    const field=f.node('workspace-shortcut-'+id);return [id,field.value,field.dataset.code];
  });
  const before=inputs();
  f.node('workspace-shortcuts-account-save').onclick();await f.flush();
  const notice=f.node('workspace-shortcuts-account-status').textContent;
  assert.match(notice,/Image \(Viewer\)/);assert.match(notice,/Report Editor \(Worklist\)/);
  assert.match(notice,/중복.*서로 다른 키/);
  assert.deepEqual(inputs(),before);
  assert.equal(f.requests.filter(x=>x.options.method==='PUT').length,0);
  assert.equal(f.node('workspace-shortcuts-dialog').open,true);assert.equal(f.data.size,0);
  f.instance.end();
});
test('observed v1 null unassigns only that action with a notice; explicit v2 null is silent',()=>{
  const legacy={...s.defaults,image:'KeyI',report:null,note:'KeyN'};
  const expected={version:2,...Object.fromEntries(Object.entries(legacy).map(([id,key])=>[id,key===null?null:'Control+Alt+'+key])),finalize:'Control+KeyS'};
  const owner='reader',data=new Map([['kin-workspace-shortcuts:v1:'+owner,JSON.stringify(legacy)]]);
  const storage={getItem:key=>data.get(key)??null};
  assert.equal(s.valid(legacy),false);
  assert.deepEqual(s.readV2(storage,owner),expected);assert.deepEqual(s.read(storage,owner),legacy);
  const migrated=s.migrate(legacy);
  assert.deepEqual(migrated.map,expected);assert.equal(migrated.notices.length,1);
  assert.match(migrated.notices[0],/Report Editor.*미배정.*Shortcuts/);
  data.set('kin-workspace-shortcuts:v2:'+owner,JSON.stringify(expected));
  assert.equal(s.valid(expected),true);assert.deepEqual(s.readV2(storage,owner),expected);
  assert.deepEqual(s.migrate(expected),{map:expected,notices:[]});
});
test('dialog reading v1 null shows its notice and preserves other keys; v2 unassignment stays silent',async()=>{
  const legacy={...s.defaults,image:'KeyI',report:null,note:'KeyN'};
  for(const version of [1,2]){
    const f=dialogFixture(version===1?legacy:null);
    const expected={version:2,...Object.fromEntries(Object.entries(legacy).map(([id,key])=>[id,key===null?null:'Control+Alt+'+key])),finalize:'Control+KeyS'};
    if(version===2)f.data.set('kin-workspace-shortcuts:v2:'+f.owner(),JSON.stringify(expected));
    else assert.match(f.node('workspace-shortcuts-status').textContent,/Report Editor.*미배정/);
    const stored=[...f.data];
    f.node('workspace-shortcuts-edit').onclick();await f.flush();
    assert.deepEqual({...f.instance.read()},expected);
    for(const [id,key] of Object.entries(expected))if(id!=='version'){
      assert.equal(f.node('workspace-shortcut-'+id).dataset.code,key??'');
      assert.equal(f.node('workspace-shortcut-'+id).value,s.display(key));
    }
    const notice=f.node('workspace-shortcuts-message').textContent;
    if(version===1)assert.match(notice,/Report Editor.*미배정.*Shortcuts/);
    else assert.equal(notice,'각 항목에서 사용할 조합을 누르세요.');
    assert.deepEqual([...f.data],stored);assert.equal(f.requests.filter(x=>x.options.method==='PUT').length,0);
    assert.equal(f.node('workspace-shortcuts-dialog').open,true);
    f.instance.end();
  }
});
