/* Reconstruct saved batch output from private, freshly read CT pixels. */
window.kinRenderVolumeJobPrint=async function({snapshot,api,bytes,signal,check}){
  const core=window.cornerstone,reference=snapshot.volume,batch=snapshot.batch;
  if(snapshot.version!==5||!batch||typeof window.KinVolumeBatch?.plan!=='function'||typeof window.KinVolumeBatchScout?.camera!=='function'||typeof window.KinVolumeBatchScout?.line!=='function'||typeof window.kinRenderVolumeScout!=='function')throw Error('단면 묶음 출력 도구를 불러오지 못했습니다.');
  if(batch.cell.projection.blend===3&&typeof window.kinPrepareVolumeAverage!=='function')throw Error('평균 투영 출력 도구를 불러오지 못했습니다.');
  const fail=()=>{throw Error('저장한 CT 원본의 화소·좌표를 확인할 수 없습니다.');};
  const list=value=>Array.isArray(value)?value.map(Number):String(value).split('\\').map(Number);
  const near=(a,b)=>a.length===b.length&&a.every((n,i)=>Number.isFinite(n)&&Math.abs(n-b[i])<.001);
  const read=async path=>JSON.parse(new TextDecoder().decode(await bytes(path,signal,524288,budget)));
  const budget={bytes:0},slices=new Array(reference.sops.length);let next=0;
  if(slices.length<2)fail();if(slices.length>256)throw Error('출력 CT 원본은 최대 256장까지 지원합니다.');
  await Promise.all(Array.from({length:Math.min(4,slices.length)},async()=>{
    while(next<slices.length){
      const index=next++,sop=reference.sops[index];check();
      const location=await api('/dicom/lookup',{signal,method:'POST',body:JSON.stringify({studyUid:reference.study,sopUid:sop})});
      if(!/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(location.id))fail();
      const path='/instances/'+location.id,info=await read(path+'/attachments/dicom/info'),tags=await read(path+'/simplified-tags');check();
      const digest=info.UncompressedMD5?.toLowerCase(),rows=Number(tags.Rows),columns=Number(tags.Columns),signed=Number(tags.PixelRepresentation)===1;
      if(!/^[a-f0-9]{32}$/.test(digest)||tags.StudyInstanceUID!==reference.study||tags.SeriesInstanceUID!==reference.series||tags.SOPInstanceUID!==sop||
        tags.SOPClassUID!=='1.2.840.10008.5.1.4.1.1.2'||tags.Modality!=='CT'||Number(tags.NumberOfFrames??1)!==1||Number(tags.SamplesPerPixel)!==1||tags.PhotometricInterpretation!=='MONOCHROME2'||
        ![rows,columns].every(n=>Number.isInteger(n)&&n>=2)||
        Number(tags.BitsAllocated)!==16||!Number.isInteger(Number(tags.BitsStored))||Number(tags.BitsStored)<1||Number(tags.BitsStored)>16||Number(tags.HighBit)!==Number(tags.BitsStored)-1||![0,1].includes(Number(tags.PixelRepresentation)))fail();
      if(rows>8192||columns>8192||rows*columns*slices.length>16777216)throw Error('출력 CT 원본 크기가 한도를 초과했습니다(한 변 8192, 전체 16,777,216 화소).');
      const raw=await bytes(path+'/frames/0/'+(signed?'image-int16':'image-uint16'),signal,8388608,budget,'image/x-portable-arbitrarymap');
      if((await read(path+'/attachments/dicom/info')).UncompressedMD5?.toLowerCase()!==digest)throw Error('출력 준비 중 원본이 변경되었습니다.');check();
      const header=/^P7\nWIDTH (\d+)\nHEIGHT (\d+)\nDEPTH 1\nMAXVAL 65535\nTUPLTYPE GRAYSCALE\nENDHDR\n/.exec(new TextDecoder().decode(raw.subarray(0,512)));
      if(!header||Number(header[1])!==columns||Number(header[2])!==rows||raw.length!==header[0].length+rows*columns*2)fail();
      slices[index]={tags,digest,raw,offset:header[0].length,signed,rows,columns};
    }
  }));check();
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(slices.map((s,i)=>[reference.sops[i],s.digest]))))),n=>n.toString(16).padStart(2,'0')).join('');
  if(digest!==reference.sourceDigest)throw Error('저장 당시 전체 원본과 달라 출력하지 않았습니다.');check();
  const first=slices[0],tags=first.tags,orientation=list(tags.ImageOrientationPatient),origin=list(tags.ImagePositionPatient),pixelSpacing=list(tags.PixelSpacing);
  const step=list(slices[1].tags.ImagePositionPatient).map((n,i)=>n-origin[i]),distance=Math.hypot(...step),slope=Number(tags.RescaleSlope),intercept=Number(tags.RescaleIntercept);
  if(orientation.length!==6||origin.length!==3||pixelSpacing.length!==2||[...orientation,...origin,...pixelSpacing,distance,slope,intercept].some(n=>!Number.isFinite(n))||pixelSpacing.some(n=>n<=0)||distance<.001||slope===0||!tags.FrameOfReferenceUID)fail();
  const x=orientation.slice(0,3),y=orientation.slice(3),normal=[x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0]],dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
  if(Math.abs(dot(x,x)-1)>1e-4||Math.abs(dot(y,y)-1)>1e-4||Math.abs(dot(x,y))>1e-4||!near(step,normal.map(n=>n*dot(step,normal))))fail();
  const identity=t=>JSON.stringify([t.PatientID,t.FrameOfReferenceUID,list(t.ImageOrientationPatient),list(t.PixelSpacing),Number(t.Rows),Number(t.Columns),Number(t.RescaleSlope),Number(t.RescaleIntercept),Number(t.BitsAllocated),Number(t.BitsStored),Number(t.HighBit),Number(t.PixelRepresentation)]);
  if(slices.some((s,i)=>identity(s.tags)!==identity(tags)||!near(list(s.tags.ImagePositionPatient),origin.map((n,k)=>n+step[k]*i))))fail();
  const length=first.rows*first.columns,pixels=new Float32Array(length*slices.length);
  for(const [z,s] of slices.entries()){
    const data=new DataView(s.raw.buffer,s.raw.byteOffset+s.offset,length*2);
    for(let i=0;i<length;i++){const value=(s.signed?data.getInt16(i*2):data.getUint16(i*2))*slope+intercept;pixels[z*length+i]=value;if(!Number.isFinite(pixels[z*length+i]))fail();}
    s.raw=null;
  }
  check();
  const id='kin-batch-print-'+crypto.randomUUID(),imageIds=slices.map((_,i)=>id+'-slice-'+i),entries=new Map(),provider=(type,imageId)=>entries.get(imageId)?.[type];
  const dimensions=[first.columns,first.rows,slices.length],spacing=[pixelSpacing[1],pixelSpacing[0],distance],direction=[...orientation,...step.map(n=>n/distance)];
  let engine,volume,element;core.metaData.addProvider(provider,10000);
  function pending(setup,ms=10000){return new Promise((resolve,reject)=>{
    let clean=()=>{},done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);clean();error?reject(error):resolve(value);},abort=()=>finish(Error('출력 준비를 취소했습니다.')),timer=setTimeout(()=>finish(Error('출력 영상 준비 시간이 초과됐습니다.')),ms);
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}try{clean=setup(value=>finish(null,value),error=>finish(error))||clean;if(done)clean();}catch(error){finish(error);}
  });}
  try{
    // Reserve before synchronous insertion. Never let private output evict a
    // diagnostic frame, and never put temporary metadata in the global store.
    if(core.cache.getBytesAvailable()<pixels.byteLength*2)throw Error('출력용 CT 메모리가 부족합니다. 다른 검사를 닫고 다시 확인하세요.');
    for(const [z,imageId] of imageIds.entries()){
      const scalarData=pixels.subarray(z*length,(z+1)*length);let min=Infinity,max=-Infinity;for(const n of scalarData){min=Math.min(min,n);max=Math.max(max,n);}
      entries.set(imageId,{imagePlaneModule:{frameOfReferenceUID:tags.FrameOfReferenceUID,rows:first.rows,columns:first.columns,rowCosines:x,columnCosines:y,imagePositionPatient:origin.map((n,i)=>n+step[i]*z),rowPixelSpacing:spacing[1],columnPixelSpacing:spacing[0]},generalSeriesModule:{modality:'CT'},modalityLutModule:{rescaleSlope:1,rescaleIntercept:0},voiLutModule:{windowCenter:[40],windowWidth:[400]},imagePixelModule:{samplesPerPixel:1,photometricInterpretation:'MONOCHROME2',rows:first.rows,columns:first.columns,bitsAllocated:32,bitsStored:32,highBit:31,pixelRepresentation:1}});
      core.cache.putImageSync(imageId,{imageId,width:first.columns,height:first.rows,rows:first.rows,columns:first.columns,color:false,rgba:false,numberOfComponents:1,slope:1,intercept:0,minPixelValue:min,maxPixelValue:max,windowCenter:40,windowWidth:400,rowPixelSpacing:spacing[1],columnPixelSpacing:spacing[0],sizeInBytes:scalarData.byteLength,getPixelData:()=>scalarData,imageFrame:{},preScale:{scaled:true,scalingParameters:{rescaleSlope:1,rescaleIntercept:0,modality:'CT'}},voxelManager:core.utilities.VoxelManager.createImageVoxelManager({scalarData,width:first.columns,height:first.rows,numberOfComponents:1})});
    }
    volume=new core.ImageVolume({volumeId:id,metadata:{Modality:'CT',FrameOfReferenceUID:tags.FrameOfReferenceUID},dimensions,spacing,origin,direction,imageIds,dataType:'Float32Array',numberOfComponents:1});core.cache.putVolumeSync(id,volume);
    // Local pixel insertion has no streaming loader to mark texture slices.
    // Upload every private frame before the first reconstructed plane renders.
    volume.invalidate();
    engine=new core.RenderingEngine(id);const base={...structuredClone(batch.cell.camera),parallelProjection:true},corners=[0,dimensions[0]-1].flatMap(a=>[0,dimensions[1]-1].flatMap(b=>[0,dimensions[2]-1].map(c=>Array.from(volume.imageData.indexToWorld([a,b,c])))));
    const plan=window.KinVolumeBatch.plan({camera:base,corners,...batch,width:batch.cell.viewport.width,height:batch.cell.viewport.height});
    element=document.createElement('div');element.dataset.kinBatchPrintRender='1';element.style.cssText='position:fixed;left:-20000px;top:0;width:'+(plan.columns/devicePixelRatio)+'px;height:'+(plan.rows/devicePixelRatio)+'px';document.body.append(element);
    engine.enableElement({viewportId:id,type:core.Enums.ViewportType.ORTHOGRAPHIC,element,defaultOptions:{suppressEvents:true}});const view=engine.getViewport(id);view.suppressEvents=false;
    await pending((resolve,reject)=>{view.setVolumes([{volumeId:id}]).then(resolve,reject);});check();
    view.getActors()[0].actor.getMapper().setViewSpecificProperties({OpenGL:{ShaderReplacements:[{shaderType:'Fragment',originalValue:'float jitter = 0.01 + 0.99*texture2D(jtexture, gl_FragCoord.xy/32.0).r;',replacementValue:'float jitter = 0.5;',replaceFirst:true,replaceAll:false}]}});
    view.setProperties({invert:false,colormap:{name:'Grayscale',opacity:1}});view.setProperties(batch.cell.properties);
    if(batch.cell.projection.blend===3){
      // A fresh GL context has no range metadata until its texture uploads.
      // Initialize it with a private thin render before preparing Average.
      view.setBlendMode(0);view.setSlabThickness(.05);
      await pending(resolve=>{const done=()=>resolve();element.addEventListener(core.Enums.Events.IMAGE_RENDERED,done,{once:true});view.render();return ()=>element.removeEventListener(core.Enums.Events.IMAGE_RENDERED,done);},5000);check();
      window.kinPrepareVolumeAverage(view,volume);
    }
    view.setBlendMode(batch.cell.projection.blend);view.setSlabThickness(batch.cell.projection.thickness/2);
    const frames=[];let encoded=0;
    for(const camera of plan.cameras){
      check();const next={...camera};delete next.rotation;view.setCamera(next);
      await pending(resolve=>{const done=()=>resolve();element.addEventListener(core.Enums.Events.IMAGE_RENDERED,done,{once:true});view.render();return ()=>element.removeEventListener(core.Enums.Events.IMAGE_RENDERED,done);},5000);check();
      const actual=view.getCamera(),canvas=view.getCanvas();if(canvas.width!==plan.columns||canvas.height!==plan.rows||['focalPoint','position','viewPlaneNormal','viewUp'].some(key=>actual[key].some((n,i)=>Math.abs(n-camera[key][i])>1e-5)))throw Error('출력 단면의 크기·환자 좌표를 재현하지 못했습니다.');
      const blob=await pending((resolve,reject)=>{canvas.toBlob(value=>value?resolve(value):reject(Error('출력 단면을 만들지 못했습니다.')),'image/png');});check();encoded+=blob.size;if(encoded>32*1024*1024)throw Error('출력 단면 용량 한도를 초과했습니다.');frames.push({blob,camera:actual});
    }
    const scout=await window.kinRenderVolumeScout({engine,volume,base,corners,frames,properties:batch.cell.properties,signal,check,pending:(_signal,setup,ms)=>pending(setup,ms)});check();if(encoded+scout.blob.size>32*1024*1024)throw Error('출력 단면 용량 한도를 초과했습니다.');
    return {frames,scout,width:plan.columns,height:plan.rows};
  }finally{
    engine?.destroy();element?.remove();if(core.cache.getVolume(id))core.cache.removeVolumeLoadObject(id);
    for(const imageId of imageIds)if(core.cache.getImageLoadObject(imageId))core.cache.removeImageLoadObject(imageId);
    core.metaData.removeProvider(provider);entries.clear();
  }
};
