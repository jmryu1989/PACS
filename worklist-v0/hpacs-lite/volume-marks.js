(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumeMarks=api;})(globalThis,()=>{
  const vector=v=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=1e6);
  function normalize(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='marks,sync,version,visible'||value.version!==1||typeof value.visible!=='boolean'||typeof value.sync!=='boolean'||!Array.isArray(value.marks)||value.marks.length>64)return null;
    const ids=new Set(),marks=[];
    for(const mark of value.marks){
      if(!mark||typeof mark!=='object'||Array.isArray(mark)||Object.keys(mark).sort().join(',')!=='id,label,point'||typeof mark.id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(mark.id)||ids.has(mark.id)||typeof mark.label!=='string'||!mark.label.trim()||mark.label.length>160||/[\u0000-\u001f\u007f]/.test(mark.label)||!vector(mark.point))return null;
      ids.add(mark.id);marks.push({id:mark.id,label:mark.label,point:mark.point.slice()});
    }
    return {version:1,visible:value.visible,sync:value.sync,marks};
  }
  function inVolume(point,volume){
    if(!vector(point))return false;
    const index=Array.from(volume.imageData.worldToIndex(point));
    return vector(index)&&index.every((n,i)=>n>=-.5-1e-5&&n<=volume.dimensions[i]-.5+1e-5);
  }
  function signedOffset(point,camera){
    if(!vector(point)||!vector(camera?.focalPoint)||!vector(camera?.viewPlaneNormal))throw Error('표식의 환자 좌표를 확인할 수 없습니다.');
    const norm=Math.hypot(...camera.viewPlaneNormal);if(norm<1e-8)throw Error('평면 방향을 확인할 수 없습니다.');
    return point.reduce((n,x,i)=>n+(x-camera.focalPoint[i])*camera.viewPlaneNormal[i]/norm,0);
  }
  function centered(point,camera){
    signedOffset(point,camera);
    const delta=point.map((n,i)=>n-camera.focalPoint[i]);
    return {...camera,focalPoint:point.slice(),position:camera.position.map((n,i)=>n+delta[i])};
  }
  return {normalize,inVolume,signedOffset,centered};
});
