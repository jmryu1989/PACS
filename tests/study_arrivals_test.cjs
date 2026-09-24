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

// S4-U1b: the shipped observation and label rules against tests/study_observation_vectors.json, which
// tests/study_observation_test.py also judges with an independent Python model.
const V=require('./study_observation_vectors.json');
const same=iso=>iso;
const apiRow=([uid,count,series])=>({uid,count,series,state:{}});
function run(steps){
  let model=arrivals.observationStart();
  for(let index=0;index<steps.length;index++){
    const step=steps[index];
    if(step.fail){model=arrivals.observationFailed(model);continue;}
    const o=step.ok,result=arrivals.observationSucceeded(model,{owner:o.owner,studies:o.studies.map(apiRow),
      observation:{observedAt:o.observedAt,notObserved:o.notObserved===null?null:o.notObserved.map(([uid,origin,createdAt])=>({uid,origin,createdAt}))}});
    if(!result.ok)return {invalidAt:index,error:result.error,model};
    model=result.model;
  }
  return {model};
}

test('S4-U1b sequences: session-local change, resets, departure, failure keeps, cold start invents nothing',()=>{
  for(const sequence of V.sequences){
    const outcome=run(sequence.steps);
    if('invalidAt' in sequence){assert.equal(outcome.invalidAt,sequence.invalidAt,sequence.id);assert.ok(outcome.error,sequence.id);continue;}
    assert.equal(outcome.invalidAt,undefined,sequence.id);
    for(const [uid,expected] of Object.entries(sequence.expect)){
      const actual=arrivals.studyObservation(outcome.model,uid);
      for(const [key,value] of Object.entries(expected))assert.deepEqual(actual[key],value,`${sequence.id} ${uid}.${key}`);
    }
    if(sequence.model){
      assert.equal(outcome.model.observedAt,sequence.model.observedAt,sequence.id);
      assert.deepEqual(outcome.model.notObserved===null?null:outcome.model.notObserved.map(row=>row.uid),sequence.model.notObservedUids,sequence.id);
    }
    const summary=arrivals.observationSummary(outcome.model,same);
    for(const [key,value] of Object.entries(sequence.summary))assert.deepEqual(summary[key],value,`${sequence.id} summary.${key}`);
  }
});

test('S4-U1b label table: every assignment x observation x receipt combination, no completion vocabulary',()=>{
  const banned=new RegExp(V.banned.join('|'),'i');
  assert.equal(String(arrivals.BANNED),String(banned));
  assert.deepEqual([...arrivals.PHASES],V.phases);
  let rows=0;
  for(const [assignment,assignmentText] of Object.entries(V.assignmentText))
    for(const [name,observation] of Object.entries(V.observations))
      for(const [receiptName,receipt] of Object.entries(V.receipts)){
        const labels=arrivals.receiptLabels({assignment,observation,gateway:receipt},same);rows++;
        assert.equal(labels.assignment.text,assignmentText);
        assert.equal(labels.observation.text,V.observationText[name],name);
        assert.equal(labels.change?.text??null,V.changeText[name]??null,name);
        assert.equal(labels.gateway.text,V.gatewayText[receiptName],receiptName);
        for(const part of [labels.assignment,labels.observation,labels.change,labels.gateway].filter(Boolean))
          assert.doesNotMatch(part.text+' '+(part.title||''),banned,`${assignment}/${name}/${receiptName}`);
        // Axis C never changes axis B, and axis A never changes either.
        assert.deepEqual(labels.observation,arrivals.receiptLabels({assignment:'assigned',observation,gateway:null},same).observation);
        // Every phase of one M-of-N report reads the same; `complete` is not promoted.
        if(receipt&&V.phases.includes(receipt.phase))for(const phase of V.phases)
          assert.deepEqual(arrivals.receiptLabels({assignment,observation,gateway:{...receipt,phase}},same).gateway,labels.gateway);
      }
  assert.equal(rows,2*13*9);
  assert.throws(()=>arrivals.receiptLabels({assignment:'Unassigned',observation:V.observations.observed_12,gateway:null},same));
});

// S4-U4: the Now Retry action over every V.receipts entry x phase. Retry/failed inputs are derived by phase
// substitution, so V.receipts keeps its nine entries and the 2*13*9 table above does not move.
test('S4-U4 Now Retry: only a readable retry receipt offers it, failed is the F-01 sentence, the Gateway label never moves',()=>{
  const banned=new RegExp(V.banned.join('|'),'i'),EPOCH='0a1b2c3d-0000-4000-8000-00000000000a';
  const bindable=['sending_3_of_12','complete_12_of_12','complete_13_of_13','sending_0_of_0','old_complete_12_of_12'];
  assert.equal(Object.keys(V.receipts).length,9);
  let offered=0,refused=0;
  for(const [name,receipt] of Object.entries(V.receipts))
    for(const phase of V.phases){
      const errorCode=phase==='retry'?'stow_http':phase==='failed'?'instance_exceeds_budget':null;
      const derived=receipt===null?null:{...receipt,phase,errorCode,epoch:EPOCH};
      const action=arrivals.gatewayRetryAction(derived),id=name+'/'+phase;
      const labels=arrivals.receiptLabels({assignment:'assigned',observation:V.observations.observed_12,gateway:derived},same);
      assert.deepEqual(labels.retry,action,id);
      // The Gateway label reads the same whatever the phase; Now Retry is a separate output.
      if(derived)assert.deepEqual(labels.gateway,arrivals.receiptLabels({assignment:'assigned',observation:V.observations.observed_12,
        gateway:{...derived,phase:'sending',errorCode:null}},same).gateway,id);
      if(phase==='retry'&&bindable.includes(name)){
        assert.deepEqual(action,{kind:'now_retry',key:EPOCH+'|'+receipt.agentSeq,text:'Now Retry',title:arrivals.RETRY_TEXT.buttonTitle},id);
        // The V epoch (1) cannot bind a request: no key, no control.
        assert.equal(arrivals.gatewayRetryAction({...receipt,phase,errorCode}),null,id);
        assert.equal(arrivals.gatewayRetryAction({...derived,agentSeq:-1}),null,id);
        assert.equal(arrivals.gatewayRetryAction({...derived,epoch:EPOCH.toUpperCase()}),null,id);
        offered++;
      }else if(phase==='failed'&&(bindable.includes(name)||name==='unreadable_phase')){
        assert.deepEqual(action,{kind:'unsupported_f01',text:'같은 바이트로는 성공할 수 없습니다 — 지원 범위 밖(F-01)',
          title:arrivals.RETRY_TEXT.unsupportedTitle},id);
        refused++;
      }else assert.equal(action,null,id);   // other phases, no receipt, unreadable, or retry without agentSeq
      if(action)assert.doesNotMatch(action.text+' '+action.title,banned,id);
    }
  assert.deepEqual([offered,refused],[5,6]);
  for(const text of Object.values(arrivals.RETRY_TEXT))assert.doesNotMatch(text,banned,text);
});

test('S4-U4 Now Retry answer: fixed text only, requested means stored, the server wording never shows',()=>{
  const at='2026-09-24T01:04:00.000Z',T=arrivals.RETRY_TEXT,requested={requested:true,text:'Retry Requested ('+at+')',title:T.requestedTitle};
  assert.deepEqual(arrivals.gatewayRetryAnswer('1.2.3',{studyUid:'1.2.3',result:'requested',requestedAt:at},null,same),requested);
  assert.deepEqual(arrivals.gatewayRetryAnswer('1.2.3',{studyUid:'1.2.3',result:'already_requested',requestedAt:at},null,same),requested);
  const fail=text=>({requested:false,text,title:''});
  for(const [answer,error,expected] of [
    [{studyUid:'1.2.4',result:'requested',requestedAt:at},null,fail(T.failed)],
    [{studyUid:'1.2.3',result:'retried',requestedAt:at},null,fail(T.failed)],
    [{studyUid:'1.2.3',result:'requested',requestedAt:'soon'},null,fail(T.failed)],
    [null,null,fail(T.failed)],
    [null,{status:404,message:'검사를 찾을 수 없습니다 SERVER'},fail(T.notFound)],
    [null,{status:409,code:'GATEWAY_RETRY_UNSUPPORTED_F01',message:'SERVER'},fail(T.unsupported)],
    [null,{status:409,code:'GATEWAY_RETRY_NOT_RETRY',message:'SERVER'},fail(T.notRetry)],
    [null,{status:409,code:'SOMETHING_ELSE'},fail(T.failed)],
    [null,{status:503,code:'GATEWAY_RETRY_BUSY'},fail(T.busy)],
    [null,{status:401,message:'세션이 만료되었습니다'},fail(T.failed)],
    [{studyUid:'1.2.3',result:'requested',requestedAt:at},{status:500},fail(T.failed)],
    [null,new Error('network SERVER'),fail(T.failed)],
  ]){
    const shown=arrivals.gatewayRetryAnswer('1.2.3',answer,error,same);
    assert.deepEqual(shown,expected,JSON.stringify([answer,error&&error.status]));
    assert.ok(!shown.text.includes('SERVER'));
  }
  for(const text of [requested.text,requested.title,...Object.values(T)])assert.doesNotMatch(text,/재시도됨|retried|완료|complete/i,text);
});

test('S4-U1b needs_check reasons for Gateway M-of-N beside KIN K',()=>{
  for(const row of V.reasonCases){
    const labels=arrivals.receiptLabels({assignment:'assigned',observation:V.observations[row.observation],gateway:V.receipts[row.receipt]},same);
    assert.deepEqual(labels.reasons,row.reasons,row.id);assert.equal(labels.needsCheck,row.reasons.length>0,row.id);
  }
});

test('S4-U1b IF-W09 three phrases are distinct and only 관측 불가 comes from a failed observation',()=>{
  const phrases=Object.keys(V.phrases).map(kind=>arrivals.phrase(kind));
  assert.deepEqual(phrases,Object.values(V.phrases));
  for(const a of phrases)for(const b of phrases)if(a!==b)assert.ok(!a.includes(b)&&!b.includes(a));
  const unavailable=arrivals.receiptLabels({assignment:'assigned',observation:V.observations.unavailable_cold,gateway:null},same);
  assert.equal(unavailable.observation.text,V.phrases.observationUnavailable);
  for(const name of Object.keys(V.observations)){
    const text=arrivals.receiptLabels({assignment:'assigned',observation:V.observations[name],gateway:null},same).observation.text;
    assert.ok(!text.includes(V.phrases.orderWithoutImages)&&!text.includes(V.phrases.viewerLoadFailed),name);
    assert.equal(text.includes(V.phrases.observationUnavailable),name.startsWith('unavailable_'),name);
  }
  assert.throws(()=>arrivals.phrase('toString'));
});

test('S4-U1b a failed observation leaves the model it was given untouched',()=>{
  const {model}=run(V.sequences[0].steps),before=structuredClone(model);
  const failed=arrivals.observationFailed(model);
  assert.equal(failed.available,false);assert.equal(failed.rows,model.rows);assert.deepEqual(model,before);
});

test('accepts full API rows and never mutates either snapshot',()=>{
  const previous=[row('1.2',1,1,{name:'literal patient',state:{ss:'Verified'}})];
  const next=[row('1.2',2,1,{name:'changed literal',state:{ss:'Unverified'}})];
  const beforePrevious=structuredClone(previous),beforeNext=structuredClone(next);
  assert.equal(arrivals.diff(previous,next).changes[0].addedInstances,1);
  assert.deepEqual(previous,beforePrevious);assert.deepEqual(next,beforeNext);
});
