/* MIP Viewer model: whole-volume slab projection on the same native semantics as the MPR slab; no voxels are edited. */
(function(root){
  const modes=Object.freeze(['MIP','MinIP','Raysum']),orientations=Object.freeze(['Axial','Coronal','Sagittal']);
  // The pinned vtk blend modes the Volume Projection panel already uses: 1 maximum, 2 minimum, 3 average.
  // Raysum is the mean along the ray (manual p.326), never the additive blend (4).
  const blends=Object.freeze({MIP:1,MinIP:2,Raysum:3}),keys=Object.freeze({Axial:'axial',Coronal:'coronal',Sagittal:'sagittal'});
  /* A11-ORIENT-1 direction presets (kin-mip-2): the manual's bottom Orientation Preset bar A/P/L/R/H/F (IF-RND-502U Rev1.2
     p.332 §12.1 'A- anterior / P- posterior/ L- left/ R- right / H -head / F - foot'; p.342 §13 'The basic operation works
     the same as it does in the VR mode'). Each entry is [viewPlaneNormal, viewUp] in patient LPS mm: the normal points from
     the focal point toward the camera and screen right is viewUp x normal. This is a pinned copy of this product's own VR
     table (volume-rendering.js directions), never a runtime import — a saved kin-mip-2 row must keep its meaning even if VR
     changes, so a changed VR table is a new algorithm, not a reinterpretation; tests/volume_mip_test.cjs guards the drift.
     H = Superior, F = Inferior. F is the Axial projection turned 180 degrees in plane (same normal, up and screen right both
     negated), not the Axial image; Axial itself stays the radiological foot view. */
  const directions=Object.freeze({
    Anterior:Object.freeze([Object.freeze([0,-1,0]),Object.freeze([0,0,1])]),
    Posterior:Object.freeze([Object.freeze([0,1,0]),Object.freeze([0,0,1])]),
    Left:Object.freeze([Object.freeze([1,0,0]),Object.freeze([0,0,1])]),
    Right:Object.freeze([Object.freeze([-1,0,0]),Object.freeze([0,0,1])]),
    Superior:Object.freeze([Object.freeze([0,0,1]),Object.freeze([0,-1,0])]),
    Inferior:Object.freeze([Object.freeze([0,0,-1]),Object.freeze([0,1,0])]),
  });
  const directionNames=Object.freeze(Object.keys(directions)),views=Object.freeze([...orientations,...directionNames]);
  const dot=(a,b)=>a.reduce((n,x,i)=>n+x*b[i],0),vector=v=>{try{const a=Array.from(v||[]);return a.length===3&&a.every(Number.isFinite)?a:null;}catch(_){return null;}};
  /* VOI Slab: a display-only slab in source world (patient LPS mm) bound to one volume and the index-to-world affine
     captured at open. It is never the W/L voiRange. HISTORY bounds the confirmed records Undo can return to. */
  const VOI_LIMIT=1e6,HISTORY=32,finite=n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=VOI_LIMIT;
  const triple=v=>Array.isArray(v)&&v.length===3&&v.every(finite);
  function affine(indexToWorld){
    const origin=vector(indexToWorld([0,0,0])),axes=[[1,0,0],[0,1,0],[0,0,1]].map(e=>vector(indexToWorld(e)));
    if(!origin||axes.some(a=>!a))throw Error('CT 원본 좌표를 확인할 수 없습니다.');
    const [i,j,k]=axes.map(a=>a.map((n,m)=>n-origin[m])),values=[...origin,...i,...j,...k];
    const volume=i[0]*(j[1]*k[2]-j[2]*k[1])-i[1]*(j[0]*k[2]-j[2]*k[0])+i[2]*(j[0]*k[1]-j[1]*k[0]);
    if(!values.every(finite)||!(Math.abs(volume)>0))throw Error('CT 원본 좌표를 확인할 수 없습니다.');
    return Object.freeze(values);
  }
  function normalizeVoi(value){
    if(value===null||value===undefined)return null;
    if(typeof value!=='object'||typeof value.volumeId!=='string'||!value.volumeId||!Array.isArray(value.affine)||value.affine.length!==12||!value.affine.every(finite)||![value.center,value.normal,value.pivot].every(triple)||!finite(value.thickness)||!(value.thickness>0))throw Error('VOI Slab 값을 확인할 수 없습니다.');
    const length=Math.hypot(...value.normal);
    if(!(Math.abs(length-1)<=1e-6))throw Error('VOI Slab 방향을 확인할 수 없습니다.');
    return Object.freeze({volumeId:value.volumeId,affine:Object.freeze([...value.affine]),center:Object.freeze([...value.center]),normal:Object.freeze(value.normal.map(n=>n/length)),pivot:Object.freeze([...value.pivot]),thickness:value.thickness});
  }
  const sameList=(a,b)=>a.length===b.length&&a.every((n,i)=>n===b[i]);
  function sameVoi(a,b){
    if(!a||!b)return !a&&!b;
    return a===b||a.volumeId===b.volumeId&&a.thickness===b.thickness&&['affine','center','normal','pivot'].every(key=>sameList(a[key],b[key]));
  }
  // A record from another volume or another affine is refused, never re-read in the current volume's coordinates.
  function verifyBinding(value,binding){
    let record;try{record=normalizeVoi(value);}catch(error){return error.message;}
    if(!record)return '';
    if(!binding||record.volumeId!==binding.volumeId)return 'VOI Slab이 현재 CT 볼륨의 값이 아니어서 적용하지 않았습니다.';
    const current=binding.affine;
    if(!Array.isArray(current)||current.length!==12||record.affine.some((n,i)=>!Number.isFinite(current[i])||Math.abs(n-current[i])>1e-9*Math.max(1,Math.abs(n))))return 'VOI Slab의 CT 좌표 기준이 현재 볼륨과 달라 적용하지 않았습니다.';
    return '';
  }
  // Two inward planes: the pinned mapper keeps dot(x-origin, normal) >= 0 and shortens each ray to that segment, so
  // excluded samples are never traversed by MIP, MinIP or the counted-sample mean.
  function voiPlanes(value){
    const record=normalizeVoi(value);if(!record)throw Error('VOI Slab 값을 확인할 수 없습니다.');
    const half=record.thickness/2,n=record.normal;
    return [{origin:record.center.map((x,i)=>x-n[i]*half),normal:[...n]},{origin:record.center.map((x,i)=>x+n[i]*half),normal:n.map(x=>-x)}];
  }
  // The viewport rewrites the first two (slab) planes on camera and thickness changes. VOI planes refuse those writes,
  // so no camera change can move the slab in world space.
  function voiPlane(definition){
    if(!definition||![definition.origin,definition.normal].every(triple))throw Error('VOI Slab 평면을 확인할 수 없습니다.');
    const origin=Object.freeze([...definition.origin]),normal=Object.freeze([...definition.normal]);
    return Object.freeze({isA:name=>name==='vtkPlane',getOrigin:()=>[...origin],getNormal:()=>[...normal],setOrigin:()=>false,setNormal:()=>false});
  }
  function normalizeHistory(value){
    if(value===undefined)return Object.freeze([]);
    if(!Array.isArray(value)||value.length>HISTORY)throw Error('VOI Slab 되돌리기 기록을 확인할 수 없습니다.');
    return Object.freeze(value.map(normalizeVoi));
  }
  function normalizeRequest(value){
    if(!value||!modes.includes(value.mode)||!views.includes(value.orientation))throw Error('Projection과 Orientation을 목록에서 선택하세요.');
    if(value.original!==undefined&&typeof value.original!=='boolean')throw Error('Original 보기 상태를 확인할 수 없습니다.');
    const voiSlab=normalizeVoi(value.voiSlab),original=value.original===true;
    if(original&&!voiSlab)throw Error('VOI Slab을 적용한 뒤 Original을 볼 수 있습니다.');
    return {mode:value.mode,orientation:value.orientation,voiSlab,original,history:normalizeHistory(value.history)};
  }
  const sameHistory=(a,b)=>a.length===b.length&&a.every((n,i)=>sameVoi(n,b[i]));
  function sameRequest(a,b){
    if(!a||!b)return false;
    const left=normalizeRequest(a),right=normalizeRequest(b);
    return left.mode===right.mode&&left.orientation===right.orientation&&left.original===right.original&&sameVoi(left.voiSlab,right.voiSlab)&&sameHistory(left.history,right.history);
  }
  /* Undo history travels with each request and only becomes current when that request's final render is confirmed,
     so a superseded or failed change never enters it. `final` is the confirmed request, `applied` the latest one. */
  function withDisplay(applied,change){const base=normalizeRequest(applied);return normalizeRequest({...base,...change,voiSlab:base.voiSlab,original:base.original,history:base.history});}
  function voiChange(final,applied,voiSlab){
    const base=normalizeRequest(applied),done=normalizeRequest(final),next=normalizeVoi(voiSlab);
    if(base.original)throw Error('Original 보기를 끈 뒤 VOI Slab을 바꾸세요.');
    if(sameVoi(next,done.voiSlab))return {mode:base.mode,orientation:base.orientation,voiSlab:done.voiSlab,original:false,history:done.history};
    return {mode:base.mode,orientation:base.orientation,voiSlab:next,original:false,history:Object.freeze([...done.history,done.voiSlab].slice(-HISTORY))};
  }
  function voiUndo(final,applied){
    const base=normalizeRequest(applied),done=normalizeRequest(final);
    if(base.original)throw Error('Original 보기를 끈 뒤 Undo를 누르세요.');
    const chain=[...done.history,done.voiSlab],steps=base.history.length;
    // A pending change that is not a confirmed record is undone to the current Final first.
    if(!sameHistory([...base.history,base.voiSlab],chain.slice(0,steps+1)))return {mode:base.mode,orientation:base.orientation,voiSlab:done.voiSlab,original:false,history:done.history};
    if(!steps)throw Error('되돌릴 VOI Slab 변경이 없습니다.');
    return {mode:base.mode,orientation:base.orientation,voiSlab:base.history[steps-1],original:false,history:Object.freeze(base.history.slice(0,-1))};
  }
  function voiOriginal(applied,original){
    const base=normalizeRequest(applied);
    if(typeof original!=='boolean')throw Error('Original 보기 상태를 확인할 수 없습니다.');
    return normalizeRequest({...base,original});
  }
  function blendMode(mode){if(!Object.prototype.hasOwnProperty.call(blends,mode))throw Error('Projection을 목록에서 선택하세요.');return blends[mode];}
  // Presets are the native MPR_CAMERA_VALUES the MPR planes open with, so the same name is the same plane.
  function preset(values,orientation){
    const key=keys[orientation],entry=key&&values?values[key]:null,normal=vector(entry?.viewPlaneNormal),up=vector(entry?.viewUp);
    if(!normal||!up||Math.abs(Math.hypot(...normal)-1)>1e-6||Math.abs(Math.hypot(...up)-1)>1e-6||Math.abs(dot(normal,up))>1e-6)throw Error('고정 뷰어의 '+(key?orientation:'선택한')+' 방향 기준값을 확인할 수 없습니다.');
    return {key,viewPlaneNormal:normal,viewUp:up};
  }
  /* The camera of any of the nine offered displays: the three MPR planes resolve through the pinned MPR_CAMERA_VALUES above,
     the six anatomical presets through the frozen kin-mip-2 table. `key` is the native orientation key for a plane and null
     for a direction, which the viewer writes as setOrientation({viewPlaneNormal,viewUp},false). Every camera write, batch
     frame and print frame resolves here, so no call site keeps a preset lookup of its own. */
  function view(values,orientation){
    const entry=Object.prototype.hasOwnProperty.call(directions,orientation)?directions[orientation]:null;
    return entry?{key:null,viewPlaneNormal:[...entry[0]],viewUp:[...entry[1]]}:preset(values,orientation);
  }
  function geometry(dimensions,spacing){
    const d=Array.from(dimensions||[]),s=Array.from(spacing||[]);
    if(d.length!==3||s.length!==3||d.some(n=>!Number.isInteger(n)||n<2)||s.some(n=>!Number.isFinite(n)||n<=0))throw Error('CT 볼륨 크기와 간격을 확인할 수 없습니다.');
    return {d,s};
  }
  // The Volume Projection panel's Total Thickness upper limit; centred on the volume it spans every voxel centre.
  function projectionThickness(dimensions,spacing){const {d,s}=geometry(dimensions,spacing),total=Math.min(1000,Math.hypot(...d.map((n,i)=>(n-1)*s[i])));if(!(total>=.2))throw Error('CT 볼륨 두께를 확인할 수 없습니다.');return total;}
  // Pinned createVolumeMapper samples every (sx+sy+sz)/6 mm; a coarser value is a preview, not a final render.
  function sampleDistance(spacing){const {s}=geometry([2,2,2],spacing);return (s[0]+s[1]+s[2])/6;}
  function corners(dimensions,indexToWorld){
    const {d}=geometry(dimensions,[1,1,1]),result=[];
    for(const i of [0,d[0]-1])for(const j of [0,d[1]-1])for(const k of [0,d[2]-1]){const world=vector(indexToWorld([i,j,k]));if(!world)throw Error('CT 원본 좌표를 확인할 수 없습니다.');result.push(world);}
    return result;
  }
  const near=(a,b,tolerance)=>!!a&&!!b&&a.every((n,i)=>Math.abs(n-b[i])<=tolerance);
  // Returns the first mismatch between the native state and the requested final display, or ''.
  function verifyState(state,expected){
    if(!state||state.actors!==1||state.volumeId!==expected.volumeId)return 'MIP 표시의 원본 볼륨을 확인하지 못했습니다.';
    if(state.blend!==expected.blend)return 'MIP 투영 방식을 확인하지 못했습니다.';
    const normal=vector(state.viewPlaneNormal),up=vector(state.viewUp);
    if(!near(normal,expected.viewPlaneNormal,1e-6)||!near(up,expected.viewUp,1e-6))return 'MIP 투영 방향을 확인하지 못했습니다.';
    const planes=Array.isArray(state.planes)?state.planes.map(p=>({origin:vector(p?.origin),normal:vector(p?.normal)})):[];
    if(planes.length<2||planes.slice(0,2).some(p=>!p.origin||!p.normal||Math.abs(Math.abs(dot(p.normal,normal))-1)>1e-6))return 'MIP 투영 평면을 확인하지 못했습니다.';
    const total=expected.thickness,gap=Math.hypot(...planes[0].origin.map((n,i)=>n-planes[1].origin[i]));
    if(!Number.isFinite(total)||Math.abs(gap-total)>1e-6*Math.max(1,total))return 'MIP 투영 두께를 확인하지 못했습니다.';
    const middle=planes[0].origin.map((n,i)=>(n+planes[1].origin[i])/2);
    if(!expected.corners.every(c=>Math.abs(dot(c.map((n,i)=>n-middle[i]),normal))<=total/2-1e-6))return 'CT 볼륨 전체가 투영 범위에 들어가지 않아 표시하지 않았습니다.';
    if(!Number.isFinite(state.sampleDistance)||Math.abs(state.sampleDistance-expected.sampleDistance)>1e-9)return '최종 표본 간격이 아니어서 MIP 표시를 확정하지 않았습니다.';
    if(state.interpolationType!==expected.interpolationType)return 'MIP 보간 방식을 확인하지 못했습니다.';
    const range=state.voiRange,voi=expected.voiRange;
    if(!range||![range.lower,range.upper].every(Number.isFinite)||Math.abs(range.lower-voi.lower)>1e-6*Math.max(1,Math.abs(voi.lower))||Math.abs(range.upper-voi.upper)>1e-6*Math.max(1,Math.abs(voi.upper)))return 'MIP 밝기 범위를 확인하지 못했습니다.';
    // The shown slab is the request's unless Original is on; any other plane set is not this display.
    const slab=expected.voiSlab??null;
    if(planes.length!==(slab?4:2))return slab?'VOI Slab 평면을 확인하지 못했습니다.':'VOI Slab 평면이 남아 있어 표시를 확정하지 않았습니다.';
    if(slab){
      const binding=verifyBinding(slab,{volumeId:expected.volumeId,affine:expected.affine});if(binding)return binding;
      if(voiPlanes(slab).some((p,i)=>{const q=planes[2+i];return !q.origin||!q.normal||!near(q.origin,p.origin,1e-6)||!near(q.normal,p.normal,1e-6);}))return 'VOI Slab 평면을 확인하지 못했습니다.';
    }
    return '';
  }
  // A04's average patch counts accepted samples; the unpatched shader divides by fractional ray distance.
  const averageShader=source=>typeof source==='string'&&source.includes('kinAverageSamples += 1.0;')&&source.includes('max(kinAverageSamples, 1.0)')&&!source.includes('sum /= vec4(stepsTraveled');
  // The pinned mapper bakes the plane count into the ray-bound loop. A program linked for another count would read
  // stale plane uniforms, so the linked source must clip the ray segment for exactly the planes read back.
  const clipLoop='float rayDirRatio = dot(rayDir, vClipPlaneNormals[i]);';
  const clipShader=(source,count)=>typeof source==='string'&&Number.isInteger(count)&&count>0&&source.split(clipLoop).length===2&&source.includes('for(int i = 0; i < '+count+'; i++) {\n  '+clipLoop)&&source.includes('if (rayDirRatio < 0.0) dists.y = min(dists.y, result);')&&source.includes('else dists.x = max(dists.x, result);');
  const mm=value=>Number(Number(value).toFixed(1));
  function describe(request,thickness){const r=normalizeRequest(request);return r.mode+' · '+r.orientation+' · '+mm(thickness)+' mm'+(r.voiSlab?(r.original?' · Original':' · VOI Slab '+mm(r.voiSlab.thickness)+' mm'):'');}
  function normalizeOwner(owner){
    if(!Array.isArray(owner)||owner.length!==2||owner.some(value=>typeof value!=='string'||value.length<1||value.length>256||/[ -]/.test(value)))throw Error('MIP Viewer의 기관과 계정을 확인할 수 없습니다.');
    return [...owner];
  }
  /* Serializes display changes. The latest selection wins; a result is announced only for the current request after
     its final render was confirmed, and any failure returns to the last confirmed display. */
  function createSequence({apply,confirm,blocked,closed,show,fatal,describe:label}){
    let generation=0,applied=null,final=null,state='pending',ended=false;
    const same=(a,b)=>{try{return sameRequest(a,b);}catch(_){return false;}};
    const live=()=>{try{return !ended&&!closed();}catch(_){return false;}};
    const stop=error=>{if(ended)return;ended=true;generation++;fatal(error);};
    function settle(request,ticket,message){
      let result;try{result=Promise.resolve(confirm(request));}catch(error){result=Promise.reject(error);}
      return result.then(()=>{
        if(ticket!==generation||!live())return false;
        final=request;state='final';show({status:'final',request,message:message??label(request)+' 최종 표시를 확인했습니다.'});return true;
      },error=>ticket!==generation||!live()?false:restore(error,message!==undefined));
    }
    function restore(error,rollingBack){
      if(rollingBack||!final){stop(error);return false;}
      const ticket=++generation,message=(error?.message||'MIP 표시를 적용하지 못했습니다.')+' 이전 표시('+label(final)+')를 유지합니다.';
      try{apply(final);}catch(rollbackError){stop(rollbackError);return false;}
      applied=final;state='pending';show({status:'pending',request:final,message});
      return settle(final,ticket,message);
    }
    function begin(next){
      const ticket=++generation;
      try{apply(next);}catch(error){return Promise.resolve(restore(error,false));}
      applied=next;state='pending';show({status:'pending',request:next,message:label(next)+' 최종 렌더를 확인하는 중입니다.'});
      return settle(next,ticket);
    }
    return {
      start(initial){if(ended||generation||!live())return Promise.resolve(false);return begin(initial);},
      request(next){
        if(!live()||!generation)return Promise.resolve(false);
        let reason;try{reason=blocked();}catch(_){reason='작업 상태를 확인하지 못했습니다. 잠시 뒤 다시 선택하세요.';}
        if(reason){show({status:state,request:applied,message:reason});return Promise.resolve(false);}
        if(same(next,applied))return Promise.resolve(false);
        return begin(next);
      },
      dispose(){ended=true;generation++;},
      snapshot:()=>({applied,final,state,generation,ended}),
    };
  }
  const api={modes,orientations,directions:directionNames,views,view,normalizeRequest,blendMode,preset,projectionThickness,sampleDistance,corners,verifyState,averageShader,describe,normalizeOwner,createSequence,
    voiHistoryLimit:HISTORY,affine,normalizeVoi,sameVoi,verifyBinding,voiPlanes,voiPlane,sameRequest,withDisplay,voiChange,voiUndo,voiOriginal,clipShader};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumeMip=api;
})(typeof window==='object'?window:globalThis);
