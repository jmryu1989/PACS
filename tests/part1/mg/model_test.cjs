// TEST-MG-MODEL (E-MG R1): REQ-MG-01/02/03/04/05/06 -> RISK-MG-MISCLASS/OMIT/FALSE-ANATOMY/WRONG-STUDY/FLIP-CLIP/STALE.
// D73: every assertion binds to the public model contract (kind, frame identity, position, slot,
// ticket validity) for DICOM JSON inputs built here; no source text, function name or DOM is read.
// KIN_MG_MODEL may point at a copy of the model (tests/part1/mg/mutants.py); the product tree is never edited.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const model=require(process.env.KIN_MG_MODEL||path.join(__dirname,'..','..','..','worklist-v0','hpacs-lite','mammography-model.js'));

const MG='1.2.840.10008.5.1.4.1.1.1.2',MG_PROCESSING='1.2.840.10008.5.1.4.1.1.1.2.1',DBT='1.2.840.10008.5.1.4.1.1.13.1.3',SC='1.2.840.10008.5.1.4.1.1.7';
const VIEW={CC:['SCT','399162004'],MLO:['SCT','399368009'],CC_SRT:['SRT','R-10242'],MLO_SRT:['SRT','R-10226']};
const ORIENT={R:{CC:['P','L'],MLO:['P','FL']},L:{CC:['A','R'],MLO:['A','FR']}};
const v=(vr,...Value)=>({vr,Value});
const seq=(...items)=>({vr:'SQ',Value:items});
let serial=100;
const next=()=>'1.2.826.0.1.3680043.10.9.'+(++serial);

function mg({sop=next(),series='1.2.826.0.1.3680043.10.8.1',study='1.2.826.0.1.3680043.10.7.1',patient='PT-1',issuer=null,birth=null,date='20240105',
  type=['ORIGINAL','PRIMARY',''],lat='R',view='CC',viewCode=null,modifiers=[],orientation=null,sopClass=MG,description=null,partial=null,
  number=1,intent='FOR PRESENTATION',extra={}}={}){
  const code=viewCode||VIEW[view];
  const item={'00080016':v('UI',sopClass),'00080018':v('UI',sop),'0020000D':v('UI',study),'0020000E':v('UI',series),
    '00080060':v('CS','MG'),'00080008':v('CS',...type),'00100020':v('LO',patient),'00080020':v('DA',date),'00200013':v('IS',number),
    '00280010':v('US',120),'00280011':v('US',90),'00280004':v('CS','MONOCHROME2'),'00280101':v('US',12),
    '00281050':v('DS',2048),'00281051':v('DS',4096),'00080068':v('CS',intent),
    '00540220':seq({'00080102':v('SH',code[0]),'00080100':v('SH',code[1]),'00540222':seq(...modifiers.map(([s,c])=>({'00080102':v('SH',s),'00080100':v('SH',c)})))})};
  if(lat!==null)item['00200062']=v('CS',lat);
  const o=orientation||(ORIENT[lat]&&ORIENT[lat][view]);if(o)item['00200020']=v('CS',...o);
  if(issuer!==null)item['00100021']=v('LO',issuer);
  if(birth!==null)item['00100030']=v('DA',birth);
  if(description!==null)item['0008103E']=v('LO',description);
  if(partial!==null)item['00281350']=v('CS',partial);
  return Object.assign(item,extra);
}
// A DBT object: shared orientation/thickness, per-frame position; `positions` are mm along +z.
function dbt({sop=next(),study='1.2.826.0.1.3680043.10.7.1',series='1.2.826.0.1.3680043.10.8.2',patient='PT-1',lat='L',view='CC',
  positions=[0,1,2,3,4],frames=null,iop=[0,-1,0,-1,0,0],technique='TOMOSYNTHESIS',volumetric='VOLUME',thickness=1,perFrame=null,
  frameTypes=null,omitPositions=false,imageType=['DERIVED','PRIMARY','TOMOSYNTHESIS','NONE'],frameType=null,frameIops=null,dimensions=null,extra={}}={}){
  const count=frames===null?positions.length:frames;
  // frameTypes[i] = [Volumetric Properties, Volume Based Calculation Technique] of frame i+1;
  // frameIops[i] puts frame i+1's own Plane Orientation in its per-frame item (no shared one);
  // dimensions = {pointers:[[tag, group]], values:[[...] per frame]} adds a Dimension Index.
  const items=(perFrame||positions.map((z,i)=>{
    const ft=frameTypes&&frameTypes[i]||[volumetric,technique];
    return {'00189504':seq({'00089007':v('CS',...(frameType||imageType)),'00089206':v('CS',ft[0]),'00089207':v('CS',ft[1])}),
      ...(omitPositions?{}:{'00209113':seq({'00200032':v('DS',...(Array.isArray(z)?z:[-60,-10,z]))})}),
      ...(frameIops?{'00209116':seq({'00200037':v('DS',...frameIops[i])})}:{}),
      ...(dimensions?{'00209111':seq({'00209157':v('UL',...dimensions.values[i])})}:{})};
  }));
  const shared={'00209071':seq({'00209072':v('CS',lat)}),'00289110':seq({'00180050':v('DS',thickness),'00280030':v('DS',0.1,0.1)})};
  if(!frameIops)shared['00209116']=seq({'00200037':v('DS',...iop)});
  return Object.assign({'00080016':v('UI',DBT),'00080018':v('UI',sop),'0020000D':v('UI',study),'0020000E':v('UI',series),'00080060':v('CS','MG'),
    '00080008':v('CS',...imageType),'00100020':v('LO',patient),'00080020':v('DA','20240105'),'00089206':v('CS',volumetric),'00089207':v('CS',technique),
    '00280008':v('IS',count),'00280010':v('US',120),'00280011':v('US',90),'00280004':v('CS','MONOCHROME2'),'00280101':v('US',12),
    '00540220':seq({'00080102':v('SH',VIEW[view][0]),'00080100':v('SH',VIEW[view][1])}),
    '52009229':seq(shared),'52009230':{vr:'SQ',Value:items},
    ...(dimensions?{'00209222':seq(...dimensions.pointers.map(([tag,group])=>({'00209165':v('AT',tag),...(group?{'00209167':v('AT',group)}:{})})))}:{})},extra);
}
const HOLOGIC={'00080070':v('LO','HOLOGIC, Inc.'),'00081090':v('LO','Selenia Dimensions'),'00181020':v('LO','AWS:1.9.1.8','ROS:2.10.4800.DRT21')};
const GENERATED=['DERIVED','PRIMARY','TOMOSYNTHESIS','GENERATED_2D'];
const PARTIAL_MEDIAL={'00281352':seq({'00080102':v('SH','SCT'),'00080100':v('SH','255561001'),'00080104':v('LO','Medial')})};
// D735: the shared E-MG/EMR-E rule table, read in place and pinned by SHA-256. Every case is its own test
// named by its testId; every provided expected key is compared with model.contract(). The table is input
// data from the consult; nothing here is generated from this model's output.
const fs=require('node:fs'),crypto=require('node:crypto');
const RULE_TABLE=process.env.KIN_MG_RULE_CASES||'C:/Users/norne/PACS/tmp/astra-control/evidence/mg-classification-consult-20261009/v2/rule-cases.json';
const RULE_TABLE_SHA256='a60b86b6267853615872a915d66a59150062afdbfe5d8725ca7a55f578c984d0';
// This byte pin is required only to bind both products to the identical shared input contract.
// A missing required table fails collection, rather than silently passing a smaller suite.
const raw=fs.readFileSync(RULE_TABLE),table=JSON.parse(raw);
{
  test('D744 rule table is the pinned one',()=>{
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),RULE_TABLE_SHA256);
    assert.equal(table.cases.length,273);assert.equal(new Set(table.cases.map(c=>c.testId)).size,273);
  });
  for(const k of table.cases)test(k.testId,()=>{
    const got=model.contract(k.input.dicom,k.input.context);
    for(const [key,expected] of Object.entries(k.expected)){
      assert.deepEqual(got[key]===undefined?null:got[key],expected,k.id+' '+key);
    }
  });
}
const study=(uid,role,instances,institution='H1')=>({uid,role,institution,instances});
const manifest=(...studies)=>({institution:'H1',studies});
const slot=(p,role,side,view,kind)=>p.slots[[role,side,view,kind].join('|')];

// R3 independent counterexamples: header facts and source relations, never implementation text.
const clone=o=>JSON.parse(JSON.stringify(o));
const concept=(scheme,value)=>({'00080102':v('SH',scheme),'00080100':v('SH',value)});
const reference=o=>seq({'00081150':o['00080016'],'00081155':o['00080018']});
function sourcePair(){
  const target=dbt({lat:'R',extra:{'00281350':v('CS','NO')}});
  const result=mg({type:GENERATED,partial:'NO',extra:{'00082112':reference(target)}});
  return {result,target,context:{patientKey:'patient-1',institutionKey:'institution-1',storedObjects:[{dicom:target,patientKey:'patient-1',institutionKey:'institution-1'}]}};
}
test('MG08-reject source acceptance requires nonempty patient and institution keys on both sides',()=>{
  const good=sourcePair();assert.equal(model.verifySources(good.result,good.context).sourceAccepted,true);
  for(const key of ['patientKey','institutionKey'])for(const side of ['caller','target','both'])for(const value of [undefined,null,'','   ',0,{},[]]){
    const {result,context}=sourcePair();
    if(side!=='target')context[key]=value;
    if(side!=='caller')context.storedObjects[0][key]=value;
    const got=model.verifySources(result,context);
    assert.equal(got.sourceLinkStatus,'unresolved','MG08 M25: missing context never verifies a source');
    assert.equal(got.sourceAccepted,false);assert.equal(got.references.length,1);assert.equal(got.rawReferenceRetained,true);
  }
});
test('MG08-reject partial sources require verified matching CID 4005 meanings',()=>{
  for(const scheme of ['SRT','SNM3']){
    const {result,target,context}=sourcePair();
    result['00281350']=target['00281350']=v('CS','YES');
    result['00281352']=seq(concept('SCT','255561001'));target['00281352']=seq(concept(scheme,'R-404D5'));
    assert.equal(model.verifySources(result,context).sourceAccepted,true,'equivalent CID 4005 meanings agree across schemes');
    target['00281352']=seq(concept('SCT','49370004'));
    assert.equal(model.verifySources(result,context).sourceLinkStatus,'rejected','different verified sections contradict');
  }
  for(const c of [concept('99LOCAL','x'),concept('SCT','999999'),{},concept('SCT','R-404D5')]){
    const {result,target,context}=sourcePair();
    result['00281350']=target['00281350']=v('CS','YES');result['00281352']=target['00281352']=seq(c);
    const got=model.verifySources(result,context);
    assert.equal(got.sourceAccepted,false,'MG08 M26: identical unknown partial codes are not verified meaning');
    assert.equal(got.sourceLinkStatus,'unresolved');assert.equal(got.references.length,1);
  }
});
test('MG08-reject source modifiers and biopsy context cannot contradict the result',()=>{
  for(const where of ['result','target']){
    const p=sourcePair();p[where]['00540220'].Value[0]['00540222']=seq(concept('SCT','399055006'));
    assert.equal(model.verifySources(p.result,p.context).sourceLinkStatus,'rejected','MG08 M27: plain and spot source contexts contradict');
  }
  const same=sourcePair();
  for(const o of [same.result,same.target])o['00540220'].Value[0]['00540222']=seq(concept('SCT','399209000'));
  assert.equal(model.verifySources(same.result,same.context).sourceAccepted,true,'matching verified modifiers are permitted');
  const biopsy=sourcePair();biopsy.result['00080008']=v('CS','DERIVED','PRIMARY','TOMO_SCOUT','GENERATED_2D');
  assert.equal(model.classify(biopsy.result).status,'verified');
  assert.equal(model.verifySources(biopsy.result,biopsy.context).sourceLinkStatus,'rejected','MG08 M28: biopsy result cannot claim a plain source context');
});
test('MG08-reject cycles in the provided source graph never verify',()=>{
  for(const length of [2,3,6]){
    const {result,target,context}=sourcePair();let tail=target;
    for(let i=2;i<length;i++){
      const nextTarget=clone(target);nextTarget['00080018']=v('UI',next());
      tail['00082112']=reference(nextTarget);tail=nextTarget;
      context.storedObjects.push({dicom:tail,patientKey:context.patientKey,institutionKey:context.institutionKey});
    }
    tail['00082112']=reference(result);
    const got=model.verifySources(result,context);
    assert.equal(got.sourceLinkStatus,'rejected','MG08 M29: a source cycle is a contradiction');assert.equal(got.rawReferenceRetained,true);
    tail['00082112']=reference(target);
    assert.equal(model.verifySources(result,context).sourceLinkStatus,'rejected','reachable source-only cycle is also rejected');
    delete tail['00082112'];assert.equal(model.verifySources(result,context).sourceAccepted,true,'acyclic supplied graph is accepted');
  }
});
test('MG04-allow every DBT representation has a nonempty selection with duplicate MinIP ambiguous',()=>{
  const make=(technique,thickness=10)=>dbt({lat:'R',positions:[0,5,10],volumetric:'SAMPLED',technique,thickness});
  const a=make('MIN_IP'),b=make('MIN_IP'),mip=make('MAX_IP'),slab=make('TOMOSYNTHESIS');
  slab['00080008'].Value[3]='MEAN';for(const f of slab['52009230'].Value)f['00189504'].Value[0]['00089007'].Value[3]='MEAN';
  const thin=dbt({lat:'R'}),get=xs=>slot(model.plan(manifest(study(a['0020000D'].Value[0],'current',xs))),'current','R','CC','dbt');
  const duplicate=get([a,b]);
  assert.equal(duplicate.status,'ambiguous','MG04 M30: duplicate MinIP remains a nonempty explicit choice');assert.equal(duplicate.candidates.length,2);
  assert.equal(get([a,mip]).status,'ambiguous','MinIP and MIP have equal priority, neither silently replaces the other');
  for(const [rows,chosen] of [[[a],a],[[a,slab],slab],[[a,b,mip,slab,thin],thin]]){
    const s=get(rows);assert.equal(s.status,'ready');assert.equal(s.object.sop,chosen['00080018'].Value[0]);
    assert.equal(s.alternatives.length,rows.length-1);
  }
});
test('MG01-reject Shared Functional Groups cardinality and shape precede first-item use',()=>{
  const good=dbt();assert.equal(model.classify(good).status,'verified');
  const first=good['52009229'].Value[0],forbidden={'00189504':seq({'00089007':v('CS',...GENERATED)})};
  for(const e of [seq(first,forbidden),seq(first,{}),seq(),seq(null),seq('bad'),seq([]),null,[],{vr:'LO',Value:[first]},{vr:'SQ',Value:{}}]){
    const o=clone(good);o['52009229']=e;
    const got=model.classify(o);
    assert.equal(got.status,'unverified','MG01 M31: malformed shared groups cannot verify from item zero');
    assert.equal(got.standard,false);assert.equal(model.frameIndex(o).complete,false);
  }
  const perFrame=clone(good);delete perFrame['52009229'];
  perFrame['52009230'].Value.forEach(f=>Object.assign(f,clone(first)));
  perFrame['52009229']=seq({});assert.equal(model.classify(perFrame).status,'verified','one empty shared item with per-frame macros is valid');
});
test('MG01-allow v2 separates declaration and hanging while malformed partial evidence stays out',()=>{
  for(const flag of [undefined,{vr:'CS'},v('CS'),v('CS',null),v('CS',' '),v('CS','NO')]){
    const o=mg();if(flag!==undefined)o['00281350']=flag;
    const c=model.classify(o),s=slot(model.plan(manifest(study(c.study,'current',[o]))),'current','R','CC','conventional');
    assert.equal(c.fullViewAutoMatch,true,'MG01 M36: absent or empty partial view hangs automatically');
    assert.equal(c.standard,c.fullViewAutoMatch);assert.equal(s.status,'ready');
    assert.equal(c.partialDeclaration,flag===undefined?'ABSENT':flag.Value&&flag.Value[0]==='NO'?'NO':'EMPTY');
    assert.equal(c.fullness,c.partialDeclaration==='NO'?'declared-not-partial':'inferred-for-hanging');
  }
  for(const root of [false,true]){
    const o=mg(),holder=root?o:o['00540220'].Value[0];holder['00540222']=seq(concept('SCT','255561001'));
    assert.equal(model.contract(o).partial,'conflict','MG01 M33: CID 4005 in a modifier container is a conflict');
  }
  for(const flag of [null,'NO',[],v('CS','NO','YES'),v('CS',17),v('CS',{}),{vr:'CS',Value:'NO'}]){
    const o=mg({extra:{'00281350':flag}});
    assert.equal(model.contract(o).partial,'conflict','MG01 M34: malformed Partial View is not absence');
  }
  for(const sq of [seq('bad'),seq(null),seq([]),{vr:'SQ',Value:{}},null]){
    const o=mg({extra:{'00281352':sq}});
    assert.equal(model.contract(o).partial,'conflict','MG01 M35: malformed partial SQ items are not filtered into absence');
  }
  for(const k of table.cases){
    const o=clone(k.input.dicom);o['00100020']=v('LO','test-patient');
    const c=model.classify(o),p=model.plan(manifest(study(c.study,'current',[o])));
    assert.equal(c.standard,c.contract.fullViewAutoMatch,k.id+' plan eligibility matches the contract');
    if(c.standard)assert.equal(slot(p,'current',c.laterality,c.view,c.kind).status,'ready',k.id+' eligible object really hangs');
    else assert.ok(!Object.values(p.slots).some(s=>s.status==='ready'),k.id+' excluded object does not hang');
  }
});

test('MG01-allow conventional, device synthetic 2D and DBT are told apart by standard attributes with evidence',()=>{
  const conventional=model.classify(mg({type:['DERIVED','PRIMARY']}));
  assert.equal(conventional.kind,'conventional');assert.equal(conventional.status,'verified');assert.equal(conventional.standard,true);
  assert.ok(conventional.evidence.some(e=>/Image Type/.test(e)),'the kind decision carries its Image Type evidence');
  const synthetic=model.classify(mg({type:['DERIVED','PRIMARY','TOMOSYNTHESIS','GENERATED_2D']}));
  assert.equal(synthetic.kind,'generated2d');assert.equal(synthetic.status,'verified');assert.equal(synthetic.biopsy,null);
  const biopsy=model.classify(mg({type:['DERIVED','PRIMARY','POSTBIOPSY','GENERATED_2D']}));
  assert.equal(biopsy.kind,'generated2d','biopsy Value 3 takes precedence and Value 4 still marks the generated 2D view');assert.equal(biopsy.biopsy,'POSTBIOPSY');
  const slices=model.classify(dbt());
  assert.equal(slices.kind,'dbt');assert.equal(slices.sliceKind,'slices');assert.equal(slices.laterality,'L');assert.equal(slices.view,'CC');
  // Slices vs slab follow thickness and contiguous positions together with the tags (ruling D730).
  const sampledThin=model.classify(dbt({volumetric:'SAMPLED',thickness:1}));
  const volumeThick=model.classify(dbt({positions:[0,5,10,15],technique:'MAX_IP',volumetric:'VOLUME',thickness:10}));
  assert.deepEqual([sampledThin.sliceKind,volumeThick.sliceKind],['slices','mip-slab'],
    'MG01 M23: slices vs slab follow thickness and contiguous positions, not Volumetric Properties alone');
  const slab=model.classify(dbt({technique:'MAX_IP',volumetric:'SAMPLED',thickness:10}));
  assert.equal(slab.kind,'dbt');assert.equal(slab.sliceKind,'mip-slab','a MIP slab is reported as what is stored, not as thin slices');assert.equal(slab.sliceThickness,10);
  // Thin MAX_IP sections are slices only within the verified Hologic 1 mm profile, never for any device.
  assert.equal(model.classify(dbt({technique:'MAX_IP',volumetric:'VOLUME',thickness:1,extra:HOLOGIC})).sliceKind,'slices');
  assert.equal(model.classify(dbt({technique:'MAX_IP',volumetric:'VOLUME',thickness:1})).status,'unverified');
  const gaps=model.classify(dbt({positions:[0,3,6,9],thickness:1}));
  assert.equal(gaps.sliceKind,'unspecified','sections with gaps between them are not claimed to be contiguous slices');
  // The named device exception: Hologic Selenia Dimensions one-frame Breast Tomosynthesis GENERATED_2D.
  const stored2d=model.classify(dbt({positions:[0],technique:'MAX_IP',volumetric:'VOLUME',thickness:54,imageType:GENERATED,extra:HOLOGIC}));
  assert.equal(stored2d.kind,'generated2d');assert.equal(stored2d.status,'verified');assert.equal(stored2d.standard,true);
  assert.equal(stored2d.basis,'hologic-selenia-dimensions-bto-generated-2d','the verified device profile is named as the basis');
  assert.equal(model.contract(dbt({positions:[0],technique:'MAX_IP',volumetric:'VOLUME',thickness:54,imageType:GENERATED,extra:HOLOGIC})).class,'device-synthetic-2d');
  const cur='1.2.826.0.1.3680043.10.7.1';
  const p=model.plan(manifest(study(cur,'current',[mg({type:['DERIVED','PRIMARY']}),mg({type:['DERIVED','PRIMARY','TOMOSYNTHESIS','GENERATED_2D']}),
    dbt({lat:'R',view:'CC',technique:'MAX_IP',volumetric:'SAMPLED',thickness:10}),dbt({lat:'R',view:'CC'})])));
  assert.equal(slot(p,'current','R','CC','conventional').status,'ready');
  assert.equal(slot(p,'current','R','CC','generated2d').status,'ready');
  const d=slot(p,'current','R','CC','dbt');
  assert.equal(d.status,'ready');assert.equal(d.object.sliceKind,'slices','stored slices come before a slab of the same view');
  assert.equal(d.alternatives.length,1,'the slab stays listed as an alternative');
});

test('MG01-reject DERIVED alone, a description, a contradiction or a non-mammography object never yields synthetic 2D or DBT',()=>{
  const derived=model.classify(mg({type:['DERIVED','PRIMARY']}));
  assert.notEqual(derived.kind,'generated2d','MG01 M1: DERIVED pixel data is not evidence of a synthetic view');
  const described=model.classify(mg({type:['ORIGINAL','PRIMARY',''],description:'R CC C-View'}));
  assert.notEqual(described.kind,'generated2d','MG01 M2: a series description alone never confirms a synthetic view');
  assert.equal(described.status,'unverified');assert.equal(described.standard,false,'a doubtful object is kept out of automatic matching');
  const tomoText=model.classify(mg({description:'Mammography with tomosynthesis'}));
  assert.equal(tomoText.kind,'conventional','tomosynthesis in a description does not turn a 2D exposure into DBT');
  for(const type of [['DERIVED','PRIMARY','TOMOSYNTHESIS'],['DERIVED','PRIMARY','','GENERATED_2D'],['DERIVED','PRIMARY','TOMO_PROJ','GENERATED_2D']]){
    const c=model.classify(mg({type}));
    assert.notEqual(c.kind,'generated2d',type.join('\\'));assert.equal(c.standard,false,type.join('\\'));
  }
  const sc=model.classify(mg({sopClass:SC,description:'DBT slices',type:['ORIGINAL','PRIMARY']}));
  assert.notEqual(sc.kind,'dbt');assert.notEqual(sc.kind,'generated2d');assert.equal(sc.standard,false,'a secondary capture is never a device image');
  const processing=model.classify(mg({sopClass:MG_PROCESSING,intent:'FOR PROCESSING'}));
  assert.equal(processing.presentation,'processing');assert.equal(processing.standard,false,'For Processing is not shown as For Presentation');
  // Image Type and Frame Type must agree before any kind is trusted, whichever value differs.
  for(const [name,object] of [
    ['Frame Type Value 3 VOLUME',dbt({positions:[0],imageType:GENERATED,frameType:['DERIVED','PRIMARY','VOLUME','GENERATED_2D'],extra:HOLOGIC})],
    ['Image Type Value 4 NONE',dbt({positions:[0],imageType:['DERIVED','PRIMARY','TOMOSYNTHESIS','NONE'],frameType:GENERATED,extra:HOLOGIC})],
    ['slices with a disagreeing Frame Type',dbt({frameType:['ORIGINAL','PRIMARY','TOMOSYNTHESIS','NONE']})]]){
    const c=model.classify(object);
    assert.equal(c.status,'unverified','MG01 M17: Image Type and Frame Type must agree before any kind is trusted ('+name+')');
    assert.equal(c.standard,false,name);
  }
  // Exactly the named exception, nothing wider.
  // Each differs from the verified profile in one respect only (same VOLUME/MAX_IP one-frame encoding).
  const exact={positions:[0],imageType:GENERATED,technique:'MAX_IP',volumetric:'VOLUME',thickness:54};
  for(const [name,object] of [['another manufacturer',dbt({...exact,extra:{'00080070':v('LO','GE MEDICAL SYSTEMS'),'00081090':v('LO','Senographe Pristina'),'00181020':v('LO','AWS:1.9.1.8')}})],
    ['a look-alike manufacturer',dbt({...exact,extra:{...HOLOGIC,'00080070':v('LO','HOLOGIC clone')}})],
    ['another software',dbt({...exact,extra:{...HOLOGIC,'00181020':v('LO','AWS:99.0')}})],
    ['no manufacturer',dbt({...exact})],
    ['Hologic but many frames',dbt({imageType:GENERATED,extra:HOLOGIC})],
    ['Hologic but Value 3 VOLUME',dbt({positions:[0],imageType:['DERIVED','PRIMARY','VOLUME','GENERATED_2D'],extra:HOLOGIC})]]){
    const c=model.classify(object);
    assert.notEqual(c.kind,'generated2d','MG01 M18: a one-frame tomosynthesis GENERATED_2D object is synthetic 2D only as the named device exception ('+name+')');
    assert.equal(c.standard,false,name);
  }
  const mixed=model.classify(dbt({frameTypes:[['VOLUME','TOMOSYNTHESIS'],['SAMPLED','MAX_IP'],['VOLUME','TOMOSYNTHESIS'],['VOLUME','TOMOSYNTHESIS'],['VOLUME','TOMOSYNTHESIS']]}));
  assert.equal(mixed.status,'unverified');assert.equal(mixed.standard,false);
  const cur='1.2.826.0.1.3680043.10.7.1';
  const p=model.plan(manifest(study(cur,'current',[mg({type:['ORIGINAL','PRIMARY',''],description:'R CC C-View'}),mg({sopClass:SC,type:['ORIGINAL','PRIMARY']}),
    mg({sopClass:MG_PROCESSING,intent:'FOR PROCESSING'})])));
  for(const k of model.KINDS)assert.equal(slot(p,'current','R','CC',k).status,'missing',k+' is not filled from an unverified object');
  assert.equal(p.objects.filter(o=>o.use==='other').length,3,'every unmatched object stays listed');
});

test('MG02-allow every stored frame first to last keeps its own SOP and frame number, also after a position sort',()=>{
  const ordered=model.frameIndex(dbt({positions:[0,1,2,3,4,5,6]}));
  assert.equal(ordered.total,7);assert.equal(ordered.complete,true);
  assert.deepEqual(ordered.entries.map(e=>e.frame),[1,2,3,4,5,6,7],'MG02 M3: the first and the last stored slice are both reachable');
  assert.deepEqual(ordered.entries.map(e=>e.index),[1,2,3,4,5,6,7]);
  assert.ok(ordered.entries.every(e=>e.total===7&&e.sop===ordered.sop));
  // Stored out of order: frame k lies at z = shuffled[k-1].
  const shuffled=[3,0,4,1,6,2,5],index=model.frameIndex(dbt({positions:shuffled}));
  assert.equal(index.complete,true);
  const byFrame=new Map(index.entries.map(e=>[e.frame,e]));
  assert.deepEqual([...byFrame.keys()].sort((a,b)=>a-b),[1,2,3,4,5,6,7],'every stored frame appears exactly once');
  const offsets=index.entries.map(e=>e.position.offset);
  assert.deepEqual(offsets,[0,1,2,3,4,5,6],'display order walks the volume');
  for(const e of index.entries)assert.equal(Math.abs(e.position.projection),shuffled[e.frame-1],
    'MG02 M4: a sorted entry still names the stored frame that lies at its position');
  const coverage=model.createCoverage(index);
  for(const e of index.entries)assert.equal(coverage.mark(e),true);
  assert.equal(coverage.mark({sop:index.sop,frame:8}),false,'a frame outside the object never counts');
  assert.deepEqual(coverage.snapshot(),{total:7,seen:7,complete:true});
  // A Dimension Index that agrees with Image Position and In-Stack Position keeps the index complete.
  const agreeing=model.frameIndex(dbt({positions:[0,1,2,3,4],dimensions:{pointers:[['00200032','00209113']],values:[[1],[2],[3],[4],[5]]}}));
  assert.equal(agreeing.complete,true);
});

test('MG02-reject a duplicate, a missing per-frame item, a gap or a wrong total never reports complete',()=>{
  const duplicate=model.frameIndex(dbt({positions:[0,1,1,2,3]}));
  assert.equal(duplicate.complete,false);assert.ok(duplicate.issues.includes('duplicate-position'));
  const short=dbt({positions:[0,1,2,3,4,5]});short['52009230'].Value.pop();
  const missing=model.frameIndex(short);
  assert.equal(missing.complete,false,'MG02: six per-frame items for NumberOfFrames 6 are needed');
  assert.deepEqual(missing.entries.map(e=>e.frame),[1,2,3,4,5,6],'every declared frame stays reachable');
  assert.ok(missing.entries.every(e=>e.position.status==='unverified'),'positions are not paired with the wrong frames');
  const coverage=model.createCoverage(missing);
  for(const e of missing.entries)coverage.mark(e);
  assert.equal(coverage.snapshot().complete,false,'all reachable frames seen is still not complete when the index is not');
  const wrongTotal=dbt({positions:[0,1,2,3,4],frames:6});
  assert.equal(model.frameIndex(wrongTotal).complete,false);
  const gap=model.frameIndex(dbt({positions:[0,1,2,4,5,6]}));
  assert.equal(gap.complete,false);assert.ok(gap.issues.includes('irregular-spacing'));
  // A frame count outside the limit is refused before any per-frame work and never reaches a slot.
  const cur='1.2.826.0.1.3680043.10.7.1';
  for(const count of [2001,0,-1,1.5]){
    // 2001 frames carry a complete, otherwise valid geometry: only the limit refuses them.
    const big=count===2001?dbt({lat:'R',view:'CC',positions:Array.from({length:2001},(_,i)=>i)}):dbt({lat:'R',view:'CC',frames:count}),c=model.classify(big);
    assert.equal(c.standard,false,'MG02 M20: a frame count outside the limit is refused before any per-frame work ('+count+')');
    assert.ok(c.issues.includes('frame-count-invalid'));
    const p=model.plan(manifest(study(cur,'current',[big])));
    assert.equal(slot(p,'current','R','CC','dbt').status,'missing','no empty frame index is handed to a slot');
    assert.equal(model.frameIndex(big).complete,false);
  }
  const started=Date.now(),huge=model.classify(dbt({frames:1e9}));
  assert.ok(Date.now()-started<1000&&huge.issues.includes('frame-count-invalid'),'an absurd frame count is refused at once');
  // Dimension Index Values that contradict the positions they index: frames stay, completeness does not.
  const pointers=[['00200032','00209113']];
  for(const [name,values] of [['two positions share one index',[[1],[2],[2],[3],[4]]],['index order against position order',[[1],[3],[2],[4],[5]]]]){
    const index=model.frameIndex(dbt({positions:[0,1,2,3,4],dimensions:{pointers,values}}));
    assert.equal(index.complete,false,'MG02 M21: dimension index values that contradict the positions never report complete ('+name+')');
    assert.deepEqual(index.entries.map(e=>e.frame).sort(),[1,2,3,4,5],'every stored frame stays reachable');
    const coverage=model.createCoverage(index);for(const e of index.entries)coverage.mark(e);
    assert.equal(coverage.snapshot().complete,false);
  }
  assert.equal(model.frameIndex(dbt({positions:[0,1,2],dimensions:{pointers,values:[[1],[2],[]]}})).complete,false,'a missing index value');
});

test('MG03-allow two DBTs of different length and spacing report their own positions in mm',()=>{
  const a=model.frameIndex(dbt({positions:[10,11,12,13,14]})),b=model.frameIndex(dbt({positions:[30,30.5,31,31.5,32,32.5,33,33.5,34],lat:'R'}));
  assert.equal(a.total,5);assert.equal(b.total,9);assert.equal(a.spacing,1);assert.equal(b.spacing,0.5);
  assert.equal(a.entries[2].position.offset,2);assert.equal(b.entries[2].position.offset,1,'the same slice number is not the same depth');
  for(const e of [...a.entries,...b.entries]){assert.equal(e.position.status,'verified');assert.equal(e.position.unit,'mm');assert.ok(e.position.basis);}
  // An oblique DBT measures along its own normal, not along a patient axis.
  const c=Math.SQRT1_2,oblique=model.frameIndex(dbt({iop:[0,1,0,c,0,-c],positions:[0,1,2,3].map(t=>[-t*c,0,-t*c]),lat:'R',view:'MLO'}));
  assert.equal(oblique.complete,true);assert.ok(Math.abs(oblique.entries[3].position.offset-3)<1e-9);
});

test('MG03-reject absent or non-finite positions stay Unverified and are never borrowed from another DBT',()=>{
  const none=model.frameIndex(dbt({omitPositions:true}));
  assert.equal(none.complete,false);
  assert.ok(none.entries.every(e=>e.position.status==='unverified'&&!('offset' in e.position)),'no millimetre value is invented');
  const bad=dbt({positions:[0,1,2,3,4]});bad['52009230'].Value[2]['00209113']=seq({'00200032':v('DS',-60,-10,'NaN')});
  const invalid=model.frameIndex(bad);
  assert.equal(invalid.complete,false);assert.ok(invalid.issues.includes('position-invalid'));
  assert.ok(invalid.entries.every(e=>e.position.status==='unverified'));
  const mixed=dbt({positions:[0,1,2,3,4]});mixed['52009230'].Value[4]['00209116']=seq({'00200037':v('DS',1,0,0,0,1,0)});
  assert.equal(model.frameIndex(mixed).complete,false);
  // Same frame count, one with positions and one without: the second never takes the first one's depths.
  const cur='1.2.826.0.1.3680043.10.7.1';
  const withPositions=dbt({lat:'L',view:'CC'}),withoutPositions=dbt({lat:'R',view:'CC',omitPositions:true});
  const p=model.plan(manifest(study(cur,'current',[withPositions,withoutPositions])));
  const left=model.frameIndex(withPositions),right=model.frameIndex(withoutPositions);
  assert.equal(left.entries.length,right.entries.length);
  assert.ok(left.entries.every(e=>e.position.status==='verified'));
  assert.ok(right.entries.every(e=>e.position.status==='unverified'),'MG03: positions are per object');
  assert.equal(slot(p,'current','L','CC','dbt').status,'ready');
  assert.equal(slot(p,'current','R','CC','dbt').status,'missing','a DBT whose geometry cannot be verified is not placed as slices');
});

test('MG04-allow current and prior are paired per side, view and kind, and a missing slot is explicit',()=>{
  const cur='1.2.826.0.1.3680043.10.7.1',pri='1.2.826.0.1.3680043.10.7.2',curSeries='1.2.826.0.1.3680043.10.8.10',priSeries='1.2.826.0.1.3680043.10.8.20';
  // One series holds all four views, as in a real screening export; laterality is read per object.
  const views=[['R','CC'],['L','CC'],['R','MLO'],['L','MLO']];
  const current=views.map(([lat,view],i)=>mg({study:cur,series:curSeries,lat,view,number:i+1}));
  const prior=views.map(([lat,view],i)=>mg({study:pri,series:priSeries,lat,view,number:i+1,date:'20230105',viewCode:VIEW[view+'_SRT']}));
  const synthetic=mg({study:cur,series:'1.2.826.0.1.3680043.10.8.11',lat:'R',view:'CC',type:['DERIVED','PRIMARY','TOMOSYNTHESIS','GENERATED_2D']});
  const p=model.plan(manifest(study(cur,'current',[...current,synthetic]),study(pri,'prior',prior)));
  assert.equal(p.status,'ok');assert.equal(p.prior.status,'ok');assert.equal(p.current.date,'2024-01-05');assert.equal(p.prior.date,'2023-01-05');
  views.forEach(([lat,view],i)=>{
    assert.equal(slot(p,'current',lat,view,'conventional').object.sop,current[i]['00080018'].Value[0],'current '+lat+' '+view);
    assert.equal(slot(p,'prior',lat,view,'conventional').object.sop,prior[i]['00080018'].Value[0],'prior '+lat+' '+view);
  });
  assert.equal(slot(p,'current','R','CC','generated2d').status,'ready');
  for(const [lat,view] of views.slice(1))assert.equal(slot(p,'current',lat,view,'generated2d').status,'missing');
  for(const [lat,view] of views)assert.equal(slot(p,'prior',lat,view,'dbt').status,'missing');
  assert.deepEqual(model.arrangement('compare-cc'),[{role:'current',side:'R',view:'CC'},{role:'current',side:'L',view:'CC'},
    {role:'prior',side:'R',view:'CC'},{role:'prior',side:'L',view:'CC'}]);
  const alone=model.plan(manifest(study(cur,'current',current)));
  assert.equal(alone.prior,null);for(const [lat,view] of views)assert.equal(slot(alone,'prior',lat,view,'conventional').status,'missing');
});

test('MG04-reject another patient, another institution, an ambiguous duplicate or a partial/modified view is never chosen',()=>{
  const cur='1.2.826.0.1.3680043.10.7.1',pri='1.2.826.0.1.3680043.10.7.2';
  const current=[mg({study:cur,lat:'R',view:'CC'}),mg({study:cur,lat:'L',view:'CC'})];
  const priorOf=patch=>[mg({study:pri,lat:'R',view:'CC',date:'20240105',...patch}),mg({study:pri,lat:'L',view:'CC',date:'20240105',...patch})];
  const other=model.plan(manifest(study(cur,'current',current),study(pri,'prior',priorOf({patient:'PT-2'}))));
  assert.equal(other.prior.status,'refused','MG04 M8: a prior of another patient is refused even on the same date');
  assert.equal(slot(other,'prior','R','CC','conventional').status,'refused');
  assert.ok(other.objects.filter(o=>o.role==='prior').every(o=>o.use==='refused'));
  assert.equal(model.plan(manifest(study(cur,'current',current),study(pri,'prior',priorOf({issuer:'SITE-B'})))).prior.status,'refused','another issuer');
  assert.equal(model.plan(manifest(study(cur,'current',current),study(pri,'prior',priorOf({}),'H2'))).prior.status,'refused','another institution');
  assert.equal(model.plan(manifest(study(cur,'current',current.map(i=>({...i,'00100030':v('DA','19700101')}))),
    study(pri,'prior',priorOf({birth:'19710101'})))).prior.status,'refused','conflicting birth dates');
  const dup=model.plan(manifest(study(cur,'current',[...current,mg({study:cur,lat:'R',view:'CC',number:7})])));
  const r=slot(dup,'current','R','CC','conventional');
  assert.equal(r.status,'ambiguous');assert.equal(r.candidates.length,2);assert.equal(r.object,undefined,'no duplicate is picked silently');
  const extras=model.plan(manifest(study(cur,'current',[mg({study:cur,lat:'R',view:'CC',modifiers:[['SCT','399055006']]}),
    mg({study:cur,lat:'L',view:'CC',modifiers:[['SRT','R-102D6']]}),mg({study:cur,lat:'R',view:'MLO',partial:'YES'}),
    mg({study:cur,lat:'B',view:'MLO',orientation:['P','F']}),mg({study:cur,lat:null,view:'MLO'})])));
  for(const [lat,view] of [['R','CC'],['L','CC'],['L','MLO']])assert.equal(slot(extras,'current',lat,view,'conventional').status,'missing',lat+' '+view);
  assert.equal(slot(extras,'current','R','MLO','conventional').status,'partial','a partial view gets its own slot, never the full one');
  assert.equal(extras.objects.filter(o=>o.use==='other').length,4,'spot, magnification, both-sides and unknown-side views stay listed');
  // Partial acquisition told by its section code alone (no Partial View flag), or by its description.
  for(const [name,extra] of [['section code only',PARTIAL_MEDIAL],['description only',{'00281351':v('ST','medial half')}]]){
    const part=mg({study:cur,lat:'R',view:'CC',extra});
    const c=model.classify(part);
    assert.equal(c.standard,false,'MG04 M19: a partial view is never matched as the full standard view ('+name+')');
    assert.equal(c.partial,true,name);
    const p=model.plan(manifest(study(cur,'current',[part,mg({study:cur,lat:'L',view:'CC'})])));
    assert.equal(slot(p,'current','R','CC','conventional').status,'partial',name);
    assert.equal(slot(p,'current','R','CC','conventional').object,undefined,'a partial slot needs an explicit choice');
  }
  assert.deepEqual(model.classify(mg({study:cur,lat:'R',view:'CC',extra:PARTIAL_MEDIAL})).partialSections,['Medial']);
  const conflict=model.classify(mg({study:cur,lat:'R',view:'CC',partial:'NO',extra:PARTIAL_MEDIAL}));
  assert.equal(conflict.status,'unverified','Partial View NO beside a section code is a contradiction');assert.equal(conflict.partialSlot,false);
  const both=model.plan(manifest(study(cur,'current',[mg({study:cur,lat:'R',view:'CC'}),mg({study:cur,lat:'R',view:'CC',extra:PARTIAL_MEDIAL})])));
  const full=slot(both,'current','R','CC','conventional');
  assert.equal(full.status,'ready');assert.equal(full.object.partial,false,'the full view is the one placed');assert.equal(full.partials.length,1);
  assert.equal(model.plan(manifest(study(cur,'current',current),study(pri,'current',current))).status,'refused','two current studies');
});

// R CC standard: rows run posterior (+y), columns run toward the medial side (+x, patient left).
const RCC_IOP=[0,1,0,1,0,0],RCC_ROW_REVERSED=[0,-1,0,1,0,0],RCC_COLUMN_REVERSED=[0,1,0,-1,0,0],RCC_BOTH_REVERSED=[0,-1,0,-1,0,0];
test('MG05-allow the requested frame\'s own orientation decides its horizontal and vertical flips',()=>{
  const item=dbt({lat:'R',view:'CC',positions:[0,1,2,3],frameIops:[RCC_IOP,RCC_ROW_REVERSED,RCC_COLUMN_REVERSED,RCC_BOTH_REVERSED]});
  const flips=[1,2,3,4].map(f=>{const o=model.displaySpec(item,f).orientation;return [o.status,o.flipH,o.flipV];});
  assert.deepEqual(flips,[['verified',false,false],['verified',true,false],['verified',false,true],['verified',true,true]],
    'MG05 M22: the orientation of the requested frame decides its flips');
  // Oblique view: superior must be up; a column running toward the head is turned over.
  const c=Math.SQRT1_2,mlo=dbt({lat:'R',view:'MLO',positions:[0,1],frameIops:[[0,1,0,c,0,-c],[0,1,0,c,0,c]]});
  assert.deepEqual([1,2].map(f=>model.displaySpec(mlo,f).orientation.flipV),[false,true]);
  // A 2D object with only Patient Orientation keeps using it.
  assert.equal(model.displaySpec(mg({lat:'L',view:'CC',orientation:['P','L']}),1).orientation.flipH,true);
});

test('MG05-reject a frame whose own tags disagree, or cannot decide, is shown as stored and Unverified',()=>{
  const item=dbt({lat:'R',view:'CC',positions:[0,1],frameIops:[RCC_IOP,RCC_ROW_REVERSED],extra:{'00200020':v('CS','P','L')}});
  const first=model.displaySpec(item,1).orientation,second=model.displaySpec(item,2).orientation;
  assert.equal(first.status,'verified');
  assert.deepEqual([second.status,second.flipH,second.flipV],['unverified',false,false],'Patient Orientation against this frame\'s orientation is a contradiction');
  const sideways=dbt({lat:'R',view:'CC',positions:[0,1],frameIops:[RCC_IOP,[1,0,0,0,1,0]]});
  const s=model.displaySpec(sideways,2).orientation;
  assert.deepEqual([s.status,s.flipH,s.flipV],['unverified',false,false],'a frame whose rows do not run anterior-posterior is not guessed');
  assert.equal(model.frameIndex(sideways).complete,false,'mixed per-frame orientation is reported by the index');
});

test('MG06-allow only the latest request of a slot in the live mount generation is current',()=>{
  const gate=model.createGate();
  const a=gate.begin('cell-1','sop#1');assert.equal(gate.current(a),true);
  const b=gate.begin('cell-1','sop#2');assert.equal(gate.current(b),true);assert.equal(gate.current(a),false);
  const other=gate.begin('cell-2','sop#1');assert.equal(gate.current(other),true);assert.equal(gate.current(b),true,'slots do not cancel each other');
  const id={institution:'H1',subject:'reader-1',sequence:4};
  assert.equal(model.sameIdentity(id,{...id}),true);
});

test('MG06-reject A->B->A, a reset, an end or another account invalidates older tickets',()=>{
  const gate=model.createGate();
  const first=gate.begin('cell-1','sop#5'),middle=gate.begin('cell-1','sop#6'),back=gate.begin('cell-1','sop#5');
  assert.equal(gate.current(first),false,'MG06 M9: returning to the same image does not revive the first request');
  assert.equal(gate.current(middle),false);assert.equal(gate.current(back),true);
  gate.reset();assert.equal(gate.current(back),false,'a new mount generation invalidates every older ticket');
  const fresh=gate.begin('cell-1','sop#5');assert.equal(gate.current(fresh),true);
  gate.end();assert.equal(gate.current(fresh),false);
  assert.equal(gate.current(gate.begin('cell-1','sop#5')),false,'nothing becomes current after the end');
  const id={institution:'H1',subject:'reader-1',sequence:4};
  for(const other of [{...id,subject:'reader-2'},{...id,institution:'H2'},{...id,sequence:5},{...id,subject:''},null])
    assert.equal(model.sameIdentity(id,other),false,JSON.stringify(other));
});
