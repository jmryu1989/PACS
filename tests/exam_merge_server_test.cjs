// Merge Exam / Unmerge server: the compiled ExamMergeService over an in-memory store (every refusal, the locked
// re-check, the audit row, the new draft epochs, Unmerge's own refusals), the report scope a merged member and its base get,
// and the compiled PacsService.listStudies turning a merged exam into one row before paging (Count / Series of all its studies,
// Total and pages of exams, an unknown count, a caller who cannot see every study). Runs inside kin-api:ci; no network.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {ExamMergeService,activeGroups,STUDY_MERGED,EXAM_GROUP_REFUSED,MERGE_LIMIT}=require('/app/dist/exam-merge.service');
const {PacsService}=require('/app/dist/pacs.service');
const {StudyAccessService}=require('/app/dist/study-access.service');
const {resolveExamScope}=require('/app/dist/exam-merge.service');

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
    institution:{findMany:async()=>[{id:'hallym',name:'hallym',dicomNames:''}]},
    studyState:{create:async({data})=>{const row=state(data.uid,data);db.states.set(data.uid,row);return row;},findUnique:async({where})=>clone(db.states.get(where.uid)??null),
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
  const access={prepared:[],prepare:async(_c,uids=[])=>{access.prepared.push([...uids]);},prepareSourceIdentity:async(_c,uids)=>{access.prepared.push([...uids]);},
    require:async(_c,uids)=>{if(uids.some(uid=>denied.includes(uid))){const {NotFoundException}=require('@nestjs/common');throw new NotFoundException('검사를 찾을 수 없습니다');}},
    assertUnsplitSource:(_c,uid)=>({sourcePatientId:PATIENT[uid]??null,sourceInstitution:'hallym'}),
    assertIdentifiedSource:(_c,uid)=>({sourcePatientId:PATIENT[uid]??null,sourceInstitution:'hallym'}),
    requireSourceOwner:async()=>{},sourceSeries:async()=>[{uid:'2.25.701',count:3},{uid:'2.25.702',count:5}]};
  return {svc:new ExamMergeService(prisma,access),db,prisma,access};
}
const rulesOf=e=>(body(e)?.refusals??[]).map(r=>[r.uid,r.rule]);
const merged=(id,base,list,extra={})=>({groups:[{id,institutionId:'hallym',kind:'merge',baseUid:base,createdBy:'syn-tech',createdBySub:'syn-tech-sub',dissolvedAt:null,...extra}],
  members:list.map((uid,part)=>({groupId:id,logicalUid:uid,studyUid:uid,part,seriesUids:[]}))});
const G1='00000000-0000-4000-8000-00000000a001';

test('tele changes all original channels atomically and closes every receiving assignment on cancellation', async () => {
  const { PacsStudyState } = require('/app/dist/pacs/study-state');
  const { PacsAccess } = require('/app/dist/pacs/access');
  const f = fixture(merged(G1, B, [B, A]));
  f.prisma.report = { findUnique: async () => null };
  f.prisma.reportDraft.findUnique = async () => null;
  f.prisma.readerAssignment = { findMany: async () => [], findUnique: async () => null, create: async ({ data }) => data };
  const query = f.prisma.$queryRaw;
  f.prisma.$queryRaw = async (strings, ...values) => strings.join('').includes('FOR NO KEY UPDATE')
    ? [f.db.states.get(values[0])] : query(strings, ...values);
  const unit = new PacsStudyState(f.prisma, f.access, new PacsAccess(f.prisma, f.access), { institutions: [{ id: 'remote' }] }, {});
  const closed = [], workflow = { tx: f.prisma, record: async () => {}, closeAssignment: async uid => closed.push(uid) };
  await unit.patchState(B, { ts: 'wait', teleTo: 'remote' }, reader);
  assert.deepEqual([A, B].map(uid => [f.db.states.get(uid).ts, f.db.states.get(uid).teleInstitutionId]), [['wait', 'remote'], ['wait', 'remote']]);
  assert.deepEqual(f.db.locks[0].uids, [A, B]);
  f.db.states.get(A).ts = 'completed';
  await assert.rejects(unit.patchState(B, { ts: 'cancelled' }, reader), e => status(e) === 400);
  assert.equal(f.db.states.get(B).ts, 'wait');
  f.db.states.get(A).ts = 'wait';
  await unit.patchState(B, { ts: 'cancelled' }, reader, workflow);
  assert.deepEqual(closed.sort(), [A, B]);
  assert.ok([A, B].every(uid => f.db.states.get(uid).teleInstitutionId === null));
});

test('source correction refuses active or preserved report scopes, but an empty dissolved group does not block correction', async () => {
  const { PacsStudyState } = require('/app/dist/pacs/study-state');
  const { PacsAccess } = require('/app/dist/pacs/access');
  for (const [active, preserved] of [[true, false], [false, true], [false, false]]) {
    const f = fixture(merged(G1, A, [A, B], { dissolvedAt: active ? null : new Date() }));
    f.prisma.report = { findUnique: async () => null };
    f.prisma.reportDraft.findUnique = async () => null;
    f.prisma.reportDraft.findFirst = async () => null;
    f.prisma.reportVersion = { findFirst: async () => preserved ? { uid: A, groupId: G1 } : null };
    f.prisma.reportDraftPurposeEnd = { findFirst: async () => null };
    const unit = new PacsStudyState(f.prisma, f.access, new PacsAccess(f.prisma, f.access), {}, {});
    const write = () => unit.patchState(B, { ov: { name: 'SYN corrected' } }, tech);
    if (active || preserved) {
      await assert.rejects(write(), e => status(e) === 409);
      assert.equal(f.db.states.get(B).ov, undefined);
    } else assert.equal((await write()).ov.name, 'SYN corrected');
  }
});

test('film layout selects originals across a merge and only the permitted series in each split part', async () => {
  const { FilmPrintService } = require('/app/dist/film-print.service');
  const f = fixture(merged(G1, A, [A, B]));
  f.prisma.studyAttachment = { findMany: async () => [] };
  const orthanc = {
    filmStudy: async uid => ({ id: uid, series: ['2.25.701', '2.25.702'].map((seriesUid, i) => ({ id: uid + '.' + i,
      uid: seriesUid, number: i, description: 'SYN', modality: 'CT', instances: ['SYN-instance'] })) }),
    filmInstances: async id => [{ id, sop: '2.25.703', number: '1', frames: '1' }], filmWindow: async () => ({ center: '', width: '' }),
  };
  const svc = new FilmPrintService(f.prisma, orthanc, { listStudies: async (_c, q) => ({ studies: [{ uid: q.uids }] }) }, f.access);
  const input = { studyUid: A, format: '1x1', filmSize: '14INX17IN', orientation: 'PORTRAIT' };
  const mergedLayout = await svc.layout({ ...input, sourceUid: B, seriesUid: '2.25.701' }, reader);
  assert.equal(mergedLayout.sourceUid, B); assert.deepEqual(mergedLayout.scope.sources.map(s => s.studyUid), [A, B]);
  assert.deepEqual([...new Set(mergedLayout.series.map(s => s.sourceUid))], [A, B]);
  f.db.groups = []; f.db.members = [];
  const made = await f.svc.split(tech, { uid: A, seriesUids: ['2.25.701'] });
  const second = made.group.members.find(m => m.part === 1).logicalUid;
  assert.deepEqual((await svc.layout(input, reader)).series.map(s => s.uid), ['2.25.702']);
  assert.deepEqual((await svc.layout({ ...input, studyUid: second }, reader)).series.map(s => [s.sourceUid, s.uid]), [[A, '2.25.701']]);
  await assert.rejects(svc.layout({ ...input, studyUid: second, seriesUid: '2.25.702' }, reader), e => status(e) === 404);
});

test('source links retain original keys and expose both split reports and a dissolved merged report',async()=>{
  const {examLinks,currentExamStates}=require('/app/dist/exam-merge.service');
  const f=fixture(merged(G1,A,[A,B]));
  assert.deepEqual((await currentExamStates(f.prisma,f.access,reader,[...f.db.states.values()])).states.map(s=>s.uid).sort(),[A,C,D,E,F].sort());
  const links=await examLinks(f.prisma,f.access,reader,[A,B]);
  assert.deepEqual(links.map(x=>x.uid),[A,B]);
  assert.ok(links.every(x=>x.exams.some(e=>e.reportUid===A&&e.groupId===G1)));
  f.db.groups[0].dissolvedAt=new Date();
  assert.equal((await examLinks(f.prisma,f.access,reader,[B]))[0].exams.find(e=>e.groupId===G1).active,false);
  const split=fixture();const made=await split.svc.split(tech,{uid:A,seriesUids:['2.25.701']});
  const parts=(await examLinks(split.prisma,split.access,reader,[A]))[0].exams.filter(e=>e.groupId===made.group.id);
  assert.deepEqual(parts.map(e=>e.part).sort(),[0,1]);
  assert.deepEqual(parts.map(e=>e.sources[0].series.mode).sort(),['exclude','include']);
});

test('favorites and tags keep their original keys, count current split exams and retain retired report links separately', async () => {
  const { FavoriteService } = require('/app/dist/favorite.service');
  const { StudyTagsService } = require('/app/dist/study-tags.service');
  const f = fixture(), made = await f.svc.split(tech, { uid: A, seriesUids: ['2.25.701'] });
  const parts = made.group.members.map(m => m.logicalUid).sort();
  const saved = { revision: 1, value: JSON.stringify([{ id: G1, name: 'SYN folder', uids: [A] }]) };
  f.prisma.favoriteWorkspace = { findUnique: async () => saved };
  f.prisma.studyTagCatalog = { findMany: async () => [{ ...saved, ownerSub: reader.sub }] };
  f.access.snapshot = async () => ({ policy: { restricted: false } });
  f.prisma.$queryRaw = async query => (query.sql ?? query.join('')).includes('FavoriteWorkspace') ? [saved] : [{ uid: A }];
  const favorites = new FavoriteService(f.prisma, {}, f.access), tags = new StudyTagsService(f.prisma, f.access);
  const read = async () => [(await favorites.read(reader)).folders[0], (await tags.read(reader)).catalogs[0].tags[0]];
  for (const item of await read()) {
    assert.deepEqual(item.uids, [A]); assert.deepEqual([...item.examUids].sort(), parts);
  }
  f.db.groups[0].dissolvedAt = new Date();
  for (const item of await read()) {
    assert.deepEqual(item.uids, [A]); assert.deepEqual(item.examUids, [A]);
    assert.equal(item.links[0].exams.filter(exam => exam.groupId === made.group.id && !exam.active).length, 2);
  }
  assert.deepEqual(JSON.parse(saved.value)[0].uids, [A]);
});

test('preview selects stored text, private text and every permitted original key by the saved series scope',async()=>{
  const {ReportPreviewController}=require('/app/dist/report-preview.controller');
  const f=fixture(merged(G1,A,[A,B]));
  const report={uid:A,version:1,groupId:G1,findings:'SYN SAVED',conclusion:'',recommendation:''};
  f.prisma.report={findUnique:async()=>report};
  f.prisma.reportVersion={findUnique:async()=>({...report,id:10,action:'approve'})};
  f.prisma.reportDraft={findUnique:async()=>({...report,present:true,revision:2,findings:'SYN PRIVATE',version:undefined})};
  f.prisma.viewerItem={findMany:async()=>[A,B].map((studyUid,i)=>({id:'key-'+i,studyUid,revision:1,snapshot:{kind:'key',seriesUid:'2.25.701'}}))};
  const controller=new ReportPreviewController(f.prisma,{reportPreviewStudy:async()=>qido(A,'ACC-A',3,1)},f.access,{});
  const saved=await controller.read(A,{...reader,query:{}}),body=JSON.parse(saved.json);
  assert.equal(body.report.findings,'SYN SAVED');assert.deepEqual(body.keys.map(x=>x.sourceUid),[A,B]);
  assert.deepEqual(saved.sources.filter(x=>x.target.kind==='key-image').map(x=>x.target.studyId.value),[A,B]);
  assert.equal(JSON.parse((await controller.read(A,{...reader,query:{draft:'1'}})).json).report.findings,'SYN PRIVATE');
  await assert.rejects(controller.read(A,{...reader,query:{generation:'stale'}}),e=>bodyOf(e)?.code==='EXAM_SCOPE_CHANGED');
  f.db.states.get(B).institutionId='other';
  await assert.rejects(controller.read(A,{...reader,query:{}}),e=>status(e)===404);
  function bodyOf(error){return error.getResponse?.();}
});

test('split preview excludes the other part and exposes the actual source UID for selected keys',async()=>{
  const {ReportPreviewController}=require('/app/dist/report-preview.controller');
  const f=fixture();const made=await f.svc.split(tech,{uid:A,seriesUids:['2.25.701']});
  const part=made.group.members.find(m=>m.part===1).logicalUid;
  f.prisma.report={findUnique:async()=>null};f.prisma.viewerItem={findMany:async()=>['2.25.701','2.25.702'].map((seriesUid,i)=>({id:'key-'+i,studyUid:A,revision:1,snapshot:{kind:'key',seriesUid}}))};
  const controller=new ReportPreviewController(f.prisma,{reportPreviewStudy:async uid=>{assert.equal(uid,A);return qido(A,'ACC-A',8,2);}},f.access,{});
  const first=JSON.parse((await controller.read(A,{...reader})).json),second=JSON.parse((await controller.read(part,{...reader})).json);
  assert.deepEqual(first.keys.map(k=>k.item.seriesUid),['2.25.702']);
  assert.deepEqual(second.keys.map(k=>[k.sourceUid,k.item.seriesUid]),[[A,'2.25.701']]);
});

test('stored scope refuses a missing group instead of reading the study alone',async()=>{
  const {prisma,access}=fixture();
  await assert.rejects(resolveExamScope(prisma,access,reader,{uid:A,purpose:'stored',record:{groupId:G1}}),e=>status(e)===409);
});

test('stored null and an explicit source remain originals while current work covers the merged exam',async()=>{
  const f=fixture(merged(G1,A,[A,B]));
  for(const request of [{uid:A,purpose:'stored',record:{groupId:null}},{uid:B,purpose:'source'}]){
    const scope=await resolveExamScope(f.prisma,f.access,reader,request);
    assert.equal(scope.groupId,null);assert.deepEqual(scope.studies,[request.uid]);
  }
  assert.deepEqual((await resolveExamScope(f.prisma,f.access,reader,{uid:A,purpose:'current'})).studies,[A,B]);
});

test('scope generation refuses a merge-unmerge round trip even when the original UID returns',async()=>{
  const f=fixture();
  const prepared=await resolveExamScope(f.prisma,f.access,reader,{uid:A,purpose:'current',phase:'prepare'});
  const merged=await f.svc.merge(tech,{baseUid:A,uids:[A,B]});
  await f.svc.dissolve(tech,merged.group.id);
  await assert.rejects(resolveExamScope(f.prisma,f.access,reader,{uid:A,purpose:'current',phase:'write',prepared}),e=>body(e)?.code==='EXAM_SCOPE_CHANGED');
});

test('the source identity fixed at grouping refuses a later change shared by every original',async()=>{
  const f=fixture();await f.svc.merge(tech,{baseUid:A,uids:[A,B]});
  f.access.assertIdentifiedSource=()=>({sourcePatientId:'SYN-REPLACED',sourceInstitution:'hallym'});
  await assert.rejects(resolveExamScope(f.prisma,f.access,reader,{uid:A,purpose:'current'}),e=>body(e)?.code==='EXAM_SCOPE_CHANGED');
});

test('tele callers see the same exam only while every original is assigned, but cannot dissolve it',async()=>{
  const f=fixture({...merged(G1,A,[A,B]),states:[state(A,{teleInstitutionId:'remote'}),state(B,{teleInstitutionId:'remote'})]});
  const remote={...tech,institution:'remote'};
  const group=await f.svc.group(remote,A);
  assert.equal(group.group.id,G1);assert.equal(group.checks.find(c=>c.rule==='owner').ok,false);
  assert.equal((await f.svc.scope(remote,A)).groupId,G1);
  await assert.rejects(f.svc.dissolve(remote,G1),e=>status(e)===404);
  f.db.states.get(B).teleInstitutionId=null;
  await assert.rejects(f.svc.scope(remote,A),e=>status(e)===404);
  await assert.rejects(f.svc.group(remote,A),e=>status(e)===404);
});

test('hold and renewal reject a hidden member and a partially revoked current group without changing holders',async()=>{
  const {PacsHold}=require('/app/dist/pacs/hold');
  for(const denied of [[],[B]]){
    const f=fixture({...merged(G1,A,[A,B]),denied});
    const hold=new PacsHold(f.prisma,f.access,{});
    for(const renew of [false,true])await assert.rejects(hold.hold(denied.length?A:B,reader,{renew}),e=>denied.length?status(e)===404:body(e)?.code===STUDY_MERGED);
    assert.equal(f.db.states.get(A).holder,null);assert.equal(f.db.states.get(B).holder,null);
    assert.equal(f.db.audits.length,0);
  }
});

test('scope write locks all originals and refuses a grouping changed after preparation',async()=>{
  const f=fixture(merged(G1,B,[B,A,C]));
  const prepared=await resolveExamScope(f.prisma,f.access,reader,{uid:B,purpose:'current',phase:'prepare'});
  f.db.groups[0].dissolvedAt=new Date();
  await assert.rejects(resolveExamScope(f.prisma,f.access,reader,{uid:B,purpose:'current',phase:'write',prepared}),e=>body(e)?.code==='EXAM_SCOPE_CHANGED');
  assert.deepEqual(f.db.locks.at(-1).uids,[A,B,C]);
});

test('stored scope retains Split series rules and never becomes current after Unsplit',async()=>{
  const f=fixture({groups:[{id:G1,institutionId:'hallym',kind:'split',baseUid:A,dissolvedAt:new Date()}],
    states:[state(A),state(B)],members:[{groupId:G1,logicalUid:A,studyUid:A,part:0,seriesUids:[]},
      {groupId:G1,logicalUid:B,studyUid:A,part:1,seriesUids:['2.25.701']}]});
  const a=await resolveExamScope(f.prisma,f.access,reader,{uid:A,purpose:'stored',record:{groupId:G1}});
  const b=await resolveExamScope(f.prisma,f.access,reader,{uid:B,purpose:'stored',record:{groupId:G1}});
  assert.deepEqual(a.sources,[{studyUid:A,series:{mode:'exclude',uids:['2.25.701']}}]);
  assert.deepEqual(b.sources,[{studyUid:A,series:{mode:'include',uids:['2.25.701']}}]);
  assert.equal(b.reportUid,B);assert.equal(b.active,false);
  await assert.rejects(resolveExamScope(f.prisma,f.access,reader,{uid:B,purpose:'current'}),e=>body(e)?.code==='EXAM_SCOPE_CHANGED');
});

test('Split creates independent report parents, keeps series ownership on later arrival, and Unsplit preserves both parents',async()=>{
  const f=fixture();
  const out=await f.svc.split(tech,{uid:A,seriesUids:['2.25.701']});
  const second=out.group.members.find(m=>m.part===1).logicalUid;
  assert.notEqual(second,A);assert.equal(f.db.states.get(second).rs,'W');
  const firstScope=await resolveExamScope(f.prisma,f.access,reader,{uid:A,purpose:'current'});
  const secondScope=await resolveExamScope(f.prisma,f.access,reader,{uid:second,purpose:'current'});
  const {scopeIncludesSeries}=require('/app/dist/exam-merge.service');
  for(const series of ['2.25.701','2.25.702','2.25.703']) {
    assert.equal(scopeIncludesSeries(firstScope,A,series),series!=='2.25.701');
    assert.equal(scopeIncludesSeries(secondScope,A,series),series==='2.25.701');
  }
  const writes=[];
  f.prisma.reportDraft.create=async({data})=>{writes.push(clone(data));return data;};
  const drafts=Object.create(PacsReportDraft.prototype);
  drafts.studyAccess=f.access;
  for(const uid of [A,second])await drafts.storeDraft(f.prisma,uid,reader.actor,null,
    {findings:uid,conclusion:'',recommendation:'',baseVersion:0,citations:[],structured:[]},'approve',undefined,reader);
  assert.deepEqual(writes.map(d=>[d.uid,d.groupId]),[[A,out.group.id],[second,out.group.id]]);
  f.db.states.get(second).rs='A';
  await assert.rejects(f.svc.dissolve(tech,out.group.id),e=>rulesOf(e).some(([uid,rule])=>uid===second&&rule==='approved'));
  f.db.states.get(second).rs='W';
  await f.svc.dissolve(tech,out.group.id);
  assert.ok(f.db.states.has(second),'Unsplit never deletes a report parent');
  assert.equal((await resolveExamScope(f.prisma,f.access,reader,{uid:second,purpose:'stored',record:{groupId:out.group.id}})).part,1);
  assert.deepEqual(f.db.audits.map(a=>a.action),['study.split','study.unsplit']);
});

test('Split refuses empty, duplicate, whole and absent series, foreign access, holds, drafts and source transfers without writes',async()=>{
  for(const seriesUids of [[],['2.25.701','2.25.701'],['2.25.701','2.25.702'],['2.25.799']]){
    const f=fixture();await assert.rejects(f.svc.split(tech,{uid:A,seriesUids}),e=>status(e)===400);
    assert.equal(f.db.groups.length,0);assert.equal(f.db.audits.length,0);
  }
  for(const setup of [{denied:[A]},{states:[state(A,{institutionId:'other'})]},
    {states:[state(A,{holder:'other',heldAt:new Date()})]},{drafts:[{uid:A,present:true}]},
    {transfers:[{studyUid:A,status:'OPEN'}]}]){
    const f=fixture(setup);await assert.rejects(f.svc.split(tech,{uid:A,seriesUids:['2.25.701']}),e=>[404,409].includes(status(e)));
    assert.equal(f.db.groups.length,0);
  }
});

test('stored scope evaluates every original on the supplied transaction after partial tele or policy revocation',async()=>{
  const f=fixture({...merged(G1,A,[A,B]),states:[state(A,{teleInstitutionId:'remote'}),state(B,{teleInstitutionId:'remote'})]});
  const remote={...reader,institution:'remote'};
  const calls=[];const tx={...f.prisma};
  f.access.require=async(_c,uids,db)=>{calls.push({uids,db});};
  f.access.requireSourceOwner=async(_c,_uid,_owner,db)=>{assert.equal(db,tx);};
  assert.deepEqual((await resolveExamScope(tx,f.access,remote,{uid:A,purpose:'stored',record:{groupId:G1}})).studies,[A,B]);
  assert.ok(calls.every(call=>call.db===tx));
  assert.deepEqual(calls[0].uids,[A,B]);
  f.db.states.get(B).teleInstitutionId=null;
  await assert.rejects(resolveExamScope(tx,f.access,remote,{uid:A,purpose:'stored',record:{groupId:G1}}),e=>status(e)===404);
  const denied=fixture({...merged(G1,A,[A,B]),denied:[B]});
  await assert.rejects(resolveExamScope(denied.prisma,denied.access,reader,{uid:A,purpose:'current'}),e=>status(e)===404);
});

test('a group cannot be read or written after an original disappears, becomes ambiguous, unidentified, or changes patient or owner',async()=>{
  for(const alteration of ['missing','ambiguous','empty','patient','owner','institution']){
    const f=fixture(merged(G1,A,[A,B]));
    const original=f.prisma.$queryRaw;
    f.prisma.$queryRaw=async(strings,...values)=>strings.join('').includes('StudyAccessPolicy')?[]:original(strings,...values);
    const resources=uid=>uid===B&&alteration==='missing'?[]:
      Array.from({length:uid===B&&alteration==='ambiguous'?2:1},()=>qido(uid,'SYN',3,1,
        uid===B&&alteration==='empty'?'':uid===B&&alteration==='patient'?'SYN-OTHER':'SYN-P1'));
    if(alteration==='owner')f.db.states.get(B).institutionId='other';
    const access=new StudyAccessService(f.prisma,{studyIdentityResources:async uid=>{
      const rows=resources(uid);if(uid===B&&alteration==='institution')for(const row of rows)row['00080080']={Value:['other']};return rows;
    }},{});
    const {prepareExamRead}=require('/app/dist/exam-merge.service');
    await prepareExamRead(f.prisma,access,reader,A);
    await assert.rejects(resolveExamScope(f.prisma,access,reader,{uid:A,purpose:'current'}),e=>[404,409].includes(status(e)),alteration);
    assert.equal(f.db.audits.length,0);
  }
});

test('ended draft purpose keeps the payload original scope, including a split report target',async()=>{
  const saved=[];const tx={reportDraftPurposeEnd:{create:async({data})=>saved.push(data)}};
  const drafts=Object.create(PacsReportDraft.prototype);
  const row={uid:B,author:reader.actor,revision:7,present:true,workUnit:'disposal:synthetic',workSince:new Date(0),
    workIntent:'approve',findings:'SYN TEXT',conclusion:'',recommendation:'',baseVersion:3,groupId:G1};
  await drafts.endWork(tx,row,reader.actor,{trigger:'explicit-discard'});
  assert.equal(saved[0].groupId,G1);assert.equal(saved[0].uid,B);assert.equal(saved[0].findings,row.findings);
});

test('citations and structured evidence apply the saved scope of each head, draft and version before returning values',async()=>{
  const {PacsReportEvidence}=require('/app/dist/pacs/report-evidence');
  const {PacsAccess}=require('/app/dist/pacs/access');
  for(const surface of ['head','draft','version'])for(const method of surface==='version'?['reportVersionCitations']:['reportCitations','reportStructure']){
    const f=fixture({...merged(G1,A,[A,B],{dissolvedAt:new Date()}),denied:[B]});
    f.prisma.report={findUnique:async()=>({uid:A,version:1,groupId:surface==='head'?G1:null})};
    f.prisma.reportDraft.findUnique=async()=>({uid:A,author:reader.actor,present:true,revision:1,groupId:surface==='draft'?G1:null});
    f.prisma.reportVersion={findUnique:async()=>({uid:A,version:1,groupId:surface==='version'?G1:null,citations:[],structured:[]})};
    const unit=new PacsReportEvidence(f.prisma,f.access,{readableFindings:async()=>[]},new PacsAccess(f.prisma,f.access));
    await assert.rejects(surface==='version'?unit[method](A,'1',reader):unit[method](A,reader),e=>status(e)===404,surface+' '+method);
  }
});

test('Reset checks the preserved head before copying text from an ended group',async()=>{
  const {PacsReportCommit}=require('/app/dist/pacs/report-commit');
  const f=fixture({...merged(G1,A,[A,B],{dissolvedAt:new Date()}),denied:[B]});
  const unit=new PacsReportCommit({},f.access,{citationKeys:()=>[],structureKeys:()=>[]},{
    settleEnding:async fn=>fn(),ownDraft:async()=>null,
    draftTransaction:async(_uid,_c,_session,_epoch,_prepare,work)=>work(f.prisma,f.db.states.get(A),async()=>{})});
  unit.lockHead=async()=>({uid:A,version:1,findings:'SYN PRESERVED',conclusion:'',recommendation:'',updatedBy:reader.actor,groupId:G1});
  await assert.rejects(unit.commitReport(A,{action:'reset',reason:'SYN',baseVersion:1,
    expectedOwner:{institution:reader.institution,sub:reader.sub,author:reader.actor},expectedRevision:f.db.states.get(A).draftEpoch+':0'},reader,null,{}),e=>status(e)===404);
  assert.equal(f.db.updates.length,0);assert.equal(f.db.audits.length,0);
});

test('draft GET checks the draft saved scope after Unmerge even when the current report is of the original alone',async()=>{
  const {PacsAccess}=require('/app/dist/pacs/access');
  for(const revoked of [false,true]){
    const f=fixture({...merged(G1,A,[A,B],{dissolvedAt:new Date()}),denied:revoked?[B]:[]});
    f.prisma.reportDraft.findUnique=async()=>({uid:A,author:reader.actor,present:true,revision:1,groupId:G1,
      findings:'SYN PRESERVED',conclusion:'',recommendation:'',baseVersion:0,citations:null,structured:null});
    const unit=new PacsReportDraft(f.prisma,f.access,new PacsAccess(f.prisma,f.access),{}, {}, {});
    unit.recorded=async(_uid,_c,_observation,work)=>work(f.prisma,async()=>{});
    if(revoked)await assert.rejects(unit.readDraft(A,reader,{}),e=>status(e)===404);
    else assert.equal((await unit.readDraft(A,reader,{})).snapshot.findings,'SYN PRESERVED');
  }
});

test('state deletion refuses both active and ended group references under the original parent lock',async()=>{
  const {PacsStudyState}=require('/app/dist/pacs/study-state');
  for(const dissolvedAt of [null,new Date()]){
    const f=fixture(merged(G1,A,[A,B],{dissolvedAt}));
    f.prisma.studyGroupMember.findFirst=async({where})=>f.db.members.find(m=>match(m,where));
    let deleted=false;
    f.prisma.studyState.delete=async()=>{deleted=true;};
    for(const name of ['reportDraftPurposeEnd','viewerItem','techNoteRevision','viewerJob','studyQuestion','studyImageRequest','criticalResult','reportVersion'])
      f.prisma[name]={findFirst:async()=>null};
    Object.assign(f.prisma.reportDraft,{findFirst:async()=>null,deleteMany:async()=>({count:0})});
    f.prisma.readerAssignment={findMany:async()=>[]};
    const query=f.prisma.$queryRaw;
    f.prisma.$queryRaw=async(strings,...values)=>strings.join('').includes('FOR NO KEY UPDATE')?[f.db.states.get(A)]:query(strings,...values);
    const unit=Object.assign(Object.create(PacsStudyState.prototype),{prisma:f.prisma,studyAccess:f.access,
      access:{gate:async()=>f.db.states.get(A),visible:(s,c)=>s.institutionId===c}});
    await assert.rejects(unit.removeState(A,tech),e=>status(e)===409);
    assert.equal(deleted,false);assert.deepEqual(f.db.locks[0].uids,[A]);
  }
});

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
  const {prisma,access}=fixture(merged(G1,B,[B,A,C]));
  const read=async(db,uid)=>{const {groupId,kind,baseUid,studies}=await resolveExamScope(db,access,reader,{uid,purpose:'current'});return {groupId,kind,baseUid,studies};};
  await assert.rejects(read(prisma,A),e=>{assert.equal(status(e),409);assert.equal(body(e).code,STUDY_MERGED);assert.equal(body(e).baseUid,B);return true;});
  assert.deepEqual(await read(prisma,B),{groupId:G1,kind:'merge',baseUid:B,studies:[B,A,C]});
  assert.deepEqual(await read(prisma,D),{groupId:null,kind:null,baseUid:D,studies:[D]});
  // After Unmerge every study is its own exam again.
  const ended=fixture(merged(G1,B,[B,A,C],{dissolvedAt:new Date(),dissolvedBy:'syn-tech',dissolvedBySub:'syn-tech-sub'}));
  assert.deepEqual(await read(ended.prisma,A),{groupId:null,kind:null,baseUid:A,studies:[A]});
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
async function listFixture({rows=[qido(A,'ACC-A',8,1),qido(B,'ACC-B',8,1),qido(C,'ACC-C',4,2),qido(D,'ACC-D',3,1,'SYN-P2')],group=merged(G1,B,[B,A,C]),reports=[],drafts=[],extraStates=[],series=[],attachments=[],policy=null}={}){
  const states=[...rows.map(r=>({...state(r['0020000D'].Value[0]),origin:'dicom',createdAt:new Date('2020-01-01T00:00:00Z'),matched:'U',orderOid:null})).filter(s=>!extraStates.some(e=>e.uid===s.uid)),...extraStates];
  const project=(list,select)=>select?list.map(r=>Object.fromEntries(Object.keys(select).map(k=>[k,r[k]]))):list;
  const prisma={
    institution:{findMany:async()=>[{id:'hallym',name:'hallym',dicomNames:''}]},
    studyState:{findUnique:async({where})=>clone(states.find(s=>s.uid===where.uid)??null),findMany:async arg=>{let list=clone(states);if(arg?.where?.uid)list=list.filter(s=>arg.where.uid.in.includes(s.uid));
      else if(arg?.where?.institutionId)list=list.filter(s=>s.institutionId===arg.where.institutionId);return project(list,arg?.select);},
      create:async()=>{throw new Error('no create');},update:async()=>{throw new Error('no update');}},
    order:{findMany:async()=>[]},
    studyGroup:{findMany:async({where,select})=>(group?.groups??[]).filter(g=>match(g,where)).map(g=>pick(clone(g),select))},
    studyGroupMember:{findMany:async({where,select})=>(group?.members??[]).filter(m=>match(m,where)).map(m=>pick(clone(m),select))},
    report:{findMany:async({where})=>clone(reports).filter(r=>where.uid.in.includes(r.uid))},reportDraft:{findMany:async({where})=>clone(drafts).filter(d=>match(d,where))},readerAssignment:{findMany:async()=>[]},
    studyAttachment:{groupBy:async()=>[],findMany:async()=>clone(attachments),findFirst:async()=>null},gatewayReceipt:{findMany:async()=>[]},
    readingTemplate:{count:async()=>1,findMany:async()=>[]},userFilter:{findMany:async()=>[]},
    auditLog:{create:async()=>{throw new Error('no audit');}},$queryRaw:async()=>policy?[{institution:'hallym',revision:1,policy}]:[],
  };
  const orthanc={studies:async()=>clone(rows),
    studyIdentities:async(meta,acc)=>clone(rows).map(r=>({'0020000D':r['0020000D'],'00080080':r['00080080'],
      ...(meta?{'00100020':r['00100020'],'00080020':r['00080020'],'00080061':r['00080061']}:{}),...(acc?{'00080050':r['00080050']}:{})})),
    filmStudy:async()=>({series:series.map(s=>({uid:s.uid,instances:Array.from({length:s.count},()=>({}))}))}),
    studyIdentityResources:async uid=>clone(rows).filter(r=>r['0020000D'].Value[0]===uid),
    studiesByUid:async uids=>clone(rows).filter(r=>uids.includes(r['0020000D'].Value[0]))};
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

test('Split list projects two independently reported rows before paging and counts only each part series',async()=>{
  const group={groups:[{id:G1,institutionId:'hallym',kind:'split',baseUid:A,dissolvedAt:null}],members:[
    {groupId:G1,logicalUid:A,studyUid:A,part:0,seriesUids:[]},
    {groupId:G1,logicalUid:B,studyUid:A,part:1,seriesUids:['2.25.701']}]};
  const svc=await listFixture({group,rows:[qido(A,'ACC-A',12,3)],extraStates:[state(B,{origin:'logical',rs:'T'})],
    series:[{uid:'2.25.701',count:3},{uid:'2.25.702',count:5},{uid:'2.25.703',count:4}],
    reports:[{uid:B,version:1,findings:'SYN SECOND',conclusion:'',recommendation:'',groupId:G1}],
    drafts:[{uid:B,author:reader.actor,present:true,revision:1,findings:'SYN DRAFT',groupId:G1}],
    policy:{version:1,restricted:true,startsAt:null,endsAt:null,rules:[{patientId:null,modalities:[],dateFrom:null,dateTo:null,studyUids:[A]}]}});
  const all=await svc.listStudies({...reader});
  assert.deepEqual(all.studies.map(s=>[s.uid,s.count,s.series,s.state.rs]),[[A,9,2,'W'],[B,3,1,'T']]);
  assert.equal(all.studies[1].state.findings,'SYN SECOND');
  assert.equal(all.studies[1].state.draft.findings,'SYN DRAFT');
  assert.equal(all.notObserved.some(s=>s.uid===B),false);
  const first=await svc.listStudies({...reader},{limit:'1'});
  assert.equal(first.pagination.total,2);
  const last=await svc.listStudies({...reader},{limit:'1',after:first.pagination.next});
  assert.deepEqual(last.studies.map(s=>s.uid),[B]);
  const target=await svc.listStudies({...reader},{uids:B});
  assert.deepEqual(target.studies.map(s=>s.uid),[B]);
  const boot=await svc.bootstrap({...reader});
  assert.equal(boot.states[B].findings,'SYN SECOND');assert.equal(boot.states[B].draft.findings,'SYN DRAFT');
});

test('bootstrap and worklist withhold an own draft whose preserved group is only partly readable',async()=>{
  const group=merged(G1,A,[A,B],{dissolvedAt:new Date()});
  const svc=await listFixture({group,rows:[qido(A,'ACC-A',8,1)],extraStates:[state(B,{institutionId:'other'})],
    drafts:[{uid:A,author:reader.actor,present:true,revision:1,groupId:G1,findings:'SYN HIDDEN'}]});
  assert.equal((await svc.listStudies({...reader})).studies[0].state.draft,null);
  assert.equal((await svc.bootstrap({...reader})).states[A].draft,null);
});

test('tele lists project the same merged exam and targeted source lookup resolves its logical report',async()=>{
  const svc=await listFixture({rows:[qido(A,'ACC-A',3,1),qido(B,'ACC-B',5,1)],group:merged(G1,A,[A,B]),
    extraStates:[state(A,{teleInstitutionId:'remote'}),state(B,{teleInstitutionId:'remote'})]});
  const remote={...reader,institution:'remote'};
  const all=await svc.listStudies(remote);
  assert.deepEqual(all.studies.map(s=>[s.uid,s.count]),[[A,8]]);
  const one=await svc.listStudies({...remote},{uids:B});
  assert.deepEqual(one.studies.map(s=>[s.uid,s.count]),[[A,8]]);
});

// ── the report's exam group: a draft written on a merged exam carries it; text moved by Reset keeps its own ──
const {PacsReportDraft}=require('/app/dist/pacs/report-draft');
test('drafts carry the exam group they were written on (the study\'s current one), and an emptied draft carries none',async()=>{
  const {prisma,access}=fixture(merged(G1,B,[B,A]));
  const writes=[];
  const tx={...prisma,reportDraft:{create:async({data})=>{writes.push(data);return {...data};},
    updateMany:async({data})=>{writes.push(data);return {count:1};},findUnique:async()=>({revision:2})}};
  const drafts=Object.create(PacsReportDraft.prototype);
  drafts.studyAccess=access;
  const text={findings:'f',conclusion:'',recommendation:'',baseVersion:0,citations:[],structured:[]};
  await drafts.storeDraft(tx,B,'syn-reader',null,text,'approve',undefined,reader);
  assert.equal(writes.at(-1).groupId,G1);
  await drafts.storeDraft(tx,D,'syn-reader',null,text,'approve',undefined,reader);
  assert.equal(writes.at(-1).groupId,null);
  await drafts.storeDraft(tx,B,'syn-reader',{revision:1,present:true,workUnit:'disposal:x',workSince:new Date()},null);
  assert.equal(writes.at(-1).groupId,null);assert.equal(writes.at(-1).present,false);
  // Reset moving another reader's saved text into that reader's draft keeps the text's own group.
  await drafts.storeDraft(tx,B,'syn-other',null,text,'approve',null);
  assert.equal(writes.at(-1).groupId,null);
  // A merged member has no draft of its own while merged.
  await assert.rejects(drafts.storeDraft(tx,A,'syn-reader',null,text,'approve',undefined,reader),e=>body(e)?.code===STUDY_MERGED);
});

test('worklist read (GET studies): the merged exam row is listed alone and each of its studies is recorded as read', async () => {
  const svc = await listFixture();
  const read = await svc.readStudies(reader);
  const body = JSON.parse(read.json);
  assert.deepEqual(body.studies.map(s => s.uid), [B, D]);
  const at = body.studies.findIndex(s => s.uid === B);
  const metadata = read.sources.filter(s => s.target.kind === 'study-metadata' && [A,B,C].includes(s.target.studyId.value));
  assert.deepEqual(metadata.map(s=>s.target.studyId.value).sort(),[A,B,C]);
  for(const source of metadata){
    const projected=source.path.reduce((value,key)=>value[key],body);
    assert.equal(projected.uid,source.target.studyId.value);
    assert.equal(projected.acc,body.studies[at].sourceMetadata.find(row=>row.uid===projected.uid)?.acc??body.studies[at].acc);
  }
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
