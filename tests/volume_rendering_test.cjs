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
test('crop validation accepts only ordered integer source voxel indexes without mutating input',()=>{
 const bounds={i:[0,63],j:[2,30],k:[4,18]},dimensions=[64,32,20],before=structuredClone(bounds),valid=model.validateCropBounds(bounds,dimensions);
 assert.deepEqual(valid,bounds);assert.notEqual(valid,bounds);assert.deepEqual(bounds,before);
 for(const invalid of [{i:[0.5,63],j:[0,31],k:[0,19]},{i:[-1,63],j:[0,31],k:[0,19]},{i:[40,20],j:[0,31],k:[0,19]},{i:[0,64],j:[0,31],k:[0,19]}])assert.throws(()=>model.validateCropBounds(invalid,dimensions));
 assert.throws(()=>model.validateCropBounds(bounds,[64,0,20]));assert.deepEqual(bounds,before);
});
test('crop planes follow oblique anisotropic index geometry at inclusive voxel edges',()=>{
 const origin=[11,-7,23],basis=[[2,0,0],[.5,3,0],[.2,.4,4]],world=p=>origin.map((n,row)=>n+p.reduce((sum,value,column)=>sum+value*basis[column][row],0)),bounds={i:[3,8],j:[4,11],k:[2,6]},planes=model.cropPlanes(bounds,[20,30,10],world),before=structuredClone(bounds);
 assert.equal(planes.length,6);
 for(let axis=0;axis<3;axis++)for(let side=0;side<2;side++){
  const plane=planes[axis*2+side],others=[0,1,2].filter(n=>n!==axis),edge=side===0?bounds[['i','j','k'][axis]][0]-.5:bounds[['i','j','k'][axis]][1]+.5,point=[(bounds.i[0]+bounds.i[1])/2,(bounds.j[0]+bounds.j[1])/2,(bounds.k[0]+bounds.k[1])/2];point[axis]=edge;
  assert.ok(Math.hypot(...plane.origin.map((n,i)=>n-world(point)[i]))<1e-10);assert.ok(Math.abs(plane.normal.reduce((n,v,i)=>n+v*basis[others[0]][i],0))<1e-10);assert.ok(Math.abs(plane.normal.reduce((n,v,i)=>n+v*basis[others[1]][i],0))<1e-10);assert.ok((side===0?1:-1)*plane.normal.reduce((n,v,i)=>n+v*basis[axis][i],0)>0);
 }
 assert.deepEqual(bounds,before);
});
test('crop geometry rejects invalid transforms before returning partial planes',()=>{
 assert.throws(()=>model.cropPlanes({i:[0,1],j:[0,1],k:[0,1]},[2,2,2],([i,j,k])=>[i,j,i+j]));
 assert.throws(()=>model.cropPlanes({i:[0,1],j:[0,1],k:[0,1]},[2,2,2],()=>[NaN,0,0]));
});
test('immutable crop planes ignore inherited camera slab updates',()=>{
 const definitions=model.cropPlanes({i:[2,8],j:[3,9],k:[1,7]},[12,12,12],([i,j,k])=>[2*i+j*.2,3*j+k*.1,4*k]),before=structuredClone(definitions),planes=definitions.map(model.createCropPlane),cameraNormal=[.2,.7,.4],cameraOrigin=[99,-50,400];
 assert.doesNotThrow(()=>{planes[0].setNormal(cameraNormal);planes[0].setOrigin(cameraOrigin);planes[1].setNormal(cameraNormal.map(n=>-n));planes[1].setOrigin(cameraOrigin.map(n=>n+10));});
 assert.deepEqual(planes.map(plane=>({origin:plane.getOrigin(),normal:plane.getNormal()})),before.map(({origin,normal})=>({origin,normal})));
 const borrowed=planes[0].getOrigin();borrowed[0]=999;cameraNormal[0]=999;cameraOrigin[0]=999;
 assert.deepEqual(planes[0].getOrigin(),before[0].origin);assert.deepEqual(planes[0].getNormal(),before[0].normal);assert.deepEqual(definitions,before);assert.equal(planes[0].isA('vtkPlane'),true);assert.equal(planes[0].setOrigin([0,0,0]),false);
});
test('custom transfer knots validate atomically and retain exact manual values',()=>{
 const knots=[{hu:'-1000',color:'#1020a0',opacity:'0'},{hu:40,color:'#ABCDEF',opacity:.35},{hu:'2000',color:'#ffffff',opacity:'1'}],before=structuredClone(knots),valid=model.validateTransferKnots(knots);
 assert.deepEqual(valid,[{hu:-1000,color:'#1020A0',opacity:0},{hu:40,color:'#ABCDEF',opacity:.35},{hu:2000,color:'#FFFFFF',opacity:1}]);assert.deepEqual(knots,before);assert.notEqual(valid,knots);assert.deepEqual(model.hexToRgb('#FF8000'),[1,128/255,0]);
 for(const invalid of [knots.slice(0,1),Array.from({length:17},(_,i)=>({hu:i,color:'#000000',opacity:0})),[{hu:'',color:'#000000',opacity:0},{hu:1,color:'#ffffff',opacity:1}],[{hu:null,color:'#000000',opacity:0},{hu:1,color:'#ffffff',opacity:1}],[{hu:2,color:'#000000',opacity:0},{hu:1,color:'#ffffff',opacity:1}],[{hu:1,color:'#000000',opacity:0},{hu:1,color:'#ffffff',opacity:1}],[{hu:-40000,color:'#000000',opacity:0},{hu:1,color:'#ffffff',opacity:1}],[{hu:0,color:'red',opacity:0},{hu:1,color:'#ffffff',opacity:1}],[{hu:0,color:'#000000',opacity:-.1},{hu:1,color:'#ffffff',opacity:1}]])assert.throws(()=>model.validateTransferKnots(invalid));
 assert.deepEqual(knots,before);
});
