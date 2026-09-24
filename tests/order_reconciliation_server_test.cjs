// TEST-S4-U2-ORDER-RECONCILIATION server: the compiled rule against the shared vectors, then the real
// compiled PacsService.listStudies over a fake database/Orthanc (tenant pin, tele exclusion, restricted
// caller, seed, completing page only, failure and ordering). Runs inside kin-api:ci; no network.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');const {join}=require('node:path');
const {accessionRelation,reconcileOrders,ORDER_RECONCILIATION_SOURCE}=require('/app/dist/order-reconciliation');
const {PacsService}=require('/app/dist/pacs.service');
const {StudyAccessService}=require('/app/dist/study-access.service');
const V=JSON.parse(readFileSync(join(__dirname,'order_reconciliation_vectors.json'),'utf8'));
const row=(uid,acc)=>({'0020000D':{Value:[uid]},'00080050':{Value:[acc]}});

test('S4-U2 compiled accession relation is three-valued',()=>{
  for(const c of V.accession)assert.equal(accessionRelation(c.order,c.study),c.expect,c.name);
  assert.equal(ORDER_RECONCILIATION_SOURCE,V.source);
});

test('S4-U2 compiled reconcileOrders matches every shared vector',()=>{
  for(const c of V.reconcile){
    const observed=new Map(Object.entries(c.observed).map(([uid,acc])=>[uid,row(uid,acc)]));
    const got=reconcileOrders({me:c.me,restricted:c.restricted,orders:structuredClone(c.orders),links:structuredClone(c.links),observed,
      accessionOf:r=>r['00080050'].Value[0],permitted:uid=>!c.restricted||c.permitted.includes(uid)});
    assert.deepEqual(got,{source:V.source,orders:c.expect},c.name);
  }
});

const caller={institution:'hallym',sub:'synthetic-sub',actor:'synthetic-tech',roles:['technician'],kind:'member'};
const STATES=[
  {uid:'2.25.11',institutionId:'hallym',teleInstitutionId:null,origin:'dicom',createdAt:new Date('2020-01-01T00:00:00.000Z'),rs:'W',matched:'U',orderOid:null},
  {uid:'2.25.12',institutionId:'kin-center',teleInstitutionId:null,origin:'dicom',createdAt:new Date('2020-01-01T00:00:00.000Z'),rs:'W',matched:'U',orderOid:null},
  {uid:'2.25.13',institutionId:'kin-center',teleInstitutionId:'hallym',origin:'dicom',createdAt:new Date('2020-01-01T00:00:00.000Z'),rs:'W',matched:'U',orderOid:null},
  {uid:'2.25.14',institutionId:'hallym',teleInstitutionId:null,origin:'gateway',createdAt:new Date('2020-01-01T00:00:00.000Z'),rs:'W',matched:'M',orderOid:'SYN-H-L'}];
const ORDERS=[
  {oid:'O-9001',institutionId:'hallym',patientId:'P-1001',name:'KIM CHULSOO',sched:'2026-09-24 09:10',accession:null,matched:'U',studyUid:null},
  {oid:'SYN-H-1',institutionId:'hallym',patientId:'SYN-P1',name:'SYNTHETIC PATIENT',sched:'x',accession:'SYN-ACC-1',matched:'U',studyUid:null},
  {oid:'SYN-H-2',institutionId:'hallym',patientId:'SYN-P2',name:'SYNTHETIC PATIENT',sched:'x',accession:'SYN-ACC-2',matched:'U',studyUid:null},
  {oid:'SYN-H-L',institutionId:'hallym',patientId:'SYN-P3',name:'SYNTHETIC PATIENT',sched:'x',accession:null,matched:'M',studyUid:'2.25.14'},
  {oid:'SYN-K-1',institutionId:'kin-center',patientId:'SYN-P4',name:'SYNTHETIC PATIENT',sched:'x',accession:'SYN-ACC-1',matched:'U',studyUid:null}];
const QIDO=[['2.25.11','hallym','SYN-ACC-1'],['2.25.12','kin-center','SYN-ACC-1'],['2.25.13','kin-center','SYN-ACC-2']]
  .map(([uid,inst,acc])=>({'0020000D':{Value:[uid]},'00080080':{Value:[inst]},'00080050':{Value:[acc]},'00100020':{Value:['SYN-'+uid]},'00100010':{Value:['SYNTHETIC^PATIENT']}}));
const project=(rows,select)=>select?rows.map(r=>Object.fromEntries(Object.keys(select).map(k=>[k,r[k]]))):rows;
function setup({policies=()=>[],qido=QIDO,studies}={}){
  const seq=[],identityArgs=[];let policyReads=0;
  const prisma={
    studyState:{findMany:async arg=>{seq.push('state');let rows=structuredClone(STATES);
      if(arg?.where?.uid)rows=rows.filter(s=>arg.where.uid.in.includes(s.uid));
      else if(arg?.where?.institutionId)rows=rows.filter(s=>s.institutionId===arg.where.institutionId);
      else if(arg?.where)throw new Error('unexpected where '+JSON.stringify(arg.where));
      return project(rows,arg?.select);},
      create:async()=>{throw new Error('no study should be created');},update:async()=>{throw new Error('no study should be changed');}},
    order:{findMany:async arg=>{seq.push('order');const rows=structuredClone(ORDERS).filter(o=>o.institutionId===arg.where.institutionId);return project(rows,arg.select);}},
    report:{findMany:async()=>[]},reportDraft:{findMany:async()=>[]},readerAssignment:{findMany:async()=>[]},gatewayReceipt:{findMany:async()=>[]},
    auditLog:{create:async()=>{throw new Error('no audit expected');}},
    $queryRaw:async(strings)=>{const sql=strings.join('?');if(sql.includes('StudyAccessPolicy')){seq.push('policy');return policies(++policyReads);}return [];},
  };
  const orthanc={studies:studies||(async()=>structuredClone(qido)),
    studyIdentities:async(...args)=>{identityArgs.push(args);return structuredClone(qido).map(r=>({'0020000D':r['0020000D'],'00080080':r['00080080'],...(args[1]?{'00080050':r['00080050']}:{})}));},
    studiesByUid:async uids=>structuredClone(qido).filter(r=>uids.includes(r['0020000D'].Value[0]))};
  const svc=new PacsService(prisma,orthanc,{},new StudyAccessService(prisma,orthanc,{}));
  svc.institutions=[{id:'hallym',name:'hallym'},{id:'kin-center',name:'kin-center'}];svc.prefs=async()=>({filters:[],templates:[]});
  return {svc,seq,identityArgs};
}
const HALLYM=[
  {oid:'O-9001',link:'unlinked',accession:'absent',candidates:[]},
  {oid:'SYN-H-1',link:'unlinked',accession:'present',candidates:['2.25.11']},
  {oid:'SYN-H-2',link:'unlinked',accession:'present',candidates:[]},
  {oid:'SYN-H-L',link:'not_observed',studyUid:'2.25.14'}];

test('S4-U2 full list: own tenant only, tele-received never pairs, seed not comparable, no patient field leaves',async()=>{
  const {svc,seq}=setup();const r=await svc.listStudies(caller);
  assert.deepEqual(r.orderReconciliation,{source:'engineering_only',orders:HALLYM});
  const text=JSON.stringify(r.orderReconciliation);
  for(const leak of ['SYN-K-1','2.25.12','2.25.13','SYN-ACC','SYNTHETIC PATIENT','KIM CHULSOO','09:10','P-1001'])assert.ok(!text.includes(leak),leak);
  assert.ok(seq.lastIndexOf('order')<seq.lastIndexOf('policy'),'the order side is read before the access re-check');
  assert.deepEqual(r.notObserved.map(x=>x.uid),['2.25.14']);
});

test('S4-U2 paged list: only the completing page carries the answer; the enumeration asks for the accession',async()=>{
  const {svc,identityArgs,seq}=setup();
  const first=await svc.listStudies(caller,{limit:'1'});
  assert.ok(first.pagination.next);assert.equal('orderReconciliation' in first,false);assert.equal('notObserved' in first,false);
  assert.equal(seq.includes('order'),false,'no order read on a page that does not complete the list');
  const last=await svc.listStudies(caller,{limit:'1',after:first.pagination.next});
  assert.equal(last.pagination.next,null);assert.deepEqual(last.orderReconciliation,{source:'engineering_only',orders:HALLYM});
  assert.deepEqual(identityArgs,[[false,true],[false,true]]);
});

test('S4-U2 restricted caller receives zero unlinked orders and zero candidates',async()=>{
  const policy={version:1,restricted:true,startsAt:null,endsAt:null,rules:[{patientId:null,modalities:[],dateFrom:null,dateTo:null,studyUids:['2.25.11','2.25.14']}]};
  const {svc}=setup({policies:()=>[{institution:'hallym',revision:1,policy,reason:'SYNTHETIC',updatedBy:null,updatedAt:null}]});
  for(const query of [undefined,{limit:'100'}]){
    const r=await svc.listStudies(caller,query);
    assert.deepEqual(r.orderReconciliation,{source:'engineering_only',orders:[{oid:'SYN-H-L',link:'not_observed',studyUid:'2.25.14'}]});
  }
  const other=setup().svc;const ktech={...caller,institution:'kin-center'};
  const k=await other.listStudies(ktech);
  assert.deepEqual(k.orderReconciliation.orders,[{oid:'SYN-K-1',link:'unlinked',accession:'present',candidates:['2.25.12']}]);
});

test('S4-U2 failures: no answer without a successful enumeration; an unidentifiable row makes it unknown; policy change refuses',async()=>{
  const failing=setup({studies:async()=>{throw Object.assign(new Error('Orthanc HTTP 503'),{getStatus:()=>503});}});
  await assert.rejects(failing.svc.listStudies(caller));assert.equal(failing.seq.includes('order'),false);
  const partial=setup({qido:[...QIDO,{'00080080':{Value:['hallym']},'00080050':{Value:['SYN-ACC-1']}}]});
  const r=await partial.svc.listStudies(caller);assert.equal(r.orderReconciliation,null);assert.equal(r.notObserved,null);
  const policy={version:1,restricted:true,startsAt:null,endsAt:null,rules:[{patientId:null,modalities:[],dateFrom:null,dateTo:null,studyUids:['2.25.11']}]};
  const changed=setup({policies:n=>n===1?[]:[{institution:'hallym',revision:1,policy,reason:'SYNTHETIC',updatedBy:null,updatedAt:null}]});
  await assert.rejects(changed.svc.listStudies(caller),e=>e.getStatus()===409);
});

test('S4-U2 bootstrap order payload is unchanged: no accession leaves through it',async()=>{
  const {svc}=setup();const b=await svc.bootstrap(caller,{states:'omit'});
  for(const o of b.orders)assert.deepEqual(Object.keys(o).sort(),['birth','desc','id','matched','modality','name','oid','reqDoc','sched','sex','studyUid','ward']);
});
