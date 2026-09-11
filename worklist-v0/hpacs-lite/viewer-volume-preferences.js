window.kinCreateVolumePreferences=function({target,permitted,alive,owner,services,host}){
  const model=window.KinVolumePreferences,identity=JSON.stringify(owner()),key='kin-mpr-preferences:v1:'+identity;
  let ended=false,current=model.defaults(),bound=null,saved=false,pending=null,failed=null;
  const live=()=>{try{return !ended&&alive()&&JSON.stringify(owner())===identity;}catch(_){return false;}};
  const allowed=()=>{try{return live()&&permitted()&&!window.kinViewerJobWorkspaceState?.().busy&&!window.kinVolumeBatchState?.busy?.()&&!document.hidden;}catch(_){return false;}};
  const panel=document.createElement('section');panel.id='kin-mpr-preferences';panel.style.cssText='border-top:1px solid #657c9f;padding:8px 0';host.append(panel);
  panel.innerHTML='<strong>MPR Properties</strong><div class="display"></div><div class="mouse"></div><button type="button" data-action="apply">Apply Mouse</button> <button type="button" data-action="save">Save MPR Preferences</button> <button type="button" data-action="load">Load MPR Preferences</button><p role="status"></p><p>방향 큐브는 환자 L/R·P/A·H/F 축을 투영하고 Sample L/P/H는 표본 평면의 법선을 표시합니다. 표시와 마우스 설정은 현재 계정·이 브라우저에 저장합니다. 확대 배율은 기본 맞춤 기준이며 눈금은 환자 좌표의 거리입니다. 화면의 실제 자 크기와 다릅니다. 영상·판독 내용은 저장하지 않습니다.</p>';
  const status=panel.querySelector('[role=status]'),checks={},selects={};
  const labels={windowing:'Windowing',zoom:'Zoom Factor',thickness:'Thickness',scale:'Scale Bar',orientation:'Orientation',demographics:'Demographic Info',cube:'Orientation Cube',sample:'Sample Direction',autoHideCrosshair:'Auto Hide Crosshair'};
  for(const name of model.fields){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.setAttribute('aria-label','Show MPR '+labels[name]);label.append(input,' '+labels[name]+' ');panel.querySelector('.display').append(label);checks[name]=input;input.onchange=()=>{if(!allowed()){refresh();return;}pending=null;current.display[name]=input.checked;paint();status.textContent='표시 설정을 현재 세 평면에 적용했습니다.';};}
  for(const name of ['left','middle','right']){const label=document.createElement('label'),select=document.createElement('select');select.setAttribute('aria-label','MPR '+name+' mouse button');for(const tool of model.tools){const option=document.createElement('option');option.value=tool;option.textContent={WindowLevel:'Window / Level',Pan:'Pan',Zoom:'Zoom',StackScroll:'Slice Move'}[tool];select.append(option);}label.append(name[0].toUpperCase()+name.slice(1)+' ',select,' ');panel.querySelector('.mouse').append(label);selects[name]=select;}
  const style=document.createElement('style');style.textContent=`
    .kin-mpr-configured[data-kin-auto-hide-crosshair="true"]:not(:hover) [data-kin-crosshair]{visibility:hidden!important}
    .kin-mpr-configured [data-cy="viewport-overlay-bottom-left"]>div:not(:first-child){display:none!important}
    .kin-mpr-configured[data-kin-windowing="false"] [data-cy="viewport-overlay-bottom-left"]>div:first-child,
    .kin-mpr-configured[data-kin-thickness="false"] .kin-volume-projection-label,
    .kin-mpr-configured[data-kin-orientation="false"] .ViewportOrientationMarkers,
    .kin-mpr-configured[data-kin-demographics="false"] [data-cy="viewport-overlay-top-left"],
    .kin-mpr-configured[data-kin-demographics="false"] [data-cy="viewport-overlay-top-right"],
    .kin-mpr-configured[data-kin-demographics="false"] .kin-viewer-identity{visibility:hidden!important}
  `;document.head.append(style);
  const progressiveLabel=document.createElement('label'),progressive=document.createElement('input');progressive.type='checkbox';progressive.setAttribute('aria-label','MPR Progressive Rendering');progressiveLabel.append(progressive,' Progressive Rendering');panel.querySelector('.mouse').before(progressiveLabel);progressive.onchange=()=>{if(!allowed()){refresh();return;}pending=null;current.progressive=progressive.checked;if(!current.progressive)window.kinMprRenderingState?.settle();status.textContent='두꺼운 MPR 조작 중 표본 간격을 넓혀 미리 보고, 조작을 마치면 원래 품질로 복귀합니다.';};
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  function restoreTools(s){
    if(!s?.applied||!s.original||!equal(s.group.toolOptions,s.applied))return;
    for(const [name,before] of Object.entries(s.original))try{
      if(before.mode==='Active'){s.group.setToolPassive(name,{removeAllBindings:true});s.group.setToolActive(name,{bindings:before.bindings});}
      else s.group['setTool'+before.mode](name);
    }catch(_){}
  }
  function clear(){const s=bound;bound=null;if(!s)return;restoreTools(s);for(const item of s.items){item.view.element.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED,paint);item.zoom.remove();item.scale.remove();item.cube.remove();item.sample.remove();item.root.classList.remove('kin-mpr-configured');for(const k of model.fields)delete item.root.dataset['kin'+k[0].toUpperCase()+k.slice(1)];}}
  function applyMouse(value){
    const t=target(true);if(!allowed()||!bound||t?.group!==bound.key)throw Error('현재 MPR 배치를 확인하세요.');
    const group=bound.group,before=structuredClone(group.toolOptions),bindings=[{mouseButton:1},{mouseButton:4},{mouseButton:2}];
    try{
      for(const [name,options] of Object.entries(before))if(options.bindings?.some(b=>bindings.some(x=>x.mouseButton===b.mouseButton)&&b.modifierKey===undefined))group.setToolPassive(name,{removeAllBindings:bindings});
      ['left','middle','right'].forEach((name,i)=>group.setToolActive(value[name],{bindings:[bindings[i]]}));
      for(const [i,name] of ['left','middle','right'].entries())if(!group.getToolOptions(value[name])?.bindings.some(b=>b.mouseButton===bindings[i].mouseButton&&b.modifierKey===undefined))throw Error('마우스 연결을 확인하지 못했습니다.');
      bound.original||=before;bound.applied=structuredClone(group.toolOptions);current.mouse={...value};
    }catch(error){
      for(const [name,options] of Object.entries(before))try{group.setToolPassive(name,{removeAllBindings:true});if(options.mode==='Active')group.setToolActive(name,{bindings:options.bindings});else group['setTool'+options.mode](name);}catch(_){}
      throw error;
    }
  }
  function paint(){
    if(!bound||!live())return;
    for(const {root,view,zoom,scale,cube,sample} of bound.items){
      for(const k of model.fields)root.dataset['kin'+k[0].toUpperCase()+k.slice(1)]=String(current.display[k]);
      zoom.hidden=!current.display.zoom;zoom.textContent='Zoom: '+view.getZoom().toFixed(2)+'×';
      const rule=model.ruler(view);scale.hidden=!current.display.scale||!rule;
      if(rule){scale.style.width=rule.pixels+'px';scale.textContent=Number(rule.mm.toPrecision(5))+' mm';}
      sample.hidden=!current.display.sample;sample.textContent='Sample L/P/H: '+view.getCamera().viewPlaneNormal.map(n=>Number(n.toFixed(3))).join(' / ');
      cube.style.display=current.display.cube?'':'none';cube.replaceChildren();const shape=model.cube(view);
      if(shape){const make=(tag,attrs,text)=>{const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));if(text)el.textContent=text;cube.append(el);};
        for(const [a,b] of shape.edges)make('line',{x1:shape.corners[a][0],y1:shape.corners[a][1],x2:shape.corners[b][0],y2:shape.corners[b][1],stroke:'#6de6ff','stroke-width':1});
        for(const label of shape.labels)make('text',{x:label.point[0],y:label.point[1],fill:'#e1ecfc','font-size':12,'text-anchor':'middle','dominant-baseline':'middle'},label.text);
      }

    }
  }
  function attach(t){
    clear();const groups=t.views.map(v=>cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId));
    if(!groups[0]||groups.some(g=>g!==groups[0])||model.tools.some(n=>!groups[0].getToolInstance(n)))throw Error('현재 MPR 도구 연결을 확인하지 못했습니다.');
    bound={key:t.group,views:t.views,group:groups[0],items:[],initialApplied:!saved};
    for(const view of t.views){const root=view.element.parentElement;if(!root?.classList.contains('viewport-wrapper'))throw Error('현재 영상 표시 구조를 확인하지 못했습니다.');const zoom=document.createElement('span'),scale=document.createElement('span');zoom.className='kin-mpr-zoom';scale.className='kin-mpr-scale';zoom.style.cssText='position:absolute;left:10px;bottom:53px;pointer-events:none;background:#00131dcc;padding:2px 4px;color:#6de6ff;font-size:12px';scale.style.cssText='position:absolute;left:12px;top:80px;border-bottom:2px solid #6de6ff;color:#6de6ff;text-align:center;pointer-events:none;font-size:12px';const cube=document.createElementNS('http://www.w3.org/2000/svg','svg'),sample=document.createElement('span');cube.classList.add('kin-mpr-cube');cube.setAttribute('viewBox','0 0 120 120');cube.style.cssText='position:absolute;bottom:70px;right:15px;width:100px;height:100px;pointer-events:none;background:#00131dcc;border-radius:5px';sample.className='kin-mpr-sample';sample.style.cssText='position:absolute;top:110px;left:10px;color:#6de6ff;font-size:11px;pointer-events:none';view.element.append(zoom,scale,cube,sample);root.classList.add('kin-mpr-configured');view.element.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED,paint);bound.items.push({root,view,zoom,scale,cube,sample});}
    paint();
  }
  function refresh(){
    if(ended)return;const t=live()&&target();panel.hidden=!t;
    if(!t){if(!live()||bound?.views.some(v=>!v.element.isConnected||services.cornerstoneViewportService.getCornerstoneViewport(v.id)!==v))clear();return;}
    try{if(failed?.key===t.group&&failed.views.every((v,i)=>v===t.views[i]))return;if(!bound||bound.key!==t.group||bound.views.some((v,i)=>v!==t.views[i]))attach(t);if(pending&&allowed()){const next=pending;pending=null;apply(next);}if(saved&&!bound.initialApplied&&allowed()){bound.initialApplied=true;apply(current);}paint();}catch(error){clear();failed={key:t.group,views:t.views};status.textContent=error.message+' 영상 창을 새로고침한 뒤 재시도하세요.';}
    for(const control of panel.querySelectorAll('input,select,button'))control.disabled=!bound||!allowed();
    for(const name of model.fields)checks[name].checked=current.display[name];panel.querySelector('[data-action=save]').disabled=!bound||!allowed()||!!pending;progressive.checked=current.progressive;progressive.disabled=!bound||!allowed()||!window.kinMprRenderingState;
  }
  function showMouse(){for(const name of ['left','middle','right'])selects[name].value=current.mouse[name];}
  panel.querySelector('[data-action=apply]').onclick=()=>{pending=null;try{const candidate=model.normalize({...current,mouse:Object.fromEntries(Object.entries(selects).map(([k,v])=>[k,v.value]))});if(!candidate)throw Error('각 버튼에는 서로 다른 도구를 지정하세요.');applyMouse(candidate.mouse);status.textContent='마우스 버튼을 적용했습니다. 이후 도구 모음 선택은 해당 조작을 바꿀 수 있습니다.';}catch(error){status.textContent=error.message;}refresh();};
  panel.querySelector('[data-action=save]').onclick=()=>{if(!allowed()||pending)return;if(Object.entries(selects).some(([k,v])=>v.value!==current.mouse[k])){status.textContent='마우스 변경을 먼저 적용하세요.';return;}try{current=read();localStorage.setItem(key,JSON.stringify(current));saved=true;notify();status.textContent='MPR 설정을 저장했습니다 · 현재 계정·이 브라우저';}catch(_){status.textContent='MPR 설정을 저장하지 못했습니다. 현재 창은 유지합니다.';}};
  function load(explicit){try{const raw=localStorage.getItem(key);if(raw===null){status.textContent='저장된 MPR 설정이 없습니다.';return;}const value=raw.length<=1024&&model.normalize(JSON.parse(raw));if(!value)throw Error('저장된 MPR 설정 형식을 확인할 수 없습니다.');if(explicit&&!apply(value))throw Error('현재 MPR 설정을 적용하지 못했습니다.');current=value;saved=true;showMouse();paint();status.textContent='저장된 MPR 설정을 불러왔습니다 · 이 브라우저';}catch(error){status.textContent=error.message||'MPR 설정을 읽지 못했습니다.';}}
  panel.querySelector('[data-action=load]').onclick=()=>{if(allowed())load(true);refresh();};
  function read(){return model.normalize({...current,sync:window.kinVolumeSynchronization?.read()||current.sync});}
  function notify(){for(const destination of window.parent===window?[window]:[window,window.parent])try{destination.dispatchEvent(new destination.CustomEvent('kin-mpr-preference-changed',{detail:{owner:identity,value:read()}}));}catch(_){} }
  function apply(value){
    const next=model.normalize(value);if(!next||!allowed()||!bound)return false;
    const previous=read(),scope=bound,tools=structuredClone(bound.group.toolOptions),ownership={original:bound.original,applied:bound.applied};let syncApplied=false;try{applyMouse(next.mouse);if(!window.kinVolumeSynchronization?.apply(next.sync))throw Error('동기화 설정을 적용하지 못했습니다.');syncApplied=true;current=next;bound.initialApplied=true;showMouse();paint();saved=true;notify();return true;}
    catch(error){if(bound===scope&&live())try{for(const [name,options] of Object.entries(tools)){scope.group.setToolPassive(name,{removeAllBindings:true});if(options.mode==='Active')scope.group.setToolActive(name,{bindings:options.bindings});else scope.group['setTool'+options.mode](name);}scope.original=ownership.original;scope.applied=ownership.applied;if(syncApplied)window.kinVolumeSynchronization?.apply(previous.sync);current=previous;showMouse();paint();}catch(_){status.textContent='이전 마우스 설정을 완전히 복구하지 못했습니다.';return false;}status.textContent=error.message;return false;}
  }
  const capability={read:()=>bound?read():null,apply,notice(text){status.textContent=text;},requestApply(value){const clean=model.normalize(value);if(!live()||!clean)return false;pending=clean;panel.querySelector('[data-action=save]').disabled=true;status.textContent='불러온 MPR 설정은 현재 모달/작업이 끝나면 적용합니다.';return true;},canApply:value=>!!model.normalize(value)&&allowed()&&!!bound};window.kinMprPreferences=capability;
  load(false);showMouse();const timer=setInterval(refresh,250);refresh();
  return {dispose(){ended=true;clearInterval(timer);clear();if(window.kinMprPreferences===capability)delete window.kinMprPreferences;style.remove();panel.remove();}};
};
