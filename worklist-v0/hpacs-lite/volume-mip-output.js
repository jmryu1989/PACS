/* MIP Viewer output model (A11-OUTPUT-1): Print Saved Images for a saved version 12 MIP Viewer Job and a version 13 MIP Batch Job.
   Every page frame is rebuilt from freshly read CT pixels under an exact analytic camera; nothing here renders or reads pixels.
   The camera distance D = projectionThickness, the 512 px square raster, the captions and the bounds are this product's output
   choices (A11-OUTPUT-1 U3), not manual statements. Other MIP globals are resolved at call time: print assets load in parallel. */
(function(root){
  const SIZE=512,OUTER_MS=120000,FRAME_MS=15000,PRE_RENDER_MS=5000,BLOB_BYTES=32*1024*1024,CAMERA_EDGE=1e-6,DEPTH_EDGE=1e-6;
  const messages=Object.freeze({
    reproduce:'MIP 작업의 계산 방식을 이 뷰어가 재현할 수 없어 출력하지 않았습니다.',
    shape:'저장한 MIP 작업의 형식을 확인할 수 없어 출력하지 않았습니다.',
    frame:'저장한 MIP 작업의 좌표계(Frame of Reference)가 출력 원본과 달라 출력하지 않았습니다.',
    outside:'저장한 VOI Slab이 출력 CT 볼륨과 겹치지 않아 출력하지 않았습니다.',
    tool:'MIP 출력 도구를 불러오지 못했습니다. 다시 확인하세요.',
    batchTool:'MIP Batch 출력 도구를 불러오지 못해 출력하지 않았습니다.',
    average:'Raysum 평균 계산 모듈을 확인할 수 없어 출력하지 않았습니다.',
    capability:'고정 뷰어에서 MIP 출력 기능을 확인하지 못했습니다.',
    camera:'MIP 출력 투영 카메라를 확인할 수 없어 출력하지 않았습니다.',
    distance:'MIP 출력 카메라가 CT 볼륨 투영 범위 안에 있어 출력하지 않았습니다.',
    frameCamera:'MIP 출력 프레임의 투영 카메라를 확인하지 못했습니다.',
    clip:'MIP 출력 투영 깊이 범위를 확인하지 못했습니다.',
    display:'MIP 출력 표시 속성을 확인하지 못했습니다.',
    preRender:'MIP 출력 준비 렌더를 확인하지 못했습니다.',
    frameTimeout:'MIP 출력 프레임의 최종 렌더를 확인하지 못했습니다.',
    plane:'MIP 출력의 VOI Slab 평면을 적용하지 못했습니다.',
    gpu:'MIP 출력 셰이더를 GPU에서 확인하지 못했습니다.',
    contextLost:'MIP 출력 GPU 문맥이 사라져 출력하지 않았습니다.',
    slabShader:'MIP 출력 투영 범위 셰이더를 GPU에서 확인하지 못했습니다.',
    voiShader:'MIP 출력 VOI Slab 자르기 셰이더를 GPU에서 확인하지 못했습니다.',
    averageShader:'MIP 출력 Raysum 평균 셰이더를 확인하지 못했습니다.',
    size:'MIP 출력 영상 크기를 확인하지 못했습니다.',
    image:'MIP 출력 영상을 만들지 못했습니다.',
    memory:'MIP 출력 영상 용량 한도(32 MiB)를 초과했습니다.',
    timeout:'MIP 출력 준비 시간이 지났습니다. 다시 확인하세요.',
  });
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const vector=v=>{try{const a=Array.from(v||[]);return a.length===3&&a.every(finite)?a:null;}catch(_){return null;}};
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
  const model=name=>{const value=root[name];if(!value)throw Error(name==='KinVolumeMipBatch'?messages.batchTool:messages.tool);return value;};
  const supports=version=>version===12||version===13;
  // The saved Job as this viewer prints it: version 12 is a mip block without a recipe key, version 13 the same block with its recipe.
  function saved(snapshot){
    const version=object(snapshot)?snapshot.version:undefined;
    if(!supports(version)||!object(snapshot.mip))throw Error(messages.shape);
    const jobs=model('KinVolumeMipJob');
    if(!jobs.supported(snapshot.mip))throw Error(messages.reproduce);
    let mip;try{mip=jobs.validate(snapshot.mip);}catch(_){throw Error(messages.shape);}
    const recipe=Object.prototype.hasOwnProperty.call(snapshot,'mipBatch');
    if(version===12){if(recipe)throw Error(messages.shape);return Object.freeze({version,mip,recipe:null});}
    if(!recipe||!object(snapshot.mipBatch))throw Error(messages.shape);
    const batch=model('KinVolumeMipBatch'),reason=batch.problem(snapshot.mipBatch);
    if(reason)throw Error(messages[reason]);
    return Object.freeze({version,mip,recipe:batch.validate(snapshot.mipBatch)});
  }
  // One direction resolver per saved algorithm. kin-mip-1 names the pinned MPR_CAMERA_VALUES presets its display was confirmed on;
  // a later algorithm adds its own resolver here rather than a print change.
  const resolvers=Object.freeze({'kin-mip-1':(orientation,values)=>{const p=model('KinVolumeMip').preset(values,orientation);return {viewPlaneNormal:p.viewPlaneNormal,viewUp:p.viewUp};}});
  function direction(algorithm,orientation,values){
    if(!Object.prototype.hasOwnProperty.call(resolvers,algorithm))throw Error(messages.reproduce);
    return resolvers[algorithm](orientation,values);
  }
  /* The analytic cameras of a page. Version 12 builds its one camera here with exactly the frame 0 expressions of
     KinVolumeMipBatch.plan, so it is that frame bit for bit without needing the MIP Batch model; version 13 takes every frame from
     that plan unchanged. Both refuse the inputs plan() refuses, before any delegation, with the output's own wording. */
  function plan({version,recipe=null,normal,viewUp,focalPoint,distance,thickness}={}){
    const n0=vector(normal),u0=vector(viewUp),f=vector(focalPoint);
    if(!n0||!u0||!f||Math.abs(Math.hypot(...n0)-1)>1e-6||Math.abs(Math.hypot(...u0)-1)>1e-6||Math.abs(dot(n0,u0))>1e-6||!finite(thickness)||!(thickness>0))throw Error(messages.camera);
    if(!finite(distance)||!(distance>=thickness/2+CAMERA_EDGE))throw Error(messages.distance);
    if(version===12){
      if(recipe!==null)throw Error(messages.shape);
      const scale=thickness/2;
      const camera=Object.freeze({index:0,angle:0,focalPoint:Object.freeze([...f]),position:Object.freeze(f.map((x,k)=>x+n0[k]*distance)),viewPlaneNormal:Object.freeze([...n0]),viewUp:Object.freeze([...u0]),parallelScale:scale});
      return Object.freeze({size:SIZE,parallelScale:scale,distance,cameras:Object.freeze([camera])});
    }
    if(version!==13)throw Error(messages.shape);
    const made=model('KinVolumeMipBatch').plan({recipe,normal:n0,viewUp:u0,focalPoint:f,distance,thickness});
    return Object.freeze({size:SIZE,parallelScale:made.parallelScale,distance:made.distance,cameras:made.cameras});
  }
  // The frames of a saved Job on the print volume: f is the voxel-centre box centre and D = t, the whole-volume projection thickness.
  function frames({saved:job,values,dimensions,spacing,corners}={}){
    const mip=model('KinVolumeMip');
    if(!Array.isArray(corners)||corners.length!==8||!corners.every(corner=>vector(corner)))throw Error(messages.camera);
    const axes=direction(job.mip.algorithm,job.mip.orientation,values),thickness=mip.projectionThickness(dimensions,spacing);
    const focalPoint=[0,1,2].map(i=>corners.reduce((sum,corner)=>sum+corner[i],0)/corners.length);
    const made=plan({version:job.version,recipe:job.recipe,normal:axes.viewPlaneNormal,viewUp:axes.viewUp,focalPoint,distance:thickness,thickness});
    return Object.freeze({...made,thickness,sampleDistance:mip.sampleDistance(spacing),blend:mip.blendMode(job.mip.mode)});
  }
  /* The saved VOI Slab bound to the print volume as a restore binds it (KinVolumeMipJob.restoreRequest), held to that volume id and
     affine and to the voxel-centre box. The fresh Frame of Reference must be the saved one first. */
  function bind({saved:job,frameOfReference,volumeId,affine,corners}={}){
    if(typeof frameOfReference!=='string'||frameOfReference!==job?.mip?.frameOfReference)throw Error(messages.frame);
    const jobs=model('KinVolumeMipJob'),mip=model('KinVolumeMip');
    let request;try{request=jobs.restoreRequest(job.mip,{frameOfReference,volumeId,affine});}catch(_){throw Error(messages.shape);}
    const bound=mip.verifyBinding(request.voiSlab,{volumeId,affine});if(bound)throw Error(bound);
    if(!jobs.intersects(job.mip.voiSlab,corners))throw Error(messages.outside);
    return request;
  }
  // A version 12 frame is its analytic camera only if focal point, position, normal, up and parallel scale all read back within 1e-6
  // (the KinVolumeMipBatch.verifyCamera rule, which a version 13 frame uses itself).
  function verifyCamera(actual,want){
    if(!actual||!want)return messages.frameCamera;
    for(const key of ['focalPoint','position','viewPlaneNormal','viewUp']){const a=vector(actual[key]),b=want[key];if(!a||a.some((n,i)=>!(Math.abs(n-b[i])<=CAMERA_EDGE)))return messages.frameCamera;}
    return finite(actual.parallelScale)&&Math.abs(actual.parallelScale-want.parallelScale)<=CAMERA_EDGE?'':messages.frameCamera;
  }
  /* The depth range of a frame. The voxel-centre corner depths dot(p - c, n) span [D - h0, D + h0]; e is the projected half voxel,
     because the print volume's image extends half a spacing beyond its voxel centres along each unit index axis. The margin m is
     capped at t/2, so a range holding the whole-volume slab always passes, while a range cut inside the box or its half-voxel
     border refuses. A missing, non-finite or empty readback refuses; nothing falls back to another readback. */
  function verifyClip({range,camera,corners,direction:axes,spacing,thickness,distance}={}){
    let values;try{values=Array.from(range);}catch(_){return messages.clip;}
    if(values.length!==2||!values.every(finite)||!(values[0]<values[1]))return messages.clip;
    const n=vector(camera?.viewPlaneNormal),f=vector(camera?.focalPoint),a=(()=>{try{return Array.from(axes);}catch(_){return [];}})(),s=(()=>{try{return Array.from(spacing);}catch(_){return [];}})();
    if(!n||!f||!Array.isArray(corners)||corners.length!==8||a.length!==9||!a.every(finite)||s.length!==3||!s.every(x=>finite(x)&&x>0)||!finite(thickness)||!(thickness>0)||!finite(distance))return messages.clip;
    let h0=0;
    for(const corner of corners){const c=vector(corner);if(!c)return messages.clip;h0=Math.max(h0,Math.abs(dot([f[0]-c[0],f[1]-c[1],f[2]-c[2]],n)));}
    const e=.5*[0,1,2].reduce((sum,k)=>sum+s[k]*Math.abs(dot(n,a.slice(3*k,3*k+3))),0),m=Math.min(h0+e+DEPTH_EDGE,thickness/2);
    return values[0]<=distance-m&&values[1]>=distance+m?'':messages.clip;
  }
  // kin-mip-1 stores only voiRange and interpolationType; the rest of the display is written explicitly and must read back exactly.
  function verifyDisplay(properties){
    if(!object(properties))return messages.display;
    return properties.VOILUTFunction==='LINEAR'&&properties.invert===false&&object(properties.colormap)&&properties.colormap.name==='Grayscale'?'':messages.display;
  }
  const mm=value=>Number(Number(value).toFixed(1));
  const degrees=value=>(value>0?'+':'')+Number(Number(value).toFixed(3))+'°';
  function caption({version,index,count,mode,orientation,axis,angle,voiThickness=null}){
    const slab='VOI Slab '+(voiThickness===null?'Off':mm(voiThickness)+' mm'),size=SIZE+' × '+SIZE;
    if(version===13)return 'Frame '+(index+1)+' / '+count+' · '+mode+' · '+orientation+' · '+axis+' '+degrees(angle)+' · '+slab+' · '+size;
    if(version===12)return 'MIP Viewer · '+mode+' · '+orientation+' · '+slab+' · '+size;
    throw Error(messages.shape);
  }
  // The saved lower~upper range in the MPR print's own figure form; a W/L label would misname these numbers as width and level.
  function displayCaption(voiRange,properties){return 'VOI '+voiRange.lower+' ~ '+voiRange.upper+' ('+properties.VOILUTFunction+') · '+(properties.invert?'Inverted':'Normal grayscale');}
  // The outer print bound: 120 s for version 12, 120 s plus the MIP Batch restore budget (at most 300 s) for version 13. Without a
  // count it is the bound of the largest recipe, which a print arms before it has read its own.
  function timer(version,count){
    if(version===12)return OUTER_MS;
    if(version!==13)throw Error(messages.shape);
    const batch=model('KinVolumeMipBatch');
    return OUTER_MS+batch.budget(count===undefined?batch.limits.count[1]:count);
  }
  // Encoded frames share the 32 MiB page budget of the MPR batch output.
  function bytes(total,size){const next=total+size;if(!finite(total)||!finite(size)||size<0||!(next<=BLOB_BYTES))throw Error(messages.memory);return next;}
  const api=Object.freeze({size:SIZE,outerMs:OUTER_MS,frameMs:FRAME_MS,preRenderMs:PRE_RENDER_MS,blobBytes:BLOB_BYTES,messages,
    supports,saved,direction,plan,frames,bind,verifyCamera,verifyClip,verifyDisplay,caption,displayCaption,timer,bytes});
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumeMipOutput=api;
})(typeof window==='object'?window:globalThis);
