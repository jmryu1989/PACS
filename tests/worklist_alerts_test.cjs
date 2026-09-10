const test=require('node:test'),assert=require('node:assert/strict');
const {observer,defaults,normalize,initialObserver}=require('../worklist-v0/hpacs-lite/worklist-alerts.js');
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
 assert.deepEqual(normalize(defaults()),{version:2,newStudies:false,emergency:false,initialEmergency:false,volume:0.3});
 for(const bad of [{...defaults(),uids:['1.2']},{...defaults(),volume:1},{...defaults(),emergency:1},[],null])assert.equal(normalize(bad),null);
});

test('legacy settings preserve choices while initial emergency defaults off',()=>{
 assert.deepEqual(normalize({version:1,newStudies:true,emergency:true,volume:0.6}),{version:2,newStudies:true,emergency:true,initialEmergency:false,volume:0.6});
 assert.equal(normalize({...defaults(),initialEmergency:1}),null);
});
test('initial emergency queue only shrinks and is consumed once after successful sound',()=>{
 const m=initialObserver();m.observe([{uid:'1.2',em:'E'},{uid:'1.3',em:'E'}],true);assert.equal(m.count(),2);
 m.observe([{uid:'1.2',em:'N'},{uid:'1.3',em:'E'},{uid:'1.4',em:'E'}],true);assert.equal(m.count(),1);
 assert.equal(m.consume(()=>false),false);assert.equal(m.count(),1);assert.equal(m.consume(()=>true),true);
 m.observe([{uid:'1.2',em:'E'},{uid:'1.3',em:'E'}],true);assert.equal(m.consume(()=>true),false);
 const disabled=initialObserver();disabled.observe([{uid:'1.2',em:'E'}],false);disabled.observe([{uid:'1.2',em:'E'}],true);assert.equal(disabled.count(),0);
 const cancelled=initialObserver();cancelled.observe([{uid:'1.2',em:'E'}],true);cancelled.clear();cancelled.observe([{uid:'1.2',em:'E'}],true);assert.equal(cancelled.count(),0);
});
