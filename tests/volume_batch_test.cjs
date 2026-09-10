const {test}=require('node:test'),assert=require('node:assert/strict');
const {plan}=require('../worklist-v0/hpacs-lite/volume-batch.js');
const camera={focalPoint:[32,31,16],position:[32,31,-50],viewPlaneNormal:[0,0,-1],viewUp:[0,-1,0],parallelProjection:true,parallelScale:40,flipHorizontal:true};
const corners=[0,63].flatMap(x=>[0,63].flatMap(y=>[0,32].map(z=>[x,y,z])));
const input={camera,corners,offset:-12,interval:12,count:3,width:800,height:600};
test('physical offsets include endpoints and preserve the source camera',()=>{
 const before=structuredClone(input),result=plan(input);
 assert.deepEqual(result.cameras.map(c=>c.focalPoint),[[32,31,28],[32,31,16],[32,31,4]]);
 assert.deepEqual(result.cameras.map(c=>c.position),[[32,31,-38],[32,31,-50],[32,31,-62]]);
 assert.deepEqual(input,before);assert.equal(result.columns,512);assert.equal(result.rows,384);
 assert.deepEqual(plan({...input,offset:-16,interval:32,count:2}).cameras.map(c=>c.focalPoint[2]),[32,0]);
 assert.deepEqual(plan({...input,offset:12,reverse:true}).cameras.map(c=>c.focalPoint[2]),[4,16,28]);
});
test('oblique planes advance along the patient normal without tangential drift',()=>{
 const n=[1/Math.sqrt(2),0,1/Math.sqrt(2)],oblique={...camera,viewPlaneNormal:n,viewUp:[0,1,0]};
 const result=plan({...input,camera:oblique,offset:0,interval:.25,count:20});
 result.cameras.forEach((c,i)=>{assert.ok(Math.abs(c.focalPoint[0]-(32+i*.25/Math.sqrt(2)))<1e-12);assert.ok(Math.abs(c.focalPoint[2]-(16+i*.25/Math.sqrt(2)))<1e-12);assert.equal(c.focalPoint[1],31);});
});
test('reject invalid geometry, count, physical extent and memory budget',()=>{
 for(const value of [0,1,129,2.5,NaN])assert.throws(()=>plan({...input,count:value}));
 for(const value of [0,.09,1001,Infinity])assert.throws(()=>plan({...input,interval:value}));
 assert.throws(()=>plan({...input,offset:-17}));assert.throws(()=>plan({...input,interval:20}));
 assert.throws(()=>plan({...input,camera:{...camera,viewPlaneNormal:[0,0,-2]}}));
 assert.throws(()=>plan({...input,camera:{...camera,viewUp:[0,0,1]}}));
 assert.throws(()=>plan({...input,camera:{...camera,parallelProjection:false}}));
 assert.throws(()=>plan({...input,corners:corners.slice(1)}));
 assert.throws(()=>plan({...input,width:512,height:512,count:65,interval:.1}),/64 MiB/);
 assert.equal(plan({...input,width:512,height:512,count:64,interval:.1}).cameras.length,64);
});
