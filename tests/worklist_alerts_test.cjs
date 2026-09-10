const test=require('node:test'),assert=require('node:assert/strict');
const {observer,defaults,normalize}=require('../worklist-v0/hpacs-lite/worklist-alerts.js');
test('first list is silent, repeated results are silent, independent changes aggregate',()=>{
 const m=observer();assert.deepEqual(m.observe([{uid:'1.2',em:'E'}]),{baseline:true,newStudies:0,emergency:0});
 assert.deepEqual(m.observe([{uid:'1.2',em:'E'}]),{baseline:false,newStudies:0,emergency:0});
 assert.deepEqual(m.observe([{uid:'1.2',em:'N'},{uid:'1.3',em:'N'},{uid:'1.4',em:'E'}]),{baseline:false,newStudies:2,emergency:1});
 assert.deepEqual(m.observe([{uid:'1.2',em:'E'},{uid:'1.3',em:'N'},{uid:'1.4',em:'E'}]),{baseline:false,newStudies:0,emergency:1});
});
test('invalid lists cannot replace baseline; reset and newly visible rows are explicit',()=>{
 const m=observer();m.observe([{uid:'1.2',em:'N'}]);
 for(const rows of [null,[{uid:'1.2',em:'urgent'}],[{uid:'1.2'},{uid:'1.2'}],Array(20001).fill({uid:'1.3'})])assert.throws(()=>m.observe(rows));
 assert.deepEqual(m.observe([{uid:'1.2',em:'E'}]),{baseline:false,newStudies:0,emergency:1});
 m.observe([]);assert.equal(m.observe([{uid:'1.2',em:'E'}]).newStudies,1);
 m.reset();assert.equal(m.observe([{uid:'1.2',em:'E'}]).baseline,true);
});
test('only bounded user settings persist, never a UID baseline',()=>{
 assert.deepEqual(normalize(defaults()),{version:1,newStudies:false,emergency:false,volume:0.3});
 for(const bad of [{...defaults(),uids:['1.2']},{...defaults(),volume:1},{...defaults(),emergency:1},[],null])assert.equal(normalize(bad),null);
});
