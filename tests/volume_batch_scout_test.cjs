const {test}=require('node:test'),assert=require('node:assert/strict');
const scout=require('../worklist-v0/hpacs-lite/volume-batch-scout.js');
const near=(a,b)=>a.forEach((n,i)=>assert.ok(Math.abs(n-b[i])<1e-9));
test('parallel slice guides keep physical order and clip to reference raster',()=>{
 const canvas=[[0,0,0],[0,64,0],[0,0,32]];
 for(const z of [24,16,8]){const line=scout.line([0,0,1],[0,0,z],canvas,256,256);near(line[0],[0,z*8]);near(line[1],[256,z*8]);}
 assert.equal(scout.line([0,0,1],[0,0,33],canvas,256,256),null);
});
test('oblique guide crosses opposite corners without false coincident-plane line',()=>{
 const n=[Math.SQRT1_2,Math.SQRT1_2,0],p=[[0,0,0],[10,0,0],[0,10,0]];
 const line=scout.line(n,[5,5,0],p,100,100);near(line[0],[0,100]);near(line[1],[100,0]);
 assert.equal(scout.line([0,0,1],[0,0,0],p,100,100),null);
});
test('reference camera is perpendicular to batch planes and fits the original corners',()=>{
 const n=[Math.SQRT1_2,0,Math.SQRT1_2],u=[0,1,0],corners=[0,63].flatMap(x=>[0,63].flatMap(y=>[0,32].map(z=>[x,y,z]))),c=scout.camera({viewPlaneNormal:n,viewUp:u},corners);
 near(c.focalPoint,[31.5,31.5,16]);near(c.viewUp,n);assert.ok(Math.abs(c.viewPlaneNormal.reduce((sum,v,i)=>sum+v*n[i],0))<1e-9);assert.ok(c.parallelScale>31.5);assert.equal(c.parallelProjection,true);
 assert.throws(()=>scout.camera({viewPlaneNormal:[0,0,2],viewUp:u},corners));assert.throws(()=>scout.line(n,[0,0,0],[[0,0,0],[1,0,0],[0,1,0]],0,256));
});
