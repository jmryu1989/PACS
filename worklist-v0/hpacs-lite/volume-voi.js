(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.KinVolumeVoi=api;
})(typeof globalThis==='object'?globalThis:this,()=>{
  'use strict';
  const LIMIT=1e6,EPS=1e-9;
  const orientationNormals=Object.freeze({
    Axial:Object.freeze([0,0,1]),
    Coronal:Object.freeze([0,1,0]),
    Sagittal:Object.freeze([1,0,0])
  });
  const worldAxes=Object.freeze({L:Object.freeze([1,0,0]),P:Object.freeze([0,1,0]),S:Object.freeze([0,0,1])});

  function finite(value){return typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=LIMIT;}
  function vector(value){return Array.isArray(value)&&value.length===3&&value.every(finite);}
  function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
  function subtract(a,b){return [a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
  function add(a,b){return [a[0]+b[0],a[1]+b[1],a[2]+b[2]];}
  function scale(a,n){return [a[0]*n,a[1]*n,a[2]*n];}
  function cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
  function freezeSlab(slab){return Object.freeze({center:Object.freeze(slab.center.slice()),normal:Object.freeze(slab.normal.slice()),pivot:Object.freeze(slab.pivot.slice()),thickness:slab.thickness});}
  function validSlab(slab){
    if(!slab||typeof slab!=='object'||!vector(slab.center)||!vector(slab.normal)||!vector(slab.pivot)||!finite(slab.thickness)||slab.thickness<=0)return false;
    const length=Math.hypot(...slab.normal);
    return Number.isFinite(length)&&Math.abs(length-1)<=1e-6;
  }
  function validate(slab){
    if(!validSlab(slab))throw Error('Invalid VOI slab.');
    const length=Math.hypot(...slab.normal);
    return freezeSlab({center:slab.center,normal:scale(slab.normal,1/length),pivot:slab.pivot,thickness:slab.thickness});
  }
  function geometry(imageData){
    if(!imageData||typeof imageData.getSpatialExtent!=='function'||typeof imageData.indexToWorld!=='function')throw Error('Invalid VOI image geometry.');
    const extent=Array.from(imageData.getSpatialExtent());
    if(extent.length!==6||!extent.every(finite)||extent[1]-extent[0]<=0||extent[3]-extent[2]<=0||extent[5]-extent[4]<=0)throw Error('Invalid VOI spatial extent.');
    const origin=Array.from(imageData.indexToWorld([extent[0],extent[2],extent[4]]));
    const ends=[[extent[1],extent[2],extent[4]],[extent[0],extent[3],extent[4]],[extent[0],extent[2],extent[5]]].map(index=>Array.from(imageData.indexToWorld(index)));
    if(!vector(origin)||!ends.every(vector))throw Error('Invalid VOI affine.');
    const basis=ends.map(end=>subtract(end,origin));
    if(dot(basis[0],cross(basis[1],basis[2]))===0)throw Error('Invalid VOI affine.');
    return {extent,origin,basis};
  }
  function corners(g){
    const result=[];
    for(let i=0;i<2;i++)for(let j=0;j<2;j++)for(let k=0;k<2;k++)result.push(add(g.origin,add(scale(g.basis[0],i),add(scale(g.basis[1],j),scale(g.basis[2],k)))));
    return result;
  }
  function defaults(imageData,orientation){
    const normal=orientationNormals[orientation];
    if(!normal)throw Error('Invalid VOI orientation.');
    const g=geometry(imageData),center=add(g.origin,scale(add(add(g.basis[0],g.basis[1]),g.basis[2]),.5));
    const projected=corners(g).map(value=>dot(value,normal)),thickness=Math.max(...projected)-Math.min(...projected);
    if(!vector(center)||!finite(thickness)||thickness<=0)throw Error('Invalid VOI default slab.');
    return freezeSlab({center,normal,pivot:center,thickness});
  }
  function requireSlab(slab){return validate(slab);}
  function move(slab,distanceMM){
    slab=requireSlab(slab);
    if(!finite(distanceMM))throw Error('Invalid VOI movement.');
    const center=add(slab.center,scale(slab.normal,distanceMM));
    if(!vector(center))throw Error('VOI movement exceeds coordinate bounds.');
    return freezeSlab({center,normal:slab.normal,pivot:slab.pivot,thickness:slab.thickness});
  }
  function rotateVector(value,axis,radians){
    const cosine=Math.cos(radians),sine=Math.sin(radians);
    return add(add(scale(value,cosine),scale(cross(axis,value),sine)),scale(axis,dot(axis,value)*(1-cosine)));
  }
  function rotate(slab,axis,degrees){
    slab=requireSlab(slab);
    if(!worldAxes[axis]||!finite(degrees)||Math.abs(degrees)>180)throw Error('Invalid VOI rotation.');
    const radians=degrees*Math.PI/180,normal=rotateVector(slab.normal,worldAxes[axis],radians);
    const center=add(slab.pivot,rotateVector(subtract(slab.center,slab.pivot),worldAxes[axis],radians));
    const length=Math.hypot(...normal),normalized=scale(normal,1/length);
    if(!vector(center)||!vector(normalized))throw Error('VOI rotation exceeds coordinate bounds.');
    return freezeSlab({center,normal:normalized,pivot:slab.pivot,thickness:slab.thickness});
  }
  function setPivot(slab,worldPoint){
    slab=requireSlab(slab);
    if(!vector(worldPoint))throw Error('Invalid VOI pivot.');
    return freezeSlab({center:slab.center,normal:slab.normal,pivot:worldPoint,thickness:slab.thickness});
  }
  function contains(slab,worldPoint){
    slab=requireSlab(slab);
    if(!vector(worldPoint))throw Error('Invalid VOI world point.');
    const half=slab.thickness/2,tolerance=EPS*Math.max(1,half);
    return Math.abs(dot(subtract(worldPoint,slab.center),slab.normal))<=half+tolerance;
  }
  function samplePlane(slab,imageData){
    slab=requireSlab(slab);
    const g=geometry(imageData),base=dot(subtract(g.origin,slab.center),slab.normal);
    const axes=g.basis.map(axis=>dot(axis,slab.normal)),halfThickness=slab.thickness/2;
    if(!finite(base)||!axes.every(finite)||!finite(halfThickness))throw Error('Invalid VOI sample plane.');
    return Object.freeze({base,axes:Object.freeze(axes),halfThickness});
  }
  return Object.freeze({orientationNormals,defaults,validate,move,rotate,setPivot,contains,samplePlane});
});
