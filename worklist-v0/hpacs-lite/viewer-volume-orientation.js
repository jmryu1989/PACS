window.kinCreateVolumeOrientation=function({services,selected,live,allowed=live,owner=()=>null,host}){
  const panel=document.createElement('section');panel.id='kin-volume-orientation';panel.style.cssText='border-top:1px solid #657c9f;padding:8px 0';
  panel.innerHTML='<strong>MPR Orientation</strong><p class="target"></p><label>Axis <select aria-label="MPR Rotation Axis"><option value="0">Patient L/R</option><option value="1">Patient A/P</option><option value="2">Patient H/F</option></select></label> <label>Degrees <input type="number" aria-label="MPR Rotation Degrees" min="-180" max="180" step="5" value="15" style="width:80px"></label> <button type="button">Rotate Three Planes</button> <button type="button">Reset Planes</button><p role="status"></p><p>세 평면의 교점을 유지해 회전합니다. Reset Planes는 이 배치에서 시작한 방향·위치·확대로 돌아갑니다. Save New Job으로 표시를 저장할 수 있습니다.</p>';
  host.append(panel);
  const axis=panel.querySelector('select'),degrees=panel.querySelector('input'),[rotate,reset]=panel.querySelectorAll('button'),status=panel.querySelector('[role=status]'),caption=panel.querySelector('.target');
  const model=window.KinVolumeOrientation,volumeKeys=new WeakMap(),readyRepairs=new WeakMap();let nextVolume=0,ended=false,busy=false,shown='',baseline=null;
  const alive=()=>{try{return !ended&&live();}catch(_){return false;}};
  const permitted=()=>{try{return alive()&&allowed();}catch(_){return false;}};
  const workspaceBusy=()=>{try{return !!window.kinViewerJobWorkspaceState?.().busy;}catch(_){return true;}};
  const same=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((n,i)=>Number.isFinite(Number(n))&&Math.abs(Number(n)-Number(b[i]))<.001);
  function target(verify=false,readOnly=false){
    if(!alive())return null;
    try{
      const source=selected();if(source?.kind!=='volume')return null;
      const grid=services.viewportGridService.getState(),cells=[...grid.viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x);
      if(cells.length!==3||!cells.some(c=>c.viewportId===source.viewportId))return null;
      const views=cells.map(c=>services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId));
      if(views.some(v=>v?.type!=='orthographic'||v.getActors().length!==1))return null;
      const volume=cornerstone.cache.getVolume(views[0].getVolumeId());
      if(!volume?.loadStatus?.loaded||volume.framesLoaded!==volume.imageIds?.length||volume.imageIds.length>256||volume.imageIds.length<2||views.some(v=>cornerstone.cache.getVolume(v.getVolumeId())!==volume))return null;
      if(cells.some(c=>c.displaySetInstanceUIDs?.length!==1||services.displaySetService.getDisplaySetByUID(c.displaySetInstanceUIDs[0])?.StudyInstanceUID!==source.uid||services.displaySetService.getDisplaySetByUID(c.displaySetInstanceUIDs[0])?.SeriesInstanceUID!==source.series||services.displaySetService.getDisplaySetByUID(c.displaySetInstanceUIDs[0])?.Modality!=='CT'))return null;
      if(views.some((v,i)=>{const c=v.getCanvas();return !c?.clientWidth||!c?.clientHeight||Math.abs(c.width-Math.floor(c.clientWidth*devicePixelRatio))>1||Math.abs(c.height-Math.floor(c.clientHeight*devicePixelRatio))>1;}))return null;
      if(cells.some(c=>!c.isReady)){
        if(!permitted()||workspaceBusy())return null;
        // The pinned grid resets isReady during layout changes, but React can
        // retain the enabled viewport without another onElementEnabled callback.
        // Restore that element-readiness flag only for the actual current native
        // renderer after the complete volume/source and canvas checks above.
        for(let i=0;i<views.length;i++)if(!cells[i].isReady){
          const v=views[i];if(!v.element.isConnected||cornerstone.getEnabledElement(v.element)?.viewport!==v)return null;
          if(readyRepairs.get(v)!==cells[i]){services.viewportGridService.setViewportIsReady(v.id,true);readyRepairs.set(v,cells[i]);}
        }
        return null;
      }
      if(verify){
        if(readOnly!==true&&!permitted())throw Error('다른 작업을 마친 뒤 MPR 방향을 조절하세요.');
        if(volume.imageIds.length!==volume.dimensions?.[2])throw Error('MPR 원본 프레임 수를 확인할 수 없습니다.');
        for(let i=0;i<volume.imageIds.length;i++){
          const m=cornerstone.metaData.get('instance',volume.imageIds[i]);
          if(m?.SOPClassUID!=='1.2.840.10008.5.1.4.1.1.2'||m.Modality!=='CT'||Number(m.SamplesPerPixel)!==1||m.PhotometricInterpretation!=='MONOCHROME2'||Number(m.Rows)!==volume.dimensions[1]||Number(m.Columns)!==volume.dimensions[0]||!same(m.PixelSpacing,[volume.spacing[1],volume.spacing[0]])||!same(m.ImagePositionPatient,Array.from(volume.imageData.indexToWorld([0,0,i])))||!same(m.ImageOrientationPatient,Array.from(volume.direction).slice(0,6)))throw Error('정규 CT 원본 좌표를 확인한 뒤 회전하세요.');
        }
      }
      if(!volumeKeys.has(volume))volumeKeys.set(volume,++nextVolume);
      return {source,views,cameras:views.map(v=>v.getCamera()),group:JSON.stringify([cells.map(c=>c.viewportId),volumeKeys.get(volume),source.sourceSignature]),selection:JSON.stringify([source.viewportId,source.selectionEpoch])};
    }catch(error){if(verify)throw error;return null;}
  }
  function refresh(){
    if(ended)return;
    const t=target();let eligible=false;
    try{const g=services.viewportGridService.getState();eligible=g.viewports.size===3&&services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId)?.type==='orthographic';}catch(_){}
    panel.hidden=!alive()||!eligible;
    rotate.disabled=reset.disabled=axis.disabled=degrees.disabled=busy||workspaceBusy()||!t||!permitted();
    if(!t){shown='';caption.textContent='완전히 로드된 단일 정규 CT의 3평면을 선택하세요.';return;}
    shown=t.selection;
    try{
      const point=model.intersection(t.cameras);
      if(!workspaceBusy()&&(!baseline||baseline.group!==t.group||baseline.viewRefs.some((ref,i)=>ref.deref()!==t.views[i])))baseline={group:t.group,cameras:structuredClone(t.cameras),viewRefs:t.views.map(v=>new WeakRef(v))};
      caption.textContent=t.source.study.id+' · Center L/P/H (mm): '+point.map(n=>Number(n.toFixed(3))).join(' / ');
    }catch(error){rotate.disabled=true;reset.disabled=busy||workspaceBusy()||!permitted()||baseline?.group!==t.group;caption.textContent=error.message;}
  }
  const setCamera=(v,camera)=>{v.setCamera({flipHorizontal:camera.flipHorizontal,flipVertical:camera.flipVertical});const next={...camera};delete next.rotation;delete next.flipHorizontal;delete next.flipVertical;v.setCamera(next);v.render();};
  async function apply(starting){
    if(busy)return;
    let t,before,changed=false;
    try{
      t=target(true);if(!t||workspaceBusy()||t.selection!==shown)throw Error('선택한 MPR 평면이 바뀌었습니다. 대상을 확인하고 다시 적용하세요.');
      const angle=Number(degrees.value),index=Number(axis.value);
      if(!starting&&(!degrees.value.trim()||![0,1,2].includes(index)||!Number.isFinite(angle)||Math.abs(angle)>180))throw Error('회전축과 -180~180도 범위의 각도를 입력하세요.');
      if(starting&&(baseline?.group!==t.group||baseline.viewRefs.some((ref,i)=>ref.deref()!==t.views[i])))throw Error('이 배치의 시작 화면을 확인할 수 없습니다.');
      const next=starting?structuredClone(baseline.cameras):model.rotate(t.cameras,[0,1,2].map(i=>i===index?1:0),angle);
      before=t.cameras;busy=true;status.textContent='MPR 방향을 적용 중입니다.';refresh();changed=true;
      t.views.forEach((v,i)=>setCamera(v,next[i]));
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const after=target(true);if(!after||after.group!==t.group||after.selection!==t.selection)throw Error('화면이 변경되어 회전 결과를 확인하지 못했습니다.');
      for(let i=0;i<3;i++)for(const key of ['position','focalPoint','viewUp','viewPlaneNormal'])if(!same(after.cameras[i][key],next[i][key]))throw Error('MPR 방향을 확인하지 못했습니다.');
      model.intersection(after.cameras);status.textContent=starting?'시작 MPR 화면으로 돌아왔습니다.':'세 평면을 '+angle+'도 회전했습니다. 원본과 판독문은 그대로입니다.';
    }catch(error){
      if(changed&&alive())try{const current=target();if(current?.group===t.group&&current.selection===t.selection)t.views.forEach((v,i)=>setCamera(v,before[i]));}catch(_){}
      if(alive())status.textContent=error.message||'MPR 방향을 적용하지 못했습니다.';
    }finally{busy=false;refresh();}
  }
  rotate.onclick=()=>apply(false);reset.onclick=()=>apply(true);
  const guard=e=>{if(busy&&!panel.contains(e.target)){e.preventDefault();e.stopImmediatePropagation();}};
  for(const name of ['pointerdown','wheel','keydown'])document.addEventListener(name,guard,{capture:true,passive:false});
  const timer=setInterval(refresh,500);refresh();
  const crosshair=window.KinVolumeCrosshair&&window.kinCreateVolumeCrosshair?.({target,permitted,alive,host});
  const display=window.KinVolumeDisplay&&window.kinCreateVolumeDisplay?.({target,starting:()=>baseline,permitted:()=>!busy&&permitted(),alive,services,host});
  const synchronization=window.kinCreateVolumeSync?.({target,permitted:()=>!busy&&permitted(),alive,services,host});
  const preferences=window.KinVolumePreferences&&window.kinCreateVolumePreferences?.({target,permitted:()=>!busy&&permitted(),alive,owner,services,host});
  const progressive=window.kinCreateVolumeProgressive?.({target,enabled:()=>window.kinMprPreferences?.read()?.progressive===true,permitted:()=>!busy&&permitted(),alive,notice:text=>window.kinMprPreferences?.notice(text)});
  const marks=window.KinVolumeMarks&&window.kinCreateVolumeMarks?.({target,permitted:()=>!busy&&permitted(),alive,owner,host});
  const batch=window.KinVolumeBatch&&window.kinCreateVolumeBatch?.({target,permitted:()=>!busy&&permitted(),alive,owner,host});
  const vrButton=document.createElement('button');vrButton.textContent='Open Volume Rendering';panel.append(vrButton);let vr=null,vrLoading=false;
  vrButton.onclick=async()=>{
    if(vrLoading||!alive()||busy||!permitted()||workspaceBusy())return;vrLoading=true;vrButton.disabled=true;
    try{
      for(const [name,file] of [['KinVolumeRendering','volume-rendering.js'],['KinVolumeSculpt','volume-sculpt.js'],['KinVolumeMaskRenderer','volume-mask-renderer.js'],['kinCreateVolumeSculpt','viewer-volume-sculpt.js'],['kinCreateVolumeRendering','viewer-volume-rendering.js']])if(!window[name])await new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src='/worklist/hpacs-lite/'+file;let finished=false;
        const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);script.onload=script.onerror=null;script.remove();error?reject(error):resolve();};
        const timer=setTimeout(()=>finish(Error('VR 도구를 불러오지 못했습니다. 다시 누르세요.')),30000);
        script.onload=()=>finish(window[name]?null:Error('VR 도구를 확인하지 못했습니다.'));script.onerror=()=>finish(Error('VR 도구를 불러오지 못했습니다. 다시 누르세요.'));document.head.append(script);
      });
      if(!alive())return;vr||=window.kinCreateVolumeRendering({target,permitted:()=>!busy&&permitted(),alive,owner,notice:message=>{if(alive())status.textContent=message;}});await vr.open();
    }catch(error){if(alive())status.textContent=error.message;}finally{vrLoading=false;vrButton.disabled=!alive();}
  };
  const cineTarget=(v,verify=false)=>{if(verify&&(busy||!permitted()))throw Error('다른 작업을 마친 뒤 MPR을 재생하세요.');const t=target(verify);if(!t||t.source.viewportId!==v?.id||!t.views.includes(v))return null;return {key:JSON.stringify([t.group,t.selection]),contentKey:JSON.stringify([t.group,v.id]),allowed:!busy&&permitted(),volume:cornerstone.cache.getVolume(v.getVolumeId())};};
  window.kinGetVolumeCineTarget=cineTarget;
  return {dispose(){ended=true;vr?.dispose();if(window.kinGetVolumeCineTarget===cineTarget){delete window.kinGetVolumeCineTarget;window.dispatchEvent(new Event('kin-volume-cine-target-ended'));}batch?.dispose();marks?.dispose();progressive?.dispose();preferences?.dispose();synchronization?.dispose();display?.dispose();crosshair?.dispose();clearInterval(timer);panel.remove();for(const name of ['pointerdown','wheel','keydown'])document.removeEventListener(name,guard,true);}};
};
