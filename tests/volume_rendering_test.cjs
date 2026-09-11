const {test}=require('node:test'),assert=require('node:assert/strict'),model=require('../worklist-v0/hpacs-lite/volume-rendering.js');
const base={position:[20,-80,30],focalPoint:[20,20,30],viewUp:[0,0,1],viewPlaneNormal:[0,-1,0]};
test('patient LPS presets retain center and camera distance',()=>{
 const want={Anterior:[0,-1,0],Posterior:[0,1,0],Left:[1,0,0],Right:[-1,0,0],Superior:[0,0,1],Inferior:[0,0,-1]};
 for(const name of model.directions){const c=model.orient(base,name);assert.deepEqual(c.focalPoint,base.focalPoint);assert.deepEqual(c.viewPlaneNormal,want[name]);assert.equal(Math.hypot(...c.position.map((v,i)=>v-c.focalPoint[i])),100);assert.equal(c.viewUp.reduce((n,v,i)=>n+v*c.viewPlaneNormal[i],0),0);}
});
test('repeated two-axis rotation preserves physical center, orthonormal basis and source',()=>{
 const initial=structuredClone(base);let c=base;
 for(let i=0;i<500;i++){c=model.rotate(c,3,-2);assert.deepEqual(c.focalPoint,base.focalPoint);assert.ok(Math.abs(Math.hypot(...c.position.map((v,j)=>v-c.focalPoint[j]))-100)<1e-8);assert.ok(Math.abs(c.viewUp.reduce((n,v,j)=>n+v*c.viewPlaneNormal[j],0))<1e-8);}
 assert.deepEqual(base,initial);assert.throws(()=>model.rotate(base,Infinity,0));assert.throws(()=>model.orient(base,'unknown'));
});
