window.kinCreateVolumeMip=function({target,permitted,alive,owner,notice=()=>{}}){
  const model=window.KinVolumeMip,el=(tag,text,parent)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;parent?.append(e);return e;};
  const dialog=el('dialog');dialog.id='kin-volume-mip';dialog.style.cssText='background:#18212b;color:white;padding:16px';
  const style=el('style',undefined,dialog);style.textContent='#kin-volume-mip{width:min(1180px,96vw);height:min(820px,92vh);overflow:hidden;box-sizing:border-box;border:1px solid #6884a6;border-radius:8px;font:14px/1.5 system-ui;display:grid;grid-template-columns:minmax(300px,380px) minmax(0,1fr);column-gap:16px}#kin-volume-mip:not([open]){display:none}#kin-volume-mip::backdrop{background:#0009}#kin-volume-mip .kin-mip-side{min-height:0;overflow:auto;padding-right:6px}#kin-volume-mip h2{font-size:20px;font-weight:700;margin:0 0 8px}#kin-volume-mip p{margin:6px 0}#kin-volume-mip fieldset{display:flex;flex-wrap:wrap;align-items:center;gap:10px;border:1px solid #52657e;border-radius:5px;padding:10px;margin:12px 0}#kin-volume-mip legend{padding:0 5px}#kin-volume-mip label{display:inline-flex;align-items:center;gap:5px}#kin-volume-mip select{color:#17202a;background:white;border:1px solid #657c9f;border-radius:3px;padding:4px}#kin-volume-mip button{padding:5px 10px;border:1px solid #6884a6;border-radius:4px;background:#263c57;color:white}#kin-volume-mip button:hover{background:#3b5577}#kin-volume-mip details{font-size:12px;overflow-wrap:anywhere;color:#c6d3e1}#kin-volume-mip .kin-mip-canvas-pane{position:relative;min-width:0;min-height:0;display:flex;background:#000}#kin-volume-mip .kin-mip-label{position:absolute;left:10px;bottom:10px;pointer-events:none;color:#6de6ff;background:#00131dcc;padding:2px 5px;font-size:12px}@media(max-width:1000px){#kin-volume-mip{display:block;width:min(900px,96vw);height:auto;max-height:94vh;overflow:auto}#kin-volume-mip .kin-mip-canvas-pane{height:min(60vh,600px);min-height:300px}}';
  const side=el('div',undefined,dialog);side.className='kin-mip-side';el('h2','MIP Viewer',side);
  const identity=el('p','',side),sourceDetails=el('details',undefined,side);el('summary','Source Identifiers',sourceDetails);const sourceText=el('p','',sourceDetails);
  el('p','현재 로드된 CT 볼륨 전체를 선택한 방향으로 투영하는 수동 표시입니다. MIP는 최댓값, MinIP는 최솟값, Raysum은 광선 경로 표본의 평균이며 합계가 아닙니다. 원본 DICOM과 MPR·VR 표시는 바꾸지 않습니다. 조작성 평가 가능·진단 품질 미검증.',side);
  const controls=el('fieldset',undefined,side);el('legend','MIP Display',controls);
  const select=(label,values)=>{const l=el('label',label+' ',controls),s=el('select',undefined,l);s.setAttribute('aria-label','MIP '+label);for(const value of values){const o=el('option',value,s);o.value=value;}return s;};
  const projection=select('Projection',model.modes),orientation=select('Orientation',model.orientations);
  const render=el('p','',side);render.className='kin-mip-render';const status=el('p','',side);status.setAttribute('role','status');
  el('p','선택을 바꾸면 최종 렌더를 확인한 뒤 Final로 표시합니다. 확인 전 화면은 Rendering으로 표시하며 결과로 쓰지 않습니다. 밝기 범위는 MIP Viewer를 열 때의 MPR 값을 따릅니다.',side);
  const closeButton=el('button','Close MIP Viewer',side);
  const canvasPane=el('div',undefined,dialog);canvasPane.className='kin-mip-canvas-pane';const canvasHost=el('div',undefined,canvasPane);canvasHost.dataset.kinMipRender='1';canvasHost.style.cssText='width:100%;height:100%;min-height:0;background:black';
  const label=el('span','',canvasPane);label.className='kin-mip-label';document.body.append(dialog);controls.disabled=true;
  let ended=false,operation=null;
  const current=op=>{try{const t=target(true,true,{requireRenderReady:false});return !ended&&alive()&&dialog.open&&operation===op&&!op.controller.signal.aborted&&JSON.stringify(owner())===op.owner&&t?.group===op.target.group&&t.selection===op.target.selection&&t.views.every((v,i)=>v===op.target.views[i])&&(!op.view||op.engine?.getViewport(op.id)===op.view&&op.view.getVolumeId()===op.volume.volumeId&&cornerstone.cache.getVolume(op.volume.volumeId)===op.volume&&op.source.getVolumeId()===op.volume.volumeId);}catch(_){return false;}};
  function close(){
    const op=operation;operation=null;controls.disabled=true;
    if(op){op.controller.abort();op.sequence?.dispose();clearTimeout(op.timeout);clearTimeout(op.accessTimer);for(const cancel of [...op.pending])cancel();try{if(op.engine?.getViewport(op.id))op.engine.disableElement(op.id);}catch(_){}}
    canvasHost.replaceChildren();identity.textContent=sourceText.textContent=label.textContent=render.textContent='';sourceDetails.open=false;delete dialog.dataset.kinMipState;if(dialog.open)dialog.close();
  }
  function fail(op,error){if(operation!==op)return;close();notice('MIP Viewer를 닫았습니다. '+(error?.message||'다시 열어 확인하세요.'));}
  function check(op){if(!current(op))throw Error('원본이나 계정이 변경되어 MIP Viewer를 닫았습니다.');}
  async function access(op){
    const get=async url=>{const r=await fetch(url,{credentials:'same-origin',cache:'no-store',headers:{'X-KIN-Subject':JSON.parse(op.owner)[1]},signal:op.controller.signal});if(!r.ok)throw Error('MIP 원본 접근 권한을 확인하지 못했습니다.');return r.json();};
    const me=await get('/api/me');if(me.kind!=='member'||JSON.stringify([me.institution,me.sub])!==op.owner)throw Error('MIP Viewer 계정이 변경되었습니다.');
    await get('/api/studies/'+encodeURIComponent(op.target.source.uid)+'/viewer-jobs');check(op);op.checkedAt=Date.now();
  }
  function show(op,{status:state,request,message}){
    if(operation!==op)return;
    if(request){projection.value=request.mode;orientation.value=request.orientation;}
    const text=request?model.describe(request,op.thickness):'';dialog.dataset.kinMipState=state;
    label.textContent=state==='final'?text+' · Final':'Rendering · 최종 표시 전';render.textContent=state==='final'?'Final · '+text:'Rendering · 최종 렌더 확인 중';
    if(message!==undefined)status.textContent=message;
  }
  function readState(op){
    const actors=op.view.getActors(),actor=actors[0]?.actor,mapper=actor?.getMapper(),camera=op.view.getCamera();
    return {actors:actors.length,volumeId:op.view.getVolumeId(),blend:mapper?.getBlendMode(),viewPlaneNormal:camera.viewPlaneNormal,viewUp:camera.viewUp,planes:(mapper?.getClippingPlanes()||[]).map(p=>({origin:p.getOrigin(),normal:p.getNormal()})),sampleDistance:mapper?.getSampleDistance(),interpolationType:actor?.getProperty().getInterpolationType(),voiRange:op.view.getProperties()?.voiRange};
  }
  function expected(op,request){const p=model.preset(cornerstone.CONSTANTS?.MPR_CAMERA_VALUES,request.orientation);return {volumeId:op.volume.volumeId,blend:model.blendMode(request.mode),viewPlaneNormal:p.viewPlaneNormal,viewUp:p.viewUp,thickness:op.thickness,corners:op.corners,sampleDistance:op.sampleDistance,interpolationType:op.display.interpolationType,voiRange:op.display.voiRange};}
  // Every request writes the whole display (orientation, blend and slab), so a rollback never inherits a partial write.
  function apply(op,request){
    check(op);const next=model.normalizeRequest(request),want=expected(op,next);
    if(want.blend===3){if(typeof window.kinPrepareVolumeAverage!=='function')throw Error('Raysum 평균 계산 모듈을 확인할 수 없어 적용하지 않았습니다.');window.kinPrepareVolumeAverage(op.view,op.volume);}
    // The pinned setOrientation applies MPR_CAMERA_VALUES and resets to the volume centre; the slab planes are
    // re-derived explicitly afterwards because a camera change alone keeps the previous planes.
    op.view.setOrientation(model.preset(cornerstone.CONSTANTS?.MPR_CAMERA_VALUES,next.orientation).key,false);op.view.setBlendMode(want.blend);op.view.setSlabThickness(op.thickness/2);
    const problem=model.verifyState(readState(op),want);if(problem)throw Error(problem);
  }
  function gpuProblem(op,request){
    const node=op.engine.offscreenMultiRenderWindow?.getOpenGLRenderWindow?.()?.getViewNodeFor?.(op.mapper),program=node?.get?.('tris')?.tris?.getProgram?.();
    if(!program?.getCompiled?.()||!program.getLinked?.())return '투영 셰이더를 GPU에서 확인하지 못했습니다.';
    if(model.blendMode(request.mode)===3&&!model.averageShader(program.getFragmentShader().getSource()))return 'Raysum 평균 셰이더를 확인하지 못했습니다.';
    return '';
  }
  // Final means a native frame rendered after this request and the state read in that same event still matches it.
  function confirm(op,request){
    return new Promise((resolve,reject)=>{
      const name=cornerstone.Enums.Events.IMAGE_RENDERED,element=canvasHost;let timer,finished=false;
      const finish=error=>{if(finished)return;finished=true;element.removeEventListener(name,rendered);clearTimeout(timer);op.pending.delete(cancel);error?reject(error):resolve();};
      const cancel=()=>finish(Error('MIP Viewer를 닫았습니다.'));
      const rendered=()=>{try{check(op);const problem=model.verifyState(readState(op),expected(op,request))||gpuProblem(op,request);finish(problem?Error(problem):null);}catch(error){finish(error);}};
      op.pending.add(cancel);element.addEventListener(name,rendered);timer=setTimeout(()=>finish(Error('최종 렌더를 확인하지 못했습니다.')),15000);
      try{check(op);op.view.render();}catch(error){finish(error);}
    });
  }
  function blocked(op){
    if(!current(op)){fail(op,Error('원본·선택 또는 계정이 변경되었습니다.'));return '원본·선택 또는 계정이 변경되었습니다.';}
    if([...document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"],.modal.show')].some(e=>e!==dialog&&!dialog.contains(e)))return '다른 창을 닫은 뒤 Projection이나 Orientation을 바꾸세요.';
    if(window.kinViewerJobWorkspaceState?.().busy)return '영상 작업 처리가 끝난 뒤 Projection이나 Orientation을 바꾸세요.';
    if(window.kinVolumeBatchState?.busy?.())return 'MPR batch가 끝난 뒤 Projection이나 Orientation을 바꾸세요.';
    if(window.kinMprRenderingState?.busy?.())return 'MPR preview 정리가 끝난 뒤 Projection이나 Orientation을 바꾸세요.';
    // A standalone viewer's permission also requires that no dialog is open, which this dialog itself always fails;
    // the query above keeps that gate for every other dialog. An embedded viewer's gate is the reading page's.
    if(window.top!==window&&!permitted())return '판독 화면의 다른 작업을 마친 뒤 Projection이나 Orientation을 바꾸세요.';
    return '';
  }
  async function open(){
    if(ended||operation||!alive()||!permitted()||window.kinViewerJobWorkspaceState?.().busy||window.kinVolumeBatchState?.busy?.()||window.kinMprRenderingState?.busy?.())return;
    const t=target(true);if(!t)throw Error('완전히 로드된 일반 CT의 MPR에서 여세요.');
    const capturedOwner=owner();if(!capturedOwner)throw Error('로그인 상태를 확인하세요.');
    const op={target:t,owner:JSON.stringify(model.normalizeOwner(capturedOwner)),controller:new AbortController(),id:'kin-mip-'+crypto.randomUUID(),pending:new Set()};operation=op;
    dialog.showModal();controls.disabled=true;dialog.dataset.kinMipState='pending';label.textContent='Rendering · 최종 표시 전';render.textContent='Rendering · 원본 확인 중';status.textContent='원본과 계정을 확인하는 중…';
    op.timeout=setTimeout(()=>fail(op,Error('MIP 원본 확인 시간이 지났습니다. 다시 열어 주세요.')),30000);
    try{
      await access(op);const source=t.views.find(v=>v.id===t.source.viewportId),volume=cornerstone.cache.getVolume(source.getVolumeId());check(op);
      if(!cornerstone.Enums?.Events?.IMAGE_RENDERED||!cornerstone.Enums?.ViewportType?.ORTHOGRAPHIC)throw Error('MIP Viewer의 최종 렌더 확인 기능을 찾지 못했습니다.');
      for(const name of model.orientations)model.preset(cornerstone.CONSTANTS?.MPR_CAMERA_VALUES,name);
      op.volume=volume;op.source=source;op.thickness=model.projectionThickness(volume.dimensions,volume.spacing);op.sampleDistance=model.sampleDistance(volume.spacing);op.corners=model.corners(volume.dimensions,index=>volume.imageData.indexToWorld(index));
      const properties=source.getProperties()||{},voi=properties.voiRange;
      op.display={interpolationType:source.getActors()[0].actor.getProperty().getInterpolationType(),voiRange:{lower:Number(voi?.lower),upper:Number(voi?.upper)}};
      if(![op.display.voiRange.lower,op.display.voiRange.upper].every(Number.isFinite)||op.display.voiRange.upper<=op.display.voiRange.lower)throw Error('MPR 밝기 범위를 확인할 수 없습니다.');
      identity.textContent='CT · Patient '+t.source.study.id;sourceText.textContent='Study '+t.source.uid+' · Series '+t.source.series;
      // An orthographic volume viewport, not the VR type: the pinned VolumeViewport3D ignores blend mode and slab thickness.
      // It shares the GL context but owns its actor and camera; suppressed creation keeps OHIF's viewport binders off it.
      op.engine=source.getRenderingEngine();op.engine.enableElement({viewportId:op.id,type:cornerstone.Enums.ViewportType.ORTHOGRAPHIC,element:canvasHost,defaultOptions:{orientation:'axial',background:[0,0,0],suppressEvents:true}});op.view=op.engine.getViewport(op.id);op.view.suppressEvents=false;
      await op.view.setVolumes([{volumeId:volume.volumeId}]);check(op);
      op.mapper=op.view.getActors()[0]?.actor?.getMapper?.();
      if(op.view.getActors().length!==1||!op.mapper||op.mapper===source.getActors()[0].actor.getMapper())throw Error('독립 MIP 표시를 만들지 못했습니다.');
      if(['setOrientation','setBlendMode','setSlabThickness','setProperties'].some(n=>typeof op.view[n]!=='function')||['getBlendMode','getClippingPlanes','getSampleDistance'].some(n=>typeof op.mapper[n]!=='function'))throw Error('고정 뷰어에서 MIP 투영 기능을 확인하지 못했습니다.');
      op.view.setProperties({voiRange:op.display.voiRange,interpolationType:op.display.interpolationType},undefined,true);
      clearTimeout(op.timeout);
      op.sequence=model.createSequence({apply:request=>apply(op,request),confirm:request=>confirm(op,request),blocked:()=>blocked(op),closed:()=>operation!==op,show:state=>show(op,state),fatal:error=>fail(op,error),describe:request=>model.describe(request,op.thickness)});
      op.ready=true;controls.disabled=false;await op.sequence.start({mode:'MIP',orientation:'Axial'});
    }catch(error){if(operation===op){close();throw error;}}
  }
  const changed=()=>{const op=operation;if(!op?.ready)return;if(!current(op)){fail(op,Error('원본·선택 또는 계정이 변경되었습니다.'));return;}op.sequence.request({mode:projection.value,orientation:orientation.value});};
  projection.onchange=orientation.onchange=changed;
  closeButton.onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  // Keep browser input/Tab/Escape behavior while isolating native viewer hotkeys.
  for(const name of ['keydown','keyup','keypress'])dialog.addEventListener(name,e=>e.stopPropagation(),true);
  const observer=new ResizeObserver(()=>{const op=operation;if(op?.ready&&current(op)){try{op.engine.resize(true,true);}catch(error){fail(op,error);}}});observer.observe(canvasHost);
  const timer=setInterval(()=>{const op=operation;if(!op)return;if(!current(op)){fail(op,Error('원본·선택 또는 계정이 변경되었습니다.'));return;}if(op.ready&&!op.checking&&Date.now()-op.checkedAt>15000){op.checking=true;op.accessTimer=setTimeout(()=>fail(op,Error('MIP 접근 확인 시간이 지났습니다.')),15000);access(op).catch(error=>fail(op,error)).finally(()=>{op.checking=false;clearTimeout(op.accessTimer);});}},250);
  return {open,dispose(){ended=true;clearInterval(timer);observer.disconnect();close();dialog.remove();}};
};
