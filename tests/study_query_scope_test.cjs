const {StudyAccessService}=require('/app/dist/study-access.service');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {PacsService}=require('/app/dist/pacs.service');
const caller={institution:'hallym',sub:'subject',actor:'doctor',roles:['radiologist'],kind:'member'};
const states=[{uid:'1',institutionId:'hallym',teleInstitutionId:null,rs:'W',preDoc:null,preReviewer:null,ov:'{"id":"override"}'},{uid:'2',institutionId:'hallym',teleInstitutionId:null,rs:'P',preDoc:'other',preReviewer:'reviewer'},{uid:'3',institutionId:'other',teleInstitutionId:null,rs:'W'}];
const qido=states.map(s=>({'0020000D':{Value:[s.uid]},'00080080':{Value:[s.institutionId]},'00100020':{Value:['patient-'+s.uid]}}));
// S9-U0b: the institution cache belongs to the institutions concern and is filled as the API process fills it, by the
// service's own start (onModuleInit) over this store; templates and searches come from the store, not a replaced prefs().
async function start(svc){const log=console.log;console.log=()=>{};try{await svc.onModuleInit();}finally{console.log=log;}return svc;}
async function setup(changeAt,change,fixture=states){
 const calls=[];let read=0;
 const prisma={readerAssignment:{findMany:async arg=>{calls.push(['assignment',arg]);return [];}},gatewayReceipt:{findMany:async()=>[]},studyState:{findMany:async arg=>{calls.push(['state',arg]);read++;let rows=structuredClone(fixture);if(arg?.where?.uid)rows=rows.filter(s=>arg.where.uid.in.includes(s.uid));else if(arg?.where)rows=rows.filter(s=>s.institutionId==='hallym');if(read===changeAt)rows[0]={...rows[0],...change};if(arg?.select)rows=rows.map(s=>Object.fromEntries(Object.keys(arg.select).map(k=>[k,s[k]])));return rows;}},report:{findMany:async arg=>{calls.push(['report',arg]);return [{uid:'1',version:1,findings:'report'},{uid:'2',version:2,findings:'private prelim'}];}},reportDraft:{findMany:async arg=>{calls.push(['draft',arg]);return [{uid:'1',findings:'draft',baseVersion:1,revision:1,present:true}];}},order:{findMany:async()=>[],count:async()=>1,updateMany:async()=>({count:0})},institution:{upsert:async()=>({}),findMany:async()=>[{id:'hallym',name:'hallym'},{id:'other',name:'other'}]},readingTemplate:{count:async()=>1,findMany:async()=>[]},userFilter:{findMany:async()=>[]},$queryRaw:async(strings,...values)=>{if(strings.join('').includes('StudyAccessPolicy'))return [];calls.push(['note',values]);return [];}};
 const svc=new PacsService(prisma,{studies:async()=>qido,studyIdentities:async()=>qido,studiesByUid:async uids=>qido.filter(s=>uids.includes(s['0020000D'].Value[0]))},{},new StudyAccessService(prisma,{},{}));await start(svc);return {svc,calls};
}
test('lean bootstrap never reads study/report/draft; legacy keeps private state rules',async()=>{
 const {svc,calls}=await setup();const lean=await svc.bootstrap(caller,{states:'omit'});assert.deepEqual(lean.states,{});assert.equal(lean.statesOmitted,true);assert.deepEqual(calls,[]);
 const full=await svc.bootstrap(caller);assert.equal(full.statesOmitted,undefined);assert.equal(full.states['1'].draft.findings,'draft');assert.equal(full.states['2'].findings,'');assert.equal(full.states['3'],undefined);
 for(const q of [{states:'all'},{states:['omit']},{states:'omit',x:'y'}])await assert.rejects(svc.bootstrap(caller,q),e=>e.getStatus()===400);
});
test('page query excludes private report state before loading details and notes for its selected UID',async()=>{
 const {svc,calls}=await setup();const r=await svc.listStudies(caller,{limit:'1'});assert.equal(r.studies.length,1);assert.equal(r.studies[0].state.ov.id,'override');assert.equal(r.pagination.total,2);
 // Scope discovery may read only identity and arrival ordering, never private state.
 assert.deepEqual(Object.keys(calls[0][1].select).sort(),['createdAt','institutionId','origin','teleInstitutionId','uid']);
 for(const [kind,arg] of calls.filter(x=>['report','draft'].includes(x[0])))assert.deepEqual(arg.where.uid.in,['1']);
 assert.deepEqual(calls.find(x=>x[0]==='note')[1][2].values,['1']);
 assert.equal(calls.filter(x=>x[0]==='state').length,3);
 assert.deepEqual(calls.find(x=>x[0]==='assignment')[1].where,{studyUid:{in:['1']},institutionId:'hallym'});
});
test('scope change before details and scope/Prelim change before response reject full batch',async()=>{
 for(const [at,change,query] of [[2,{institutionId:'other'},{limit:'1'}],[3,{institutionId:'other'},{limit:'1'}],[3,{rs:'P',preDoc:'other',preReviewer:'reviewer'},{limit:'1'}],[2,{rs:'P',preDoc:'other',preReviewer:'reviewer'},undefined]]){
  const {svc}=await setup(at,change);await assert.rejects(svc.listStudies(caller,query),e=>e.getStatus()===409&&e.getResponse().code==='STUDY_LIST_CHANGED');
 }
});

// REQ-S7-U5-DESIGNATION-SUB -> RISK-RECYCLED-EMAIL/READABILITY-RACE -> CORE_R10_WORKLIST.
test('CORE_R10_WORKLIST bootstrap and page keep a renamed designated subject readable and hide a recycled label',async()=>{
 const fixture=structuredClone(states);fixture[1].preReviewerSub=caller.sub;fixture[1].preDocSub='other-sub';
 for(const [who,readable] of [[{...caller,actor:'renamed'},true],[{...caller,sub:'recycled',actor:'reviewer'},false]]){
  const {svc}=await setup(undefined,undefined,fixture);
  assert.equal((await svc.bootstrap(who)).states['2'].findings,readable?'private prelim':'');
  const page=await svc.listStudies(who,{limit:'10'});
  assert.equal(page.studies.find(row=>row.state.uid==='2'||row.uid==='2').state.findings,readable?'private prelim':'');
 }
});

test('CORE_R10_WORKLIST a changed designation subject before response invalidates the batch even if labels stay identical',async()=>{
 const fixture=structuredClone(states);fixture[0]={...fixture[0],rs:'P',preDoc:caller.actor,preDocSub:caller.sub};
 const {svc}=await setup(3,{preDocSub:'different-person'},fixture);
 await assert.rejects(svc.listStudies(caller,{limit:'1'}),e=>e.getStatus()===409&&e.getResponse().code==='STUDY_LIST_CHANGED');
});
