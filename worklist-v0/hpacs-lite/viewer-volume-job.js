/* MPR Jobs keep volume references, never a fictitious reconstructed SOP/frame. */
window.kinCreateVolumeJob = function({grid,cs,ds,studies}) {
  const fail=()=>{throw Error('완전히 로드된 단일 일반 CT의 3평면에서 MPR 작업을 저장하세요.');};
  const ordered=()=>[...grid.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x);
  function source(v) {
    if(v?.type!=='orthographic'||v.getActors().length!==1)fail();
    const volume=cornerstone.cache.getVolume(v.getVolumeId()),images=volume?.imageIds;
    if(!volume?.loadStatus?.loaded||!Array.isArray(images)||images.length<2||images.length>256||volume.framesLoaded!==images.length)fail();
    const refs=images.map(id=>cornerstone.metaData.get('instance',id)),first=refs[0];
    if(!first||!studies.includes(first.StudyInstanceUID)||refs.some(m=>!m||m.StudyInstanceUID!==first.StudyInstanceUID||m.SeriesInstanceUID!==first.SeriesInstanceUID||m.PatientID!==first.PatientID||m.SOPClassUID!=='1.2.840.10008.5.1.4.1.1.2'||m.Modality!=='CT'||Number(m.SamplesPerPixel)!==1||m.PhotometricInterpretation!=='MONOCHROME2'))fail();
    const sops=refs.map(m=>m.SOPInstanceUID);if(new Set(sops).size!==sops.length)fail();
    return {volume,reference:{study:first.StudyInstanceUID,series:first.SeriesInstanceUID,sops}};
  }
  function resolve(value) {
    const ref=value.volume,matches=ds.getActiveDisplaySets().filter(d=>d.StudyInstanceUID===ref.study&&d.SeriesInstanceUID===ref.series);
    if(matches.length!==1||matches[0].images?.length!==ref.sops.length||new Set(matches[0].images.map(m=>m.SOPInstanceUID)).size!==ref.sops.length||matches[0].images.some(m=>!ref.sops.includes(m.SOPInstanceUID)||m.SOPClassUID!=='1.2.840.10008.5.1.4.1.1.2'))throw Error('저장한 MPR의 전체 원본 시리즈를 찾을 수 없습니다.');
    return matches[0].displaySetInstanceUID;
  }
  function capture() {
    const state=grid.getState(),views=ordered(),{numRows:rows,numCols:cols,layoutType}=state.layout;
    if(layoutType!=='grid'||!(rows===1&&cols===3||rows===3&&cols===1)||views.length!==3)fail();
    let reference,loaded,pixels=0;
    const cells=views.map((g,i)=>{
      if(Math.abs(g.x-(i%cols)/cols)>1e-6||Math.abs(g.y-Math.floor(i/cols)/rows)>1e-6||Math.abs(g.width-1/cols)>1e-6||Math.abs(g.height-1/rows)>1e-6||g.displaySetInstanceUIDs?.length!==1)fail();
      const v=cs.getCornerstoneViewport(g.viewportId),current=source(v);
      if(reference&&(JSON.stringify(reference)!==JSON.stringify(current.reference)||loaded!==current.volume))fail();
      reference=current.reference;loaded=current.volume;
      if(resolve({volume:reference})!==g.displaySetInstanceUIDs[0])fail();
      const camera=v.getCamera(),properties=v.getProperties(),canvas=v.getCanvas(),mapper=v.getActors()[0].actor.getMapper();
      const width=canvas.width,height=canvas.height;pixels+=width*height;
      if(![width,height].every(n=>Number.isInteger(n)&&n>=1&&n<=8192)||width*height>16777216||pixels>33554432)throw Error('저장할 화면 크기를 줄인 뒤 다시 저장하세요.');
      // Native inversion labels its grayscale transfer function "X Ray".
      const color=properties.colormap?.name;
      if(color&&color!=='Grayscale'&&!(color==='X Ray'&&properties.invert))throw Error('MPR 작업은 회색조 표시에서 저장할 수 있습니다.');
      const opacity=v.getActors()[0].actor.getProperty().getScalarOpacity(0),count=opacity?.getSize?.();
      if(!Number.isInteger(count)||count<1||count>64||!opacity.getClamping())fail();
      for(let n=0;n<count;n++){const node=[];opacity.getNodeValue(n,node);if(Math.abs(node[1]-1)>1e-6)throw Error('MPR 작업은 불투명한 일반 CT 표시에서 저장할 수 있습니다.');}
      const blend=mapper.getBlendMode(),thickness=v.getSlabThickness()*2;
      if(![0,1,2,3].includes(blend)||!Number.isFinite(thickness)||thickness<.1||thickness>1000||blend===0&&thickness>.2)fail();
      if(blend===3){const info=mapper.getScalarTexture?.()?.getVolumeInfo();if(!Number.isFinite(info?.dataComputedScale?.[0])||info.dataComputedScale[0]<=0)throw Error('평균 투영을 다시 적용한 뒤 저장하세요.');}
      return {study:reference.study,series:reference.series,viewport:{width,height},projection:{blend,thickness},
        camera:{...Object.fromEntries(['focalPoint','position','viewUp','viewPlaneNormal','parallelScale','flipHorizontal','flipVertical'].map(k=>[k,camera[k]])),rotation:camera.rotation||0},
        properties:{voiRange:properties.voiRange,VOILUTFunction:properties.VOILUTFunction||'LINEAR',invert:!!properties.invert,interpolationType:properties.interpolationType??1}};
    });
    const active=views.findIndex(v=>v.viewportId===state.activeViewportId);if(active<0)throw Error('활성 MPR 평면을 선택한 뒤 저장하세요.');
    const batch=window.kinVolumeBatchState?.capture(reference);
    return JSON.parse(JSON.stringify({version:batch?5:4,studies,rows,cols,active,volume:reference,cells,...(batch?{batch}:{})}));
  }
  function holdCrosshairReset(){
    const group=window.cornerstoneTools?.ToolGroupManager?.getToolGroup('mpr'),tool=group?.getToolInstance('Crosshairs');
    if(!tool||typeof tool.onResetCamera!=='function')return {release(){}};
    const original=tool.onResetCamera;let held=true;
    const guarded=function(...args){if(!held)return original.apply(this,args);};tool.onResetCamera=guarded;
    return {group,tool,release(){held=false;if(tool.onResetCamera===guarded)tool.onResetCamera=original;}};
  }
  async function apply(value,current) {
    if(JSON.stringify(value.studies)!==JSON.stringify(studies))throw Error('저장한 현재·비교 검사를 같은 순서로 먼저 여세요.');
    const set=resolve(value),ids=value.cells.map(()=> 'kin-volume-job-'+crypto.randomUUID());
    window.kinVolumeBatchState?.clear();
    // Native reset callbacks reset every linked plane while OHIF replaces one
    // viewport. Hold that propagation through both initialization and failure.
    const crosshair=holdCrosshairReset();try{
    // Native position-cache keys use viewportOptions.id, not viewportId. A
    // cached oblique reference recurses through setOrientation/resetCamera on
    // a fresh axial viewport. Initialize a new presentation for this Job;
    // the verified saved cameras below are the sole position source.
    await grid.setLayout({numRows:value.rows,numCols:value.cols,activeViewportId:ids[value.active],isHangingProtocolLayout:false,
      findOrCreateViewport:index=>({displaySetInstanceUIDs:[set],displaySetOptions:[{}],viewportOptions:{id:ids[index],viewportId:ids[index],viewportType:'volume',toolGroupId:'mpr',orientation:['axial','sagittal','coronal'][index],allowUnmatchedView:true}})});
    const loaded=[],deadline=Date.now()+60000;
    for(let i=0;i<ids.length;i++){
      while(Date.now()<deadline){
        if(!current())throw Error('화면이 변경되어 MPR 복원을 중단했습니다.');
        const v=cs.getCornerstoneViewport(ids[i]);let original;try{original=source(v);}catch(_){}
        const canvas=v?.getCanvas(),ready=grid.getState().viewports.get(ids[i])?.isReady;
        if(original&&ready&&canvas?.clientWidth>1&&canvas?.clientHeight>1&&Math.abs(canvas.width-Math.floor(canvas.clientWidth*devicePixelRatio))<=1&&Math.abs(canvas.height-Math.floor(canvas.clientHeight*devicePixelRatio))<=1){
          if(JSON.stringify(original.reference)!==JSON.stringify({study:value.volume.study,series:value.volume.series,sops:value.volume.sops}))throw Error('볼륨 원본의 순서나 구성이 달라 복원하지 않았습니다.');
          loaded.push({v,original});break;
        }
        await new Promise(r=>setTimeout(r,100));
      }
      if(loaded.length!==i+1)throw Error('MPR 원본 볼륨 로딩에 실패했습니다.');
    }
    const rendered=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    await rendered();
    if(!current())throw Error('화면이 변경되어 MPR 복원을 중단했습니다.');
    for(let i=0;i<loaded.length;i++){
      const {v,original}=loaded[i],cell=value.cells[i];
      // Volume opacity [] is an empty transfer function (black), unlike a stack.
      v.setProperties({invert:false,colormap:{name:'Grayscale',opacity:1}});v.setProperties(cell.properties);
      if(cell.projection.blend===3){if(typeof window.kinPrepareVolumeAverage!=='function')throw Error('평균 투영 도구 로딩을 마친 뒤 다시 복원하세요.');window.kinPrepareVolumeAverage(v,original.volume);}
      v.setBlendMode(cell.projection.blend);
      if(Math.abs(v.getSlabThickness()*2-cell.projection.thickness)>1e-6)v.setSlabThickness(cell.projection.thickness/2);
      if(v.getActors()[0].actor.getMapper().getBlendMode()!==cell.projection.blend||Math.abs(v.getSlabThickness()*2-cell.projection.thickness)>1e-6)throw Error('저장한 MPR 모드나 두께를 복원하지 못했습니다.');
    }
    // Let the native initial slice and resize presentation finish before the
    // saved physical camera is assigned. A loaded volume alone is insufficient.
    await rendered();
    if(!current())throw Error('화면이 변경되어 MPR 복원을 중단했습니다.');
    const settled=async()=>{
      let signature='',since=Date.now();
      while(Date.now()<deadline){
        if(!current())throw Error('화면이 변경되어 MPR 복원을 중단했습니다.');
        const state=grid.getState(),ready=loaded.every(({v})=>cs.getCornerstoneViewport(v.id)===v&&state.viewports.get(v.id)?.isReady);
        const next=JSON.stringify(loaded.map(({v})=>{const c=v.getCanvas(),camera=v.getCamera();delete camera.rotation;return [c.width,c.height,c.clientWidth,c.clientHeight,camera];}));
        if(!ready||next!==signature){signature=next;since=Date.now();}else if(Date.now()-since>=600)return;
        await new Promise(r=>setTimeout(r,50));
      }
      throw Error('MPR 화면 배치가 안정되지 않아 복원하지 못했습니다.');
    };
    let matched=false;
    for(let attempt=0;attempt<3&&!matched;attempt++){
    for(let i=0;i<loaded.length;i++){
      const v=loaded[i].v,cell=value.cells[i];
      v.setCamera({flipHorizontal:cell.camera.flipHorizontal,flipVertical:cell.camera.flipVertical});
      const camera={...cell.camera};delete camera.flipHorizontal;delete camera.flipVertical;delete camera.rotation;v.setCamera(camera);v.render();
    }
    await rendered();
    // A cached volume can become ready before delayed resize/presentation work.
    // Reapply only after that work settles, retaining the strict camera oracle.
    await settled();
    if(crosshair.tool&&crosshair.group.getToolOptions('Crosshairs')?.mode!=='Disabled')crosshair.tool.computeToolCenter();
    await rendered();matched=true;
    for(let i=0;i<loaded.length;i++){
      const actual=loaded[i].v.getCamera(),expected=value.cells[i].camera;
      for(const [key,want] of Object.entries(expected)){
        // Native oblique rotation derives a sign from a nearly-zero dot product
        // against initialViewUp (335 vs 25 for identical physical vectors).
        // v4 orientation is verified by viewUp/normal, position and focalPoint.
        if(key==='rotation')continue;
        const got=actual[key],same=Array.isArray(want)?Array.isArray(got)&&want.every((n,j)=>Math.abs(n-got[j])<1e-6):typeof want==='number'?Math.abs(want-got)<1e-6:want===got;
        if(!same)matched=false;
      }
    }
    }
    if(!matched)throw Error('저장한 MPR 영상 위치를 확인하지 못했습니다. 이전 화면을 확인하세요.');
    if(!current())throw Error('화면이 변경되어 MPR 복원을 중단했습니다.');grid.setActiveViewportId(ids[value.active]);
    if(value.version===5){
      if(!window.kinVolumeBatchState)throw Error('단면 묶음 도구 로딩을 마친 뒤 다시 복원하세요.');
      await rendered();await window.kinVolumeBatchState.restore(value.batch,current);
    }
    }finally{crosshair.release();}
  }
  return {capture,resolve,apply};
};
