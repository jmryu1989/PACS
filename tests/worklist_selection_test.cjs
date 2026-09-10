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
