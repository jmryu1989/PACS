// TEST-S4-U3-GATEWAY-RECEIPT server: the compiled rule against the shared vectors, then the real compiled
// PacsService.gatewayReceipt and listStudies over a fake store (ownership 404 before any order rule, closed
// body, replay/conflict/stale, H-1 interim epoch refusal with a bounded audit, own-row read surface).
// Runs inside kin-api:ci; no network, no database, no clinical data.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');const {join}=require('node:path');
const R=require('/app/dist/gateway-receipt');
const {PacsService}=require('/app/dist/pacs.service');
const {StudyAccessService}=require('/app/dist/study-access.service');
const V=JSON.parse(readFileSync(join(__dirname,'gateway_receipt_vectors.json'),'utf8'));
const OTHER_EPOCH='ffffffff-ffff-4fff-bfff-ffffffffffff';

// Spread, not Object.assign: a vector's own "__proto__" key must stay an own key, as JSON.parse leaves it.
function parseBody(c){if('body' in c)return c.body;const body={...V.valid,...(c.set||{})};for(const key of c.drop||[])delete body[key];return body;}
const body=(uid,seq,extra={})=>({...V.valid,studyUid:uid,seq,...extra});

test('S4-U3 compiled parse matches every shared vector and names only the refused field',()=>{
  for(const c of V.parse){
    let got='ok';
    try{R.parseGatewayReceipt(parseBody(c));}catch(e){assert.ok(e instanceof R.GatewayReceiptInputError,c.id);got=e.message;}
    assert.equal(got,c.ok?'ok':c.error,c.id);
  }
  assert.deepEqual([...R.GATEWAY_RECEIPT_KEYS],V.keys);assert.deepEqual([...R.GATEWAY_PHASES],V.phases);
  assert.deepEqual([...R.GATEWAY_ERROR_PHASES],V.errorPhases);assert.equal(R.GATEWAY_EPOCH_INCIDENT_WINDOW_MS,V.incidentWindowMs);
});

test('S4-U3 compiled decide matches every shared vector',()=>{
  for(const c of V.decide){
    const stored='stored' in c&&c.stored===null?null:{...V.stored,...(c.storedSet||{})};
    const got=R.decideGatewayReceipt(stored,{...V.valid,...c.next});
    assert.deepEqual(got,c.kind==='advance'?{kind:'advance',transition:c.transition}:{kind:c.kind},c.id);
  }
});

test('S4-U3 projection is the S4-U1b receipt shape; BIGINT and Date convert; none is null',()=>{
  const row=V.project.row;
  assert.deepEqual(R.projectGatewayReceipt(row),V.project.expect);
  const stored={...row,seq:BigInt(row.seq),attempt:BigInt(row.attempt),successCount:BigInt(row.successCount),
    localCount:BigInt(row.localCount),receivedAt:new Date(row.receivedAt)};
  assert.deepEqual(R.projectGatewayReceipt(stored),V.project.expect);
  assert.doesNotThrow(()=>JSON.stringify(R.projectGatewayReceipt(stored)));
  assert.equal(R.projectGatewayReceipt(null),null);assert.equal(R.projectGatewayReceipt(undefined),null);
});

const GATEWAY={institution:'hallym',sub:'gw-sub',actor:'service-account-gw-hallym',roles:['gateway'],kind:'gateway'};
const MEMBER={institution:'hallym',sub:'member-sub',actor:'synthetic-admin',roles:['technician','admin'],kind:'member'};
const big=data=>({...data,seq:BigInt(data.seq),attempt:BigInt(data.attempt),successCount:BigInt(data.successCount),localCount:BigInt(data.localCount)});
function store({busy=false}={}){
  const states=new Map([['2.25.1','hallym'],['2.25.2','kin-center']]),receipts=new Map(),audits=[],log=[];let writes=0;
  const prisma={
    $transaction:async(fn,options)=>{log.push(['transaction',options]);if(busy)throw Object.assign(new Error('synthetic timeout'),{code:'P2028'});return fn(prisma);},
    $executeRaw:async strings=>{log.push(['execute',strings.join('?')]);return 0;},
    $queryRaw:async(strings,...values)=>{log.push(['lock',strings.join('?'),values]);return [{locked:1}];},
    studyState:{findUnique:async({where})=>states.has(where.uid)?{institutionId:states.get(where.uid)}:null},
    gatewayReceipt:{
      findUnique:async({where})=>receipts.has(where.studyUid)?structuredClone(receipts.get(where.studyUid)):null,
      create:async({data})=>{writes++;assert.equal(receipts.has(data.studyUid),false);receipts.set(data.studyUid,big(data));return data;},
      update:async({where,data})=>{writes++;receipts.set(where.studyUid,{...receipts.get(where.studyUid),...big(data)});return data;}},
    auditLog:{create:async({data})=>{audits.push({...data,at:new Date()});return data;},
      findFirst:async({where})=>audits.find(a=>a.action===where.action&&a.target===where.target&&a.at>=where.at.gte)??null},
  };
  return {svc:new PacsService(prisma,{},{},new StudyAccessService(prisma,{},{})),receipts,audits,log,writes:()=>writes};
}

test('S4-U3 route: gateway credentials only and a closed body, both before any store access',async()=>{
  const s=store();
  for(const caller of [MEMBER,{...GATEWAY,kind:'member'},{...GATEWAY,roles:['radiologist']},{...GATEWAY,institution:null}])
    await assert.rejects(s.svc.gatewayReceipt(body('2.25.1',1),caller),e=>e.getStatus()===403);
  for(const c of V.parse.filter(c=>!c.ok))
    await assert.rejects(s.svc.gatewayReceipt(parseBody(c),GATEWAY),
      e=>e.getStatus()===400&&e.getResponse().code==='GATEWAY_RECEIPT_INVALID'&&e.getResponse().field===c.error,c.id);
  assert.deepEqual(s.log,[]);assert.equal(s.writes(),0);assert.deepEqual(s.audits,[]);
});

test('S4-U3 route: absent and foreign are one identical 404, decided before any order rule',async()=>{
  const s=store();
  // A foreign study that even has a receipt from another epoch: deciding order first would answer 409.
  s.receipts.set('2.25.2',big({studyUid:'2.25.2',institutionId:'kin-center',epoch:OTHER_EPOCH,seq:9,phase:'sending',attempt:0,
    successCount:1,localCount:2,errorCode:null,receivedAt:new Date('2026-01-01T00:00:00.000Z')}));
  const answers=[];
  for(const uid of ['2.25.9','2.25.2'])
    await assert.rejects(s.svc.gatewayReceipt(body(uid,1),GATEWAY),e=>{answers.push([e.getStatus(),e.getResponse()]);return true;});
  assert.deepEqual(answers,[[404,{code:'GATEWAY_RECEIPT_STUDY_NOT_FOUND'}],[404,{code:'GATEWAY_RECEIPT_STUDY_NOT_FOUND'}]]);
  assert.equal(s.writes(),0);assert.deepEqual(s.audits,[]);assert.equal(s.receipts.get('2.25.2').seq,9n);
});

test('S4-U3 route: first once, replay/conflict/stale write nothing, one transition audit, server time only',async()=>{
  const s=store();const before=Date.now();
  assert.deepEqual(await s.svc.gatewayReceipt(body('2.25.1',5),GATEWAY),{studyUid:'2.25.1',result:'stored'});
  const first=structuredClone(s.receipts.get('2.25.1'));
  assert.equal(first.institutionId,'hallym');
  assert.ok(first.receivedAt instanceof Date&&first.receivedAt.getTime()>=before,'reception time is the server clock');
  assert.deepEqual(s.audits.map(a=>[a.action,a.target,a.actor]),[['gateway.receipt.first','2.25.1',GATEWAY.actor]]);
  assert.deepEqual(await s.svc.gatewayReceipt(body('2.25.1',5),GATEWAY),{studyUid:'2.25.1',result:'duplicate'});
  await assert.rejects(s.svc.gatewayReceipt(body('2.25.1',5,{successCount:4}),GATEWAY),
    e=>e.getStatus()===409&&e.getResponse().code==='GATEWAY_RECEIPT_CONFLICT');
  assert.deepEqual(await s.svc.gatewayReceipt(body('2.25.1',4,{phase:'complete',successCount:12}),GATEWAY),{studyUid:'2.25.1',result:'stale'});
  assert.deepEqual(s.receipts.get('2.25.1'),first);assert.equal(s.writes(),1);assert.equal(s.audits.length,1);
  for(const [seq,extra] of [[6,{phase:'retry',attempt:1,errorCode:'stow_http'}],[7,{phase:'complete',successCount:12}],[8,{phase:'complete',successCount:12}]])
    assert.deepEqual(await s.svc.gatewayReceipt(body('2.25.1',seq,extra),GATEWAY),{studyUid:'2.25.1',result:'stored'});
  assert.deepEqual(s.audits.map(a=>a.action),['gateway.receipt.first','gateway.receipt.transition'],'not one audit per report');
  assert.deepEqual(JSON.parse(s.audits[1].detail),{epoch:V.valid.epoch,seq:7,from:'retry',phase:'complete'});
  const last=s.receipts.get('2.25.1');
  assert.deepEqual([last.seq,last.phase,last.errorCode,last.successCount],[8n,'complete',null,12n]);
  const locks=s.log.filter(x=>x[0]==='lock');
  assert.equal(locks.length,7);assert.ok(locks.every(x=>x[2][0]==='kin.gateway-receipt:2.25.1'));
  assert.ok(s.log.filter(x=>x[0]==='transaction').every(x=>x[1].isolationLevel==='ReadCommitted'));
});

test('S4-U3 route: another epoch is refused, never stored, audited once per window; the registered epoch goes on',async()=>{
  const s=store();
  await s.svc.gatewayReceipt(body('2.25.1',5),GATEWAY);
  const kept=structuredClone(s.receipts.get('2.25.1'));
  for(const seq of [6,500,1,5]){
    await assert.rejects(s.svc.gatewayReceipt(body('2.25.1',seq,{epoch:OTHER_EPOCH,phase:'complete',successCount:12}),GATEWAY),
      e=>e.getStatus()===409&&e.getResponse().code==='GATEWAY_EPOCH_UNRECOGNISED');
    assert.deepEqual(s.receipts.get('2.25.1'),kept,'a replaced or rolled-back receipt');
  }
  const incidents=()=>s.audits.filter(a=>a.action==='gateway.receipt.epoch_unrecognised');
  assert.equal(incidents().length,1);
  assert.deepEqual(JSON.parse(incidents()[0].detail),{registeredEpoch:V.valid.epoch,offeredEpoch:OTHER_EPOCH});
  incidents()[0].at=new Date(Date.now()-V.incidentWindowMs-1000);
  await assert.rejects(s.svc.gatewayReceipt(body('2.25.1',7,{epoch:OTHER_EPOCH}),GATEWAY),e=>e.getStatus()===409);
  assert.equal(incidents().length,2,'bounded per window, not silenced for ever');
  assert.equal(s.writes(),1);
  assert.deepEqual(await s.svc.gatewayReceipt(body('2.25.1',6),GATEWAY),{studyUid:'2.25.1',result:'stored'});
  // A stored row that another institution's credentials wrote is never overwritten.
  s.receipts.set('2.25.1',{...s.receipts.get('2.25.1'),institutionId:'kin-center'});
  await assert.rejects(s.svc.gatewayReceipt(body('2.25.1',99),GATEWAY),e=>e.getStatus()===409&&e.getResponse().code==='GATEWAY_EPOCH_UNRECOGNISED');
  assert.equal(s.receipts.get('2.25.1').seq,6n);
});

test('S4-U3 route: a lock or transaction timeout is 503, which the agent keeps owed',async()=>{
  const s=store({busy:true});
  await assert.rejects(s.svc.gatewayReceipt(body('2.25.1',1),GATEWAY),e=>e.getStatus()===503&&e.getResponse().code==='GATEWAY_RECEIPT_BUSY');
});

test('S4-U3 list: only own rows carry the stored receipt; tele, stray and absent are null; nothing is written',async()=>{
  const at=new Date('2020-01-01T00:00:00.000Z');
  const STATES=[['2.25.21','hallym',null],['2.25.22','hallym',null],['2.25.23','kin-center','hallym'],['2.25.24','hallym',null]]
    .map(([uid,institutionId,teleInstitutionId])=>({uid,institutionId,teleInstitutionId,origin:'gateway',createdAt:at,rs:'W',matched:'U',orderOid:null}));
  const receipt=(uid,institutionId,epoch)=>big({studyUid:uid,institutionId,epoch,seq:9,phase:'complete',attempt:0,successCount:12,localCount:12,
    errorCode:null,receivedAt:new Date('2026-09-24T01:04:00.000Z')});
  const RECEIPTS=[receipt('2.25.21','hallym',V.valid.epoch),receipt('2.25.23','kin-center',OTHER_EPOCH),receipt('2.25.24','kin-center',OTHER_EPOCH)];
  // KIN now holds 14 of the study whose Gateway reported complete 12 of 12 (contract test 9).
  const QIDO=STATES.map(s=>({'0020000D':{Value:[s.uid]},'00080080':{Value:[s.institutionId]},'00201208':{Value:[s.uid==='2.25.21'?'14':'3']},
    '00201206':{Value:['1']},'00100020':{Value:['SYN-'+s.uid]},'00100010':{Value:['SYNTHETIC^PATIENT']}}));
  const reads=[];
  const pick=(rows,select)=>select?rows.map(r=>Object.fromEntries(Object.keys(select).map(k=>[k,r[k]]))):rows;
  const prisma={
    studyState:{findMany:async arg=>{let rows=structuredClone(STATES);const where=arg?.where;
        if(where?.uid)rows=rows.filter(s=>where.uid.in.includes(s.uid));
        else if(where?.OR)rows=rows.filter(s=>where.OR.some(c=>Object.entries(c).every(([k,v])=>s[k]===v)));
        else if(where?.institutionId)rows=rows.filter(s=>s.institutionId===where.institutionId);
        else if(where)throw new Error('unexpected where '+JSON.stringify(where));
        return pick(rows,arg?.select);},
      create:async()=>{throw new Error('no study should be created');},update:async()=>{throw new Error('no study should be changed');}},
    gatewayReceipt:{findMany:async arg=>{reads.push(structuredClone(arg));
        return structuredClone(RECEIPTS).filter(r=>arg.where.studyUid.in.includes(r.studyUid)&&r.institutionId===arg.where.institutionId);},
      create:async()=>{throw new Error('the list never writes a receipt');},update:async()=>{throw new Error('the list never writes a receipt');}},
    order:{findMany:async()=>[]},report:{findMany:async()=>[]},reportDraft:{findMany:async()=>[]},readerAssignment:{findMany:async()=>[]},
    auditLog:{create:async()=>{throw new Error('no audit expected');}},$queryRaw:async()=>[],
  };
  const orthanc={studies:async()=>structuredClone(QIDO),
    studyIdentities:async()=>structuredClone(QIDO).map(r=>({'0020000D':r['0020000D'],'00080080':r['00080080']})),
    studiesByUid:async uids=>structuredClone(QIDO).filter(r=>uids.includes(r['0020000D'].Value[0]))};
  const svc=new PacsService(prisma,orthanc,{},new StudyAccessService(prisma,orthanc,{}));
  svc.institutions=[{id:'hallym',name:'hallym'},{id:'kin-center',name:'kin-center'}];svc.prefs=async()=>({filters:[],templates:[]});
  const caller={institution:'hallym',sub:'synthetic-sub',actor:'synthetic-tech',roles:['technician'],kind:'member'};
  const r=await svc.listStudies(caller);
  const rows=Object.fromEntries(r.studies.map(s=>[s.uid,s]));
  assert.deepEqual(Object.keys(rows).sort(),['2.25.21','2.25.22','2.25.23','2.25.24']);
  assert.deepEqual(rows['2.25.21'].gatewayReceipt,{phase:'complete',successCount:12,localCount:12,attempt:0,errorCode:null,
    serverReceivedAt:'2026-09-24T01:04:00.000Z',agentSeq:9,epoch:V.valid.epoch});
  assert.equal(rows['2.25.21'].count,14,'the observation moved on; the receipt stays what the Gateway reported');
  for(const uid of ['2.25.22','2.25.23','2.25.24'])assert.equal(rows[uid].gatewayReceipt,null,uid);
  assert.deepEqual(reads.map(x=>[x.where.studyUid.in.slice().sort(),x.where.institutionId]),[[['2.25.21','2.25.22','2.25.23','2.25.24'],'hallym']]);
  assert.equal(JSON.stringify(r).includes(OTHER_EPOCH),false);
  const b=await svc.bootstrap(caller);
  assert.equal(Object.keys(b.states).length,4);
  assert.equal(JSON.stringify(b).includes('gatewayReceipt'),false);assert.equal(JSON.stringify(b).includes(V.valid.epoch),false);
  reads.length=0;
  const page=await svc.listStudies(caller,{limit:'1'});
  assert.equal(page.studies.length,1);
  assert.deepEqual(reads.map(x=>[x.where.studyUid.in,x.where.institutionId]),[[[page.studies[0].uid],'hallym']]);
});

test('S4-F01V list: an absent own study carries only its own receipt, read before the policy re-check; nothing else moves',async()=>{
  const at=new Date('2020-01-01T00:00:00.000Z'),CREATED=at.toISOString();
  // 2.25.21/22 have QIDO rows; the rest have no image. 2.25.35 is tele-received by hallym, 2.25.36 is kin-center only.
  const STATES=[['2.25.21','hallym',null,'gateway'],['2.25.22','hallym',null,'dicom'],['2.25.31','hallym',null,'gateway'],
    ['2.25.32','hallym',null,'dicom'],['2.25.33','hallym',null,'gateway'],['2.25.34','hallym',null,'gateway'],
    ['2.25.35','kin-center','hallym','gateway'],['2.25.36','kin-center',null,'gateway']]
    .map(([uid,institutionId,teleInstitutionId,origin])=>({uid,institutionId,teleInstitutionId,origin,createdAt:at,rs:'W',matched:'U',orderOid:null}));
  const receipt=(uid,institutionId,epoch,seq,phase,successCount,localCount,errorCode)=>big({studyUid:uid,institutionId,epoch,seq,phase,
    attempt:1,successCount,localCount,errorCode,receivedAt:new Date('2026-09-24T01:0'+seq+':00.000Z')});
  // 2.25.34 holds a stray receipt another institution's credentials wrote; 2.25.35/36 hold kin-center's own.
  const RECEIPTS=[receipt('2.25.21','hallym',V.valid.epoch,4,'retry',3,12,'stow_http'),
    receipt('2.25.31','hallym',V.valid.epoch,3,'failed',0,1,'instance_exceeds_budget'),
    receipt('2.25.32','hallym',V.valid.epoch,2,'retry',0,2,'stow_http'),
    receipt('2.25.34','kin-center',OTHER_EPOCH,5,'failed',0,1,'instance_exceeds_budget'),
    receipt('2.25.35','kin-center',OTHER_EPOCH,6,'retry',0,1,'stow_http'),
    receipt('2.25.36','kin-center',OTHER_EPOCH,7,'failed',0,1,'instance_exceeds_budget')];
  const QIDO=STATES.slice(0,2).map(s=>({'0020000D':{Value:[s.uid]},'00080080':{Value:[s.institutionId]},'00201208':{Value:['3']},
    '00201206':{Value:['1']},'00100020':{Value:['SYN-'+s.uid]},'00100010':{Value:['SYNTHETIC^PATIENT']}}));
  const log=[];let qido=QIDO;
  const pick=(rows,select)=>select?rows.map(r=>Object.fromEntries(Object.keys(select).map(k=>[k,r[k]]))):rows;
  const prisma={
    studyState:{findMany:async arg=>{let rows=structuredClone(STATES);const where=arg?.where;
        if(where?.uid)rows=rows.filter(s=>where.uid.in.includes(s.uid));
        else if(where?.institutionId)rows=rows.filter(s=>s.institutionId===where.institutionId);
        else if(where)throw new Error('unexpected where '+JSON.stringify(where));
        return pick(rows,arg?.select);},
      create:async()=>{throw new Error('no study should be created');},update:async()=>{throw new Error('no study should be changed');}},
    gatewayReceipt:{findMany:async arg=>{log.push(['receipt',arg.where.studyUid.in.slice(),arg.where.institutionId,Object.keys(arg.where).sort()]);
        return structuredClone(RECEIPTS).filter(r=>arg.where.studyUid.in.includes(r.studyUid)&&r.institutionId===arg.where.institutionId);},
      create:async()=>{throw new Error('the list never writes a receipt');},update:async()=>{throw new Error('the list never writes a receipt');}},
    order:{findMany:async()=>[]},report:{findMany:async()=>[]},reportDraft:{findMany:async()=>[]},readerAssignment:{findMany:async()=>[]},
    auditLog:{create:async()=>{throw new Error('no audit expected');}},
    // The access policy snapshot is the only raw read that names StudyAccessPolicy: the first and the re-check.
    $queryRaw:async strings=>{if(strings.join('?').includes('"StudyAccessPolicy"'))log.push(['policy']);return [];},
  };
  const orthanc={studies:async()=>structuredClone(qido),
    studyIdentities:async()=>structuredClone(qido).map(r=>({'0020000D':r['0020000D'],'00080080':r['00080080']})),
    studiesByUid:async uids=>structuredClone(qido).filter(r=>uids.includes(r['0020000D']?.Value?.[0]))};
  const svc=new PacsService(prisma,orthanc,{},new StudyAccessService(prisma,orthanc,{}));
  svc.institutions=[{id:'hallym',name:'hallym'},{id:'kin-center',name:'kin-center'}];
  const caller={institution:'hallym',sub:'synthetic-sub',actor:'synthetic-tech',roles:['technician'],kind:'member'};
  const projection=(phase,successCount,localCount,errorCode,seq)=>({phase,successCount,localCount,attempt:1,errorCode,
    serverReceivedAt:'2026-09-24T01:0'+seq+':00.000Z',agentSeq:seq,epoch:V.valid.epoch});
  const OWN_ABSENT=['2.25.31','2.25.32','2.25.33','2.25.34'];
  const ABSENT=[{uid:'2.25.31',origin:'gateway',createdAt:CREATED,gatewayReceipt:projection('failed',0,1,'instance_exceeds_budget',3)},
    {uid:'2.25.32',origin:'dicom',createdAt:CREATED,gatewayReceipt:projection('retry',0,2,'stow_http',2)},
    {uid:'2.25.33',origin:'gateway',createdAt:CREATED},{uid:'2.25.34',origin:'gateway',createdAt:CREATED}];
  const receiptRead=uids=>['receipt',uids,'hallym',['institutionId','studyUid']];
  // The full list and the page that completes it answer the same absence list.
  for(const query of [undefined,{limit:'100'}]){
    log.length=0;
    const r=await svc.listStudies(caller,query);
    const label=JSON.stringify(query??'full');
    // failed and retry carry the exact projection (a dicom origin too: origin is no gate); no own receipt keeps 3 keys.
    assert.deepEqual(r.notObserved,ABSENT,label);
    assert.deepEqual(r.notObserved.map(x=>Object.keys(x).sort().join()),
      ['createdAt,gatewayReceipt,origin,uid','createdAt,gatewayReceipt,origin,uid','createdAt,origin,uid','createdAt,origin,uid'],label);
    // A restored QIDO row carries its receipt as a row, never as absent; tele and foreign studies are not listed.
    const rows=Object.fromEntries(r.studies.map(s=>[s.uid,s]));
    assert.deepEqual(Object.keys(rows).sort(),['2.25.21','2.25.22'],label);
    assert.deepEqual(rows['2.25.21'].gatewayReceipt,projection('retry',3,12,'stow_http',4),label);
    assert.equal(rows['2.25.22'].gatewayReceipt,null,label);
    assert.equal(JSON.stringify(r).includes(OTHER_EPOCH),false,label);
    // One more read, pinned to hallym, holding exactly the absent own UIDs, before the policy re-check.
    assert.deepEqual(log,[['policy'],receiptRead(['2.25.21','2.25.22']),receiptRead(OWN_ABSENT),['policy']],label);
  }
  // Unknown enumeration: absence is null and there is no second receipt read.
  qido=[...QIDO,{'00080080':{Value:['hallym']}}];log.length=0;
  const unknown=await svc.listStudies(caller);
  assert.equal(unknown.notObserved,null);
  assert.deepEqual(log,[['policy'],receiptRead(['2.25.21','2.25.22']),['policy']]);
  // A page that does not complete the list: no absence key and no second receipt read.
  qido=QIDO;log.length=0;
  const first=await svc.listStudies(caller,{limit:'1'});
  assert.ok(first.pagination.next);assert.equal('notObserved' in first,false);
  assert.deepEqual(log,[['policy'],receiptRead([first.studies[0].uid]),['policy']]);
});

// TEST-S5-U6a-SERVER: the admin Gateway Status page (admin.html) reads these same GET /studies rows and Not Observed
// items; there is no admin route. An admin has no institution exception (RISK-S5-U6a-TENANT): each institution's admin
// sees only receipts its own credentials wrote on its own studies, every phase projected exactly as stored (failed keeps
// its F-01 error code for the page to name), a tele-received row and a stray receipt stay null, and nothing is written.
test('S5-U6a admin view: each institution admin sees only its own receipts, every phase as stored, absent ones too; nothing written',async()=>{
  const at=new Date('2020-01-01T00:00:00.000Z'),CREATED=at.toISOString();
  const PHASES=['pending','announcing','sending','retry','failed','complete'],CODE={retry:'stow_http',failed:'instance_exceeds_budget'};
  // hallym owns 2.25.41-46 (one receipt per phase), 2.25.47 (none), 2.25.48 (a stray receipt kin-center credentials wrote)
  // and 2.25.51/52 (no QIDO row; 51 has its own failed receipt). kin-center owns 2.25.61 and 2.25.62 (tele-read by hallym).
  const STATES=[...PHASES.map((_,i)=>['2.25.4'+(i+1),'hallym',null]),['2.25.47','hallym',null],['2.25.48','hallym',null],
    ['2.25.51','hallym',null],['2.25.52','hallym',null],['2.25.61','kin-center',null],['2.25.62','kin-center','hallym']]
    .map(([uid,institutionId,teleInstitutionId])=>({uid,institutionId,teleInstitutionId,origin:'gateway',createdAt:at,rs:'W',matched:'U',orderOid:null}));
  const minute=seq=>'2026-09-26T02:0'+seq+':00.000Z';
  const receipt=(uid,institutionId,epoch,seq,phase,successCount,localCount)=>big({studyUid:uid,institutionId,epoch,seq,phase,attempt:2,
    successCount,localCount,errorCode:CODE[phase]??null,receivedAt:new Date(minute(seq))});
  const RECEIPTS=[...PHASES.map((phase,i)=>receipt('2.25.4'+(i+1),'hallym',V.valid.epoch,i+1,phase,phase==='complete'?12:3,12)),
    receipt('2.25.48','kin-center',OTHER_EPOCH,7,'failed',0,1),receipt('2.25.51','hallym',V.valid.epoch,8,'failed',0,1),
    receipt('2.25.61','kin-center',OTHER_EPOCH,9,'retry',2,4),receipt('2.25.62','kin-center',OTHER_EPOCH,3,'sending',1,4)];
  const QIDO=STATES.filter(s=>!['2.25.51','2.25.52'].includes(s.uid)).map(s=>({'0020000D':{Value:[s.uid]},'00080080':{Value:[s.institutionId]},
    '00201208':{Value:['3']},'00201206':{Value:['1']},'00100020':{Value:['SYN-'+s.uid]},'00100010':{Value:['SYNTHETIC^PATIENT']}}));
  const reads=[];
  const pick=(rows,select)=>select?rows.map(r=>Object.fromEntries(Object.keys(select).map(k=>[k,r[k]]))):rows;
  const prisma={
    studyState:{findMany:async arg=>{let rows=structuredClone(STATES);const where=arg?.where;
        if(where?.uid)rows=rows.filter(s=>where.uid.in.includes(s.uid));
        else if(where?.institutionId)rows=rows.filter(s=>s.institutionId===where.institutionId);
        else if(where)throw new Error('unexpected where '+JSON.stringify(where));
        return pick(rows,arg?.select);},
      create:async()=>{throw new Error('no study should be created');},update:async()=>{throw new Error('no study should be changed');}},
    gatewayReceipt:{findMany:async arg=>{reads.push([arg.where.studyUid.in.slice().sort(),arg.where.institutionId,Object.keys(arg.where).sort()]);
        return structuredClone(RECEIPTS).filter(r=>arg.where.studyUid.in.includes(r.studyUid)&&r.institutionId===arg.where.institutionId);},
      create:async()=>{throw new Error('the list never writes a receipt');},update:async()=>{throw new Error('the list never writes a receipt');}},
    order:{findMany:async()=>[]},report:{findMany:async()=>[]},reportDraft:{findMany:async()=>[]},readerAssignment:{findMany:async()=>[]},
    auditLog:{create:async()=>{throw new Error('no audit expected');}},$queryRaw:async()=>[],
  };
  const orthanc={studies:async()=>structuredClone(QIDO),
    studyIdentities:async()=>structuredClone(QIDO).map(r=>({'0020000D':r['0020000D'],'00080080':r['00080080']})),
    studiesByUid:async uids=>structuredClone(QIDO).filter(r=>uids.includes(r['0020000D'].Value[0]))};
  const svc=new PacsService(prisma,orthanc,{},new StudyAccessService(prisma,orthanc,{}));
  svc.institutions=[{id:'hallym',name:'hallym'},{id:'kin-center',name:'kin-center'}];
  const admin=institution=>({institution,sub:'synthetic-admin-'+institution,actor:'synthetic-admin-'+institution,roles:['admin'],kind:'member'});
  const projection=(phase,successCount,localCount,seq,epoch)=>({phase,successCount,localCount,attempt:2,errorCode:CODE[phase]??null,
    serverReceivedAt:minute(seq),agentSeq:seq,epoch});
  const keys=['institutionId','studyUid'];

  const own=await svc.listStudies(admin('hallym'));
  const rows=Object.fromEntries(own.studies.map(s=>[s.uid,s]));
  assert.deepEqual(Object.keys(rows).sort(),['2.25.41','2.25.42','2.25.43','2.25.44','2.25.45','2.25.46','2.25.47','2.25.48','2.25.62']);
  PHASES.forEach((phase,i)=>assert.deepEqual(rows['2.25.4'+(i+1)].gatewayReceipt,
    projection(phase,phase==='complete'?12:3,12,i+1,V.valid.epoch),phase));
  for(const uid of ['2.25.47','2.25.48','2.25.62'])assert.equal(rows[uid].gatewayReceipt,null,uid);
  assert.equal(rows['2.25.62'].tele,true);
  assert.deepEqual(own.notObserved,[{uid:'2.25.51',origin:'gateway',createdAt:CREATED,gatewayReceipt:projection('failed',0,1,8,V.valid.epoch)},
    {uid:'2.25.52',origin:'gateway',createdAt:CREATED}]);
  assert.equal(JSON.stringify(own).includes(OTHER_EPOCH),false,'no receipt another institution wrote reaches the hallym admin');
  assert.deepEqual(reads,[[['2.25.41','2.25.42','2.25.43','2.25.44','2.25.45','2.25.46','2.25.47','2.25.48','2.25.62'],'hallym',keys],
    [['2.25.51','2.25.52'],'hallym',keys]]);

  reads.length=0;
  const other=await svc.listStudies(admin('kin-center'));
  const otherRows=Object.fromEntries(other.studies.map(s=>[s.uid,s]));
  assert.deepEqual(Object.keys(otherRows).sort(),['2.25.61','2.25.62']);
  assert.deepEqual(otherRows['2.25.61'].gatewayReceipt,projection('retry',2,4,9,OTHER_EPOCH));
  assert.deepEqual(otherRows['2.25.62'].gatewayReceipt,projection('sending',1,4,3,OTHER_EPOCH),'the owner sees its own receipt on a study it sent out');
  assert.deepEqual(other.notObserved,[]);
  // The receipt its credentials wrote on hallym's 2.25.48 is not its study either: nothing of it is listed.
  for(const needle of [V.valid.epoch,'2.25.48','2.25.51'])assert.equal(JSON.stringify(other).includes(needle),false,needle);
  assert.deepEqual(reads,[[['2.25.61','2.25.62'],'kin-center',keys]]);
});
