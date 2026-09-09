const {test}=require('node:test');const assert=require('node:assert/strict');
const {create}=require('../worklist-v0/hpacs-lite/study-pages.js');
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

test('request timeout retains retry checkpoint and explicit cancel alone pauses polling',async()=>{
 const client=create({identity:()=>owner,changed:()=>{},timeoutMs:5,request:async(path,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('timeout'),{name:'AbortError'}))))});
 await assert.rejects(client.read(),e=>e.name==='AbortError');assert.equal(client.resumable,true);assert.equal(client.paused,false);
 client.cancel();assert.equal(client.paused,true);client.clear();assert.equal(client.paused,false);
});
