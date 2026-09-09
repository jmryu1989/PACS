const {test}=require('node:test');const assert=require('node:assert/strict');
const {PacsService}=require('/app/dist/pacs.service');
const caller={institution:'hallym',sub:'subject',actor:'doctor',roles:['radiologist'],kind:'member'};
const states=[{uid:'1',institutionId:'hallym',teleInstitutionId:null,rs:'W',preDoc:null,preReviewer:null,ov:'{"id":"override"}'},{uid:'2',institutionId:'hallym',teleInstitutionId:null,rs:'P',preDoc:'other',preReviewer:'reviewer'},{uid:'3',institutionId:'other',teleInstitutionId:null,rs:'W'}];
const qido=states.map(s=>({'0020000D':{Value:[s.uid]},'00080080':{Value:[s.institutionId]},'00100020':{Value:['patient-'+s.uid]}}));
function setup(changeAt,change){
 const calls=[];let read=0;
 const prisma={studyState:{findMany:async arg=>{calls.push(['state',arg]);read++;let rows=structuredClone(states);if(arg?.where?.uid)rows=rows.filter(s=>arg.where.uid.in.includes(s.uid));else if(arg?.where)rows=rows.filter(s=>s.institutionId==='hallym');if(read===changeAt)rows[0]={...rows[0],...change};if(arg?.select)rows=rows.map(s=>Object.fromEntries(Object.keys(arg.select).map(k=>[k,s[k]])));return rows;}},report:{findMany:async arg=>{calls.push(['report',arg]);return [{uid:'1',version:1,findings:'report'},{uid:'2',version:2,findings:'private prelim'}];}},reportDraft:{findMany:async arg=>{calls.push(['draft',arg]);return [{uid:'1',findings:'draft',baseVersion:1}];}},order:{findMany:async()=>[]},$queryRaw:async(strings,...values)=>{calls.push(['note',values]);return [];}};
 const svc=new PacsService(prisma,{studies:async()=>qido},{});svc.institutions=[{id:'hallym',name:'hallym'},{id:'other',name:'other'}];svc.prefs=async()=>({filters:[],templates:[]});return {svc,calls};
}
test('lean bootstrap never reads study/report/draft; legacy keeps private state rules',async()=>{
 const {svc,calls}=setup();const lean=await svc.bootstrap(caller,{states:'omit'});assert.deepEqual(lean.states,{});assert.equal(lean.statesOmitted,true);assert.deepEqual(calls,[]);
 const full=await svc.bootstrap(caller);assert.equal(full.statesOmitted,undefined);assert.equal(full.states['1'].draft.findings,'draft');assert.equal(full.states['2'].findings,'');assert.equal(full.states['3'],undefined);
 for(const q of [{states:'all'},{states:['omit']},{states:'omit',x:'y'}])await assert.rejects(svc.bootstrap(caller,q),e=>e.getStatus()===400);
});
test('page query projects only membership then loads details and notes for its UID',async()=>{
 const {svc,calls}=setup();const r=await svc.listStudies(caller,{limit:'1'});assert.equal(r.studies.length,1);assert.equal(r.studies[0].state.ov.id,'override');assert.equal(r.pagination.total,2);
 assert.deepEqual(Object.keys(calls[0][1].select).sort(),['institutionId','teleInstitutionId','uid']);
 for(const [kind,arg] of calls.filter(x=>['report','draft'].includes(x[0])))assert.deepEqual(arg.where.uid.in,['1']);
 assert.deepEqual(calls.find(x=>x[0]==='note')[1][2].values,['1']);
 assert.equal(calls.filter(x=>x[0]==='state').length,3);
});
test('scope change before details and scope/Prelim change before response reject full batch',async()=>{
 for(const [at,change,query] of [[2,{institutionId:'other'},{limit:'1'}],[3,{institutionId:'other'},{limit:'1'}],[3,{rs:'P',preDoc:'other',preReviewer:'reviewer'},{limit:'1'}],[2,{rs:'P',preDoc:'other',preReviewer:'reviewer'},undefined]]){
  const {svc}=setup(at,change);await assert.rejects(svc.listStudies(caller,query),e=>e.getStatus()===409&&e.getResponse().code==='STUDY_LIST_CHANGED');
 }
});
