/* Saved MIP Viewer and MIP Batch output (A11-OUTPUT-1). Every page frame is rendered by the private print engine from the private,
   freshly read and digest-verified volume of viewer-volume-job-print.js, under its analytic camera (volume-mip-output.js), and is
   accepted only from its own rendered event after the projection state, the display, the linked shaders, the camera and its depth
   range read back. It never touches the OHIF engine, the MIP Viewer dialog, a preview or a saved-state object; the caller's finally
   destroys the engine and element and removes the private volume. */
window.kinRenderVolumeMipPrint=async function kinRenderVolumeMipPrint({core,engine,volume,element,pending,check,snapshot,corners,dimensions,spacing,direction,frameOfReference}){
  const output=window.KinVolumeMipOutput,model=window.KinVolumeMip;
  if(!output||!model)throw Error('MIP 출력 도구를 불러오지 못했습니다. 다시 확인하세요.');
  const {messages}=output,job=output.saved(snapshot),id=volume.volumeId,rendered=core.Enums?.Events?.IMAGE_RENDERED,size=output.size;
  const affine=model.affine(index=>volume.imageData.indexToWorld(index));
  const request=output.bind({saved:job,frameOfReference,volumeId:id,affine,corners});
  const plan=output.frames({saved:job,values:core.CONSTANTS?.MPR_CAMERA_VALUES,dimensions,spacing,corners});
  const batch=job.recipe?window.KinVolumeMipBatch:null,display=job.mip.display,slab=request.voiSlab??null;
  if(plan.blend===3&&typeof window.kinPrepareVolumeAverage!=='function')throw Error(messages.average);
  if(!rendered||!core.Enums?.ViewportType?.ORTHOGRAPHIC)throw Error(messages.capability);
  check();
  element.style.width=(size/devicePixelRatio)+'px';element.style.height=(size/devicePixelRatio)+'px';
  engine.enableElement({viewportId:id,type:core.Enums.ViewportType.ORTHOGRAPHIC,element,defaultOptions:{background:[0,0,0],suppressEvents:true}});
  const view=engine.getViewport(id);if(!view)throw Error(messages.capability);view.suppressEvents=false;
  await pending((resolve,reject)=>{view.setVolumes([{volumeId:id}]).then(resolve,reject);});check();
  const mapper=printCapabilities();
  function printCapabilities(){
    const actors=view.getActors(),found=actors[0]?.actor?.getMapper?.(),camera=typeof view.getVtkActiveCamera==='function'?view.getVtkActiveCamera():null;
    if(actors.length!==1||!found||typeof found.setViewSpecificProperties!=='function'||typeof camera?.getClippingRange!=='function'||
      ['setCamera','getCamera','setBlendMode','setSlabThickness','setProperties','getProperties','getCanvas','getVolumeId','render'].some(name=>typeof view[name]!=='function')||
      ['getBlendMode','getClippingPlanes','addClippingPlane','removeClippingPlane','getSampleDistance'].some(name=>typeof found[name]!=='function'))throw Error(messages.capability);
    return found;
  }
  function writePrintFrame(camera){
    view.setCamera({focalPoint:[...camera.focalPoint],position:[...camera.position],viewUp:[...camera.viewUp],viewPlaneNormal:[...camera.viewPlaneNormal],parallelScale:camera.parallelScale});
    // A camera write keeps the previous slab planes, so the whole-volume slab is re-derived from this camera. The VOI Slab planes are
    // then written again in source LPS, never derived from the camera.
    view.setSlabThickness(plan.thickness/2);
    for(const plane of mapper.getClippingPlanes().slice(2))if(mapper.removeClippingPlane(plane)!==true)throw Error(messages.plane);
    if(slab)for(const definition of model.voiPlanes(slab))if(mapper.addClippingPlane(model.voiPlane(definition))!==true)throw Error(messages.plane);
  }
  // The display and the depth range are read through their own named steps, so a readback fault can target exactly one of them.
  function printDisplay(){return view.getProperties();}
  function printDepthRange(){const camera=view.getVtkActiveCamera();return typeof camera?.getClippingRange==='function'?camera.getClippingRange():undefined;}
  function printShaderProblem(){
    const gl=engine.offscreenMultiRenderWindow?.getOpenGLRenderWindow?.(),context=gl?.getContext?.();
    // A lost context can still copy an empty or earlier canvas with a rendered event; that canvas is never a frame.
    if(!context||typeof context.isContextLost!=='function'||context.isContextLost())return messages.contextLost;
    const program=gl.getViewNodeFor?.(mapper)?.get?.('tris')?.tris?.getProgram?.();
    if(!program?.getCompiled?.()||!program.getLinked?.())return messages.gpu;
    const source=program.getFragmentShader().getSource();
    if(!model.clipShader(source,slab?4:2))return slab?messages.voiShader:messages.slabShader;
    return plan.blend===3&&!model.averageShader(source)?messages.averageShader:'';
  }
  function verifyPrintFrame(camera){
    check();
    const actors=view.getActors(),actor=actors[0]?.actor;
    if(engine.getViewport(id)!==view||actor?.getMapper?.()!==mapper)throw Error(messages.capability);
    const properties=printDisplay(),actual=view.getCamera();
    const state={actors:actors.length,volumeId:view.getVolumeId(),blend:mapper.getBlendMode(),viewPlaneNormal:actual.viewPlaneNormal,viewUp:actual.viewUp,
      planes:mapper.getClippingPlanes().map(p=>({origin:p.getOrigin(),normal:p.getNormal()})),sampleDistance:mapper.getSampleDistance(),interpolationType:actor.getProperty().getInterpolationType(),voiRange:properties?.voiRange};
    const want={volumeId:id,blend:plan.blend,viewPlaneNormal:camera.viewPlaneNormal,viewUp:camera.viewUp,thickness:plan.thickness,corners,sampleDistance:plan.sampleDistance,
      interpolationType:display.interpolationType,voiRange:display.voiRange,voiSlab:slab,affine};
    const problem=model.verifyState(state,want)||output.verifyDisplay(properties)||printShaderProblem()||
      ((batch?batch.verifyCamera(actual,camera):output.verifyCamera(actual,camera))?messages.frameCamera:'')||
      output.verifyClip({range:printDepthRange(),camera,corners,direction,spacing,thickness:plan.thickness,distance:plan.distance});
    if(problem)throw Error(problem);
    const canvas=view.getCanvas();if(canvas?.width!==size||canvas?.height!==size)throw Error(messages.size);
    return {canvas,properties:{VOILUTFunction:properties.VOILUTFunction,invert:properties.invert}};
  }
  // vtk gives each new mapper a random ray-start texture; the pinned phase makes one saved Job print the same pixels every time.
  mapper.setViewSpecificProperties({OpenGL:{ShaderReplacements:[{shaderType:'Fragment',originalValue:'float jitter = 0.01 + 0.99*texture2D(jtexture, gl_FragCoord.xy/32.0).r;',replacementValue:'float jitter = 0.5;',replaceFirst:true,replaceAll:false}]}});
  view.setProperties({invert:false,colormap:{name:'Grayscale',opacity:1}});
  view.setProperties({VOILUTFunction:'LINEAR',voiRange:{lower:display.voiRange.lower,upper:display.voiRange.upper},interpolationType:display.interpolationType});
  if(plan.blend===3){
    // A never-rendered private texture carries no volume info for the average patch, so the accepted MPR print order renders once
    // first. That render only prepares the texture and is never accepted as a frame.
    view.setBlendMode(0);view.setSlabThickness(.05);
    await pending(resolve=>{const done=()=>resolve();element.addEventListener(rendered,done,{once:true});view.render();return ()=>element.removeEventListener(rendered,done);},output.preRenderMs,messages.preRender);check();
    window.kinPrepareVolumeAverage(view,volume);
  }
  view.setBlendMode(plan.blend);
  const frames=[];let encoded=0;
  for(const camera of plan.cameras){
    check();
    const {canvas,properties}=await pending((resolve,reject)=>{
      const done=()=>{try{resolve(verifyPrintFrame(camera));}catch(error){reject(error);}};
      writePrintFrame(camera);element.addEventListener(rendered,done,{once:true});
      try{view.render();}catch(error){element.removeEventListener(rendered,done);throw error;}
      return ()=>element.removeEventListener(rendered,done);
    },output.frameMs,messages.frameTimeout);check();
    const blob=await pending((resolve,reject)=>{canvas.toBlob(value=>value?resolve(value):reject(Error(messages.image)),'image/png');});check();
    encoded=output.bytes(encoded,blob.size);
    frames.push({blob,index:camera.index,angle:camera.angle,width:size,height:size,display:output.displayCaption(display.voiRange,properties),
      caption:output.caption({version:job.version,index:camera.index,count:plan.cameras.length,mode:job.mip.mode,orientation:job.mip.orientation,axis:job.recipe?.axis,angle:camera.angle,voiThickness:slab?slab.thickness:null})});
  }
  return {frames,scout:null,width:size,height:size,mip:{version:job.version,mode:job.mip.mode,orientation:job.mip.orientation,recipe:job.recipe}};
};
