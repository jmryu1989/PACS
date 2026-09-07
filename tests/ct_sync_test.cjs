const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('config/ohif.js','utf8');
const model=vm.runInNewContext(source.slice(source.indexOf('const kinCTSyncModel'),source.indexOf('function kinCreateCTSync'))+';kinCTSyncModel');
const plane=z=>({frameOfReferenceUID:'1.2.3',imagePositionPatient:[0,0,z],rowCosines:[1,0,0],columnCosines:[0,1,0]});
const stack=zs=>({patient:'institution/patient',classic:true,index:0,planes:zs.map(plane)});
const copy=x=>JSON.parse(JSON.stringify(x));
test('physical location, reversed order and stable ties replace index correspondence',()=>{
 assert.equal(model.match(stack([8]),stack([0,4,8,12])).index,2);
 assert.equal(model.match(stack([8]),stack([12,8,4,0])).index,1);
 assert.equal(model.match(stack([6]),stack([0,4,8,12])).index,1);
 assert.equal(model.match(stack([6]),stack([12,8,4,0])).index,1);
});
test('unrelated patients, absent identity and unsupported viewport refuse',()=>{
 for(const patch of [{patient:'other'},{patient:''},{classic:false}])assert.equal(model.match(stack([2]),{...stack([0,2,4]),...patch}).index,-1);
 assert.equal(model.match(null,stack([0,2])).index,-1);
});
test('different or missing frame of reference never creates an offset',()=>{
 for(const uid of ['',undefined,'9.9']){const t=stack([0,2]);t.planes[1].frameOfReferenceUID=uid;assert.equal(model.match(stack([0]),t).index,-1);}
});
test('finite orthonormal directions and non-default geometry required',()=>{
 for(const patch of [{imagePositionPatient:[NaN,0,0]},{rowCosines:[1,1,0]},{columnCosines:[1,0,0]},{rowCosines:[1,0]},{isDefaultValueSetForRowCosine:true}]){
  const s=stack([2]);Object.assign(s.planes[0],patch);assert.equal(model.match(s,stack([0,2,4])).index,-1);
 }
 const t=stack([0,2]);t.planes[1].rowCosines=[0,0,1];assert.equal(model.match(stack([0]),t).index,-1);
});
test('range endpoints, duplicate planes, single-frame and large gaps fail closed',()=>{
 for(const [z,positions] of [[-1,[0,2,4]],[5,[0,2,4]],[2,[0,2,2,4]],[0,[0]],[8,[0,2,14,16]]])assert.equal(model.match(stack([z]),stack(positions)).index,-1);
 assert.equal(model.match(stack([4]),stack([0,2,4])).index,2);
});
test('parallel plane translation is allowed but tilted stack origins are refused',()=>{
 const s=stack([2]);s.planes[0].imagePositionPatient=[100,50,2];assert.equal(model.match(s,stack([0,2,4])).index,1);
 const t=stack([0,2,4]);t.planes[1].imagePositionPatient[0]=1;assert.equal(model.match(s,t).index,-1);
});
test('anti-parallel orientation represents the same physical plane',()=>{
 const t=stack([0,2,4]);t.planes.forEach(p=>p.columnCosines=[0,-1,0]);assert.equal(model.match(stack([2]),t).index,1);
});
test('matching preserves source and target metadata and bounds scan work',()=>{
 const s=stack([3]),t=stack([0,2,4]);const before=JSON.stringify([s,t]);model.match(s,t);assert.equal(JSON.stringify([s,t]),before);
 assert.equal(model.match(s,stack(Array.from({length:2001},(_,i)=>i))).index,-1);
 assert.equal(model.match(copy(s),copy(t)).index,1);
});
