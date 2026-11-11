const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../worklist-v0/hpacs-lite/report-draft-client');
// FC-028 Batch Reading: a commit pinned to the draft revision the dialog captured is sent only on that revision, once.
// It is never re-based and re-sent (the ordinary commit reads the server draft after a 409 and sends again).

const OWNER={institution:'SYN-INST',sub:'syn-sub',author:'syn-reader@SYN'};
const UID='1.2.826.0.1.3680043.10.7707.1';
function site(answers){
  const calls=[];
  const transport={request:async(url,opts)=>{
    calls.push({url,method:opts.method||'GET',json:opts.json});
    const next=answers.shift();
    if(!next)throw Object.assign(new Error('SYN no answer'),{sent:true});
    return typeof next==='function'?next(url,opts):next;
  }};
  return {calls,client:create({transport,base:'/api'})};
}
const committed=(revision)=>({ok:true,status:200,body:{uid:UID,owner:OWNER,revision,present:false,snapshot:null,state:{rs:'T',version:1}}});
const body={action:'save',reason:'Batch Reading — SYN',baseVersion:0,findings:'F',conclusion:'C',recommendation:''};

test('pinned: the captured revision goes out as expectedRevision and the answer moves the baseline',async()=>{
  const {calls,client}=site([committed('e1:1')]);
  client.observe(UID,'e1:0',null);
  const r=await client.commit(UID,body,{owner:OWNER,pinned:{revision:'e1:0'}});
  assert.equal(r.outcome,'saved');
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,`/api/studies/${encodeURIComponent(UID)}/report/commit`);
  assert.equal(calls[0].json.expectedRevision,'e1:0');
  assert.deepEqual(calls[0].json.expectedOwner,OWNER);
  assert.equal(calls[0].json.reason,'Batch Reading — SYN');
  assert.equal(client.revision(UID),'e1:1');
});

test('pinned: a revision or epoch that moved before its turn sends nothing',async()=>{
  for(const now of ['e1:1','e2:0']){
    const {calls,client}=site([]);
    client.observe(UID,now,null);
    const r=await client.commit(UID,body,{owner:OWNER,pinned:{revision:'e1:0'}});
    assert.equal(r.outcome,'changed',now);
    assert.equal(calls.length,0,now);
  }
});

test('pinned: a draft this document knows at that revision sends nothing',async()=>{
  const draft={findings:'mine',conclusion:'',recommendation:'',baseVersion:0,citations:[],structured:[]};
  const {calls,client}=site([{ok:true,status:200,body:{uid:UID,owner:OWNER,revision:'e1:0',present:true,snapshot:draft}}]);
  client.observe(UID,'e1:0',null);
  await client.prime(UID,{owner:OWNER});   // the full read: the server holds my draft at e1:0
  assert.equal(calls.length,1);
  const r=await client.commit(UID,body,{owner:OWNER,pinned:{revision:'e1:0'}});
  assert.equal(r.outcome,'changed');
  assert.equal(calls.length,1,'no commit left');
});

test('pinned: a 409 draft conflict is returned as it is — no read, no second send',async()=>{
  const {calls,client}=site([{ok:false,status:409,code:'REPORT_DRAFT_CONFLICT',body:{code:'REPORT_DRAFT_CONFLICT'}}]);
  client.observe(UID,'e1:0',null);
  const r=await client.commit(UID,body,{owner:OWNER,pinned:{revision:'e1:0'}});
  assert.equal(r.outcome,'conflict');
  assert.equal(calls.length,1,'the ordinary commit would read the draft and send again; the pinned one does not');
  assert.equal(client.conflict(UID),null,'no conflict review is opened for a study nobody is editing');
});

test('pinned: a lost answer is unknown and the next command reads the server first',async()=>{
  const {calls,client}=site([]);
  client.observe(UID,'e1:0',null);
  const r=await client.commit(UID,body,{owner:OWNER,pinned:{revision:'e1:0'}});
  assert.equal(r.outcome,'unknown');
  assert.equal(calls.length,1);
  assert.equal(client.uncertain(UID),true);
  // While the line is uncertain, a second pinned commit is not sent either.
  const again=await client.commit(UID,body,{owner:OWNER,pinned:{revision:'e1:0'}});
  assert.equal(again.outcome,'changed');
  assert.equal(calls.length,1);
});

test('pinned: a refusal (version conflict, held) is the server answer, nothing re-sent',async()=>{
  const {calls,client}=site([{ok:false,status:409,code:'REPORT_VERSION_CONFLICT',body:{code:'REPORT_VERSION_CONFLICT',message:'SYN v1'}}]);
  client.observe(UID,'e1:0',null);
  const r=await client.commit(UID,body,{owner:OWNER,pinned:{revision:'e1:0'}});
  assert.equal(r.outcome,'refused');
  assert.equal(r.message,'SYN v1');
  assert.equal(calls.length,1);
});

test('the ordinary commit still re-reads after a draft conflict (unchanged path)',async()=>{
  const read=revision=>({ok:true,status:200,body:{uid:UID,owner:OWNER,revision,present:false,snapshot:null}});
  const {calls,client}=site([read('e1:0'),{ok:false,status:409,code:'REPORT_DRAFT_CONFLICT',body:{}},read('e1:1')]);
  client.observe(UID,'e1:0',null);
  await client.commit(UID,body,{owner:OWNER});
  assert.deepEqual(calls.map(c=>c.method),['GET','POST','GET'],'the unpinned commit settles, sends, and reads the server draft after a 409');
});
