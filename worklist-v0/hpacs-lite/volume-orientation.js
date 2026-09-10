/* Patient-space rigid transforms for the three planes of one MPR volume. */
(function(root){
  const vector=v=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e7);
  const dot=(a,b)=>a.reduce((s,n,i)=>s+n*b[i],0);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const scale=(v,n)=>v.map(x=>x*n),add=(a,b)=>a.map((n,i)=>n+b[i]);
  const normalized=v=>vector(v)&&Math.abs(dot(v,v)-1)<1e-5;
  function validate(cameras){
    if(!Array.isArray(cameras)||cameras.length!==3)throw Error('MPR3평면이 필요합니다.');
    for(const c of cameras){
      if(!c||!vector(c.focalPoint)||!vector(c.position)||!normalized(c.viewUp)||!normalized(c.viewPlaneNormal)||Math.abs(dot(c.viewUp,c.viewPlaneNormal))>1e-5)throw Error('MPR 평면의 좌표를 확인할 수 없습니다.');
      const delta=add(c.position,scale(c.focalPoint,-1)),length=Math.hypot(...delta);
      if(length<1e-4||Math.abs(dot(delta,c.viewPlaneNormal)/length-1)>1e-5)throw Error('MPR 카메라 방향이 일치하지 않습니다.');
    }
    for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)if(Math.abs(dot(cameras[i].viewPlaneNormal,cameras[j].viewPlaneNormal))>1e-5)throw Error('서로 직교하는 MPR3평면을 선택하세요.');
  }
  function intersection(cameras){
    validate(cameras);
    // For orthonormal plane normals, N^-1 is N^T, irrespective of handedness.
    return cameras.reduce((point,c)=>add(point,scale(c.viewPlaneNormal,dot(c.viewPlaneNormal,c.focalPoint))),[0,0,0]);
  }
  function rotate(cameras,axis,degrees){
    validate(cameras);
    if(!normalized(axis)||!Number.isFinite(degrees)||Math.abs(degrees)>180)throw Error('회전축과 -180~180도 범위의 각도를 확인하세요.');
    const pivot=intersection(cameras),angle=degrees*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
    const direction=v=>add(add(scale(v,c),scale(cross(axis,v),s)),scale(axis,dot(axis,v)*(1-c)));
    const position=v=>add(pivot,direction(add(v,scale(pivot,-1))));
    const result=cameras.map(camera=>({...camera,focalPoint:position(camera.focalPoint),position:position(camera.position),viewUp:direction(camera.viewUp),viewPlaneNormal:direction(camera.viewPlaneNormal)}));
    validate(result);return result;
  }
  const model=Object.freeze({intersection,rotate});
  if(typeof module!=='undefined'&&module.exports)module.exports=model;else root.KinVolumeOrientation=model;
})(typeof window!=='undefined'?window:globalThis);
