/* Patient-space reference view and clipped batch-plane guides. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumeBatchScout=api;})(typeof window!=='undefined'?window:globalThis,function(){
  const fail=()=>{throw Error('단면 위치 안내선의 좌표를 확인할 수 없습니다.');};
  const vector=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
  const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0),sub=(a,b)=>a.map((n,i)=>n-b[i]);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  function camera(base,corners){
    const n=base?.viewPlaneNormal,u=base?.viewUp;
    if(!vector(n)||!vector(u)||Math.abs(dot(n,n)-1)>1e-6||Math.abs(dot(u,u)-1)>1e-6||Math.abs(dot(n,u))>1e-6||!Array.isArray(corners)||corners.length!==8||!corners.every(vector))fail();
    const normal=cross(n,u),focalPoint=[0,1,2].map(i=>corners.reduce((sum,p)=>sum+p[i],0)/8),right=cross(n,normal);
    const span=Math.max(...corners.map(p=>Math.max(Math.abs(dot(sub(p,focalPoint),n)),Math.abs(dot(sub(p,focalPoint),right)))));
    if(!Number.isFinite(span)||span<=0)fail();
    return {focalPoint,position:focalPoint.map((v,i)=>v+normal[i]*Math.max(1,span*4)),viewPlaneNormal:normal,viewUp:n.slice(),parallelScale:span*1.05,parallelProjection:true,flipHorizontal:false,flipVertical:false};
  }
  function line(normal,center,canvasCorners,width,height){
    if(!vector(normal)||!vector(center)||Math.abs(dot(normal,normal)-1)>1e-6||!Array.isArray(canvasCorners)||canvasCorners.length!==3||!canvasCorners.every(vector)||![width,height].every(n=>Number.isFinite(n)&&n>0))fail();
    const [origin,x,y]=canvasCorners,a=dot(normal,sub(x,origin))/width,b=dot(normal,sub(y,origin))/height,c=dot(normal,sub(origin,center)),points=[];
    const add=(x,y)=>{if(x>=-1e-6&&x<=width+1e-6&&y>=-1e-6&&y<=height+1e-6){const p=[Math.max(0,Math.min(width,x)),Math.max(0,Math.min(height,y))];if(!points.some(q=>Math.hypot(p[0]-q[0],p[1]-q[1])<1e-6))points.push(p);}};
    if(Math.abs(b)>1e-12){add(0,-c/b);add(width,-(a*width+c)/b);}
    if(Math.abs(a)>1e-12){add(-c/a,0);add(-(b*height+c)/a,height);}
    if(points.length<2)return null;
    let pair=[points[0],points[1]],distance=0;
    for(const p of points)for(const q of points){const d=Math.hypot(p[0]-q[0],p[1]-q[1]);if(d>distance){pair=[p,q];distance=d;}}
    return pair;
  }
  return {camera,line};
});
