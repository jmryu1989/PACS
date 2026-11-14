const test=require('node:test'),assert=require('node:assert/strict');
const {create,comparison}=require('../worklist-v0/hpacs-lite/worklist-selection');
const rows=['a','b','c','d'].map(uid=>({uid,sourcePatientKey:'same'}));
const examScopes=require('../worklist-v0/hpacs-lite/exam-scope');
const scope=(generation='one',part=0)=>({reportUid:'1.2',groupId:'group',kind:'split',part,active:true,generation,
  sources:[{studyUid:'1.1',series:{mode:part?'include':'exclude',uids:['1.1.2']}}]});
test('exam storage identity survives a generation change; selected scope changes invalidate the action',()=>{
  const a=scope(),b=scope('two'),m=create(),first=[{uid:'1.2',examScope:a}];
  assert.equal(examScopes.key(a),examScopes.key(b));assert.notEqual(examScopes.stamp(a),examScopes.stamp(b));
  assert.notEqual(examScopes.key(a),examScopes.key(scope('one',1)));
  m.toggle('1.2',first);const before=m.generation();m.reconcile([{uid:'1.2',examScope:b}]);
  assert.equal(m.generation(),before+1);m.reconcile(first);assert.equal(m.generation(),before+2);
});
test('scoped DICOM reads preserve original UID and include or exclude only server series',async()=>{
  const rows=['1.1.1','1.1.2','1.1.3'].map(uid=>({'0020000E':{Value:[uid]}})),calls=[];
  for(const part of [0,1]){
    const result=await examScopes.dicom(scope('one',part),'series',async(path,source)=>{calls.push([path,source.studyUid]);return rows;});
    assert.deepEqual(result.map(v=>v.row['0020000E'].Value[0]),part?['1.1.2']:['1.1.1','1.1.3']);
    assert.ok(result.every(v=>v.sourceUid==='1.1'));
  }
  assert.deepEqual(calls,[['/dicom-web/studies/1.1/series','1.1'],['/dicom-web/studies/1.1/series','1.1']]);
});
test('stored scope fetch and viewer input preserve current and prior roles and the selected version',async()=>{
  const current=scope(),prior={...scope('older',1),reportUid:'1.3'},calls=[];
  const fetched=await examScopes.fetch(async(...args)=>{calls.push(args);return current;},'1.2',{purpose:'stored',version:4});
  fetched.sources[0].series.uids.push('mutation');assert.deepEqual(current.sources[0].series.uids,['1.1.2']);
  assert.equal(calls[0][1],'/studies/1.2/exam-scope?purpose=stored&version=4');
  const input=examScopes.viewerInput(current,prior,4),url=new URL(examScopes.viewerUrl(input),'https://synthetic.test');
  assert.deepEqual(input.studyUids,['1.1']);assert.equal(input.reportUid,'1.2');
  const ref=s=>({reportUid:s.reportUid,groupId:s.groupId,part:s.part,generation:s.generation});
  assert.deepEqual(JSON.parse(url.searchParams.get('kinExamScopes')),{current:ref(current),prior:ref(prior),version:4,priorVersion:null});
  const large={...current,sources:[{studyUid:'1.1',series:{mode:'include',uids:Array.from({length:500},(_,i)=>'1.1.'+i)}}]};
  assert.ok(examScopes.viewerUrl(examScopes.viewerInput(large)).length<2000);
});
test('exam changes reach only another document of the same session and stop after disposal',()=>{
  const native=globalThis.BroadcastChannel,channels=[];
  globalThis.BroadcastChannel=class {constructor(){channels.push(this);}postMessage(data){for(const peer of channels)if(peer!==this&&!peer.closed)peer.onmessage?.({data});}close(){this.closed=true;}};
  try{
    const received=[],foreign=[],a=examScopes.changes(()=> 'owner',()=>{}),b=examScopes.changes(()=> 'owner',uids=>received.push(uids)),c=examScopes.changes(()=> 'other',uids=>foreign.push(uids));
    a.send(['1.1','1.1']);assert.deepEqual(received,[['1.1']]);assert.deepEqual(foreign,[]);
    b.close();a.send(['1.2']);assert.equal(received.length,1);a.close();c.close();
  }finally{globalThis.BroadcastChannel=native;}
});
test('range and page selection retain displayed order and remove filtered or revoked studies',()=>{
  const m=create();m.toggle('b',rows);m.toggle('d',rows,true);assert.deepEqual(m.rows(rows).map(s=>s.uid),['b','c','d']);
  m.page(['a','unknown'],rows);assert.deepEqual(m.rows(rows).map(s=>s.uid),['a','b','c','d']);
  assert.deepEqual(m.rows([rows[3],rows[1]]).map(s=>s.uid),['d','b']);
  assert.deepEqual(m.rows(rows).map(s=>s.uid),['b','d']);m.clear();assert.deepEqual(m.rows(rows),[]);
});
test('comparison requires exactly two confirmed original patient identities',()=>{
  assert.deepEqual(comparison(rows.slice(0,2)),['a','b']);
  assert.deepEqual(comparison(rows.slice(0,2),'b'),['b','a']);
  for(const invalid of [[],rows,[rows[0]], [rows[0],{...rows[1],sourcePatientKey:''}], [rows[0],{...rows[1],sourcePatientKey:'other'}]])assert.equal(comparison(invalid),null);
});
test('W9: the selection generation counts real changes of the selected set, including a filtered-out member',()=>{
  const m=create(),g=()=>m.generation();const start=g();
  m.toggle('a',rows);assert.equal(g(),start+1);
  m.toggle('zz',rows);assert.equal(g(),start+1,'an unknown row changes nothing');
  m.page(['a'],rows);assert.equal(g(),start+1,'re-adding a selected row changes nothing');
  m.toggle('b',rows);m.toggle('b',rows);m.toggle('b',rows);assert.equal(g(),start+4,'A -> B -> A is three changes');
  m.rows([rows[1],rows[2]]);assert.equal(g(),start+5,'a selected row leaving the list is a change');
  m.clear();assert.equal(g(),start+6);m.clear();assert.equal(g(),start+6);
});
