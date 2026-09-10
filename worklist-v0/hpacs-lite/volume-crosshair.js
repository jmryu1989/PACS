/* CSS-pixel line geometry; image and camera coordinates remain untouched. */
(function(root){
  function segments(center,direction,width,height,style){
    if(!['normal','gap','small','tapered'].includes(style)||![center,direction].every(v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite))||![width,height].every(n=>Number.isFinite(n)&&n>0))throw Error('교차선 표시 좌표를 확인할 수 없습니다.');
    const length=Math.hypot(...direction);if(length<1e-8)throw Error('교차선 방향을 확인할 수 없습니다.');
    const d=direction.map(n=>n/length);let low=-Infinity,high=Infinity;
    for(let i=0;i<2;i++){
      const max=i?height:width;
      if(Math.abs(d[i])<1e-12){if(center[i]<0||center[i]>max)return [];continue;}
      const a=-center[i]/d[i],b=(max-center[i])/d[i];low=Math.max(low,Math.min(a,b));high=Math.min(high,Math.max(a,b));
    }
    if(low>=high)return [];
    const ranges=style==='gap'?[[-Infinity,-20],[20,Infinity]]:style==='small'?[[-40,40]]:style==='tapered'?[[-Infinity,0],[0,Infinity]]:[[-Infinity,Infinity]];
    return ranges.map(([a,b])=>[Math.max(a,low),Math.min(b,high)]).filter(([a,b])=>a<b).map(([a,b])=>({start:center.map((n,i)=>n+d[i]*a),end:center.map((n,i)=>n+d[i]*b),range:[a,b]}));
  }
  function near(point,lines,tolerance){
    if(!Array.isArray(point)||point.length!==2||!point.every(Number.isFinite)||!Number.isFinite(tolerance)||tolerance<0)return false;
    return lines.some(({start:a,end:b})=>{const dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;if(!length)return false;const t=Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/length));return Math.hypot(point[0]-a[0]-t*dx,point[1]-a[1]-t*dy)<=tolerance;});
  }
  function rotationDegrees(center,previous,current){
    if(![center,previous,current].every(v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite)))throw Error('회전 포인터 좌표를 확인할 수 없습니다.');
    const a=previous.map((n,i)=>n-center[i]),b=current.map((n,i)=>n-center[i]);
    if(Math.hypot(...a)<1||Math.hypot(...b)<1)return 0;
    // Canvas Y points down; camera-normal rotation has the opposite sign.
    return -Math.atan2(a[0]*b[1]-a[1]*b[0],a[0]*b[0]+a[1]*b[1])*180/Math.PI;
  }
  const model=Object.freeze({segments,near,rotationDegrees});if(typeof module!=='undefined'&&module.exports)module.exports=model;else root.KinVolumeCrosshair=model;
})(typeof window!=='undefined'?window:globalThis);
