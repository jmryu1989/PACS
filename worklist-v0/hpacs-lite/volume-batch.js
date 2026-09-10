/* Parallel reconstruction positions in patient millimetres, independent of UI. */
(function(root){
  const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
  const vector=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
  function plan({camera,corners,offset,interval,count,reverse=false,width,height}){
    if(!camera||!['focalPoint','position','viewPlaneNormal','viewUp'].every(k=>vector(camera[k]))||camera.parallelProjection!==true||!Number.isFinite(camera.parallelScale)||camera.parallelScale<=0||Math.abs(Math.hypot(...camera.viewPlaneNormal)-1)>1e-6||Math.abs(Math.hypot(...camera.viewUp)-1)>1e-6||Math.abs(dot(camera.viewUp,camera.viewPlaneNormal))>1e-6)throw Error('평행 MPR 카메라 좌표를 확인할 수 없습니다.');
    if(!Array.isArray(corners)||corners.length!==8||!corners.every(vector))throw Error('원본 볼륨 범위를 확인할 수 없습니다.');
    if(!Number.isFinite(offset)||!Number.isFinite(interval)||interval<.1||interval>1000||!Number.isInteger(count)||count<2||count>128||typeof reverse!=='boolean')throw Error('간격 0.1~1000 mm와 장수 2~128을 입력하세요.');
    if(![width,height].every(n=>Number.isFinite(n)&&n>0))throw Error('원본 화면 크기를 확인할 수 없습니다.');
    const scale=512/Math.max(width,height),columns=Math.max(1,Math.floor(width*scale)),rows=Math.max(1,Math.floor(height*scale));
    if(columns*rows*4*count>64*1024*1024)throw Error('생성 영상은 64 MiB 이내로 장수를 줄이세요.');
    const normal=camera.viewPlaneNormal,range=corners.map(p=>dot(normal,p)),min=Math.min(...range),max=Math.max(...range),origin=dot(normal,camera.focalPoint);
    const offsets=Array.from({length:count},(_,i)=>offset+(reverse?-1:1)*interval*i);
    if(offsets.some(d=>origin+d<min-1e-6||origin+d>max+1e-6))throw Error('시작 위치와 마지막 단면을 원본 볼륨 범위 안에 지정하세요.');
    return {columns,rows,interval,offsets,range:{min,max,current:origin},cameras:offsets.map(d=>({...camera,focalPoint:camera.focalPoint.map((n,i)=>n+normal[i]*d),position:camera.position.map((n,i)=>n+normal[i]*d)}))};
  }
  const model=Object.freeze({plan});if(typeof module!=='undefined'&&module.exports)module.exports=model;else root.KinVolumeBatch=model;
})(typeof window!=='undefined'?window:globalThis);
