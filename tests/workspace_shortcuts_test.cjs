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
