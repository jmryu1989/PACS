/* Patient LPS camera operations; no voxel values or source cameras are edited. */
(function(root){
  const dot=(a,b)=>a.reduce((n,x,i)=>n+x*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const unit=a=>{const d=Math.hypot(...a);if(!Number.isFinite(d)||d<1e-8)throw Error('VR 방향을 확인할 수 없습니다.');return a.map(n=>n/d);};
  const turn=(v,axis,r)=>{const a=unit(axis),c=Math.cos(r),s=Math.sin(r),x=cross(a,v),p=dot(a,v);return v.map((n,i)=>n*c+x[i]*s+a[i]*p*(1-c));};
  function rotate(camera,dx,dy){
    if(![dx,dy].every(Number.isFinite)||Math.abs(dx)>360||Math.abs(dy)>360)throw Error('VR 회전 범위를 확인하세요.');
    const offset=camera.position.map((n,i)=>n-camera.focalPoint[i]),up=unit(camera.viewUp),normal=unit(offset),right=unit(cross(up,normal));
    const yaw=turn(offset,up,-dx*Math.PI/180),pitched=turn(yaw,right,dy*Math.PI/180),nextUp=turn(up,right,dy*Math.PI/180);
    return {position:camera.focalPoint.map((n,i)=>n+pitched[i]),focalPoint:[...camera.focalPoint],viewUp:unit(nextUp),viewPlaneNormal:unit(pitched)};
  }
  const directions={Anterior:[[0,-1,0],[0,0,1]],Posterior:[[0,1,0],[0,0,1]],Left:[[1,0,0],[0,0,1]],Right:[[-1,0,0],[0,0,1]],Superior:[[0,0,1],[0,-1,0]],Inferior:[[0,0,-1],[0,1,0]]};
  function orient(camera,name){const d=directions[name];if(!d)throw Error('VR 방향을 선택하세요.');const length=Math.hypot(...camera.position.map((n,i)=>n-camera.focalPoint[i]));if(!Number.isFinite(length)||length<1e-8)throw Error('VR 중심을 확인할 수 없습니다.');return {focalPoint:[...camera.focalPoint],position:camera.focalPoint.map((n,i)=>n+d[0][i]*length),viewPlaneNormal:[...d[0]],viewUp:[...d[1]]};}
  const api={rotate,orient,directions:Object.keys(directions)};if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumeRendering=api;
})(typeof window==='object'?window:globalThis);
