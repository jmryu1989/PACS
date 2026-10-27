const {test}=require('node:test');const assert=require('node:assert/strict');
const {create: productCreate} = require('../worklist-v0/hpacs-lite/study-pages.js');
const { install } = require("./module_session_harness.cjs");
const create = options => { install(options?.fetcher); return productCreate(options); };
const owner=['hallym','subject'],me={kind:'member',institution:owner[0],sub:owner[1]};
const rows=Array.from({length:201},(_,i)=>({uid:String(i).padStart(4,'0'),state:{}}));
const page=(offset)=>({studies:rows.slice(offset,offset+100),pagination:{owner,limit:100,offset,total:201,next:offset<200?String(offset+100):null}});
test('failed second page resumes checkpoint without publishing partial data',async()=>{
 let fail=true,calls=[],states=[];
 const client=create({identity:()=>owner,changed:s=>states.push(s),request:async path=>{
  calls.push(path);if(path==='/me')return me;const offset=Number(new URL('http://local'+path).searchParams.get('after')||0);
  if(offset===100&&fail)throw new Error('offline');return page(offset);
 }});
 await assert.rejects(client.read({epoch:0}));assert.equal(client.resumable,true);assert.equal(states.at(-1).received,100);
 fail=false;calls=[];assert.deepEqual((await client.read({resume:true,epoch:0})).studies,rows);
 assert.ok(calls[0].includes('after=100'));assert.equal(client.resumable,false);
});
test('completed pages survive temporary identity check failure; malformed order and stale epochs reject',async()=>{
 let fail=true;
 const client=create({identity:()=>owner,changed:()=>{},request:async path=>{if(path==='/me'){if(fail)throw new Error('unavailable');return me;}return page(Number(new URL('http://local'+path).searchParams.get('after')||0));}});
 await assert.rejects(client.read({epoch:1}));fail=false;assert.equal((await client.read({resume:true,epoch:1})).studies.length,201);
 const malformed=create({identity:()=>owner,changed:()=>{},request:async()=>{const bad=page(0);[bad.studies[0],bad.studies[1]]=[bad.studies[1],bad.studies[0]];return bad;}});
 await assert.rejects(malformed.read());assert.equal(malformed.resumable,false);
 const stale=create({identity:()=>owner,changed:()=>{},request:async()=>page(0)});
 await assert.rejects(stale.read({valid:()=>false}));assert.equal(stale.resumable,false);
});
test('cancel and superseded responses cannot overwrite new checkpoint; changed owner rejects',async()=>{
 let resolve,hold=true,who=owner;
 const client=create({identity:()=>who,changed:()=>{},request:async path=>{
  if(hold){hold=false;return new Promise(r=>resolve=r);}if(path==='/me')return me;return page(Number(new URL('http://local'+path).searchParams.get('after')||0));
 }});
 const old=client.read();client.cancel();const next=await client.read();resolve(page(0));await assert.rejects(old);assert.equal(next.studies.length,201);
 who=['other','subject'];await assert.rejects(client.read(),e=>e.ownerChanged===true);
});

// WORKLIST-SPLIT-UID TEST-WSU-03/07: the completing page's identityIssues travel with the completed, owner-checked batch.
// A middle page says nothing about them; a completing page without the field is unknown (null), never []; a malformed
// field refuses the batch; a cancelled or superseded read never publishes its issues.
test('identity issues come only with the completed batch, unknown stays null and malformed refuses',async()=>{
 const issue={uid:'9999',code:'STUDY_IDENTITY_UNRESOLVED'};
 const paged=(issues,middle)=>path=>{if(path==='/me')return me;const offset=Number(new URL('http://local'+path).searchParams.get('after')||0),body=page(offset);
  if(offset===200&&issues!==undefined)body.identityIssues=issues;if(offset===0&&middle!==undefined)body.identityIssues=middle;return body;};
 const read=async(request,options)=>create({identity:()=>owner,changed:()=>{},request:async p=>request(p)}).read(options);
 assert.deepEqual((await read(paged([issue]))).identityIssues,[issue]);
 assert.deepEqual((await read(paged([]))).identityIssues,[]);
 assert.equal((await read(paged(undefined))).identityIssues,null);
 assert.equal((await read(paged(undefined,[issue]))).identityIssues,null,'a middle page is not the answer');
 for(const bad of [{},[{uid:''}],[{uid:'9999'}],[null],'x'])await assert.rejects(read(paged(bad)),e=>e.stale===true);
 // A read superseded before it completes never hands its issues to anyone.
 let release,first=true;const client=create({identity:()=>owner,changed:()=>{},request:async path=>{
  if(first&&path.includes('after=200')){first=false;await new Promise(r=>release=r);}return paged([issue])(path);}});
 const old=client.read();while(!release)await new Promise(r=>setImmediate(r));
 const next=client.read();release();
 await assert.rejects(old,e=>e.stale===true);
 assert.deepEqual((await next).identityIssues,[issue]);
});

test('request timeout retains retry checkpoint and explicit cancel alone pauses polling',async()=>{
 const client=create({identity:()=>owner,changed:()=>{},timeoutMs:5,request:async(path,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('timeout'),{name:'AbortError'}))))});
 await assert.rejects(client.read(),e=>e.name==='AbortError');assert.equal(client.resumable,true);assert.equal(client.paused,false);
 client.cancel();assert.equal(client.paused,true);client.clear();assert.equal(client.paused,false);
});

// M11-a: a list that changes between pages is read again from the first page, never joined into a "complete" list that
// is missing a study. `listed` stands in for the server's visible set; its cursor carries that set like study-page.ts.
const server=listed=>{
 const log=[];
 const request=async path=>{
  if(path==='/me')return me;
  const after=new URL('http://local'+path).searchParams.get('after'),set=listed.map(r=>r.uid).join();log.push(after===null?'first':'next');
  let start=0;
  if(after!==null){const cursor=JSON.parse(after);if(cursor.set!==set)throw Object.assign(new Error('검사 목록이 바뀌었습니다.'),{status:409,code:'STUDY_LIST_CHANGED'});start=cursor.offset;}
  const studies=listed.slice(start,start+100),more=start+studies.length<listed.length;
  return {studies,pagination:{owner,limit:100,offset:start,total:listed.length,next:more?JSON.stringify({set,offset:start+100}):null},identityIssues:[]};
 };
 return {log,request};
};
test('an urgent arrival before the cursor between pages restarts the read and is in the completed list',async()=>{
 const listed=rows.slice(1,102).map(r=>({...r})),urgent={uid:rows[0].uid,state:{em:'E'}},{log,request}=server(listed),states=[];
 const client=create({identity:()=>owner,changed:s=>states.push(s),request:async path=>{
  if(log.length===1&&path!=='/me')listed.unshift(urgent);return request(path);}});
 const result=await client.read();
 assert.equal(result.studies.length,102);assert.ok(result.studies.some(r=>r.uid===urgent.uid&&r.state.em==='E'));
 assert.deepEqual(log,['first','next','first','next']);
 assert.equal(states.at(-1).message,'');assert.equal(client.resumable,false);
});
test('an offset or total that no longer continues the pages read restarts; a list that keeps changing is refused, never partial',async()=>{
 for(const delta of [-1,1]){
  const first=page(0),last={studies:[rows[100]],pagination:{owner,limit:100,offset:100+delta,total:101+delta,next:null}};
  first.pagination.total=101;first.pagination.next='n';
  const whole=[page(0),{studies:[rows[100]],pagination:{owner,limit:100,offset:100,total:101,next:null}}];
  whole[0].pagination.total=101;whole[0].pagination.next='n';
  const replies=[first,last,...whole],paths=[];
  const client=create({identity:()=>owner,changed:()=>{},request:async path=>{if(path==='/me')return me;paths.push(path);return replies.shift();}});
  assert.deepEqual((await client.read()).studies,rows.slice(0,101));
  assert.deepEqual(paths.map(p=>p.includes('after=')),[false,true,false,true]);
 }
 // A list that keeps changing is read again for one request's allowance (timeoutMs) from the first change, then refused.
 for(const delta of [-1,1]){
  const paths=[];let changedAt=null;
  const client=create({identity:()=>owner,changed:()=>{},timeoutMs:40,request:async path=>{
   if(path==='/me')return me;paths.push(path);await new Promise(r=>setTimeout(r,2));
   if(!path.includes('after=')){const first=page(0);first.pagination.total=101;first.pagination.next='n';return first;}
   changedAt??=Date.now();
   return {studies:[rows[100]],pagination:{owner,limit:100,offset:100+delta,total:101+delta,next:null}};}});
  await assert.rejects(client.read(),e=>e.code==='STUDY_LIST_CHANGED');
  assert.ok(Date.now()-changedAt>=40,'refused only after the allowance from the first change');
  assert.ok(paths.length>=4&&paths.length%2===0,'read again from the first page, whole passes only: '+paths.length);
  assert.equal(client.resumable,false);
 }
});
test('a continuation refused as changed is read again for one request\'s allowance; a first page refusal is not retried',async()=>{
 const always=[];let changedAt=null;
 const changing=create({identity:()=>owner,changed:()=>{},timeoutMs:40,request:async path=>{
  if(path==='/me')return me;always.push(path.includes('after=')?'next':'first');await new Promise(r=>setTimeout(r,2));
  if(path.includes('after=')){changedAt??=Date.now();throw Object.assign(new Error('검사 목록이 바뀌었습니다.'),{status:409,code:'STUDY_LIST_CHANGED'});}return page(0);}});
 await assert.rejects(changing.read(),e=>e.code==='STUDY_LIST_CHANGED');
 assert.ok(Date.now()-changedAt>=40,'refused only after the allowance from the first change');
 assert.ok(always.length>=4&&always.every((step,i)=>step===(i%2?'next':'first')),always.join());
 assert.equal(changing.resumable,false);
 let calls=0;
 const firstRefused=create({identity:()=>owner,changed:()=>{},request:async path=>{
  if(path==='/me')return me;calls++;throw Object.assign(new Error('검사 접근 범위가 바뀌었습니다.'),{status:409,code:'STUDY_LIST_CHANGED'});}});
 await assert.rejects(firstRefused.read(),e=>e.code==='STUDY_LIST_CHANGED');assert.equal(calls,1);
});
test('a resumed read whose cursor no longer matches the list starts from the first page',async()=>{
 const listed=rows.slice(1).map(r=>({...r})),{log,request}=server(listed);let fail=true;
 const client=create({identity:()=>owner,changed:()=>{},request:async path=>{
  if(path!=='/me'&&log.length===1&&fail){fail=false;log.push('lost');throw new Error('offline');}return request(path);}});
 await assert.rejects(client.read({epoch:0}));assert.equal(client.resumable,true);
 listed.unshift({...rows[0]});
 const result=await client.read({resume:true,epoch:0});
 assert.deepEqual(result.studies.map(r=>r.uid),rows.map(r=>r.uid));
 assert.deepEqual(log,['first','lost','next','first','next','next']);
});
