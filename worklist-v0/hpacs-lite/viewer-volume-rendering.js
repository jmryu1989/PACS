window.kinCreateVolumeRendering=function({target,permitted,alive,owner,notice=()=>{}}){
  const el=(tag,text,parent)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;parent?.append(e);return e;};
  const dialog=el('dialog');dialog.id='kin-volume-rendering';dialog.style.cssText='background:#18212b;color:white;padding:16px;width:min(900px,92vw);max-height:94vh;overflow:auto';
  const style=el('style',undefined,dialog);style.textContent='#kin-volume-rendering{border:1px solid #6884a6;border-radius:8px;font:14px/1.5 system-ui}#kin-volume-rendering::backdrop{background:#0009}#kin-volume-rendering h2{font-size:20px;font-weight:700;margin:0 0 8px}#kin-volume-rendering p{margin:6px 0}#kin-volume-rendering fieldset{display:flex;flex-wrap:wrap;align-items:center;gap:10px;border:1px solid #52657e;border-radius:5px;padding:10px;margin:12px 0}#kin-volume-rendering legend{padding:0 5px}#kin-volume-rendering label{display:inline-flex;align-items:center;gap:5px}#kin-volume-rendering input,#kin-volume-rendering select{color:#17202a;background:white;border:1px solid #657c9f;border-radius:3px;padding:4px}#kin-volume-rendering button{padding:5px 10px;border:1px solid #6884a6;border-radius:4px;background:#263c57;color:white}#kin-volume-rendering button:hover{background:#3b5577}#kin-volume-rendering details{font-size:12px;overflow-wrap:anywhere;color:#c6d3e1}';
  el('h2','Volume Rendering',dialog);const identity=el('p','',dialog),sourceDetails=el('details',undefined,dialog);el('summary','Source Identifiers',sourceDetails);const sourceText=el('p','',sourceDetails);el('p','현재 로드된 CT 원본의 수동 3D 표시입니다. 색과 불투명도는 표시 조건이며 조직 판정이나 자동 분석 결과가 아닙니다.',dialog);
  const controls=el('fieldset',undefined,dialog);el('legend','VR Display',controls);
  const select=(label,values)=>{const l=el('label',label+' ',controls),s=el('select',undefined,l);s.setAttribute('aria-label',label);for(const value of values){const o=el('option',value,s);o.value=value;}return s;};
  const preset=select('VR Preset',['CT-Bone','CT-Soft-Tissue','CT-Fat']),direction=select('View From',['Custom',...window.KinVolumeRendering.directions]);direction.options[0].disabled=true;
  const opacityLabel=el('label',' Opacity (%) ',controls),opacity=el('input',undefined,opacityLabel);opacity.type='number';opacity.min=0;opacity.max=100;opacity.step=5;opacity.value=100;opacity.style.width='72px';opacity.setAttribute('aria-label','VR Opacity');
  const shadeLabel=el('label',' Shading ',controls),shade=el('input',undefined,shadeLabel);shade.type='checkbox';shade.checked=false;shade.setAttribute('aria-label','VR Shading');
  const apply=el('button','Apply Display',controls),reset=el('button','Reset VR',controls),closeButton=el('button','Close VR',dialog);
  const status=el('p','',dialog);status.setAttribute('role','status');el('p','드래그: 회전 · 휠: 확대/축소. 원래 MPR 평면·표식·판독 입력은 유지됩니다.',dialog);
  const canvasHost=el('div',undefined,dialog);canvasHost.dataset.kinVrRender='1';canvasHost.style.cssText='width:100%;height:min(60vh,600px);min-height:240px;background:black;touch-action:none';document.body.append(dialog);
  let ended=false,operation=null,drag=null;
  const current=op=>{try{const t=target(true,true);return !ended&&alive()&&dialog.open&&operation===op&&!op.controller.signal.aborted&&JSON.stringify(owner())===op.owner&&t?.group===op.target.group&&t.selection===op.target.selection&&t.views.every((v,i)=>v===op.target.views[i]);}catch(_){return false;}};
  function close(){const op=operation;operation=null;drag=null;controls.disabled=true;if(op){op.controller.abort();clearTimeout(op.timeout);clearTimeout(op.accessTimer);try{if(op.engine?.getViewport(op.id))op.engine.disableElement(op.id);}catch(_){} }canvasHost.replaceChildren();identity.textContent=sourceText.textContent='';sourceDetails.open=false;dialog.close();}
  function fail(op,error){if(operation!==op)return;close();notice('VR 표시를 닫았습니다. '+(error.message||'다시 열어 확인하세요.'));}
  function check(op){if(!current(op))throw Error('원본이나 계정이 변경되어 VR 표시를 닫았습니다.');}
  async function access(op){
    const get=async url=>{const r=await fetch(url,{credentials:'same-origin',cache:'no-store',headers:{'X-KIN-Subject':JSON.parse(op.owner)[1]},signal:op.controller.signal});if(!r.ok)throw Error('VR 원본 접근 권한을 확인하지 못했습니다.');return r.json();};
    const me=await get('/api/me');if(me.kind!=='member'||JSON.stringify([me.institution,me.sub])!==op.owner)throw Error('VR 계정이 변경되었습니다.');
    await get('/api/studies/'+encodeURIComponent(op.target.source.uid)+'/viewer-jobs');check(op);op.checkedAt=Date.now();
  }
  function render(op){check(op);op.view.render();}
  function applyDisplay(rethrow=false){const op=operation;if(!op?.view)return;let changed=false;try{
    check(op);const scale=Number(opacity.value);if(!opacity.value.trim()||!Number.isFinite(scale)||scale<0||scale>100)throw Error('불투명도를 0~100 범위로 입력하세요.');
    changed=true;op.view.setProperties({preset:preset.value});const property=op.view.getActors()[0].actor.getProperty(),curve=property.getScalarOpacity(0);
    for(let i=0;i<curve.getSize();i++){const node=[];curve.getNodeValue(i,node);node[1]*=scale/100;curve.setNodeValue(i,node);}property.setShade(shade.checked);render(op);status.textContent='VR 표시 조건을 적용했습니다.';
  }catch(error){if(rethrow===true)throw error;if(changed)fail(op,error);else status.textContent=error.message;}}
  async function open(){
    if(ended||operation||!alive()||!permitted()||window.kinViewerJobWorkspaceState?.().busy||window.kinVolumeBatchState?.busy?.()||window.kinMprRenderingState?.busy?.())return;
    const t=target(true);if(!t)throw Error('완전히 로드된 일반 CT의 MPR에서 여세요.');
    const bound=JSON.stringify(owner());if(!owner())throw Error('로그인 상태를 확인하세요.');
    const op={target:t,owner:bound,controller:new AbortController(),id:'kin-vr-'+crypto.randomUUID()};operation=op;dialog.showModal();controls.disabled=true;status.textContent='원본과 계정을 확인하는 중…';
    op.timeout=setTimeout(()=>fail(op,Error('VR 원본 확인 시간이 지났습니다. 다시 열어 주세요.')),30000);
    try{
      await access(op);const source=t.views.find(v=>v.id===t.source.viewportId),volume=cornerstone.cache.getVolume(source.getVolumeId());check(op);
      identity.textContent='CT · Patient '+t.source.study.id;sourceText.textContent='Study '+t.source.uid+' · Series '+t.source.series;
      // Keep the existing GL context, but allocate a separate actor and camera.
      // Private viewport creation must not trigger OHIF's crosshair reset binder.
      op.engine=source.getRenderingEngine();op.engine.enableElement({viewportId:op.id,type:cornerstone.Enums.ViewportType.VOLUME_3D,element:canvasHost,defaultOptions:{parallelProjection:true,suppressEvents:true}});op.view=op.engine.getViewport(op.id);op.view.suppressEvents=false;
      await op.view.setVolumes([{volumeId:volume.volumeId}]);check(op);op.view.resetCamera();op.base=structuredClone(op.view.getCamera());preset.value='CT-Bone';opacity.value='100';shade.checked=false;direction.value='Anterior';op.view.setCamera(KinVolumeRendering.orient(op.base,'Anterior'));op.base=structuredClone(op.view.getCamera());applyDisplay(true);clearTimeout(op.timeout);op.ready=true;controls.disabled=false;status.textContent='VR 원본을 표시했습니다.';
    }catch(error){if(operation===op){close();throw error;}}
  }
  direction.onchange=()=>{const op=operation;if(!op?.view)return;try{check(op);op.view.setCamera(KinVolumeRendering.orient(op.view.getCamera(),direction.value));render(op);}catch(e){fail(op,e);}};
  apply.onclick=()=>applyDisplay();reset.onclick=()=>{const op=operation;if(!op?.view)return;try{check(op);op.view.setCamera(structuredClone(op.base));preset.value='CT-Bone';opacity.value='100';shade.checked=false;direction.value='Anterior';applyDisplay(true);status.textContent='처음 VR 표시로 돌아왔습니다.';}catch(e){fail(op,e);}};
  canvasHost.onpointerdown=e=>{const op=operation;if(e.button!==0||!op?.ready||!current(op))return;e.preventDefault();drag={id:e.pointerId,x:e.clientX,y:e.clientY};canvasHost.setPointerCapture(e.pointerId);};
  canvasHost.onpointermove=e=>{const op=operation;if(!drag||drag.id!==e.pointerId||!op?.ready||!current(op))return;e.preventDefault();try{const dx=Math.max(-180,Math.min(180,(e.clientX-drag.x)*.4)),dy=Math.max(-180,Math.min(180,(e.clientY-drag.y)*.4));drag.x=e.clientX;drag.y=e.clientY;op.view.setCamera(KinVolumeRendering.rotate(op.view.getCamera(),dx,dy));direction.value='Custom';render(op);}catch(error){fail(op,error);}};
  canvasHost.onpointerup=canvasHost.onpointercancel=()=>{drag=null;};canvasHost.onwheel=e=>{const op=operation;if(!op?.ready||!current(op))return;e.preventDefault();try{const c=op.view.getCamera(),scale=Math.max(op.base.parallelScale/8,Math.min(op.base.parallelScale*8,c.parallelScale*Math.exp(Math.max(-1,Math.min(1,e.deltaY/500)))));op.view.setCamera({parallelScale:scale});render(op);}catch(error){fail(op,error);}};
  closeButton.onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  // Keep browser input/Tab/Escape behavior while isolating native viewer hotkeys.
  for(const name of ['keydown','keyup','keypress'])dialog.addEventListener(name,e=>e.stopPropagation(),true);
  const observer=new ResizeObserver(()=>{const op=operation;if(op?.ready&&current(op)){try{op.engine.resize(true,true);render(op);}catch(error){fail(op,error);}}});observer.observe(canvasHost);
  const timer=setInterval(()=>{const op=operation;if(!op)return;if(!current(op)){fail(op,Error('원본·선택 또는 계정이 변경되었습니다.'));return;}if(op.view&&!op.checking&&Date.now()-op.checkedAt>15000){op.checking=true;op.accessTimer=setTimeout(()=>fail(op,Error('VR 접근 확인 시간이 지났습니다.')),15000);access(op).catch(error=>fail(op,error)).finally(()=>{op.checking=false;clearTimeout(op.accessTimer);});}},250);
  return {open,dispose(){ended=true;clearInterval(timer);observer.disconnect();close();dialog.remove();}};
};
