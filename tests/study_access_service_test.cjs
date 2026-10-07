const test=require('node:test'),assert=require('node:assert/strict');
const {StudyAccessService}=require('/app/dist/study-access.service');
const {StudyAccessInterceptor}=require('/app/dist/study-access.interceptor');
const {of,lastValueFrom,tap}=require('/app/node_modules/rxjs');
const caller={kind:'member',institution:'synthetic',sub:'synthetic-sub',actor:'synthetic-actor',roles:['radiologist']};
const policy=()=>({version:1,restricted:true,startsAt:null,endsAt:null,rules:[{patientId:'SYNTHETIC',modalities:[],dateFrom:null,dateTo:null,studyUids:[]}]});
const uid='2.25.1234';
function service(initial){const normalized=v=>v.map(r=>({institution:caller.institution,...r}));let rows=normalized(initial),rootQueries=0;const db={$queryRaw:async()=>{rootQueries++;return rows;}};const orth={studyAccessMetadata:async()=>null,studyIdentities:async()=>[]};return {svc:new StudyAccessService(db,orth,{}),orth,db,set:v=>{rows=normalized(v);},queries:()=>rootQueries};}
test('malformed/missing storage fails closed; absent policy preserves default scope',async()=>{
  const f=service([]);assert.deepEqual([...await f.svc.allowed(caller,[uid])],[uid]);
  f.set([{revision:1,policy:{}}]);await assert.rejects(f.svc.allowed(caller,[uid]),e=>e.getStatus()===503);
  f.db.$queryRaw=async()=>{throw Error('database unavailable');};await assert.rejects(f.svc.allowed(caller,[uid]),e=>e.getStatus()===503);
});
test('missing single source and real nonmatching source both deny without existence oracle',async()=>{
  const f=service([{revision:1,policy:policy()}]);
  await assert.rejects(f.svc.require({...caller},[uid]),e=>e.getStatus()===404);
  f.orth.studyAccessMetadata=async()=>({'0020000D':{Value:[uid]},'00100020':{Value:['OTHER']}});
  await assert.rejects(f.svc.require({...caller},[uid]),e=>e.getStatus()===404);
  f.orth.studyAccessMetadata=async()=>{throw Error('transport');};await assert.rejects(f.svc.require({...caller},[uid]),e=>e.getStatus()===503);
});
test('transaction scope stays on one pooled connection, takes shared advisory lock',async()=>{
  const f=service([]),calls=[];const p=policy();p.rules=[{all:true}];
  const tx={$queryRaw:async(strings)=>{const sql=strings.join('?');calls.push(sql);return sql.includes('pg_advisory')?[{locked:1}]:[{institution:caller.institution,revision:3,policy:p}];}};
  await f.svc.require(caller,[uid],tx);assert.equal(f.queries(),0);assert.equal(calls.length,2);assert.match(calls[0],/pg_advisory_xact_lock_shared/);
});
test('final response check rejects a policy change across a read snapshot',async()=>{
  const f=service([]),interceptor=new StudyAccessInterceptor(f.svc);
  const context={switchToHttp:()=>({getRequest:()=>caller}),getClass:()=>({name:'ViewerController'}),getHandler:()=>({name:'list'})};
  const stream=await interceptor.intercept(context,{handle:()=>of({patient:'must not escape'}).pipe(tap(()=>f.set([{revision:1,policy:policy()}])))});
  await assert.rejects(lastValueFrom(stream),e=>e.getStatus()===409);
});
test('DICOM auth maps failed policy lookup to nginx-compatible 403',async()=>{
  const f=service([{revision:1,policy:{}}]),interceptor=new StudyAccessInterceptor(f.svc);
  const context={switchToHttp:()=>({getRequest:()=>caller}),getClass:()=>({name:'PacsController'}),getHandler:()=>({name:'authzDicom'})};
  await assert.rejects(interceptor.intercept(context,{handle:()=>of(null)}),e=>e.getStatus()===403);
});
test('profile remains available to recover malformed study policy through admin scope',async()=>{
  const f=service([{revision:1,policy:{}}]),interceptor=new StudyAccessInterceptor(f.svc);
  const context={switchToHttp:()=>({getRequest:()=>caller}),getClass:()=>({name:'PacsController'}),getHandler:()=>({name:'me'})};
  assert.deepEqual(await lastValueFrom(await interceptor.intercept(context,{handle:()=>of({sub:caller.sub})})),{sub:caller.sub});
  assert.equal(f.queries(),0);
});

test('managed identity requires new institution decision, even when old policy was cleared',async()=>{
  const p={version:1,restricted:false,startsAt:null,endsAt:null,rules:[]};
  const f=service([{institution:'previous',revision:4,policy:p}]);
  assert.equal((await f.svc.snapshot(caller)).needsInstitutionReview,true);
  await assert.rejects(f.svc.require({...caller},[uid]),e=>e.getStatus()===404);
  f.set([{institution:caller.institution,revision:1,policy:p}]);
  assert.deepEqual([...await f.svc.allowed(caller,[uid])],[uid]);
});


test('legacy synthetic keys remain valid without restriction and are hidden under restrictions',async()=>{
  const f=service([]);assert.deepEqual([...await f.svc.allowed(caller,['legacy-key',uid])],['legacy-key',uid]);
  assert.equal(f.svc.matches(await f.svc.snapshot(caller),'legacy-key'),true);
  const p=policy();p.rules=[{all:true}];f.set([{revision:1,policy:p}]);
  assert.deepEqual([...await f.svc.allowed(caller,['legacy-key',uid])],[uid]);
});

test('conditional clinical transaction uses prepared source tags without network or root connection',async()=>{
  const f=service([{revision:1,policy:policy()}]),request={...caller};let network=0;
  f.orth.studyAccessMetadata=async()=>{network++;return {'0020000D':{Value:[uid]},'00100020':{Value:['SYNTHETIC']}};};
  const tx={$queryRaw:async(strings)=>strings.join('?').includes('pg_advisory')?[{locked:1}]:[{institution:caller.institution,revision:1,policy:policy()}]};
  await assert.rejects(f.svc.require(request,[uid],tx),e=>e.getStatus()===409);assert.equal(network,0);
  await f.svc.prepare(request,[uid]);const before=f.queries();
  f.orth.studyAccessMetadata=async()=>{throw Error('network inside transaction');};
  await f.svc.require(request,[uid],tx);assert.equal(network,1);assert.equal(f.queries(),before);
  const changed=policy();changed.rules[0].patientId='OTHER';
  const changedTx={$queryRaw:async(strings)=>strings.join('?').includes('pg_advisory')?[]:[{institution:caller.institution,revision:2,policy:changed}]};
  await assert.rejects(f.svc.require(request,[uid],changedTx),e=>e.getStatus()===404);
});

// S7-U4a fix1 (Astra S7-U4a-R-001 F02): snapshot() passes the original error on as the 503's cause. What every caller gets
// stays as it was: status, body, and no code/meta on the exception itself (reader-assignment, study-tags, consultation and
// others map busy codes from e.code, so a code here would change their answers). All but the last case also hold for the
// service before the change; the last one is the cause Clinical Context reads.
const unavailable={message:'검사 접근 조건을 확인하지 못했습니다. 잠시 후 다시 시도하세요',error:'Service Unavailable',statusCode:503};
const dbError=(code,meta)=>Object.assign(Error('SYN-DB-DETAIL'),{code},meta?{meta:{code:meta,message:'SYN-DB-DETAIL'}}:{});
const failures=()=>[['lock timeout',dbError('P2010','55P03')],['expired transaction',dbError('P2028')],['other DB error',dbError('P2010','42P01')],['no code',Error('SYN-DB-DETAIL')]];
const same=(e,label)=>{assert.equal(e.getStatus(),503,label);assert.deepEqual(e.getResponse(),unavailable,label);assert.equal(e.code,undefined,label);assert.equal(e.meta,undefined,label);return true;};
test('a failed policy read answers one 503 body with no code of its own, on the root client and in a transaction',async()=>{
  for(const [label,error] of failures()){
    const f=service([]);f.db.$queryRaw=async()=>{throw error;};
    await assert.rejects(f.svc.snapshot(caller),e=>same(e,label));
    await assert.rejects(f.svc.require(caller,[uid],{$queryRaw:async()=>{throw error;}}),e=>same(e,label+' in a transaction'));
  }
  await assert.rejects(service([{revision:1,policy:{}}]).svc.snapshot(caller),e=>same(e,'malformed policy row'));
});
test('the worklist, report preview and response interceptor keep their answers when the policy read fails',async()=>{
  const {PacsService}=require('/app/dist/pacs.service');
  const {ReportPreviewController}=require('/app/dist/report-preview.controller');
  const context=(controller,handler)=>({switchToHttp:()=>({getRequest:()=>caller}),getClass:()=>({name:controller}),getHandler:()=>({name:handler})});
  const state={uid,institutionId:caller.institution,teleInstitutionId:null,rs:'A',preDoc:null,preReviewer:null,ov:null};
  for(const [label,error] of failures()){
    const f=service([]);f.db.$queryRaw=async()=>{throw error;};
    await assert.rejects(new PacsService(f.db,f.orth,{},f.svc,{}).listStudies({...caller}),e=>same(e,'worklist '+label));
    const interceptor=new StudyAccessInterceptor(f.svc);
    await assert.rejects(interceptor.intercept(context('ViewerController','list'),{handle:()=>of(null)}),e=>same(e,'interceptor '+label));
    await assert.rejects(interceptor.intercept(context('PacsController','authzDicom'),{handle:()=>of(null)}),
      e=>e.getStatus()===403&&JSON.stringify(e.getResponse())===JSON.stringify({message:'열람 권한이 없습니다',error:'Forbidden',statusCode:403}));
    // report preview: the policy read fails first on the root client, then (root fine) inside its own transaction
    const db=(read)=>({$queryRaw:read,studyState:{findUnique:async()=>({...state})}});
    const orth={...f.orth,reportPreviewStudy:async()=>({})};
    const preview=prisma=>new ReportPreviewController(prisma,orth,new StudyAccessService(prisma,orth,{}),{});
    await assert.rejects(preview(db(f.db.$queryRaw)).read(uid,{...caller}),e=>same(e,'report preview '+label));
    const root=db(async()=>[]),tx=db(async()=>{throw error;});
    root.$transaction=async fn=>fn(tx);
    await assert.rejects(preview(root).read(uid,{...caller}),e=>same(e,'report preview transaction '+label));
  }
});
test('the original error is kept only as the cause, never in the body',async()=>{
  for(const [label,error] of failures()){
    const f=service([]);f.db.$queryRaw=async()=>{throw error;};
    let seen=null;try{await f.svc.snapshot(caller);}catch(e){seen=e;}
    assert.equal(seen?.cause,error,label);
    assert.ok(!JSON.stringify(seen.getResponse()).includes('SYN-DB-DETAIL'),label);
  }
});

// REQ-S7-U5-DB-RIGHTS -> RISK-STALE-AFFILIATION -> CORE-ACCESS, D623.
test('CORE-ACCESS managed affiliation is the current DB member, independent of provider claims',async()=>{
  const subject='00000000-0000-4000-8000-000000000091',c={...caller,roles:['admin']};
  const f=service([]),row={sub:subject,approved:true,suspended:false,institution:c.institution,roles:['radiologist'],username:'syn',email:'syn@synthetic.test'};
  let current=row;f.db.memberRights={findUnique:async()=>current};
  assert.equal((await f.svc.read(subject,c)).subject,subject);
  for(const update of [{institution:'old-provider-institution'},{suspended:true},{approved:false},null]){
    current=update?{...row,...update}:null;
    await assert.rejects(f.svc.read(subject,c),e=>e.getStatus()===404);
  }
});
