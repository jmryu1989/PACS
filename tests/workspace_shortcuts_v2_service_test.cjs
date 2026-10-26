'use strict';
/* REQ-WS7 -> RISK-WS7 preference loss/owner/CAS -> TEST-W4-SC-SERVER.
 * Real facade and source loader, transactional synthetic Prisma. These tests
 * assert public results and preserved rows, not member names or implementation text.
 * Database isolation and browser/session transport remain separate live checks. */
const test=require('node:test'),assert=require('node:assert/strict');
if(!require('node:fs').existsSync('/app/dist/pacs'))require('./service_test_loader.cjs');
const {PacsService}=require('/app/dist/pacs.service');
const client=require('../worklist-v0/hpacs-lite/workspace-shortcuts.js');
const caller={kind:'member',institution:'synthetic-a',sub:'reader-a',actor:'reader@synthetic.test',roles:['radiologist']};
const owner=c=>[c.institution,c.sub],clone=v=>structuredClone(v);
const v1=()=>({list:'KeyQ',image:'Digit2',prior:'Digit3',report:'Digit4',context:'Digit5',note:'Digit6',tools:'Digit7',nativeTools:'Digit9',previous:'ArrowLeft',next:'ArrowRight'});
const v2=()=>({version:2,list:'Control+Alt+KeyQ',image:'Control+Alt+Digit2',prior:'Control+Alt+Digit3',report:'Control+Alt+Digit4',context:'Control+Alt+Digit5',note:'Control+Alt+Digit6',tools:'Control+Alt+Digit7',nativeTools:'Control+Alt+Digit9',previous:'Control+Alt+ArrowLeft',next:'Control+Alt+ArrowRight',finalize:'Control+KeyS'});
const request=(bindings=v2(),revision=0,c=caller)=>({bindings,revision,expectedOwner:owner(c)});
const status=code=>e=>e.getStatus?.()===code;

test('v1 MG preference survives a v2 shortcut save with per-modality hanging',async()=>{
  const f=fixture(), mammography={layout:'current',kind:'conventional',viewOrder:'MLO-CC',priorPosition:'left',compareColumns:2};
  const old={version:1,bar:['Zoom'],shortcuts:{Zoom:'z'},mammography};
  const save=(viewerSettings,revision)=>f.service.saveWorkspaceShortcuts({expectedOwner:owner(caller),revision,viewerSettings},caller);
  const first=await save(old,0);
  const next={...first.viewerSettings,version:2,bar:[],shortcuts:{Zoom:'shift+z'},
    hanging:{CT:{layout:'2x2',priorPosition:'left',seriesMatch:'similar'},MR:{layout:'3x3',priorPosition:'top',seriesMatch:'number'},XA:{layout:'1x2',priorPosition:'right',seriesMatch:'largest'}}};
  const saved=await save(next,first.revision);
  assert.deepEqual(saved.viewerSettings,next);
  assert.deepEqual((await f.service.workspaceShortcuts(caller)).viewerSettings.mammography,mammography);
  const before=f.snapshot();
  for(const hanging of [{CT:{layout:'bad',priorPosition:'left',seriesMatch:'similar'}},{CT:{layout:'2x2',priorPosition:'unknown',seriesMatch:'similar'}}])
    await assert.rejects(save({...next,hanging},saved.revision),status(400));
  assert.deepEqual(f.snapshot(),before);
});

test('MG layout and representation roam with viewer settings and preserve workspace shortcuts',async()=>{
  const f=fixture(), tools={version:1,bar:['Zoom'],shortcuts:{Zoom:'z'}};
  let revision=0;
  const save=value=>f.service.saveWorkspaceShortcuts({expectedOwner:owner(caller),revision,viewerSettings:value},caller);
  for(const layout of ['compare','current'])for(const kind of [null,'conventional','generated2d','dbt']){
    const value={...tools,mammography:{layout,kind}}, saved=await save(value); revision=saved.revision;
    assert.deepEqual(saved.viewerSettings,value);
    assert.deepEqual((await f.service.workspaceShortcuts(caller)).viewerSettings,value);
    const workspace=await f.service.saveWorkspaceShortcuts(request(v2(),revision),caller); revision=workspace.revision;
    assert.deepEqual(workspace.viewerSettings,value);
    assert.deepEqual(workspace.bindings,v2());
  }
  for(const c of [{...caller,sub:'other'}, {...caller,institution:'other'}])
    assert.equal((await f.service.workspaceShortcuts(c)).viewerSettings,null);
  const before=f.snapshot();
  for(const mammography of [null,[],{}, {layout:'invalid',kind:null}, {layout:'compare',kind:'invalid'},
    {layout:'current'}, {layout:'compare',kind:null,extra:true},
    {layout:'compare',kind:null,priorPosition:'right',compareColumns:1},
    {layout:'compare',kind:null,priorPosition:'top',compareColumns:8}])
    await assert.rejects(save({...tools,mammography}),status(400));
  assert.deepEqual(f.snapshot(),before);
  await assert.rejects(f.service.saveWorkspaceShortcuts({expectedOwner:owner(caller),revision:revision-1,
    viewerSettings:{...tools,mammography:{layout:'current',kind:'dbt'}}},caller),status(409));
  assert.deepEqual(f.snapshot(),before);
});
function fixture(){
  let rows=new Map(),fault=null;
  const key=o=>JSON.stringify([o.institution,o.subject]);
  const table=store=>({
    async findUnique({where}){return clone(store.get(key(where.institution_subject))??null);},
    async create({data}){if(store.has(key(data))||fault==='create')throw Object.assign(Error('unique'),{code:'P2002'});store.set(key(data),clone(data));return clone(data);},
    async updateMany({where,data}){const row=store.get(key(where));if(fault==='write')throw Error('unavailable');if(!row||row.revision!==where.revision||fault==='race')return {count:0};store.set(key(where),{...row,bindings:clone(data.bindings),revision:row.revision+data.revision.increment});return {count:1};}
  });
  const prisma={workspaceShortcuts:{findUnique:args=>table(rows).findUnique(args)},async $transaction(run){const pending=clone(rows);const result=await run({workspaceShortcuts:table(pending)});rows=pending;return result;}};
  return {service:new PacsService(prisma,{},{},{},{}),snapshot:()=>clone(rows),fault:value=>{fault=value;},seed(bindings,revision=7,c=caller){rows.set(JSON.stringify(owner(c)),{institution:c.institution,subject:c.sub,bindings:clone(bindings),revision});}};
}

test('viewer toolbar and single keys roam per account without replacing workspace keys',async()=>{
  const f=fixture(), viewerSettings={version:1,bar:['Zoom','Pan'],shortcuts:{Zoom:'j',Pan:'p',Length:null}};
  const save=(value,revision,c=caller)=>f.service.saveWorkspaceShortcuts({expectedOwner:owner(c),revision,viewerSettings:value},c);
  const first=await save(viewerSettings,0);
  assert.deepEqual(first,{owner:owner(caller),revision:1,bindings:null,invalid:false,viewerSettings});
  const workspace=await f.service.saveWorkspaceShortcuts(request(v2(),1),caller);
  assert.deepEqual(workspace.viewerSettings,viewerSettings);
  const changed={...viewerSettings,bar:['Pan'],shortcuts:{...viewerSettings.shortcuts,Zoom:'k'}};
  const saved=await save(changed,2);
  assert.deepEqual(saved.bindings,v2()); assert.deepEqual(saved.viewerSettings,changed);
  assert.deepEqual(await f.service.workspaceShortcuts(caller),saved);
  for(const c of [{...caller,sub:'other'}, {...caller,institution:'other'}])
    assert.equal((await f.service.workspaceShortcuts(c)).viewerSettings,null);
  const before=f.snapshot();
  await assert.rejects(save(viewerSettings,2),status(409));
  for(const value of [{...changed,bar:['Pan','Pan']},{...changed,shortcuts:{Zoom:'p',Pan:'p'}},{...changed,shortcuts:{Zoom:'Control+KeyJ'}}])
    await assert.rejects(save(value,3),status(400));
  assert.deepEqual(f.snapshot(),before);
});
test('v1 and v2 exact readback and client migration roundtrip through real facade',async()=>{
  for(const bindings of [v1(),v2(),{...v2(),finalize:null,image:null}]){
    const f=fixture();assert.deepEqual(await f.service.workspaceShortcuts(caller),{owner:owner(caller),revision:0,bindings:null,viewerSettings:null,invalid:false});
    const saved=await f.service.saveWorkspaceShortcuts(request(bindings),caller);
    assert.deepEqual(saved,{owner:owner(caller),revision:1,bindings,viewerSettings:null,invalid:false});
    assert.deepEqual(await f.service.workspaceShortcuts(caller),saved);
    assert.equal(client.valid(saved.bindings),true);
    const migrated=client.migrate(saved.bindings).map;
    assert.deepEqual(await f.service.saveWorkspaceShortcuts(request(migrated,1),caller),{...saved,revision:2,bindings:migrated});
  }
});
test('current revision v1 over stored v2 is 409 and preserves every key (downgrade mutant)',async()=>{
  const f=fixture();f.seed(v2());const before=f.snapshot();
  await assert.rejects(f.service.saveWorkspaceShortcuts(request(v1(),7),caller),status(409));
  assert.deepEqual(f.snapshot(),before);assert.deepEqual((await f.service.workspaceShortcuts(caller)).bindings,v2());

});
test('unknown fields, missing actions, malformed versions, reserved chords and duplicates are 400 without mutation',async()=>{
  const bad=[null,[],{},false,{...v2(),version:1},{...v2(),version:3},{...v2(),version:'2'},{...v1(),version:1},{...v2(),extra:null},{...v1(),extra:'KeyZ'}];
  for(const base of [v1(),v2()])for(const id of Object.keys(base)){const value={...base};delete value[id];bad.push(value);}
  for(const key of ['Control+Alt+KeyC','Control+Alt+Digit8','Control+KeyR','Enter','KeyS',false,0,{},undefined])bad.push({...v2(),finalize:key});
  bad.push({...v2(),list:'Control+KeyS'},{...v1(),list:null},{...v1(),list:'KeyC'},{...v1(),list:'Digit2'});
  const f=fixture();f.seed(v2());const before=f.snapshot();
  for(const value of bad){await assert.rejects(f.service.saveWorkspaceShortcuts(request(value,7),caller),status(400),JSON.stringify(value));assert.deepEqual(f.snapshot(),before);}
  for(const body of [{...request(v2(),7),extra:true},{...request(v2(),7),revision:-1},{...request(v2(),7),revision:1.5},{...request(v2(),7),revision:2147483647}])await assert.rejects(f.service.saveWorkspaceShortcuts(body,caller),status(400));
});
test('owner and revision CAS, create/update races and write failure preserve stored bindings',async()=>{
  const f=fixture();f.seed(v2());const before=f.snapshot();
  for(const req of [request(v2(),6),request(v2(),0),request(v2(),7,{...caller,sub:'other'})]){
    await assert.rejects(f.service.saveWorkspaceShortcuts(req,caller),status(409));assert.deepEqual(f.snapshot(),before);
  }
  f.fault('race');await assert.rejects(f.service.saveWorkspaceShortcuts(request(v2(),7),caller),status(409));assert.deepEqual(f.snapshot(),before);
  f.fault('write');await assert.rejects(f.service.saveWorkspaceShortcuts(request(v2(),7),caller),/unavailable/);assert.deepEqual(f.snapshot(),before);
  const empty=fixture();empty.fault('create');await assert.rejects(empty.service.saveWorkspaceShortcuts(request(),caller),status(409));assert.equal(empty.snapshot().size,0);
});
test('read isolation, role denial and corrupt stored shape do not repair or leak data',async()=>{
  const f=fixture();f.seed(v2());
  for(const c of [{...caller,institution:'other'},{...caller,sub:'other'}])assert.equal((await f.service.workspaceShortcuts(c)).bindings,null);
  const denied={...caller,roles:['clinician']};
  await assert.rejects(f.service.workspaceShortcuts(denied),status(403));
  await assert.rejects(f.service.saveWorkspaceShortcuts(request(null),denied),status(403));
  f.seed({...v2(),finalize:'Enter'});const before=f.snapshot();
  assert.deepEqual(await f.service.workspaceShortcuts(caller),{owner:owner(caller),revision:7,bindings:null,viewerSettings:null,invalid:true});assert.deepEqual(f.snapshot(),before);
});

test('invalid stored versions and shapes can be repaired only at the current revision',async()=>{
  for(const bindings of [{...v2(),version:3},{...v2(),version:'3'},{...v2(),version:2.5},{...v2(),finalize:'Enter'},{}]){
    const f=fixture();f.seed(bindings);const before=f.snapshot();
    assert.deepEqual(await f.service.workspaceShortcuts(caller),{owner:owner(caller),revision:7,bindings:null,viewerSettings:null,invalid:true});
    await assert.rejects(f.service.saveWorkspaceShortcuts(request(v2(),6),caller),status(409));
    assert.deepEqual(f.snapshot(),before);
    const repaired=await f.service.saveWorkspaceShortcuts(request(v2(),7),caller);
    assert.deepEqual(repaired,{owner:owner(caller),revision:8,bindings:v2(),viewerSettings:null,invalid:false});
    assert.deepEqual(await f.service.workspaceShortcuts(caller),repaired);
  }
});
