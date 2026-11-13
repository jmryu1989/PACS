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
  {oid:'SYN-K-1',institutionId:'kin-center',patientId:'SYN-P4',name:'SYNTHETIC PATIENT',sched:'x',accession:'SYN-ACC-1',matched:'U',studyUid:null},
  // Taken off the list (Delete Order): its accession would pair with 2.25.11 if it were still read.
  {oid:'SYN-H-R',institutionId:'hallym',patientId:'SYN-P5',name:'SYNTHETIC PATIENT',sched:'x',accession:'SYN-ACC-1',matched:'U',studyUid:null,removedAt:new Date('2020-01-02T00:00:00.000Z')}];
const QIDO=[['2.25.11','hallym','SYN-ACC-1'],['2.25.12','kin-center','SYN-ACC-1'],['2.25.13','kin-center','SYN-ACC-2']]
  .map(([uid,inst,acc])=>({'0020000D':{Value:[uid]},'00080080':{Value:[inst]},'00080050':{Value:[acc]},'00100020':{Value:['SYN-'+uid]},'00100010':{Value:['SYNTHETIC^PATIENT']}}));
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
async function setup({policies=()=>[],qido=QIDO,states=STATES,studies}={}){
  const seq=[];let policyReads=0;
  const prisma={
    studyState:{findMany:async arg=>{seq.push('state');let rows=structuredClone(states);
      if(arg?.where?.uid)rows=rows.filter(s=>arg.where.uid.in.includes(s.uid));
      else if(arg?.where?.institutionId)rows=rows.filter(s=>s.institutionId===arg.where.institutionId);
      else if(arg?.where)throw new Error('unexpected where '+JSON.stringify(arg.where));
      return project(rows,arg?.select);},
      create:async()=>{throw new Error('no study should be created');},update:async()=>{throw new Error('no study should be changed');}},
    order:{findMany:async arg=>{seq.push('order');const rows=structuredClone(ORDERS).filter(o=>o.institutionId===arg.where.institutionId&&(arg.where.removedAt!==null||o.removedAt==null));return project(rows,arg.select);}},
    report:{findMany:async()=>[]},reportDraft:{findMany:async()=>[]},readerAssignment:{findMany:async()=>[]},studyAttachment:{groupBy:async()=>[],findMany:async()=>[],findFirst:async()=>null},gatewayReceipt:{findMany:async()=>[]},
    readingTemplate:{count:async()=>1,findMany:async()=>[]},userFilter:{findMany:async()=>[]},
    auditLog:{create:async()=>{throw new Error('no audit expected');}},
    $queryRaw:async(strings)=>{const sql=strings.join('?');if(sql.includes('StudyAccessPolicy')){seq.push('policy');return policies(++policyReads);}return [];},
  };
  const orthanc={studies:studies||(async()=>structuredClone(qido)),
    studyIdentities:async(accessMetadata,accession)=>structuredClone(qido).map(r=>({'0020000D':r['0020000D'],'00080080':r['00080080'],
      ...(accessMetadata?{'00100020':r['00100020'],'00080020':r['00080020'],'00080061':r['00080061']}:{}),
      ...(accession?{'00080050':r['00080050']}:{})})),
    studiesByUid:async uids=>structuredClone(qido).filter(r=>uids.includes(r['0020000D'].Value[0]))};
  const svc=new PacsService(prisma,orthanc,{},new StudyAccessService(prisma,orthanc,{}));
  await start(svc,prisma,[{id:'hallym',name:'hallym'},{id:'kin-center',name:'kin-center'}]);
  return {svc,seq};
}
const HALLYM=[
  {oid:'O-9001',link:'unlinked',accession:'absent',candidates:[]},
  {oid:'SYN-H-1',link:'unlinked',accession:'present',candidates:['2.25.11']},
  {oid:'SYN-H-2',link:'unlinked',accession:'present',candidates:[]},
  {oid:'SYN-H-L',link:'not_observed',studyUid:'2.25.14'}];

test('S4-U2 full list: own tenant only, tele-received never pairs, seed not comparable, no patient field leaves',async()=>{
  const {svc,seq}=await setup();const r=await svc.listStudies(caller);
  assert.deepEqual(r.orderReconciliation,{source:'engineering_only',orders:HALLYM});
  const text=JSON.stringify(r.orderReconciliation);
  for(const leak of ['SYN-K-1','2.25.12','2.25.13','SYN-ACC','SYNTHETIC PATIENT','KIM CHULSOO','09:10','P-1001'])assert.ok(!text.includes(leak),leak);
  assert.ok(seq.lastIndexOf('order')<seq.lastIndexOf('policy'),'the order side is read before the access re-check');
  assert.deepEqual(r.notObserved.map(x=>x.uid),['2.25.14']);
});

test('S4-U2 paged list: only the completing page carries accession-based candidates',async()=>{
  const {svc,seq}=await setup();
  const first=await svc.listStudies(caller,{limit:'1'});
  assert.ok(first.pagination.next);assert.equal('orderReconciliation' in first,false);assert.equal('notObserved' in first,false);
  assert.equal(seq.includes('order'),false,'no order read on a page that does not complete the list');
  const last=await svc.listStudies(caller,{limit:'1',after:first.pagination.next});
  assert.equal(last.pagination.next,null);assert.deepEqual(last.orderReconciliation,{source:'engineering_only',orders:HALLYM});
});

test('D1887 patientless studies stay out of full/paged lists and accession-matching suggestions',async()=>{
  const uid='2.25.15';
  const identified={...structuredClone(QIDO[0]),'0020000D':{Value:[uid]}};
  const states=[...STATES,{...STATES[0],uid}];
  for(const patient of [undefined,'','   ']){
    const held=structuredClone(identified);
    if(patient===undefined)delete held['00100020'];else held['00100020']={Value:[patient]};
    // A corrected resend may coexist with the old patientless resource, in either enumeration order.
    for(const resources of [[held],[held,identified],[identified,held]]){
      const {svc}=await setup({states,qido:[...QIDO,...resources]});
      for(const query of [undefined,{limit:'1'}]){
        let after;const listed=[];let answer;
        do{
          answer=await svc.listStudies(caller,query?{...query,after}:undefined);
          listed.push(...answer.studies.map(s=>s.uid));
          after=answer.pagination?.next;
        }while(after);
        assert.deepEqual(listed.sort(),['2.25.11','2.25.13']);
        assert.deepEqual(answer.orderReconciliation,{source:'engineering_only',orders:HALLYM});
        assert.deepEqual(answer.notObserved.map(s=>s.uid),['2.25.14'],'held is observed, not missing');
      }
    }
  }
});

test('S4-U2 restricted caller receives zero unlinked orders and zero candidates',async()=>{
  const policy={version:1,restricted:true,startsAt:null,endsAt:null,rules:[{patientId:null,modalities:[],dateFrom:null,dateTo:null,studyUids:['2.25.11','2.25.14']}]};
  const {svc}=await setup({policies:()=>[{institution:'hallym',revision:1,policy,reason:'SYNTHETIC',updatedBy:null,updatedAt:null}]});
  for(const query of [undefined,{limit:'100'}]){
    const r=await svc.listStudies(caller,query);
    assert.deepEqual(r.orderReconciliation,{source:'engineering_only',orders:[{oid:'SYN-H-L',link:'not_observed',studyUid:'2.25.14'}]});
  }
  const other=(await setup()).svc;const ktech={...caller,institution:'kin-center'};
  const k=await other.listStudies(ktech);
  assert.deepEqual(k.orderReconciliation.orders,[{oid:'SYN-K-1',link:'unlinked',accession:'present',candidates:['2.25.12']}]);
});

test('S4-U2 failures: no answer without a successful enumeration; an unidentifiable row makes it unknown; policy change refuses',async()=>{
  const failing=await setup({studies:async()=>{throw Object.assign(new Error('Orthanc HTTP 503'),{getStatus:()=>503});}});
  await assert.rejects(failing.svc.listStudies(caller));assert.equal(failing.seq.includes('order'),false);
  const partial=await setup({qido:[...QIDO,{'00080080':{Value:['hallym']},'00080050':{Value:['SYN-ACC-1']}}]});
  const r=await partial.svc.listStudies(caller);assert.equal(r.orderReconciliation,null);assert.equal(r.notObserved,null);
  const policy={version:1,restricted:true,startsAt:null,endsAt:null,rules:[{patientId:null,modalities:[],dateFrom:null,dateTo:null,studyUids:['2.25.11']}]};
  const changed=await setup({policies:n=>n===1?[]:[{institution:'hallym',revision:1,policy,reason:'SYNTHETIC',updatedBy:null,updatedAt:null}]});
  await assert.rejects(changed.svc.listStudies(caller),e=>e.getStatus()===409);
});

test('S4-U2 bootstrap order payload carries only the order\'s own accession (null without one) and leaves removed orders out',async()=>{
  const {svc}=await setup();const b=await svc.bootstrap(caller,{states:'omit'});
  for(const o of b.orders)assert.deepEqual(Object.keys(o).sort(),['accession','birth','desc','id','matched','modality','name','oid','reqDoc','sched','sex','studyUid','ward']);
  assert.deepEqual(b.orders.map(o=>[o.oid,o.accession]),[['O-9001',null],['SYN-H-1','SYN-ACC-1'],['SYN-H-2','SYN-ACC-2'],['SYN-H-L',null]]);
});

// ── Technician Order List: Scheduled, Delete Order and Undo over a fake store and archive ──
const {TechnicianOrdersService,removeReason}=require('/app/dist/technician-orders.service');
const {scheduledOrderState}=require('/app/dist/order-reconciliation');
const DAY='2026-11-14';
const status=error=>typeof error?.getStatus==='function'?error.getStatus():null;
const qidoRow=(uid,acc,count,inst='hallym')=>({'0020000D':{Value:[uid]},'00080050':{Value:[acc]},'00201208':{Value:[count]},'00081030':{Value:['SYN DESC']},'00080080':{Value:[inst]},'00100020':{Value:['x']},'00080020':{Value:['20261114']},'00080061':{Value:['CT']}});
const TO_ORDERS=[
  {oid:'TO-A',institutionId:'hallym',patientId:'TO-PA',name:'SYN A',sched:DAY+' 09:00',modality:'CT',descr:'SYN',accession:null,matched:'M',studyUid:'2.25.21'},
  {oid:'TO-B',institutionId:'hallym',patientId:'TO-PB',name:'SYN B',sched:DAY+' 09:10',modality:'CT',descr:'SYN',accession:null,matched:'U',studyUid:null},
  {oid:'TO-C',institutionId:'hallym',patientId:'TO-PC',name:'SYN C',sched:DAY+' 09:20',modality:'CT',descr:'SYN',accession:null,matched:'U',studyUid:null},
  {oid:'TO-D',institutionId:'hallym',patientId:'TO-PD',name:'SYN D',sched:DAY+' 09:30',modality:'CT',descr:'SYN',accession:'ACC-D',matched:'U',studyUid:null},
  {oid:'TO-E',institutionId:'hallym',patientId:' ',name:'SYN E',sched:DAY+' 09:40',modality:'CT',descr:'SYN',accession:null,matched:'U',studyUid:null},
  {oid:'TO-F',institutionId:'hallym',patientId:'TO-PB',name:'SYN F',sched:DAY+' 09:50',modality:'CT',descr:'SYN',accession:null,matched:'U',studyUid:null,removedAt:new Date('2026-11-14T00:00:00Z')},
  {oid:'TO-G',institutionId:'hallym',patientId:'TO-PB',name:'SYN G',sched:'2026-11-15 09:00',modality:'CT',descr:'SYN',accession:null,matched:'U',studyUid:null},
  {oid:'TO-H',institutionId:'kin-center',patientId:'TO-PB',name:'SYN H',sched:DAY+' 09:00',modality:'CT',descr:'SYN',accession:null,matched:'U',studyUid:null},
  {oid:'TO-I',institutionId:'hallym',patientId:'TO-PI',name:'SYN I',sched:DAY+' 10:00',modality:'CT',descr:'SYN',accession:null,matched:'U',studyUid:null}];
const TO_STATES=[['2.25.31','hallym','U',null],['2.25.32','hallym','U',null],['2.25.33','kin-center','U',null],['2.25.34','hallym','M','TO-X'],['2.25.41','hallym','U',null]]
  .map(([uid,institutionId,matched,orderOid])=>({uid,institutionId,matched,orderOid}));
function ordersFixture({restricted=false,allowed=null,failPatients=[],failCounts=false}={}){
  const rows=structuredClone(TO_ORDERS),writes=[],audits=[],asked=[];
  const hit=(o,where)=>Object.entries(where).every(([k,v])=>v===null?o[k]==null:v&&typeof v==='object'&&'not' in v?o[k]!=null:
    v&&typeof v==='object'&&'startsWith' in v?String(o[k]).startsWith(v.startsWith):o[k]===v);
  const prisma={
    order:{findMany:async({where})=>structuredClone(rows.filter(o=>hit(o,where))),findUnique:async({where})=>structuredClone(rows.find(o=>o.oid===where.oid)??null),
      updateMany:async({where,data})=>{const taken=rows.filter(o=>hit(o,where));for(const o of taken)Object.assign(o,data);writes.push({where,data,count:taken.length});return {count:taken.length};}},
    studyState:{findMany:async({where})=>TO_STATES.filter(s=>where.uid.in.includes(s.uid)).map(s=>({...s}))},
    auditLog:{create:async({data})=>{audits.push(data);return data;}}};
  prisma.$transaction=async work=>work(prisma);
  const archive={'TO-PD|20261114':[qidoRow('2.25.31','ACC-X',5),qidoRow('2.25.32','ACC-D',7),qidoRow('2.25.33','ACC-D',3,'kin-center'),qidoRow('2.25.34','ACC-D',2)],
    'TO-PI|20261114':[qidoRow('2.25.41','ACC-I',1),qidoRow('2.25.41','ACC-I',1)]};
  const orthanc={patientStudiesOnDate:async(pid,date)=>{asked.push(pid+'|'+date);if(failPatients.includes(pid))throw new Error('archive down');return structuredClone(archive[pid+'|'+date]??[]);},
    studyInstanceCounts:async uids=>{if(failCounts)throw new Error('archive down');return new Map(uids.filter(u=>u==='2.25.21').map(u=>[u,20]));}};
  const studyAccess={snapshot:async()=>({policy:{restricted}}),allowed:async(_c,uids)=>new Set(allowed??uids),
    matches:(_a,uid)=>!restricted||(allowed??[]).includes(uid),unchanged:async()=>{}};
  return {svc:new TechnicianOrdersService(prisma,orthanc,studyAccess),rows,writes,audits,asked};
}
const tech={...caller,roles:['technician']};
const stateOf=answer=>Object.fromEntries(answer.orders.map(o=>[o.oid,o.state]));

test('TO-SCHED each of the day\'s orders keeps its own state: matched, no images, lookup failed, images found, not checkable',async()=>{
  const f=ordersFixture({failPatients:['TO-PC']});const answer=await f.svc.scheduled(tech,{day:DAY});
  assert.equal(answer.source,'engineering_only');assert.equal(answer.day,DAY);
  assert.deepEqual(stateOf(answer),{'TO-A':'matched','TO-B':'no_images','TO-C':'lookup_failed','TO-D':'images_found','TO-E':'not_checkable','TO-I':'lookup_failed'},
    'removed, other-day and other-institution orders are left out; a failed or split lookup is never "no images"');
  const by=Object.fromEntries(answer.orders.map(o=>[o.oid,o]));
  assert.equal(by['TO-A'].images,20);assert.equal(by['TO-A'].studyUid,'2.25.21');
  assert.deepEqual(by['TO-D'].candidates,[{uid:'2.25.31',accession:'ACC-X',images:5,desc:'SYN DESC',relation:'mismatch'},{uid:'2.25.32',accession:'ACC-D',images:7,desc:'SYN DESC',relation:'match'}],
    'own unmatched studies only: another institution\'s and an already matched study are no candidates');
  assert.equal(by['TO-D'].accession,'ACC-D');assert.equal(by['TO-B'].accession,null);
  assert.ok(!f.asked.some(a=>a.startsWith(' ')),'a blank patient ID asks the archive nothing');
});

test('TO-SCHED Retry Check reads one order; a failed count of a matched order is lookup failed; bad queries and roles are refused',async()=>{
  const f=ordersFixture();
  assert.deepEqual(stateOf(await f.svc.scheduled(tech,{day:DAY,oid:'TO-C'})),{'TO-C':'no_images'},'the archive answered this time');
  assert.deepEqual(stateOf(await ordersFixture({failCounts:true}).svc.scheduled(tech,{day:DAY,oid:'TO-A'})),{'TO-A':'lookup_failed'});
  for(const q of [{},{day:'2026-11-1'},{day:DAY,extra:'1'},{day:DAY,oid:''}])
    await assert.rejects(f.svc.scheduled(tech,q),e=>status(e)===400,JSON.stringify(q));
  await assert.rejects(f.svc.scheduled({...tech,roles:['radiologist']},{day:DAY}),e=>status(e)===403);
});

test('TO-SCHED a restricted caller gets no unmatched order and a matched one only for a study it may open',async()=>{
  assert.deepEqual(stateOf(await ordersFixture({restricted:true,allowed:['2.25.21']}).svc.scheduled(tech,{day:DAY})),{'TO-A':'matched'});
  assert.deepEqual(stateOf(await ordersFixture({restricted:true,allowed:[]}).svc.scheduled(tech,{day:DAY})),{});
});

test('TO-REMOVE takes an unmatched order off the list with who and why in one claim, refuses a matched one, and Undo restores it',async()=>{
  const f=ordersFixture();
  const done=await f.svc.remove(tech,'TO-B',{reason:'  Duplicate order, cancelled by ward  '});
  assert.equal(done.oid,'TO-B');assert.equal(done.removed,true);
  assert.deepEqual(f.writes[0].where,{oid:'TO-B',institutionId:'hallym',matched:'U',studyUid:null,removedAt:null},'not matched and on the list, in the same statement');
  const row=f.rows.find(o=>o.oid==='TO-B');
  assert.ok(row.removedAt instanceof Date);assert.equal(row.removedBySub,tech.sub);assert.equal(row.removedBy,tech.actor);assert.equal(row.removeReason,'Duplicate order, cancelled by ward');
  assert.deepEqual(f.audits.map(a=>[a.action,a.target,JSON.parse(a.detail)]),[['order.remove','TO-B',{reason:'Duplicate order, cancelled by ward',by:'hallym'}]]);
  assert.ok(!(await f.svc.scheduled(tech,{day:DAY})).orders.some(o=>o.oid==='TO-B'),'a removed order leaves Scheduled');
  await assert.rejects(f.svc.remove(tech,'TO-B',{reason:'again'}),e=>status(e)===409);
  await f.svc.restore(tech,'TO-B');
  assert.equal(row.removedAt,null);assert.equal(row.removeReason,null);
  assert.deepEqual(f.audits.map(a=>a.action),['order.remove','order.restore']);
  await assert.rejects(f.svc.restore(tech,'TO-B'),e=>status(e)===409,'an order on the list has nothing to undo');
  // Matched: refused with nothing written.
  const g=ordersFixture();
  await assert.rejects(g.svc.remove(tech,'TO-A',{reason:'x'}),e=>status(e)===409&&/Unmatch/.test(e.message));
  assert.equal(g.rows.find(o=>o.oid==='TO-A').removedAt,undefined);assert.deepEqual(g.audits,[]);
  // Another institution's order, a missing reason, a restricted caller, a radiologist: refused before any write.
  for(const [c,oid,body,code] of [[tech,'TO-H',{reason:'x'},404],[tech,'TO-C',{},400],[tech,'TO-C',{reason:'   '},400],[tech,'TO-C',{reason:'x'.repeat(501)},400],
    [{...tech,roles:['radiologist']},'TO-C',{reason:'x'},403]])
    await assert.rejects(g.svc.remove(c,oid,body),e=>status(e)===code,oid+' '+JSON.stringify(body).slice(0,20));
  await assert.rejects(ordersFixture({restricted:true}).svc.remove(tech,'TO-C',{reason:'x'}),e=>status(e)===404);
  assert.equal(g.rows.find(o=>o.oid==='TO-C').removedAt,undefined);assert.deepEqual(g.audits,[]);
  assert.equal(removeReason(' why '),'why');
});

test('TO-SCHED the pure entry never renames one state as another',()=>{
  assert.deepEqual(scheduledOrderState({accession:null},{studyUid:'2.25.1',images:null,failed:false},null),{state:'matched',studyUid:'2.25.1',images:null,candidates:[]});
  assert.equal(scheduledOrderState({accession:null},{studyUid:'2.25.1',images:3,failed:true},[]).state,'lookup_failed');
  assert.equal(scheduledOrderState({accession:null},null,null).state,'lookup_failed');
  assert.equal(scheduledOrderState({accession:null},null,'unqueryable').state,'not_checkable');
  assert.equal(scheduledOrderState({accession:null},null,[]).state,'no_images');
  assert.deepEqual(scheduledOrderState({accession:null},null,[{uid:'2.25.2',accession:' ',images:1,desc:''}]).candidates,
    [{uid:'2.25.2',accession:null,images:1,desc:'',relation:'not_comparable'}],'an empty accession on either side is not comparable');
});

test('TO-LIST a matched row carries its order\'s accession as orderAccession; acc stays the archive\'s tag',async()=>{
  const states=STATES.map(s=>s.uid==='2.25.11'?{...s,matched:'M',orderOid:'SYN-H-2'}:s);
  const {svc}=await setup({states});const r=await svc.listStudies(caller);
  const row=r.studies.find(s=>s.uid==='2.25.11');
  assert.equal(row.acc,'SYN-ACC-1');assert.equal(row.orderAccession,'SYN-ACC-2');
  assert.equal(r.studies.find(s=>s.uid==='2.25.13').orderAccession,null,'a tele-received row has no order here');
});