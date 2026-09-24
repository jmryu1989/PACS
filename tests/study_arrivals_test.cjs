const {test}=require('node:test');
const assert=require('node:assert/strict');
const arrivals=require('../worklist-v0/hpacs-lite/study-arrivals.js');

const row=(uid,count,series,extra={})=>({uid,count,series,...extra});

test('reports instance, series, and combined growth for existing studies',()=>{
  const previous=[row('1.2',5,2),row('1.3',8,3),row('1.4',13,5)];
  const next=[row('1.2',7,2),row('1.3',8,4),row('1.4',15,6)];
  assert.deepEqual(arrivals.diff(previous,next),{ok:true,changes:[
    {uid:'1.2',previousCount:5,count:7,previousSeries:2,series:2,addedInstances:2,addedSeries:0},
    {uid:'1.3',previousCount:8,count:8,previousSeries:3,series:4,addedInstances:0,addedSeries:1},
    {uid:'1.4',previousCount:13,count:15,previousSeries:5,series:6,addedInstances:2,addedSeries:1},
  ]});
});

test('matches by UID across ABA ordering and ignores new, missing, equal, or decreased studies',()=>{
  const result=arrivals.diff(
    [row('1.10',10,3),row('1.20',20,4),row('1.30',30,5)],
    [row('1.30',29,5),row('1.99',99,9),row('1.10',10,3),row('1.20',21,4)]
  );
  assert.deepEqual(result,{ok:true,changes:[{uid:'1.20',previousCount:20,count:21,previousSeries:4,series:4,addedInstances:1,addedSeries:0}]});
});

test('rejects duplicate UIDs without emitting inferred arrivals',()=>{
  assert.deepEqual(arrivals.diff([row('1.2',1,1),row('1.2',2,1)],[row('1.2',3,1)]),
    {ok:false,changes:[],error:'previous:duplicate-uid:1'});
  assert.deepEqual(arrivals.diff([row('1.2',1,1)],[row('1.2',2,1),row('1.2',3,1)]),
    {ok:false,changes:[],error:'next:duplicate-uid:1'});
});

test('rejects malformed UIDs and non-integer, unsafe, or coerced counters',()=>{
  for(const [rows,reason] of [
    [[row('not-a-uid',1,1)],'invalid-uid'],
    [[row('1.2',undefined,1)],'invalid-count'],
    [[row('1.2','12',1)],'invalid-count'],
    [[row('1.2',1,'0')],'invalid-count'],
    [[row('1.2',3.5,1)],'invalid-count'],
    [[row('1.2',1,NaN)],'invalid-count'],
    [[row('1.2',Infinity,1)],'invalid-count'],
    [[row('1.2',Number.MAX_SAFE_INTEGER+1,1)],'invalid-count'],
    [[row('1.2',1,-1)],'invalid-count'],
  ]){
    const result=arrivals.diff([],rows);assert.equal(result.ok,false);assert.deepEqual(result.changes,[]);assert.equal(result.error,`next:${reason}:0`);
  }
});

// S4-U1a: null is the server's unknown (QIDO tag absent or non-integer). It is a valid snapshot
// value, distinct from a real 0, and growth is only ever measured between two known values.
test('unknown (null) counters are accepted and unknown->known is not an arrival',()=>{
  assert.deepEqual(arrivals.diff([row('1.2',null,null)],[row('1.2',12,3)]),{ok:true,changes:[]});
  assert.deepEqual(arrivals.diff([row('1.2',null,2)],[row('1.2',12,2)]),{ok:true,changes:[]});
  assert.deepEqual(arrivals.diff([row('1.2',5,null)],[row('1.2',5,3)]),{ok:true,changes:[]});
});

test('known->unknown and unknown->unknown never notify and never fail the snapshot',()=>{
  assert.deepEqual(arrivals.diff([row('1.2',5,2)],[row('1.2',null,2)]),{ok:true,changes:[]});
  assert.deepEqual(arrivals.diff([row('1.2',5,2)],[row('1.2',null,null)]),{ok:true,changes:[]});
  assert.deepEqual(arrivals.diff([row('1.2',null,null)],[row('1.2',null,null)]),{ok:true,changes:[]});
});

test('a real zero is known: 0->n is an arrival while null->n is not',()=>{
  assert.deepEqual(arrivals.diff([row('1.2',0,0),row('1.3',null,null)],[row('1.2',3,1),row('1.3',3,1)]),{ok:true,changes:[
    {uid:'1.2',previousCount:0,count:3,previousSeries:0,series:1,addedInstances:3,addedSeries:1},
  ]});
});

test('a known axis still reports growth beside an unknown axis, with the unknown value kept as null',()=>{
  assert.deepEqual(arrivals.diff([row('1.2',5,null)],[row('1.2',7,3)]),{ok:true,changes:[
    {uid:'1.2',previousCount:5,count:7,previousSeries:null,series:3,addedInstances:2,addedSeries:0},
  ]});
  assert.deepEqual(arrivals.diff([row('1.2',null,2)],[row('1.2',null,4)]),{ok:true,changes:[
    {uid:'1.2',previousCount:null,count:null,previousSeries:2,series:4,addedInstances:0,addedSeries:2},
  ]});
});

test('known->known growth is still reported next to unknown rows in the same poll',()=>{
  assert.deepEqual(arrivals.diff(
    [row('1.10',null,null),row('1.20',20,4),row('1.30',30,5)],
    [row('1.30',30,null),row('1.10',99,9),row('1.20',21,4)]
  ),{ok:true,changes:[{uid:'1.20',previousCount:20,count:21,previousSeries:4,series:4,addedInstances:1,addedSeries:0}]});
});

test('accepts full API rows and never mutates either snapshot',()=>{
  const previous=[row('1.2',1,1,{name:'literal patient',state:{ss:'Verified'}})];
  const next=[row('1.2',2,1,{name:'changed literal',state:{ss:'Unverified'}})];
  const beforePrevious=structuredClone(previous),beforeNext=structuredClone(next);
  assert.equal(arrivals.diff(previous,next).changes[0].addedInstances,1);
  assert.deepEqual(previous,beforePrevious);assert.deepEqual(next,beforeNext);
});
