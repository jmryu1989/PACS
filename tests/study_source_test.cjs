const {StudyAccessService}=require('/app/dist/study-access.service');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {OrthancService}=require('/app/dist/orthanc.service'),{PacsService}=require('/app/dist/pacs.service');
process.env.ORTHANC_USER='synthetic';process.env.ORTHANC_PASS='synthetic';
const identity=uid=>({RequestedTags:{StudyInstanceUID:uid}}),row=uid=>({'0020000D':{Value:[uid]},'00080080':{Value:[uid==='2'||uid==='3'?'other':'hallym']},'00100020':{Value:['literal-'+uid]}});
test('inventory requests indexed UID/institution; invalid identity rejects',async()=>{
 const o=new OrthancService();let args;o.get=async(...a)=>{args=a;return [identity('1'),identity('2')];};
 assert.deepEqual(await o.studyIdentities(),[{'0020000D':{Value:['1']},'00080080':{Value:['']}},{'0020000D':{Value:['2']},'00080080':{Value:['']}}]);
 assert.equal(args[0],'/tools/find');assert.deepEqual(args[1],{Level:'Study',Query:{},ResponseContent:['RequestedTags'],RequestedTags:['StudyInstanceUID','InstitutionName']});
 for(const invalid of [[identity('1,2')],[identity('')],[{}],{}]){o.get=async()=>invalid;await assert.rejects(o.studyIdentities(),e=>e.getStatus()===503);}
});
// WORKLIST-SPLIT-UID TEST-WSU-01: one row per original Study resource. A UID that two patient resources share is two
// rows in either answer order (the consumer groups them), and the normal UIDs stay as they were.
test('TEST-WSU-01 inventory keeps every resource of a shared UID in both answer orders',async()=>{
 const o=new OrthancService(),patient=(uid,pid,inst)=>({RequestedTags:{StudyInstanceUID:uid,InstitutionName:inst,PatientID:pid,StudyDate:'20261001',ModalitiesInStudy:'CT'}});
 for(const answer of [[patient('1','A','HALLYM'),patient('2','N','HALLYM'),patient('1','B','OTHER')],[patient('1','B','OTHER'),patient('2','N','HALLYM'),patient('1','A','HALLYM')]]){
  o.get=async()=>answer;const rows=await o.studyIdentities(true);
  assert.equal(rows.length,3);
  assert.deepEqual(rows.filter(r=>r['0020000D'].Value[0]==='1').map(r=>[r['00100020'].Value[0],r['00080080'].Value[0]]).sort(),[['A','HALLYM'],['B','OTHER']]);
  assert.deepEqual(rows.filter(r=>r['0020000D'].Value[0]==='2').map(r=>r['00100020'].Value[0]),['N']);
 }
 // The existing shape refusals of the institution and access-condition tags are unchanged.
 o.get=async()=>[patient('1','A','HALLYM'),{RequestedTags:{StudyInstanceUID:'1',InstitutionName:42}}];await assert.rejects(o.studyIdentities(),e=>e.getStatus()===503);
 o.get=async()=>[patient('1','A','HALLYM'),{RequestedTags:{StudyInstanceUID:'1',PatientID:7}}];await assert.rejects(o.studyIdentities(true),e=>e.getStatus()===503);
});
// The enumeration's request is part of the source contract (S4-U2): by default only the indexed UID and institution; the
// access-condition tags and the AccessionNumber are opt-in, and an unreadable accession is '' (not comparable).
test('TEST-WSU-01 enumeration default asks for UID and institution only; metadata and accession are opt-in',async()=>{
 const o=new OrthancService(),asked=[];
 o.get=async(path,body)=>{asked.push(body.RequestedTags);return [{RequestedTags:{StudyInstanceUID:'1',InstitutionName:'H',PatientID:'P',StudyDate:'20261001',ModalitiesInStudy:'CT\\SR',AccessionNumber:7}}];};
 const plain=await o.studyIdentities(),both=await o.studyIdentities(true,true),accessionOnly=await o.studyIdentities(false,true);
 assert.deepEqual(asked,[['StudyInstanceUID','InstitutionName'],['StudyInstanceUID','InstitutionName','PatientID','StudyDate','ModalitiesInStudy','AccessionNumber'],['StudyInstanceUID','InstitutionName','AccessionNumber']]);
 assert.deepEqual(Object.keys(plain[0]).sort(),['00080080','0020000D']);
 assert.deepEqual(both[0]['00080061'].Value,['CT','SR']);assert.equal(both[0]['00080050'].Value[0],'','an unreadable accession is not comparable');
 assert.deepEqual(Object.keys(accessionOnly[0]).sort(),['00080050','00080080','0020000D']);
});
test('QIDO comma list preserves exact values/order; empty skips IO and mixed/missing rows reject',async()=>{
 const o=new OrthancService();let calls=0,url;o.get=async path=>{calls++;url=path;return [row('2'),row('1')];};
 assert.deepEqual(await o.studiesByUid(['1','2']),[row('1'),row('2')]);assert.equal(new URL('http://local'+url).searchParams.get('StudyInstanceUID'),'1,2');
 assert.deepEqual(await o.studiesByUid([]),[]);assert.equal(calls,1);
 for(const bad of [['1','1'],['1*'],Array.from({length:101},(_,i)=>String(i))])await assert.rejects(o.studiesByUid(bad),e=>e.getStatus()===400);
 for(const bad of [[row('1')],[row('1'),row('1')],[row('1'),row('3')],[null,row('2')],{}]){o.get=async()=>bad;await assert.rejects(o.studiesByUid(['1','2']),e=>e.getStatus()===409&&e.getResponse().code==='STUDY_LIST_CHANGED');}
});
// TEST-WSU-01: every row of every requested UID, grouped in the request's UID order. Two resources of one UID are not a
// changed list; the answer's UID set must still equal the request's exactly.
test('TEST-WSU-01 the page read returns all resources per requested UID and refuses only a different UID set',async()=>{
 const o=new OrthancService(),second=uid=>({...row(uid),'00100020':{Value:['second-'+uid]}});
 o.get=async()=>[second('2'),row('1'),row('2')];
 const rows=await o.studiesByUid(['2','1']);
 assert.deepEqual(rows.map(r=>r['0020000D'].Value[0]),['2','2','1']);
 assert.deepEqual(rows.filter(r=>r['0020000D'].Value[0]==='2').map(r=>r['00100020'].Value[0]).sort(),['literal-2','second-2']);
 for(const bad of [[second('2'),row('2')],[second('2'),row('1'),row('2'),row('3')],[second('2'),row('1'),{}]]){o.get=async()=>bad;await assert.rejects(o.studiesByUid(['2','1']),e=>e.getStatus()===409&&e.getResponse().code==='STUDY_LIST_CHANGED');}
});
// TEST-WSU-01: the targeted read used for one UID's preparation and source observation. One resource is still an array,
// two are both rows, none is []; a failed fetch or body is a failure, never a smaller array.
test('TEST-WSU-01 targeted identity read returns every resource of one UID through the bounded source read',async()=>{
 const o=new OrthancService(),uid='2.25.42',answers=[],seen=[];const original=global.fetch;
 global.fetch=async(url,init)=>{seen.push([url,init?.method]);const next=answers.shift();if(next instanceof Error)throw next;return new Response(JSON.stringify(next),{status:next===null?500:200});};
 try{
  const one={'0020000D':{Value:[uid]},'00100020':{Value:['A']}},two={'0020000D':{Value:[uid]},'00100020':{Value:['B']}};
  answers.push([one]);assert.deepEqual(await o.studyIdentityResources(uid),[one]);
  answers.push([one,two]);assert.deepEqual(await o.studyIdentityResources(uid),[one,two]);
  answers.push([]);assert.deepEqual(await o.studyIdentityResources(uid),[]);
  const query=new URL(seen[0][0]).searchParams;assert.equal(query.get('StudyInstanceUID'),uid);assert.equal(seen[0][1],'GET');
  for(const bad of [[one,{'0020000D':{Value:['2.25.43']}}],{},[null],null,new TypeError('fetch failed')]){answers.push(bad);await assert.rejects(o.studyIdentityResources(uid),e=>e.getStatus()===503);}
  // A lookup key keeps its existing range and encoding.
  answers.push([{'0020000D':{Value:['KIN_A-1.2']}}]);assert.equal((await o.studyIdentityResources('KIN_A-1.2')).length,1);
  assert.equal(new URL(seen.at(-1)[0]).searchParams.get('StudyInstanceUID'),'KIN_A-1.2');
 }finally{global.fetch=original;}
});

test('opaque lookup keys preserve case and bytes; unsafe syntax and object keys reject',async()=>{
 const o=new OrthancService(),keys=['KIN_A-1.2','kin_a-1.2','A'.repeat(64)];let url;
 o.get=async()=>keys.map(identity);
 assert.deepEqual((await o.studyIdentities()).map(x=>x['0020000D'].Value[0]),keys);
 o.get=async path=>{url=path;return [...keys].reverse().map(row);};
 assert.deepEqual((await o.studiesByUid(keys)).map(x=>x['0020000D'].Value[0]),keys);
 assert.equal(new URL('http://local'+url).searchParams.get('StudyInstanceUID'),keys.join(','));
 for(const key of ['../1','1/2','1\\2','1,2','1*','1?','1%2f2','1#x','1&x','1"x','1 x','1\0','constructor','prototype','toString','__proto__',' 1','1 ','가','A'.repeat(65),null,42]){
  o.get=async()=>[identity(key)];await assert.rejects(o.studyIdentities(),e=>e.getStatus()===503);
  await assert.rejects(o.studiesByUid([key]),e=>e.getStatus()===400);
 }
});
test('cold and repeated orphan registration fetch only authorized page details',async()=>{
 const state=uid=>({uid,institutionId:uid==='2'?'other':'hallym',teleInstitutionId:null,rs:'W',preDoc:null,preReviewer:null});
 const rows=new Map([['1',state('1')],['2',state('2')]]),requests=[],audits=[];let orphanName='unknown';
 const prisma={readerAssignment:{findMany:async()=>[]},gatewayReceipt:{findMany:async()=>[]},studyState:{findMany:async q=>{const picked=[...rows.values()].filter(s=>!q?.where||q.where.uid.in.includes(s.uid));return picked.map(s=>q?.select?Object.fromEntries(Object.keys(q.select).map(k=>[k,s[k]])):{...s});},create:async({data})=>{const result={...state(data.uid),...data};rows.set(data.uid,result);return result;},update:async({where,data})=>{const result={...rows.get(where.uid),...data};rows.set(where.uid,result);return result;},
  // WORKLIST-SPLIT-UID: the conditional fill of a null institution and the re-read of the row it leaves.
  updateMany:async({where,data})=>{const row=rows.get(where.uid);if(!row||row.institutionId!==where.institutionId)return {count:0};rows.set(where.uid,{...row,...data});return {count:1};},
  findUnique:async({where,select})=>{const s=rows.get(where.uid);return s&&(select?Object.fromEntries(Object.keys(select).map(k=>[k,s[k]])):{...s});}},$transaction:async work=>work(prisma),report:{findMany:async()=>[]},reportDraft:{findMany:async()=>[]},$queryRaw:async()=>[],auditLog:{create:async a=>audits.push(a)},institution:{upsert:async()=>({}),findMany:async()=>[{id:'hallym',name:'hallym'},{id:'other',name:'other'}]},order:{count:async()=>1,updateMany:async()=>({count:0})}};
 const o={studyIdentities:async()=>Array.from({length:208},(_,i)=>{const r=row(String(i+1));if(i===207)r['00080080'].Value=[orphanName];return r;}),studies:async()=>{throw new Error('Full detail path must not run');},studiesByUid:async uids=>{requests.push([...uids]);return uids.map(row);}};
 // S9-U0b: the institution cache is the institutions concern's, filled by the service's own start over this store.
 const svc=new PacsService(prisma,o,{},new StudyAccessService(prisma,o,{}));{const log=console.log;console.log=()=>{};try{await svc.onModuleInit();}finally{console.log=log;}}const caller={institution:'hallym',sub:'subject',actor:'doctor',roles:['radiologist'],kind:'member'};
 let out=await svc.listStudies(caller,{limit:'1'});assert.equal(out.studies[0].uid,'1');assert.equal(out.pagination.total,205);assert.deepEqual(requests,[['1']]);assert.equal(audits.length,206);assert.equal(rows.get('208').institutionId,null);assert.equal(out.studies[0].institutionName,'hallym');assert.equal(JSON.stringify(out).includes('unknown'),false);
 requests.length=0;out=await svc.listStudies(caller,{limit:'1'});assert.deepEqual(requests,[['1']]);assert.equal(audits.length,206);assert.equal(rows.get('208').institutionId,null);
 orphanName='hallym';requests.length=0;out=await svc.listStudies(caller,{limit:'1'});assert.equal(out.pagination.total,206);assert.equal(rows.get('208').institutionId,'hallym');assert.deepEqual(requests,[['1']]);assert.equal(audits.length,206);
});

test('institution metadata preserves Unicode and empty/absent values, rejects malformed shapes',async()=>{
 const o=new OrthancService();
 for(const name of ['한림병원','','  exact raw  ',undefined,null]){o.get=async()=>[{RequestedTags:{StudyInstanceUID:'1.2',InstitutionName:name}}];assert.equal((await o.studyIdentities())[0]['00080080'].Value[0],name??'');}
 for(const name of [42,[],{},true]){o.get=async()=>[{RequestedTags:{StudyInstanceUID:'1.2',InstitutionName:name}}];await assert.rejects(o.studyIdentities(),e=>e.getStatus()===503);}
});
