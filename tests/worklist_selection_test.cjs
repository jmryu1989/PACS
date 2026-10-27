const test=require('node:test'),assert=require('node:assert/strict');
const {create,comparison}=require('../worklist-v0/hpacs-lite/worklist-selection');
const rows=['a','b','c','d'].map(uid=>({uid,sourcePatientKey:'same'}));
test('range and page selection retain displayed order and remove filtered or revoked studies',()=>{
  const m=create();m.toggle('b',rows);m.toggle('d',rows,true);assert.deepEqual(m.rows(rows).map(s=>s.uid),['b','c','d']);
  m.page(['a','unknown'],rows);assert.deepEqual(m.rows(rows).map(s=>s.uid),['a','b','c','d']);
  assert.deepEqual(m.rows([rows[3],rows[1]]).map(s=>s.uid),['d','b']);
  assert.deepEqual(m.rows(rows).map(s=>s.uid),['b','d']);m.clear();assert.deepEqual(m.rows(rows),[]);
});
test('comparison requires exactly two confirmed original patient identities',()=>{
  assert.deepEqual(comparison(rows.slice(0,2)),['a','b']);
  assert.deepEqual(comparison(rows.slice(0,2),'b'),['b','a']);
  for(const invalid of [[],rows,[rows[0]], [rows[0],{...rows[1],sourcePatientKey:''}], [rows[0],{...rows[1],sourcePatientKey:'other'}]])assert.equal(comparison(invalid),null);
});
test('W9: the selection generation counts real changes of the selected set, including a filtered-out member',()=>{
  const m=create(),g=()=>m.generation();const start=g();
  m.toggle('a',rows);assert.equal(g(),start+1);
  m.toggle('zz',rows);assert.equal(g(),start+1,'an unknown row changes nothing');
  m.page(['a'],rows);assert.equal(g(),start+1,'re-adding a selected row changes nothing');
  m.toggle('b',rows);m.toggle('b',rows);m.toggle('b',rows);assert.equal(g(),start+4,'A -> B -> A is three changes');
  m.rows([rows[1],rows[2]]);assert.equal(g(),start+5,'a selected row leaving the list is a change');
  m.clear();assert.equal(g(),start+6);m.clear();assert.equal(g(),start+6);
});
