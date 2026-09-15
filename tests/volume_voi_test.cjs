const test=require('node:test');
const assert=require('node:assert/strict');
const voi=require('../worklist-v0/hpacs-lite/volume-voi.js');

function close(actual,expected,tolerance=1e-10){assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);}
function vectorClose(actual,expected,tolerance){actual.forEach((value,index)=>close(value,expected[index],tolerance));}
function fixture(){
  const extent=[-.5,3.5,-.5,2.5,-.5,1.5];
  const transform=index=>[100+2*index[0]+.5*index[1],-50+.25*index[0]+3*index[1]+index[2],20+.5*index[0]-.25*index[1]+4*index[2]];
  return {extent,transform,imageData:{getSpatialExtent:()=>extent.slice(),indexToWorld:index=>transform(index)}};
}

test('orientation defaults use oblique anisotropic outer corners and world LPS normals',()=>{
  const f=fixture(),axial=voi.defaults(f.imageData,'Axial');
  assert.deepEqual(voi.orientationNormals,{Axial:[0,0,1],Coronal:[0,1,0],Sagittal:[1,0,0]});
  vectorClose(axial.center,f.transform([1.5,1,.5]));
  assert.deepEqual(axial.center,axial.pivot);assert.deepEqual(axial.normal,[0,0,1]);
  const projections=[];
  for(const i of [f.extent[0],f.extent[1]])for(const j of [f.extent[2],f.extent[3]])for(const k of [f.extent[4],f.extent[5]])projections.push(f.transform([i,j,k])[2]);
  close(axial.thickness,Math.max(...projections)-Math.min(...projections));
  close(voi.defaults(f.imageData,'Coronal').thickness,12);
  close(voi.defaults(f.imageData,'Sagittal').thickness,9.5);
});

test('move follows the normal while pivot stays fixed and setPivot does not move slab',()=>{
  const initial=voi.defaults(fixture().imageData,'Axial'),moved=voi.move(initial,12.5);
  vectorClose(moved.center,[initial.center[0],initial.center[1],initial.center[2]+12.5]);
  assert.deepEqual(moved.pivot,initial.pivot);assert.deepEqual(initial.center,initial.pivot);
  const pivoted=voi.setPivot(moved,[90,-40,12]);
  assert.deepEqual(pivoted.center,moved.center);assert.deepEqual(pivoted.normal,moved.normal);assert.deepEqual(pivoted.pivot,[90,-40,12]);
});

test('Rodrigues rotation moves center around pivot and inverse rotation restores it',()=>{
  const slab={center:[2,0,0],normal:[0,0,1],pivot:[1,0,0],thickness:8};
  const rotated=voi.rotate(slab,'S',90);
  vectorClose(rotated.center,[1,1,0]);vectorClose(rotated.normal,[0,0,1]);
  const restored=voi.rotate(rotated,'S',-90);
  vectorClose(restored.center,slab.center);vectorClose(restored.normal,slab.normal);
  const aroundL=voi.rotate(slab,'L',90);vectorClose(aroundL.normal,[0,-1,0]);
});

test('contains includes both finite slab boundaries and excludes points beyond them',()=>{
  const slab={center:[4,5,6],normal:[0,1,0],pivot:[4,5,6],thickness:10};
  assert.equal(voi.contains(slab,[100,0,-100]),true);
  assert.equal(voi.contains(slab,[-100,10,100]),true);
  assert.equal(voi.contains(slab,[4,-.001,6]),false);
  assert.equal(voi.contains(slab,[4,10.001,6]),false);
});

test('samplePlane matches direct world affine at normalized posIS',()=>{
  const f=fixture(),slab=voi.rotate(voi.defaults(f.imageData,'Coronal'),'L',31),plane=voi.samplePlane(slab,f.imageData);
  for(const posIS of [[0,0,0],[1,1,1],[.17,.63,.41]]){
    const index=[f.extent[0]+(f.extent[1]-f.extent[0])*posIS[0],f.extent[2]+(f.extent[3]-f.extent[2])*posIS[1],f.extent[4]+(f.extent[5]-f.extent[4])*posIS[2]];
    const world=f.transform(index),direct=world.reduce((sum,value,i)=>sum+(value-slab.center[i])*slab.normal[i],0);
    close(plane.base+plane.axes.reduce((sum,value,i)=>sum+value*posIS[i],0),direct,1e-9);
  }
  close(plane.halfThickness,slab.thickness/2);
});

test('validation rejects degenerate, excessive, non-finite, singular, and tampered values',()=>{
  const f=fixture(),valid=voi.defaults(f.imageData,'Axial');
  const clone=voi.validate({...valid,normal:[0,0,.9999995]});
  assert.notEqual(clone,valid);assert.ok(Object.isFrozen(clone));close(Math.hypot(...clone.normal),1);
  assert.throws(()=>voi.validate({...valid,normal:[0,0,2]}),/slab/);
  assert.throws(()=>voi.validate({...valid,thickness:0}),/slab/);assert.throws(()=>voi.validate({...valid,center:[Infinity,0,0]}),/slab/);
  assert.throws(()=>voi.move(valid,1e7),/movement/);assert.throws(()=>voi.rotate(valid,'S',181),/rotation/);
  assert.throws(()=>voi.rotate(valid,'user-axis',1),/rotation/);assert.throws(()=>voi.setPivot(valid,[0,NaN,0]),/pivot/);
  assert.throws(()=>voi.contains(valid,[0,0,1e7]),/world point/);assert.throws(()=>voi.defaults(f.imageData,'Camera'),/orientation/);
  assert.throws(()=>voi.defaults({getSpatialExtent:()=>[0,0,0,1,0,1],indexToWorld:p=>p},'Axial'),/spatial extent/);
  assert.throws(()=>voi.defaults({getSpatialExtent:()=>[0,1,0,1,0,1],indexToWorld:p=>[p[0]+p[1],p[0]+p[1],p[2]]},'Axial'),/affine/);
  assert.throws(()=>voi.samplePlane({...valid,normal:[0,0,.999]},f.imageData),/slab/);
});
