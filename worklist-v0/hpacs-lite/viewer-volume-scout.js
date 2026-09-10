/* A disposable orthogonal reference image; never an original CT SOP. */
window.kinRenderVolumeScout=async function({engine,volume,base,corners,frames,properties,signal,check,pending}){
  const model=window.KinVolumeBatchScout,size=256,camera=model.camera(base,corners),viewportId='kin-scout-'+crypto.randomUUID(),element=document.createElement('div');
  element.dataset.kinBatchScoutRender='1';element.style.cssText='position:fixed;left:-10000px;top:0;pointer-events:none;width:'+(size/devicePixelRatio)+'px;height:'+(size/devicePixelRatio)+'px';document.body.append(element);
  try{
    check();engine.enableElement({viewportId,type:cornerstone.Enums.ViewportType.ORTHOGRAPHIC,element,defaultOptions:{suppressEvents:true}});
    const view=engine.getViewport(viewportId);view.suppressEvents=false;
    await pending(signal,(resolve,reject)=>{view.setVolumes([{volumeId:volume.volumeId}]).then(resolve,reject);});check();
    const mapper=view.getActors()[0].actor.getMapper();
    if(typeof mapper.setViewSpecificProperties!=='function')throw Error('위치 참고 영상의 고정 샘플링을 지원하지 않는 뷰어입니다.');
    mapper.setViewSpecificProperties({OpenGL:{ShaderReplacements:[{shaderType:'Fragment',originalValue:'float jitter = 0.01 + 0.99*texture2D(jtexture, gl_FragCoord.xy/32.0).r;',replacementValue:'float jitter = 0.5;',replaceFirst:true,replaceAll:false}]}});
    view.setProperties({invert:false,colormap:{name:'Grayscale',opacity:1}});view.setProperties(properties);view.setBlendMode(0);view.setSlabThickness(.05);view.setCamera(camera);
    await pending(signal,resolve=>{const listener=()=>resolve();element.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,listener,{once:true});view.render();return()=>element.removeEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,listener);},5000);check();
    const actual=view.getCamera(),canvas=view.getCanvas();
    for(const key of ['position','focalPoint','viewPlaneNormal','viewUp'])if(actual[key].some((n,i)=>Math.abs(n-camera[key][i])>1e-5))throw Error('위치 참고 영상의 환자 좌표를 확인하지 못했습니다.');
    if(canvas.width!==size||canvas.height!==size)throw Error('위치 참고 영상의 크기를 확인하지 못했습니다.');
    // Native canvasToWorld multiplies CSS coordinates by DPR. Use exact raster
    // edges divided by DPR, not integer clientWidth at fractional scaling.
    const canvasCorners=[[0,0],[size/devicePixelRatio,0],[0,size/devicePixelRatio]].map(p=>Array.from(view.canvasToWorld(p)));
    const guides=frames.map(row=>model.line(row.camera.viewPlaneNormal,row.camera.focalPoint,canvasCorners,size,size));
    if(guides.some(line=>!line))throw Error('생성 단면의 위치를 참고 영상에 표시하지 못했습니다.');
    const blob=await pending(signal,(resolve,reject)=>{canvas.toBlob(b=>b?resolve(b):reject(Error('위치 참고 영상을 만들지 못했습니다.')),'image/png');});check();
    return {blob,camera:actual,canvasCorners,guides,width:size,height:size};
  }finally{try{engine.disableElement(viewportId);}catch(_){}element.remove();}
};
