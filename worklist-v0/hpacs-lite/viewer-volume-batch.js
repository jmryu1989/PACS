window.kinCreateVolumeBatch=function({target,permitted,alive,owner,host}){
  const panel=document.createElement('section');panel.id='kin-volume-batch';panel.style.cssText='border-top:1px solid #657c9f;padding:8px 0';
  panel.innerHTML='<strong>MPR Batch</strong><p class="target"></p><label>Start Offset (mm) <input aria-label="Batch Start Offset" type="number" step="0.1" value="0" style="width:85px"></label> <label>Interval (mm) <input aria-label="Batch Interval" type="number" min="0.1" max="1000" step="0.1" value="1" style="width:85px"></label> <label>Number <input aria-label="Batch Number" type="number" min="2" max="128" step="1" value="8" style="width:65px"></label> <label><input aria-label="Batch Reverse" type="checkbox"> Reverse</label> <button type="button" class="make">Make Batch</button> <button type="button" class="cancel" disabled>Cancel Batch</button><p role="status"></p><div class="result" hidden><img alt="Reconstructed MPR batch plane" style="max-width:100%;max-height:260px;object-fit:contain;background:black"><p class="frame"></p><button type="button" class="previous">Previous Plane</button> <button type="button" class="next">Next Plane</button> <button type="button" class="play">Play Batch</button> <button type="button" class="clear">Clear Batch</button></div><p>선택 평면에서 법선 방향으로 평행 단면을 만듭니다. Reverse는 반대 방향입니다. 원래 영상 창과 판독문을 유지합니다. 생성 결과는 이 창의 임시 미리보기이며 아직 검사에 저장되지 않습니다.</p>';
  host.append(panel);
  const q=s=>panel.querySelector(s),inputs=[...panel.querySelectorAll('input')],make=q('.make'),cancel=q('.cancel'),status=q('[role=status]'),caption=q('.target'),result=q('.result'),image=q('img'),frame=q('.frame'),previous=q('.previous'),next=q('.next'),play=q('.play'),clear=q('.clear');
  let ended=false,operation=null,output=null,index=0,playTimer=null;
  const live=()=>!ended&&alive();
  function stopPlay(){clearInterval(playTimer);playTimer=null;play.textContent='Play Batch';}
  function clearOutput(){stopPlay();image.removeAttribute('src');if(output)for(const row of output.frames)URL.revokeObjectURL(row.url);output=null;result.hidden=true;frame.textContent='';}
  function current(t,requirePermission=true){const now=live()&&target();return !!now&&(!requirePermission||!document.hidden&&permitted())&&now.group===t.group&&now.selection===t.selection&&now.views.every((v,i)=>v===t.views[i]);}
  const state=t=>JSON.stringify(t.views.map(v=>({camera:v.getCamera(),properties:v.getProperties(),blend:v.getActors()[0].actor.getMapper().getBlendMode(),slab:v.getSlabThickness()})));
  function refresh(){
    if(ended)return;const t=live()&&target();panel.hidden=!t;
    make.disabled=!!operation||!t||!permitted();inputs.forEach(i=>i.disabled=make.disabled);cancel.disabled=!operation;
    if(output&&!current(output.target,false))clearOutput();
    if(operation&&(!current(operation.target)||state(operation.target)!==operation.state))operation.controller.abort();
    if(!permitted())stopPlay();
    if(t)caption.textContent=t.source.study.id+' · Selected View '+(t.views.findIndex(v=>v.id===t.source.viewportId)+1)+' / 3 · '+t.source.series;
  }
  function show(){if(!output)return;const row=output.frames[index];image.src=row.url;frame.textContent=(index+1)+' / '+output.frames.length+' · Center L/P/H (mm): '+row.camera.focalPoint.map(n=>Number(n.toFixed(3))).join(' / ');previous.disabled=index===0;next.disabled=index===output.frames.length-1;}
  function pending(signal,setup,milliseconds=10000){
    return new Promise((resolve,reject)=>{let cleanup=()=>{},settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',aborted);cleanup();error?reject(error):resolve(value);},aborted=()=>finish(Error('단면 생성을 취소했습니다.')),timer=setTimeout(()=>finish(Error('단면 생성 시간이 초과됐습니다.')),milliseconds);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted){aborted();return;}try{cleanup=setup(value=>finish(null,value),error=>finish(error))||cleanup;if(settled)cleanup();}catch(error){finish(error);}});
  }
  async function generate(){
    if(operation||!live()||!permitted())return;
    let op,engine,element,view,viewportId;
    try{
      const t=target(true);if(!t)throw Error('선택한 정규 CT MPR을 확인하세요.');
      const source=t.views.find(v=>v.id===t.source.viewportId),volume=cornerstone.cache.getVolume(source.getVolumeId()),camera=structuredClone(source.getCamera()),properties=structuredClone(source.getProperties()),canvas=source.getCanvas();
      if(inputs.slice(0,3).some(i=>!i.value.trim()))throw Error('시작 위치·간격·장수를 입력하세요.');
      const corners=[0,volume.dimensions[0]-1].flatMap(x=>[0,volume.dimensions[1]-1].flatMap(y=>[0,volume.dimensions[2]-1].map(z=>Array.from(volume.imageData.indexToWorld([x,y,z])))));
      const plan=window.KinVolumeBatch.plan({camera,corners,offset:Number(inputs[0].value),interval:Number(inputs[1].value),count:Number(inputs[2].value),reverse:inputs[3].checked,width:canvas.width,height:canvas.height});
      const bound=JSON.stringify(owner());if(!owner())throw Error('로그인 상태를 확인하세요.');
      op={target:t,state:state(t),controller:new AbortController()};operation=op;refresh();status.textContent='로그인과 생성 범위를 확인 중입니다.';
      const check=()=>{if(op.controller.signal.aborted||operation!==op||!current(t)||JSON.stringify(owner())!==bound||state(t)!==op.state)throw Error('화면이 변경되어 단면 생성을 취소했습니다.');};
      const me=await pending(op.controller.signal,(resolve,reject)=>{fetch('/api/me',{credentials:'same-origin',cache:'no-store',signal:op.controller.signal}).then(r=>{if(!r.ok)throw Error('로그인 상태를 확인할 수 없습니다.');return r.json();}).then(resolve,reject);});
      if(me.kind!=='member'||JSON.stringify([me.institution,me.sub])!==bound)throw Error('계정이 변경되어 단면 생성을 취소했습니다.');check();clearOutput();
      // A volume's native texture belongs to its existing GL context. A second
      // engine renders black and may invalidate that shared source texture.
      engine=source.getRenderingEngine();viewportId='kin-batch-'+crypto.randomUUID();element=document.createElement('div');element.dataset.kinBatchRender='1';element.style.cssText='position:fixed;left:-10000px;top:0;pointer-events:none;width:'+(plan.columns/devicePixelRatio)+'px;height:'+(plan.rows/devicePixelRatio)+'px';document.body.append(element);
      // This viewport has no OHIF tool group. Do not broadcast its creation to
      // the native crosshair reset binder; retain our own image-render events.
      engine.enableElement({viewportId,type:cornerstone.Enums.ViewportType.ORTHOGRAPHIC,element,defaultOptions:{suppressEvents:true}});view=engine.getViewport(viewportId);view.suppressEvents=false;await pending(op.controller.signal,(resolve,reject)=>{view.setVolumes([{volumeId:volume.volumeId}]).then(resolve,reject);});check();
      view.setProperties({invert:false,colormap:{name:'Grayscale',opacity:1}});view.setProperties(properties);
      const blend=source.getActors()[0].actor.getMapper().getBlendMode();if(blend===3)window.kinPrepareVolumeAverage(view,volume);view.setBlendMode(blend);view.setSlabThickness(source.getSlabThickness());
      const frames=[];let bytes=0;
      for(let i=0;i<plan.cameras.length;i++){
        check();const c=structuredClone(plan.cameras[i]);delete c.rotation;view.setCamera(c);
        await pending(op.controller.signal,(resolve)=>{const listener=()=>resolve();element.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,listener,{once:true});view.render();return ()=>element.removeEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,listener);},5000);check();
        const actual=view.getCamera();for(const k of ['focalPoint','position','viewPlaneNormal','viewUp'])if(actual[k].some((n,j)=>Math.abs(n-c[k][j])>1e-5))throw Error('생성 단면의 환자 좌표를 확인하지 못했습니다.');
        const out=view.getCanvas();if(out.width!==plan.columns||out.height!==plan.rows)throw Error('생성 단면 크기를 확인하지 못했습니다.');
        const blob=await pending(op.controller.signal,(resolve,reject)=>{out.toBlob(b=>b?resolve(b):reject(Error('단면 영상을 만들지 못했습니다.')),'image/png');});check();bytes+=blob.size;if(bytes>32*1024*1024)throw Error('생성 결과가 32 MiB를 넘었습니다. 장수를 줄이세요.');
        frames.push({blob,camera:actual});status.textContent=(i+1)+' / '+plan.cameras.length+' 단면 생성 중';
      }
      check();output={target:t,frames:frames.map(row=>({...row,url:URL.createObjectURL(row.blob)}))};index=0;result.hidden=false;show();status.textContent=frames.length+'개 단면 미리보기를 생성했습니다.';
    }catch(error){if(live())status.textContent=error.message||'단면을 생성하지 못했습니다.';}
    finally{op?.controller.abort();if(viewportId)try{engine?.disableElement(viewportId);}catch(_){}element?.remove();if(operation===op)operation=null;refresh();}
  }
  make.onclick=generate;cancel.onclick=()=>operation?.controller.abort();
  previous.onclick=()=>{stopPlay();if(output&&index>0){index--;show();}};next.onclick=()=>{stopPlay();if(output&&index<output.frames.length-1){index++;show();}};
  play.onclick=()=>{if(playTimer){stopPlay();return;}if(!output||!current(output.target))return;play.textContent='Stop Batch';playTimer=setInterval(()=>{if(!output||!current(output.target)||document.hidden){stopPlay();return;}index=(index+1)%output.frames.length;show();},100);};
  clear.onclick=()=>{clearOutput();status.textContent='단면 미리보기를 비웠습니다.';};
  const timer=setInterval(refresh,250);refresh();
  return {dispose(){ended=true;operation?.controller.abort();clearOutput();clearInterval(timer);panel.remove();}};
};
