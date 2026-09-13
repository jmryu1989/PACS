const {test}=require('node:test'),assert=require('node:assert/strict');
// Mutation runs load a changed copy; the default is always the product model.
const model=require(process.env.KIN_ORIENTATION_MODEL_SOURCE||'../worklist-v0/hpacs-lite/volume-orientation.js');
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

// TEST-VOLUME-ORIENTATION-ORTHOGONAL. The table has the native patient-axis shape; Basic
// Orthogonal must follow it by each plane's stored name.
const TABLE={axial:{viewPlaneNormal:[0,0,-1],viewUp:[0,-1,0]},sagittal:{viewPlaneNormal:[1,0,0],viewUp:[0,0,1]},coronal:{viewPlaneNormal:[0,1,0],viewUp:[0,0,1]}};
const PLANES=['axial','sagittal','coronal'],X=[1,0,0],Y=[0,1,0],Z=[0,0,1];
const vdot=(a,b)=>a.reduce((s,n,i)=>s+n*b[i],0),vcross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],vsub=(a,b)=>a.map((n,i)=>n-b[i]);
const det=(a,b,c)=>vdot(a,vcross(b,c));
// A native-like opened screen: one intersection, independent in-plane pan, zoom and camera distance.
const basicStart=(names=PLANES)=>names.map((name,i)=>{
 const {viewPlaneNormal:n,viewUp:u}=TABLE[name],r=vcross(u,n),pan=[[3,-2],[-5,1],[4,6]][i],focal=[12,-7,30].map((x,k)=>x+r[k]*pan[0]+u[k]*pan[1]);
 return {focalPoint:focal,position:focal.map((x,k)=>x+n[k]*(80+15*i)),viewUp:u.slice(),viewPlaneNormal:n.slice(),parallelScale:40+5*i,flipHorizontal:false,flipVertical:false};
});
const turn=(value,turns)=>turns.reduce((c,[axis,degrees])=>model.rotate(c,axis,degrees),value);
const TURNS={'double oblique':[[X,23],[Y,-37]],'45 degree tie':[[Z,45]],'half turn':[[Z,180]],'two half turns':[[X,180],[Y,180]],'large mixed':[[X,-170],[Z,135],[Y,60]],'near half turn':[[Y,179.9],[X,-90]]};
const offsets=value=>{const p=model.intersection(value);return value.flatMap(c=>{const r=vcross(c.viewUp,c.viewPlaneNormal),d=vsub(c.focalPoint,p);return [vdot(d,r),vdot(d,c.viewUp),vdot(d,c.viewPlaneNormal),Math.hypot(...vsub(c.position,c.focalPoint)),c.parallelScale];});};
const native=(result,names=PLANES)=>result.forEach((c,i)=>{close(c.viewPlaneNormal,TABLE[names[i]].viewPlaneNormal);close(c.viewUp,TABLE[names[i]].viewUp);});

test('Basic Orthogonal returns each named plane to its native axes around the current intersection',()=>{
 const start=basicStart(),tableDet=det(...PLANES.map(n=>TABLE[n].viewPlaneNormal));
 for(const [name,turns] of Object.entries(TURNS)){
  const oblique=turn(start,turns),input=structuredClone(oblique),pivot=model.intersection(oblique),result=model.orthogonal(oblique,PLANES,TABLE);
  assert.deepEqual(oblique,input,name+': input unchanged');native(result);
  // Rotation keeps plane coordinates, so Basic lands exactly on the unrotated screen.
  result.forEach((c,i)=>{close(c.focalPoint,start[i].focalPoint);close(c.position,start[i].position);assert.equal(c.parallelScale,start[i].parallelScale);});
  close(model.intersection(result),pivot);close(offsets(result),offsets(oblique));
  assert.ok(Math.abs(det(...result.map(c=>c.viewPlaneNormal))-tableDet)<1e-12,name+': plane handedness');
  for(const c of result)assert.ok(Math.abs(vdot(c.viewUp,c.viewPlaneNormal))<1e-12);
 }
});
test('a nearest-axis rule is tied or flipped where Basic Orthogonal follows the plane name',()=>{
 const start=basicStart(),tie=turn(start,TURNS['45 degree tie']),half=turn(start,TURNS['half turn']);
 // Sagittal is equally close to patient L/R and A/P here; after a half turn it looks from the other side.
 assert.ok(Math.abs(Math.abs(tie[1].viewPlaneNormal[0])-Math.abs(tie[1].viewPlaneNormal[1]))<1e-12);close(half[1].viewPlaneNormal,[-1,0,0]);
 for(const oblique of [tie,half])native(model.orthogonal(oblique,PLANES,TABLE));
});
test('already basic screens are unchanged and repeated Basic Orthogonal is idempotent',()=>{
 const start=basicStart(),same=model.orthogonal(start,PLANES,TABLE);
 same.forEach((c,i)=>{for(const k of ['focalPoint','position','viewUp','viewPlaneNormal'])close(c[k],start[i][k]);assert.equal(c.parallelScale,start[i].parallelScale);});
 const once=model.orthogonal(turn(start,TURNS['large mixed']),PLANES,TABLE),twice=model.orthogonal(once,PLANES,TABLE),again=model.orthogonal(turn(once,[[Y,-64]]),PLANES,TABLE);
 once.forEach((c,i)=>{for(const k of ['focalPoint','position','viewUp','viewPlaneNormal']){close(twice[i][k],c[k]);close(again[i][k],c[k]);}});
});
test('plane identity comes from the stored names in any cell order, never from the current camera',()=>{
 const names=['coronal','axial','sagittal'],start=basicStart(names),oblique=turn(start,TURNS['two half turns']),result=model.orthogonal(oblique,names,TABLE);
 native(result,names);result.forEach((c,i)=>close(c.focalPoint,start[i].focalPoint));
 // Grid order is not identity: the same cameras named in grid order land on different planes.
 const relabelled=model.orthogonal(oblique,PLANES,TABLE);native(relabelled);close(model.intersection(relabelled),model.intersection(oblique));
 assert.ok(Math.abs(vdot(relabelled[0].viewPlaneNormal,result[0].viewPlaneNormal))<1e-12);
});
test('a tilted acquisition returns to patient axes, not to its acquired volume axes',()=>{
 // Planes aligned to a volume rotated 30 degrees about H/F and tilted 20 degrees, as a restored Job may show.
 const acquired=turn(basicStart(),[[Z,30],[X,20]]),pivot=model.intersection(acquired),result=model.orthogonal(acquired,PLANES,TABLE);
 native(result);close(model.intersection(result),pivot);close(offsets(result),offsets(acquired));
 assert.equal(model.orthogonal.length,3,'no volume direction input can pull planes onto acquired axes');
});
test('unknown or duplicate names, missing native table, flipped planes and non-rigid input are refused unchanged',()=>{
 const oblique=turn(basicStart(),TURNS['double oblique']),input=structuredClone(oblique);
 const flipped=structuredClone(oblique);flipped[2].flipHorizontal=true;
 const vertical=structuredClone(oblique);vertical[0].flipVertical=true;
 const bad=structuredClone(oblique);bad[1].viewPlaneNormal=bad[0].viewPlaneNormal.slice();
 for(const [planes,table,value,message] of [
  [['axial','axial','coronal'],TABLE,oblique,/기본 방향/],[['axial','sagittal','oblique'],TABLE,oblique,/기본 방향/],[['axial','sagittal'],TABLE,oblique,/기본 방향/],[null,TABLE,oblique,/기본 방향/],
  [PLANES,null,oblique,/기본 평면 방향 정보/],[PLANES,{axial:TABLE.axial,sagittal:TABLE.sagittal},oblique,/기본 평면 방향 정보/],
  [PLANES,{...TABLE,coronal:TABLE.axial},oblique,/기본 평면 방향 정보/],[PLANES,{...TABLE,coronal:{viewPlaneNormal:[0,2,0],viewUp:[0,0,1]}},oblique,/기본 평면 방향 정보/],
  [PLANES,{...TABLE,coronal:{viewPlaneNormal:[0,1,0],viewUp:[0,1,0]}},oblique,/기본 평면 방향 정보/],
  [PLANES,TABLE,flipped,/뒤집기/],[PLANES,TABLE,vertical,/뒤집기/],[PLANES,TABLE,bad,/MPR/]])
  assert.throws(()=>model.orthogonal(value,planes,table),message);
 assert.deepEqual(oblique,input);
});
