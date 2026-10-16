/** R5-12..16 and NC-02/05/06: original request ownership and recovery faults.
 * REQ-EMR-01/03/07 -> RISK-D-02/04 -> TEST-D-04. No live storage, credentials or product string assertions.
 * SQL port implements the database protocol; transaction snapshots model rollback and savepoints.
 */
'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),{randomUUID}=require('node:crypto');
const H=require('./response_test.cjs'),{R,S,load,technician:actor,study,caller}=H;
const SV=load('emr-clinical/services.ts'),RT=load('emr-clinical/runtime.ts');
const known=value=>({status:'known',value});
const facts={event:{rolesAtTime:actor.roles,trustedProxyIp:known({address:'10.0.0.1',source:'trusted-proxy'}),requestId:'SYN',reading:false},projection:{}};
const input=(unit=null,revision=unit?.revision??0)=>({surface:'assignment.write',actor,study,unit,
  body:{requestId:randomUUID(),expectedOwner:[actor.institutionId,actor.identity.subject],revision,readerSub:null},content:null,attachments:[],navigation:[],
  recipientId:null,readerId:null,workContext:null,ids:{recordId:unit?.recordId??randomUUID(),versionId:randomUUID()},at:new Date().toISOString()});
// The storage protocol fixture, shared with the composed service fixtures (tests/emr/d/service_fixture.cjs).
const database=()=>require('./service_fixture.cjs').database({R,unitRows:H.unitRows});
function runtime(env) {
  return new RT.ClinicalRuntime({db:env.db,ledger:env.ledger,studies:{facts:async()=>study},signatures:{},recoveryDelayMs:3600000,
    context:{facts:async()=>({actor,signature:null,requestId:'SYN',trustedProxyIp:known({address:'10.0.0.1',source:'trusted-proxy'}),member:async()=>{throw new Error('No mutable member resolution');}})}});
}
function project(env,work=async()=>{}){SV.clinicalServices.prepareProjection.delete('assignment');SV.registerClinicalProjection('assignment',async()=>{env.counts.project++;await work();});}
async function write(rt,seed,admission=async()=>({})){
  return rt.write({}, {surface:seed.surface,studyId:study.studyId,recordId:seed.ids.recordId,body:seed.body,projection:{},
    caller:{subject:actor.identity.subject,institutionId:actor.institutionId},admission});
}
test('NC-05/R5-15 typed refusal survives seal loss before/after commit and restart with no clinical effects',async()=>{
  for(const failure of ['sealBefore','sealAfter']){
    const env=database(),rt=runtime(env),seed=input();project(env,async()=>{throw new SV.ProjectionRefused('ASSIGNMENT_HELD');});env.fault[failure]=1;
    const first=await write(rt,seed);assert.ok(['unknown','failed'].includes(first.outcome.status));
    const row=[...env.rows.values()][0];assert.equal(JSON.parse(row.rejection_decision).code,'ASSIGNMENT_HELD');
    assert.equal(env.units.size,0);assert.equal(env.events.length,0);
    const recovered=await runtime(env).recover(R.prepareClinicalWrite(seed));
    assert.deepEqual([recovered.status,recovered.code],['failed','ASSIGNMENT_HELD']);
    assert.ok(env.counts.seal.every(code=>code==='ASSIGNMENT_HELD'),'NC-05: ASSIGNMENT_HELD must never become StorageFailed');
    assert.equal((await write(rt,seed,async()=>{throw new Error('Mutable admission replay');})).outcome.code,'ASSIGNMENT_HELD');
  }
});
test('R5 recovery matrix: checkpoint loss, rollback, committed-unconfirmed, fenced unknown, terminal preservation and ownership release',async()=>{
  for(const phase of ['prepared','commit-dispatched']){
    const env=database(),rt=runtime(env),seed=input();project(env);env.fault.checkpoint=phase;
    assert.equal((await write(rt,seed)).outcome.status,'unknown');
    const row=[...env.rows.values()][0];assert.equal(rt.store.isActive(row.original_id),false);
    env.fault.checkpoint=null;
    assert.equal((await runtime(env).recover(R.prepareClinicalWrite(seed))).status,'replayed');
    assert.equal(env.units.size,1);assert.equal(env.events.length,1);
  }
  for(const fault of ['append','confirm']){
    const env=database(),rt=runtime(env),seed=input();project(env);env.fault[fault]=1;
    const result=await write(rt,seed),identity=R.prepareClinicalWrite(seed);
    if(fault==='append'){
      assert.deepEqual([result.outcome.status,result.outcome.code],['failed','StorageFailed']);assert.equal(env.units.size,0);
      assert.equal((await runtime(env).recover(identity)).code,'StorageFailed');
    }else{
      assert.equal(result.outcome.status,'unknown');assert.equal((await runtime(env).recover(identity)).status,'replayed');
      assert.equal(env.counts.project,1);assert.equal(env.units.size,1);assert.equal(env.events.length,1);
    }
  }
  const env=database(),rt=runtime(env),seed=input();project(env);
  const admitted=await rt.store.admit(R.prepareClinicalWrite(seed),seed,'SYN',facts,null,()=>{});rt.store.release(admitted.execution.permit.original.originalId);
  [...env.rows.values()][0].phase='commit-dispatched';
  const observed=await runtime(env).recover(R.prepareClinicalWrite(seed));
  assert.equal(observed.status,'unknown','a fence is not proof of the original cause');assert.equal(env.counts.seal.length,0);
  assert.equal(await rt.store.checkpoint(admitted.execution.permit,{phase:'prepared',work:{plan:R.planClinicalWrite(seed),signature:null}}),false,'old epoch is fenced');
});
test('NC-06/R5-12/13 atomic ownership converges after absent observation and never re-runs mutable admission',async()=>{
  const env=database(),rt=runtime(env),seed=input();project(env,async()=>{throw new SV.ProjectionRefused('ASSIGNMENT_HELD');});
  const original=await write(rt,seed);assert.equal(original.outcome.code,'ASSIGNMENT_HELD');
  const observer=runtime(env),query=env.db.$queryRaw;let once=true;
  env.db.$queryRaw=async(strings,...v)=>{if(once&&strings.join('?').includes('observe(')){once=false;return [];}return query(strings,...v);};
  let mutable=0;
  const result=await write(observer,seed,async()=>{mutable++;throw new Error('disabled reader');});
  assert.equal(result.outcome.code,'ASSIGNMENT_HELD');assert.equal(mutable,0,'only the new registry owner may evaluate mutable admission');
  assert.equal(env.counts.admit,1);assert.equal(env.units.size,0);
});
test('R5 idempotency matrix: absent, pending, rejected, committed, A-B-A, alternate fingerprint, registry fault and concurrent duplicates',async()=>{
  const env=database(),rt=runtime(env),a=input();let admissions=0;project(env);
  const admit=async()=>{admissions++;return {};};
  const [first,duplicate]=await Promise.all([write(rt,a,admit),write(rt,a,admit)]);
  assert.deepEqual(first.outcome.receipt,duplicate.outcome.receipt);assert.equal(admissions,1);assert.equal(env.events.length,1);
  const b=input([...env.units.values()][0]);await write(rt,b,admit);
  const replay=await write(rt,a,async()=>{throw new Error('re-admission');});
  assert.deepEqual(replay.outcome.receipt,first.outcome.receipt,'A after B is A');assert.equal(env.events.length,2);
  await assert.rejects(write(rt,{...a,body:{...a.body,revision:9}}),e=>e.code==='RequestIdReused');
  env.fault.observe=1;assert.equal((await write(rt,input(),admit)).outcome.status,'unknown');assert.equal(admissions,2);
  const pending=input();env.fault.checkpoint='prepared';await write(rt,pending,admit);env.fault.checkpoint=null;
  const calls=admissions;assert.equal((await write(rt,pending,admit)).outcome.status,'unknown');assert.equal(admissions,calls);
});
test('NC-02/R5-16 SQL-bound compact seeds cover 99 entries plus close at ASCII and multibyte product limits',async()=>{
  for(const text of ['x'.repeat(2000),'가'.repeat(2000),'😀'.repeat(1000)]){
    const f=H.fixture('question',100,text),env=database(),store=new S.SqlClinicalStore(env.db,env.ledger);
    const current=f.unit,base={...current,revision:99,versions:current.versions.slice(0,99),head:{recordId:current.recordId,
      versionId:current.versions[98].versionId,sha256:current.versions[98].sha256},state:current.versions[98].state.to};
    const version=current.versions[99],seed={surface:'question.close',actor:H.clinician,study,unit:base,
      body:{requestId:randomUUID(),expectedOwner:[H.clinician.institutionId,H.clinician.identity.subject],revision:99,note:text},
      content:null,attachments:[],navigation:[],recipientId:null,readerId:null,workContext:null,ids:{recordId:base.recordId,versionId:version.versionId},at:version.at};
    await store.admit(R.prepareClinicalWrite(seed),seed,'SYN',facts,null,()=>{});
    const stored=[...env.rows.values()][0].seed,parsed=JSON.parse(stored);
    assert.ok(Buffer.byteLength(stored)<524288,'entire allowed history fits the actual SQL seed parameter');
    assert.equal(parsed.unit,undefined);assert.deepEqual(parsed.base.head,base.head);assert.equal(parsed.base.revision,99);
  }
});
test('R5-14/15 source fault matrix before checkpoint, prepared, signed and dispatched preserves stale versus unknown',async()=>{
  const C=load('emr-contract/composition.ts'),adapters=load('emr-runtime/context.ts').runtimeAdapters,sources=load('emr-clinical/sources.ts');
  C.composeEmrAdapters({...adapters,stored:sources.clinicalStoredReader(adapters.stored)});
  const V=load('emr-contract/validation.ts');
  for(const phase of ['admitted','prepared','signed','commit-dispatched'])for(const fault of ['normal','missing','changed','transient','uncomposed']){
    const env=database(),store=new S.SqlClinicalStore(env.db,env.ledger),item=randomUUID();
    let row={itemId:item,revision:1,action:'create',at:new Date(),studyUid:study.studyId,snapshot:JSON.stringify({kind:'length',label:'SYN fixed source'})};
    const resolved=await SV.readClinicalSources({$queryRaw:async()=>[row]},[{kind:'item',itemId:item,revision:1}]);
    const seed={...input(),surface:'finding.create',actor:H.radiologist,body:{requestId:randomUUID(),item:{}},content:'SYN source',attachments:resolved};
    const identity=R.prepareClinicalWrite(seed),admission=await store.admit(identity,seed,'SYN',facts,null,()=>{});
    store.release(admission.execution.permit.original.originalId);[...env.rows.values()][0].phase=phase;
    const query=env.db.$queryRaw;
    env.db.$queryRaw=async(strings,...v)=>{
      if(strings.join('?').includes('"ViewerRevision"')){
        if(fault==='transient')throw new Error('SYN connection unavailable');
        if(fault==='uncomposed')throw new V.ContractError('ClinicalSourcesNotComposed');
        if(fault==='missing')return [];
        if(fault==='changed')return [{...row,snapshot:JSON.stringify({kind:'length',label:'SYN changed source'})}];
        return [row];
      }return query(strings,...v);
    };
    try{
      if(['transient','uncomposed'].includes(fault)){
        await assert.rejects(store.recoverOriginal(identity,'SYN'));
        assert.equal([...env.rows.values()][0].state,'pending');assert.equal(env.counts.seal.length,0);
      }else{
        const result=await store.recoverOriginal(identity,'SYN');
        if(['missing','changed'].includes(fault)){
          assert.equal(result.kind,'observer','source loss must be decided');assert.equal(result.observation.state,'rejected','stale original remains rejected');
          assert.equal(result.observation.proof.code,'ClinicalSourceMissing',phase+' '+fault+' preserves the stale cause');
          assert.equal(env.units.size,0);assert.equal(env.events.length,0);
        }else if(phase==='commit-dispatched')assert.equal(result.observation.state,'pending');
        else{assert.equal(result.kind,'owner');assert.equal(result.execution.seed.attachments[0].event.sha256,resolved[0].event.sha256);}
      }
    }finally{store.release(admission.execution.permit.original.originalId);}
  }
});
test('NC-01/R5-09 each projector receives the prepared current Caller and refuses revoked current authority',async()=>{
  const {StudyAccessService}=load('study-access.service.ts');
  for(const record of ['question','image-request','consultation','finding','assignment']){
    const role=record==='assignment'?'technician':['question','image-request'].includes(record)?'clinician':'radiologist';
    const who=role==='technician'?actor:role==='clinician'?H.clinician:H.radiologist;
    const f=record==='assignment'?null:H.fixture(record==='finding'?'consultation':record);
    const plan=record==='assignment'?R.planClinicalWrite(input()):f.plans[0];
    // A metadata-restricted policy uses the real service's identity-keyed cache. Unit D must carry that exact object
    // into the transaction, while current MemberRights still decide its roles.
    let granted=true,uses=0,sourceReads=0,inTransaction=false;
    const policy={version:1,restricted:true,startsAt:null,endsAt:null,rules:[{patientId:'SYN',modalities:[],dateFrom:null,dateTo:null,studyUids:[]}]};
    const db={memberRights:{findUnique:async()=>({approved:granted,suspended:false,institution:who.institutionId,roles:[role]})},$executeRaw:async()=>0,
      $queryRaw:async strings=>strings.join('?').includes('StudyAccessPolicy')?[{institution:who.institutionId,revision:1,policy}]:[]};
    const tx={...db}; // Prisma's transaction client is distinct from the root client.
    const access=new StudyAccessService(db,{studyIdentities:async()=>{assert.equal(inTransaction,false,'metadata must be prepared before the transaction');sourceReads++;return [{'0020000D':{Value:[study.studyId]},'00100020':{Value:['SYN']}}];}},{});
    SV.registerClinicalProjection(record,async(tx,p,projection,c)=>{await access.require(c,[study.studyId],tx);uses++;},{db,access});
    const kept={caller:{...caller(who),roles:['admin']}};
    const actualPlan={...plan,record,version:{...plan.version,author:who.identity,actingInstitutionId:who.institutionId}};
    const fresh=await SV.clinicalServices.prepareProjection.get(record)(actualPlan,kept);
    assert.deepEqual(fresh.roles,[role],'stored roles are not reused');
    // finding uses its own actual surface, below; no product branch is adjusted for this fixture.
    if(record==='finding'){
      const seed={...input(),surface:'finding.create',actor:who,body:{requestId:randomUUID(),item:{}},content:'SYN'};
      Object.assign(actualPlan,R.planClinicalWrite(seed));
    }
    inTransaction=true;
    await assert.doesNotReject(SV.clinicalServices.projectors.get(record)(tx,actualPlan,kept,fresh),'normal metadata authorization must survive entering a transaction');assert.equal(uses,1);assert.equal(sourceReads,1);
    granted=false;await assert.rejects(SV.clinicalServices.projectors.get(record)(tx,actualPlan,kept,fresh),e=>e.code==='ProjectionForbidden');assert.equal(uses,1);
    SV.clinicalServices.prepareProjection.delete(record);
  }
});
