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
function database() {
  const rows=new Map(),units=new Map(),events=[]; const fault={sealBefore:0,sealAfter:0,confirm:0,observe:0,append:0,checkpoint:null};
  const counts={admit:0,commit:0,project:0,seal:[]};
  let savepoint=null, queue=Promise.resolve();
  const key=v=>JSON.stringify(v.slice(0,3)),err=code=>Object.assign(new Error(code),{meta:{code}});
  const copy=()=>({rows:structuredClone([...rows]),units:structuredClone([...units]),events:structuredClone(events)});
  const restore=s=>{rows.clear();for(const [k,v]of s.rows)rows.set(k,v);units.clear();for(const [k,v]of s.units)units.set(k,v);events.splice(0,events.length,...s.events);};
  const db={$executeRaw:async strings=>{const sql=strings.join('?');if(sql.startsWith('SAVEPOINT'))savepoint=copy();if(sql.startsWith('ROLLBACK TO'))restore(savepoint);return 0;},
    $queryRaw:async(strings,...v)=>{
      const sql=strings.join('?'),row=rows.get(key(v));
      if(sql.includes('lock_request')||sql.includes('note_attempt'))return [];
      if(sql.includes('unit_for'))return units.has(v[0])?H.unitRows(units.get(v[0])):[];
      if(sql.includes('observe(')){if(fault.observe-->0)throw new Error('SYN read unavailable');if(row&&row.fingerprint!==v[3])throw err('ED002');return row?[{...row,kind:'observer'}]:[];}
      if(sql.includes('admit(')){
        if(row){if(row.fingerprint!==v[3])throw err('ED002');return [{...row,kind:'observer'}];}
        const created={original_id:randomUUID(),epoch:1,phase:'admitted',state:'pending',fingerprint:v[3],seed:v[4],facts:v[5],envelope:v[6],checkpoint:null,confirmed:false};
        rows.set(key(v),created);counts.admit++;return [{...created,kind:'owner'}];
      }
      if(sql.includes('checkpoint(')){
        if(fault.checkpoint===v[5])throw new Error('SYN checkpoint lost');
        if(!row||row.epoch!==v[4]||row.state!=='pending'||row.rejection_decision)return [{done:false}];
        row.phase=v[5];row.checkpoint=v[6];return [{done:true}];
      }
      if(sql.includes('commit_version(')){
        if(!row||row.epoch!==v[4]||row.state!=='pending'||row.phase!=='commit-dispatched'||row.rejection_decision)throw err('ED004');
        const version=JSON.parse(v[18]),terminal=JSON.parse(v[20]);
        const unit=units.get(v[5])??null;if((unit?.revision??0)+1!==version.sequence)throw err('ED003');
        units.set(v[5],R.applyPlan(unit,terminal.binding.plan));
        row.state='committed';row.terminal=v[20];row.access_event=v[21];row.record_id=v[5];counts.commit++;return [{done:true}];
      }
      if(sql.includes('remember_rejection')){
        if(!row||row.epoch!==v[4]||row.state!=='pending')return [{done:false}];
        if(row.rejection_decision&&JSON.parse(row.rejection_decision).code!==JSON.parse(v[5]).code)throw err('ED004');
        row.rejection_decision??=v[5];return [{done:true}];
      }
      if(sql.includes('rejection_for'))return [{decision:[...rows.values()].find(r=>r.original_id===v[0])?.rejection_decision??null}];
      if(sql.includes('seal_rejected')){
        counts.seal.push(JSON.parse(v[6]).proof.code);
        if(fault.sealBefore-->0)throw new Error('SYN seal before commit');
        if(!row||row.epoch!==v[4]||row.state!=='pending'||!row.rejection_decision)return [{done:false}];
        row.state='rejected';row.terminal=v[6];if(fault.sealAfter-->0)throw new Error('SYN seal response lost');return [{done:true}];
      }
      if(sql.includes('confirm_request')){if(fault.confirm-->0)throw new Error('SYN confirm lost');row.confirmed=true;return [{done:true}];}
      if(sql.includes('recover(')){if(!row)return [];if(row.fingerprint!==v[3])throw err('ED002');if(row.state!=='pending')return [{...row,kind:'observer'}];row.epoch++;return [{...row,kind:row.phase==='commit-dispatched'?'fenced':'owner'}];}
      throw new Error('Unimplemented synthetic SQL '+sql);
    }};
  const ledger={withAppendTransaction:work=>{
    const run=queue.then(async()=>{const before=copy();try{return await work(db);}catch(e){restore(before);throw e;}});
    queue=run.catch(()=>{});return run;
  },appendInTransaction:async(_tx,event)=>{if(fault.append-->0)throw new Error('SYN B append rollback');events.push(event);return {event};},
  settleTransaction:async()=>{},confirm:async p=>({eventId:p.event.eventId,durableAt:new Date().toISOString()}),
  append:async e=>({eventId:e.eventId,durableAt:new Date().toISOString()})};
  return {db,ledger,rows,units,events,fault,counts};
}
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
