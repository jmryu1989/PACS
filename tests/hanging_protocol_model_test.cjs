const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const model=require('../worklist-v0/hpacs-lite/hanging-protocol-model.js');
const contract=JSON.parse(fs.readFileSync(path.join(__dirname,'hanging_protocol_contract_cases.json'),'utf8'));

const IDS=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const selector=(alias='Current')=>({alias,role:'current',historical:false,modality:null,retrieveAE:null,bodyPart:null,description:null,laterality:null,order:'ascending',occurrence:1});
const rule=(id=IDS[0],name='Brain CT')=>({id,name,enabled:true,match:{modality:null,retrieveAE:null,bodyPart:null,description:null},selectors:[selector()],layout:{rows:1,cols:1,cells:['Current']}});
const library=()=>({version:1,activeRuleId:IDS[0],rules:[rule()]});
const plain=value=>JSON.parse(JSON.stringify(value));
const image=(patch={})=>({RetrieveAETitle:'ARCHIVE',BodyPartExamined:'HEAD',Laterality:'L',...patch});
const display=(uid,study,number,patch={})=>({displaySetInstanceUID:'ds-'+uid,StudyInstanceUID:study,SeriesInstanceUID:uid,SeriesNumber:number,SeriesDescription:'Brain Axial',Modality:'CT',images:[image(),image()],...patch});
const studies=()=>[{uid:'1.2.1',sourcePatientKey:'site|patient',date:'20260912',modality:'CT',desc:'Head CT'},
  {uid:'1.2.2',sourcePatientKey:'site|patient',date:'20250912',modality:'CT',desc:'Old Head CT'}];

test('shared client/server contract vectors agree with strict normalization',()=>{
  assert.equal(contract.version,1);
  for(const item of contract.valid)assert.deepEqual(plain(model.normalize(item.value)),item.value,item.name);
  for(const item of contract.invalid)assert.equal(model.normalize(item.value),null,item.name);
});

test('strict v1 schema round trips ordered rules, explicit vacancy and duplicate selector cells',()=>{
  const value=library(),r=value.rules[0];r.selectors.push({...selector('Related'),role:'related',historical:true});r.layout={rows:2,cols:2,cells:['Current',null,'Related','Current']};
  assert.deepEqual(plain(model.normalize(value)),value);
  const second=rule(IDS[1],'MR');value.rules.push(second);assert.deepEqual(model.normalize(value).rules.map(x=>x.id),IDS);
});

test('schema rejects extra keys, noncanonical tokens, names/aliases, active ids and unsupported grids',()=>{
  const mutations=[v=>v.extra=1,v=>v.version=2,v=>v.activeRuleId=IDS[1],v=>v.rules[0].name=' Brain CT',
    v=>v.rules.push(rule(IDS[1],'brain ct')),v=>v.rules[0].match.modality='ct',v=>v.rules[0].match.retrieveAE=' A',
    v=>v.rules[0].selectors[0].alias='',v=>v.rules[0].selectors[0].alias='Current 1',v=>v.rules[0].selectors[0].alias='현재',v=>v.rules[0].selectors.push({...selector('current')}),v=>v.rules[0].selectors[0].role='prior',
    v=>v.rules[0].selectors[0].historical=true,v=>v.rules[0].selectors[0].occurrence=0,v=>v.rules[0].layout={rows:2,cols:1,cells:['Current',null]},
    v=>v.rules[0].layout.cells=[null],v=>v.rules[0].layout.cells=['Missing'],v=>v.rules[0].match.description={operator:'regex',value:'.*'},v=>v.rules[0].enabled=false];
  for(const mutate of mutations){const value=library();mutate(value);assert.equal(model.normalize(value),null,JSON.stringify(value));}
  const tooMany=library();while(tooMany.rules.length<21)tooMany.rules.push(rule(crypto.randomUUID(),'Rule '+tooMany.rules.length));assert.equal(model.normalize(tooMany),null);
});

const CT_IMAGE='1.2.840.10008.5.1.4.1.1.2';
// A regular axial CT: one frame of reference, constant in-plane geometry and a constant
// 2.5 mm step along the slice normal, which is what the volume loader reconstructs.
const GEOMETRY={Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2',FrameOfReferenceUID:'1.2.9.0',
  Rows:512,Columns:512,PixelSpacing:[0.7,0.7],ImageOrientationPatient:[1,0,0,0,1,0]};
const slice=(n,patch={})=>({...image(),SOPClassUID:CT_IMAGE,SOPInstanceUID:'1.2.9.'+n,...GEOMETRY,ImagePositionPatient:[-150,-150,(n-1)*2.5],...patch});
const slices=count=>Array.from({length:count},(_,n)=>slice(n+1));
const volume=(uid,study,number,patch={})=>display(uid,study,number,{images:[slice(1),slice(2),slice(3)],...patch});
const plane=(alias,orientation)=>({alias,view:'mpr',orientation});

test('plane cells stay one viewport each, keep string cells byte-identical and reject unknown shapes',()=>{
  const value=library(),r=value.rules[0];
  r.layout={rows:2,cols:2,cells:[plane('Current','axial'),plane('Current','sagittal'),plane('Current','coronal'),null]};
  assert.deepEqual(plain(model.normalize(value)),value,'a three-plane layout round trips without a version bump');
  assert.equal(model.normalize(value).rules[0].layout.cells.length,4,'three planes are three cells, never one cell that expands');
  const mixed=library();mixed.rules[0].layout={rows:1,cols:2,cells:['Current',plane('Current','coronal')]};
  assert.deepEqual(plain(model.normalize(mixed)),mixed);
  assert.equal(typeof model.normalize(mixed).rules[0].layout.cells[0],'string','a stack cell is still the bare alias string');
  const mutations=[v=>v.rules[0].layout.cells[0]={...plane('Current','axial'),thickness:5},v=>v.rules[0].layout.cells[0]=plane('Current','oblique'),
    v=>v.rules[0].layout.cells[0]={...plane('Current','axial'),view:'vr'},v=>v.rules[0].layout.cells[0]={...plane('Current','axial'),view:'stack'},
    v=>v.rules[0].layout.cells[0]=plane('Missing','axial'),v=>v.rules[0].layout.cells[0]=plane('current','axial'),
    v=>v.rules[0].layout.cells={0:plane('Current','axial'),length:1},v=>v.rules[0].layout.cells[1]=plane('Current','axial')];
  for(const mutate of mutations){const broken=library();broken.rules[0].layout={rows:1,cols:2,cells:[plane('Current','axial'),null]};mutate(broken);
    assert.equal(model.normalize(broken),null,JSON.stringify(broken.rules[0].layout));}
  assert.deepEqual(model.cellSpec('Current'),{alias:'Current',view:'stack',orientation:null});
  assert.deepEqual(model.cellSpec(plane('Current','axial')),{alias:'Current',view:'mpr',orientation:'axial'});
  assert.equal(model.cellSpec({alias:'Current',view:'mpr'}),null);
});

test('a plane cell needs one eligible CT volume and fails before any layout change',()=>{
  const value=library(),r=value.rules[0];
  r.layout={rows:2,cols:2,cells:[plane('Current','axial'),plane('Current','sagittal'),plane('Current','coronal'),null]};
  const context=sets=>({studies:[studies()[0]],displaySets:sets});
  const good=volume('1.2.1.1','1.2.1',1),result=model.resolve(value,context([good]));
  assert.equal(result.kind,'match');
  assert.deepEqual(result.cells.map(cell=>cell&&cell.displaySetInstanceUID),['ds-1.2.1.1','ds-1.2.1.1','ds-1.2.1.1',null],
    'every plane of the layout references the same single volume');
  for(const patch of [{Modality:'MR'},{images:[slice(1)]},{images:[slice(1),{...slice(2),SOPClassUID:'1.2.840.10008.5.1.4.1.1.7'}]},
    {images:[slice(1),slice(1)]},{images:[slice(1),{...slice(2),SOPInstanceUID:''}]}]){
    const rejected=model.resolve(value,context([volume('1.2.1.1','1.2.1',1,patch)]));
    assert.equal(rejected.kind,'no-match',JSON.stringify(patch));
  }
  const split=[volume('1.2.1.1','1.2.1',1),{...volume('1.2.1.1','1.2.1',1),displaySetInstanceUID:'split'}];
  assert.equal(model.resolve(value,context(split)).kind,'no-match','a split series is refused before the screen changes');
  // The same source stays a valid ordinary stack cell: legacy rules keep behaving identically.
  const stack=library();assert.equal(model.resolve(stack,context([display('1.2.1.1','1.2.1',1)])).kind,'match');
  assert.equal(model.volumeEligible(good),true);
  assert.equal(model.volumeEligible(display('1.2.1.1','1.2.1',1)),false);
});

test('an unreconstructable CT is refused before the layout changes, not after the screen is gone',()=>{
  const value=library(),r=value.rules[0];
  r.layout={rows:2,cols:2,cells:[plane('Current','axial'),plane('Current','sagittal'),plane('Current','coronal'),null]};
  const context=sets=>({studies:[studies()[0]],displaySets:sets});
  // Every source below satisfies Modality CT + CT Image Storage + unique SOPInstanceUID and is
  // still not a volume. The same predicates the MPR job and the MPR Orientation panel enforce
  // (viewer-volume-job.js:8-11, viewer-volume-orientation.js:23,43) decide it here instead.
  const unreconstructable={
    'two slice topogram, frontal and lateral':[slice(1),{...slice(2),ImageOrientationPatient:[1,0,0,0,0,-1],ImagePositionPatient:[-150,0,-150]}],
    'uneven 5 / 5 / 37 mm spacing':[0,5,10,47].map((z,n)=>slice(n+1,{ImagePositionPatient:[-150,-150,z]})),
    'palette colour CT':slices(3).map(frame=>({...frame,SamplesPerPixel:3,PhotometricInterpretation:'PALETTE COLOR'})),
    'mixed frame of reference':slices(3).map((frame,n)=>n===2?{...frame,FrameOfReferenceUID:'1.2.9.9'}:frame),
    'more frames than the loader accepts':Array.from({length:257},(_,n)=>slice(n+1)),
    'mixed matrix size':slices(3).map((frame,n)=>n===2?{...frame,Rows:256}:frame),
    'mixed pixel spacing':slices(3).map((frame,n)=>n===2?{...frame,PixelSpacing:[0.5,0.5]}:frame),
    'gantry tilted positions off the slice normal':slices(3).map((frame,n)=>({...frame,ImagePositionPatient:[-150,-150+n*1.5,n*2.5]})),
    'two frames at the same position':[slice(1),slice(2,{ImagePositionPatient:[-150,-150,0]})],
    'missing ImagePositionPatient':slices(3).map((frame,n)=>n===1?{...frame,ImagePositionPatient:undefined}:frame),
    'missing ImageOrientationPatient':slices(3).map(frame=>({...frame,ImageOrientationPatient:undefined}))};
  for(const [name,images] of Object.entries(unreconstructable)){
    const source=volume('1.2.1.1','1.2.1',1,{images});
    assert.equal(model.volumeEligible(source),false,name);
    assert.equal(model.resolve(value,context([source])).kind,'no-match',name);
    // The very same series is still an ordinary stack cell: legacy rules are untouched.
    assert.equal(model.resolve(library(),context([source])).kind,'match',name);
  }
  // DICOM string multi-values and the loader limits themselves stay accepted.
  const strings=volume('1.2.1.1','1.2.1',1,{images:slices(3).map(frame=>({...frame,PixelSpacing:'0.7\\0.7',
    ImageOrientationPatient:'1\\0\\0\\0\\1\\0',ImagePositionPatient:frame.ImagePositionPatient.join('\\')}))});
  assert.equal(model.volumeEligible(strings),true,'naturalized and raw DICOM multi-values agree');
  assert.equal(model.volumeEligible(volume('1.2.1.1','1.2.1',1,{images:Array.from({length:256},(_,n)=>slice(n+1))})),true,'256 frames is the accepted limit');
  const oblique=volume('1.2.1.1','1.2.1',1,{images:[0,2.5,5].map((along,n)=>slice(n+1,{ImageOrientationPatient:[1,0,0,0,0,-1],
    ImagePositionPatient:[-150,along,-150]}))});
  assert.equal(model.volumeEligible(oblique),true,'a consistently oriented coronal acquisition is still a volume');
});

test('owner scoped storage is strict and separates accounts',()=>{
  const memory=new Map(),storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)};
  const a=model.ownerKey({institution:'hospital',subject:'a'}),b=model.ownerKey({institution:'hospital',subject:'b'});assert.notEqual(a,b);
  model.write(storage,a,library());assert.deepEqual(plain(model.read(storage,a)),library());assert.equal(model.read(storage,b),null);
  memory.set(b,'{"version":1}');assert.throws(()=>model.read(storage,b),/손상/);assert.throws(()=>model.write(storage,a,{version:1}),/저장/);
});

test('site scoped storage is keyed by institution only and never collides with a personal key',()=>{
  const site=model.siteKey({institution:'hospital'}),other=model.siteKey({institution:'other'});
  assert.notEqual(site,other);
  assert.notEqual(site,model.ownerKey({institution:'hospital',subject:'a'}));
  // Two accounts of one institution read the same site library; a personal subject never can.
  assert.equal(model.siteKey({institution:'hospital',subject:''}),site);
  assert.equal(model.siteKey({institution:'hospital',subject:'a'}),null,'a real subject is not a site owner');
  assert.equal(model.siteKey({institution:''}),null);
  assert.deepEqual(model.siteOwner({institution:'hospital'}),{institution:'hospital',subject:''});
  assert.equal(model.scopeKey('site',{institution:'hospital'}),site);
  assert.equal(model.scopeKey('personal',{institution:'hospital',subject:'a'}),model.ownerKey({institution:'hospital',subject:'a'}));
  assert.equal(model.scopeKey('other',{institution:'hospital',subject:'a'}),null);
});

test('personal rules win and the site library is only a fallback, never an override',()=>{
  const context={studies:[studies()[0]],displaySets:[display('1.2.1.1','1.2.1',1)]};
  const personal=library();personal.rules[0].name='My CT';
  const site=library();site.rules[0].id=IDS[1];site.rules[0].name='Site CT';site.activeRuleId=IDS[1];
  const both=model.resolveScoped({personal,site},context,null);
  assert.equal(both.scope,'personal');assert.equal(both.rule.name,'My CT');
  // Only when no enabled personal rule matches does the institution library get a turn.
  const noMatch=library();noMatch.rules[0].match.modality='MR';noMatch.activeRuleId=null;
  const fell=model.resolveScoped({personal:noMatch,site},context,null);
  assert.equal(fell.scope,'site');assert.equal(fell.rule.name,'Site CT');
  // An account with no personal library at all still gets the institution rules.
  assert.equal(model.resolveScoped({personal:null,site},context,null).scope,'site');
  // Neither scope matching keeps the current layout: no-match, not a site override.
  const neither=model.resolveScoped({personal:noMatch,site:noMatch},context,null);
  assert.deepEqual(neither,{kind:'no-match'});
  assert.deepEqual(model.resolveScoped({personal:null,site:null},context,null),{kind:'no-match'});
  // A corrupt site cache must not break the personal scope it is only a fallback for.
  assert.equal(model.resolveScoped({personal,site:{version:1}},context,null).scope,'personal');
  // An explicitly selected rule applies from exactly the scope that was asked for.
  assert.equal(model.resolveScoped({personal,site},context,{scope:'site',ruleId:IDS[1]}).scope,'site');
  assert.equal(model.resolveScoped({personal,site},context,{scope:'personal',ruleId:IDS[0]}).scope,'personal');
  assert.equal(model.resolveScoped({personal,site},context,{scope:'site',ruleId:IDS[0]}).kind,'no-match');
  assert.throws(()=>model.resolveScoped({personal,site},context,{scope:'account',ruleId:IDS[0]}),/범위/);
  assert.throws(()=>model.resolveScoped({personal,site},context,{scope:'personal'}),/범위/);
  assert.throws(()=>model.resolveScoped({personal,site:{version:1}},context,{scope:'site',ruleId:IDS[1]}),/형식/);
});

test('a site fallback opens the same MPR planes a personal rule would have opened',()=>{
  const planes=value=>{value.rules[0].layout={rows:2,cols:2,
    cells:[plane('Current','axial'),plane('Current','sagittal'),plane('Current','coronal'),null]};return value;};
  const context={studies:[studies()[0]],displaySets:[volume('1.2.1.1','1.2.1',1)]};
  const personal=planes(library()),direct=model.resolve(personal,context);
  const empty=library();empty.rules=[];empty.activeRuleId=null;
  const site=planes(library());site.rules[0].id=IDS[1];site.activeRuleId=IDS[1];
  const fell=model.resolveScoped({personal:empty,site},context,null);
  assert.equal(fell.scope,'site');
  assert.deepEqual(fell.rule.layout.cells,direct.rule.layout.cells,'the site rule carries the identical plane cells');
  assert.deepEqual(fell.cells.map(cell=>cell&&cell.displaySetInstanceUID),
    direct.cells.map(cell=>cell&&cell.displaySetInstanceUID),'and resolves them onto the same single volume');
  // The same pre-check protects a site rule: an unreconstructable source fails before any
  // layout change, so a site fallback can never destroy the screen a personal rule kept.
  const weak={studies:[studies()[0]],displaySets:[display('1.2.1.1','1.2.1',1)]};
  assert.deepEqual(model.resolveScoped({personal:empty,site},weak,null),{kind:'no-match'});
});

test('scoped navigation walks personal rules before site rules and keys the cursor by scope',()=>{
  const context={studies:[studies()[0]],displaySets:[display('1.2.1.1','1.2.1',1)]};
  const personal=library();personal.rules[0].name='Mine';
  // The same rule id in both scopes must not be confused for one position in the walk.
  const site=library();site.rules[0].name='Theirs';
  assert.equal(model.navigateScoped({personal,site},context,null,'next').scope,'personal');
  assert.equal(model.navigateScoped({personal,site},context,null,'previous').scope,'site');
  const second=model.navigateScoped({personal,site},context,{scope:'personal',ruleId:IDS[0]},'next');
  assert.equal(second.scope,'site');assert.equal(second.rule.name,'Theirs');
  assert.deepEqual(model.navigateScoped({personal,site},context,{scope:'site',ruleId:IDS[0]},'next'),{kind:'no-match',reason:'end'});
  assert.equal(model.navigateScoped({personal,site},context,{scope:'site',ruleId:IDS[0]},'previous').scope,'personal');
  assert.deepEqual(model.navigateScoped({personal,site},context,{scope:'personal',ruleId:IDS[0]},'previous'),{kind:'no-match',reason:'end'});
  assert.deepEqual(model.navigateScoped({personal:null,site:null},context,null,'next'),{kind:'no-match',reason:'none'});
  assert.throws(()=>model.navigateScoped({personal,site},context,null,'first'),/방향/);
  assert.throws(()=>model.navigateScoped({personal,site},context,{scope:'personal',ruleId:'bad'},'next'),/마지막 적용/);
  assert.throws(()=>model.navigateScoped({personal,site},context,{scope:'account',ruleId:IDS[0]},'next'),/마지막 적용/);
});

test('specified metadata is exact and missing or mixed image metadata is unknown',()=>{
  assert.deepEqual(plain(model.displayMetadata(display('1.3','1.2.1',1))),{modality:'CT',retrieveAE:'ARCHIVE',bodyPart:'HEAD',description:'Brain Axial',laterality:'L',seriesNumber:1});
  for(const patch of [{images:[image(),image({RetrieveAETitle:'OTHER'})]},{images:[image(),image({BodyPartExamined:''})]},
    {images:[image(),image({Laterality:'R'})]},{images:[]}]){
    const metadata=model.displayMetadata(display('1.3','1.2.1',1,patch));
    if(patch.images.length===0)assert.equal(metadata.retrieveAE,null);else assert.ok([metadata.retrieveAE,metadata.bodyPart,metadata.laterality].includes(null));
  }
});

test('matching uses URL study roles, historical dates and deterministic series order',()=>{
  const value=library(),r=value.rules[0];r.match={modality:'CT',retrieveAE:'ARCHIVE',bodyPart:'HEAD',description:{operator:'contains',value:'head'}};
  r.selectors=[selector('Current'),{...selector('Related'),role:'related',historical:true,modality:'CT',retrieveAE:'ARCHIVE',bodyPart:'HEAD',description:{operator:'contains',value:'axial'},laterality:'L',occurrence:2}];
  r.layout={rows:2,cols:2,cells:['Current','Related','Related',null]};
  const sets=[display('1.2.1.1','1.2.1',1),display('1.2.2.20','1.2.2',20),display('1.2.2.10','1.2.2',10)];
  let result=model.resolve(value,{studies:studies(),displaySets:sets});assert.equal(result.kind,'match');assert.deepEqual(result.cells.slice(1,3).map(x=>x.SeriesNumber),[20,20]);
  r.selectors[1].order='descending';result=model.resolve(value,{studies:studies(),displaySets:sets});assert.deepEqual(result.cells.slice(1,3).map(x=>x.SeriesNumber),[10,10]);
  for(const date of ['20260912','20270912','broken']){const rows=studies();rows[1].date=date;assert.equal(model.resolve(value,{studies:rows,displaySets:sets}).kind,'no-match');}
  r.selectors[1].historical=false;const rows=studies();rows[1].date='20270912';assert.equal(model.resolve(value,{studies:rows,displaySets:sets}).kind,'match');
});

test('safe resolution rejects patient mismatch and treats missing selectors or split ambiguity as no-match',()=>{
  const value=library(),sets=[display('1.2.1.1','1.2.1',1)];assert.equal(model.resolve(value,{studies:[studies()[0]],displaySets:sets}).kind,'match');
  assert.equal(model.resolve(value,{studies:[studies()[0]],displaySets:[]}).kind,'no-match');
  const split=[display('1.2.1.1','1.2.1',1),{...display('1.2.1.1','1.2.1',1),displaySetInstanceUID:'split'}];assert.equal(model.resolve(value,{studies:[studies()[0]],displaySets:split}).kind,'no-match');
  const wrong=studies();wrong[1].sourcePatientKey='other';assert.throws(()=>model.resolve(value,{studies:wrong,displaySets:sets}),/같은 원본 환자/);
});

test('first enabled matching rule wins when no rule is selected',()=>{
  const value=library();value.activeRuleId=null;value.rules.unshift({...rule(IDS[1],'Disabled'),enabled:false});
  const result=model.resolve(value,{studies:[studies()[0]],displaySets:[display('1.2.1.1','1.2.1',1)]});assert.equal(result.rule.id,IDS[0]);
});

test('previous and next traverse only ordered enabled fully matched rules without wrapping',()=>{
  const ids=[IDS[0],'22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
  const value=library(),disabled=rule(ids[1],'Disabled'),miss=rule(ids[2],'MR only'),last=rule(ids[3],'Last CT');disabled.enabled=false;value.rules[0].match.modality='CT';miss.match.modality='MR';last.match.modality='CT';value.rules=[value.rules[0],disabled,miss,last];value.activeRuleId=IDS[0];
  const context={studies:[studies()[0]],displaySets:[display('1.2.1.1','1.2.1',1)]},before=plain(value);
  assert.equal(model.navigate(value,context,null,'next').rule.name,'Brain CT');
  assert.equal(model.navigate(value,context,null,'previous').rule.name,'Last CT');
  assert.equal(model.navigate(value,context,IDS[0],'next').rule.name,'Last CT');
  assert.equal(model.navigate(value,context,ids[3],'previous').rule.name,'Brain CT');
  assert.deepEqual(model.navigate(value,context,ids[3],'next'),{kind:'no-match',reason:'end'});
  assert.deepEqual(model.navigate(value,context,IDS[0],'previous'),{kind:'no-match',reason:'end'});
  const changed={studies:[{...studies()[0],desc:'MR follow-up',modality:'MR'}],displaySets:[{...display('1.2.1.1','1.2.1',1),Modality:'MR'}]};
  assert.equal(model.navigate(value,changed,IDS[0],'next').rule.id,ids[2],"a cursor that no longer matches restarts from the fresh matching list");
  assert.equal(model.navigate(value,changed,IDS[0],'previous').rule.id,ids[2]);
  assert.deepEqual(value,before);assert.throws(()=>model.navigate(value,context,null,'sideways'),/방향/);
});
