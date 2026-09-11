const {test} = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../worklist-v0/hpacs-lite/worklist-body-parts.js');

const study = (uid, series = 1, count = 1) => ({uid, series, count});
const row = (studyUid, seriesUid, body) => ({
  '0020000D': {Value: [studyUid]},
  '0020000E': {Value: [seriesUid]},
  ...(body === undefined ? {} : {'00180015': {Value: body}})
});
const json = (value, init = {}) => new Response(JSON.stringify(value), init);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('verified values are deduplicated and all-missing series produce an empty token array', async () => {
  const replies = new Map([
    ['1.2', [row('1.2', '1.2.1', [' CHEST ', 'CHEST']), row('1.2', '1.2.2')]],
    ['2.3', [row('2.3', '2.3.1'), row('2.3', '2.3.2', [null, '  '])]]
  ]);
  const model = create({owner: () => 'hospital:a', changed() {}, fetcher: (url, options) => {
    assert.match(url, /^\/dicom-web\/studies\/[0-9.]+\/series\?includefield=0020000D,0020000E,00180015&limit=501$/);
    assert.equal(options.credentials, 'same-origin');assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Accept, 'application/dicom+json');assert.ok(options.signal instanceof AbortSignal);
    return json(replies.get(url.split('/')[3]));
  }});
  model.sync([study('1.2', 2), study('2.3', 2)]);
  await model.load();
  assert.deepEqual(model.get('1.2'), ['CHEST']);
  assert.deepEqual(model.get('2.3'), []);
  assert.deepEqual(model.snapshot(), {busy:false,total:2,verified:2,failed:0,remaining:0,note:'',allowed:true});
});

test('malformed, duplicate, empty, and series-count mismatch responses stay unverified', async () => {
  const replies = [json([]), json([row('1.3','1.3.1'), row('1.3','1.3.1')]), json([row('1.4','1.4.1')]), json({bad:true})];
  const model = create({owner:()=> 'a', changed(){}, fetcher:()=>replies.shift()});
  model.sync([study('1.2'), study('1.3',2), study('1.4',2), study('1.5')]);
  await model.load();
  for (const uid of ['1.2','1.3','1.4','1.5']) assert.equal(model.get(uid), undefined);
  assert.equal(model.snapshot().failed, 4);
});

test('at most three requests run concurrently', async () => {
  let active=0, peak=0;
  const model=create({owner:()=> 'a',changed(){},fetcher:async url=>{
    active++;peak=Math.max(peak,active);await wait(8);active--;
    const uid=url.split('/')[3];return json([row(uid,uid+'.1',['HEAD'])]);
  }});
  model.sync(Array.from({length:9},(_,i)=>study('1.'+(i+2))));
  await model.load();
  assert.equal(peak,3);assert.equal(model.snapshot().verified,9);
});

test('cancel retains completed values and a later load resumes failed and untouched studies once', async () => {
  let calls=[];
  const model=create({owner:()=> 'a',changed(){},fetcher:url=>{
    const uid=url.split('/')[3];calls.push(uid);
    if(uid==='1.2')return json([row(uid,uid+'.1',['CHEST'])]);
    return new Promise((resolve,reject)=>setTimeout(()=>resolve(json([row(uid,uid+'.1',['HEAD'])])),40));
  }});
  model.sync([study('1.2'),study('1.3'),study('1.4'),study('1.5')]);
  const first=model.load();await wait(10);model.cancel();await first;
  assert.deepEqual(model.get('1.2'),['CHEST']);
  await model.load();
  assert.equal(model.snapshot().verified,4);
  assert.equal(calls.filter(x=>x==='1.2').length,1);
});

test('refresh invalidates verified values and fetches every scoped study again', async()=>{
  let calls=0;
  const model=create({owner:()=> 'a',changed(){},fetcher:url=>{calls++;const uid=url.split('/')[3];return json([row(uid,uid+'.1',[calls<3?'CHEST':'ABDOMEN'])]);}});
  model.sync([study('1.2'),study('1.3')]);await model.load();await model.load({refresh:true});
  assert.equal(calls,4);assert.deepEqual(model.get('1.2'),['ABDOMEN']);
});

test('a later manual load retries a failed study once while retaining verified studies', async()=>{
  let failed=true,calls=[];
  const model=create({owner:()=> 'a',changed(){},fetcher:url=>{
    const uid=url.split('/')[3];calls.push(uid);
    if(uid==='1.3'&&failed){failed=false;return new Response('',{status:500});}
    return json([row(uid,uid+'.1',['CHEST'])]);
  }});
  model.sync([study('1.2'),study('1.3')]);await model.load();await model.load();
  assert.deepEqual(calls,['1.2','1.3','1.3']);assert.equal(model.snapshot().verified,2);
});

test('scope change and delayed old response cannot populate the new scope', async()=>{
  let release;
  const model=create({owner:()=> 'a',changed(){},fetcher:url=>new Promise(resolve=>{release=()=>resolve(json([row('1.2','1.2.1',['CHEST'])]));})});
  model.sync([study('1.2')]);const old=model.load();model.sync([study('2.3')]);release();await old;
  assert.equal(model.get('1.2'),undefined);assert.equal(model.snapshot().total,1);
});

test('owner changes including A-B-A discard old generations and clear metadata', async()=>{
  let account='A', releases=[];
  const model=create({owner:()=>account,changed(){},fetcher:()=>new Promise(resolve=>releases.push(resolve))});
  model.sync([study('1.2')]);const old=model.load();account='B';model.sync([study('1.2')]);account='A';model.sync([study('1.2')]);
  releases[0](json([row('1.2','1.2.1',['CHEST'])]));await old;
  assert.equal(model.get('1.2'),undefined);assert.equal(model.snapshot().allowed,true);
});

test('authorization failure terminates the first wave and clears earlier successes', async()=>{
  let calls=0, deny=false;
  const model=create({owner:()=> 'a',changed(){},fetcher:async url=>{
    calls++;const uid=url.split('/')[3];
    return deny ? new Response('',{status:403}) : json([row(uid,uid+'.1',['CHEST'])]);
  }});
  model.sync(Array.from({length:8},(_,i)=>study('1.'+(i+2))));await model.load();
  assert.equal(model.snapshot().verified,8);
  deny=true;await model.load({refresh:true});
  assert.equal(calls,11);assert.equal(model.snapshot().verified,0);assert.match(model.snapshot().note,/권한/);
});

test('request timeout is failed while whole-load budget leaves aborted work resumable', async()=>{
  const never=()=>new Promise(()=>{});
  const timed=create({owner:()=> 'a',changed(){},fetcher:never,requestTimeoutMs:10,budgetMs:100});
  timed.sync([study('1.2')]);await timed.load();assert.equal(timed.snapshot().failed,1);
  let calls=0;
  const budget=create({owner:()=> 'a',changed(){},fetcher:async url=>{
    calls++;const uid=url.split('/')[3];if(uid==='1.2')return json([row(uid,uid+'.1',['CHEST'])]);return never();
  },requestTimeoutMs:100,budgetMs:12});
  budget.sync([study('1.2'),study('1.3'),study('1.4')]);await budget.load();
  assert.deepEqual(budget.get('1.2'),['CHEST']);assert.equal(budget.snapshot().remaining,2);assert.match(budget.snapshot().note,/전체 조회 시간/);
});

test('responses over 2 MiB are rejected without being treated as missing metadata', async()=>{
  const oversized=' '.repeat(2*1024*1024+1);
  const model=create({owner:()=> 'a',changed(){},fetcher:()=>new Response(oversized)});
  model.sync([study('1.2')]);await model.load();
  assert.equal(model.get('1.2'),undefined);assert.equal(model.snapshot().failed,1);
});
