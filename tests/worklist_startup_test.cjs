const assert=require('node:assert/strict');
const {test}=require('node:test');
const model=require('../worklist-v0/hpacs-lite/worklist-startup.js');

test('TEST-WORKLIST-STARTUP: first completed list only, current target and interaction win',()=>{
  for(const condition of ['enabled','disabled','touched','selected','unavailable','empty']){
    let selected=condition==='selected'?'existing':null,list=condition==='empty'?[]:[{uid:'first'},{uid:'second'}],calls=[];
    const initial=model.once({enabled:condition!=='disabled',current:()=>selected,rows:()=>list,
      allowed:()=>condition!=='unavailable',select:uid=>{calls.push(uid);selected=uid;}});
    if(condition==='touched')initial.touch();initial.afterList();
    assert.deepEqual(calls,condition==='enabled'?['first']:[],condition);
    selected=null;list=[{uid:'later'}];initial.afterList();
    assert.deepEqual(calls,condition==='enabled'?['first']:[],condition+' later refresh');
  }
});

test('TEST-WORKLIST-STARTUP: strict preference, no patient data or truthy coercion',()=>{
  assert.deepEqual(model.normalize({version:1,selectFirst:true}),{version:1,selectFirst:true});
  for(const value of [null,[],{}, {version:1,selectFirst:1},{version:2,selectFirst:true},{version:1,selectFirst:true,uid:'wrong'}])assert.equal(model.normalize(value),null);
});
