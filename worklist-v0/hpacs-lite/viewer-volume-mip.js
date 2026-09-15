window.kinCreateVolumeMip=function({target,permitted,alive,owner,notice=()=>{}}){
  const model=window.KinVolumeMip,el=(tag,text,parent)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;parent?.append(e);return e;};
  const dialog=el('dialog');dialog.id='kin-volume-mip';dialog.style.cssText='background:#18212b;color:white;padding:16px';
  const style=el('style',undefined,dialog);style.textContent='#kin-volume-mip{width:min(1180px,96vw);height:min(820px,92vh);overflow:hidden;box-sizing:border-box;border:1px solid #6884a6;border-radius:8px;font:14px/1.5 system-ui;display:grid;grid-template-columns:minmax(300px,380px) minmax(0,1fr);column-gap:16px}#kin-volume-mip:not([open]){display:none}#kin-volume-mip::backdrop{background:#0009}#kin-volume-mip .kin-mip-side{min-height:0;overflow:auto;padding-right:6px}#kin-volume-mip h2{font-size:20px;font-weight:700;margin:0 0 8px}#kin-volume-mip p{margin:6px 0}#kin-volume-mip fieldset{display:flex;flex-wrap:wrap;align-items:center;gap:10px;border:1px solid #52657e;border-radius:5px;padding:10px;margin:12px 0}#kin-volume-mip legend{padding:0 5px}#kin-volume-mip label{display:inline-flex;align-items:center;gap:5px}#kin-volume-mip select{color:#17202a;background:white;border:1px solid #657c9f;border-radius:3px;padding:4px}#kin-volume-mip button{padding:5px 10px;border:1px solid #6884a6;border-radius:4px;background:#263c57;color:white}#kin-volume-mip button:hover{background:#3b5577}#kin-volume-mip input:not([type=checkbox]){width:76px;color:#17202a;background:white;border:1px solid #657c9f;border-radius:3px;padding:3px}#kin-volume-mip .kin-mip-voi-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%}#kin-volume-mip .kin-mip-voi p{width:100%}#kin-volume-mip details{font-size:12px;overflow-wrap:anywhere;color:#c6d3e1}#kin-volume-mip .kin-mip-canvas-pane{position:relative;min-width:0;min-height:0;display:flex;background:#000}#kin-volume-mip .kin-mip-label{position:absolute;left:10px;bottom:10px;pointer-events:none;color:#6de6ff;background:#00131dcc;padding:2px 5px;font-size:12px}@media(max-width:1000px){#kin-volume-mip{display:block;width:min(900px,96vw);height:auto;max-height:94vh;overflow:auto}#kin-volume-mip .kin-mip-canvas-pane{height:min(60vh,600px);min-height:300px}}';
  const side=el('div',undefined,dialog);side.className='kin-mip-side';el('h2','MIP Viewer',side);
  const identity=el('p','',side),sourceDetails=el('details',undefined,side);el('summary','Source Identifiers',sourceDetails);const sourceText=el('p','',sourceDetails);
  el('p','현재 로드된 CT 볼륨 전체를 선택한 방향으로 투영하는 수동 표시입니다. MIP는 최댓값, MinIP는 최솟값, Raysum은 광선 경로 표본의 평균이며 합계가 아닙니다. 원본 DICOM과 MPR·VR 표시는 바꾸지 않습니다. 조작성 평가 가능·진단 품질 미검증.',side);
  const controls=el('fieldset',undefined,side);el('legend','MIP Display',controls);
  const select=(label,values)=>{const l=el('label',label+' ',controls),s=el('select',undefined,l);s.setAttribute('aria-label','MIP '+label);for(const value of values){const o=el('option',value,s);o.value=value;}return s;};
  const projection=select('Projection',model.modes),orientation=select('Orientation',model.orientations);
  // VOI Slab editors are a draft; only Apply, Move, Rotate, Undo, Reset and Original request a display change.
  const voi=el('fieldset',undefined,side);voi.className='kin-mip-voi';el('legend','VOI Slab',voi);
  const voiRow=()=>{const row=el('div',undefined,voi);row.className='kin-mip-voi-row';return row;};
  const voiField=(row,name,title,type='number')=>{const l=el('label',name+' ',row),i=el('input',undefined,l);i.type=type;if(type==='number')i.step='any';i.setAttribute('aria-label','VOI Slab '+name);i.title=title;return i;};
  const voiSelect=(row,name,values,title)=>{const l=el('label',name+' ',row),s=el('select',undefined,l);s.setAttribute('aria-label','VOI Slab '+name);s.title=title;for(const value of values){const o=el('option',value,s);o.value=value;}return s;};
  const voiButton=(row,text,title)=>{const b=el('button',text,row);b.type='button';b.title=title;return b;};
  let voiLine=voiRow();
  const voiEnable=voiField(voiLine,'Enable','체크한 채 Apply VOI Slab을 누르면 VOI Slab을 켜고, 해제한 채 누르면 끕니다.','checkbox');
  const voiPreset=voiSelect(voiLine,'Preset',model.orientations,'선택한 방향으로 CT 전체를 덮는 기본 VOI Slab 값을 입력합니다. 적용은 Apply VOI Slab으로 합니다.');
  const voiOriginal=voiField(voiLine,'Original','VOI Slab과 되돌리기 기록을 유지한 채 자르지 않은 Final 표시를 봅니다. 해제하면 같은 VOI Slab을 다시 적용합니다.','checkbox');
  voiLine=voiRow();const voiCenter=['L','P','S'].map(axis=>voiField(voiLine,'Center '+axis,'VOI Slab 중심의 환자 좌표(LPS, mm)입니다.'));
  voiLine=voiRow();const voiPivot=['L','P','S'].map(axis=>voiField(voiLine,'Pivot '+axis,'회전 기준점의 환자 좌표(LPS, mm)입니다.'));
  voiLine=voiRow();const voiThickness=voiField(voiLine,'Thickness','VOI Slab 두께(mm)입니다. 이 범위 밖의 복셀은 투영 계산에 쓰지 않습니다.'),voiNormal=el('span','',voiLine);
  voiLine=voiRow();const voiMove=voiField(voiLine,'Move','법선 방향으로 옮길 거리(mm)입니다. 음수는 반대 방향입니다.'),voiMoveButton=voiButton(voiLine,'Move Slab','입력한 거리만큼 VOI Slab을 옮겨 적용합니다.');
  voiLine=voiRow();const voiAxis=voiSelect(voiLine,'Rotate Axis',['L','P','S'],'회전축(환자 좌표 L/P/S)입니다.'),voiDegrees=voiField(voiLine,'Rotate Degrees','기준점을 중심으로 돌릴 각도(도, -180~180)입니다.'),voiRotateButton=voiButton(voiLine,'Rotate Slab','입력한 각도만큼 VOI Slab을 돌려 적용합니다.');
  voiLine=voiRow();const voiApply=voiButton(voiLine,'Apply VOI Slab','입력한 VOI Slab을 MIP Viewer 표시에 적용합니다.'),voiUndoButton=voiButton(voiLine,'Undo VOI','직전에 Final로 확인한 VOI Slab 상태로 되돌립니다.'),voiReset=voiButton(voiLine,'Reset VOI','VOI Slab을 끄고 입력값을 기본값으로 되돌립니다. Undo VOI로 되돌릴 수 있습니다.');
  const voiState=el('p','',voi);voiState.className='kin-mip-voi-state';const voiNote=el('p','',voi);voiNote.className='kin-mip-voi-note';
  el('p','VOI Slab은 이 MIP Viewer 화면에만 적용되는 표시 조건이며 MPR·VR·batch·출력에는 적용되지 않습니다. Save MIP Job으로 저장할 때만 3평면 MPR과 함께 영상 작업(Job)에 저장되고, 저장하지 않고 창을 닫으면 사라집니다. 원본 DICOM과 밝기 범위(W/L)는 바뀌지 않습니다. 작업 저장은 영상 반출이 아닙니다. 범위 밖 복셀은 투영 계산에서 제외하고, 범위 안 표본이 없는 광선은 0 HU가 아니라 배경으로 표시합니다.',voi).className='kin-mip-voi-scope';
  voi.disabled=true;let voiDraftNormal=null;
  const render=el('p','',side);render.className='kin-mip-render';const status=el('p','',side);status.setAttribute('role','status');
  el('p','선택을 바꾸면 최종 렌더를 확인한 뒤 Final로 표시합니다. 확인 전 화면은 Rendering으로 표시하며 결과로 쓰지 않습니다. 밝기 범위는 MIP Viewer를 열 때의 MPR 값을 따릅니다.',side);
  // Save lives in this modal because the Jobs panel behind it is inert while it is open. The request itself goes through the
  // Jobs panel's own request path (window.kinViewerJobCommand); this dialog never writes a Job by itself.
  const jobs=window.KinVolumeMipJob,saveState=jobs?.createSaveState()||null;
  style.textContent+='#kin-volume-mip .kin-mip-job label{display:flex;flex-direction:column;align-items:stretch;width:100%}#kin-volume-mip .kin-mip-job input:not([type=checkbox]),#kin-volume-mip .kin-mip-job textarea{width:100%;box-sizing:border-box;color:#17202a;background:white;border:1px solid #657c9f;border-radius:3px;padding:3px}#kin-volume-mip .kin-mip-job p{width:100%}';
  const jobBox=el('fieldset',undefined,side);jobBox.className='kin-mip-job';el('legend','MIP Job',jobBox);
  const jobField=(name,tag,max)=>{const l=el('label',name+' ',jobBox),input=el(tag,undefined,l);input.maxLength=max;input.setAttribute('aria-label',name);return input;};
  const jobTitle=jobField('MIP Job Title','input',120),jobDescription=jobField('MIP Job Description','textarea',2000);
  const jobSave=el('button','Save MIP Job',jobBox),jobRetry=el('button','Retry MIP Save',jobBox);jobSave.type=jobRetry.type='button';
  jobSave.title='현재 Final 표시(Projection·Orientation·VOI Slab)를 3평면 MPR과 함께 영상 작업(Job)으로 저장합니다.';
  jobRetry.title='응답을 확인하지 못한 같은 저장 요청을 다시 보냅니다. 서버는 같은 요청을 한 번만 저장합니다.';
  const jobNote=el('p','',jobBox);jobNote.className='kin-mip-job-note';jobBox.disabled=true;
  const closeButton=el('button','Close MIP Viewer',side);
  const canvasPane=el('div',undefined,dialog);canvasPane.className='kin-mip-canvas-pane';const canvasHost=el('div',undefined,canvasPane);canvasHost.dataset.kinMipRender='1';canvasHost.style.cssText='width:100%;height:100%;min-height:0;background:black';
  const label=el('span','',canvasPane);label.className='kin-mip-label';document.body.append(dialog);controls.disabled=true;
  let ended=false,operation=null;
  const current=op=>{try{const t=target(true,true,{requireRenderReady:false});return !ended&&alive()&&dialog.open&&operation===op&&(!op.restoring||op.restoring.current())&&!op.controller.signal.aborted&&JSON.stringify(owner())===op.owner&&t?.group===op.target.group&&t.selection===op.target.selection&&t.views.every((v,i)=>v===op.target.views[i])&&(!op.view||op.engine?.getViewport(op.id)===op.view&&op.view.getVolumeId()===op.volume.volumeId&&cornerstone.cache.getVolume(op.volume.volumeId)===op.volume&&op.source.getVolumeId()===op.volume.volumeId);}catch(_){return false;}};
  function close(){
    const op=operation;operation=null;controls.disabled=voi.disabled=jobBox.disabled=true;
    // Nothing unsaved outlives the dialog: a VOI Slab persists only inside a MIP Job saved with Save MIP Job.
    voiEnable.checked=voiOriginal.checked=false;voiDraftNormal=null;voiState.textContent=voiNote.textContent=voiNormal.textContent='';for(const input of [...voiCenter,...voiPivot,voiThickness,voiMove,voiDegrees])input.value='';
    saveState?.open(null);jobTitle.value=jobDescription.value=jobNote.textContent='';
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
    if(request){projection.value=request.mode;orientation.value=request.orientation;voiOriginal.checked=request.original===true;}
    const text=request?model.describe(request,op.thickness):'';dialog.dataset.kinMipState=state;
    label.textContent=state==='final'?text+' · Final':'Rendering · 최종 표시 전';render.textContent=state==='final'?'Final · '+text:'Rendering · 최종 렌더 확인 중';
    voiState.textContent=voiSummary(op,state,request);
    if(message!==undefined)status.textContent=message;
    refreshJob(op);
  }
  // The VOI Slab summary ends with the Job state of the display actually shown: Saved only for the saved block itself.
  function jobBlock(op){try{return jobs.block(op.sequence.snapshot(),{frameOfReference:op.frameOfReference,display:op.display});}catch(_){return null;}}
  function voiSummary(op,state,request){
    const saved=state==='final'&&saveState&&op.sequence?saveState.label(op,jobBlock(op)):'Not Saved';
    return state!=='final'?'VOI Slab · Rendering · '+saved:!request?.voiSlab?'VOI Slab · Off · '+saved:request.original?'VOI Slab · Original View · '+saved:'VOI Slab · On · '+Number(request.voiSlab.thickness.toFixed(1))+' mm · '+saved;
  }
  function paintJob(op){
    if(operation!==op||!op.sequence)return;
    const {state,final,applied}=op.sequence.snapshot();voiState.textContent=voiSummary(op,state,state==='final'?final:applied);refreshJob(op);
  }
  // Save MIP Job needs a radiologist account and a ready display; Retry MIP Save only the kept body of this very block.
  function refreshJob(op){
    if(!op||operation!==op)return;
    const command=window.kinViewerJobCommand,ask=read=>{try{return read();}catch(_){return null;}};
    const ready=!!op.ready&&!op.restoring&&!!saveState&&!!command,writable=ready&&!!ask(()=>command.writable());
    jobBox.disabled=!op.ready||!!op.restoring;
    jobSave.disabled=!writable||saveState.saving(op);
    const kept=writable?ask(()=>command.pending()):null,shown=kept?.version===12?jobBlock(op):null;
    jobRetry.disabled=jobSave.disabled||!shown||!jobs.same(kept.mip,shown);
    jobNote.textContent=!saveState||!command?'영상 작업 저장 도구를 확인할 수 없어 MIP 작업을 저장할 수 없습니다. 영상 창을 새로고침하세요.':ready&&!writable?'판독의 계정에서 MIP 작업을 저장할 수 있습니다.':'';
  }
  function readState(op){
    const actors=op.view.getActors(),actor=actors[0]?.actor,mapper=actor?.getMapper(),camera=op.view.getCamera();
    return {actors:actors.length,volumeId:op.view.getVolumeId(),blend:mapper?.getBlendMode(),viewPlaneNormal:camera.viewPlaneNormal,viewUp:camera.viewUp,planes:(mapper?.getClippingPlanes()||[]).map(p=>({origin:p.getOrigin(),normal:p.getNormal()})),sampleDistance:mapper?.getSampleDistance(),interpolationType:actor?.getProperty().getInterpolationType(),voiRange:op.view.getProperties()?.voiRange};
  }
  function expected(op,request){const p=model.preset(cornerstone.CONSTANTS?.MPR_CAMERA_VALUES,request.orientation);return {volumeId:op.volume.volumeId,blend:model.blendMode(request.mode),viewPlaneNormal:p.viewPlaneNormal,viewUp:p.viewUp,thickness:op.thickness,corners:op.corners,sampleDistance:op.sampleDistance,interpolationType:op.display.interpolationType,voiRange:op.display.voiRange,voiSlab:request.original?null:request.voiSlab??null,affine:op.binding.affine};}
  // The affine captured at open is the VOI Slab's coordinate basis; a changed source geometry is not re-interpreted.
  function binding(op){
    const affine=model.affine(index=>op.volume.imageData.indexToWorld(index));
    if(affine.some((n,i)=>Math.abs(n-op.binding.affine[i])>1e-9*Math.max(1,Math.abs(n))))throw Error('CT 볼륨 좌표 기준이 바뀌어 VOI Slab 표시를 확정하지 않았습니다.');
    return op.binding;
  }
  function writeVoi(op,slab){
    const mapper=op.mapper,extra=mapper.getClippingPlanes().slice(2);
    if(!slab&&!extra.length)return;
    for(const plane of extra)if(mapper.removeClippingPlane(plane)!==true)throw Error('이전 VOI Slab 평면을 지우지 못했습니다.');
    if(slab)for(const definition of model.voiPlanes(slab))if(mapper.addClippingPlane(model.voiPlane(definition))!==true)throw Error('VOI Slab 평면을 적용하지 못했습니다.');
  }
  // Every request writes the whole display (orientation, blend, slab and VOI Slab), so a rollback never inherits a partial write.
  function apply(op,request){
    check(op);const next=model.normalizeRequest(request),want=expected(op,next);
    const bound=model.verifyBinding(next.voiSlab,binding(op));if(bound)throw Error(bound);
    if(next.voiSlab&&op.voiProblem)throw Error(op.voiProblem);
    if(want.blend===3){if(typeof window.kinPrepareVolumeAverage!=='function')throw Error('Raysum 평균 계산 모듈을 확인할 수 없어 적용하지 않았습니다.');window.kinPrepareVolumeAverage(op.view,op.volume);}
    // The pinned setOrientation applies MPR_CAMERA_VALUES and resets to the volume centre; the slab planes are
    // re-derived explicitly afterwards because a camera change alone keeps the previous planes.
    op.view.setOrientation(model.preset(cornerstone.CONSTANTS?.MPR_CAMERA_VALUES,next.orientation).key,false);op.view.setBlendMode(want.blend);op.view.setSlabThickness(op.thickness/2);
    // VOI planes are written after the camera and slab setters, which rewrite the first two planes; readback proves both.
    writeVoi(op,want.voiSlab);
    const problem=model.verifyState(readState(op),want);if(problem)throw Error(problem);
  }
  function gpuProblem(op,request){
    const node=op.engine.offscreenMultiRenderWindow?.getOpenGLRenderWindow?.()?.getViewNodeFor?.(op.mapper),program=node?.get?.('tris')?.tris?.getProgram?.();
    if(!program?.getCompiled?.()||!program.getLinked?.())return '투영 셰이더를 GPU에서 확인하지 못했습니다.';
    const source=program.getFragmentShader().getSource(),clipped=!!request.voiSlab&&request.original!==true;
    if(!model.clipShader(source,clipped?4:2))return clipped?'VOI Slab 자르기 셰이더를 GPU에서 확인하지 못했습니다.':'MIP 투영 범위 셰이더를 GPU에서 확인하지 못했습니다.';
    if(model.blendMode(request.mode)===3&&!model.averageShader(source))return 'Raysum 평균 셰이더를 확인하지 못했습니다.';
    return '';
  }
  // Final means a native frame rendered after this request and the state read in that same event still matches it.
  function confirm(op,request){
    return new Promise((resolve,reject)=>{
      const name=cornerstone.Enums.Events.IMAGE_RENDERED,element=canvasHost;let timer,finished=false;
      const finish=error=>{if(finished)return;finished=true;element.removeEventListener(name,rendered);clearTimeout(timer);op.pending.delete(cancel);error?reject(error):resolve();};
      const cancel=()=>finish(Error('MIP Viewer를 닫았습니다.'));
      const rendered=()=>{try{check(op);binding(op);const problem=model.verifyState(readState(op),expected(op,request))||gpuProblem(op,request);finish(problem?Error(problem):null);}catch(error){finish(error);}};
      op.pending.add(cancel);element.addEventListener(name,rendered);timer=setTimeout(()=>finish(Error('최종 렌더를 확인하지 못했습니다.')),op.restoring?Math.max(0,Math.min(15000,op.restoring.deadline-Date.now())):15000);
      try{check(op);op.view.render();}catch(error){finish(error);}
    });
  }
  function blocked(op){
    if(!current(op)){fail(op,Error('원본·선택 또는 계정이 변경되었습니다.'));return '원본·선택 또는 계정이 변경되었습니다.';}
    if([...document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"],.modal.show')].some(e=>e!==dialog&&!dialog.contains(e)))return '다른 창을 닫은 뒤 Projection·Orientation·VOI Slab을 바꾸세요.';
    if(window.kinViewerJobWorkspaceState?.().busy)return '영상 작업 처리가 끝난 뒤 Projection·Orientation·VOI Slab을 바꾸세요.';
    if(window.kinVolumeBatchState?.busy?.())return 'MPR batch가 끝난 뒤 Projection·Orientation·VOI Slab을 바꾸세요.';
    if(window.kinMprRenderingState?.busy?.())return 'MPR preview 정리가 끝난 뒤 Projection·Orientation·VOI Slab을 바꾸세요.';
    // A standalone viewer's permission also requires that no dialog is open, which this dialog itself always fails;
    // the query above keeps that gate for every other dialog. An embedded viewer's gate is the reading page's.
    if(window.top!==window&&!permitted())return '판독 화면의 다른 작업을 마친 뒤 Projection·Orientation·VOI Slab을 바꾸세요.';
    return '';
  }
  // Open MIP Viewer and a MIP Job restore prepare the same display: owner and access, the source volume, a separate
  // orthographic viewport, and the W/L and interpolation of the plane the viewer opens on. `wait` bounds each wait.
  async function prepare(op,wait=promise=>promise){
    const t=op.target;
    await wait(access(op));await wait(loadVoi(op));const source=t.views.find(v=>v.id===t.source.viewportId),volume=cornerstone.cache.getVolume(source.getVolumeId());check(op);
    if(!cornerstone.Enums?.Events?.IMAGE_RENDERED||!cornerstone.Enums?.ViewportType?.ORTHOGRAPHIC)throw Error('MIP Viewer의 최종 렌더 확인 기능을 찾지 못했습니다.');
    for(const name of model.orientations)model.preset(cornerstone.CONSTANTS?.MPR_CAMERA_VALUES,name);
    op.volume=volume;op.source=source;op.thickness=model.projectionThickness(volume.dimensions,volume.spacing);op.sampleDistance=model.sampleDistance(volume.spacing);op.corners=model.corners(volume.dimensions,index=>volume.imageData.indexToWorld(index));
    const properties=source.getProperties()||{},range=properties.voiRange;
    // The Job cell records a plane's interpolation as getProperties().interpolationType ?? 1 (viewer-volume-job.js). The pinned
    // volume viewport reports that value, and keeps its actor in step, only once it was set; an unset actor keeps vtk's own
    // default. The MIP display takes the recorded value so a saved MIP Job's display is its plane's and restores with it.
    op.display={interpolationType:properties.interpolationType??1,voiRange:{lower:Number(range?.lower),upper:Number(range?.upper)}};
    if(![op.display.voiRange.lower,op.display.voiRange.upper].every(Number.isFinite)||op.display.voiRange.upper<=op.display.voiRange.lower)throw Error('MPR 밝기 범위를 확인할 수 없습니다.');
    if(![0,1,2].includes(op.display.interpolationType))throw Error('MPR 보간 방식을 확인할 수 없습니다.');
    // The source frame of reference a MIP Job is bound to; the three-plane target already proved one CT series.
    op.frameOfReference=cornerstone.metaData.get('instance',volume.imageIds?.[0])?.FrameOfReferenceUID??null;
    identity.textContent='CT · Patient '+t.source.study.id;sourceText.textContent='Study '+t.source.uid+' · Series '+t.source.series;
    // An orthographic volume viewport, not the VR type: the pinned VolumeViewport3D ignores blend mode and slab thickness.
    // It shares the GL context but owns its actor and camera; suppressed creation keeps OHIF's viewport binders off it.
    op.engine=source.getRenderingEngine();op.engine.enableElement({viewportId:op.id,type:cornerstone.Enums.ViewportType.ORTHOGRAPHIC,element:canvasHost,defaultOptions:{orientation:'axial',background:[0,0,0],suppressEvents:true}});op.view=op.engine.getViewport(op.id);op.view.suppressEvents=false;
    await wait(op.view.setVolumes([{volumeId:volume.volumeId}]));check(op);
    op.mapper=op.view.getActors()[0]?.actor?.getMapper?.();
    if(op.view.getActors().length!==1||!op.mapper||op.mapper===source.getActors()[0].actor.getMapper())throw Error('독립 MIP 표시를 만들지 못했습니다.');
    if(['setOrientation','setBlendMode','setSlabThickness','setProperties'].some(n=>typeof op.view[n]!=='function')||['getBlendMode','getClippingPlanes','getSampleDistance'].some(n=>typeof op.mapper[n]!=='function'))throw Error('고정 뷰어에서 MIP 투영 기능을 확인하지 못했습니다.');
    op.binding={volumeId:volume.volumeId,affine:model.affine(index=>volume.imageData.indexToWorld(index))};
    // A missing VOI Slab tool or clipping API disables only the VOI Slab; Projection and Orientation keep working.
    op.voiProblem=voiProblem(op);
    if(!op.voiProblem){try{writeEditors(window.KinVolumeVoi.defaults(volume.imageData,'Axial'));voiPreset.value='Axial';}catch(error){op.voiProblem=voiError(error);}}
    voiNote.textContent=op.voiProblem;
    op.view.setProperties({voiRange:op.display.voiRange,interpolationType:op.display.interpolationType},undefined,true);
  }
  const sequenceFor=op=>model.createSequence({apply:request=>apply(op,request),confirm:request=>confirm(op,request),blocked:()=>blocked(op),closed:()=>operation!==op,show:state=>show(op,state),fatal:error=>fail(op,error),describe:request=>model.describe(request,op.thickness)});
  async function open(){
    if(ended||operation||!alive()||!permitted()||window.kinViewerJobWorkspaceState?.().busy||window.kinVolumeBatchState?.busy?.()||window.kinMprRenderingState?.busy?.())return;
    const t=target(true);if(!t)throw Error('완전히 로드된 일반 CT의 MPR에서 여세요.');
    const capturedOwner=owner();if(!capturedOwner)throw Error('로그인 상태를 확인하세요.');
    const op={target:t,owner:JSON.stringify(model.normalizeOwner(capturedOwner)),controller:new AbortController(),id:'kin-mip-'+crypto.randomUUID(),pending:new Set()};operation=op;saveState?.open(op);
    dialog.showModal();controls.disabled=true;dialog.dataset.kinMipState='pending';label.textContent='Rendering · 최종 표시 전';render.textContent='Rendering · 원본 확인 중';status.textContent='원본과 계정을 확인하는 중…';
    op.timeout=setTimeout(()=>fail(op,Error('MIP 원본 확인 시간이 지났습니다. 다시 열어 주세요.')),30000);
    try{
      await prepare(op);
      clearTimeout(op.timeout);
      op.sequence=sequenceFor(op);
      op.ready=true;controls.disabled=false;voi.disabled=!!op.voiProblem;refreshJob(op);await op.sequence.start({mode:'MIP',orientation:'Axial'});
    }catch(error){if(operation===op){close();throw error;}}
  }
  const otherDialog=()=>[...document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"],.modal.show')].some(e=>e!==dialog&&!dialog.contains(e));
  /* A MIP Job restore opens the viewer on the restored active plane with the saved request. Unlike open() it runs while the
     Jobs workspace is busy (that is this restore) and never returns silently: a refusal, failure, timeout or user cancel
     throws into the Job rollback and nothing of the failed request stays open. Every wait is bounded by the Job deadline. */
  async function restore(value,{current:jobCurrent=()=>true,deadline=Date.now()+60000,viewportId}={}){
    if(!jobs||!saveState)throw Error('MIP Viewer 도구를 불러오지 못했습니다. 영상 창을 새로고침하세요.');
    const saved=jobs.validate(value);
    if(ended||!alive())throw Error('MIP Viewer 계정이 변경되어 MIP 작업을 복원하지 않았습니다.');
    if(operation)close();
    const remaining=()=>deadline-Date.now(),changed='화면이 변경되어 MIP 작업 복원을 중단했습니다.';
    let t=null;
    for(;;){
      if(!jobCurrent())throw Error(changed);
      if(otherDialog())throw Error('다른 창을 닫은 뒤 MIP 작업을 복원하세요.');
      if(!permitted())throw Error('다른 작업을 마친 뒤 MIP 작업을 복원하세요.');
      // A restored plane can still be settling (readiness, progressive preview); wait for it, never past the deadline.
      if(!window.kinVolumeBatchState?.busy?.()&&!window.kinMprRenderingState?.busy?.()&&(t=target(true)))break;
      if(remaining()<=0)throw Error('복원한 MPR에서 MIP Viewer를 열 수 없어 MIP 작업을 복원하지 않았습니다.');
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,Math.min(100,remaining()))));
    }
    if(viewportId!==undefined&&t.source.viewportId!==viewportId)throw Error('MIP Viewer를 열 평면이 복원한 활성 MPR 평면과 달라 MIP 작업을 복원하지 않았습니다.');
    const capturedOwner=owner();if(!capturedOwner)throw Error('로그인 상태를 확인하세요.');
    const op={target:t,owner:JSON.stringify(model.normalizeOwner(capturedOwner)),controller:new AbortController(),id:'kin-mip-'+crypto.randomUUID(),pending:new Set(),restoring:{current:jobCurrent,deadline}};
    operation=op;saveState.open(op);
    dialog.showModal();controls.disabled=voi.disabled=jobBox.disabled=true;dialog.dataset.kinMipState='pending';label.textContent='Rendering · 최종 표시 전';render.textContent='Rendering · 원본 확인 중';
    voiState.textContent='VOI Slab · Rendering · Not Saved';status.textContent='저장한 MIP 작업을 복원하는 중입니다. Close MIP Viewer나 Escape로 복원을 취소할 수 있습니다.';
    let timer,cancel;
    const expired=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('MIP 작업 복원 시간이 지났습니다.')),Math.max(0,remaining()));});
    const closed=new Promise((_,reject)=>{cancel=()=>reject(Error('MIP Viewer를 닫았습니다.'));});
    expired.catch(()=>{});closed.catch(()=>{});op.pending.add(cancel);
    const bounded=promise=>Promise.race([promise,expired,closed]);
    try{
      await prepare(op,bounded);
      if(saved.frameOfReference!==op.frameOfReference)throw Error(jobs.messages.frame);
      const near=(a,b)=>Math.abs(a-b)<=1e-6*Math.max(1,Math.abs(b));
      if(op.display.interpolationType!==saved.display.interpolationType||!near(op.display.voiRange.lower,saved.display.voiRange.lower)||!near(op.display.voiRange.upper,saved.display.voiRange.upper))
        throw Error('저장한 MIP 작업의 밝기 범위·보간이 복원한 MPR 평면과 달라 복원하지 않았습니다.');
      if(saved.voiSlab&&op.voiProblem)throw Error('VOI Slab 도구를 확인할 수 없어 MIP 작업을 복원하지 않았습니다.');
      const request=jobs.restoreRequest(saved,{frameOfReference:op.frameOfReference,volumeId:op.binding.volumeId,affine:op.binding.affine});
      if(!jobs.intersects(saved.voiSlab,op.corners))throw Error('저장한 VOI Slab이 현재 CT 볼륨과 겹치지 않아 MIP 작업을 복원하지 않았습니다.');
      // The editors show the restored record, so Apply VOI Slab right after a restore reapplies it rather than a default slab.
      if(saved.voiSlab){writeEditors(saved.voiSlab);voiEnable.checked=true;voiPreset.value=jobs.presetFor(saved.voiSlab.normal);}else voiEnable.checked=false;
      check(op);
      op.sequence=sequenceFor(op);op.ready=true;
      const shown=await bounded(op.sequence.start(request));
      if(shown!==true||operation!==op)throw op.failure||Error('저장한 MIP 표시의 최종 렌더를 확인하지 못해 MIP 작업을 복원하지 않았습니다.');
      check(op);
      op.pending.delete(cancel);op.restoring=null;saveState.restored(op,saved);controls.disabled=false;voi.disabled=!!op.voiProblem;
      status.textContent='저장한 MIP 작업을 복원했습니다. 표시 전용 투영이며 되돌릴 VOI Slab 변경은 없습니다.';paintJob(op);
    }catch(error){
      const failure=op.cancelled?Error('MIP 작업 복원을 취소했습니다.'):op.failure||error;
      if(operation===op)close();
      throw failure;
    }finally{clearTimeout(timer);}
  }
  // A plane or projection change keeps the requested VOI Slab fixed in source coordinates.
  const changed=()=>{const op=operation;if(!op?.ready)return;if(!current(op)){fail(op,Error('원본·선택 또는 계정이 변경되었습니다.'));return;}const applied=op.sequence.snapshot().applied,display={mode:projection.value,orientation:orientation.value};op.sequence.request(applied?model.withDisplay(applied,display):display);};
  projection.onchange=orientation.onchange=changed;
  // The VOI tool is optional: its absence is reported in the VOI Slab panel instead of blocking the viewer.
  function loadVoi(op){
    if(window.KinVolumeVoi)return Promise.resolve();
    return new Promise(resolve=>{
      const script=document.createElement('script');script.src='/worklist/hpacs-lite/volume-voi.js';let finished=false;
      const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);op.pending.delete(finish);script.onload=script.onerror=null;script.remove();resolve();};
      const timer=setTimeout(finish,15000);op.pending.add(finish);script.onload=script.onerror=finish;document.head.append(script);
    });
  }
  const voiMessages=[[/^(Invalid VOI movement|VOI movement exceeds)/,'이동 거리는 좌표 한도 안의 숫자(mm)로 입력하세요.'],[/^(Invalid VOI rotation|VOI rotation exceeds)/,'회전 각도는 -180~180도 사이의 숫자로 입력하세요.'],[/^Invalid VOI pivot/,'회전 기준점을 환자 좌표 숫자(mm)로 입력하세요.'],[/^Invalid VOI orientation/,'VOI Slab Preset을 목록에서 선택하세요.'],[/^Invalid VOI (image geometry|spatial extent|affine|default slab)/,'CT 볼륨 좌표로 기본 VOI Slab을 만들 수 없습니다.'],[/^Invalid VOI (slab|world point|sample plane)/,'VOI Slab 중심·두께·방향 값을 확인하세요. 두께는 0보다 커야 합니다.']];
  const voiError=error=>{const message=String(error?.message||'');return voiMessages.find(([pattern])=>pattern.test(message))?.[1]||message||'VOI Slab 값을 확인하세요.';};
  function voiTool(){const tool=window.KinVolumeVoi;if(!tool||['defaults','validate','move','rotate','setPivot'].some(name=>typeof tool[name]!=='function'))throw Error('VOI Slab 도구를 확인할 수 없어 VOI Slab을 쓸 수 없습니다. Projection과 Orientation은 계속 쓸 수 있습니다.');return tool;}
  function voiProblem(op){
    try{voiTool();}catch(error){return error.message;}
    if(['getClippingPlanes','addClippingPlane','removeClippingPlane'].some(name=>typeof op.mapper?.[name]!=='function'))return '고정 뷰어에서 VOI Slab 자르기 기능을 확인하지 못해 VOI Slab을 쓸 수 없습니다. Projection과 Orientation은 계속 쓸 수 있습니다.';
    return '';
  }
  function writeEditors(slab){
    voiCenter.forEach((input,i)=>{input.value=String(slab.center[i]);});voiPivot.forEach((input,i)=>{input.value=String(slab.pivot[i]);});voiThickness.value=String(slab.thickness);
    voiDraftNormal=Object.freeze([...slab.normal]);voiNormal.textContent='Normal '+slab.normal.map(n=>n.toFixed(3)).join(' / ');
  }
  function voiNumber(input,name){const text=input.value.trim(),value=text===''?NaN:Number(text);if(!Number.isFinite(value))throw Error('VOI Slab '+name+' 값을 숫자로 입력하세요.');return value;}
  function voiDraft(){
    const tool=voiTool();if(!voiDraftNormal)throw Error('VOI Slab Preset을 먼저 선택하세요.');
    const center=voiCenter.map((input,i)=>voiNumber(input,'Center '+'LPS'[i])),pivot=voiPivot.map((input,i)=>voiNumber(input,'Pivot '+'LPS'[i])),thickness=voiNumber(voiThickness,'Thickness');
    if(!(thickness>0))throw Error('VOI Slab Thickness는 0보다 큰 mm 값으로 입력하세요.');
    return tool.validate({center,normal:[...voiDraftNormal],pivot,thickness});
  }
  const voiRecord=(op,slab)=>model.normalizeVoi({volumeId:op.binding.volumeId,affine:op.binding.affine,center:slab.center,normal:slab.normal,pivot:slab.pivot,thickness:slab.thickness});
  // Invalid input, a missing tool or Original view refuse before any native call; accepted changes use the sequence.
  function voiAction(build){
    const op=operation;if(!op?.ready)return;
    if(!current(op)){fail(op,Error('원본·선택 또는 계정이 변경되었습니다.'));return;}
    let next;
    try{
      if(op.voiProblem)throw Error(op.voiProblem);
      const {final,applied}=op.sequence.snapshot();if(!final||!applied)throw Error('첫 Final 표시를 확인한 뒤 VOI Slab을 바꾸세요.');
      next=build(op,final,applied);
      if(model.sameRequest(next,applied)){status.textContent='이미 요청한 VOI Slab 표시입니다.';return;}
    }catch(error){voiOriginal.checked=op.sequence.snapshot().applied?.original===true;status.textContent=voiError(error);return;}
    op.sequence.request(next);
  }
  const voiApplied=(op,slab,next)=>{writeEditors(slab);voiEnable.checked=true;return next;};
  voiApply.onclick=()=>voiAction((op,final,applied)=>model.voiChange(final,applied,voiEnable.checked?voiRecord(op,voiDraft()):null));
  voiMoveButton.onclick=()=>voiAction((op,final,applied)=>{const slab=voiTool().move(voiDraft(),voiNumber(voiMove,'Move'));return voiApplied(op,slab,model.voiChange(final,applied,voiRecord(op,slab)));});
  voiRotateButton.onclick=()=>voiAction((op,final,applied)=>{const slab=voiTool().rotate(voiDraft(),voiAxis.value,voiNumber(voiDegrees,'Rotate Degrees'));return voiApplied(op,slab,model.voiChange(final,applied,voiRecord(op,slab)));});
  voiUndoButton.onclick=()=>voiAction((op,final,applied)=>{const next=model.voiUndo(final,applied);if(next.voiSlab)writeEditors(next.voiSlab);voiEnable.checked=!!next.voiSlab;return next;});
  voiReset.onclick=()=>voiAction((op,final,applied)=>{const next=model.voiChange(final,applied,null),slab=voiTool().defaults(op.volume.imageData,'Axial');writeEditors(slab);voiPreset.value='Axial';voiEnable.checked=false;return next;});
  voiOriginal.onchange=()=>voiAction((op,final,applied)=>model.voiOriginal(applied,voiOriginal.checked));
  voiPreset.onchange=()=>{const op=operation;if(!op?.ready||op.voiProblem)return;try{writeEditors(voiTool().defaults(op.volume.imageData,voiPreset.value));status.textContent=voiPreset.value+' 방향의 기본 VOI Slab 값을 입력했습니다. Apply VOI Slab을 눌러 적용하세요.';}catch(error){status.textContent=voiError(error);}};
  /* Save MIP Job and Retry MIP Save. The gate refuses before any request; Saved itself is marked only by the committed receipt
     (job.saved, called by the Jobs request path right after the POST resolves), so a dispatch or a 4xx is never Saved. */
  async function saveJob(retry){
    const op=operation,command=window.kinViewerJobCommand;
    if(!op?.ready||op.restoring||!saveState||saveState.saving(op))return;
    if(!current(op)){fail(op,Error('원본·선택 또는 계정이 변경되었습니다.'));return;}
    if(!command){status.textContent='영상 작업 저장 도구를 확인할 수 없어 MIP 작업을 저장하지 않았습니다. 영상 창을 새로고침하세요.';refreshJob(op);return;}
    let gate;
    try{
      const account=command.owner();
      if(account&&account!==op.owner){fail(op,Error('MIP Viewer 계정이 변경되었습니다.'));return;}
      gate=jobs.saveGate({writable:!!account&&command.writable(),busy:command.busy()||!!window.kinVolumeBatchState?.busy?.()||!!window.kinMprRenderingState?.busy?.(),
        snapshot:op.sequence.snapshot(),frameOfReference:op.frameOfReference,display:op.display,corners:op.corners,pending:command.pending(),title:jobTitle.value,retry});
    }catch(error){gate={message:error?.message||'MIP 작업 저장 상태를 확인하지 못했습니다.',block:null};}
    if(gate.message){status.textContent=gate.message;refreshJob(op);return;}
    const ticket=saveState.begin(op,gate.block);if(!ticket)return;
    status.textContent='MIP 작업을 저장하는 중…';paintJob(op);
    let outcome;
    try{outcome=retry?await command.retry():await command.save({title:jobTitle.value,description:jobDescription.value});}
    catch(error){outcome={state:'not-saved',message:error?.message||'MIP 작업을 저장하지 않았습니다.',sent:false};}
    saveState.end(ticket);
    if(operation!==op)return;
    // An unknown receipt keeps the identical body for Retry MIP Save; a request the server answered without saving clears it.
    if(outcome?.state==='unconfirmed')saveState.unknown(ticket);
    else if(outcome?.state!=='saved'&&outcome?.sent)saveState.rejected(ticket);
    if(outcome?.state==='saved'&&saveState.label(op,gate.block)==='Saved'){jobTitle.value='';jobDescription.value='';}
    status.textContent=outcome?.message||'MIP 작업을 저장하지 않았습니다.';
    if(!current(op)){fail(op,Error('원본·선택 또는 계정이 변경되었습니다.'));return;}
    paintJob(op);
  }
  jobSave.onclick=()=>saveJob(false);jobRetry.onclick=()=>saveJob(true);
  // Closing is the user's cancel of a restore that opened this dialog; the restore then throws into the Job rollback.
  const userClose=()=>{if(operation?.restoring)operation.cancelled=true;close();};
  closeButton.onclick=userClose;dialog.addEventListener('cancel',e=>{e.preventDefault();userClose();});
  // Keep browser input/Tab/Escape behavior while isolating native viewer hotkeys.
  for(const name of ['keydown','keyup','keypress'])dialog.addEventListener(name,e=>e.stopPropagation(),true);
  const observer=new ResizeObserver(()=>{const op=operation;if(op?.ready&&current(op)){try{op.engine.resize(true,true);}catch(error){fail(op,error);}}});observer.observe(canvasHost);
  const timer=setInterval(()=>{const op=operation;if(!op)return;if(!current(op)){fail(op,Error('원본·선택 또는 계정이 변경되었습니다.'));return;}if(op.ready&&!op.checking&&Date.now()-op.checkedAt>15000){op.checking=true;op.accessTimer=setTimeout(()=>fail(op,Error('MIP 접근 확인 시간이 지났습니다.')),15000);access(op).catch(error=>fail(op,error)).finally(()=>{op.checking=false;clearTimeout(op.accessTimer);});}refreshJob(op);},250);
  // The MIP Viewer Job capability viewer-volume-orientation.js lends to viewer-volume-job.js as window.kinVolumeMipJob.
  const job={
    capture(){
      const op=operation;if(!op)return null;
      if(!op.ready||op.restoring)throw Error('MIP Viewer 표시를 확인하는 중에는 MIP 작업을 저장할 수 없습니다.');
      if(!current(op))throw Error('원본·선택 또는 계정이 변경되어 MIP 작업을 저장하지 않았습니다.');
      if(!jobs)throw Error('MIP 작업 도구를 확인할 수 없어 저장하지 않았습니다.');
      const value=jobs.block(op.sequence.snapshot(),{frameOfReference:op.frameOfReference,display:op.display});
      if(!jobs.intersects(value.voiSlab,op.corners))throw Error(jobs.messages.outside);
      return value;
    },
    viewport:()=>operation?.target?.source?.viewportId??null,
    dirty(){const op=operation;return !!op&&!!saveState&&saveState.dirty(op,op.sequence?.snapshot().final??null,{title:jobTitle.value,description:jobDescription.value});},
    // A committed receipt belongs to this display only for this operation, owner and original series.
    saved(value,volume){
      const op=operation;if(!op?.ready||op.restoring||!saveState||!value||!current(op))return;
      if(volume?.study!==op.target.source.uid||volume?.series!==op.target.source.series)return;
      if(saveState.committed(op,value))paintJob(op);
    },
    // Only Close MIP Viewer and Escape inside this dialog, and only while a Job restore is opening it.
    cancels(e){const op=operation;return !!op?.restoring&&dialog.open&&dialog.contains(e.target)&&(e.type==='pointerdown'&&closeButton.contains(e.target)||e.type==='keydown'&&e.key==='Escape');},
    restore,
    clearForJob(){if(operation)close();},
  };
  return {open,job,dispose(){ended=true;clearInterval(timer);observer.disconnect();close();dialog.remove();}};
};
