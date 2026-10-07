const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parse,create: productCreate} = require('../worklist-v0/hpacs-lite/related-parts.js');
const { install } = require("./module_session_harness.cjs");
const create = options => { install(options?.fetcher); return productCreate(options); };
const row=(series,body)=>({'0020000D':{Value:['1.2']},'0020000E':{Value:[series]},...(body===undefined?{}:{'00180015':{Value:body}})});
test('series identity and complete coverage distinguish missing data from unknown',()=>{
  assert.deepEqual(parse([row('1.3',['CHEST']),row('1.4',[null]),row('1.5',['ABDOMEN'])],'1.2'),['','ABDOMEN','CHEST']);
  for(const rows of [[],Array(501).fill(row('1.3')), [row('1.3'),row('1.3')], [row('1.3',[42])]])assert.throws(()=>parse(rows,'1.2'));
  assert.throws(()=>parse([row('1.3')],'9.9'));
});
test('cancel and owner change discard a delayed successful read',async()=>{
  let owner='a',pending=[];const model=create({owner:()=>owner,changed:()=>{},fetcher:()=>new Promise(resolve=>pending.push(resolve))});
  model.reset('1.2');const first=model.load(['1.2']);model.cancel();pending.shift()(new Response(JSON.stringify([row('1.3',['CHEST'])])));await first;
  assert.equal(model.get('1.2'),undefined);
  const next=model.load(['1.2']);owner='b';pending.shift()(new Response(JSON.stringify([row('1.3',['CHEST'])])));await next;
  assert.equal(model.get('1.2'),undefined);assert.equal(model.busy(),false);
});
test('plain 403 fails the batch requests without ending the document',async()=>{
  let calls=0;const model=create({owner:()=> 'a',changed:()=>{},fetcher:async()=>{calls++;return new Response('',{status:403});}});
  model.reset('1.2');await model.load(Array.from({length:9},(_,i)=>'1.'+(i+2)));
  assert.equal(calls,9);assert.equal(model.busy(),false);assert.equal(globalThis.KinWorkContext.state(),'active');
  assert.match(model.get('1.2').error,/HTTP 403/);
});

// U5S-REQ-11/22 -> U5S-RISK-APPLY -> related parts lifecycle.
test('preparation cancels the wave, Back to Editing reloads it, and end drops late results', async()=>{
  const calls=[], pending=[];
  let hold=true;
  const {gate,end}=install(url=>{
    const uid=url.split('/')[3];calls.push(uid);
    const answer=()=>new Response(JSON.stringify([{'0020000D':{Value:[uid]},'0020000E':{Value:[uid+'.1']},'00180015':{Value:['CHEST']}}]));
    return hold ? new Promise(resolve=>pending.push(()=>resolve(answer()))) : answer();
  });
  const model=productCreate({owner:()=> 'a',changed(){}}), uids=['1.2','1.3','1.4','1.5','1.6'];
  model.reset('1.2');const loading=model.load(uids);
  assert.equal(calls.length,3);assert.equal(model.busy(),true);
  const preparation=gate.prepare({});
  assert.equal(model.busy(),false);pending.splice(0).forEach(release=>release());await loading;
  assert.equal(calls.length,3);assert.equal(model.get('1.2'),undefined);
  hold=false;assert.equal(gate.cancelPreparation(preparation),true);
  for(let n=0;n<50&&model.busy();n++)await new Promise(resolve=>setImmediate(resolve));
  for(const uid of uids)assert.deepEqual(model.get(uid),{parts:['CHEST']});
  assert.equal(calls.filter(uid=>uid==='1.2').length,2);
  hold=true;const late=model.load(uids);assert.equal(model.busy(),true);
  const count=calls.length;end();
  assert.equal(model.busy(),false);for(const uid of uids)assert.equal(model.get(uid),undefined);
  pending.splice(0).forEach(release=>release());await late;await model.load(uids);
  assert.equal(calls.length,count);for(const uid of uids)assert.equal(model.get(uid),undefined);
});
