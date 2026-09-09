const {test}=require('node:test'),assert=require('node:assert/strict');
const {OrthancService}=require('/app/dist/orthanc.service'),{PacsService}=require('/app/dist/pacs.service');
process.env.ORTHANC_USER='synthetic';process.env.ORTHANC_PASS='synthetic';
const identity=uid=>({RequestedTags:{StudyInstanceUID:uid}}),row=uid=>({'0020000D':{Value:[uid]},'00080080':{Value:[uid==='2'||uid==='3'?'other':'hallym']},'00100020':{Value:['literal-'+uid]}});
test('inventory requests only indexed UID; invalid/duplicate identity rejects',async()=>{
 const o=new OrthancService();let args;o.get=async(...a)=>{args=a;return [identity('1'),identity('2')];};
 assert.deepEqual(await o.studyIdentities(),[{'0020000D':{Value:['1']}},{'0020000D':{Value:['2']}}]);
 assert.equal(args[0],'/tools/find');assert.deepEqual(args[1],{Level:'Study',Query:{},ResponseContent:['RequestedTags'],RequestedTags:['StudyInstanceUID']});
 for(const invalid of [[identity('1'),identity('1')],[identity('1,2')],[identity('')],[{}],{}]){o.get=async()=>invalid;await assert.rejects(o.studyIdentities(),e=>e.getStatus()===503);}
});
test('QIDO comma list preserves exact values/order; empty skips IO and mixed/missing rows reject',async()=>{
 const o=new OrthancService();let calls=0,url;o.get=async path=>{calls++;url=path;return [row('2'),row('1')];};
 assert.deepEqual(await o.studiesByUid(['1','2']),[row('1'),row('2')]);assert.equal(new URL('http://local'+url).searchParams.get('StudyInstanceUID'),'1,2');
 assert.deepEqual(await o.studiesByUid([]),[]);assert.equal(calls,1);
 for(const bad of [['1','1'],['1*'],Array.from({length:101},(_,i)=>String(i))])await assert.rejects(o.studiesByUid(bad),e=>e.getStatus()===400);
 for(const bad of [[row('1')],[row('1'),row('1')],[row('1'),row('3')],[null,row('2')],{}]){o.get=async()=>bad;await assert.rejects(o.studiesByUid(['1','2']),e=>e.getStatus()===409);}
});
test('cold registration batches at100; warm page fetches only authorized page details',async()=>{
 const state=uid=>({uid,institutionId:uid==='2'?'other':'hallym',teleInstitutionId:null,rs:'W',preDoc:null,preReviewer:null});
 const rows=new Map([['1',state('1')],['2',state('2')]]),requests=[],audits=[];
 const prisma={studyState:{findMany:async q=>{const picked=[...rows.values()].filter(s=>!q?.where||q.where.uid.in.includes(s.uid));return picked.map(s=>q?.select?Object.fromEntries(Object.keys(q.select).map(k=>[k,s[k]])):{...s});},create:async({data})=>{const result={...state(data.uid),...data};rows.set(data.uid,result);return result;}},report:{findMany:async()=>[]},reportDraft:{findMany:async()=>[]},$queryRaw:async()=>[],auditLog:{create:async a=>audits.push(a)}};
 const o={studyIdentities:async()=>Array.from({length:207},(_,i)=>({'0020000D':{Value:[String(i+1)]}})),studies:async()=>{throw new Error('Full detail path must not run');},studiesByUid:async uids=>{requests.push([...uids]);return uids.map(row);}};
 const svc=new PacsService(prisma,o,{});svc.institutions=[{id:'hallym',name:'hallym'},{id:'other',name:'other'}];const caller={institution:'hallym',sub:'subject',actor:'doctor',roles:['radiologist'],kind:'member'};
 let out=await svc.listStudies(caller,{limit:'1'});assert.equal(out.studies[0].uid,'1');assert.equal(out.pagination.total,205);assert.deepEqual(requests.map(x=>x.length),[100,100,5,1]);assert.equal(audits.length,205);
 requests.length=0;out=await svc.listStudies(caller,{limit:'1'});assert.deepEqual(requests,[['1']]);assert.equal(audits.length,205);
});
