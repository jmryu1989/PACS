const {test}=require('node:test');
const assert=require('node:assert/strict');
const model=require('../worklist-v0/hpacs-lite/worklist-columns.js');
const columns={Radiology:[{k:'id'},{k:'name'},{k:'date'},{k:'desc'}],Technician:[{k:'id'},{k:'name'},{k:'ward'}]};
test('defaults and mode-specific ordering do not mutate the column schema',()=>{
  const state=model.defaults(columns); state.modes.Radiology.order.reverse();state.modes.Radiology.hidden=['desc'];
  const clean=model.normalize(state,columns);
  assert.deepEqual(model.visible(columns,clean,'Radiology').map(c=>c.k),['date','name','id']);
  assert.deepEqual(model.visible(columns,clean,'Technician').map(c=>c.k),['id','name','ward']);
  assert.deepEqual(columns.Radiology.map(c=>c.k),['id','name','date','desc']);
});
test('invalid, duplicate, unknown and required hidden fields reject as a whole',()=>{
  for(const invalid of [null,[],{}, {version:99,modes:{}}]) assert.equal(model.normalize(invalid,columns),null);
  for(const [key,list] of [['order',['id','id']],['hidden',['name']],['hidden',['id']],['hidden',['constructor']],['order',[1]],['hidden',Array(65).fill('desc')]]){
    const state=model.defaults(columns);state.modes.Radiology[key]=list;assert.equal(model.normalize(state,columns),null);
  }
  const extra=model.defaults(columns);extra.modes.Radiology.patientId='secret';assert.equal(model.normalize(extra,columns),null);
});
test('new columns append visible without disturbing earlier order',()=>{
  const state=model.defaults(columns);state.modes.Radiology.order=['name','id'];state.modes.Radiology.hidden=['desc'];
  assert.deepEqual(model.normalize(state,columns).modes.Radiology,{order:['name','id','date','desc'],hidden:['desc']});
});
test('immutable subject and institution partition browser storage; no demo or anonymous key',()=>{
  const session={state:'approved',institution:'A',sub:'subject',user:'old-name'};
  assert.equal(model.key(session),model.key({...session,user:'new-name'}));
  assert.notEqual(model.key(session),model.key({...session,institution:'B'}));
  assert.notEqual(model.key(session),model.key({...session,sub:'other'}));
  for(const invalid of [null,{}, {...session,demo:true},{...session,state:'pending'},{...session,sub:''}])assert.equal(model.key(invalid),null);
});
test('appearance validates bounded display values without losing legacy modes',()=>{
  const state=model.defaults(columns);
  state.modes.Radiology.appearance={widths:{name:240},size:18,font:'mono',color:'warm'};
  assert.deepEqual(model.normalize(state,columns),state);
  for(const patch of [{size:11},{size:21},{size:13.5},{color:'#000000'},{color:['warm']},{font:'url(https://invalid)'},{widths:{name:63}},{widths:{name:601}},{widths:{name:null}},{widths:{name:'240'}},{widths:{patientId:240}}]){
    const bad=JSON.parse(JSON.stringify(state));Object.assign(bad.modes.Radiology.appearance,patch);
    assert.equal(model.normalize(bad,columns),null);
  }
});
