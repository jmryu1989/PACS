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
