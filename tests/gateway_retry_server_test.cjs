// TEST-S4-U4-NOW-RETRY server: the compiled rules against the shared vectors, then the real compiled
// PacsService.requestGatewayRetry and gatewayRetryRequests over a fake store (checks in order, one identical
// 404, binding under the U3 lock, one audit, F-01, admin-only inclusion, the read-only poll, busy).
// Runs inside kin-api:ci; no network, no database, no clinical data. The poll's pending predicate lives in
// one SQL statement: here its text and bound values are pinned; over real rows it is the live route test.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');const {join}=require('node:path');
const R=require('/app/dist/gateway-retry');
const {PacsService}=require('/app/dist/pacs.service');
const {StudyAccessService}=require('/app/dist/study-access.service');
const V=JSON.parse(readFileSync(join(__dirname,'gateway_retry_vectors.json'),'utf8'));
const EPOCH=V.epoch;

const TECH={institution:'hallym',sub:'tech-sub',actor:'synthetic-tech',roles:['technician'],kind:'member'};
const ADMIN_ONLY={institution:'hallym',sub:'admin-sub',actor:'synthetic-admin',roles:['admin'],kind:'member'};
const RADIOLOGIST={institution:'hallym',sub:'rad-sub',actor:'synthetic-rad',roles:['radiologist'],kind:'member'};
const GATEWAY={institution:'hallym',sub:'gw-sub',actor:'service-account-gw-hallym',roles:['gateway'],kind:'gateway'};
const NOT_FOUND='검사를 찾을 수 없습니다';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const receipt=(uid,phase,extra={})=>({studyUid:uid,institutionId:'hallym',epoch:EPOCH,seq:5n,phase,attempt:1n,successCount:3n,
  localCount:12n,errorCode:phase==='retry'?'stow_http':phase==='failed'?'instance_exceeds_budget':null,
  receivedAt:new Date('2026-09-24T01:04:00.000Z'),...extra});

/**
 * The fake store. `pg_advisory_xact_lock(` really serializes per key (released when the transaction
 * callback settles), and every read/write yields, so two requests interleave unless the lock holds them.
 */
function store({states,receipts=[],policy=null,busy=null,flip=false,poll=[]}={}){
  const STATES=new Map((states||[['2.25.1','hallym',null],['2.25.2','kin-center',null],['2.25.3','kin-center','hallym']])
    .map(([uid,institutionId,teleInstitutionId])=>[uid,{uid,institutionId,teleInstitutionId,rs:'W',preDoc:null,preReviewer:null}]));
  const RECEIPTS=new Map(receipts.map(r=>[r.studyUid,r]));
  const log=[],audits=[],requests=new Map(),raw=[],locks=new Map();let writes=0,stateReads=0;
  const rowKey=r=>r.studyUid+'|'+r.epoch+'|'+String(r.seq);
  const refuse=name=>()=>{throw new Error('the Now Retry path never calls '+name);};
  const base={
    studyState:{findUnique:async({where,select})=>{log.push(['state',where.uid]);stateReads++;
        let s=STATES.get(where.uid);if(s&&flip&&stateReads>1)s={...s,institutionId:'kin-center'};
        if(!s)return null;return select?Object.fromEntries(Object.keys(select).map(k=>[k,s[k]])):{...s};},
      update:refuse('studyState.update'),create:refuse('studyState.create')},
    gatewayReceipt:{findFirst:async({where})=>{log.push(['receipt',structuredClone(where)]);await tick();
        const r=RECEIPTS.get(where.studyUid);return r&&r.institutionId===where.institutionId?{...r}:null;},
      findUnique:refuse('gatewayReceipt.findUnique'),create:refuse('gatewayReceipt.create'),update:refuse('gatewayReceipt.update'),
      upsert:refuse('gatewayReceipt.upsert')},
    gatewayRetryRequest:{
      findUnique:async({where})=>{const k=where.studyUid_epoch_seq;log.push(['request',rowKey(k)]);await tick();
        const r=requests.get(rowKey(k));return r?{...r}:null;},
      create:async({data})=>{await tick();const k=rowKey(data);
        if(requests.has(k))throw Object.assign(new Error('Unique constraint failed'),{code:'P2002'});
        writes++;requests.set(k,{...data});log.push(['create',k]);return data;},
      update:refuse('gatewayRetryRequest.update'),upsert:refuse('gatewayRetryRequest.upsert'),delete:refuse('gatewayRetryRequest.delete'),
      deleteMany:refuse('gatewayRetryRequest.deleteMany'),updateMany:refuse('gatewayRetryRequest.updateMany')},
    auditLog:{create:async({data})=>{writes++;audits.push({...data});return data;}},
    $executeRaw:async strings=>{log.push(['execute',strings.join('?')]);return 0;},
    $queryRaw:async(strings,...values)=>{const sql=strings.join('?');
      if(sql.includes('StudyAccessPolicy')){log.push(['policy']);
        return policy?[{institution:'hallym',revision:1,policy,reason:'SYNTHETIC',updatedBy:null,updatedAt:null}]:[];}
      if(sql.includes('pg_advisory_xact_lock_shared('))return [{locked:1}];
      if(sql.includes('"GatewayRetryRequest"')){raw.push({sql,values});log.push(['poll']);return structuredClone(poll);}
      throw new Error('unexpected SQL '+sql);},
  };
  base.$transaction=async(fn,options)=>{log.push(['transaction',options]);if(busy)throw busy;
    const held=[];
    const tx={...base,$queryRaw:async(strings,...values)=>{const sql=strings.join('?');
      if(sql.includes('pg_advisory_xact_lock(')){const key=values[0],prev=locks.get(key)||Promise.resolve();let release;
        const mine=new Promise(resolve=>{release=resolve;});locks.set(key,prev.then(()=>mine));await prev;held.push(release);
        log.push(['lock',key]);return [{locked:1}];}
      return base.$queryRaw(strings,...values);}};
    try{return await fn(tx);}finally{held.forEach(release=>release());}};
  return {svc:new PacsService(base,{},{},new StudyAccessService(base,{},{})),log,audits,requests,raw,writes:()=>writes};
}
const ask=(s,uid,caller=TECH,body={})=>s.svc.requestGatewayRetry(uid,body,caller);
async function status(promise){try{return {status:200,body:await promise};}catch(e){return {status:e.getStatus(),body:e.getResponse()};}}

test('C1 compiled parsers and decision match every shared vector',()=>{
  for(const c of V.requestBody){
    let got='ok';
    try{R.parseGatewayRetryRequestBody(c.absent?undefined:c.body);}catch(e){assert.ok(e instanceof R.GatewayRetryInputError,c.id);got=e.message;}
    assert.equal(got,c.ok?'ok':c.error,c.id);
  }
  for(const c of V.pollQuery){
    let got='ok';
    try{assert.equal(R.parseGatewayRetryPoll(c.query),c.query.epoch);}catch(e){assert.ok(e instanceof R.GatewayRetryInputError,c.id);got=e.message;}
    assert.equal(got,c.ok?'ok':c.error,c.id);
  }
  for(const c of V.decide)assert.equal(R.decideGatewayRetryRequest(c.receipt),c.expect,c.id);
  assert.equal(R.GATEWAY_RETRY_POLL_LIMIT,V.pollLimit);
  assert.deepEqual([R.GATEWAY_RETRY_INVALID,R.GATEWAY_RETRY_POLL_INVALID,R.GATEWAY_RETRY_NOT_RETRY,R.GATEWAY_RETRY_UNSUPPORTED_F01,R.GATEWAY_RETRY_BUSY],
    ['GATEWAY_RETRY_INVALID','GATEWAY_RETRY_POLL_INVALID','GATEWAY_RETRY_NOT_RETRY','GATEWAY_RETRY_UNSUPPORTED_F01','GATEWAY_RETRY_BUSY']);
});

test('C2 role, credential kind, institution and body/query refusals all come before any store access',async()=>{
  const s=store({receipts:[receipt('2.25.1','retry')]});
  for(const caller of [RADIOLOGIST,{...TECH,roles:[]},{...GATEWAY,roles:['technician']},{...TECH,kind:'gateway'},{...TECH,institution:null}])
    assert.equal((await status(ask(s,'2.25.1',caller))).status,403,JSON.stringify(caller));
  for(const c of V.requestBody.filter(c=>!c.ok))
    assert.deepEqual(await status(ask(s,'2.25.1',TECH,c.body)),{status:400,body:{code:'GATEWAY_RETRY_INVALID'}},c.id);
  for(const caller of [TECH,ADMIN_ONLY,{...TECH,roles:['technician','admin']},{...GATEWAY,kind:'member'},{...GATEWAY,roles:[]},{...GATEWAY,institution:null}])
    assert.equal((await status(s.svc.gatewayRetryRequests({epoch:EPOCH},caller))).status,403,JSON.stringify(caller));
  for(const c of V.pollQuery.filter(c=>!c.ok))
    assert.deepEqual(await status(s.svc.gatewayRetryRequests(c.query,GATEWAY)),{status:400,body:{code:'GATEWAY_RETRY_POLL_INVALID'}},c.id);
  assert.deepEqual(s.log,[]);assert.equal(s.writes(),0);assert.deepEqual(s.audits,[]);
});

test('C3 absent, foreign, tele-received, restricted and changed-before-the-lock are one identical 404, nothing written',async()=>{
  const answers=[];
  const retry=[receipt('2.25.1','retry'),receipt('2.25.2','retry',{institutionId:'kin-center'}),receipt('2.25.3','retry',{institutionId:'kin-center'})];
  answers.push(await status(ask(store({receipts:retry}),'2.25.9')));
  answers.push(await status(ask(store({receipts:retry}),'2.25.2')));
  answers.push(await status(ask(store({receipts:retry}),'2.25.3')));      // hallym receives it for tele-reading
  const restricted={version:1,restricted:true,startsAt:null,endsAt:null,rules:[{patientId:null,modalities:[],dateFrom:null,dateTo:null,studyUids:['2.25.99']}]};
  const r=store({receipts:retry,policy:restricted});answers.push(await status(ask(r,'2.25.1')));
  const f=store({receipts:retry,flip:true});answers.push(await status(ask(f,'2.25.1')));
  assert.deepEqual(answers.map(a=>a.status),[404,404,404,404,404]);
  for(const a of answers)assert.deepEqual(a.body,answers[0].body);
  assert.equal(answers[0].body.message,NOT_FOUND);
  assert.equal(JSON.stringify(answers).includes('kin-center'),false);
  assert.deepEqual([r.writes(),f.writes(),r.audits.length,f.audits.length],[0,0,0,0]);
  assert.ok(f.log.some(x=>x[0]==='lock'),'the flipped study is refused inside the lock, after the re-read');
});

test('C4 first request binds the stored retry receipt with one audit at server time; a repeat and a concurrent pair write once',async()=>{
  const s=store({receipts:[receipt('2.25.1','retry',{seq:7n})]});const before=Date.now();
  const first=await ask(s,'2.25.1',TECH,undefined);
  assert.deepEqual(Object.keys(first).sort(),['requestedAt','result','studyUid']);
  assert.deepEqual([first.studyUid,first.result],['2.25.1','requested']);
  assert.ok(Date.parse(first.requestedAt)>=before&&first.requestedAt.endsWith('Z'),'the request time is the server clock');
  const [row]=[...s.requests.values()];
  assert.deepEqual([row.studyUid,row.epoch,row.seq,row.requestedAt.toISOString()],['2.25.1',EPOCH,7n,first.requestedAt]);
  assert.deepEqual(s.audits.map(a=>[a.actor,a.action,a.target,JSON.parse(a.detail)]),[[TECH.actor,'gateway.retry.request','2.25.1',{epoch:EPOCH,seq:7}]]);
  const locks=s.log.filter(x=>x[0]==='lock');
  assert.deepEqual(locks,[['lock','kin.gateway-receipt:2.25.1']],'the U3 receipt lock key');
  assert.deepEqual(s.log.find(x=>x[0]==='transaction')[1],{isolationLevel:'ReadCommitted',maxWait:4000,timeout:8000});
  assert.deepEqual(s.log.filter(x=>x[0]==='receipt').map(x=>x[1]),[{studyUid:'2.25.1',institutionId:'hallym'}]);
  const again=await ask(s,'2.25.1',TECH,{});
  assert.deepEqual(again,{...first,result:'already_requested'});
  assert.deepEqual([s.writes(),s.audits.length,s.requests.size],[2,1,1]);
  const pair=store({receipts:[receipt('2.25.1','retry')]});
  const both=await Promise.all([ask(pair,'2.25.1',TECH),ask(pair,'2.25.1',{...TECH,actor:'synthetic-tech-2',sub:'tech-2'})]);
  assert.deepEqual(both.map(x=>x.result).sort(),['already_requested','requested']);
  assert.equal(both[0].requestedAt,both[1].requestedAt);
  assert.deepEqual([pair.requests.size,pair.audits.length],[1,1]);
});

test('C5 only retry is eligible: none/pending/announcing/sending/complete are NOT_RETRY, failed is F-01, nothing written',async()=>{
  for(const [rows,code] of [[[],'GATEWAY_RETRY_NOT_RETRY'],...['pending','announcing','sending','complete'].map(p=>[[receipt('2.25.1',p)],'GATEWAY_RETRY_NOT_RETRY']),
      [[receipt('2.25.1','retry',{institutionId:'kin-center'})],'GATEWAY_RETRY_NOT_RETRY'],[[receipt('2.25.1','failed')],'GATEWAY_RETRY_UNSUPPORTED_F01']]){
    const s=store({receipts:rows});
    assert.deepEqual(await status(ask(s,'2.25.1')),{status:409,body:{code}},JSON.stringify(rows.map(r=>[r.phase,r.institutionId])));
    assert.deepEqual([s.writes(),s.audits.length,s.requests.size],[0,0,0]);
  }
});

test('C6 (R2) an admin-only member of the owning institution may ask; the same admin elsewhere is 404; radiologist-only is 403',async()=>{
  const s=store({receipts:[receipt('2.25.1','retry'),receipt('2.25.2','retry',{institutionId:'kin-center'})]});
  assert.deepEqual(ADMIN_ONLY.roles,['admin']);
  const own=await ask(s,'2.25.1',ADMIN_ONLY);
  assert.equal(own.result,'requested');
  assert.deepEqual(s.audits.map(a=>a.actor),[ADMIN_ONLY.actor]);
  assert.deepEqual(await status(ask(s,'2.25.2',ADMIN_ONLY)),{status:404,body:{statusCode:404,message:NOT_FOUND,error:'Not Found'}});
  const before=s.log.length;
  assert.equal((await status(ask(s,'2.25.1',RADIOLOGIST))).status,403);
  assert.equal(s.log.length,before,'the role refusal reads nothing');
  assert.deepEqual([s.requests.size,s.audits.length],[1,1]);
});

test('C7 the poll: gateway only, closed query, one read-only statement with the D2 predicate before LIMIT, UIDs only',async()=>{
  const s=store({poll:[{studyUid:'2.25.21'},{studyUid:'2.25.1'},{studyUid:'2.25.9'}]});
  const answer=await s.svc.gatewayRetryRequests({epoch:EPOCH},GATEWAY);
  assert.deepEqual(answer,{studyUids:['2.25.21','2.25.1','2.25.9']},'the database order is kept; nothing re-sorted or re-filtered');
  assert.deepEqual(Object.keys(answer),['studyUids']);
  assert.equal(s.raw.length,1);
  const sql=s.raw[0].sql.replace(/\s+/g,' ');
  for(const needle of ['SELECT q."studyUid" FROM "GatewayRetryRequest" q',
    'JOIN "GatewayReceipt" r ON r."studyUid" = q."studyUid" AND r.epoch = q.epoch AND r.seq = q.seq',
    'JOIN "StudyState" s ON s.uid = q."studyUid"',"WHERE q.epoch = ?::uuid AND r.phase = 'retry' AND r.\"institutionId\" = ? AND s.\"institutionId\" = ?",
    'ORDER BY q."requestedAt", q."studyUid" LIMIT '+R.GATEWAY_RETRY_POLL_LIMIT])assert.ok(sql.includes(needle),needle);
  assert.deepEqual(s.raw[0].values,[EPOCH,'hallym','hallym'],'epoch from the query, institution only from the credential');
  assert.equal(s.log.some(x=>x[0]==='transaction'),false);
  assert.deepEqual([s.writes(),s.audits.length],[0,0]);
  const other=store({poll:[]});
  assert.deepEqual(await other.svc.gatewayRetryRequests({epoch:V.otherEpoch},{...GATEWAY,institution:'kin-center'}),{studyUids:[]});
  assert.deepEqual(other.raw[0].values,[V.otherEpoch,'kin-center','kin-center']);
});

test('C8 a lock or transaction timeout is 503 GATEWAY_RETRY_BUSY with nothing written; other errors are not relabelled',async()=>{
  for(const busy of [Object.assign(new Error('timeout'),{code:'P2028'}),Object.assign(new Error('lock'),{code:'P2010',meta:{code:'55P03'}}),
      Object.assign(new Error('cancel'),{code:'P2010',meta:{code:'57014'}})]){
    const s=store({receipts:[receipt('2.25.1','retry')],busy});
    assert.deepEqual(await status(ask(s,'2.25.1')),{status:503,body:{code:'GATEWAY_RETRY_BUSY'}});
    assert.deepEqual([s.writes(),s.audits.length],[0,0]);
  }
  const s=store({receipts:[receipt('2.25.1','retry')],busy:Object.assign(new Error('other'),{code:'P2010',meta:{code:'23505'}})});
  await assert.rejects(ask(s,'2.25.1'),e=>e.message==='other');
});
