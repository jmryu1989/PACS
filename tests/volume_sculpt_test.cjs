const test=require('node:test');
const assert=require('node:assert/strict');
const sculpt=require('../worklist-v0/hpacs-lite/volume-sculpt.js');

test('six tools create bounded regions with inclusive boundaries',()=>{
  const examples={
    'Rectangle':[[.2,.2],[.8,.7]],'Ellipse':[[.2,.2],[.8,.8]],
    'Freehand Area':[[.2,.2],[.8,.2],[.5,.8]],'Curved Area':[[.2,.2],[.7,.15],[.8,.7],[.3,.8]],
    'Freehand Line':[[.2,.3],[.5,.45],[.8,.3]],'Curved Line':[[.2,.3],[.5,.6],[.8,.3]]
  };
  for(const [mode,points] of Object.entries(examples)){
    const region=sculpt.makeRegion(mode,points);
    assert.ok(Object.isFrozen(region),mode);
    assert.ok(region.kind==='Polygon'||region.kind===mode,mode);
  }
  const rectangle=sculpt.makeRegion('Rectangle',examples.Rectangle);
  assert.equal(sculpt.contains(rectangle,[.2,.4]),true);
  assert.equal(sculpt.contains(rectangle,[.1,.4]),false);
  assert.equal(sculpt.contains(rectangle,[-10,.4]),false);
  const ellipse=sculpt.makeRegion('Ellipse',examples.Ellipse);
  assert.equal(sculpt.contains(ellipse,[.8,.5]),true);
  assert.equal(sculpt.contains(ellipse,[.8,.8]),false);
});

test('area closes directly while line closes clockwise through nearest boundaries',()=>{
  const area=sculpt.makeRegion('Freehand Area',[[.2,.3],[.5,.6],[.8,.3]]);
  const line=sculpt.makeRegion('Freehand Line',[[.2,.3],[.5,.6],[.8,.3]]);
  assert.equal(sculpt.contains(area,[.5,.1]),false);
  assert.equal(sculpt.contains(line,[.5,.9]),true);
  assert.ok(line.points.some(p=>p[0]===0));
  assert.ok(line.points.some(p=>p[0]===1));
  const curved=sculpt.makeRegion('Curved Line',[[.1,.4],[.35,.7],[.8,.5]]);
  assert.ok(curved.points.length<=64);
  assert.ok(curved.points.some(p=>p[0]===0||p[0]===1||p[1]===0||p[1]===1));
  const repeated=sculpt.makeRegion('Freehand Area',[[.2,.2],[.8,.2],[.8,.2],[.5,.8],[.2,.2]]);
  assert.equal(sculpt.contains(repeated,[.5,.2]),true);
});

test('projection uses spatial extent and preserves affine oblique anisotropic mapping',()=>{
  const calls=[];
  const imageData={
    getSpatialExtent:()=>[10,14,20,26,-2,2],
    indexToWorld:index=>{calls.push(index.slice());return [2*index[0]+index[2],3*index[1]-index[2],index[0]+index[1]];}
  };
  const worldToCanvas=world=>[world[0]+.5*world[1],-.25*world[0]+world[2]];
  const p=sculpt.projection(imageData,worldToCanvas,200,100);
  assert.deepEqual(calls,[[10,20,-2],[14,20,-2],[10,26,-2],[10,20,2]]);
  assert.deepEqual(p.base,[.245,.255]);
  assert.deepEqual(p.axes,[[.03999999999999998,.020000000000000018],[.044999999999999984,.06],[.010000000000000009,-.010000000000000009]]);
});

test('operations distinguish Inside removal from Outside boundary retention',()=>{
  const region=sculpt.makeRegion('Rectangle',[[.25,.25],[.75,.75]]);
  const projection={base:[0,0],axes:[[1,0],[0,1],[0,0]]};
  const inside=sculpt.makeOperation(region,projection,'Inside');
  const outside=sculpt.makeOperation(region,projection,'Outside');
  const a=sculpt.shaderReplacement([inside]),b=sculpt.shaderReplacement([outside]);
  assert.match(a.replacementValue,/kinSculptPoint0\.x >= 0\.25/);
  assert.match(a.replacementValue,/return vec4\(0\.0\)/);
  assert.match(b.replacementValue,/\(!\(kinSculptPoint0\.x >=/);
  assert.equal(b.originalValue,'vec4 getColorForValue(vec4 tValue, vec3 posIS, vec3 tstep)\n{');
  assert.equal(b.shaderType,'Fragment');assert.equal(b.replaceFirst,true);assert.equal(b.replaceAll,false);
});

test('shader uses normalized posIS affine projection, polygon bounds, and no dynamic strings',()=>{
  const region=sculpt.makeRegion('Freehand Area',[[.1,.1],[.9,.2],[.7,.8],[.2,.7]]);
  const operation=sculpt.makeOperation(region,{base:[.1,.2],axes:[[.5,.1],[-.1,.6],[.2,-.3]]},'Inside');
  const replacement=sculpt.shaderReplacement([operation]).replacementValue;
  assert.match(replacement,/posIS\.x/);assert.match(replacement,/posIS\.y/);assert.match(replacement,/posIS\.z/);
  assert.match(replacement,/kinSculptPoint0\.x >=/);assert.match(replacement,/kinBoundary0/);
  assert.doesNotMatch(replacement,/indexToWorld|worldToIndex|undefined|NaN|Infinity/);
});

test('rejects degenerate, non-finite, complex, excessive, and tampered input',()=>{
  assert.throws(()=>sculpt.makeRegion('Rectangle',[[.2,.2],[.2,.8]]),/degenerate/);
  assert.throws(()=>sculpt.makeRegion('Ellipse',[[0,0],[Infinity,1]]),/finite/);
  assert.throws(()=>sculpt.makeRegion('Freehand Area',[[0,0],[.5,.5],[1,1]]),/degenerate/);
  const complex=Array.from({length:130},(_,i)=>{const angle=i*Math.PI*2/130,r=i%2?.45:.2;return [.5+r*Math.cos(angle),.5+r*Math.sin(angle)];});
  assert.throws(()=>sculpt.makeRegion('Freehand Area',complex,.00001),/64 points/);
  assert.throws(()=>sculpt.makeRegion('Freehand Area',Array(2049).fill([.5,.5])),/2048 points/);
  assert.throws(()=>sculpt.makeRegion('Curved Area',Array(129).fill([.5,.5])),/128 control points/);
  const valid=sculpt.makeOperation(sculpt.makeRegion('Rectangle',[[.1,.1],[.2,.2]]),{base:[0,0],axes:[[1,0],[0,1],[0,0]]},'Inside');
  const accumulated=sculpt.shaderReplacement(Array(8).fill(valid)).replacementValue;
  assert.equal((accumulated.match(/vec2 kinSculptPoint/g)||[]).length,8);
  assert.equal((accumulated.match(/return vec4\(0\.0\)/g)||[]).length,1);
  assert.throws(()=>sculpt.shaderReplacement(Array(9).fill(valid)),/At most 8/);
  assert.throws(()=>sculpt.shaderReplacement([{...valid,side:'Inside); discard; //'}]),/Invalid/);
  assert.throws(()=>sculpt.shaderReplacement([{...valid,projection:{...valid.projection,base:[NaN,0]}}]),/Invalid/);
  assert.throws(()=>sculpt.makeOperation(valid.region,{base:[1e30,0],axes:[[1,0],[0,1],[0,0]]},'Inside'),/Invalid/);
  assert.throws(()=>sculpt.projection({getSpatialExtent:()=>[0,1,0,1,0,1],indexToWorld:p=>p},()=>[1e300,0],1,1),/Invalid/);
  assert.throws(()=>sculpt.projection({getSpatialExtent:()=>[0,0,0,1,0,1],indexToWorld:p=>p},p=>[p[0],p[1]],1,1),/spatial extent/);
  assert.throws(()=>sculpt.projection({getSpatialExtent:()=>[0,1,0,1,0,1],indexToWorld:p=>p},p=>[p[0]+p[1]+p[2],0],1,1),/projection/);
  assert.throws(()=>sculpt.contains(valid.region,[Infinity,.1]),/finite/);
  assert.throws(()=>sculpt.contains({...valid.region,bounds:[0,1,0,Infinity]},[.1,.1]),/Invalid/);
  const polygon=sculpt.makeRegion('Freehand Area',[[.1,.1],[.8,.1],[.5,.8]]);
  assert.throws(()=>sculpt.shaderReplacement([{region:{...polygon,bounds:[0,1,0,1]},projection:valid.projection,side:'Inside'}]),/Invalid/);
  assert.throws(()=>sculpt.shaderReplacement([{region:{...polygon,points:[[.1,.1],[.8,.1],[NaN,.8]]},projection:valid.projection,side:'Inside'}]),/Invalid/);
});
