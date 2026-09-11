const test=require('node:test'),assert=require('node:assert/strict');
const {resetZoomPan,resetWindowing}=require('../worklist-v0/hpacs-lite/volume-display.js');
const close=(a,b)=>a.forEach((n,i)=>assert.ok(Math.abs(n-b[i])<1e-10));

test('zoom and pan reset preserves an oblique slice and viewing direction',()=>{
  const n=1/Math.sqrt(2),current={focalPoint:[8,4,10],position:[8+100*n,4,10+100*n],viewPlaneNormal:[n,0,n],viewUp:[0,1,0],flipHorizontal:true};
  const before=structuredClone(current),result=resetZoomPan(current,{focalPoint:[0,0,0],parallelScale:19});
  close(result.focalPoint,[9,0,9]);close(result.position.map((x,i)=>x-result.focalPoint[i]),current.position.map((x,i)=>x-current.focalPoint[i]));
  assert.equal(result.parallelScale,19);assert.deepEqual(Object.keys(result).sort(),['focalPoint','parallelScale','position']);assert.deepEqual(current,before);
  const plane=c=>c[0]*n+c[2]*n;assert.ok(Math.abs(plane(result.focalPoint)-plane(current.focalPoint))<1e-10);
});
test('windowing reset copies only VOI and preserves inversion and projection ownership',()=>{
  const original={voiRange:{lower:-1000,upper:400},VOILUTFunction:'LINEAR',invert:true,slabThickness:10};
  const result=resetWindowing(original);assert.deepEqual(result,{voiRange:{lower:-1000,upper:400},VOILUTFunction:'LINEAR'});
  result.voiRange.lower=0;assert.equal(original.voiRange.lower,-1000);
});
test('invalid initial display and non-unit plane are refused before mutation',()=>{
  const camera={focalPoint:[1,2,3],position:[1,2,10],viewPlaneNormal:[0,0,2]},initial={focalPoint:[0,0,0],parallelScale:10};
  assert.throws(()=>resetZoomPan(camera,initial));assert.throws(()=>resetZoomPan({...camera,viewPlaneNormal:[0,0,1]},{...initial,parallelScale:NaN}));
  assert.throws(()=>resetWindowing({voiRange:{lower:4,upper:4}}));assert.throws(()=>resetWindowing({voiRange:{lower:0,upper:1},VOILUTFunction:'unknown'}));
});
