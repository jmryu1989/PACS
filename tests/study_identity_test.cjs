// TEST-S4-U5-STUDY-IDENTITY client: the shipped display module (worklist-v0/hpacs-lite/study-identity.js) against
// the shared vectors and the reviewed label table. Runs without a browser; the DOM wiring is
// tests/study_identity_dom_test.py and the relations themselves come from the compiled server rule
// (tests/study_identity_server_test.cjs). Before S4-U5 the module did not exist, so every case here fails to load.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');const {join}=require('node:path');
const ROOT=join(__dirname,'..');
const identity=require('../worklist-v0/hpacs-lite/study-identity.js');
const V=JSON.parse(readFileSync(join(ROOT,'tests/study_identity_vectors.json'),'utf8'));
const O=JSON.parse(readFileSync(join(ROOT,'tests/study_observation_vectors.json'),'utf8'));
const same=x=>x;
const OWNER=['hallym','synthetic-sub'];
const AT='2026-09-25T01:00:00.000Z',LATER='2026-09-25T01:05:00.000Z';
const FORBIDDEN=['Reset','판독 취소','Addendum','추가 판독','재작성','다른 환자입니다','같은 환자','동일 환자','확인됨','confirmed','완료','Unmatched'];
const NEGATION='같은 환자임을 확인한 것은 아닙니다.';
const hits=text=>FORBIDDEN.filter(word=>String(text).replace(NEGATION,'').includes(word));
const relations=(value='match')=>({accession:value,patientId:value,patientName:value,birth:value,sex:value});
const answer=(oid,rel=relations())=>({source:'engineering_only',oid,...rel});
function row(over={}){
  return {uid:'2.25.501',acc:'SYN-ACC-1',id:'SYN-PID-1',name:'SYNTHETIC PATIENT',birth:'19800101',sex:'M',desc:'SYNTHETIC CT',
    tele:false,orderIdentity:answer('SYN-U5-E'),state:{rs:'W',matched:'M',oid:'SYN-U5-E'},...over};
}
const result=(rows,at=AT)=>({studies:rows,owner:OWNER,observation:{observedAt:at,notObserved:[]}});
const linked={rs:'W',matched:'M',oid:'SYN-U5-E'};

test('S4-U5 read accepts only the closed engineering-only shape; anything else is unreadable, null is no answer',()=>{
  assert.equal(identity.read(answer('SYN-U5-E')).state,'identity');
  assert.deepEqual(identity.read(answer('SYN-U5-E')).identity,{oid:'SYN-U5-E',...relations()});
  for(const value of [null,undefined])assert.equal(identity.read(value).state,'none');
  const bad={
    extraKey:{...answer('SYN-U5-E'),patientIdValue:'P-1'},
    missingKey:(()=>{const a=answer('SYN-U5-E');delete a.sex;return a;})(),
    otherSource:{...answer('SYN-U5-E'),source:'interface'},
    emptyOid:answer(''),controlOid:answer('SYN\u0000E'),longOid:answer('O'.repeat(65)),numberOid:{...answer('x'),oid:7},
    relationSame:answer('SYN-U5-E',{...relations(),patientId:'same'}),
    relationNull:answer('SYN-U5-E',{...relations(),birth:null}),
    array:[answer('SYN-U5-E')],text:'match',
  };
  for(const [name,value] of Object.entries(bad))assert.equal(identity.read(value).state,'unreadable',name);
});

test('S4-U5 succeeded needs a readable observation; failure keeps the last rows; cold failure invents nothing',()=>{
  let m=identity.start();
  assert.deepEqual(identity.view(m,'2.25.501',linked),{hidden:true});
  m=identity.failed(m);
  const cold=identity.view(m,'2.25.501',linked,same);
  assert.deepEqual([cold.hidden,cold.key,cold.summary.text,cold.rows,cold.order],[false,'unavailable','DICOM Identity · 관측 불가',[],null]);
  m=identity.succeeded(identity.start(),result([row()]));
  assert.equal(identity.view(m,'2.25.501',linked,same).summary.text,'DICOM Identity');
  for(const broken of [{...result([row()]),owner:null},{...result([row()]),observation:null},result([row()],'yesterday'),{...result([row()]),studies:'x'}]){
    const kept=identity.succeeded(m,broken);
    assert.equal(kept.available,false);
    const v=identity.view(kept,'2.25.501',linked,same);
    assert.equal(v.summary.text,'DICOM Identity · 관측 불가 · 마지막 관측 '+AT+' 기준');
    assert.equal(v.rows.find(r=>r.key==='name').value,'SYNTHETIC PATIENT','the last server-read tags stay');
  }
  const failed=identity.failed(m);
  assert.equal(identity.view(failed,'2.25.501',linked,same).key,'linked');
  assert.equal(identity.tags(failed,'2.25.501').name,'SYNTHETIC PATIENT');
  // A study the last observation did not carry has no panel, even while that observation stands.
  assert.deepEqual(identity.view(m,'2.25.999',linked,same),{hidden:true});
  const gone=identity.view(failed,'2.25.999',linked,same);
  assert.deepEqual([gone.key,gone.rows],['unavailable',[]]);
  // A later success replaces the whole answer.
  const next=identity.succeeded(failed,result([row({uid:'2.25.502'})],LATER));
  assert.deepEqual(identity.view(next,'2.25.501',linked,same),{hidden:true});
  assert.equal(identity.view(next,'2.25.502',linked,same).key,'linked');
});

test('S4-U5 tags come from the response row and are copied: the worklist row and later edits cannot reach the panel',()=>{
  const response=row();
  const m=identity.succeeded(identity.start(),result([response]));
  // What a stored overlay does to the worklist row object is not an input; the model never saw that object.
  const worklistRow={...response,name:'FORGED OVERLAY NAME',id:'FORGED-ID'};
  response.name='MUTATED AFTER';response.orderIdentity.patientId='mismatch';
  const v=identity.view(m,'2.25.501',linked,same);
  assert.equal(v.rows.find(r=>r.key==='name').value,'SYNTHETIC PATIENT');
  assert.equal(v.rows.find(r=>r.key==='id').value,'SYN-PID-1');
  assert.ok(!JSON.stringify(v).includes(worklistRow.name));
  assert.equal(v.patientMismatch,false,'the relation read at observation time stays');
  const copy=identity.tags(m,'2.25.501');copy.name='CHANGED';
  assert.equal(identity.tags(m,'2.25.501').name,'SYNTHETIC PATIENT');
  assert.equal(identity.tags(identity.start(),'2.25.501'),null);
});

test('S4-U5 stale rules: unlinked at once, a newer link or a null or unreadable answer is Unknown, tele is not compared',()=>{
  const m=identity.succeeded(identity.start(),result([row({orderIdentity:answer('SYN-U5-E',{...relations(),patientId:'mismatch'})}),
    row({uid:'2.25.502',orderIdentity:null}),row({uid:'2.25.503',orderIdentity:{bogus:true}}),
    row({uid:'2.25.504',tele:true,orderIdentity:null})]));
  const at=(uid,state)=>identity.view(m,uid,state,same);
  const shown=at('2.25.501',linked);
  assert.deepEqual([shown.key,shown.order.text,shown.patientMismatch],['linked','Linked Order SYN-U5-E · Engineering Only',true]);
  assert.equal(shown.summary.text,'DICOM Identity · Patient Mismatch');
  for(const [state,key,text] of [
    [{rs:'W',matched:'U',oid:null},'no_linked_order','No Linked Order'],
    [{rs:'W'},'no_linked_order','No Linked Order'],
    [{rs:'W',matched:'M',oid:'SYN-U5-OTHER'},'unknown','Unknown'],
    [{rs:'W',matched:'X',oid:'SYN-U5-E'},'unknown','Unknown']]){
    const v=at('2.25.501',state);
    assert.deepEqual([v.key,v.order.text,v.patientMismatch,v.accessionMismatch],[key,text,false,false],JSON.stringify(state));
    assert.equal(v.summary.text,'DICOM Identity');
    assert.ok(v.rows.every(r=>r.relation===''),'no relation is drawn without the same linked order');
  }
  for(const uid of ['2.25.502','2.25.503']){
    const v=at(uid,linked);
    assert.deepEqual([v.key,v.order.text],['unknown','Unknown'],uid);
    assert.ok(!JSON.stringify(v).includes('Same Value'),uid);
  }
  const tele=at('2.25.504',linked);
  assert.deepEqual([tele.key,tele.order.text,tele.guidance],['tele','Tele-received · Not Compared','']);
  assert.equal(tele.order.title,'원격판독으로 받은 검사의 오더는 보유 기관의 일입니다.');
});

test('S4-U5 summary badges from the shared vectors, through the shipped view',()=>{
  for(const c of V.summary){
    const m=identity.succeeded(identity.start(),result([row({orderIdentity:answer('SYN-U5-E',c.identity)})]));
    const v=identity.view(m,'2.25.501',linked,same);
    assert.deepEqual([v.summary.text,v.patientMismatch,v.accessionMismatch],[c.text,c.patientMismatch,c.accessionMismatch],c.id);
    for(const r of v.rows.filter(r=>['acc','id','name','birth','sex'].includes(r.key))){
      const field={acc:'accession',id:'patientId',name:'patientName',birth:'birth',sex:'sex'}[r.key];
      assert.equal(r.relation,identity.RELATION_TEXT[c.identity[field]],c.id+':'+r.key);
    }
    assert.equal(v.rows.find(r=>r.key==='desc').relation,'Not Compared');
    assert.equal(v.rows.find(r=>r.key==='uid').relation,'');
  }
});

test('S4-U5 M-3: the PN row names the Alphabetic group and its absence is not the whole tag',()=>{
  const m=identity.succeeded(identity.start(),result([row({name:'',acc:'',orderIdentity:answer('SYN-U5-E',{...relations(),patientName:'not_comparable',accession:'not_comparable'})})]));
  const v=identity.view(m,'2.25.501',linked,same);
  const name=v.rows.find(r=>r.key==='name');
  assert.deepEqual([name.tag,name.label,name.value,name.relation],['(0010,0010)','Patient Name · Alphabetic','Alphabetic Absent','Not Comparable']);
  assert.ok(name.valueTitle.includes('Alphabetic 그룹만 읽고 표시하고 비교합니다'));
  assert.ok(name.title.startsWith(identity.RELATION_TITLE.not_comparable)&&name.title.includes(identity.NAME_SCOPE));
  assert.equal(v.rows.find(r=>r.key==='acc').value,'Absent');
  assert.deepEqual(v.rows.map(r=>r.tag+' '+r.label),['(0020,000D) Study Instance UID','(0008,0050) Accession Number',
    '(0010,0020) Patient ID','(0010,0010) Patient Name · Alphabetic','(0010,0030) Patient Birth Date','(0010,0040) Patient Sex',
    '(0008,1030) Study Description']);
});

test('S4-U5 guidance: W names Unmatch then Match, other RS names none of the report actions, shown only when due',()=>{
  const W='오더 연결이 잘못됐다면 Unmatch 후 올바른 오더로 Match하세요. Modify Exam은 화면 표시값만 바꾸며 이 비교 결과를 바꾸지 않습니다. 원본 DICOM은 이 제품에서 수정하지 않습니다.';
  assert.equal(identity.guidance('W',true,false),W);
  assert.equal(identity.GUIDANCE_W,W);
  for(const rs of ['T','P','A','H'])
    assert.equal(identity.guidance(rs,true,false),'판독이 시작된 검사(현재 RS: '+rs+')는 서버 규칙상 Match·Unmatch·Modify Exam으로 바꿀 수 없습니다. 판독 기록은 그대로 보존됩니다. 불일치가 의심되면 담당 판독의·관리자와 확인하세요.');
  assert.equal(identity.guidance('A',false,false),'');
  assert.equal(identity.guidance('W',true,true),'');
  // No mismatch: no guidance until a correction is refused for that study; an accepted one clears it.
  let m=identity.succeeded(identity.start(),result([row(),row({uid:'2.25.502'})]));
  assert.equal(identity.view(m,'2.25.501',linked,same).guidance,'');
  m=identity.correction(m,'2.25.501',false);
  assert.equal(identity.view(m,'2.25.501',{...linked,rs:'T'},same).guidance,identity.guidance('T',true,false));
  assert.equal(identity.view(m,'2.25.502',linked,same).guidance,'','another study is not affected');
  m=identity.succeeded(m,result([row(),row({uid:'2.25.502'})],LATER));
  assert.equal(identity.view(m,'2.25.501',linked,same).guidance,W,'the refusal survives a newer observation of the same account');
  m=identity.correction(m,'2.25.501',true);
  assert.equal(identity.view(m,'2.25.501',linked,same).guidance,'');
});

test('S4-U5 label table: every state carries the marker rule and no word that claims identity or a report action',()=>{
  let rows=0;
  const states=[{matched:'U',oid:null},{matched:'M',oid:'SYN-U5-E'},{matched:'M',oid:'SYN-U5-OTHER'},{matched:'M',oid:null}];
  const answers=[...['match','mismatch','not_comparable'].map(value=>answer('SYN-U5-E',relations(value))),null,{bogus:true}];
  for(const rs of ['W','T','P','A','H'])for(const tele of [false,true])for(const value of answers)for(const state of states)
    for(const mode of ['ok','failed','refused']){
      let m=identity.succeeded(identity.start(),result([row({tele,orderIdentity:value})]));
      if(mode==='failed')m=identity.failed(m);
      if(mode==='refused')m=identity.correction(m,'2.25.501',false);
      const v=identity.view(m,'2.25.501',{...state,rs},same);
      rows++;
      const strings=[v.summary.text,v.summary.title,v.order.text,v.order.title,v.guidance,...v.rows.flatMap(r=>[r.label,r.value,r.valueTitle,r.relation,r.title])];
      for(const s of strings)assert.deepEqual(hits(s),[],s);
      if(v.key==='linked')assert.ok(v.order.text.endsWith(' · '+identity.MARKER));
      else assert.ok(['No Linked Order','Tele-received · Not Compared','Unknown'].includes(v.order.text),v.order.text);
      if(v.key!=='linked')assert.ok(v.rows.every(r=>r.relation===''));
      if(tele)assert.equal(v.guidance,'');
      if(mode==='failed')assert.ok(v.summary.text.includes(' · '+O.phrases.observationUnavailable+' · 마지막 관측 '));
      else assert.ok(!v.summary.text.includes(O.phrases.observationUnavailable));
    }
  assert.equal(rows,5*2*5*4*3);
  assert.equal(identity.PHRASES.observationUnavailable,O.phrases.observationUnavailable);
  assert.equal(identity.SOURCE,V.source);assert.equal(identity.MARKER,'Engineering Only');
  // The check itself would catch the review's seeded wording (M14, M15).
  assert.deepEqual(hits('판독 취소(Reset) 후 다시 매칭하세요'),['Reset','판독 취소']);
  assert.deepEqual(hits('다른 환자입니다'),['다른 환자입니다']);
  assert.equal(identity.RELATION_TITLE.match,'규칙으로 비교한 두 기록 값이 같습니다. '+NEGATION);
});
