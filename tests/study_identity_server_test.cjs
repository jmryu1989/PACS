// TEST-S4-U5-STUDY-IDENTITY server (review M-2): the compiled rule dist/study-identity.js runs EVERY shared vector
// through the real OrthancService.tag, then the compiled PacsService.listStudies runs over a fake database/Orthanc
// (tenant pin, tele exclusion, pair back-pointer, restricted caller, paged = full, failure, policy change, no Order
// value in the answer, bootstrap unchanged, no write). Runs inside kin-api:ci with no network; no DB, no Orthanc.
// At b6a317c dist/study-identity.js does not exist and list rows carry no orderIdentity, so every case fails there.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');const {join}=require('node:path');
const {orderIdentity,overlayShape,ORDER_IDENTITY_SELECT,OVERLAY_KEYS}=require('/app/dist/study-identity');
const {OrthancService}=require('/app/dist/orthanc.service');
const {PacsService}=require('/app/dist/pacs.service');
const {StudyAccessService}=require('/app/dist/study-access.service');
const V=JSON.parse(readFileSync(join(__dirname,'study_identity_vectors.json'),'utf8'));
const KEYS=['accession','birth','oid','patientId','patientName','sex','source'];

test('S4-U5 compiled rule: every relation vector through the real tag reader; the other fields stay not comparable',()=>{
  const study={uid:'2.25.901',institutionId:'hallym',matched:'M',orderOid:'SYN-U5-V'};
  assert.ok(V.relations.length>=30);
  for(const c of V.relations){
    const spec=V.fields[c.field];
    const order={oid:'SYN-U5-V',institutionId:'hallym',studyUid:'2.25.901',matched:'M',accession:null,patientId:'',name:'',birth:'',sex:''};
    order[spec.order]=c.order;
    const st={'0020000D':{Value:['2.25.901']}};
    if(c.dicomElement)st[spec.tag]=structuredClone(c.dicomElement);
    else if(c.dicom!==null)st[spec.tag]=spec.vr==='PN'?{vr:'PN',Value:[{Alphabetic:c.dicom}]}:{vr:spec.vr,Value:[c.dicom]};
    const got=orderIdentity('hallym',study,order,key=>OrthancService.tag(st,key));
    assert.deepEqual(Object.keys(got).sort(),KEYS,c.id);
    assert.equal(got.source,'engineering_only');assert.equal(got.oid,'SYN-U5-V');
    assert.equal(got[c.field],c.expect,c.id+' ('+c.why+')');
    for(const other of Object.keys(V.fields))if(other!==c.field)assert.equal(got[other],'not_comparable',c.id+':'+other);
  }
});

test('S4-U5 compiled pair guard: only an own-institution study and order that point at each other are related',()=>{
  const study={uid:'2.25.901',institutionId:'hallym',matched:'M',orderOid:'SYN-U5-V'};
  const order={oid:'SYN-U5-V',institutionId:'hallym',studyUid:'2.25.901',matched:'M',accession:'A',patientId:'P',name:'N',birth:'1980-01-01',sex:'M'};
  const tag=()=>'';
  assert.ok(orderIdentity('hallym',study,order,tag));
  for(const [name,s,o,me] of [
    ['study other institution',{...study,institutionId:'kin-center'},order,'hallym'],
    ['study not matched',{...study,matched:'U'},order,'hallym'],
    ['study without order',{...study,orderOid:null},order,'hallym'],
    ['order missing',study,undefined,'hallym'],
    ['order is another oid',study,{...order,oid:'SYN-U5-W'},'hallym'],
    ['order other institution',study,{...order,institutionId:'kin-center'},'hallym'],
    ['order not matched',study,{...order,matched:'U'},'hallym'],
    ['order points elsewhere',study,{...order,studyUid:'2.25.902'},'hallym'],
    ['caller other institution',study,order,'kin-center']])
    assert.equal(orderIdentity(me,s,o,tag),null,name);
  assert.deepEqual(Object.keys(ORDER_IDENTITY_SELECT).sort(),['accession','birth','institutionId','matched','name','oid','patientId','sex','studyUid']);
});

test('S4-U5 compiled overlay shape (M-1/N-1): every shared overlay vector',()=>{
  assert.deepEqual([...OVERLAY_KEYS],['id','name','sex','birth','age','desc','ward','date','acc','modality']);
  for(const c of V.overlay)assert.equal(overlayShape(c.value),c.expect,c.id);
  assert.equal(overlayShape(undefined),false);
  assert.equal(overlayShape(Object.create(null)),false,'only plain JSON objects');
});

// ── the real list path over a fake store ──
const caller={institution:'hallym',sub:'synthetic-sub',actor:'synthetic-tech',roles:['technician'],kind:'member'};
const at=new Date('2020-01-01T00:00:00.000Z');
const S=(uid,institutionId,matched,orderOid,extra={})=>({uid,institutionId,teleInstitutionId:null,origin:'dicom',createdAt:at,
  rs:'W',ss:'Verified',em:'N',ts:'none',ward:'',reqHosp:'x',matched,orderOid,preDoc:null,preReviewer:null,ov:null,orig:null,...extra});
const STATES=[
  // A forged overlay and a client-claimed original: neither may change the relation or the row values.
  S('2.25.51','hallym','M','SYN-U5-E',{ov:JSON.stringify({id:'FORGED-ID',name:'FORGED NAME',birth:'19990909',sex:'F',acc:'FORGED-ACC',desc:'FORGED'}),
    orig:JSON.stringify({id:'FORGED-ORIG',name:'FORGED ORIG'})}),
  S('2.25.52','hallym','M','SYN-U5-X'),                                   // legacy link to a kin-center order
  S('2.25.53','kin-center','M','SYN-U5-K',{teleInstitutionId:'hallym'}),  // tele-received by hallym
  S('2.25.54','hallym','M','SYN-U5-B'),                                   // the order points at another study
  S('2.25.55','hallym','M','SYN-U5-U'),                                   // the order says unmatched
  S('2.25.56','hallym','U',null),
  S('2.25.57','hallym','M','SYN-U5-D'),                                   // absent and Ideographic-only tags
  S('2.25.58','hallym','M','SYN-U5-M')];                                  // every field differs
const O=(oid,institutionId,studyUid,fields,matched='M')=>({oid,institutionId,studyUid,matched,accession:null,patientId:'',name:'',sex:'',
  birth:'',sched:'x',modality:'CT',descr:'SYNTHETIC',ward:'',reqDoc:'',...fields});
const SAME=(n)=>({accession:'SYN-ACC-'+n,patientId:'SYN-P-'+n,name:'SYNTHETIC PATIENT',birth:'1980-01-01',sex:'M'});
const ORDERS=[
  O('SYN-U5-E','hallym','2.25.51',SAME(51)),
  O('SYN-U5-X','kin-center','2.25.52',SAME(52)),
  O('SYN-U5-K','kin-center','2.25.53',SAME(53)),
  O('SYN-U5-B','hallym','2.25.99',SAME(54)),
  O('SYN-U5-U','hallym',null,SAME(55),'U'),
  O('SYN-U5-D','hallym','2.25.57',{...SAME(57),accession:null}),
  O('SYN-U5-M','hallym','2.25.58',{accession:'ORDER-ONLY-ACC',patientId:'00123',name:'ORDER ONLY NAME',birth:'1962-02-28',sex:'F'})];
const val=v=>({Value:[v]}),pn=v=>({vr:'PN',Value:[{Alphabetic:v}]});
const Q=(uid,inst,tags)=>({'0020000D':val(uid),'00080080':val(inst),'00080020':val('20260925'),'00081030':val('SYNTHETIC CT'),
  '00080061':{Value:['CT']},...tags});
const QT=n=>({'00080050':val('SYN-ACC-'+n),'00100020':val('SYN-P-'+n),'00100010':pn('SYNTHETIC^PATIENT'),'00100030':val('19800101'),'00100040':val('M')});
const QIDO=[Q('2.25.51','hallym',QT(51)),Q('2.25.52','hallym',QT(52)),Q('2.25.53','kin-center',QT(53)),Q('2.25.54','hallym',QT(54)),
  Q('2.25.55','hallym',QT(55)),Q('2.25.56','hallym',QT(56)),
  Q('2.25.57','hallym',{'00080050':val('SYN-ACC-57'),'00100020':val('SYN-P-57'),'00100010':{vr:'PN',Value:[{Ideographic:'合成'}]}}),
  Q('2.25.58','hallym',{'00080050':val('SYN-ACC-58'),'00100020':val('123'),'00100010':pn('SYNTHETIC^PATIENT'),'00100030':val('19620301'),'00100040':val('M')})];
const rel=(oid,a,p,n,b,s)=>({source:'engineering_only',oid,accession:a,patientId:p,patientName:n,birth:b,sex:s});
const EXPECT={
  '2.25.51':rel('SYN-U5-E','match','match','match','match','match'),
  '2.25.52':null,'2.25.53':null,'2.25.54':null,'2.25.55':null,'2.25.56':null,
  '2.25.57':rel('SYN-U5-D','not_comparable','match','not_comparable','not_comparable','not_comparable'),
  '2.25.58':rel('SYN-U5-M','mismatch','mismatch','mismatch','mismatch','mismatch')};
const project=(rows,select)=>select?rows.map(r=>Object.fromEntries(Object.keys(select).map(k=>[k,r[k]]))):rows;
function setup({policies=()=>[],studies}={}){
  const seq=[],identityReads=[];let policyReads=0;
  const refuse=what=>async()=>{throw new Error('the list must not write: '+what);};
  const prisma={
    studyState:{findMany:async arg=>{seq.push('state');let rows=structuredClone(STATES);const where=arg?.where;
        if(where?.uid)rows=rows.filter(s=>where.uid.in.includes(s.uid));
        else if(where?.institutionId)rows=rows.filter(s=>s.institutionId===where.institutionId);
        else if(where)throw new Error('unexpected where '+JSON.stringify(where));
        return project(rows,arg?.select);},
      create:refuse('studyState.create'),update:refuse('studyState.update'),updateMany:refuse('studyState.updateMany'),delete:refuse('studyState.delete')},
    order:{findMany:async arg=>{const where=arg.where;let rows=structuredClone(ORDERS).filter(o=>o.institutionId===where.institutionId);
        if(where.oid){seq.push('identity');identityReads.push(structuredClone(arg));rows=rows.filter(o=>where.oid.in.includes(o.oid));}
        else seq.push('order');
        return project(rows,arg.select);},
      update:refuse('order.update'),updateMany:refuse('order.updateMany'),create:refuse('order.create')},
    report:{findMany:async()=>[]},reportDraft:{findMany:async()=>[]},readerAssignment:{findMany:async()=>[]},gatewayReceipt:{findMany:async()=>[]},
    auditLog:{create:refuse('auditLog.create')},
    $queryRaw:async(strings)=>{const sql=strings.join('?');if(sql.includes('StudyAccessPolicy')){seq.push('policy');return policies(++policyReads);}return [];},
  };
  const orthanc={studies:studies||(async()=>structuredClone(QIDO)),
    studyIdentities:async(...args)=>structuredClone(QIDO).map(r=>({'0020000D':r['0020000D'],'00080080':r['00080080'],...(args[1]?{'00080050':r['00080050']??val('')}:{})})),
    studiesByUid:async uids=>uids.map(uid=>structuredClone(QIDO).find(r=>r['0020000D'].Value[0]===uid))};
  const svc=new PacsService(prisma,orthanc,{},new StudyAccessService(prisma,orthanc,{}));
  svc.institutions=[{id:'hallym',name:'hallym'},{id:'kin-center',name:'kin-center'}];svc.prefs=async()=>({filters:[],templates:[]});
  return {svc,seq,identityReads,prisma};
}
async function pages(svc,user=caller){
  const rows=[];let after;
  for(let i=0;i<20;i++){
    const r=await svc.listStudies(user,after?{limit:'1',after}:{limit:'1'});
    rows.push(...r.studies);
    if(r.pagination.next===null)return rows;
    after=r.pagination.next;
  }
  throw new Error('the paged list did not end');
}
const byUid=rows=>Object.fromEntries(rows.map(r=>[r.uid,r.orderIdentity]));
const RESTRICTED={version:1,restricted:true,startsAt:null,endsAt:null,rules:[{patientId:null,modalities:[],dateFrom:null,dateTo:null,studyUids:['2.25.51','2.25.58']}]};

test('S4-U5 full list (a,b,c,e,f): server-read tags only, own pair only, forged ov/orig are not inputs, no Order value leaves',async()=>{
  const {svc,seq,identityReads}=setup();
  const r=await svc.listStudies(caller);
  assert.deepEqual(byUid(r.studies),EXPECT);
  const row=r.studies.find(s=>s.uid==='2.25.51');
  assert.deepEqual([row.acc,row.id,row.name,row.birth,row.sex],['SYN-ACC-51','SYN-P-51','SYNTHETIC PATIENT','19800101','M']);
  assert.equal(row.state.ov.id,'FORGED-ID','the overlay is still relayed as stored; it is simply not an input');
  // One identity read, pinned to the caller's institution, for the own linked rows only (never the tele row's order).
  assert.equal(identityReads.length,1);
  assert.deepEqual(identityReads[0].where.institutionId,'hallym');
  assert.deepEqual([...identityReads[0].where.oid.in].sort(),['SYN-U5-B','SYN-U5-D','SYN-U5-E','SYN-U5-M','SYN-U5-U','SYN-U5-X']);
  assert.deepEqual(identityReads[0].select,ORDER_IDENTITY_SELECT);
  assert.ok(seq.indexOf('identity')<seq.lastIndexOf('policy'),'read before the access re-check');
  // Values that exist only on the Order side (row 58 differs everywhere) must not appear anywhere in the answer.
  const text=JSON.stringify(r);
  for(const leak of ['"00123"','ORDER-ONLY-ACC','ORDER ONLY NAME','1962-02-28'])assert.ok(!text.includes(leak),leak);
  for(const s of r.studies)if(s.orderIdentity)assert.deepEqual(Object.keys(s.orderIdentity).sort(),KEYS);
});

test('S4-U5 paged list (a): every page carries the same relation as the full list',async()=>{
  const {svc,identityReads}=setup();
  const rows=await pages(svc);
  assert.deepEqual(byUid(rows),EXPECT);
  assert.ok(identityReads.every(read=>read.where.institutionId==='hallym'&&read.where.oid.in.length<=1));
  assert.equal(identityReads.length,6,'one bounded read per page that holds an own linked row');
});

test('S4-U5 restricted caller (d): relations only on permitted rows, no candidates key; unrestricted control',async()=>{
  const policy=[{institution:'hallym',revision:1,policy:RESTRICTED,reason:'SYNTHETIC',updatedBy:null,updatedAt:null}];
  for(const paged of [false,true]){
    const {svc,identityReads}=setup({policies:()=>policy});
    const rows=paged?await pages(svc):(await svc.listStudies(caller)).studies;
    assert.deepEqual(byUid(rows),{'2.25.51':EXPECT['2.25.51'],'2.25.58':EXPECT['2.25.58']},'paged='+paged);
    assert.ok(!JSON.stringify(rows.map(s=>s.orderIdentity)).includes('candidates'));
    assert.deepEqual([...new Set(identityReads.flatMap(read=>read.where.oid.in))].sort(),['SYN-U5-E','SYN-U5-M']);
  }
  const control=await setup().svc.listStudies({...caller,sub:'synthetic-other'});
  assert.equal(Object.keys(byUid(control.studies)).length,8);
});

test('S4-U5 failures (f,g): no relation without a successful enumeration; a policy change refuses the whole answer',async()=>{
  const failing=setup({studies:async()=>{throw Object.assign(new Error('Orthanc HTTP 503'),{getStatus:()=>503});}});
  await assert.rejects(failing.svc.listStudies(caller));
  assert.equal(failing.identityReads.length,0);
  const changed=setup({policies:n=>n===1?[]:[{institution:'hallym',revision:1,policy:RESTRICTED,reason:'SYNTHETIC',updatedBy:null,updatedAt:null}]});
  await assert.rejects(changed.svc.listStudies(caller),e=>e.getStatus()===409);
  assert.equal(changed.identityReads.length,1,'the relation was computed and still not sent');
});

test('S4-U5 bootstrap (h) is unchanged: no relation and the same order keys; the list never wrote (i)',async()=>{
  const {svc}=setup();
  const b=await svc.bootstrap(caller,{states:'omit'});
  for(const o of b.orders)assert.deepEqual(Object.keys(o).sort(),['birth','desc','id','matched','modality','name','oid','reqDoc','sched','sex','studyUid','ward']);
  assert.ok(!JSON.stringify(b).includes('orderIdentity'));
  // Every write method of the fake store throws, so the lists above, which completed, called none of them. The trap is live:
  const {prisma}=setup();
  for(const write of [prisma.studyState.update,prisma.studyState.create,prisma.order.update,prisma.order.updateMany,prisma.auditLog.create])
    await assert.rejects(write({}),/the list must not write/);
});
