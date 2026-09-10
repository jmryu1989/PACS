const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parse,create}=require('../worklist-v0/hpacs-lite/related-parts.js');
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
test('authorization failure stops the first bounded wave and removes earlier results',async()=>{
  let calls=0;const model=create({owner:()=> 'a',changed:()=>{},fetcher:async()=>{calls++;return new Response('',{status:403});}});
  model.reset('1.2');await model.load(Array.from({length:9},(_,i)=>'1.'+(i+2)));
  assert.equal(calls,3);assert.equal(model.busy(),false);assert.match(model.note(),/접근 권한/);
  assert.equal(model.get('1.2'),undefined);
});
