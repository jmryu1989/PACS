window.kinCreateVolumeDisplay=function({target,starting,permitted,alive,services,host}){
  const panel=document.createElement('section');panel.id='kin-volume-display';panel.style.cssText='border-top:1px solid #657c9f;padding:8px 0';
  panel.innerHTML='<strong>MPR Display</strong><p class="target"></p><button type="button">Reset Windowing</button> <button type="button">Reset Zoom / Pan</button><p role="status"></p><p>선택 평면만 조절합니다. Windowing은 원본 기본 밝기·대비로, Zoom / Pan은 이 배치의 Reset Planes와 같은 기준 중심·배율로 돌아갑니다. 현재 단면 깊이·회전·반전·투영 두께와 다른 평면은 유지합니다.</p>';
  host.append(panel);const [windowing,zoom]=panel.querySelectorAll('button'),caption=panel.querySelector('.target'),status=panel.querySelector('[role=status]'),model=window.KinVolumeDisplay;
  let ended=false,busy=false,baseline=null,shown=null;
  const live=()=>{try{return !ended&&alive();}catch(_){return false;}};
  function allowed(t){try{return live()&&permitted()&&!document.hidden&&!window.kinViewerJobWorkspaceState?.().busy&&!window.kinVolumeBatchState?.busy?.()&&!t.views.some(v=>services.cineService.getState().cines?.[v.id]?.isPlaying);}catch(_){return false;}}
  const same=(a,b)=>a?.group===b?.group&&a?.selection===b?.selection&&a?.views.every((v,i)=>v===b.views[i]);
  const sameGroup=t=>baseline?.group===t?.group&&baseline?.viewRefs.every((ref,i)=>ref.deref()===t.views[i]);
  const sameViews=(a,b)=>a?.group===b?.group&&a?.views.every((v,i)=>v===b.views[i]);
  const near=(a,b)=>Array.isArray(a)?Array.isArray(b)&&a.length===b.length&&a.every((n,i)=>near(n,b[i])):typeof a==='number'?Number.isFinite(b)&&Math.abs(a-b)<1e-6:a===b;
  const camerasEqual=(a,b)=>['position','focalPoint','viewUp','viewPlaneNormal','parallelScale','flipHorizontal','flipVertical'].every(k=>near(a[k],b[k]));
  const transfer=v=>v.getActors().find(a=>a.referencedId===v.getVolumeId()).actor.getProperty().getRGBTransferFunction(0);
  const nodes=v=>window.cornerstone.utilities.transferFunctionUtils.getTransferFunctionNodes(transfer(v));
  const opacity=view=>Array.from(view.getActors().find(a=>a.referencedId===view.getVolumeId()).actor.getProperty().getScalarOpacity(0).getDataPointer());
  // getProperties estimates sigmoid W/L from colors and reverses the inferred
  // range for inverted curves. Retain the pinned setter's actual input range.
  const state=view=>({camera:structuredClone(view.getCamera()),properties:structuredClone(view.getProperties()),range:structuredClone(view.viewportProperties?.voiRange||view.getProperties().voiRange),nodes:nodes(view),opacity:opacity(view)});
  const states=t=>t.views.map(state);
  const stateEqual=(a,b)=>camerasEqual(a.camera,b.camera)&&JSON.stringify(a.properties)===JSON.stringify(b.properties)&&JSON.stringify(a.range)===JSON.stringify(b.range)&&near(a.nodes,b.nodes)&&near(a.opacity,b.opacity);
  function selectedWindowing(v,properties){
    const manager=window.cornerstoneTools?.SynchronizerManager;
    if(typeof manager?.getSynchronizersForViewport!=='function'||typeof manager?.getSynchronizer!=='function')throw Error('선택 평면의 밝기 동기화를 확인할 수 없습니다.');
    const groups=manager.getSynchronizersForViewport(v.id,v.renderingEngineId),muted=[];
    try{
      // Native VOI events also update the visible W/L labels. Pause only the
      // currently enabled synchronizers for this synchronous update, retaining
      // native notifications for the selected viewport and restoring ownership.
      for(const group of groups){muted.push(group);group.setEnabled(false);}
      // The pinned native setter changes its LUT-function field after applying
      // the old range. Apply the desired range again under the new function.
      const current=v.getProperties(),oldFunction=current.VOILUTFunction||'LINEAR',nextFunction=properties.VOILUTFunction;
      if(oldFunction!==nextFunction)v.setProperties({VOILUTFunction:nextFunction},v.getVolumeId());
      // Native LINEAR only rescales existing nodes, leaving a sampled sigmoid
      // curve intact. Rebuild its color map before assigning the linear range.
      if(oldFunction==='SIGMOID'&&nextFunction!=='SIGMOID'){
        const cfun=window.cornerstone.utilities.createLinearRGBTransferFunction(properties.voiRange);
        v.getActors().find(a=>a.referencedId===v.getVolumeId()).actor.getProperty().setRGBTransferFunction(0,cfun);
      }
      v.setProperties({voiRange:properties.voiRange},v.getVolumeId());
      // Both native sigmoid construction and colormap replacement create
      // non-inverted nodes, even while the viewport's invert flag stays true.
      if(current.invert&&(nextFunction==='SIGMOID'||oldFunction==='SIGMOID'))v.setInvert(true,v.getVolumeId());
      if(nextFunction==='SIGMOID')window.cornerstone.utilities.triggerEvent(v.element,window.cornerstone.Enums.Events.VOI_MODIFIED,{...v.getVOIModifiedEventDetail(v.getVolumeId()),range:{...properties.voiRange}});
    }finally{for(const group of muted)if(manager.getSynchronizer(group.id)===group)group.setEnabled(true);}
  }
  function refresh(){
    if(ended)return;const t=live()&&target();panel.hidden=!t;
    windowing.disabled=zoom.disabled=true;if(!t)return;
    if(!busy)baseline=starting?.();
    shown=t;caption.textContent=t.source.study.id+' · Plane '+(t.views.findIndex(v=>v.id===t.source.viewportId)+1);
    if(busy||!allowed(t)||!sameGroup(t))return;
    const v=t.views.find(v=>v.id===t.source.viewportId);if(!v)return;
    try{model.resetWindowing(v.getDefaultProperties(v.getVolumeId()));windowing.disabled=false;}catch(_){}
    try{model.resetZoomPan(v.getCamera(),baseline.cameras[t.views.indexOf(v)]);zoom.disabled=false;}catch(_){}
  }
  async function apply(kind){
    if(busy)return;let t,v,before,applied,changed=false;
    try{
      t=target(true);if(!t||!same(t,shown)||!sameGroup(t)||!allowed(t))throw Error('선택한 MPR 평면과 진행 중인 작업을 확인한 뒤 다시 조절하세요.');
      v=t.views.find(view=>view.id===t.source.viewportId);const index=t.views.indexOf(v);if(index<0)throw Error('선택 평면을 확인할 수 없습니다.');
      before=states(t);
      const update=kind==='windowing'?model.resetWindowing(v.getDefaultProperties(v.getVolumeId())):model.resetZoomPan(before[index].camera,baseline.cameras[index]);
      busy=true;status.textContent='선택 평면 표시를 초기화 중입니다.';refresh();changed=true;
      if(kind==='windowing')selectedWindowing(v,update);else v.setCamera(update);
      v.render();applied=states(t);
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('화면 갱신을 확인하지 못했습니다.')),1000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));});
      const after=target(true);if(!same(t,after)||!allowed(after))throw Error('화면이 변경되어 초기화 결과를 확인하지 못했습니다.');
      for(let i=0;i<t.views.length;i++){
        const camera=t.views[i].getCamera(),properties=t.views[i].getProperties();
        if(!near(opacity(t.views[i]),before[i].opacity))throw Error('평면의 불투명도가 변경되어 초기화를 취소했습니다.');
        if(i!==index){if(!stateEqual(state(t.views[i]),before[i]))throw Error('다른 평면의 표시가 변경되어 초기화를 취소했습니다.');continue;}
        if(kind==='windowing'){
          // Native colormap is inferred from curve nodes: sigmoid gray has no
          // preset name, while linear gray matches X Ray. This derived name
          // changes with the LUT; its opacity points must still be preserved.
          const curveChange=before[i].properties.VOILUTFunction==='SIGMOID'||update.VOILUTFunction==='SIGMOID';
          const rest=p=>JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k])=>!['voiRange','VOILUTFunction',...(curveChange?['colormap']:[])].includes(k))));
          let rangeMatches=near(properties.voiRange.lower,update.voiRange.lower)&&near(properties.voiRange.upper,update.voiRange.upper);
          if(update.VOILUTFunction==='SIGMOID'){
            // Native readback estimates and rounds the sigmoid W/L from sampled
            // colors (and reverses it for invert). Verify the actual curve.
            const expected=window.cornerstone.utilities.createSigmoidRGBTransferFunction(update.voiRange);
            try{if(before[i].properties.invert)window.cornerstone.utilities.invertRgbTransferFunction(expected);rangeMatches=near(nodes(v),window.cornerstone.utilities.transferFunctionUtils.getTransferFunctionNodes(expected));}finally{expected.delete();}
          }
          if(!camerasEqual(camera,before[i].camera)||!rangeMatches||(properties.VOILUTFunction||'LINEAR')!==update.VOILUTFunction||rest(properties)!==rest(before[i].properties))throw Error('선택 평면의 밝기·대비를 확인하지 못했습니다.');
        }else if(!camerasEqual(camera,{...before[i].camera,...update})||JSON.stringify(properties)!==JSON.stringify(before[i].properties))throw Error('선택 평면의 확대·이동을 확인하지 못했습니다.');
      }
      status.textContent=kind==='windowing'?'선택 평면의 기본 밝기·대비로 돌아왔습니다.':'현재 단면을 유지하며 초기 확대·이동으로 돌아왔습니다.';
    }catch(error){
      let rollbackFailed=false;
      if(changed&&live())try{
        const now=target();
        if(sameViews(t,now))for(let i=0;i<t.views.length;i++)try{
          const view=t.views[i],current=state(view);
          // A selection change does not retire these viewports. Restore our
          // own applied state, but never overwrite a newer independent edit.
          if(applied&&!stateEqual(current,applied[i]))continue;
          const camera={...before[i].camera};delete camera.rotation;
          if(!camerasEqual(current.camera,camera))view.setCamera(camera);
          if(kind==='windowing'&&(JSON.stringify(current.properties)!==JSON.stringify(before[i].properties)||!near(current.nodes,before[i].nodes)))selectedWindowing(view,model.resetWindowing({...before[i].properties,voiRange:before[i].range}));
          if(kind==='windowing'&&!near(nodes(view),before[i].nodes))window.cornerstone.utilities.transferFunctionUtils.setTransferFunctionNodes(transfer(view),before[i].nodes);
          view.render();
        }catch(_){rollbackFailed=true;}
      }catch(_){rollbackFailed=true;}
      if(live())status.textContent=(error.message||'선택 평면을 초기화하지 못했습니다.')+(rollbackFailed?' 초기화 전 표시를 완전히 복구하지 못했습니다. 현재 표시를 확인하세요.':'');
    }finally{busy=false;refresh();}
  }
  windowing.onclick=()=>apply('windowing');zoom.onclick=()=>apply('zoom');
  const guard=e=>{if(busy&&!panel.contains(e.target)){e.preventDefault();e.stopImmediatePropagation();}};
  for(const name of ['pointerdown','wheel','keydown'])document.addEventListener(name,guard,{capture:true,passive:false});
  const timer=setInterval(refresh,250);refresh();
  return {dispose(){ended=true;clearInterval(timer);panel.remove();for(const name of ['pointerdown','wheel','keydown'])document.removeEventListener(name,guard,true);}};
};
