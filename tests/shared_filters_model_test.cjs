const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sharedSearch, sharedLibrary, copySearchFolder, mergeCopiedFolders } = require('/app/dist/shared-filters.js');
const base = {id:1,name:'Example',mode:'Radiology',quick:'query',days:-1,cols:{mod:'CT'},sortKey:'date',sortDir:-1,
  folder:'A%/_/CT',description:'keep',ordinal:7};
const throws = (fn, status=400) => assert.throws(fn,e=>e.getStatus()===status);

test('publication keeps definitions and drops personal ownership/default/id',()=>{
  const actual=sharedSearch({...base,cols:JSON.stringify(base.cols),owner:'private',isDefault:true,createdAt:'private'},402);
  assert.deepEqual(actual,{...base,id:402});
  assert.equal(actual.owner,undefined);assert.equal(actual.isDefault,undefined);
  for(const changed of [{name:''},{name:'x'.repeat(201)},{cols:'not-json'},{cols:[]},{sortDir:2},{ordinal:-1}])
    throws(()=>sharedSearch({...base,...changed},1));
});

test('literal subtree copy preserves empties, metadata and compound criteria without input mutation',()=>{
  const folders=[{path:'A%/_/Empty',description:'empty',ordinal:2}];
  const filters=[{...base,cols:{__compound:{version:1,join:'or',rules:[{field:'mod',op:'eq',value:'CT'}]}}},{...base,id:2,name:'Other',folder:'Axy/_/CT'}];
  const before=JSON.stringify({folders,filters});const result=copySearchFolder(folders,filters,'A%/_','Shared/Sub','Team ');
  assert.equal(result.filters.length,1);assert.deepEqual(result.filters[0],{...filters[0],name:'Team Example',folder:'Shared/Sub/CT'});
  assert(result.folders.some(f=>f.path==='Shared/Sub/Empty'&&f.description==='empty'&&f.ordinal===2));
  assert.equal(JSON.stringify({folders,filters}),before);
  throws(()=>copySearchFolder(folders,filters,'A%/_','a/b/c/d/e',''),400);
  throws(()=>copySearchFolder(folders,filters,'Missing','New',''),404);
  throws(()=>copySearchFolder(folders,filters,'A%/_','New','  '),400);
  throws(()=>copySearchFolder(folders,filters,'A%/_','New',' Leading'),400);
});

test('root copy includes ungrouped searches and empty root',()=>{
  const copied=copySearchFolder([],[{...base,folder:''}],'','Root','');
  assert.equal(copied.filters[0].folder,'Root');assert(copied.folders.some(f=>f.path==='Root'));
  assert.deepEqual(copySearchFolder([],[],'','Empty',''),{folders:[{path:'Empty',description:'',ordinal:0}],filters:[]});
});

test('folder merge rejects implicit collisions and preserves unrelated parent metadata',()=>{
  const existing=[{path:'Parent',description:'keep parent',ordinal:9}];
  const copied=[{path:'Parent/New',description:'new',ordinal:1}];
  const result=mergeCopiedFolders(existing,[],copied,false);
  assert.deepEqual(result[0],existing[0]);assert.deepEqual(result[1],copied[0]);
  throws(()=>mergeCopiedFolders(existing,[{id:1,folder:'Parent/New/Child'}],copied,false),409);
  assert.deepEqual(mergeCopiedFolders(existing,[],[{...existing[0],description:'replace'}],true)[0].description,'replace');
});

test('library budgets, unique identities/names and strict stored fields',()=>{
  throws(()=>sharedLibrary([],[base,{...base,id:2}]));
  throws(()=>sharedLibrary([],[base,{...base,name:'second'}]));
  throws(()=>sharedLibrary([],[{...base,isDefault:true}]));
  throws(()=>sharedLibrary([],[{...base,quick:'x'.repeat(256*1024)}]));
  throws(()=>sharedLibrary([],Array.from({length:201},(_,i)=>({...base,id:i+1,name:String(i)}))));
  assert.equal(sharedLibrary([],[base]).filters.length,1);
});
