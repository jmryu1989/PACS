const {test}=require('node:test');const assert=require('node:assert/strict');
const {create}=require('../worklist-v0/hpacs-lite/study-priority.js');
test('pending and ambiguous writes cannot toggle twice or claim success',async()=>{
  let resolve,requests=0,applied=[];
  const model=create({owner:()=> 'a',allowed:()=>true,request:()=>{requests++;return new Promise(r=>resolve=r);},apply:(...a)=>applied.push(a),changed:()=>{},invalidate:()=>{},notify:()=>{}});
  const first=model.set('1.2','E');await model.set('1.2','N');assert.equal(requests,1);assert.deepEqual(applied,[]);
  resolve({em:'N'});await first;assert.equal(model.get('1.2').phase,'unknown');await model.set('1.2','E');assert.equal(requests,1);
  model.observed(['1.2']);const retry=model.set('1.2','E');resolve({em:'E',draft:{findings:'stale'}});await retry;
  assert.deepEqual(applied,[['1.2','E']]);assert.equal(model.get('1.2'),undefined);
});
test('owner change cannot apply the old response',async()=>{
  let owner='a',resolve,applied=false;
  const model=create({owner:()=>owner,allowed:()=>true,request:()=>new Promise(r=>resolve=r),apply:()=>applied=true,changed:()=>{},invalidate:()=>{},notify:()=>{}});
  const run=model.set('1.2','E');owner='b';resolve({em:'E'});await run;assert.equal(applied,false);assert.equal(model.get('1.2'),undefined);
});
test('network failure stays unknown until a complete read and cannot clear an active write',async()=>{
  let reject,epochs=0,applied=false;
  const model=create({owner:()=> 'a',allowed:()=>true,request:()=>new Promise((_,r)=>reject=r),apply:()=>applied=true,changed:()=>{},invalidate:()=>epochs++,notify:()=>{}});
  const run=model.set('1.2','E');model.observed(['1.2']);assert.equal(model.get('1.2').phase,'saving');
  reject(new Error('timeout'));await run;assert.equal(model.get('1.2').phase,'unknown');assert.equal(epochs,2);assert.equal(applied,false);
});
test('a rendering exception cannot wedge a confirmed write',async()=>{
  let calls=0,applied=false;const original=console.error;console.error=()=>{};
  try{
    const model=create({owner:()=> 'a',allowed:()=>true,request:async()=>{calls++;return {em:'E'};},apply:()=>applied=true,changed:()=>{throw Error('synthetic render');},invalidate:()=>{},notify:()=>{}});
    await model.set('1.2','E');assert.equal(calls,1);assert.equal(applied,true);assert.equal(model.get('1.2'),undefined);
  }finally{console.error=original;}
});
