// Merge Exam / Unmerge server: the compiled ExamMergeService over an in-memory store (every refusal, the locked
// re-check, the audit row, the new draft epochs, Unmerge's own refusals), the report scope a merged member and its base get,
// and the compiled PacsService.listStudies turning a merged exam into one row before paging (Count / Series of all its studies,
// Total and pages of exams, an unknown count, a caller who cannot see every study). Runs inside kin-api:ci; no network.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {ExamMergeService,examScope,activeGroups,STUDY_MERGED,EXAM_GROUP_REFUSED,MERGE_LIMIT}=require('/app/dist/exam-merge.service');
const {PacsService}=require('/app/dist/pacs.service');
const {StudyAccessService}=require('/app/dist/study-access.service');

const clone=v=>structuredClone(v);
const status=e=>typeof e?.getStatus==='function'?e.getStatus():null;
const body=e=>typeof e?.getResponse==='function'?e.getResponse():null;
const tech={institution:'hallym',sub:'syn-tech-sub',actor:'syn-tech',roles:['technician'],kind:'member'};
const reader={...tech,sub:'syn-reader-sub',actor:'syn-reader',roles:['radiologist']};
const A='2.25.501',B='2.25.502',C='2.25.503',D='2.25.504',E='2.25.505',F='2.25.506';
const state=(uid,extra={})=>({uid,institutionId:'hallym',teleInstitutionId:null,rs:'W',ss:'Verified',em:'N',holder:null,heldAt:null,
  draftEpoch:'00000000-0000-4000-8000-0000000000'+uid.slice(-2),...extra});
const PATIENT={[A]:'SYN-P1',[B]:'SYN-P1',[C]:'SYN-P1',[D]:'SYN-P2',[E]:'',[F]:'SYN-P1'};

function match(row,where){
  if(!where)return true;
  return Object.entries(where).every(([k,v])=>{
    if(k==='OR')return v.some(x=>match(row,x));
    if(v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Date)){
      if('in' in v)return v.in.includes(row[k]);
      if('not' in v)return (row[k]??null)!==v.not;
    }
    return (row[k]??null)===v;
  });
}
const pick=(row,select)=>select?Object.fromEntries(Object.keys(select).map(k=>[k,row[k]])):row;

function fixture({states=[A,B,C,D,E,F].map(uid=>state(uid)),groups=[],members=[],drafts=[],transfers=[],downloads=[],denied=[],onLock=null}={}){
  const db={states:new Map(states.map(s=>[s.uid,clone(s)])),groups:clone(groups),members:clone(members),drafts:clone(drafts),
    transfers:clone(transfers),downloads:clone(downloads),audits:[],locks:[],updates:[],tx:0};
  const prisma={
    $executeRaw:async()=>0,
    $queryRaw:async(strings,...values)=>{
      const sql=strings.join('?');
      if(sql.includes('FROM "StudyState"')&&sql.includes('FOR UPDATE')){
        const uids=values[0]?.values??values;db.locks.push({uids:[...uids],tx:db.tx});
        if(onLock)await onLock(db,uids);
        return [...uids].sort().flatMap(uid=>db.states.has(uid)?[clone(db.states.get(uid))]:[]);
      }
      throw new Error('unexpected raw query: '+sql);
    },
    studyState:{findUnique:async({where})=>clone(db.states.get(where.uid)??null),
      findMany:async({where,select})=>[...db.states.values()].filter(s=>match(s,where)).map(s=>pick(clone(s),select)),
      update:async({where,data})=>{db.updates.push({uid:where.uid,data});Object.assign(db.states.get(where.uid),data);return clone(db.states.get(where.uid));}},
    studyGroup:{findMany:async({where,select})=>db.groups.filter(g=>match(g,where)).map(g=>pick(clone(g),select)),
      findUnique:async({where})=>clone(db.groups.find(g=>g.id===where.id)??null),
      create:async({data})=>{db.groups.push({dissolvedAt:null,dissolvedBy:null,dissolvedBySub:null,...data});return data;},
      updateMany:async({where,data})=>{const hit=db.groups.filter(g=>match(g,where));for(const g of hit)Object.assign(g,data);return {count:hit.length};}},
    studyGroupMember:{findMany:async({where,select})=>db.members.filter(m=>match(m,where)).map(m=>pick(clone(m),select)),
      createMany:async({data})=>{db.members.push(...clone(data));return {count:data.length};}},
    reportDraft:{findMany:async({where,select})=>db.drafts.filter(d=>match(d,where)).map(d=>pick(d,select))},
    transfer:{findMany:async({where,select})=>db.transfers.filter(t=>match(t,where)).map(t=>pick(t,select))},
    importOperation:{findMany:async({where,select})=>db.downloads.filter(t=>match(t,where)).map(t=>pick(t,select))},
    auditLog:{create:async({data})=>{db.audits.push(data);return data;}},
  };
  prisma.$transaction=async work=>{db.tx+=1;const before=clone({groups:db.groups,members:db.members,audits:db.audits,states:[...db.states]});
    try{return await work(prisma);}catch(e){db.groups=before.groups;db.members=before.members;db.audits=before.audits;db.states=new Map(before.states);throw e;}};
  const access={prepared:[],prepare:async(_c,uids)=>{access.prepared.push([...uids]);},prepareSourceIdentity:async(_c,uids)=>{access.prepared.push([...uids]);},
    require:async(_c,uids)=>{if(uids.some(uid=>denied.includes(uid))){const {NotFoundException}=require('@nestjs/common');throw new NotFoundException('검사를 찾을 수 없습니다');}},
    assertUnsplitSource:(_c,uid)=>({sourcePatientId:PATIENT[uid]??null,sourceInstitution:'hallym'})};
  return {svc:new ExamMergeService(prisma,access),db,prisma,access};
}
const rulesOf=e=>(body(e)?.refusals??[]).map(r=>[r.uid,r.rule]);
const merged=(id,base,list,extra={})=>({groups:[{id,institutionId:'hallym',kind:'merge',baseUid:base,createdBy:'syn-tech',createdBySub:'syn-tech-sub',dissolvedAt:null,...extra}],
  members:list.map((uid,part)=>({groupId:id,logicalUid:uid,studyUid:uid,part,seriesUids:[]}))});
const G1='00000000-0000-4000-8000-00000000a001';

test('merge: three studies of one patient become one exam on the base; members, audit and new draft epochs in one transaction',async()=>{
  const {svc,db}=fixture();
  const out=await svc.merge(tech,{baseUid:B,uids:[C,A,B]});
  assert.equal(out.group.baseUid,B);
  assert.deepEqual(out.group.members.map(m=>[m.studyUid,m.part]),[[B,0],[A,1],[C,2]]);
  assert.equal(db.groups.length,1);assert.equal(db.groups[0].kind,'merge');assert.equal(db.groups[0].institutionId,'hallym');
  assert.deepEqual(db.members.map(m=>m.studyUid).sort(),[A,B,C]);
  // Locked once, in UID order, before anything was judged.
  assert.deepEqual(db.locks.map(l=>l.uids),[[A,B,C]]);
  assert.deepEqual(db.audits.map(a=>[a.action,a.target]),[['study.merge',B]]);
  assert.deepEqual(JSON.parse(db.audits[0].detail),{by:'hallym',group:out.group.id,base:B,studies:[B,A,C]});
  for(const uid of [A,B,C])assert.notEqual(db.states.get(uid).draftEpoch,state(uid).draftEpoch,'a screen of the old grouping cannot write');
  assert.equal(db.states.get(D).draftEpoch,state(D).draftEpoch);
});

test('merge refusals: different patients, empty patient ID, already merged, report written or approved, draft, live hold, transfer, export',async()=>{
  const cases=[
    [{},{baseUid:A,uids:[A,D]},[[null,'different-patients']]],
    [{},{baseUid:A,uids:[A,E]},[[E,'patient-unidentified']]],
    [merged(G1,A,[A,B]),{baseUid:C,uids:[C,B]},[[B,'grouped']]],
    [{states:[state(A,{rs:'T'}),state(B)]},{baseUid:B,uids:[A,B]},[[A,'reported']]],
    [{states:[state(A,{rs:'A'}),state(B)]},{baseUid:A,uids:[A,B]},[[A,'approved']]],
    [{states:[state(A,{rs:'D'}),state(B)]},{baseUid:A,uids:[A,B]},[[A,'destroyed']]],
    [{drafts:[{uid:B,author:'syn-reader',present:true}]},{baseUid:A,uids:[A,B]},[[B,'draft']]],
    [{states:[state(A,{holder:'syn-reader',heldAt:new Date()}),state(B)]},{baseUid:A,uids:[A,B]},[[A,'held']]],
    [{transfers:[{studyUid:B,status:'OPEN'}]},{baseUid:A,uids:[A,B]},[[B,'transfer']]],
    [{downloads:[{studyUid:A,kind:'download',status:'sending'}]},{baseUid:A,uids:[A,B]},[[A,'transfer']]],
  ];
  for(const [setup,request,expected] of cases){
    const {svc,db}=fixture(setup);
    const groups=db.groups.length;
    await assert.rejects(svc.merge(tech,request),e=>{
      assert.equal(status(e),409);assert.equal(body(e).code,EXAM_GROUP_REFUSED);
      assert.deepEqual(rulesOf(e),expected,JSON.stringify(request));return true;});
    assert.equal(db.groups.length,groups,'nothing is written');assert.equal(db.audits.length,0);
  }
  // A held hold that expired, a transfer that ended and a draft that was emptied do not refuse.
  const ok=fixture({states:[state(A,{holder:'syn-reader',heldAt:new Date(0)}),state(B)],transfers:[{studyUid:A,status:'IMPORTED'}],
    drafts:[{uid:A,author:'x',present:false}]});
  await ok.svc.merge(tech,{baseUid:A,uids:[A,B]});
});

test('merge: other institution, tele, unreadable or unknown study is not found; malformed requests and roles are refused',async()=>{
  for(const setup of [{states:[state(A),state(B,{institutionId:'kin-center',teleInstitutionId:'hallym'})]},{states:[state(A)]},{denied:[B]}]){
    const {svc,db}=fixture(setup);
    await assert.rejects(svc.merge(tech,{baseUid:A,uids:[A,B]}),e=>status(e)===404);
    assert.equal(db.groups.length,0);
  }
  const {svc}=fixture();
  for(const bad of [{},{baseUid:A,uids:[A]},{baseUid:A,uids:[B,C]},{baseUid:A,uids:[A,A]},{baseUid:A,uids:[A,'x']},{baseUid:A,uids:[A,B],extra:1},
    {baseUid:A,uids:[A,...Array.from({length:MERGE_LIMIT},(_,i)=>'2.25.9'+i)]}])
    await assert.rejects(svc.merge(tech,bad),e=>status(e)===400,JSON.stringify(bad));
  await assert.rejects(svc.merge(reader,{baseUid:A,uids:[A,B]}),e=>status(e)===403);
  await svc.merge({...reader,roles:['admin']},{baseUid:A,uids:[A,B]});
});

test('merge vs approval race: a report approved (or a draft opened) before the lock is seen under it and refuses',async()=>{
  const {svc,db}=fixture({onLock:db=>{db.states.get(B).rs='A';}});
  await assert.rejects(svc.merge(tech,{baseUid:A,uids:[A,B]}),e=>status(e)===409&&rulesOf(e).some(([u,r])=>u===B&&r==='approved'));
  assert.equal(db.groups.length,0);
  // Two merges of one study: the second, judged under the same row lock after the first committed, finds it merged.
  const two=fixture();
  await two.svc.merge(tech,{baseUid:A,uids:[A,B]});
  await assert.rejects(two.svc.merge(tech,{baseUid:C,uids:[C,B]}),e=>status(e)===409&&rulesOf(e).some(([u,r])=>u===B&&r==='grouped'));
  assert.equal(two.db.groups.length,1);
});

test('report scope: a merged member refuses every report write (409 STUDY_MERGED naming the base); the base covers all studies',async()=>{
  const {prisma}=fixture(merged(G1,B,[B,A,C]));
  await assert.rejects(examScope(prisma,A),e=>{assert.equal(status(e),409);assert.equal(body(e).code,STUDY_MERGED);assert.equal(body(e).baseUid,B);return true;});
  assert.deepEqual(await examScope(prisma,B),{groupId:G1,kind:'merge',baseUid:B,studies:[B,A,C]});
  assert.deepEqual(await examScope(prisma,D),{groupId:null,kind:null,baseUid:D,studies:[D]});
  // After Unmerge every study is its own exam again.
  const ended=fixture(merged(G1,B,[B,A,C],{dissolvedAt:new Date(),dissolvedBy:'syn-tech',dissolvedBySub:'syn-tech-sub'}));
  assert.deepEqual(await examScope(ended.prisma,A),{groupId:null,kind:null,baseUid:A,studies:[A]});
  assert.deepEqual(await activeGroups(ended.prisma,[A,B,C]),[]);
});

test('unmerge: ends the group (kept with who and when), new epochs, audit; images belong to each study again',async()=>{
  const {svc,db,prisma}=fixture({...merged(G1,B,[B,A,C]),states:[state(A),state(B,{rs:'T'}),state(C),state(D)]});
  const out=await svc.dissolve(tech,G1);
  assert.equal(out.group.id,G1);assert.ok(out.group.dissolvedAt);
  assert.equal(db.groups[0].dissolvedBy,'syn-tech');assert.ok(db.groups[0].dissolvedAt instanceof Date);
  assert.equal(db.members.length,3,'the members stay: a report written on the group keeps its source');
  assert.deepEqual(db.audits.map(a=>[a.action,a.target]),[['study.unmerge',B]]);
  for(const uid of [A,B,C])assert.notEqual(db.states.get(uid).draftEpoch,state(uid).draftEpoch);
  assert.deepEqual(await activeGroups(prisma,[A,B,C]),[]);
  await assert.rejects(svc.dissolve(tech,G1),e=>status(e)===409,'a second Unmerge');
});

test('unmerge refusals: an approved report now (Reset first), a draft, a live hold of another reader, a transfer; unknown group',async()=>{
  const cases=[
    [{states:[state(A),state(B,{rs:'A'})]},[[B,'approved']]],
    [{drafts:[{uid:B,author:'syn-reader',present:true}]},[[B,'draft']]],
    [{states:[state(A),state(B,{holder:'syn-reader',heldAt:new Date()})]},[[B,'held']]],
    [{transfers:[{studyUid:A,status:'ACCEPTED'}]},[[A,'transfer']]],
  ];
  for(const [setup,expected] of cases){
    const {svc,db}=fixture({...merged(G1,B,[B,A]),...setup});
    await assert.rejects(svc.dissolve(tech,G1),e=>{assert.equal(status(e),409);assert.deepEqual(rulesOf(e),expected);return true;});
    assert.equal(db.groups[0].dissolvedAt,null);
  }
  // After Reset (RS back to W) the same exam can be unmerged.
  const reset=fixture({...merged(G1,B,[B,A]),states:[state(A),state(B,{rs:'W'})]});
  await reset.svc.dissolve(tech,G1);
  const other=fixture({...merged(G1,B,[B,A],{institutionId:'kin-center'})});
  await assert.rejects(other.svc.dissolve(tech,G1),e=>status(e)===404);
  await assert.rejects(other.svc.dissolve(tech,'not-a-uuid'),e=>status(e)===404);
});

test('exam group read: the window gets the group and its checks (each ✓ or the reason), nothing changes',async()=>{
  const {svc,db}=fixture({...merged(G1,B,[B,A]),states:[state(A),state(B,{rs:'A'}),state(D)],transfers:[]});
  const out=await svc.group(tech,B);
  assert.equal(out.group.id,G1);
  assert.deepEqual(out.checks.map(c=>[c.rule,c.ok]),[['approved',false],['transfer',true],['held',true]]);
  assert.equal(db.audits.length,0);
  assert.deepEqual(await svc.group(tech,D),{group:null});
});

// ── the worklist: a merged exam is one row before paging ──
const qido=(uid,acc,count,series,patient='SYN-P1')=>({'0020000D':{Value:[uid]},'00080050':{Value:[acc]},'00080080':{Value:['hallym']},
  '00100020':{Value:[patient]},'00100010':{Value:['SYN^PATIENT']},'00080020':{Value:['20261114']},'00080061':{Value:['CT']},
  '00081030':{Value:['CT '+acc]},...(count===null?{}:{'00201208':{Value:[count]}}),'00201206':{Value:[series]}});
async function start(svc,prisma,names){
  const saved={institution:prisma.institution,order:prisma.order};
  prisma.institution={upsert:async()=>({}),findMany:async()=>clone(names)};
  prisma.order={...prisma.order,count:async()=>1,updateMany:async()=>({count:0})};
  const log=console.log;console.log=()=>{};
  try{await svc.onModuleInit();}finally{console.log=log;if(saved.order)prisma.order=saved.order;else delete prisma.order;if(saved.institution)prisma.institution=saved.institution;else delete prisma.institution;}
}
async function listFixture({rows=[qido(A,'ACC-A',8,1),qido(B,'ACC-B',8,1),qido(C,'ACC-C',4,2),qido(D,'ACC-D',3,1,'SYN-P2')],group=merged(G1,B,[B,A,C]),reports=[],extraStates=[]}={}){
  const states=[...rows.map(r=>({...state(r['0020000D'].Value[0]),origin:'dicom',createdAt:new Date('2020-01-01T00:00:00Z'),matched:'U',orderOid:null})),...extraStates];
  const project=(list,select)=>select?list.map(r=>Object.fromEntries(Object.keys(select).map(k=>[k,r[k]]))):list;
  const prisma={
    studyState:{findMany:async arg=>{let list=clone(states);if(arg?.where?.uid)list=list.filter(s=>arg.where.uid.in.includes(s.uid));
      else if(arg?.where?.institutionId)list=list.filter(s=>s.institutionId===arg.where.institutionId);return project(list,arg?.select);},
      create:async()=>{throw new Error('no create');},update:async()=>{throw new Error('no update');}},
    order:{findMany:async()=>[]},
    studyGroup:{findMany:async({where,select})=>(group?.groups??[]).filter(g=>match(g,where)).map(g=>pick(clone(g),select))},
    studyGroupMember:{findMany:async({where,select})=>(group?.members??[]).filter(m=>match(m,where)).map(m=>pick(clone(m),select))},
    report:{findMany:async({where})=>clone(reports).filter(r=>where.uid.in.includes(r.uid))},reportDraft:{findMany:async()=>[]},readerAssignment:{findMany:async()=>[]},
    studyAttachment:{groupBy:async()=>[],findMany:async()=>[],findFirst:async()=>null},gatewayReceipt:{findMany:async()=>[]},
    readingTemplate:{count:async()=>1,findMany:async()=>[]},userFilter:{findMany:async()=>[]},
    auditLog:{create:async()=>{throw new Error('no audit');}},$queryRaw:async()=>[],
  };
  const orthanc={studies:async()=>clone(rows),
    studyIdentities:async(meta,acc)=>clone(rows).map(r=>({'0020000D':r['0020000D'],'00080080':r['00080080'],
      ...(meta?{'00100020':r['00100020'],'00080020':r['00080020'],'00080061':r['00080061']}:{}),...(acc?{'00080050':r['00080050']}:{})})),
    studiesByUid:async uids=>uids.map(uid=>clone(rows).find(r=>r['0020000D'].Value[0]===uid))};
  const svc=new PacsService(prisma,orthanc,{},new StudyAccessService(prisma,orthanc,{}));
  await start(svc,prisma,[{id:'hallym',name:'hallym'}]);
  return svc;
}

test('worklist: a merged exam is its base row with every study\'s Count and Series and the studies it holds; Total counts exams',async()=>{
  const svc=await listFixture();
  const r=await svc.listStudies(reader);
  assert.deepEqual(r.studies.map(s=>s.uid),[B,D]);
  const base=r.studies.find(s=>s.uid===B);
  assert.equal(base.count,20);assert.equal(base.series,4);assert.equal(base.acc,'ACC-B');
  assert.deepEqual(base.group.members.map(m=>[m.uid,m.acc,m.count,m.series]),[[B,'ACC-B',8,1],[A,'ACC-A',8,1],[C,'ACC-C',4,2]]);
  assert.equal(base.group.id,G1);assert.equal(base.group.kind,'merge');
  assert.equal('group' in r.studies.find(s=>s.uid===D),false,'an ordinary row is unchanged');
  // Paged: two exams, one per page; the members never take a page row.
  const first=await svc.listStudies(reader,{limit:'1'});
  assert.equal(first.pagination.total,2);assert.deepEqual(first.studies.map(s=>s.uid),[B]);assert.equal(first.studies[0].count,20);
  const last=await svc.listStudies(reader,{limit:'1',after:first.pagination.next});
  assert.deepEqual(last.studies.map(s=>s.uid),[D]);assert.equal(last.pagination.next,null);
  // The EMR / clinician reads keep the original studies.
  const original=await svc.worklistConcern.selectStudies(reader,undefined);
  assert.deepEqual(original.body.studies.map(s=>s.uid).sort(),[A,B,C,D]);
});

test('worklist: a merged study whose Count is unknown makes the exam\'s Count unknown; without a group nothing changes',async()=>{
  const unknown=await listFixture({rows:[qido(A,'ACC-A',null,1),qido(B,'ACC-B',8,1),qido(C,'ACC-C',4,2),qido(D,'ACC-D',3,1,'SYN-P2')]});
  const base=(await unknown.listStudies(reader)).studies.find(s=>s.uid===B);
  assert.equal(base.count,null);assert.equal(base.series,4);
  const plain=await listFixture({group:null});
  assert.deepEqual((await plain.listStudies(reader)).studies.map(s=>s.uid).sort(),[A,B,C,D]);
  // Ended groups are not read as merged.
  const ended=await listFixture({group:merged(G1,B,[B,A,C],{dissolvedAt:new Date()})});
  assert.deepEqual((await ended.listStudies(reader)).studies.map(s=>s.uid).sort(),[A,B,C,D]);
});

test('worklist: a caller who cannot see every study of a merged exam gets the original rows',async()=>{
  // C is not in this caller's list (another hospital's resource here): the exam is not shown merged.
  const svc=await listFixture({rows:[qido(A,'ACC-A',8,1),qido(B,'ACC-B',8,1),qido(D,'ACC-D',3,1,'SYN-P2')]});
  const r=await svc.listStudies(reader);
  assert.deepEqual(r.studies.map(s=>s.uid).sort(),[A,B,D]);
  assert.equal(r.studies.some(s=>'group' in s),false);
});

// ── the report's exam group: a draft written on a merged exam carries it; text moved by Reset keeps its own ──
const {PacsReportDraft}=require('/app/dist/pacs/report-draft');
test('drafts carry the exam group they were written on (the study\'s current one), and an emptied draft carries none',async()=>{
  const {prisma}=fixture(merged(G1,B,[B,A]));
  const writes=[];
  const tx={...prisma,reportDraft:{create:async({data})=>{writes.push(data);return {...data};},
    updateMany:async({data})=>{writes.push(data);return {count:1};},findUnique:async()=>({revision:2})}};
  const drafts=Object.create(PacsReportDraft.prototype);
  const text={findings:'f',conclusion:'',recommendation:'',baseVersion:0,citations:[],structured:[]};
  await drafts.storeDraft(tx,B,'syn-reader',null,text);
  assert.equal(writes.at(-1).groupId,G1);
  await drafts.storeDraft(tx,D,'syn-reader',null,text);
  assert.equal(writes.at(-1).groupId,null);
  await drafts.storeDraft(tx,B,'syn-reader',{revision:1,present:true,workUnit:'disposal:x',workSince:new Date()},null);
  assert.equal(writes.at(-1).groupId,null);assert.equal(writes.at(-1).present,false);
  // Reset moving another reader's saved text into that reader's draft keeps the text's own group.
  await drafts.storeDraft(tx,B,'syn-other',null,text,'approve',null);
  assert.equal(writes.at(-1).groupId,null);
  // A merged member has no draft of its own while merged.
  await assert.rejects(drafts.storeDraft(tx,A,'syn-reader',null,text),e=>body(e)?.code===STUDY_MERGED);
});

test('worklist read (GET studies): the merged exam row is listed alone and each of its studies is recorded as read', async () => {
  const svc = await listFixture();
  const read = await svc.readStudies(reader);
  const body = JSON.parse(read.json);
  assert.deepEqual(body.studies.map(s => s.uid), [B, D]);
  const at = body.studies.findIndex(s => s.uid === B);
  const metadata = read.sources.filter(s => s.target.kind === 'study-metadata').map(s => [s.target.studyId.value, JSON.stringify(s.path)]);
  assert.deepEqual(metadata.filter(([uid]) => [A, B, C].includes(uid)).sort(), [
    [A, JSON.stringify(['studies', at, 'group', 'members', 1])], [B, JSON.stringify(['studies', at])],
    [C, JSON.stringify(['studies', at, 'group', 'members', 2])]].sort());
  const member = read.sources.find(s => s.target.studyId.value === A);
  assert.equal(member.target.sourcePatientId.value, 'SYN-P1');
});
test('worklist: a report written on a merged exam says so after Unmerge, and its text is withheld from a caller who cannot read every study of it', async () => {
  const ended = merged(G1, B, [B, A], { dissolvedAt: new Date(), dissolvedBy: 'syn-tech', dissolvedBySub: 'syn-tech-sub' });
  const report = { uid: B, findings: 'SYN MERGED FINDINGS', conclusion: 'SYN', recommendation: '', version: 1, updatedBy: 'syn-reader', groupId: G1 };
  const open = await listFixture({ group: ended, reports: [report] });
  const row = (await open.listStudies(reader)).studies.find(s => s.uid === B);
  assert.deepEqual(row.reportGroup, { id: G1, active: false, readable: true, studies: [B, A] });
  assert.equal(row.state.findings, 'SYN MERGED FINDINGS');
  // A's row is another hospital's now (this caller no longer reads it): B's text written on both is withheld, B's row stays.
  const closed = await listFixture({ group: ended, reports: [report], rows: [qido(B, 'ACC-B', 8, 1), qido(D, 'ACC-D', 3, 1, 'SYN-P2')],
    extraStates: [{ ...state(A), institutionId: 'kin-center' }] });
  const hidden = (await closed.listStudies(reader)).studies.find(s => s.uid === B);
  assert.deepEqual(hidden.reportGroup, { id: G1, active: false, readable: false, studies: [] });
  assert.deepEqual([hidden.state.findings, hidden.state.conclusion, hidden.state.version], ['', '', 1]);
  // A report of the study alone keeps its row shape (no reportGroup key).
  const plain = await listFixture({ group: null, reports: [{ ...report, groupId: null }] });
  assert.equal('reportGroup' in (await plain.listStudies(reader)).studies.find(s => s.uid === B), false);
});
