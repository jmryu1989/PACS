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

test('owner scoped storage is strict and separates accounts',()=>{
  const memory=new Map(),storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)};
  const a=model.ownerKey({institution:'hospital',subject:'a'}),b=model.ownerKey({institution:'hospital',subject:'b'});assert.notEqual(a,b);
  model.write(storage,a,library());assert.deepEqual(plain(model.read(storage,a)),library());assert.equal(model.read(storage,b),null);
  memory.set(b,'{"version":1}');assert.throws(()=>model.read(storage,b),/손상/);assert.throws(()=>model.write(storage,a,{version:1}),/저장/);
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
  const value=library(),disabled=rule(ids[1],'Disabled'),miss=rule(ids[2],'MR only'),last=rule(ids[3],'Last CT');disabled.enabled=false;miss.match.modality='MR';value.rules=[value.rules[0],disabled,miss,last];value.activeRuleId=IDS[0];
  const context={studies:[studies()[0]],displaySets:[display('1.2.1.1','1.2.1',1)]},before=plain(value);
  assert.equal(model.navigate(value,context,null,'next').rule.name,'Brain CT');
  assert.equal(model.navigate(value,context,null,'previous').rule.name,'Last CT');
  assert.equal(model.navigate(value,context,IDS[0],'next').rule.name,'Last CT');
  assert.equal(model.navigate(value,context,ids[3],'previous').rule.name,'Brain CT');
  assert.deepEqual(model.navigate(value,context,ids[3],'next'),{kind:'no-match',reason:'end'});
  assert.deepEqual(model.navigate(value,context,IDS[0],'previous'),{kind:'no-match',reason:'end'});
  assert.deepEqual(value,before);assert.throws(()=>model.navigate(value,context,null,'sideways'),/방향/);
});
