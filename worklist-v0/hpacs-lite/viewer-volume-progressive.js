window.kinCreateVolumeProgressive=function({target,enabled,permitted,alive,notice=()=>{}}){
  let ended=false,bound=null,active=null,settleTimer=null,frame=0;
  const renderErrors=new Set();
  const live=()=>{try{return !ended&&alive();}catch(_){return false;}};
  const allowed=()=>{try{return live()&&enabled()&&permitted()&&!document.hidden&&!window.kinViewerJobWorkspaceState?.().busy&&!window.kinVolumeBatchState?.busy?.();}catch(_){return false;}};
  function settle(){
    clearTimeout(settleTimer);settleTimer=null;const old=active;active=null;if(!old)return;
    const failed=[];
    for(const state of old){const {view,mapper,before,coarse,label}=state;
      try{
        // A newer renderer setting belongs to its caller, even while dragging.
        if(!mapper.isDeleted()&&mapper.getSampleDistance()===coarse){
          mapper.setSampleDistance(before);
          const restored=mapper.getSampleDistance();
          if(restored!==before){state.coarse=restored;throw Error('Sample distance was not restored');}
        }
        label.remove();
      }catch(_){failed.push(state);label.textContent='Refinement failed';if(view.element.isConnected)view.element.append(label);continue;}
      try{if(view.element.isConnected&&view.getActors().some(a=>a.actor.getMapper()===mapper))view.render();}
      catch(_){label.textContent='Refresh failed';label.className='kin-mpr-render-error';view.element.append(label);renderErrors.add(label);notice('원래 표본 간격은 복구했지만 화면 갱신에 실패했습니다. 영상을 다시 조절해 확인하세요.');}
    }
    if(failed.length){active=failed;notice('원래 렌더링 품질을 복구하지 못했습니다. 영상 표시를 확인하세요. 다시 복구를 시도합니다.');}
    frame++;const mine=frame;requestAnimationFrame(()=>requestAnimationFrame(()=>{if(frame===mine)frame=0;}));
  }
  function begin(){
    if(active||!allowed())return;
    const t=target();if(!t||t.group!==bound?.key)return;
    const states=[];for(const label of renderErrors)label.remove();renderErrors.clear();
    try{
      for(const view of t.views){
        if(view.getSlabThickness()<=.1)continue;
        const mapper=view.getActors()[0].actor.getMapper(),before=mapper.getSampleDistance();
        if(!Number.isFinite(before)||before<=0)throw Error('Invalid native sample distance');
        const coarse=before*3,label=document.createElement('span');label.className='kin-mpr-refining';label.textContent='Preview · refining';label.style.cssText='position:absolute;left:10px;top:135px;color:#fff1d6;background:#102036;padding:2px 5px;pointer-events:none;font-size:12px';
        states.push({view,mapper,before,coarse,label});mapper.setSampleDistance(coarse);view.element.append(label);view.render();
      }
      active=states.length?states:null;
    }catch(_){active=states;settle();if(!active)notice('점진 렌더링을 적용하지 못해 원래 품질로 복귀합니다.');}
  }
  const wheel=()=>{begin();clearTimeout(settleTimer);settleTimer=setTimeout(settle,150);};
  function clear(){settle();if(!bound)return;for(const view of bound.views){view.element.removeEventListener('pointerdown',begin,true);view.element.removeEventListener('wheel',wheel,true);}bound=null;}
  function refresh(){
    if(ended)return;const t=live()&&target();
    if(!allowed()||active?.some(x=>x.label.textContent==='Refinement failed'))settle();
    if(!t){clear();return;}
    if(bound?.key===t.group&&bound.views.every((v,i)=>v===t.views[i]))return;
    clear();bound={key:t.group,views:t.views};
    for(const view of t.views){view.element.addEventListener('pointerdown',begin,{capture:true,passive:true});view.element.addEventListener('wheel',wheel,{capture:true,passive:true});}
  }
  for(const event of ['pointerup','pointercancel','keydown'])document.addEventListener(event,settle,true);
  window.addEventListener('blur',settle);document.addEventListener('visibilitychange',settle);
  const capability={busy:()=>!!active||!!frame,settle};window.kinMprRenderingState=capability;
  const timer=setInterval(refresh,250);refresh();
  return {dispose(){ended=true;clearInterval(timer);clear();for(const label of renderErrors)label.remove();renderErrors.clear();for(const event of ['pointerup','pointercancel','keydown'])document.removeEventListener(event,settle,true);window.removeEventListener('blur',settle);document.removeEventListener('visibilitychange',settle);if(window.kinMprRenderingState===capability)delete window.kinMprRenderingState;}};
};
