(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumePreferences=api;})(globalThis,()=>{
  const fields=['windowing','zoom','thickness','scale','orientation','demographics','cube','sample','autoHideCrosshair'];
  const tools=['WindowLevel','Pan','Zoom','StackScroll'];
  const defaults=()=>({version:1,display:Object.fromEntries(fields.map(k=>[k,k!=='autoHideCrosshair'])),mouse:{left:'WindowLevel',middle:'Pan',right:'Zoom'},sync:{windowing:true,zoom:false},progressive:false});
  function normalize(v){
    const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
    if(!object(v)||Object.keys(v).sort().join(',')!=='display,mouse,progressive,sync,version'||v.version!==1||typeof v.progressive!=='boolean'||!object(v.display)||Object.keys(v.display).sort().join(',')!==fields.slice().sort().join(',')||fields.some(k=>typeof v.display[k]!=='boolean')||!object(v.mouse)||Object.keys(v.mouse).sort().join(',')!=='left,middle,right'||Object.values(v.mouse).some(t=>!tools.includes(t))||new Set(Object.values(v.mouse)).size!==3||!object(v.sync)||Object.keys(v.sync).sort().join(',')!=='windowing,zoom'||typeof v.sync.windowing!=='boolean'||typeof v.sync.zoom!=='boolean')return null;
    return {version:1,display:Object.fromEntries(fields.map(k=>[k,v.display[k]])),mouse:{left:v.mouse.left,middle:v.mouse.middle,right:v.mouse.right},sync:{windowing:v.sync.windowing,zoom:v.sync.zoom},progressive:v.progressive};
  }
  // The ruler describes distance in the rendered patient plane, not physical
  // monitor size. Choose a readable length that fits at the current zoom.
  function ruler(view){
    const canvas=view.getCanvas(),width=canvas.clientWidth,height=canvas.clientHeight;
    if(width<100||height<100)return null;
    const a=view.canvasToWorld([width/2,height/2]),b=view.canvasToWorld([width/2+1,height/2]);
    const mm=Math.hypot(...a.map((n,i)=>n-b[i])),limit=Math.min(90,width/3)*mm;
    if(!Number.isFinite(mm)||mm<=0||!Number.isFinite(limit)||limit<=0)return null;
    const decade=10**Math.floor(Math.log10(limit)),length=[5,2,1].map(n=>n*decade).find(n=>n<=limit)||decade/2;
    return {mm:length,pixels:length/mm};
  }
  function cube(view){
    const focal=view.getCamera().focalPoint,origin=view.worldToCanvas(focal);
    const r=ruler(view);if(!r)return null;const unit=r.pixels/r.mm;
    const project=p=>{const xy=view.worldToCanvas(p.map((n,i)=>n+focal[i]));return xy.map((n,i)=>60+(n-origin[i])*22/unit);};
    const corners=Array.from({length:8},(_,n)=>project([0,1,2].map(i=>n&(1<<i)?1:-1)));
    const edges=[];for(let i=0;i<8;i++)for(let axis=0;axis<3;axis++){const j=i^(1<<axis);if(i<j)edges.push([i,j]);}
    const normal=view.getCamera().viewPlaneNormal;
    const labels=['R','L','A','P','F','H'].flatMap((text,i)=>normal[Math.floor(i/2)]*(i%2?1:-1)>.01?[{text,point:project([0,1,2].map(k=>k===Math.floor(i/2)?(i%2?1:-1)*1.2:0))}]:[]);
    return {corners,edges,labels};
  }
  return {fields,tools,defaults,normalize,ruler,cube};
});
