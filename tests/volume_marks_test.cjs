const test=require('node:test'),assert=require('node:assert/strict');
const m=require('../worklist-v0/hpacs-lite/volume-marks.js');
const mark={id:'12345678-1234-4234-8234-123456789abc',label:'Manual point',point:[2,3,4]};
test('manual point identity and text are bounded; duplicate or unknown fields reject',()=>{
 const value={version:1,visible:true,sync:true,marks:[mark]};assert.deepEqual(m.normalize(value),value);
 for(const bad of [{...value,marks:[mark,mark]},{...value,marks:[{...mark,label:'\n'}]},{...value,marks:[{...mark,point:[NaN,2,3]}]},{...value,extra:1}])assert.equal(m.normalize(bad),null);
 const copy=m.normalize(value);copy.marks[0].point[0]=99;assert.equal(mark.point[0],2);
});
test('rotated anisotropic volume membership includes only half-voxel bounds',()=>{
 const v={dimensions:[5,8,10],imageData:{worldToIndex:p=>[(p[1]-20)/2,(10-p[0])/3,(p[2]+5)/4]}};
 assert.equal(m.inVolume([10,20,-5],v),true);assert.equal(m.inVolume([11.5,19,-7],v),true);
 assert.equal(m.inVolume([11.51,19,-7],v),false);assert.equal(m.inVolume([10,30,-5],v),false);
});
test('oblique go-to point centers the chosen point and preserves orientation and zoom',()=>{
 const n=[1/Math.sqrt(2),0,1/Math.sqrt(2)],c={focalPoint:[2,4,6],position:[12,4,16],viewPlaneNormal:n,viewUp:[0,1,0],parallelScale:9};
 const p=[8,9,12],next=m.centered(p,c);assert.ok(Math.abs(m.signedOffset(p,next))<1e-12);
 assert.deepEqual(next.focalPoint,p);assert.deepEqual(next.viewUp,c.viewUp);assert.equal(next.parallelScale,9);
 for(let i=0;i<3;i++)assert.ok(Math.abs(next.position[i]-next.focalPoint[i]-(c.position[i]-c.focalPoint[i]))<1e-12);
});
