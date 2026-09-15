/* MIP Viewer Batch model (kin-mip-batch-1): a display-only rotation series of the confirmed MIP/MinIP/Raysum Final display.
   The manual (IF-RND-502U p.342 -> p.339 -> p.328) says only that the batch makes continuous images rotating transversely or
   vertically with the 11.8 Batch controls. Everything numeric here is this product's choice, not a manual statement: Horizontal
   turns about the Final viewUp u0, Vertical about the screen right r0 = u0 x n0, + is right-handed about that axis and Reverse
   negates it; the limits, the square 512 px raster and the camera are ours too. The manual tool's Type and Thickness fields and
   the VR A/P/L/R/H/F presets are not offered: the slab is the whole volume or the VOI Slab, and the MIP orientations stay
   Axial/Coronal/Sagittal. api/src/viewer-volume-mip.ts applies the same recipe rule. No voxels are edited; nothing here renders. */
(function(root){
  const SCHEMA=1,ALGORITHM='kin-mip-batch-1',SIZE=512,FRAME_MS=15000,BUDGET_MS=300000,SPAN_EDGE=1e-9,CAMERA_EDGE=1e-6;
  const AXES=Object.freeze(['Horizontal','Vertical']),KEYS=Object.freeze(['schema','algorithm','axis','interval','count','reverse']);
  const LIMITS=Object.freeze({interval:Object.freeze([1,180]),count:Object.freeze([2,64]),span:360});
  // The MPR batch budgets (volume-batch.js, viewer-volume-batch.js): 64 MiB of raw frames and 32 MiB of encoded images.
  const RAW_BYTES=64*1024*1024,BLOB_BYTES=32*1024*1024;
  const DEFAULTS=Object.freeze({axis:'Horizontal',interval:10,count:36,reverse:false});
  const messages=Object.freeze({
    reproduce:'MIP Batch 작업의 계산 방식을 이 뷰어가 재현할 수 없어 복원하지 않았습니다.',
    shape:'저장한 MIP Batch 조건의 형식을 확인할 수 없어 복원하지 않았습니다.',
    axis:'MIP Batch Axis를 Horizontal 또는 Vertical에서 선택하세요.',
    limits:'MIP Batch Interval은 1~180도, Number는 2~64장, 전체 회전 범위((Number-1)×Interval)는 360도 이내로 입력하세요.',
    camera:'MIP 투영 카메라를 확인할 수 없어 MIP Batch를 만들지 않았습니다.',
    distance:'MIP 투영 카메라가 CT 볼륨 투영 범위 안에 있어 MIP Batch를 만들지 않았습니다.',
    frameCamera:'MIP Batch 프레임의 투영 카메라를 확인하지 못했습니다.',
    generating:'MIP Batch 생성이 끝난 뒤 다시 누르세요.',
    restoring:'MIP 작업 복원이 끝난 뒤 MIP Batch를 만드세요.',
    saving:'MIP 작업 저장이 끝난 뒤 MIP Batch를 만드세요.',
    busy:'영상 작업 처리가 끝난 뒤 MIP Batch를 만드세요.',
    rendering:'최종 표시를 확인한 뒤 MIP Batch를 만드세요.',
    original:'Original 보기를 끈 뒤 MIP Batch를 만드세요.',
    save:'MIP Batch 생성을 마친 뒤 MIP 작업을 저장하세요.',
    tool:'MIP Batch 도구를 불러오지 못해 MIP Batch를 만들 수 없습니다. Projection·Orientation·VOI Slab과 MIP 작업 저장은 계속 쓸 수 있습니다.',
    restoreTool:'MIP Batch 도구를 불러오지 못해 MIP 작업을 복원하지 않았습니다.',
    frameTimeout:'MIP Batch 프레임의 최종 렌더를 확인하지 못했습니다.',
    size:'MIP Batch 영상 크기를 확인하지 못했습니다.',
    image:'MIP Batch 영상을 만들지 못했습니다.',
    memory:'MIP Batch 결과가 32 MiB를 넘었습니다. Number를 줄이세요.',
    cancelled:'MIP Batch 생성을 취소했습니다.',
    changed:'화면이 변경되어 MIP Batch 생성을 중단했습니다.',
    expired:'MIP Batch 복원 시간이 지났습니다. 이전 화면으로 되돌립니다.',
    kept:' 이전 MIP Batch 미리보기를 유지합니다.',
    cleared:'MIP Batch 미리보기를 비웠습니다.',
  });
  const exact=(v,want)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===want.length&&Object.keys(v).every(k=>want.includes(k));
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const vector=v=>{try{const a=Array.from(v||[]);return a.length===3&&a.every(finite)?a:null;}catch(_){return null;}};
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  // The saved form is JSON text in a jsonb column that does not keep key order, so comparison text sorts keys (volume-mip-job.js).
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  const limited=(interval,count)=>finite(interval)&&interval>=LIMITS.interval[0]&&interval<=LIMITS.interval[1]&&Number.isInteger(count)&&
    count>=LIMITS.count[0]&&count<=LIMITS.count[1]&&(count-1)*interval<=LIMITS.span+SPAN_EDGE;
  // '' for a recipe this viewer reproduces, 'reproduce' for another schema or algorithm, 'shape' for anything malformed.
  function problem(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||value.schema!==SCHEMA||value.algorithm!==ALGORITHM)return 'reproduce';
    if(!exact(value,KEYS)||!AXES.includes(value.axis)||typeof value.reverse!=='boolean'||!limited(value.interval,value.count))return 'shape';
    return '';
  }
  const freeze=value=>Object.freeze({schema:value.schema,algorithm:value.algorithm,axis:value.axis,interval:value.interval,count:value.count,reverse:value.reverse});
  function validate(value){const reason=problem(value);if(reason)throw Error(messages[reason]);return freeze(value);}
  // The recipe from the editors. Numbers are taken as entered and refused, never clamped or rounded into range.
  function recipe({axis,interval,count,reverse}={}){
    if(!AXES.includes(axis))throw Error(messages.axis);
    if(typeof reverse!=='boolean'||!limited(interval,count))throw Error(messages.limits);
    return freeze({schema:SCHEMA,algorithm:ALGORITHM,axis,interval,count,reverse});
  }
  // Rodrigues rotation of v about the unit axis k by a signed angle in degrees, right-handed.
  function rotate(v,k,degrees){
    const r=degrees*Math.PI/180,c=Math.cos(r),s=Math.sin(r),d=dot(k,v),x=cross(k,v);
    return [0,1,2].map(i=>v[i]*c+x[i]*s+k[i]*d*(1-c));
  }
  /* The analytic camera of every frame. All frames look at the voxel-centre box centre from the confirmed Final camera distance D
     with parallelScale thickness/2, so the square raster spans the whole-volume slab in every direction. D must leave the camera
     outside that slab: a camera inside it would clip rays while every plane readback still matched. */
  function plan({recipe:value,normal,viewUp,focalPoint,distance,thickness}={}){
    const r=validate(value),n0=vector(normal),u0=vector(viewUp),f=vector(focalPoint);
    if(!n0||!u0||!f||Math.abs(Math.hypot(...n0)-1)>1e-6||Math.abs(Math.hypot(...u0)-1)>1e-6||Math.abs(dot(n0,u0))>1e-6||!finite(thickness)||!(thickness>0))throw Error(messages.camera);
    if(!finite(distance)||!(distance>=thickness/2+CAMERA_EDGE))throw Error(messages.distance);
    if(r.count*SIZE*SIZE*4>RAW_BYTES)throw Error(messages.limits);
    const c=cross(u0,n0),length=Math.hypot(...c),right=c.map(x=>x/length),axis=r.axis==='Horizontal'?u0:right,sign=r.reverse?-1:1,scale=thickness/2;
    const cameras=Array.from({length:r.count},(_,i)=>{
      const angle=i?sign*i*r.interval:0;
      // Frame 0 is the Final direction itself. A Horizontal turn keeps viewUp, its own axis, bit for bit.
      const n=i?rotate(n0,axis,angle):[...n0],u=i&&r.axis==='Vertical'?rotate(u0,axis,angle):[...u0];
      return Object.freeze({index:i,angle,focalPoint:Object.freeze([...f]),position:Object.freeze(f.map((x,k)=>x+n[k]*distance)),viewPlaneNormal:Object.freeze(n),viewUp:Object.freeze(u),parallelScale:scale});
    });
    return Object.freeze({size:SIZE,parallelScale:scale,distance,axis:Object.freeze([...axis]),cameras:Object.freeze(cameras)});
  }
  // A frame is its analytic camera only if focal point, position, normal, up and parallel scale all read back within 1e-6.
  function verifyCamera(actual,want){
    if(!actual||!want)return messages.frameCamera;
    for(const key of ['focalPoint','position','viewPlaneNormal','viewUp']){const a=vector(actual[key]),b=want[key];if(!a||a.some((n,i)=>!(Math.abs(n-b[i])<=CAMERA_EDGE)))return messages.frameCamera;}
    return finite(actual.parallelScale)&&Math.abs(actual.parallelScale-want.parallelScale)<=CAMERA_EDGE?'':messages.frameCamera;
  }
  // The explicit restore regeneration budget, armed only after the Final display is confirmed; each frame waits at most 15 s of it.
  function budget(count){if(!Number.isInteger(count)||count<LIMITS.count[0]||count>LIMITS.count[1])throw Error(messages.limits);return Math.min(count*FRAME_MS,BUDGET_MS);}
  const frameTimeout=remaining=>Math.max(0,Math.min(FRAME_MS,Number.isNaN(remaining)?0:remaining));
  function key(block){if(!block||typeof block!=='object'||Array.isArray(block))throw Error(messages.camera);return canonical(block);}
  // The first reason Make MIP Batch is refused, in the order a user can act on it.
  function makeGate({generating=false,restoring=false,saving=false,busy=false,snapshot=null,same=(a,b)=>root.KinVolumeMip.sameRequest(a,b)}={}){
    if(generating)return messages.generating;
    if(restoring)return messages.restoring;
    if(saving)return messages.saving;
    if(busy)return messages.busy;
    const final=snapshot?.final,applied=snapshot?.applied;let confirmed=false;
    try{confirmed=snapshot?.state==='final'&&!!final&&!!applied&&same(applied,final)===true;}catch(_){confirmed=false;}
    if(!confirmed)return messages.rendering;
    if(final.original===true)return messages.original;
    return '';
  }
  /* One owned preview. A generation runs beside the previous preview, which stays owned but is not shown, played or saved while
     it runs. Success swaps both in one step and only then revokes the old frames; failure or cancel leaves the previous preview
     untouched; any clear also retires the running generation, so a late success cannot bring frames back. */
  function createPreview({revoke=()=>{}}={}){
    let output=null,run=null;
    const drop=value=>{if(!value)return;for(const frame of value.frames||[])try{revoke(frame.url);}catch(_){}};
    const clear=()=>{const old=output;output=null;run=null;drop(old);return !!old;};
    return {
      begin(owner){if(run||typeof owner!=='string'||!owner)return null;run=Object.freeze({key:owner});return run;},
      generating:()=>!!run,
      succeed(ticket,next){
        if(!ticket||ticket!==run||!next||next.key!==ticket.key){drop(next);return false;}
        run=null;const old=output;output=next;if(old&&old!==next)drop(old);return true;
      },
      fail(ticket){if(!ticket||ticket!==run)return false;run=null;return true;},
      clear,
      // The preview belongs only to the confirmed Final display it was made from; anything else clears it.
      current({state,key:owner}={}){
        if(!output||run)return null;
        if(state!=='final'||owner!==output.key){clear();return null;}
        return output;
      },
      peek:()=>output,
    };
  }
  const mm=value=>Number(Number(value).toFixed(1));
  const degrees=value=>(value>0?'+':'')+Number(Number(value).toFixed(3))+'°';
  function caption({index,count,mode,orientation,axis,angle,voiThickness=null}){
    return (index+1)+' / '+count+' · '+mode+' · '+orientation+' · '+axis+' '+degrees(angle)+' · VOI Slab '+(voiThickness===null?'Off':mm(voiThickness)+' mm')+' · Preview';
  }
  const api=Object.freeze({schema:SCHEMA,algorithm:ALGORITHM,axes:AXES,keys:KEYS,size:SIZE,limits:LIMITS,defaults:DEFAULTS,frameMs:FRAME_MS,budgetMs:BUDGET_MS,
    rawBytes:RAW_BYTES,blobBytes:BLOB_BYTES,messages,problem,validate,recipe,rotate,plan,verifyCamera,budget,frameTimeout,key,makeGate,createPreview,caption});
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumeMipBatch=api;
})(typeof window==='object'?window:globalThis);
