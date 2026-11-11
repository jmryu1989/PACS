const test=require('node:test'),assert=require('node:assert/strict');
const batch=require('../worklist-v0/hpacs-lite/worklist-batch-report');
const {classify,recheck,run,retryable,summary,usableTemplate,templateTexts,batchReason,capture,SKIP}=batch;
// FC-028 Batch Reading: which selected studies take the batch text, and how the rows are sent (one after another).

const blank={findings:'',conclusion:'',recommendation:''};
const unread=(over={})=>({rs:'W',ss:'Verified',em:'N',prelimHidden:false,identityUnresolved:false,texts:{...blank},draft:false,
  holder:null,unconfirmed:false,priority:false,version:0,draftRevision:'e1:0',draftEpoch:'e1',...over});

test('an Unread study with no text, no draft of mine and nothing unconfirmed takes the batch text',()=>{
  assert.deepEqual(classify(unread()),{ok:true});
  // An emergency study that is still being acquired may be read (the existing rule: Unverified && em !== 'E').
  assert.deepEqual(classify(unread({ss:'Unverified',em:'E'})),{ok:true});
});

test('every exclusion of the design is skipped with its reason',()=>{
  const cases=[
    [null,SKIP.missing],
    [unread({identityUnresolved:true}),'환자 식별 불일치'],
    [unread({prelimHidden:true,rs:'P'}),'다른 판독의의 예비 판독입니다'],
    [unread({rs:'A'}),'승인된 검사입니다'],
    [unread({rs:'H'}),'보류 중입니다'],
    [unread({rs:'D'}),'파기된 검사입니다'],
    [unread({ss:'Unverified',em:'N'}),'촬영 중(미확인) 검사입니다'],
    [unread({holder:'SYN Reader B'}),'SYN Reader B 님이 판독 중입니다'],
    [unread({holder:'다른 기관'}),'다른 기관 판독의가 판독 중입니다'],
    [unread({holder:'작성자 비공개'}),'비공개 작성자가 판독 중입니다'],
    [unread({draft:true}),'내 초안이 있습니다'],
    [unread({unconfirmed:true}),'저장을 확인하는 중인 글이 있습니다'],
    [unread({priority:true}),'응급 상태 저장을 확인하는 중입니다'],
    [unread({rs:'T',texts:{...blank,findings:'SYN saved'}}),'이미 판독문이 있습니다'],
    [unread({rs:'T'}),'이미 판독문이 있습니다'],
    [unread({rs:'P'}),'이미 판독문이 있습니다'],
    [unread({texts:{...blank,conclusion:'SYN'}}),'이미 판독문이 있습니다'],
    [unread({draftRevision:null}),'이 검사의 초안 기준을 알 수 없습니다'],
  ];
  for(const [facts,reason] of cases)assert.deepEqual(classify(facts),{ok:false,reason},JSON.stringify(facts));
});

test('an empty or blank Reading Template is never put; the reason names the template',()=>{
  assert.equal(usableTemplate(null),false);
  assert.equal(usableTemplate({title:'SYN',findings:'',conclusion:' \n',recommendation:''}),false);
  assert.equal(usableTemplate({title:'SYN',findings:'',conclusion:'SYN normal'}),true);
  assert.deepEqual(templateTexts({title:'SYN',findings:'F'}),{findings:'F',conclusion:'',recommendation:''});
  assert.equal(batchReason({title:' SYN Normal Chest '}),'Batch Reading — SYN Normal Chest');
});

test('recheck: the captured row is sent only while the study is still that row',()=>{
  const item=capture('u1',unread({version:2,draftRevision:'e1:4'}));
  assert.deepEqual(recheck(item,unread({version:2,draftRevision:'e1:4'})),{ok:true});
  assert.deepEqual(recheck(item,unread({version:2,draftRevision:'e1:5'})),{ok:false,reason:SKIP.changed});
  assert.deepEqual(recheck(item,unread({version:2,draftRevision:'e1:4',draftEpoch:'e2'})),{ok:false,reason:SKIP.changed});
  assert.deepEqual(recheck(item,unread({version:3,draftRevision:'e1:4'})),{ok:false,reason:SKIP.text});
  assert.deepEqual(recheck(item,unread({version:2,draftRevision:'e1:4',draft:true})),{ok:false,reason:SKIP.draft});
});

test('run: one row at a time, in order; a failure or a throw does not stop the next row',async()=>{
  const items=['a','b','c','d'].map(uid=>({uid}));
  const order=[],open=new Set();
  const answers={a:{status:'saved'},b:{status:'failed',reason:'SYN 409'},c:null,d:{status:'saved'}};
  const out=await run(items,{
    send:async item=>{
      assert.equal(open.size,0,'never two requests at once');open.add(item.uid);order.push(item.uid);
      await new Promise(r=>setTimeout(r,2));open.delete(item.uid);
      if(item.uid==='c')throw new Error('SYN network');
      return answers[item.uid];
    },
  });
  assert.deepEqual(order,['a','b','c','d']);
  assert.deepEqual(out.map(x=>x.result.status),['saved','failed','failed','saved']);
  assert.equal(out[2].result.reason,'SYN network');
  assert.deepEqual(retryable(out),['b','c']);
});

test('run: a lost answer is checked; what it cannot tell stays Unconfirmed and is never retried',async()=>{
  const items=['a','b','c'].map(uid=>({uid}));
  const verified=[];
  const out=await run(items,{
    send:async()=>({status:'unknown',sentAt:1}),
    verify:async item=>{verified.push(item.uid);return item.uid==='a'?{status:'saved'}:item.uid==='b'?{status:'failed',reason:'other'}:{status:'unknown'};},
  });
  assert.deepEqual(verified,['a','b','c']);
  assert.deepEqual(out.map(x=>x.result.status),['saved','failed','unknown']);
  assert.deepEqual(retryable(out),['b'],'the Unconfirmed row is not sent twice');
  assert.equal(summary(out),'Saved 1 · Skipped 0 · Failed 1 · Unconfirmed 1');
});

test('run: a row that no longer qualifies is skipped without a request',async()=>{
  const sent=[];
  const out=await run([{uid:'a'},{uid:'b'}],{check:item=>item.uid==='a'?{ok:false,reason:SKIP.changed}:{ok:true},
    send:async item=>{sent.push(item.uid);return {status:'saved'};}});
  assert.deepEqual(sent,['b']);
  assert.deepEqual(out[0].result,{status:'skipped',reason:SKIP.changed});
});

test('run: after the session ends (or the document stops) no further request leaves',async()=>{
  let alive=true;const sent=[];
  const out=await run([{uid:'a'},{uid:'b'},{uid:'c'}],{live:()=>alive?null:SKIP.stopped,
    send:async item=>{sent.push(item.uid);alive=false;return {status:'saved'};}});
  assert.deepEqual(sent,['a']);
  assert.deepEqual(out.map(x=>x.result.status),['saved','skipped','skipped']);
  // A send whose context ended answers 'stopped': that row and the rest are not sent either.
  const sent2=[];
  const out2=await run([{uid:'a'},{uid:'b'}],{send:async item=>{sent2.push(item.uid);return {status:'stopped'};}});
  assert.deepEqual(sent2,['a']);
  assert.deepEqual(out2.map(x=>x.result.reason),[SKIP.stopped,SKIP.stopped]);
});
