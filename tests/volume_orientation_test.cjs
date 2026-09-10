const {test}=require('node:test'),assert=require('node:assert/strict');
const model=require('../worklist-v0/hpacs-lite/volume-orientation.js');
const cameras=[
 {focalPoint:[2,3,4],position:[2,3,14],viewPlaneNormal:[0,0,1],viewUp:[0,1,0],parallelScale:10},
 {focalPoint:[2,8,4],position:[12,8,4],viewPlaneNormal:[1,0,0],viewUp:[0,0,1],parallelScale:10},
 {focalPoint:[2,3,9],position:[2,13,9],viewPlaneNormal:[0,1,0],viewUp:[0,0,1],parallelScale:10},
];
const close=(a,b)=>a.forEach((n,i)=>assert.ok(Math.abs(n-b[i])<1e-9,`${a} != ${b}`));
test('three physical planes intersect despite independent in-plane pan',()=>close(model.intersection(cameras),[2,3,4]));
test('known quarter turn and inverse retain intersection, scale and input',()=>{
 const before=structuredClone(cameras),rotated=model.rotate(cameras,[0,0,1],90);
 close(rotated[1].viewPlaneNormal,[0,1,0]);close(rotated[1].focalPoint,[-3,3,4]);close(model.intersection(rotated),[2,3,4]);
 const restored=model.rotate(rotated,[0,0,1],-90);
 for(let i=0;i<3;i++){for(const field of ['position','focalPoint','viewUp','viewPlaneNormal'])close(restored[i][field],cameras[i][field]);assert.equal(rotated[i].parallelScale,10);}
 assert.deepEqual(cameras,before);
});
test('double oblique rotations stay orthogonal and reject non-rigid inputs',()=>{
 const tilted=model.rotate(model.rotate(cameras,[1,0,0],23),[0,1,0],-37);close(model.intersection(tilted),[2,3,4]);
 assert.throws(()=>model.rotate(cameras,[2,0,0],10));assert.throws(()=>model.rotate(cameras,[1,0,0],Infinity));
 const bad=structuredClone(cameras);bad[2]=bad[1];assert.throws(()=>model.intersection(bad));
});
