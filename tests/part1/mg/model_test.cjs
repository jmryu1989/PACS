// TEST-MG-MODEL (E-MG R1): REQ-MG-01/02/03/04/06 -> RISK-MG-MISCLASS/OMIT/FALSE-ANATOMY/WRONG-STUDY/STALE.
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
  frameTypes=null,omitPositions=false,imageType=['ORIGINAL','PRIMARY','VOLUME','NONE'],frameType=null}={}){
  const count=frames===null?positions.length:frames;
  // frameTypes[i] = [Volumetric Properties, Volume Based Calculation Technique] of frame i+1.
  const items=(perFrame||positions.map((z,i)=>{
    const ft=frameTypes&&frameTypes[i]||[volumetric,technique];
    return {'00189504':seq({'00089007':v('CS',...(frameType||imageType)),'00089206':v('CS',ft[0]),'00089207':v('CS',ft[1])}),
      ...(omitPositions?{}:{'00209113':seq({'00200032':v('DS',...(Array.isArray(z)?z:[-60,-10,z]))})})};
  }));
  return {'00080016':v('UI',DBT),'00080018':v('UI',sop),'0020000D':v('UI',study),'0020000E':v('UI',series),'00080060':v('CS','MG'),
    '00080008':v('CS',...imageType),'00100020':v('LO',patient),'00080020':v('DA','20240105'),
    '00280008':v('IS',count),'00280010':v('US',120),'00280011':v('US',90),'00280004':v('CS','MONOCHROME2'),'00280101':v('US',12),
    '00540220':seq({'00080102':v('SH',VIEW[view][0]),'00080100':v('SH',VIEW[view][1])}),
    '52009229':seq({'00209071':seq({'00209072':v('CS',lat)}),'00209116':seq({'00200037':v('DS',...iop)}),
      '00289110':seq({'00180050':v('DS',thickness),'00280030':v('DS',0.1,0.1)})}),
    '52009230':{vr:'SQ',Value:items}};
}
const study=(uid,role,instances,institution='H1')=>({uid,role,institution,instances});
const manifest=(...studies)=>({institution:'H1',studies});
const slot=(p,role,side,view,kind)=>p.slots[[role,side,view,kind].join('|')];

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
  const slab=model.classify(dbt({technique:'MAX_IP',volumetric:'SAMPLED',thickness:10}));
  assert.equal(slab.kind,'dbt');assert.equal(slab.sliceKind,'mip-slab','a MIP slab is reported as what is stored, not as thin slices');assert.equal(slab.sliceThickness,10);
  // Volumetric Properties VOLUME names regularly sampled slices even when the technique says MAX_IP.
  const volume=model.classify(dbt({technique:'MAX_IP',volumetric:'VOLUME',thickness:1}));
  assert.equal(volume.sliceKind,'slices');assert.ok(volume.notes.length>0,'the disagreeing technique is kept as a note');
  // A device synthetic 2D view stored as a one-frame Breast Tomosynthesis object.
  const stored2d=model.classify(dbt({positions:[0],technique:'MAX_IP',volumetric:'VOLUME',thickness:54,
    imageType:['DERIVED','PRIMARY','TOMOSYNTHESIS','GENERATED_2D']}));
  assert.equal(stored2d.kind,'generated2d');assert.equal(stored2d.status,'verified');assert.equal(stored2d.standard,true);
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
  const generated=['DERIVED','PRIMARY','TOMOSYNTHESIS','GENERATED_2D'];
  for(const [name,object] of [['many frames',dbt({imageType:generated})],
    ['frame type disagrees',dbt({positions:[0],imageType:generated,frameType:['DERIVED','PRIMARY','TOMOSYNTHESIS','NONE']})],
    ['Value 3 not tomosynthesis',dbt({positions:[0],imageType:['DERIVED','PRIMARY','VOLUME','GENERATED_2D']})]]){
    const c=model.classify(object);
    assert.notEqual(c.kind,'generated2d',name);assert.equal(c.standard,false,name);
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
  const p=model.plan(manifest(study(cur,'current',[dbt({lat:'L',view:'CC'}),dbt({lat:'R',view:'CC',omitPositions:true})])));
  const left=model.frameIndex(slot(p,'current','L','CC','dbt').object.item),right=model.frameIndex(slot(p,'current','R','CC','dbt').object.item);
  assert.equal(left.entries.length,right.entries.length);
  assert.ok(left.entries.every(e=>e.position.status==='verified'));
  assert.ok(right.entries.every(e=>e.position.status==='unverified'),'MG03: positions are per object');
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
  for(const [lat,view] of [['R','CC'],['L','CC'],['R','MLO'],['L','MLO']])assert.equal(slot(extras,'current',lat,view,'conventional').status,'missing',lat+' '+view);
  assert.equal(extras.objects.filter(o=>o.use==='other').length,5,'spot, magnification, partial, both-sides and unknown-side views stay listed');
  assert.equal(model.plan(manifest(study(cur,'current',current),study(pri,'current',current))).status,'refused','two current studies');
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
