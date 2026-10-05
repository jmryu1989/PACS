window.kinCreateVolumeRendering=function({target,permitted,alive,owner,notice=()=>{},storage}){
  storage||={getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value)};
  const el=(tag,text,parent)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;parent?.append(e);return e;};
  const dialog=el('dialog');dialog.id='kin-volume-rendering';dialog.style.cssText='background:#18212b;color:white;padding:16px';
  const style=el('style',undefined,dialog);style.textContent='#kin-volume-rendering{width:min(1320px,96vw);height:min(860px,92vh);overflow:hidden;box-sizing:border-box;border:1px solid #6884a6;border-radius:8px;font:14px/1.5 system-ui;display:grid;grid-template-columns:minmax(340px,440px) minmax(0,1fr);grid-template-rows:auto auto auto auto minmax(0,1fr) auto auto auto;grid-template-areas:"title canvas" "identity canvas" "source canvas" "intro canvas" "controls canvas" "status canvas" "hint canvas" "close canvas";column-gap:16px}#kin-volume-rendering::backdrop{background:#0009}#kin-volume-rendering h2{grid-area:title;font-size:20px;font-weight:700;margin:0 0 8px}#kin-volume-rendering p{margin:6px 0}#kin-volume-rendering .kin-vr-identity{grid-area:identity}#kin-volume-rendering .kin-vr-source{grid-area:source}#kin-volume-rendering .kin-vr-intro{grid-area:intro}#kin-volume-rendering .kin-vr-controls{grid-area:controls;min-height:0;overflow:auto;padding-right:6px}#kin-volume-rendering .kin-vr-status{grid-area:status}#kin-volume-rendering .kin-vr-hint{grid-area:hint}#kin-volume-rendering .kin-vr-close{grid-area:close;justify-self:start}#kin-volume-rendering .kin-vr-canvas-pane{grid-area:canvas;min-width:0;min-height:0;display:flex;background:#000}#kin-volume-rendering fieldset{display:flex;flex-wrap:wrap;align-items:center;gap:10px;border:1px solid #52657e;border-radius:5px;padding:10px;margin:12px 0}#kin-volume-rendering legend{padding:0 5px}#kin-volume-rendering label{display:inline-flex;align-items:center;gap:5px}#kin-volume-rendering input,#kin-volume-rendering select{color:#17202a;background:white;border:1px solid #657c9f;border-radius:3px;padding:4px}#kin-volume-rendering input[type=number]{width:76px}#kin-volume-rendering button{padding:5px 10px;border:1px solid #6884a6;border-radius:4px;background:#263c57;color:white}#kin-volume-rendering button:hover{background:#3b5577}#kin-volume-rendering details{font-size:12px;overflow-wrap:anywhere;color:#c6d3e1}#kin-volume-rendering .kin-vr-knots{display:grid;grid-template-columns:auto auto auto;gap:6px;width:100%}#kin-volume-rendering .kin-vr-knots[hidden]{display:none}#kin-volume-rendering .kin-vr-preset-name{width:150px}@media(max-width:1000px){#kin-volume-rendering{display:block;width:min(900px,96vw);height:auto;max-height:94vh;overflow:auto}#kin-volume-rendering .kin-vr-controls{overflow:visible;padding-right:0}#kin-volume-rendering .kin-vr-canvas-pane{height:min(60vh,600px);min-height:300px}}';
  style.textContent+='#kin-volume-rendering:not([open]){display:none}';
  style.textContent+='#kin-volume-rendering.kin-vr-covered>:not(style):not(.kin-vr-cover):not(.kin-vr-close){visibility:hidden}#kin-volume-rendering .kin-vr-cover{position:absolute;inset:0;z-index:4;background:#18212b;display:flex;align-items:center;justify-content:center;padding:48px;box-sizing:border-box}#kin-volume-rendering .kin-vr-cover[hidden]{display:none}#kin-volume-rendering .kin-vr-close{position:relative;z-index:5}';
  el('h2','Volume Rendering',dialog);const identity=el('p','',dialog);identity.className='kin-vr-identity';const sourceDetails=el('details',undefined,dialog);sourceDetails.className='kin-vr-source';el('summary','Source Identifiers',sourceDetails);const sourceText=el('p','',sourceDetails),intro=el('p','현재 로드된 CT 원본의 수동 3D 표시입니다. 색과 불투명도는 표시 조건이며 조직 판정이나 자동 분석 결과가 아닙니다.',dialog);intro.className='kin-vr-intro';const controlsPane=el('div',undefined,dialog);controlsPane.className='kin-vr-controls';
  const controls=el('fieldset',undefined,controlsPane);el('legend','VR Display',controls);
  const select=(label,values,parent=controls)=>{const l=el('label',label+' ',parent),s=el('select',undefined,l);s.setAttribute('aria-label',label);for(const value of values){const o=el('option',value,s);o.value=value;}return s;};
  const preset=select('VR Preset',['CT-Bone','CT-Soft-Tissue','CT-Fat']),direction=select('View From',['Custom',...window.KinVolumeRendering.directions]);direction.options[0].disabled=true;
  const opacityLabel=el('label',' Opacity (%) ',controls),opacity=el('input',undefined,opacityLabel);opacity.type='number';opacity.min=0;opacity.max=100;opacity.step=5;opacity.value=100;opacity.style.width='72px';opacity.setAttribute('aria-label','VR Opacity');
  const shadeLabel=el('label',' Shading ',controls),shade=el('input',undefined,shadeLabel);shade.type='checkbox';shade.checked=false;shade.setAttribute('aria-label','VR Shading');
  const apply=el('button','Apply Display',controls),reset=el('button','Reset VR',controls);
  const cropControls=el('fieldset',undefined,controlsPane);el('legend','Crop Bounds',cropControls);el('p','I/J/K 원본 복셀 번호를 양 끝 포함 범위로 입력하세요.',cropControls);const cropInputs={};
  for(const axis of ['I','J','K'])for(const side of ['Min','Max']){const name=axis+' '+side,label=el('label',name+' ',cropControls),input=el('input',undefined,label);input.type='number';input.step='1';input.setAttribute('aria-label',name);cropInputs[axis.toLowerCase()+side]=input;}
  const applyCropButton=el('button','Apply Crop',cropControls);
  const transferControls=el('fieldset',undefined,controlsPane);el('legend','Transfer Function',transferControls);el('p','Custom에서는 HU, 색상, 불투명도 점을 HU가 작은 순서로 입력하세요.',transferControls);const transferMode=select('Transfer Mode',['Preset','Custom'],transferControls),knotHost=el('div',undefined,transferControls);knotHost.className='kin-vr-knots';
  const addKnot=el('button','Add Knot',transferControls),removeKnot=el('button','Remove Knot',transferControls);
  const presetControls=el('fieldset',undefined,controlsPane);el('legend','Personal Display Presets',presetControls);const presetHelp=el('p','',presetControls),presetHelpText='현재 기관과 계정에 한정해 이 브라우저에만 저장됩니다. 편집값은 Apply Display로 적용한 뒤 저장하세요.';presetHelp.textContent=presetHelpText;
  const presetNameLabel=el('label','Preset Name ',presetControls),presetName=el('input',undefined,presetNameLabel);presetName.type='text';presetName.maxLength=128;presetName.className='kin-vr-preset-name';presetName.setAttribute('aria-label','Preset Name');
  const savedPreset=select('Saved Presets',[],presetControls),savePreset=el('button','Save New Preset',presetControls),replacePreset=el('button','Replace Preset',presetControls),loadPreset=el('button','Load Preset',presetControls),deletePreset=el('button','Delete Preset',presetControls),reloadPresets=el('button','Reload Presets',presetControls),closeButton=el('button','Close VR',dialog);closeButton.className='kin-vr-close';
  const status=el('p','',dialog);status.className='kin-vr-status';status.setAttribute('role','status');const hint=el('p','드래그: 회전 · 휠: 확대/축소. 원래 MPR 평면·표식·판독 입력은 유지됩니다.',dialog);hint.className='kin-vr-hint';
  const canvasPane=el('div',undefined,dialog);canvasPane.className='kin-vr-canvas-pane';const canvasHost=el('div',undefined,canvasPane);canvasHost.dataset.kinVrRender='1';canvasHost.style.cssText='width:100%;height:100%;min-height:0;background:black;touch-action:none';document.body.append(dialog);
  const coverNotice=el('p','',dialog);coverNotice.className='kin-vr-cover';coverNotice.setAttribute('role','alert');coverNotice.hidden=true;
  let ended=false,operation=null,drag=null,drawing=false,knots=[],librarySnapshot=null,libraryStale=false,libraryFailure=null;const groups=[controls,cropControls,transferControls,presetControls],writeButtons=[savePreset,replacePreset,deletePreset];
  const disableControls=value=>{groups.forEach(group=>group.disabled=value);if(sculpt)sculpt.fieldset.disabled=value;};
  const sculpt=window.kinCreateVolumeSculpt({controlsPane,canvasPane,canvasHost,getOperation:()=>operation,check,render:renderSculpt,preflight:(op,properties)=>window.KinVolumeMaskRenderer.preflight(op,properties),fail,status,
    setDrawing(value){drawing=value;drag=null;const op=operation;groups.forEach(group=>group.disabled=value||!op?.ready||!!op.libraryBusy||!!op.covers.size);}
  });
  function renderKnots(){knotHost.replaceChildren();for(const field of ['HU','Color','Opacity'])el('strong',field,knotHost);knots.forEach((k,index)=>{for(const field of ['HU','Color','Opacity']){const input=el('input',undefined,knotHost);input.setAttribute('aria-label','Knot '+(index+1)+' '+field);input.value=k[field.toLowerCase()];input.type=field==='Color'?'color':'number';if(field==='HU'){input.min='-32768';input.max='65535';input.step='1';}if(field==='Opacity'){input.min='0';input.max='1';input.step='0.05';}input.oninput=()=>{knots[index][field.toLowerCase()]=input.value;};}});const custom=transferMode.value==='Custom';preset.disabled=custom;knotHost.hidden=!custom;addKnot.hidden=removeKnot.hidden=!custom;removeKnot.disabled=knots.length<=2;addKnot.disabled=knots.length>=16;}
  function resetEditors(op){preset.value='CT-Bone';opacity.value='100';shade.checked=false;direction.value='Anterior';transferMode.value='Preset';knots=[{hu:'-1000',color:'#000000',opacity:'0'},{hu:'2000',color:'#FFFFFF',opacity:'1'}];if(op?.dimensions){['i','j','k'].forEach((axis,index)=>{cropInputs[axis+'Min'].value='0';cropInputs[axis+'Max'].value=String(op.dimensions[index]-1);cropInputs[axis+'Min'].min=cropInputs[axis+'Max'].min='0';cropInputs[axis+'Min'].max=cropInputs[axis+'Max'].max=String(op.dimensions[index]-1);});}renderKnots();}
  const current=op=>{try{const t=target(true,true,{requireRenderReady:false});return !ended&&alive()&&dialog.open&&operation===op&&!op.controller.signal.aborted&&JSON.stringify(owner())===op.owner&&t?.group===op.target.group&&t.selection===op.target.selection&&t.views.every((v,i)=>v===op.target.views[i])&&(!op.view||op.engine?.getViewport(op.id)===op.view);}catch(_){return false;}};
  function close(){const op=operation;operation=null;sculpt.cancel();drag=null;librarySnapshot=null;libraryStale=false;libraryFailure=null;disableControls(true);if(op){op.controller.abort();for(const request of op.requests)request.controller.abort();clearTimeout(op.accessTimer);op.rejectAccess(Error('VR 표시가 닫혔습니다.'));op.unwatchSession?.();op.unguard?.();try{if(op.engine?.getViewport(op.id))op.engine.disableElement(op.id);}catch(_){} }canvasHost.replaceChildren();savedPreset.replaceChildren();presetName.value='';identity.textContent=sourceText.textContent='';sourceDetails.open=false;dialog.close();}
  function fail(op,error){if(operation!==op)return;close();notice('VR 표시를 닫았습니다. '+(error.message||'다시 열어 확인하세요.'));}
  function check(op){if(!current(op))throw Error('원본이나 계정이 변경되어 VR 표시를 닫았습니다.');}
  const ACCESS_VALID_MS=15000,ACCESS_COVER_MS=30000,ACCESS_REFRESH_MS=10000,ACCESS_RETRY_MS=2000;
  const clock=()=>({mono:performance.now(),wall:Date.now()}),age=(now,then)=>Math.max(now.mono-then.mono,now.wall-then.wall);
  const accessMessage='VR 접근을 확인하지 못해 화면을 가렸습니다. 연결을 확인하는 중이며 편집값은 유지됩니다.';
  function cover(op,reason,message){
    if(operation!==op)return;
    if(message)op.covers.set(reason,message);else op.covers.delete(reason);
    const covered=op.covers.size>0;
    dialog.classList.toggle('kin-vr-covered',covered);coverNotice.hidden=!covered;
    coverNotice.textContent=op.covers.get('session')||op.covers.get('context')||op.covers.get('access')||'';
    for(const node of [controlsPane,canvasPane,identity,sourceDetails])node.inert=covered;
    if(covered){drag=null;sculpt.pause();disableControls(true);}
    else if(op.ready){disableControls(false);groups.forEach(group=>group.disabled=drawing||!!op.libraryBusy);}
  }
  function invalidateDisplay(op){
    op.displayEpoch++;op.confirmedExpired=true;cover(op,'access',accessMessage);
  }
  function access(op){
    if(op.asking)return op.accessReady;
    check(op);const asking={started:clock(),epoch:op.displayEpoch,controller:new AbortController()};
    op.asking=asking;op.requests.add(asking);
    const get=async path=>{
      const response=await fetch(new URL(path,location.origin).href,{credentials:'same-origin',cache:'no-store',headers:{'X-KIN-Subject':JSON.parse(op.owner)[1]},signal:asking.controller.signal});
      const refusal=window.KinSessionTransport?.refusal(response);
      // Even an expired or replaced request can deliver a refusal for this operation.
      if(refusal==='denied'||refusal==='ended'||path!=='/api/me'&&response.status===404){fail(op,Error('VR 원본 접근 권한을 확인하지 못했습니다.'));return false;}
      if(!response.ok)return false;
      const body=await response.json();
      if(path==='/api/me'){
        if(!body||typeof body.kind!=='string')return false;
        if(body.kind!=='member'){fail(op,Error('VR 계정이 변경되었습니다.'));return false;}
        if(typeof body.institution!=='string'||typeof body.sub!=='string')return false;
        if(JSON.stringify([body.institution,body.sub])!==op.owner){fail(op,Error('VR 계정이 변경되었습니다.'));return false;}
        if(op.session!==undefined&&typeof body.sessionId!=='string')return false;
        if(op.session!==undefined&&body.sessionId!==op.session){fail(op,Error('VR 세션이 변경되었습니다.'));return false;}
      }else if(!Array.isArray(body))return false;
      return true;
    };
    // Both bodies must complete. Failure of one half never hides the other's refusal.
    Promise.all(op.paths.map(path=>get(path).catch(()=>false))).then(replies=>{
      op.requests.delete(asking);
      if(operation!==op||op.asking!==asking)return;
      const now=clock();op.asking=null;op.completed=now;
      try{
        check(op);
        if(replies.every(Boolean)&&age(now,asking.started)<ACCESS_VALID_MS&&asking.epoch===op.displayEpoch
          &&!op.pageHidden&&document.visibilityState!=='hidden'&&(!window.KinViewerSessionBoundary||window.KinViewerSessionBoundary.active())){
          op.confirmed=asking.started;op.confirmedExpired=false;cover(op,'access',null);op.resolveAccess();
        }
        if(mayStartFrame(op)){
          // Only a rejected draw needs replay. A long completed frame is already current;
          // replaying it after every confirmation would cover a slow renderer forever.
          if(op.held&&op.view){op.held=false;render(op);}
          else verifySculpt(op);
        }
      }catch(error){fail(op,error);}
    });
    return op.accessReady;
  }
  function mayStartFrame(op){
    try{
      check(op);
      const boundary=window.KinViewerSessionBoundary;
      if(boundary?.ended()){fail(op,Error('VR 세션이 종료되었습니다.'));return false;}
      if(boundary&&!boundary.active())return false;
      const now=clock();
      if(!op.ready&&op.preparationStarted&&age(now,op.preparationStarted)>=30000)throw Error('VR 원본 확인 시간이 지났습니다. 다시 열어 주세요.');
      const pending=op.asking;
      if(pending&&age(now,pending.started)>=ACCESS_VALID_MS){
        pending.controller.abort();op.requests.delete(pending);op.asking=null;op.completed=now;
      }
      // Expiry is latched: a later wall-clock correction cannot resurrect permission.
      const confirmedAge=op.confirmed?age(now,op.confirmed):Infinity;
      if(confirmedAge>=ACCESS_VALID_MS)op.confirmedExpired=true;
      if(confirmedAge>=ACCESS_COVER_MS||op.pageHidden||document.visibilityState==='hidden')cover(op,'access',accessMessage);
      if((op.confirmedExpired||confirmedAge>=ACCESS_REFRESH_MS)&&!op.asking&&(!op.completed||age(now,op.completed)>=ACCESS_RETRY_MS))access(op);
      clearTimeout(op.accessTimer);op.accessTimer=setTimeout(()=>mayStartFrame(op),250);
      return !op.confirmedExpired&&!op.covers.size;
    }catch(error){fail(op,error);return false;}
  }
  function guardFrames(op){
    // Gating public render()/renderViewport()/resize() calls cannot stop already queued work.
    // This adapter gates VTK traversal instead. Detect both internal members before creating
    // a VR, then prove traversal at its first IMAGE_RENDERED. Remove that listener afterwards.
    const engine=op.engine,was=engine.performVtkDrawCall,own=Object.prototype.hasOwnProperty.call(engine,'performVtkDrawCall');
    const unsupported=()=>Error('이 뷰어 버전에서는 3D 표시를 열 수 없습니다. 뷰어 지원 담당자에게 문의하세요.');
    if(typeof was!=='function'||!(engine._needsRender instanceof Set))throw unsupported();
    let entered=false;
    const event=cornerstone.Enums.Events.IMAGE_RENDERED;
    const firstFrame=()=>{canvasHost.removeEventListener(event,firstFrame);if(!entered)fail(op,unsupported());};
    canvasHost.addEventListener(event,firstFrame);
    const guarded=function(){
      if(this._needsRender.has(op.id)){
        if(!mayStartFrame(op)){op.held=true;this._needsRender.delete(op.id);}
        else op.held=false;
      }
      try{return was.call(this);}finally{if(operation===op)mayStartFrame(op);}
    };
    const proving=function(){
      if(this._needsRender.has(op.id)){entered=true;engine.performVtkDrawCall=guarded;}
      return guarded.call(this);
    };
    engine.performVtkDrawCall=proving;
    if(engine.performVtkDrawCall!==proving){canvasHost.removeEventListener(event,firstFrame);throw unsupported();}
    op.unguard=()=>{canvasHost.removeEventListener(event,firstFrame);if(engine.performVtkDrawCall===guarded||engine.performVtkDrawCall===proving){if(own)engine.performVtkDrawCall=was;else delete engine.performVtkDrawCall;}};
  }

  function render(op){if(mayStartFrame(op))op.view.render();else op.held=true;}
  function verifySculpt(op){
    if(!op.sculptRenderGeneration||op.sculptFrameGeneration!==op.sculptRenderGeneration||op.sculptVerifyQueued||op.covers.size||op.held)return;
    const generation=op.sculptRenderGeneration;op.sculptVerifyQueued=true;
    // Wait only after an actual frame, never poll rAF while access holds a draw.
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      op.sculptVerifyQueued=false;
      if(operation!==op||op.controller.signal.aborted||op.covers.size||op.held)return;
      if(op.sculptRenderGeneration!==generation){verifySculpt(op);return;}
      try{
        check(op);const node=op.engine.offscreenMultiRenderWindow.getOpenGLRenderWindow().getViewNodeFor(op.mapper),program=node?.get('tris')?.tris?.getProgram();
        if(!program?.getCompiled()||!program.getLinked()||(!!op.sculptOperations?.length!==program.getFragmentShader().getSource().includes('kinSculptPoint0')))throw Error('VR 조각 표시를 GPU에서 적용하지 못했습니다. 다시 열어 주세요.');
        op.sculptRenderGeneration=0;
      }catch(error){fail(op,error);}
    }));
  }
  function renderSculpt(op){
    op.sculptRenderGeneration=(op.sculptRenderGeneration||0)+1;render(op);
  }
  canvasHost.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,()=>{
    const op=operation;if(!op)return;
    op.sculptFrameGeneration=op.sculptRenderGeneration;verifySculpt(op);
  });
  function editorDisplay(){
    const scale=Number(opacity.value);if(!opacity.value.trim()||!Number.isFinite(scale)||scale<0||scale>100)throw Error('불투명도를 0~100 범위로 입력하세요.');
    const normalizedKnots=transferMode.value==='Custom'?KinVolumeRendering.validateTransferKnots(knots):[];
    return KinVolumeRendering.normalizeDisplay({transferMode:transferMode.value,preset:transferMode.value==='Preset'?preset.value:null,knots:normalizedKnots,opacity:scale,shading:shade.checked});
  }
  function useDisplay(display){const value=KinVolumeRendering.normalizeDisplay(display);transferMode.value=value.transferMode;if(value.transferMode==='Preset')preset.value=value.preset;opacity.value=String(value.opacity);shade.checked=value.shading;knots=value.transferMode==='Custom'?value.knots.map(k=>({hu:String(k.hu),color:k.color,opacity:String(k.opacity)})):[{hu:'-1000',color:'#000000',opacity:'0'},{hu:'2000',color:'#FFFFFF',opacity:'1'}];renderKnots();}
  function drawPresetList(selected=''){
    savedPreset.replaceChildren();const blank=el('option','Select a preset',savedPreset);blank.value='';
    for(const item of librarySnapshot?.library.presets||[]){const option=el('option',item.name,savedPreset);option.value=item.name;}
    savedPreset.value=(librarySnapshot?.library.presets||[]).some(item=>item.name===selected)?selected:'';
  }
  function reloadLibrary(op,message=true){
    const selected=savedPreset.value;try{check(op);const next=KinVolumeRendering.readPresetLibrary(storage,JSON.parse(op.owner));check(op);librarySnapshot=next;libraryStale=false;libraryFailure=null;drawPresetList(selected);if(message)status.textContent='VR 프리셋 목록을 다시 불러왔습니다. 표시와 편집값은 유지됩니다.';}catch(error){libraryStale=true;libraryFailure=error.message;throw error;}
  }
  function selectedEntry(){const name=savedPreset.value,item=librarySnapshot?.library.presets.find(entry=>entry.name===name);if(!item)throw Error('VR 프리셋을 선택하세요.');return item;}
  function appliedEditor(op){const display=editorDisplay();if(!op.appliedDisplay||JSON.stringify(display)!==JSON.stringify(op.appliedDisplay))throw Error('편집한 표시 조건을 먼저 Apply Display로 적용하세요.');return display;}
  async function changeLibrary(type){const op=operation;if(!op?.ready||op.libraryBusy)return;let command,snapshot;
    try{
      check(op);if(libraryFailure)throw Error(libraryFailure);if(!librarySnapshot)throw Error('Reload Presets로 VR 프리셋 목록을 먼저 불러오세요.');if(libraryStale)throw Error('다른 창에서 VR 프리셋 목록이 변경되었습니다. Reload Presets를 누르세요.');
      const selected=type==='add'?null:selectedEntry();command=type==='delete'?{type,name:selected.name}:{type,name:type==='add'?KinVolumeRendering.normalizePresetName(presetName.value):selected.name,display:appliedEditor(op)};snapshot=librarySnapshot;
      if(typeof navigator?.locks?.request!=='function')throw Error('이 브라우저에서는 안전한 VR 프리셋 저장을 사용할 수 없습니다.');
      op.libraryBusy=true;disableControls(true);
      await navigator.locks.request('kin-vr-presets:'+snapshot.key,{mode:'exclusive',signal:op.controller.signal},()=>{
        check(op);if(librarySnapshot!==snapshot||libraryStale)throw Error('다른 창에서 VR 프리셋 목록이 변경되었습니다. Reload Presets를 누르세요.');
        const next=KinVolumeRendering.writePresetLibrary(storage,snapshot,command);check(op);librarySnapshot=next;libraryStale=false;drawPresetList(type==='delete'?'':command.name);if(type==='add')presetName.value='';status.textContent=type==='add'?'VR 프리셋을 저장했습니다.':type==='replace'?'VR 프리셋을 바꿨습니다.':'VR 프리셋을 삭제했습니다.';
      });
    }catch(error){if(operation===op){if(current(op))status.textContent=error.message;else fail(op,error);}}finally{op.libraryBusy=false;if(operation===op&&current(op)){cover(op,'access',op.covers.get('access'));renderKnots();}}
  }
  function applyDisplay(rethrow=false){const op=operation;if(!op?.view)return;let changed=false;try{
    check(op);const display=editorDisplay(),scale=display.opacity,custom=display.transferMode==='Custom'?display.knots:null,property=op.view.getActors()[0].actor.getProperty();changed=true;
    if(custom){const colors=property.getRGBTransferFunction(0),curve=property.getScalarOpacity(0);colors.removeAllPoints();curve.removeAllPoints();for(const knot of custom){const rgb=KinVolumeRendering.hexToRgb(knot.color);colors.addRGBPoint(knot.hu,...rgb);curve.addPoint(knot.hu,knot.opacity*scale/100);}}
    else{op.view.setProperties({preset:display.preset});const curve=property.getScalarOpacity(0);for(let i=0;i<curve.getSize();i++){const node=[];curve.getNodeValue(i,node);node[1]*=scale/100;curve.setNodeValue(i,node);}}
    property.setShade(display.shading);render(op);op.appliedDisplay=KinVolumeRendering.normalizeDisplay(display);status.textContent='VR 표시 조건을 적용했습니다.';
  }catch(error){if(rethrow===true){try{error.kinVrDisplayChanged=changed;}catch(_){}throw error;}if(changed)fail(op,error);else status.textContent=error.message;}}
  function cropValues(){const value=input=>input.value.trim()===''?NaN:Number(input.value);return {i:[value(cropInputs.iMin),value(cropInputs.iMax)],j:[value(cropInputs.jMin),value(cropInputs.jMax)],k:[value(cropInputs.kMin),value(cropInputs.kMax)]};}
  function applyCrop(rethrow=false,clear=false){const op=operation;if(!op?.view)return;let changed=false;try{
    check(op);const bounds=KinVolumeRendering.validateCropBounds(cropValues(),op.dimensions),full=['i','j','k'].every((axis,index)=>bounds[axis][0]===0&&bounds[axis][1]===op.dimensions[index]-1),mapper=op.mapper;
    if(typeof mapper.getClippingPlanes!=='function'||typeof mapper.addClippingPlane!=='function'||typeof mapper.removeAllClippingPlanes!=='function')throw Error('이 뷰어에서는 VR 자르기를 사용할 수 없습니다.');
    const definitions=full||clear?[]:KinVolumeRendering.cropPlanes(bounds,op.dimensions,op.imageData),next=definitions.map(KinVolumeRendering.createCropPlane),previous=[...mapper.getClippingPlanes()];changed=true;
    try{mapper.removeAllClippingPlanes();for(const plane of next)if(mapper.addClippingPlane(plane)===false)throw Error('VR 자르기 평면을 적용하지 못했습니다.');}
    catch(error){mapper.removeAllClippingPlanes();for(const plane of previous)mapper.addClippingPlane(plane);throw error;}
    render(op);if(!clear)status.textContent=full?'전체 VR 범위를 표시합니다.':'VR 자르기 범위를 적용했습니다.';
  }catch(error){if(rethrow===true)throw error;if(changed)fail(op,error);else status.textContent=error.message;}}
  async function open(){
    if(ended||operation||!alive()||!permitted()||window.kinViewerJobWorkspaceState?.().busy||window.kinVolumeBatchState?.busy?.()||window.kinMprRenderingState?.busy?.())return;
    const t=target(true);if(!t)throw Error('완전히 로드된 일반 CT의 MPR에서 여세요.');
    const capturedOwner=owner();if(!capturedOwner)throw Error('로그인 상태를 확인하세요.');const bound=JSON.stringify(KinVolumeRendering.normalizeOwner(capturedOwner));
    const op={target:t,owner:bound,session:window.KinViewerSessionBoundary?.session(),controller:new AbortController(),id:'kin-vr-'+crypto.randomUUID(),confirmed:null,confirmedExpired:true,covers:new Map(),displayEpoch:0,requests:new Set()};
    op.accessReady=new Promise((resolve,reject)=>{op.resolveAccess=resolve;op.rejectAccess=reject;});op.accessReady.catch(()=>{});
    op.paths=['/api/me','/api/studies/'+encodeURIComponent(t.source.uid)+'/viewer-jobs'];
    operation=op;dialog.showModal();cover(op,'access',accessMessage);disableControls(true);status.textContent='원본과 계정을 확인하는 중…';
    op.unwatchSession=window.KinViewerSessionBoundary?.onState(state=>{
      if(operation!==op)return;
      if(state==='ended'){fail(op,Error('VR 세션이 종료되었습니다.'));return;}
      if(state!=='active'){invalidateDisplay(op);cover(op,'session','세션 변경을 확인하는 중입니다. 편집값은 유지됩니다.');}
      else{cover(op,'session',null);mayStartFrame(op);}
    });
    try{
      mayStartFrame(op);await op.accessReady;op.preparationStarted=clock();const source=t.views.find(v=>v.id===t.source.viewportId),volume=cornerstone.cache.getVolume(source.getVolumeId());check(op);
      identity.textContent='CT · Patient '+t.source.study.id;sourceText.textContent='Study '+t.source.uid+' · Series '+t.source.series;
      // Keep the existing GL context, but allocate a separate actor and camera.
      // Private viewport creation must not trigger OHIF's crosshair reset binder.
      op.engine=source.getRenderingEngine();guardFrames(op);op.engine.enableElement({viewportId:op.id,type:cornerstone.Enums.ViewportType.VOLUME_3D,element:canvasHost,defaultOptions:{parallelProjection:true,suppressEvents:true}});op.view=op.engine.getViewport(op.id);op.view.suppressEvents=false;
      await op.view.setVolumes([{volumeId:volume.volumeId}]);mayStartFrame(op);check(op);op.imageData=volume.imageData;op.dimensions=Array.from(op.imageData?.getDimensions?.()||volume.dimensions||[]);KinVolumeRendering.validateCropBounds({i:[0,op.dimensions[0]-1],j:[0,op.dimensions[1]-1],k:[0,op.dimensions[2]-1]},op.dimensions);op.mapper=op.view.getActors()[0].actor.getMapper();const sourceMapper=source.getActors?.()[0]?.actor?.getMapper?.();if(!op.mapper||op.mapper===sourceMapper)throw Error('독립 VR 표시를 만들지 못했습니다.');
      op.view.resetCamera();op.base=structuredClone(op.view.getCamera());resetEditors(op);op.view.setCamera(KinVolumeRendering.orient(op.base,'Anterior'));op.base=structuredClone(op.view.getCamera());applyDisplay(true);op.ready=true;cover(op,'access',op.covers.get('access'));renderKnots();const locksAvailable=typeof navigator?.locks?.request==='function';writeButtons.forEach(button=>button.disabled=!locksAvailable);presetHelp.textContent=presetHelpText+(locksAvailable?'':' 이 브라우저에서는 안전한 프리셋 저장과 변경을 사용할 수 없습니다.');try{reloadLibrary(op,false);status.textContent=locksAvailable?'VR 원본을 표시했습니다.':'VR 원본을 표시했습니다. 안전한 개인 프리셋 저장은 이 브라우저에서 사용할 수 없습니다.';}catch(error){if(!current(op))throw error;status.textContent=error.message;}
    }catch(error){if(operation===op){close();throw error;}}
  }
  direction.onchange=()=>{const op=operation;if(!op?.view)return;try{check(op);op.view.setCamera(KinVolumeRendering.orient(op.view.getCamera(),direction.value));render(op);}catch(e){fail(op,e);}};
  transferMode.onchange=()=>renderKnots();addKnot.onclick=()=>{if(knots.length>=16)return;const last=knots.at(-1),previous=knots.at(-2),gap=Math.max(1,Number(last.hu)-Number(previous.hu));knots.push({hu:String(Math.min(65535,Number(last.hu)+gap)),color:last.color,opacity:last.opacity});renderKnots();};removeKnot.onclick=()=>{if(knots.length>2){knots.pop();renderKnots();}};
  apply.onclick=()=>applyDisplay();applyCropButton.onclick=()=>applyCrop();reset.onclick=()=>{const op=operation;if(!op?.view)return;try{check(op);sculpt.reset(op);op.view.setCamera(structuredClone(op.base));resetEditors(op);applyDisplay(true);if(typeof op.mapper.getClippingPlanes==='function'&&typeof op.mapper.addClippingPlane==='function'&&typeof op.mapper.removeAllClippingPlanes==='function')applyCrop(true,true);status.textContent='처음 VR 표시로 돌아왔습니다.';}catch(e){fail(op,e);}};
  savePreset.onclick=()=>changeLibrary('add');replacePreset.onclick=()=>changeLibrary('replace');deletePreset.onclick=()=>changeLibrary('delete');loadPreset.onclick=()=>{const op=operation;if(!op?.ready)return;try{check(op);if(libraryFailure)throw Error(libraryFailure);if(libraryStale)throw Error('다른 창에서 VR 프리셋 목록이 변경되었습니다. Reload Presets를 누르세요.');const item=selectedEntry();useDisplay(item.display);applyDisplay(true);status.textContent='VR 프리셋을 불러와 적용했습니다.';}catch(error){if(operation===op&&(!current(op)||error.kinVrDisplayChanged))fail(op,error);else status.textContent=error.message;}};reloadPresets.onclick=()=>{const op=operation;if(!op?.ready)return;try{reloadLibrary(op);}catch(error){if(operation===op&&!current(op))fail(op,error);else status.textContent=error.message;}};
  canvasHost.onpointerdown=e=>{const op=operation;if(drawing||e.button!==0||!op?.ready||!current(op))return;e.preventDefault();drag={id:e.pointerId,x:e.clientX,y:e.clientY};canvasHost.setPointerCapture(e.pointerId);};
  canvasHost.onpointermove=e=>{const op=operation;if(drawing||!drag||drag.id!==e.pointerId||!op?.ready||!current(op))return;e.preventDefault();try{const dx=Math.max(-180,Math.min(180,(e.clientX-drag.x)*.4)),dy=Math.max(-180,Math.min(180,(e.clientY-drag.y)*.4));drag.x=e.clientX;drag.y=e.clientY;op.view.setCamera(KinVolumeRendering.rotate(op.view.getCamera(),dx,dy));direction.value='Custom';render(op);}catch(error){fail(op,error);}};
  canvasHost.onpointerup=canvasHost.onpointercancel=()=>{drag=null;};canvasHost.onwheel=e=>{const op=operation;if(drawing){e.preventDefault();return;}if(!op?.ready||!current(op))return;e.preventDefault();try{const c=op.view.getCamera(),scale=Math.max(op.base.parallelScale/8,Math.min(op.base.parallelScale*8,c.parallelScale*Math.exp(Math.max(-1,Math.min(1,e.deltaY/500)))));op.view.setCamera({parallelScale:scale});render(op);}catch(error){fail(op,error);}};
  closeButton.onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  // Keep browser input/Tab/Escape behavior while isolating native viewer hotkeys.
  for(const name of ['keydown','keyup','keypress'])dialog.addEventListener(name,e=>e.stopPropagation(),true);
  const observer=new ResizeObserver(()=>{const op=operation;if(op?.ready&&current(op)&&!op.covers.size){try{sculpt.cancel();op.engine.resize(true,true);render(op);}catch(error){fail(op,error);}}});observer.observe(canvasHost);
  const windowResized=()=>{if(operation?.ready&&!operation.covers.size)sculpt.cancel();};window.addEventListener('resize',windowResized);
  const watch=()=>{const op=operation;if(op)mayStartFrame(op);};
  const timer=setInterval(watch,250);
  const visibilityChanged=()=>{const op=operation;if(!op)return;if(document.visibilityState==='hidden')invalidateDisplay(op);watch();};
  const pageHidden=()=>{const op=operation;if(op){op.pageHidden=true;invalidateDisplay(op);}};
  const pageShown=()=>{if(operation)operation.pageHidden=false;watch();};
  document.addEventListener('visibilitychange',visibilityChanged);window.addEventListener('pagehide',pageHidden);window.addEventListener('pageshow',pageShown);
  // Block edits without resetting any form, camera or sculpt draft. Close stays usable.
  for(const name of ['pointerdown','pointermove','pointerup','pointercancel','click','dblclick','wheel','keydown','beforeinput','input','change','contextmenu'])
    dialog.addEventListener(name,event=>{if(operation?.covers.size&&!closeButton.contains(event.target)){event.preventDefault();event.stopImmediatePropagation();}},true);
  const storageChanged=event=>{const op=operation;if(!op?.ready||!current(op)||!librarySnapshot||event.key!==null&&event.key!==librarySnapshot.key)return;libraryStale=true;libraryFailure=null;status.textContent='다른 창에서 VR 프리셋 목록이 변경되었습니다. 편집과 표시는 유지됩니다. Reload Presets를 누르세요.';};window.addEventListener('storage',storageChanged);
  return {open,setContextLoss(message){const op=operation;if(op){cover(op,'context',message||null);if(!message&&mayStartFrame(op)&&op.held&&op.view){op.held=false;render(op);}}},dispose(){ended=true;clearInterval(timer);document.removeEventListener('visibilitychange',visibilityChanged);window.removeEventListener('pagehide',pageHidden);window.removeEventListener('pageshow',pageShown);window.removeEventListener('storage',storageChanged);observer.disconnect();window.removeEventListener('resize',windowResized);close();sculpt.dispose();dialog.remove();}};
};
