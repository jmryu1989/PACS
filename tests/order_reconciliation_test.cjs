// TEST-S4-U2-ORDER-RECONCILIATION client: the shipped module against the shared vectors.
// Runs without a browser; the DOM wiring is tests/order_reconciliation_dom_test.py.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');const {join}=require('node:path');
const ROOT=join(__dirname,'..');
const orders=require('../worklist-v0/hpacs-lite/order-reconciliation.js');
const V=JSON.parse(readFileSync(join(ROOT,'tests/order_reconciliation_vectors.json'),'utf8'));
const O=JSON.parse(readFileSync(join(ROOT,'tests/study_observation_vectors.json'),'utf8'));
const byName=Object.fromEntries(V.read.map(c=>[c.name,c.value]));
const same=x=>x;
function resolve(result){
  const copy=structuredClone(result),o=copy.observation;
  if(o&&typeof o.orderReconciliation==='string'&&o.orderReconciliation.startsWith('@'))o.orderReconciliation=structuredClone(byName[o.orderReconciliation.slice(1)]);
  return copy;
}

test('S4-U2 read accepts only the closed engineering-only shape; null stays unknown, never []',()=>{
  for(const c of V.read){
    const got=orders.read(structuredClone(c.value));
    const state=got.error?'error':got.orders===null?'unknown':'ok';
    assert.equal(state,c.expect,c.name);
  }
  assert.deepEqual(orders.read(undefined),{orders:null});
  assert.deepEqual(orders.read(byName.full).orders,byName.full.orders);
});

test('S4-U2 row labels: one IF-W09 phrase for no-image rows, the pair is only a suggestion',()=>{
  for(const c of V.labels){const got=orders.rowLabel(c.row);assert.deepEqual([got.key,got.text],[c.key,c.text],c.row.oid);assert.ok(got.title.length>0);}
  assert.equal(orders.PHRASES.orderWithoutImages,O.phrases.orderWithoutImages);
  assert.equal(orders.PHRASES.observationUnavailable,O.phrases.observationUnavailable);
  assert.equal(orders.SOURCE,V.source);assert.equal(orders.MARKER,V.marker);
});

test('S4-U2 transitions: failure keeps the last answer, cold failure invents nothing, recovery replaces',()=>{
  for(const c of V.transitions){
    let model=orders.start();
    for(const step of c.steps)model=step.op==='succeeded'?orders.succeeded(model,resolve(step.result)):orders.failed(model);
    const s=orders.summary(model,same);
    assert.deepEqual([s.key,s.hidden,s.text,s.rows.map(r=>r.text)],[c.key,c.hidden,c.text,c.rows],c.name);
    if(!s.hidden)assert.ok(s.text.startsWith('Order Reconciliation · '+V.marker),c.name);
    for(const line of [s.text,...s.rows.map(r=>r.text)])assert.doesNotMatch(line,/완료|수신 완료|안정|received|complete|stable|Scheduled|예정/i,c.name);
    if(s.key==='observation_unavailable')assert.ok(!s.text.includes(V.phrases.orderWithoutImages),c.name);
  }
});

test('S4-U2 the model never reaches for the offline seed, storage or the network',()=>{
  const source=readFileSync(join(ROOT,'worklist-v0/hpacs-lite/order-reconciliation.js'),'utf8');
  for(const banned of ['localStorage','sessionStorage','fetch(','XMLHttpRequest','document.','SEED_ORDERS','kin-orders'])assert.ok(!source.includes(banned),banned);
  // A global `orders` (the Order List array, possibly the localStorage seed) is not an input.
  globalThis.orders=[{oid:'O-9001',name:'KIM CHULSOO',sched:'2026-09-24 09:10',matched:'U',studyUid:null}];
  try{
    const s=orders.summary(orders.succeeded(orders.start(),{owner:['hallym','sub'],observation:{observedAt:'2026-09-24T01:00:00.000Z'}}),same);
    assert.equal(s.key,'unknown');assert.deepEqual(s.rows,[]);
    const full=orders.summary(orders.succeeded(orders.start(),resolve({owner:['hallym','sub'],observation:{observedAt:'2026-09-24T01:00:00.000Z',orderReconciliation:'@full'}})),same);
    assert.ok(!JSON.stringify(full).includes('KIM CHULSOO')&&!JSON.stringify(full).includes('09:10'));
  }finally{delete globalThis.orders;}
});
