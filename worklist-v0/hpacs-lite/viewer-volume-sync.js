window.kinCreateVolumeSync=function({target,permitted,alive,services,host}){
  const panel=document.createElement('section');panel.id='kin-volume-sync';panel.style.cssText='border-top:1px solid #657c9f;padding:8px 0';
  panel.innerHTML='<strong>MPR Synchronization</strong><p class="target"></p><label><input type="checkbox" aria-label="Sync MPR Windowing"> Windowing</label> <label><input type="checkbox" aria-label="Sync MPR Zoom"> Zoom</label><p role="status"></p><p>현재 세 평면에서 이후 조절하는 밝기·대비 또는 기본 맞춤 기준 확대 배율을 함께 적용합니다. 단면 위치·회전·이동·반전은 각각 유지합니다. Reset View 및 Reset Windowing / Reset Zoom / Pan은 대기 중인 동기화를 취소하며 선택 평면만 초기화합니다. 설정은 현재 배치에만 적용됩니다.</p>';
  host.append(panel);const [windowing,zoom]=panel.querySelectorAll('input'),status=panel.querySelector('[role=status]'),caption=panel.querySelector('.target');
  let ended=false,session=null,applying=false,suppressed=0,resizing=0;
  const manager=()=>window.cornerstoneTools.SynchronizerManager;
  const events=()=>window.cornerstone.Enums.Events;
  const same=(a,b)=>a?.group===b?.group&&a?.views.every((v,i)=>v===b.views[i]);
  const live=()=>{try{return !ended&&alive();}catch(_){return false;}};
  const allowed=()=>{try{return live()&&!resizing&&permitted()&&!document.hidden&&!window.kinViewerJobWorkspaceState?.().busy&&!window.kinVolumeBatchState?.busy?.();}catch(_){return false;}};
  const curve=v=>v.getActors().find(a=>a.referencedId===v.getVolumeId()).actor.getProperty().getRGBTransferFunction(0);
  const snapshot=v=>({camera:structuredClone(v.getCamera()),properties:structuredClone(v.getProperties()),range:structuredClone(v.viewportProperties?.voiRange||v.getProperties().voiRange),nodes:window.cornerstone.utilities.transferFunctionUtils.getTransferFunctionNodes(curve(v))});
  function normalizeWindowing(view,range){
    const properties=view.getProperties();if(properties.VOILUTFunction!=='SIGMOID')return;
    // Native mouse W/L rebuilds a non-inverted sigmoid even when invert is
    // still true. Restore the curve, not just that already-true flag, and
    // publish the input range rather than the sampled curve's extent to W/L.
    const utility=window.cornerstone.utilities,expected=utility.createSigmoidRGBTransferFunction(range);
    try{
      if(properties.invert)utility.invertRgbTransferFunction(expected);
      utility.transferFunctionUtils.setTransferFunctionNodes(curve(view),utility.transferFunctionUtils.getTransferFunctionNodes(expected));
    }finally{expected.delete();}
    utility.triggerEvent(view.element,events().VOI_MODIFIED,{...view.getVOIModifiedEventDetail(view.getVolumeId()),range:{...range}});view.render();
  }
  const mounted=s=>{try{
    const cells=[...services.viewportGridService.getState().viewports.keys()];
    return !!s&&cells.length===3&&s.mounts.every(({view,element,volume})=>cells.includes(view.id)&&services.cornerstoneViewportService.getCornerstoneViewport(view.id)===view&&view.element===element&&window.cornerstone.cache.getVolume(view.getVolumeId())===volume);
  }catch(_){return false;}};
  function groups(t){
    const matches=info=>t.views.some(v=>v.id===info.viewportId&&v.renderingEngineId===info.renderingEngineId);
    // This field is part of the pinned Synchronizer implementation. Membership
    // must be wholly within this MPR layout before its VOI group can be muted.
    return manager().getAllSynchronizers().filter(g=>g._eventName===events().VOI_MODIFIED&&[...g.getSourceViewports(),...g.getTargetViewports()].some(matches)).map(g=>{
      if(![...g.getSourceViewports(),...g.getTargetViewports()].every(matches))throw Error('다른 화면과 연결된 밝기 동기화를 먼저 해제하세요.');
      return {group:g,enabled:!g.isDisabled()};
    });
  }
  function clear(){
    const old=session;session=null;if(!old)return;
    for(const [element,name,handler] of old.listeners)element.removeEventListener(name,handler);
    for(const {owner,key,original,hook,own} of (old.resizeHooks||[]).slice().reverse())if(owner[key]===hook){if(own)owner[key]=original;else delete owner[key];}
    for(const {group,enabled} of old.muted)try{if(manager().getSynchronizer(group.id)===group)group.setEnabled(enabled);}catch(_){}
  }
  function attach(t){
    clear();const initial=groups(t);
    const engine=t.views[0].getRenderingEngine();if(t.views.some(v=>v.getRenderingEngine()!==engine))throw Error('같은 영상 엔진의 세 평면을 선택하세요.');
    session={target:t,windowing:initial.some(x=>x.enabled),zoom:false,controlled:true,muted:initial,listeners:[],pending:new Map(),suspended:false,mounts:t.views.map(view=>({view,element:view.element,volume:window.cornerstone.cache.getVolume(view.getVolumeId())})),scales:new Map(t.views.map(v=>[v,v.initialCamera.parallelScale])),zooms:new Map(t.views.map(v=>[v,v.getZoom()]))};
    for(const {group} of initial)group.setEnabled(false);
    const s=session;s.resizeHooks=[];
    // Native resize emits intermediate reset/restore camera events before all
    // fit cameras have settled. OHIF then reapplies every presentation outside
    // the engine resize call. Guard that verified complete service operation.
    const guardResize=(owner,key)=>{
      const original=owner[key];if(typeof original!=='function')throw Error('MPR 화면 크기 변경 경로를 확인할 수 없습니다.');
      const hook=function(...args){
        if(session!==s)return original.apply(this,args);
        resizing++;try{return original.apply(this,args);}finally{
          resizing--;
          if(session===s&&mounted(s))try{for(const v of t.views){s.zooms.set(v,v.getZoom());s.scales.set(v,v.initialCamera.parallelScale);}}catch(_){s.suspended=true;}
        }
      };
      s.resizeHooks.push({owner,key,original,hook,own:Object.hasOwn(owner,key)});owner[key]=hook;
    };
    guardResize(services.cornerstoneViewportService,'performResize');
    // Native download/magnifier use the public engine entry directly.
    guardResize(engine,'resize');
    for(const view of t.views)for(const key of ['resetProperties','resetCamera']){
      const original=view[key];if(typeof original!=='function')throw Error('선택 평면의 초기화 경로를 확인할 수 없습니다.');
      const hook=function(...args){return session===s?capability.selected(()=>original.apply(this,args)):original.apply(this,args);};
      s.resizeHooks.push({owner:view,key,original,hook,own:Object.hasOwn(view,key)});view[key]=hook;
    }
    for(const v of t.views)for(const [name,kind] of [[events().VOI_MODIFIED,'windowing'],[events().CAMERA_MODIFIED,'zoom']]){
      const handler=e=>{
        if(kind==='zoom'){propagate(v,kind,e);return;}
        if(e.detail?.invertStateChanged)return;
        const s=session;if(!s||applying||suppressed||!s.controlled||!s.windowing||!allowed()||!same(s.target,target()))return;
        // The pinned native setter emits VOI_MODIFIED before assigning its
        // input range. Its event range is only the curve extent for SIGMOID.
        // Read the final input after the setter returns; discard queued work
        // on selected resets, replacement, or another event from this source.
        const token={};s.pending.set(v,token);const element=e.currentTarget;
        queueMicrotask(()=>{if(session!==s||s.pending.get(v)!==token)return;s.pending.delete(v);propagate(v,kind,{currentTarget:element});});
      };v.element.addEventListener(name,handler);session.listeners.push([v.element,name,handler]);
    }
  }
  function propagate(source,kind,event){
    const s=session;if(!s)return;
    if(!live()||!same(s.target,target())||event.currentTarget!==source.element||!s.target.views.includes(source))return;
    const oldZoom=s.zooms.get(source),newZoom=source.getZoom();s.zooms.set(source,newZoom);
    const oldScale=s.scales.get(source),newScale=source.initialCamera.parallelScale;s.scales.set(source,newScale);
    // Resize recalculates native fit cameras. That is not a user's zoom input.
    if(kind==='zoom'&&oldScale!==newScale)return;
    if(applying||suppressed||!s.controlled||!s[kind]||!allowed()||!same(s.target,target())||event.currentTarget!==source.element||!s.target.views.includes(source))return;
    if(kind==='zoom'&&Math.abs(newZoom-oldZoom)<1e-8)return;
    let before=[];
    try{
      const peers=s.target.views.filter(v=>v!==source);before=peers.map(v=>[v,snapshot(v)]);applying=true;
      const range=source.viewportProperties?.voiRange||event.detail?.range||source.getProperties().voiRange;
      if(kind==='windowing'&&(!Number.isFinite(range?.lower)||!Number.isFinite(range?.upper)||range.lower>=range.upper))throw Error('밝기 범위를 확인할 수 없습니다.');
      if(kind==='zoom'&&(!Number.isFinite(newZoom)||newZoom<=0))throw Error('확대 배율을 확인할 수 없습니다.');
      if(kind==='windowing')normalizeWindowing(source,range);
      for(const [v,state] of before){
        if(s!==session||!allowed()||!same(s.target,target()))throw Error('MPR 배치 또는 권한이 변경되어 동기화를 중단했습니다.');
        if(kind==='zoom')v.setZoom(newZoom);
        else{
          v.setProperties({voiRange:{...range}},v.getVolumeId());
          normalizeWindowing(v,range);
        }
        s.zooms.set(v,v.getZoom());v.render();
      }
    }catch(error){
      let failed=before.length>0&&!(s===session&&live()&&same(s.target,target()));
      if(!failed)for(const [v,state] of before)try{
        if(s!==session||!live()||!same(s.target,target())){failed=true;break;}
        if(kind==='zoom'){const c={...state.camera};delete c.rotation;v.setCamera(c);}
        else{v.setProperties({voiRange:state.range},v.getVolumeId());window.cornerstone.utilities.transferFunctionUtils.setTransferFunctionNodes(curve(v),state.nodes);}
        s.zooms.set(v,v.getZoom());v.render();
      }catch(_){failed=true;}
      s[kind]=false;status.textContent='동기화를 중단했습니다. '+(error.message||'표시를 확인하세요.')+(failed?' 이전 표시를 완전히 복구하지 못했습니다.':'');
    }finally{applying=false;refresh();}
  }
  function change(kind,value){
    try{
      const t=target(true);if(!allowed()||!same(session?.target,t))throw Error('현재 MPR 배치와 진행 중인 작업을 확인하세요.');
      session[kind]=value;status.textContent='현재 배치의 이후 조절에 동기화 설정을 적용했습니다.';
    }catch(error){if(!live()||!mounted(session))clear();status.textContent=error.message||'동기화 설정을 적용하지 못했습니다.';}
    refresh();
  }
  function refresh(){
    if(ended)return;
    const t=live()&&target();panel.hidden=!t;windowing.disabled=zoom.disabled=true;
    if(!t){if(!live()||!mounted(session))clear();else{session.suspended=true;session.pending.clear();}return;}
    try{
      if(!same(session?.target,t)||!mounted(session))attach(t);
      if(session.suspended){session.zooms=new Map(t.views.map(v=>[v,v.getZoom()]));session.scales=new Map(t.views.map(v=>[v,v.initialCamera.parallelScale]));session.suspended=false;}
      windowing.checked=session.windowing;zoom.checked=session.zoom;
      caption.textContent=t.source.study.id+' · Three Planes';windowing.disabled=zoom.disabled=!allowed();
    }catch(error){clear();status.textContent=error.message||'동기화 대상을 확인하지 못했습니다.';}
  }
  windowing.onchange=()=>change('windowing',windowing.checked);zoom.onchange=()=>change('zoom',zoom.checked);
  const capability={selected(operation){session?.pending.clear();suppressed++;try{return operation();}finally{suppressed--;}},read(){return session?{windowing:session.windowing,zoom:session.zoom}:null;},apply(value){
    try{if(!allowed()||!same(session?.target,target(true))||typeof value?.windowing!=='boolean'||typeof value?.zoom!=='boolean')return false;
      session.pending.clear();session.windowing=value.windowing;session.zoom=value.zoom;refresh();return true;
    }catch(_){return false;}
  }};
  window.kinVolumeSynchronization=capability;const timer=setInterval(refresh,250);refresh();
  return {dispose(){ended=true;clearInterval(timer);clear();if(window.kinVolumeSynchronization===capability)delete window.kinVolumeSynchronization;panel.remove();}};
};
