const {test}=require('node:test');
const assert=require('node:assert/strict');
const model=require('../worklist-v0/hpacs-lite/volume-rendering.js');

const owner=['hospital-a','immutable-subject'];
const bone={transferMode:'Preset',preset:'CT-Bone',knots:[],opacity:75,shading:true};
const custom={transferMode:'Custom',preset:null,knots:[{hu:-1000,color:'#000000',opacity:0},{hu:50,color:'#AABBCC',opacity:.4},{hu:2000,color:'#FFFFFF',opacity:1}],opacity:60,shading:false};

function memoryStorage(){
  const values=new Map();
  return {values,getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,value)};
}

test('strict display and owner normalization retain only reusable display fields as detached values',()=>{
  const source=structuredClone(custom),clean=model.normalizeDisplay(source);
  assert.deepEqual(clean,custom);assert.notEqual(clean,source);assert.notEqual(clean.knots,source.knots);
  source.knots[0].hu=99;assert.equal(clean.knots[0].hu,-1000);
  assert.throws(()=>model.normalizeDisplay({...bone,camera:{position:[1,2,3]}}),/형식/);
  assert.throws(()=>model.normalizeDisplay({...bone,knots:[{hu:0,color:'#000000',opacity:0},{hu:1,color:'#FFFFFF',opacity:1}]}),/형식/);
  assert.throws(()=>model.normalizeDisplay({...custom,preset:'CT-Bone'}),/형식/);
  assert.throws(()=>model.normalizeDisplay({...custom,knots:custom.knots.map((k,i)=>i?{...k}:{...k,hu:String(k.hu)})}),/형식/);
  assert.throws(()=>model.normalizeDisplay({...custom,knots:custom.knots.map((k,i)=>i?{...k}:{...k,source:'editor'})}),/형식/);
  assert.throws(()=>model.normalizeDisplay({...custom,opacity:101}),/형식/);
  assert.throws(()=>model.normalizeDisplay({...custom,shading:1}),/형식/);
  assert.notEqual(model.presetStoreKey(owner),model.presetStoreKey(['hospital-b','immutable-subject']));
  assert.notEqual(model.presetStoreKey(owner),model.presetStoreKey(['hospital-a','other-subject']));
  assert.equal(model.normalizePresetName('😀'.repeat(64)),'😀'.repeat(64));assert.throws(()=>model.normalizePresetName('😀'.repeat(65)),/1~64/);
  for(const invalid of [null,['only-one'],['hospital-a',''],['hospital-a','subject','extra'],['hospital-a','bad\nsubject']])assert.throws(()=>model.presetStoreKey(invalid),/기관과 계정/);
});

test('library add, replace and delete are explicit, detached and reject normalized duplicate names',()=>{
  const empty=model.emptyPresetLibrary(owner),added=model.changePresetLibrary(empty,{type:'add',name:'  My\u3000Preset  ',display:bone});
  assert.equal(added.presets[0].name,'My Preset');assert.deepEqual(empty.presets,[]);
  assert.throws(()=>model.changePresetLibrary(added,{type:'add',name:'ｍｙ preset',display:custom}),/같은 이름/);
  const replaced=model.changePresetLibrary(added,{type:'replace',name:'my preset',display:custom});
  assert.equal(replaced.presets[0].name,'My Preset');assert.deepEqual(replaced.presets[0].display,custom);assert.deepEqual(added.presets[0].display,bone);
  const deleted=model.changePresetLibrary(replaced,{type:'delete',name:'MY PRESET'});assert.deepEqual(deleted.presets,[]);assert.equal(replaced.presets.length,1);
  assert.throws(()=>model.changePresetLibrary(empty,{type:'replace',name:'missing',display:bone}),/선택/);
  assert.throws(()=>model.changePresetLibrary(empty,{type:'delete',name:'missing'}),/선택/);
});

test('library enforces version, exact schema, normalized stored names and the twenty item limit',()=>{
  let library=model.emptyPresetLibrary(owner);
  for(let i=0;i<20;i++)library=model.changePresetLibrary(library,{type:'add',name:'Preset '+i,display:bone});
  assert.equal(library.presets.length,20);
  assert.throws(()=>model.changePresetLibrary(library,{type:'add',name:'Preset 20',display:bone}),/최대 20/);
  for(const invalid of [
    {...library,version:2},
    {...library,extra:true},
    {...library,owner:['hospital-a','other']},
    {version:1,owner,presets:[{name:' padded ',display:bone}]},
    {version:1,owner,presets:[{name:'A',display:bone},{name:'ａ',display:bone}]},
    {version:1,owner,presets:[{name:'A',display:{...bone,crop:{i:[0,1]}}}]}
  ])assert.throws(()=>model.normalizePresetLibrary(invalid,owner));
});

test('storage snapshots support writes and reject corrupt data or exact-raw lost updates',()=>{
  const storage=memoryStorage(),initial=model.readPresetLibrary(storage,owner),added=model.writePresetLibrary(storage,initial,{type:'add',name:'Bone',display:bone});
  assert.equal(added.library.presets.length,1);assert.equal(JSON.parse(storage.values.get(added.key)).owner[1],owner[1]);
  assert.throws(()=>model.writePresetLibrary({...storage,getItem:()=>null},{...initial,key:model.presetStoreKey(['hospital-b','immutable-subject'])},{type:'add',name:'Wrong owner',display:bone}),/계정/);
  storage.values.set(added.key,JSON.stringify({...added.library,presets:[...added.library.presets,{name:'Other',display:custom}]}));
  assert.throws(()=>model.writePresetLibrary(storage,added,{type:'replace',name:'Bone',display:custom}),/다른 창/);
  storage.values.set(added.key,'{bad json');assert.throws(()=>model.readPresetLibrary(storage,owner),/손상.*덮어쓰지/);assert.equal(storage.values.get(added.key),'{bad json');
  storage.values.set(added.key,' '.repeat(131073));assert.throws(()=>model.readPresetLibrary(storage,owner),/크기.*덮어쓰지/);assert.equal(storage.values.get(added.key).length,131073);
});

test('storage size limit counts UTF-8 bytes before parsing and preserves oversized raw data',()=>{
  const storage=memoryStorage(),key=model.presetStoreKey(owner),raw='가'.repeat(50000);storage.values.set(key,raw);
  assert.ok(raw.length<131072);assert.ok(new TextEncoder().encode(raw).byteLength>131072);
  assert.throws(()=>model.readPresetLibrary(storage,owner),/크기.*덮어쓰지/);assert.equal(storage.values.get(key),raw);
});

test('storage read and write failures preserve the last snapshot, input and stored raw value',()=>{
  const backing=memoryStorage(),snapshot=model.readPresetLibrary(backing,owner),command={type:'add',name:' Pending Name ',display:structuredClone(custom)},before=structuredClone(command);
  const readFailure={getItem(){throw Error('denied')},setItem(){throw Error('unexpected')}};
  assert.throws(()=>model.readPresetLibrary(readFailure,owner),/읽지 못했습니다/);
  const rawBefore=backing.getItem(snapshot.key),writeFailure={getItem:key=>backing.getItem(key),setItem(){throw Error('quota')}};
  assert.throws(()=>model.writePresetLibrary(writeFailure,snapshot,command),/저장하지 못했습니다.*입력 내용은 유지/);
  assert.equal(backing.getItem(snapshot.key),rawBefore);assert.deepEqual(snapshot.library.presets,[]);assert.deepEqual(command,before);
});
