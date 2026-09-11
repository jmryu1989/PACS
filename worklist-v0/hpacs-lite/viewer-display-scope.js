(function(root){
  'use strict';
  const CT='1.2.840.10008.5.1.4.1.1.2';
  const uid=value=>typeof value==='string'&&value.length<=64&&/^\d+(?:\.\d+)+$/.test(value);
  const copy=value=>typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value));
  function create(services,options={}){
    const grid=services?.viewportGridService,cornerstone=services?.cornerstoneViewportService,sets=services?.displaySetService;
    const objectIds=new WeakMap();let nextObject=0,mode='active',chosen=new Set(),baseline=null,ended=false,panel=null,status=null,subscriptions=[],channel=null,listening=false;
    const objectId=value=>{if(!value||!['object','function'].includes(typeof value))return String(value);if(!objectIds.has(value))objectIds.set(value,++nextObject);return objectIds.get(value);};
    const ordered=()=>[...(grid?.getState?.().viewports?.values?.()||[])].sort((a,b)=>(a.y??0)-(b.y??0)||(a.x??0)-(b.x??0)||String(a.viewportId).localeCompare(String(b.viewportId)));
    const metadata=imageId=>options.metadata?options.metadata(imageId):root.cornerstone?.metaData?.get?.('instance',imageId);
    function source(view){
      const ids=view?.displaySetInstanceUIDs||[],viewport=ids.length===1&&cornerstone?.getCornerstoneViewport?.(view.viewportId),displaySet=ids.length===1&&sets?.getDisplaySetByUID?.(ids[0]);
      const imageIds=viewport?.getImageIds?.(),current=viewport?.getCurrentImageId?.();
      if(ids.length!==1||viewport?.type!=='stack'||displaySet?.Modality!=='CT'||displaySet?.SOPClassUID!==CT||!uid(displaySet.StudyInstanceUID)||!uid(displaySet.SeriesInstanceUID)||!Array.isArray(imageIds)||!imageIds.length||!imageIds.includes(current))return null;
      for(const imageId of imageIds){const item=metadata(imageId);if(!item||item.SOPClassUID!==CT||item.StudyInstanceUID!==displaySet.StudyInstanceUID||item.SeriesInstanceUID!==displaySet.SeriesInstanceUID||!uid(item.SOPInstanceUID))return null;}
      const currentItem=metadata(current);if(!currentItem||!uid(currentItem.SOPInstanceUID))return null;
      const result={id:view.viewportId,view,viewport,displaySet,imageIds:[...imageIds],current,currentSop:currentItem.SOPInstanceUID};
      if(options.validateStack&&options.validateStack(result)!==true)return null;
      return result;
    }
    function signature(){
      const state=grid?.getState?.(),layout=state?.layout||{},views=ordered();
      return JSON.stringify([layout.layoutType,layout.numRows,layout.numCols,views.map(view=>{const ids=view.displaySetInstanceUIDs||[],viewport=cornerstone?.getCornerstoneViewport?.(view.viewportId),displaySet=ids.length===1&&sets?.getDisplaySetByUID?.(ids[0]);return [objectId(view),view.viewportId,view.x,view.y,view.width,view.height,ids,objectId(viewport),objectId(displaySet),displaySet?.StudyInstanceUID,displaySet?.SeriesInstanceUID,displaySet?.SOPInstanceUID,displaySet?.SOPClassUID,displaySet?.Modality,viewport?.getImageIds?.()||[]];})]);
    }
    function note(message){if(status)status.textContent=message;return message;}
    function resetForSource(message){mode='active';chosen.clear();try{baseline=signature();}catch(_){baseline=null;}try{refreshUi();}catch(_){ }if(message)note(message);}
    function fresh(){const next=signature();if(baseline===null){baseline=next;return true;}if(next!==baseline){resetForSource('화면 또는 원본이 변경되어 표시 범위를 Active로 되돌렸습니다.');return false;}return true;}
    function idsForMode(){const state=grid?.getState?.(),all=ordered().map(view=>view.viewportId);if(mode==='all')return all;if(mode==='set')return all.filter(id=>chosen.has(id));return state?.activeViewportId?[state.activeViewportId]:[];}
    function selection(){fresh();return {mode,ids:idsForMode()};}
    function setMode(value){if(!['active','set','all'].includes(value))return false;fresh();mode=value;if(value==='active')chosen.clear();refreshUi();return true;}
    function setSelection(ids){fresh();const all=new Set(ordered().map(view=>view.viewportId));if(!Array.isArray(ids)||ids.some(id=>!all.has(id)))return false;chosen=new Set(ids);mode='set';refreshUi();return true;}
    function invertSelection(){fresh();const all=ordered().map(view=>view.viewportId),selected=new Set(idsForMode());chosen=new Set(all.filter(id=>!selected.has(id)));mode='set';refreshUi();return [...chosen];}
    function toggleCell(id,checked,expected=baseline,expectedView=null){
      const currentView=grid?.getState?.().viewports?.get?.(id);
      if(ended||expected!==baseline||signature()!==expected||expectedView&&currentView!==expectedView){resetForSource('화면 또는 원본이 변경되어 표시 범위를 Active로 되돌렸습니다.');return false;}
      const all=new Set(ordered().map(view=>view.viewportId));if(!all.has(id))return false;
      if(mode!=='set')chosen=new Set(idsForMode());checked?chosen.add(id):chosen.delete(id);mode='set';refreshUi();return true;
    }
    function capabilities(viewport,action){
      if(!['getCamera','setCamera','getProperties','setProperties','render'].every(name=>typeof viewport[name]==='function'))return false;
      const functions={rotate:['getViewPresentation','setViewPresentation','render'],flipH:['getCamera','setCamera','render'],flipV:['getCamera','setCamera','render'],invert:['getProperties','setProperties','render'],fit:['getCamera','resetCamera','render'],reset:['getCamera','getProperties','resetCamera','setCamera','setProperties','setVOI','render'],window:['getProperties','setVOI','render']}[action];
      if(action==='reset'&&typeof viewport.resetProperties!=='function')return false;
      return functions?.every(name=>typeof viewport[name]==='function');
    }
    function snapshot(item){return {camera:copy(item.viewport.getCamera()),properties:copy(item.viewport.getProperties()),presentation:typeof item.viewport.getViewPresentation==='function'?copy(item.viewport.getViewPresentation()):null,source:key(item)};}
    const key=item=>item?JSON.stringify([item.id,objectId(item.viewport),objectId(item.displaySet),item.displaySet.StudyInstanceUID,item.displaySet.SeriesInstanceUID,item.current,item.currentSop,item.imageIds]):null;
    function restore(item,saved,action){
      try{
        const view=grid?.getState?.().viewports?.get?.(item.id),now=view&&source(view);if(!now||key(now)!==saved.source)return false;
        const viewport=now.viewport,properties=copy(saved.properties);let exact=true;
        if(action==='invert')viewport.setProperties({invert:properties.invert});
        else if(action==='window'){
          const colormap=properties.colormap;if(properties.isComputedVOI){viewport.resetProperties();const defined={...properties};delete defined.voiRange;delete defined.isComputedVOI;delete defined.colormap;if(colormap===undefined)exact=false;viewport.setProperties(defined);viewport.setVOI(copy(properties.voiRange),{forceRecreateLUTFunction:true,voiUpdatedWithSetProperties:false});}
          else viewport.setVOI(copy(properties.voiRange),{forceRecreateLUTFunction:true,voiUpdatedWithSetProperties:true});
          if(colormap!==undefined)viewport.setProperties({colormap});
        }else if(action==='reset'){
          const colormap=properties.colormap,defined={...properties};delete defined.voiRange;delete defined.isComputedVOI;delete defined.colormap;viewport.setProperties(defined);viewport.setVOI(copy(properties.voiRange),{forceRecreateLUTFunction:true,voiUpdatedWithSetProperties:true});viewport.setProperties({colormap});
        }
        if(['flipH','flipV','fit','reset'].includes(action)){const camera=copy(saved.camera),flips={flipHorizontal:camera.flipHorizontal,flipVertical:camera.flipVertical};delete camera.flipHorizontal;delete camera.flipVertical;delete camera.rotation;viewport.setCamera(flips);viewport.setCamera(camera);}
        if(['rotate','reset'].includes(action)&&saved.presentation&&typeof viewport.setViewPresentation==='function')viewport.setViewPresentation(copy(saved.presentation));viewport.render();return exact;
      }catch(_){return false;}
    }
    function mutate(item,action,value){
      const viewport=item.viewport;
      if(action==='rotate'){const presentation=viewport.getViewPresentation(),rotation=Number(presentation.rotation)||0;viewport.setViewPresentation({...presentation,rotation:(rotation+value+360)%360});}
      else if(action==='flipH'){const camera=viewport.getCamera();viewport.setCamera({flipHorizontal:!camera.flipHorizontal});}
      else if(action==='flipV'){const camera=viewport.getCamera();viewport.setCamera({flipVertical:!camera.flipVertical});}
      else if(action==='invert'){const properties=viewport.getProperties();viewport.setProperties({invert:!properties.invert});}
      else if(action==='fit')viewport.resetCamera();
      else if(action==='reset'){viewport.resetProperties?.();viewport.resetCamera();}
      else if(action==='window')viewport.setProperties({voiRange:value});
      viewport.render();
    }
    function apply(action,value){
      if(ended)return {ok:false,message:note('표시 범위 연결이 종료되었습니다.')};let before,wanted,views;try{fresh();before=signature();wanted=idsForMode();views=new Map(ordered().map(view=>[view.viewportId,view]));}catch(error){return {ok:false,message:note((error.message||'원본 표시 상태를 확인할 수 없습니다.')+' 적용 전에 중단했습니다.')}}
      if(action==='rotate'&&![-90,90].includes(value))return {ok:false,message:note('회전은 -90 또는 +90만 적용할 수 있습니다.')};
      if(!wanted.length)return {ok:false,message:note('적용할 화면을 선택하세요.')};if(views.size<1||views.size>4)return {ok:false,message:note('Display Scope는 현재 1~4개 화면에서 사용할 수 있습니다.')};
      let targets;try{targets=wanted.map(id=>source(views.get(id)));}catch(error){return {ok:false,message:note((error.message||'원본 표시 상태를 확인할 수 없습니다.')+' 적용 전에 중단했습니다.')}}
      if(targets.some(item=>!item)||targets.some(item=>!capabilities(item.viewport,action)))return {ok:false,message:note('선택 범위 전체가 원본이 확인된 일반 CT 스택이어야 합니다. 빈 화면·혼합 영상에는 적용하지 않았습니다.')};
      let operationValue=value;
      if(action==='window'){
        const numeric=input=>(typeof input==='number'||typeof input==='string'&&input.trim()!=='')&&Number.isFinite(Number(input)),width=Number(value?.width),center=Number(value?.center),converter=options.toLowHighRange||root.cornerstone?.utilities?.windowLevel?.toLowHighRange;
        if(!numeric(value?.width)||width<1||!numeric(value?.center)||typeof converter!=='function')return {ok:false,message:note('W/L은 WW>=1, 유효한 WC로 입력하세요.')};
        try{operationValue=converter(width,center);}catch(_){return {ok:false,message:note('W/L 범위를 확인할 수 없습니다.')};}if(!Number.isFinite(operationValue?.lower)||!Number.isFinite(operationValue?.upper)||operationValue.lower>operationValue.upper)return {ok:false,message:note('W/L 범위를 확인할 수 없습니다.')};
      }
      let saved;try{saved=targets.map(item=>[item,snapshot(item)]);}catch(error){return {ok:false,message:note((error.message||'표시 상태를 확인할 수 없습니다.')+' 적용 전에 중단했습니다.')}}const attempted=[];
      if(action==='reset'&&saved.some(([,state])=>!state.properties?.colormap||typeof state.properties.colormap!=='object'||![0,1,2].includes(state.properties?.interpolationType)||typeof state.properties?.invert!=='boolean'||state.properties?.isComputedVOI!==false||!Number.isFinite(state.properties?.voiRange?.lower)||!Number.isFinite(state.properties?.voiRange?.upper)))return {ok:false,message:note('현재 표시 속성은 Reset 실패 시 공개 API로 정확히 복구할 수 없어 적용하지 않았습니다.')};
      if(action==='window'&&saved.some(([item,state])=>state.properties?.isComputedVOI===true&&typeof item.viewport.resetProperties!=='function'))return {ok:false,message:note('현재 자동 W/L 상태는 실패 시 공개 API로 복구할 수 없어 적용하지 않았습니다.')};
      try{
        for(const item of targets){const view=grid?.getState?.().viewports?.get?.(item.id),now=view&&source(view);if(signature()!==before||!now||key(now)!==key(item))throw Error('적용 중 화면 원본이 변경되었습니다.');attempted.push(item);mutate(item,action,operationValue);const afterView=grid?.getState?.().viewports?.get?.(item.id),after=afterView&&source(afterView);if(signature()!==before||!after||key(after)!==key(item))throw Error('적용 중 화면 원본이 변경되었습니다.');}
        return {ok:true,count:targets.length,message:note(`${targets.length}개 CT 화면에 표시 조작을 적용했습니다.`)};
      }catch(error){
        let restored=true;for(const [item,state] of saved.slice(0,attempted.length).reverse())if(!restore(item,state,action))restored=false;
        let stable=false;try{stable=signature()===before;}catch(_){ }if(!stable)resetForSource();
        const message=(error.message||'표시 조작에 실패했습니다.')+(restored&&stable?' 이전 표시로 복구했습니다.':' 일부 표시를 안전하게 복구하지 못했습니다. 새 원본은 변경하지 않았습니다.');
        return {ok:false,partial:!(restored&&stable),message:note(message)};
      }
    }
    function refreshUi(){
      if(!panel)return;const views=ordered();panel.querySelectorAll('[data-scope-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.scopeMode===mode)));
      const list=panel.querySelector('[data-scope-cells]');list.replaceChildren();const token=baseline;views.slice(0,4).forEach((view,index)=>{const label=root.document.createElement('label'),input=root.document.createElement('input');input.type='checkbox';input.checked=mode==='all'||mode==='active'&&grid.getState().activeViewportId===view.viewportId||mode==='set'&&chosen.has(view.viewportId);input.onchange=()=>{if(!input.isConnected||!panel?.contains(input))return;toggleCell(view.viewportId,input.checked,token,view);};label.append(input,` ${String.fromCharCode(65+index)}`);list.append(label);});
    }
    function mount(host=options.host||root.document?.querySelector?.('#kin-viewer-layout')){
      if(ended||panel||!host)return false;panel=root.document.createElement('section');panel.id='kin-display-scope';panel.style.cssText='border-top:1px solid #657c9f;margin-top:8px;padding-top:8px';
      panel.innerHTML='<strong>Display Scope</strong><p>표시 조작 범위를 고릅니다. Set의 선택 반전과 Invert Images는 서로 다른 기능입니다.</p><div><button type="button" data-scope-mode="active">Active</button> <button type="button" data-scope-mode="set">Set</button> <button type="button" data-scope-mode="all">All</button> <button type="button" data-scope-invert>Invert Selection</button></div><div data-scope-cells></div><div><button type="button" data-action="rotate-left">Rotate -90</button> <button type="button" data-action="rotate-right">Rotate +90</button> <button type="button" data-action="flipH">Flip H</button> <button type="button" data-action="flipV">Flip V</button> <button type="button" data-action="invert">Invert Images</button> <button type="button" data-action="fit">Fit</button> <button type="button" data-action="reset">Reset Display</button></div><div><label>WW (>=1) <input data-ww type="number" min="1" step="any"></label> <label>WC <input data-wc type="number" step="any"></label> <button type="button" data-window>Apply W/L</button></div><p role="status"></p>';
      status=panel.querySelector('[role=status]');host.append(panel);
      panel.querySelectorAll('[data-scope-mode]').forEach(button=>button.onclick=()=>setMode(button.dataset.scopeMode));panel.querySelector('[data-scope-invert]').onclick=invertSelection;
      panel.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>apply(button.dataset.action==='rotate-left'?'rotate':button.dataset.action==='rotate-right'?'rotate':button.dataset.action,button.dataset.action==='rotate-left'?-90:button.dataset.action==='rotate-right'?90:undefined));
      panel.querySelector('[data-window]').onclick=()=>apply('window',{width:panel.querySelector('[data-ww]').value,center:panel.querySelector('[data-wc]').value});
      baseline=signature();for(const event of new Set(Object.values(grid?.EVENTS||{})))try{subscriptions.push(grid.subscribe(event,()=>{fresh();refreshUi();}));}catch(_){ }
      if(!listening){listening=true;root.addEventListener?.('storage',sessionEnd);root.addEventListener?.('pagehide',stop);try{channel=new BroadcastChannel('kin-session');channel.onmessage=event=>{if(event.data?.type==='session-ended')stop();};}catch(_){ }}refreshUi();return true;
    }
    const sessionEnd=event=>{if(event.key==='kin-session-ended')stop();};
    function stop(){if(ended)return;ended=true;subscriptions.splice(0).forEach(item=>item?.unsubscribe?.());channel?.close();channel=null;if(listening){root.removeEventListener?.('storage',sessionEnd);root.removeEventListener?.('pagehide',stop);listening=false;}panel?.remove();panel=status=null;chosen.clear();}
    return {mount,stop,apply,selection,setMode,setSelection,invertSelection,toggleCell,sourceToken:()=>baseline,refresh(){fresh();refreshUi();}};
  }
  const api={create};if(typeof module==='object'&&module.exports)module.exports=api;else root.KinViewerDisplayScope=api;
})(typeof globalThis==='object'?globalThis:this);
