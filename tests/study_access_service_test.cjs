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
