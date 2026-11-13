// REQ-S7-U3b-HOSPITAL-COLUMN -> RISK-S7-U3b-PREF-BREAK / RISK-S7-U3b-TELE-MISLABEL
// -> TEST-S7-U3b-COLUMNS (server half: sc01-sc04) and TEST-S7-U3b-ROWS (sc05).
// Runs inside kin-api:ci with no network, no DB and no Orthanc: the compiled normalizer over the shared pre-unit documents
// (tests/worklist_columns_vectors.json, expectations written by hand), the compiled PacsService column read/write over a fake
// store (a stored pre-unit row is answered with Hospital added and never rewritten by the read; an old client's PUT is
// stored with it; refusals and conflicts as before), and the compiled PacsService.listStudies over a fake store whose
// registry names differ from the ids, so a row showing an id, the caller's name or a guessed tele fails.
// KIN_WORKLIST_COLUMNS_SERVER names the compiled module directory (default /app/dist); only the local mutant runs point it
// at a copied directory. After the last case the /app/dist modules this file loaded are printed as CI evidence (the NEW-2
// record-run --file list is checked against them); that print is not an assertion.
const {test,after}=require('node:test');const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');const {join}=require('node:path');
const DIST=(process.env.KIN_WORKLIST_COLUMNS_SERVER||'/app/dist').replace(/\/+$/,'');
const {normalizeWorklistColumns}=require(DIST+'/worklist-columns');
const {PacsService}=require(DIST+'/pacs.service');
const {StudyAccessService}=require(DIST+'/study-access.service');
const V=JSON.parse(readFileSync(join(__dirname,'worklist_columns_vectors.json'),'utf8'));
const byId=Object.fromEntries([...V.accepted,...V.refused,...V.idempotent].map(v=>[v.id,v]));
const clone=value=>JSON.parse(JSON.stringify(value));
const status=error=>typeof error?.getStatus==='function'?error.getStatus():null;

const caller={institution:'hallym',sub:'syn-sub-a',actor:'syn-reader-a@synthetic.test',roles:['radiologist'],kind:'member'};
const OWNER={institution:'hallym',subject:'syn-sub-a'};

test('sc01 the compiled normalizer keeps every pre-unit document and shows Hospital last in Radiology only',()=>{
  for(const v of V.accepted){
    const before=JSON.stringify(v.document);
    assert.deepEqual(normalizeWorklistColumns(clone(v.document)),v.expect,v.id+': '+v.why);
    assert.equal(JSON.stringify(v.document),before,v.id+' input untouched');
    assert.deepEqual(normalizeWorklistColumns(clone(v.document)).modes.Technician.order,v.expect.modes.Technician.order,v.id+' Technician');
  }
  // Preserving pair: another permutation of the stored order stays that permutation, Hospital after it; the request columns
  // join right after Name and Confirm right after RS wherever the user put those two.
  const permuted=clone(byId.V02.document);permuted.modes.Radiology.order.reverse();
  assert.deepEqual(normalizeWorklistColumns(permuted).modes.Radiology.order,[...clone(byId.V02.document).modes.Radiology.order].reverse()
    .flatMap(k=>k==='name'?['name','reqDate','reqDept','reqDoc','ptClass']:k==='rs'?['rs','confirm']:[k]).concat('institutionName','time'));
  // PF-10: both modes with every key at the widest width and all but ID and Name hidden still fit the 8192 bound.
  const widest=mode=>{const keys=byId.V01.expect.modes[mode].order;
    return {order:[...keys],hidden:keys.filter(k=>k!=='id'&&k!=='name'),appearance:{widths:Object.fromEntries(keys.map(k=>[k,600])),font:'mono',size:20,color:'warm'}};};
  const wide={version:1,modes:{Radiology:widest('Radiology'),Technician:widest('Technician')}};
  assert.ok(JSON.stringify(wide).length<=8192,String(JSON.stringify(wide).length));
  assert.deepEqual(normalizeWorklistColumns(clone(wide)),wide);
  // A synthetic document over the bound is refused whole (no valid-key document can reach it: 29 keys at most).
  const big=clone(byId.V01.document);big.modes.Radiology.appearance={widths:Object.fromEntries(Array.from({length:1000},(_,i)=>['k'+i,64])),font:'default',size:13,color:'default'};
  assert.ok(JSON.stringify(big).length>8192);assert.equal(normalizeWorklistColumns(big),null,'over the 8192 bound');
});

test('sc02 refused documents stay refused whole; a document that already places Hospital keeps that place',()=>{
  for(const v of V.refused)assert.equal(normalizeWorklistColumns(clone(v.document)),null,v.id+': '+v.why);
  for(const v of V.idempotent){
    assert.deepEqual(normalizeWorklistColumns(clone(v.document)),v.expect,v.id+': '+v.why);
    assert.deepEqual(normalizeWorklistColumns(clone(v.expect)),v.expect,v.id+' twice');
  }
  // The same key in the Radiology order is accepted (R07's pair).
  const radiology=clone(byId.R07.document);radiology.modes.Technician.order=['id','name'];radiology.modes.Radiology.order=['id','name','institutionName'];
  assert.deepEqual(normalizeWorklistColumns(radiology).modes.Radiology.order.slice(-2),['preReviewer','time']);
  assert.deepEqual(normalizeWorklistColumns(radiology).modes.Radiology.order.slice(0,7),['id','name','reqDate','reqDept','reqDoc','ptClass','institutionName']);
});

test('compact 11px is accepted and 9px is refused by the API normalizer',()=>{
  const document=clone(byId.V01.document);
  for(const size of [10,11,20]) {
    document.modes.Radiology.appearance={widths:{name:240},font:'default',size,color:'default'};
    assert.equal(normalizeWorklistColumns(document).modes.Radiology.appearance.size,size);
  }
  document.modes.Radiology.appearance.size=9;
  assert.equal(normalizeWorklistColumns(document),null);
});

// ── the column routes over a fake store ──
function columnsService(initial){
  let row=initial?clone(initial):null;const writes=[],reads=[];
  const table={
    findUnique:async arg=>{reads.push(clone(arg));assert.deepEqual(arg.where,{institution_subject:OWNER});return row?clone(row):null;},
    create:async arg=>{writes.push(['create',clone(arg)]);if(row){const e=new Error('unique');e.code='P2002';throw e;}
      row={...arg.data,updatedAt:new Date('2026-09-29T00:00:00.000Z')};return clone(row);},
    updateMany:async arg=>{writes.push(['updateMany',clone(arg)]);
      if(!row||row.institution!==arg.where.institution||row.subject!==arg.where.subject||row.revision!==arg.where.revision)return {count:0};
      row={...row,value:arg.data.value,revision:row.revision+arg.data.revision.increment,updatedAt:new Date('2026-09-29T00:01:00.000Z')};return {count:1};},
  };
  for(const name of ['update','upsert','delete','deleteMany'])table[name]=async()=>{writes.push([name]);throw new Error('unexpected '+name);};
  const prisma={worklistColumns:table,$transaction:async fn=>fn(prisma)};
  const svc=new PacsService(prisma,{},{},new StudyAccessService(prisma,{},{}));
  return {svc,writes,reads,row:()=>row};
}
const stored=(document,revision=3)=>({...OWNER,revision,value:JSON.stringify(document),updatedAt:new Date('2026-09-01T00:00:00.000Z')});

test('sc03 GET answers a stored pre-unit row with Hospital added and leaves the row as it was',async()=>{
  for(const id of ['V01','V02','V03','V05']){
    const v=byId[id],store=columnsService(stored(v.document));
    const answer=await store.svc.worklistColumns(caller);
    assert.deepEqual(answer.owner,['hallym','syn-sub-a'],id);
    assert.equal(answer.revision,3,id);assert.deepEqual(answer.columns,v.expect,id+': '+v.why);
    assert.deepEqual(store.writes,[],id+' the read writes nothing');
    assert.equal(store.row().value,JSON.stringify(v.document),id+' stored value unchanged');assert.equal(store.row().revision,3,id);
  }
  const empty=columnsService(null);const none=await empty.svc.worklistColumns(caller);
  assert.equal(none.columns,null);assert.equal(none.revision,0);assert.deepEqual(empty.writes,[]);
  // An unreadable stored row is still 503 and still kept.
  const bad=columnsService(stored(byId.R01.document));
  await assert.rejects(bad.svc.worklistColumns(caller),e=>status(e)===503);
  assert.deepEqual(bad.writes,[]);assert.equal(bad.row().value,JSON.stringify(byId.R01.document));
});

test('sc04 PUT stores an old client document with Hospital added; refusals and conflicts write nothing',async()=>{
  const v=byId.V02,store=columnsService(stored(byId.V01.document));
  const answer=await store.svc.writeWorklistColumns({expectedOwner:['hallym','syn-sub-a'],revision:3,columns:clone(v.document)},caller,false);
  assert.deepEqual(answer.columns,v.expect);assert.equal(answer.revision,4);
  assert.deepEqual(JSON.parse(store.row().value),v.expect,'the stored value is the normalized document');
  assert.equal(store.writes.length,1);assert.equal(store.writes[0][0],'updateMany');
  // First save of a partial document (revision 0 creates the row).
  const first=columnsService(null);
  const created=await first.svc.writeWorklistColumns({expectedOwner:['hallym','syn-sub-a'],revision:0,columns:clone(byId.V03.document)},caller,false);
  assert.deepEqual(created.columns,byId.V03.expect);assert.equal(created.revision,1);assert.deepEqual(JSON.parse(first.row().value),byId.V03.expect);
  // R07 (Hospital in Technician) and every other refused document: 400, nothing written.
  for(const r of V.refused){
    const kept=columnsService(stored(byId.V01.document));
    await assert.rejects(kept.svc.writeWorklistColumns({expectedOwner:['hallym','syn-sub-a'],revision:3,columns:clone(r.document)},caller,false),
      e=>status(e)===400,r.id);
    assert.deepEqual(kept.writes,[],r.id);assert.equal(kept.row().value,JSON.stringify(byId.V01.document),r.id);
  }
  // A stale revision: 409 COLUMNS_CONFLICT and the row as it was.
  const later=columnsService(stored(byId.V01.document,5));
  await assert.rejects(later.svc.writeWorklistColumns({expectedOwner:['hallym','syn-sub-a'],revision:3,columns:clone(v.document)},caller,false),
    e=>status(e)===409&&e.getResponse().code==='COLUMNS_CONFLICT');
  assert.equal(later.row().value,JSON.stringify(byId.V01.document));assert.equal(later.row().revision,5);
  // The idempotent document keeps Hospital where the user put it.
  const moved=columnsService(stored(byId.V01.document));
  const kept=await moved.svc.writeWorklistColumns({expectedOwner:['hallym','syn-sub-a'],revision:3,columns:clone(byId.R06.document)},caller,false);
  assert.deepEqual(kept.columns,byId.R06.expect);
});

// ── the list rows over a fake store (registry names differ from ids) ──
const INSTITUTIONS=[{id:'hallym',name:'SYN Hospital A',dicomNames:'SYN-DICOM-A'},{id:'kin-center',name:'SYN Center B',dicomNames:'SYN-DICOM-B'}];
const at=new Date('2026-09-01T00:00:00.000Z');
const S=(uid,institutionId,teleInstitutionId)=>({uid,institutionId,teleInstitutionId,origin:'dicom',createdAt:at,
  rs:'W',ss:'Verified',em:'N',ts:'none',ward:'',reqHosp:'SYN MANUAL',matched:'U',orderOid:null,preDoc:null,preReviewer:null,ov:null,orig:null});
const STATES=[
  S('2.25.8101','hallym',null),              // R-own
  S('2.25.8102','kin-center','hallym'),      // R-tele: kin-center opened it to hallym
  S('2.25.8103','hallym','kin-center'),      // R-sent: hallym opened it to kin-center
  S('2.25.8104','syn-unregistered','hallym'),// an owner id the registry does not know, received by hallym
  S('2.25.8105','hallym',null)];             // tele closed (or never opened): only its owner sees it
const val=v=>({Value:[v]});
const Q=(uid,inst)=>({'0020000D':val(uid),'00080080':val(inst),'00080020':val('20260929'),'00081030':val('SYN MI CT'),
  '00080061':{Value:['CT']},'00080050':val('SYNACC'+uid.slice(-4)),'00100020':val('SYN-P-'+uid.slice(-4)),
  '00100010':{vr:'PN',Value:[{Alphabetic:'SYN^ROW^'+uid.slice(-4)}]},'00201206':val(1),'00201208':val(1)});
const QIDO=[Q('2.25.8101','SYN-DICOM-A'),Q('2.25.8102','SYN-DICOM-B'),Q('2.25.8103','SYN-DICOM-A'),Q('2.25.8104','SYN OTHER'),Q('2.25.8105','SYN-DICOM-A')];
const project=(rows,select)=>select?rows.map(r=>Object.fromEntries(Object.keys(select).map(k=>[k,r[k]]))):rows;
// S9-U0b: the institution cache belongs to the institutions concern. It is filled as the API process fills it, by the
// service's own start (onModuleInit), over a start-time view of this store: the institution list given here, and the
// start's seed writes absorbed. The cases begin after the start and keep every refusal of their own store.
async function start(svc,prisma,names){
  const saved={institution:prisma.institution,order:prisma.order};
  prisma.institution={upsert:async()=>({}),findMany:async()=>structuredClone(names)};
  prisma.order={...prisma.order,count:async()=>1,updateMany:async()=>({count:0})};
  const log=console.log;console.log=()=>{};
  try{await svc.onModuleInit();}finally{console.log=log;if(saved.order)prisma.order=saved.order;else delete prisma.order;if(saved.institution)prisma.institution=saved.institution;else delete prisma.institution;}
  return svc;
}
async function listService(names=INSTITUTIONS){
  const refuse=what=>async()=>{throw new Error('the list must not write: '+what);};
  const prisma={
    studyState:{findMany:async arg=>{let rows=clone(STATES).map(s=>({...s,createdAt:at}));const where=arg?.where;
        if(where?.uid)rows=rows.filter(s=>where.uid.in.includes(s.uid));
        else if(where?.institutionId)rows=rows.filter(s=>s.institutionId===where.institutionId);
        else if(where)throw new Error('unexpected where '+JSON.stringify(where));
        return project(rows,arg?.select);},
      create:refuse('studyState.create'),update:refuse('studyState.update'),updateMany:refuse('studyState.updateMany')},
    order:{findMany:async arg=>project([],arg?.select)},
    report:{findMany:async()=>[]},reportDraft:{findMany:async()=>[]},studyAttachment:{groupBy:async()=>[],findMany:async()=>[],findFirst:async()=>null},gatewayReceipt:{findMany:async()=>[]},
    readerAssignment:{findMany:async arg=>{assert.ok(typeof arg.where.institutionId==='string');return [];}},
    auditLog:{create:refuse('auditLog.create')},
    $queryRaw:async()=>[],
  };
  const orthanc={studies:async()=>clone(QIDO),
    studyIdentities:async(accessMetadata,accession)=>clone(QIDO).map(r=>({'0020000D':r['0020000D'],'00080080':r['00080080'],
      ...(accessMetadata?{'00100020':r['00100020'],'00080020':r['00080020'],'00080061':r['00080061']}:{}),
      ...(accession?{'00080050':r['00080050']}:{})})),
    studiesByUid:async uids=>uids.map(uid=>clone(QIDO).find(r=>r['0020000D'].Value[0]===uid))};
  const svc=new PacsService(prisma,orthanc,{},new StudyAccessService(prisma,orthanc,{}));
  await start(svc,prisma,clone(names));
  return svc;
}
const rowsOf=answer=>Object.fromEntries(answer.studies.map(r=>[r.uid,{institutionName:r.institutionName,tele:r.tele}]));

test('sc05 list rows carry the owner registry name and tele only for a study received by the caller',async()=>{
  const svc=await listService();
  const expectA={
    '2.25.8101':{institutionName:'SYN Hospital A',tele:false},   // SR-01
    '2.25.8102':{institutionName:'SYN Center B',tele:true},      // SR-02: the owner's name, not the caller's
    '2.25.8103':{institutionName:'SYN Hospital A',tele:false},   // SR-03 at the owner
    '2.25.8104':{institutionName:'(미배정)',tele:true},           // SR-04: the server's own fallback, as it is
    '2.25.8105':{institutionName:'SYN Hospital A',tele:false}};
  assert.deepEqual(rowsOf(await svc.listStudies(caller)),expectA,'full list, hallym');
  assert.deepEqual(rowsOf(await svc.listStudies(caller,{limit:'100'})),expectA,'paged list, hallym');
  // Pair: the same store read by the other institution (SR-03 at the receiver, SR-05 closed tele not listed).
  const other={...caller,institution:'kin-center',sub:'syn-sub-b',actor:'syn-reader-b@synthetic.test'};
  const expectB={
    '2.25.8102':{institutionName:'SYN Center B',tele:false},
    '2.25.8103':{institutionName:'SYN Hospital A',tele:true}};
  assert.deepEqual(rowsOf(await svc.listStudies(other)),expectB,'full list, kin-center');
  assert.deepEqual(rowsOf(await svc.listStudies(other,{limit:'100'})),expectB,'paged list, kin-center');
  // Equal registry names (HC-04): tele still follows the row, never a name comparison.
  const same=await listService([{...INSTITUTIONS[0],name:'SYN Hospital'},{...INSTITUTIONS[1],name:'SYN Hospital'}]);
  const rows=rowsOf(await same.listStudies(caller));
  assert.deepEqual(rows['2.25.8101'],{institutionName:'SYN Hospital',tele:false});
  assert.deepEqual(rows['2.25.8102'],{institutionName:'SYN Hospital',tele:true});
});

// ── request and approval columns (ReqDate, ReqDept, ReqDoc, Pt Class after Name; Confirm after RS) ──
const TECH=byId.V01.expect.modes.Technician;
const doc=radiology=>({version:1,modes:{Radiology:radiology,Technician:clone(TECH)}});
test('sc06 a stored layout gains the request columns after Name and Confirm after RS; the user\'s order and hidden stay',()=>{
  const rest=['pf','assignedReader','techNote','no','viewing','count','series','em','ss','acc','ts','id','age','birth','sex','modality','desc','date','preDoc','preReviewer','institutionName','time'];
  // A partial order: RS and Name where the user put them, Age hidden; every other column after them as before.
  assert.deepEqual(normalizeWorklistColumns(doc({order:['rs','name'],hidden:['age']})).modes.Radiology,
    {order:['rs','confirm','name','reqDate','reqDept','reqDoc','ptClass',...rest],hidden:['age']});
  // A user who already moved one of them keeps it there; the ones still missing follow their own anchor.
  assert.deepEqual(normalizeWorklistColumns(doc({order:['reqDate','name','rs'],hidden:[]})).modes.Radiology.order.slice(0,7),
    ['reqDate','reqDept','reqDoc','ptClass','name','rs','confirm']);
  // All five already stored (moved and hidden by the user): nothing moves.
  const placed={order:['confirm','ptClass','id','name','rs','reqDoc','reqDept','reqDate',...rest.filter(k=>k!=='id')],hidden:['ptClass','reqDate']};
  assert.deepEqual(normalizeWorklistColumns(doc(clone(placed))).modes.Radiology,placed);
  assert.deepEqual(normalizeWorklistColumns(doc(clone(placed))).modes.Technician,TECH,'Technician unchanged');
  // The Technician list has none of them: a Technician layout that names one is refused whole.
  const tech=clone(byId.V01.document);tech.modes.Technician.order.push('confirm');
  assert.equal(normalizeWorklistColumns(tech),null);
});

const values=require(DIST+'/pacs/values');
test('sc07 the request columns take the matched order first; ReqDoc alone falls back to the DICOM physician tags',()=>{
  const dicom={requestingPhysician:'SYN^REQUESTING',referringPhysician:'SYN^REFERRING'};
  assert.deepEqual(values.requestColumns({reqAt:new Date('2026-11-12T00:40:00.000Z'),reqDept:' Neurology ',reqDoc:'SYN ORDER DOC',ptClass:'O'},dicom),
    {reqDate:'2026-11-12T00:40:00.000Z',reqDept:'Neurology',reqDoc:'SYN ORDER DOC',ptClass:'Outpatient'});
  assert.deepEqual(['I','E','ICU','icu','X'].map(ptClass=>values.requestColumns({ptClass}).ptClass),['Inpatient','ER','ICU','ICU','X']);
  // An order without a physician: the study's Requesting Physician, then its Referring Physician; never a guess.
  assert.equal(values.requestColumns({reqDoc:'  '},dicom).reqDoc,'SYN REQUESTING');
  assert.equal(values.requestColumns(null,{requestingPhysician:null,referringPhysician:'SYN^REFERRING'}).reqDoc,'SYN REFERRING');
  assert.deepEqual(values.requestColumns(null,{}),{reqDate:null,reqDept:null,reqDoc:null,ptClass:null});
  assert.deepEqual(values.requestColumns(undefined),{reqDate:null,reqDept:null,reqDoc:null,ptClass:null});
  assert.equal(values.requestColumns({reqAt:'not a time'}).reqDate,null);
});

test('sc08 list rows: an own matched study shows its order; a received tele study and an unmatched one only the DICOM physician',async()=>{
  const st=(uid,over)=>({...S(uid,'hallym',null),...over});
  const states=[st('2.25.8201',{matched:'M',orderOid:'SYN-O1'}),st('2.25.8202',{}),
    st('2.25.8203',{institutionId:'kin-center',teleInstitutionId:'hallym',matched:'M',orderOid:'SYN-O2'})];
  const orders=[{oid:'SYN-O1',institutionId:'hallym',studyUid:'2.25.8201',matched:'M',accession:null,patientId:'SYN-P-8201',name:'SYN ROW',birth:'',sex:'M',
      reqAt:new Date('2026-11-11T05:00:00.000Z'),reqDept:'Orthopedics',reqDoc:'SYN ORDER DOC',ptClass:'I'},
    {oid:'SYN-O2',institutionId:'kin-center',studyUid:'2.25.8203',matched:'M',accession:null,patientId:'SYN-P-8203',name:'SYN ROW',birth:'',sex:'M',
      reqAt:new Date('2026-11-10T05:00:00.000Z'),reqDept:'SYN OTHER DEPT',reqDoc:'SYN OTHER DOC',ptClass:'E'}];
  const orderReads=[];
  const prisma={
    studyState:{findMany:async arg=>{let rows=clone(states).map(s=>({...s,createdAt:at}));const where=arg?.where;
      if(where?.uid)rows=rows.filter(s=>where.uid.in.includes(s.uid));
      else if(where?.institutionId)rows=rows.filter(s=>s.institutionId===where.institutionId);
      return project(rows,arg?.select);}},
    order:{findMany:async arg=>{orderReads.push(clone(arg));let rows=orders.filter(o=>o.institutionId===arg.where.institutionId);
      if(arg.where.oid)rows=rows.filter(o=>arg.where.oid.in.includes(o.oid));return project(rows,arg.select);}},
    report:{findMany:async()=>[]},reportDraft:{findMany:async()=>[]},studyAttachment:{groupBy:async()=>[],findMany:async()=>[],findFirst:async()=>null},gatewayReceipt:{findMany:async()=>[]},
    readerAssignment:{findMany:async()=>[]},$queryRaw:async()=>[],
  };
  const person=v=>({vr:'PN',Value:[{Alphabetic:v}]});
  const qido=[{...Q('2.25.8201','SYN-DICOM-A'),'00321032':person('SYN^TAG^REQ')},
    {...Q('2.25.8202','SYN-DICOM-A'),'00080090':person('SYN^TAG^REF')},
    {...Q('2.25.8203','SYN-DICOM-B'),'00321032':person('SYN^TELE^REQ')}];
  const orthanc={studies:async()=>clone(qido),
    studyIdentities:async(accessMetadata,accession)=>clone(qido).map(r=>({'0020000D':r['0020000D'],'00080080':r['00080080'],
      ...(accessMetadata?{'00100020':r['00100020'],'00080020':r['00080020'],'00080061':r['00080061']}:{}),...(accession?{'00080050':r['00080050']}:{})})),
    studiesByUid:async uids=>uids.map(uid=>clone(qido).find(r=>r['0020000D'].Value[0]===uid))};
  const svc=new PacsService(prisma,orthanc,{},new StudyAccessService(prisma,orthanc,{}));
  await start(svc,prisma,clone(INSTITUTIONS));
  const pick=r=>({reqDate:r.reqDate,reqDept:r.reqDept,reqDoc:r.reqDoc,ptClass:r.ptClass});
  for(const query of [undefined,{limit:'100'}]){
    orderReads.length=0;
    const rows=Object.fromEntries((await svc.listStudies(caller,query)).studies.map(r=>[r.uid,pick(r)]));
    assert.deepEqual(rows,{
      '2.25.8201':{reqDate:'2026-11-11T05:00:00.000Z',reqDept:'Orthopedics',reqDoc:'SYN ORDER DOC',ptClass:'Inpatient'},
      '2.25.8202':{reqDate:null,reqDept:null,reqDoc:'SYN TAG REF',ptClass:null},
      '2.25.8203':{reqDate:null,reqDept:null,reqDoc:'SYN TELE REQ',ptClass:null}},JSON.stringify(query));
    // The request read names only the caller's own linked orders and only the four request fields.
    const request=orderReads.find(r=>r.select&&'reqAt' in r.select);
    assert.deepEqual(request,{where:{oid:{in:['SYN-O1']},institutionId:'hallym'},select:{oid:true,reqAt:true,reqDept:true,reqDoc:true,ptClass:true}});
  }
});

after(()=>{
  const loaded=Object.keys(require.cache).filter(k=>k.startsWith(DIST+'/')).map(k=>k.slice(DIST.length+1)).sort();
  console.log('S7-U3b NEW-2 loaded compiled modules ('+DIST+'): '+JSON.stringify(loaded));
});
