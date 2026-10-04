(function(root){
  'use strict';
  /* The VR mask path on the GPU (S8-SCULPT-PERF B-u). Every mask is uniform data of one fixed getColorForValue replacement
     (KinVolumeVrMasks.TEXT), so the program is compiled once per display variant in a context and an edit only writes
     numbers. preflight installs that program in the renderer's own shader cache before anything is written; session runs
     the requests on it.
     A request is checked (a refusal changes nothing), installed when needed (a refusal writes nothing and takes no
     generation), given a page-wide generation and written as pending: kinHead is cleared first, so an interrupted write draws
     nothing, then every array, a GL error check, and kinHead = (generation, count). One frame is drawn and checked in this
     order: a closed session, a lost or replaced context and a newer request end it (cancelled-session, cancelled-context,
     superseded); a frame that reported an error fails it whatever the uniforms hold; then the drawn program must carry the
     fixed text and read back the generation and spot values, with one rewrite and one more frame for a stale program (a
     variant the frame just compiled has no data yet). Only a request whose own frame passed becomes committed. After a
     failure the committed data (no masks when nothing was committed) is written and drawn again, so the shown image is the
     committed one; when even that cannot be shown the result says so and the caller closes the display (fail closed). */
  const SIGNATURE='vec4 getColorForValue(vec4 tValue, vec3 posIS, vec3 tstep)\n{';
  const owned=text=>/kinSculptPoint\d|kinVoiDistance/.test(text);
  const NAMES=['kinHead','kinMeta','kinProj','kinBox','kinEll','kinEdge','kinCross','kinVoi','kinVoiHalf'];
  const RETRIES=1;
  // Page-wide, so a value a closed session left in a shared program can never pass for a newer request's.
  let generations=0,empty=null;
  function refusal(reason,message){const error=Error(message);error.kinVrReason=reason;return error;}
  function model(){const masks=root.KinVolumeVrMasks;if(!masks)throw refusal('render-failed','VR 가림 모듈을 불러오지 못했습니다.');return masks;}
  const renderWindow=target=>target.engine.offscreenMultiRenderWindow.getOpenGLRenderWindow();
  function drawnProgram(windowGL,mapper){try{return windowGL.getViewNodeFor(mapper)?.get('tris')?.tris?.getProgram()||null;}catch(_){return null;}}
  function cachedPrograms(windowGL){try{const programs=windowGL.getShaderCache?.()?.get?.('shaderPrograms')?.shaderPrograms;return programs&&typeof programs==='object'?programs:null;}catch(_){return null;}}
  const sourcesOf=program=>({vertex:program.getVertexShader().getSource(),fragment:program.getFragmentShader().getSource(),geometry:program.getGeometryShader?.()?.getSource?.()??''});
  // The handle of a cache entry compiled and linked in this live context; a context restored after a loss keeps the cache
  // object but not its programs.
  function liveHandle(entry,gl){
    try{
      if(entry?.getCompiled?.()!==true||entry.getLinked?.()!==true||entry.get?.('context')?.context!==gl)return null;
      const handle=entry.getHandle?.();return handle&&gl.isProgram(handle)?handle:null;
    }catch(_){return null;}
  }
  function linkedProgram(windowGL,gl,source){
    if(gl.isContextLost())return null;
    for(const entry of Object.values(cachedPrograms(windowGL)||{})){
      try{if(liveHandle(entry,gl)&&entry.getVertexShader().getSource()===source.vertex&&entry.getFragmentShader().getSource()===source.fragment&&(entry.getGeometryShader?.()?.getSource?.()??'')===source.geometry)return entry;}catch(_){}
    }
    return null;
  }
  // Every linked program of this context built with the fixed text: one per display variant. Each gets the data, so a
  // variant the display returns to shows the current masks.
  function fixedPrograms(windowGL,gl,text){
    const handles=[];
    for(const entry of Object.values(cachedPrograms(windowGL)||{})){try{const handle=liveHandle(entry,gl);if(handle&&entry.getFragmentShader().getSource().includes(text))handles.push(handle);}catch(_){}}
    return handles;
  }
  // The drawn fragment as the variant was before any mask: without the fixed text, or without a generated owned block.
  function unmasked(fragment,text){
    if(fragment.includes(text))return fragment.replace(text,()=>SIGNATURE);
    const start=fragment.indexOf(SIGNATURE);
    if(start<0)throw Error('VR GPU 표본 함수를 확인할 수 없습니다.');
    const prefix=fragment.slice(0,start+SIGNATURE.length);let tail=fragment.slice(start+SIGNATURE.length);
    while(tail.startsWith('\n  {')){
      let depth=0,end=-1;
      for(let i=3;i<tail.length;i++){
        if(tail[i]==='{')depth++;
        if(tail[i]==='}'&&--depth===0){end=i+1;break;}
      }
      if(end<0||!owned(tail.slice(0,end)))break;
      tail=tail.slice(end);
    }
    return prefix+tail;
  }
  function ownedReplacement(properties){
    const list=(properties?.OpenGL?.ShaderReplacements||[]).filter(r=>owned(r?.replacementValue||''));
    if(list.length>1)throw Error('VR GPU 가림 설정이 중복되었습니다.');
    const replacement=list[0]||null;
    if(replacement&&(replacement.originalValue!==SIGNATURE||replacement.shaderType!=='Fragment'||replacement.replaceAll!==false||replacement.replaceFirst!==true))throw Error('VR GPU 가림 형식을 확인할 수 없습니다.');
    return replacement;
  }
  function discard(windowGL,gl,entry){
    try{const programs=cachedPrograms(windowGL),key=entry.getMd5Hash?.();if(programs&&key&&programs[key]===entry)delete programs[key];}catch(_){}
    try{const handle=entry.getHandle?.();if(handle)gl.deleteProgram(handle);}catch(_){}
    for(const shader of [entry.getVertexShader?.(),entry.getFragmentShader?.(),entry.getGeometryShader?.()])try{shader?.cleanup?.();}catch(_){}
  }
  /* Install: the program the next frame will draw with these properties is compiled and linked once, in the renderer's own
     shader cache under the key that frame looks up (its three final sources), so the frame binds it without compiling it
     again. A program the renderer already linked from exactly these sources in this live context is used as it is. A
     compile or link failure removes the entry again, so nothing half-built stays for a later frame or a second attempt,
     and throws: the caller writes nothing and keeps the display. Returns whether it compiled. */
  function preflight(target,properties){
    const windowGL=renderWindow(target),gl=windowGL.getContext();
    if(typeof gl?.isContextLost!=='function'||gl.isContextLost())throw Error('VR GPU 연결을 확인할 수 없습니다.');
    const program=drawnProgram(windowGL,target.mapper);
    if(!program?.getCompiled?.()||!program.getLinked?.())throw Error('VR GPU 준비가 끝난 뒤 다시 적용하세요.');
    const replacement=ownedReplacement(properties),source=sourcesOf(program);
    source.fragment=unmasked(source.fragment,model().TEXT);
    if(replacement)source.fragment=source.fragment.replace(SIGNATURE,()=>replacement.replacementValue);
    if(linkedProgram(windowGL,gl,source))return false;
    const cache=windowGL.getShaderCache();
    let entry=cache.getShaderProgram(source.vertex,source.fragment,source.geometry);
    // An entry of these sources whose program did not survive a lost context would answer as compiled without one.
    if(entry.getCompiled?.()&&!liveHandle(entry,gl)){discard(windowGL,gl,entry);entry=cache.getShaderProgram(source.vertex,source.fragment,source.geometry);}
    let ready=null;try{ready=cache.readyShaderProgram(entry);}catch(_){ready=null;}
    if(!ready||!liveHandle(entry,gl)){discard(windowGL,gl,entry);throw Error('VR 가림을 GPU에서 컴파일하지 못했습니다. 기존 표시를 유지합니다.');}
    return true;
  }
  function withoutOwned(properties){
    const list=properties?.OpenGL?.ShaderReplacements;
    if(!Array.isArray(list)||!list.some(r=>owned(r?.replacementValue||'')))return properties;
    return {...properties,OpenGL:{...properties.OpenGL,ShaderReplacements:list.filter(r=>!owned(r?.replacementValue||''))}};
  }
  const same=(got,want)=>!!got&&got.length===want.length&&Array.prototype.every.call(got,(value,index)=>value===want[index]);

  /* One VR display's masks. target = {engine, mapper, frame}: frame(done) schedules one render of the display and calls
     done({error}) after it, with error set when the render or the copy to the screen failed. install(target, properties)
     installs the fixed program (preflight unless the caller names its own). onLost runs after the session has dropped what
     belonged to a lost context. Requests resolve to {status, gen, error, restore}; status is ok, failed, superseded,
     cancelled-session or cancelled-context, and restore tells whether the committed image is shown again after a failure. */
  function session({target,install=preflight,onLost=()=>{}}){
    const s={target,closed:false,lost:false,context:0,latest:0,pending:null,committed:null,written:null,installed:false,
      locations:new WeakMap(),waits:new Set(),pristine:new WeakMap(),canvas:null};
    const contextOf=()=>{const windowGL=renderWindow(s.target);return {windowGL,gl:windowGL.getContext()};};
    const committedData=()=>s.committed?s.committed.data:empty||(empty=model().pack({}));
    // A lost context takes its programs, handles and uniform locations with it: nothing of it is used again, the request
    // in flight ends as cancelled-context and the committed request stays as it was.
    function invalidate(status){
      s.context++;s.installed=false;s.written=null;s.pending=null;s.locations=new WeakMap();
      for(const wait of [...s.waits])wait.finish(status);
    }
    const onLoss=()=>{if(s.closed||s.lost)return;invalidate('cancelled-context');s.lost=true;try{onLost();}catch(_){}};
    function listen(){
      s.canvas?.removeEventListener?.('webglcontextlost',onLoss);s.canvas=null;
      try{s.canvas=contextOf().gl.canvas||null;s.canvas?.addEventListener?.('webglcontextlost',onLoss);}catch(_){s.canvas=null;}
    }
    listen();
    const usable=gl=>!s.closed&&!s.lost&&!gl.isContextLost();
    function locate(gl,handle){
      let found=s.locations.get(handle);if(found)return found;
      found={};
      for(const name of NAMES){found[name]=gl.getUniformLocation(handle,name);if(!found[name])throw refusal('render-failed','VR 가림 program에 '+name+' 값이 없습니다.');}
      s.locations.set(handle,found);return found;
    }
    function carries(mapper,text){const list=mapper.getViewSpecificProperties?.()?.OpenGL?.ShaderReplacements;return Array.isArray(list)&&list.some(r=>r?.replacementValue===text);}
    function ensureInstalled(){
      const masks=model(),mapper=s.target.mapper;
      if(s.installed&&carries(mapper,masks.TEXT))return;
      if(!s.pristine.has(mapper))s.pristine.set(mapper,withoutOwned(mapper.getViewSpecificProperties()||{}));
      const properties=masks.properties(s.pristine.get(mapper),masks.REPLACEMENT);
      try{install(s.target,properties);}catch(error){throw refusal('render-failed',error?.message||'VR 가림을 GPU에서 확인하지 못했습니다. 기존 표시를 유지합니다.');}
      mapper.setViewSpecificProperties(properties);s.installed=true;
    }
    function writeHandle(gl,handle,data,gen){
      const at=locate(gl,handle);
      gl.uniform4i(at.kinHead,0,0,0,0);
      gl.uniform4iv(at.kinMeta,data.meta);gl.uniform4fv(at.kinProj,data.proj);gl.uniform4fv(at.kinBox,data.box);gl.uniform4fv(at.kinEll,data.ell);
      gl.uniform4fv(at.kinEdge,data.edge);gl.uniform4iv(at.kinCross,data.cross);gl.uniform4fv(at.kinVoi,data.voi);gl.uniform2fv(at.kinVoiHalf,data.voiHalf);
      const error=gl.getError();if(error!==gl.NO_ERROR)throw refusal('render-failed','VR 가림 값을 GPU에 쓰지 못했습니다 (GL '+error+').');
      gl.uniform4i(at.kinHead,gen,data.count,0,0);
    }
    function write(gen,data){
      const {windowGL,gl}=contextOf();
      if(!usable(gl))throw refusal('context-lost','GPU 연결이 끊겨 VR 가림 값을 쓰지 못했습니다.');
      const handles=fixedPrograms(windowGL,gl,model().TEXT);
      if(!handles.length)throw refusal('render-failed','VR 가림 program을 찾지 못했습니다.');
      // Errors another user of the shared context left are not this write's.
      for(let n=0;n<16&&gl.getError()!==gl.NO_ERROR;n++);
      const current=gl.getParameter(gl.CURRENT_PROGRAM);s.written=null;
      // The bound program is restored, so the renderer's own bound-program bookkeeping stays true.
      try{for(const handle of handles){gl.useProgram(handle);writeHandle(gl,handle,data,gen);}}
      finally{gl.useProgram(current);}
      s.written={gen,data};
    }
    function check(gen,data){
      const {windowGL,gl}=contextOf(),program=drawnProgram(windowGL,s.target.mapper),handle=program?.getHandle?.();
      if(!handle||program.getLinked?.()!==true||!gl.isProgram(handle))return {ok:false,retry:true,why:'drawn program not linked'};
      let fragment='';try{fragment=program.getFragmentShader().getSource();}catch(_){}
      if(!fragment.includes(model().TEXT))return {ok:false,retry:false,why:'drawn program without the fixed masks'};
      const read=name=>{const location=gl.getUniformLocation(handle,name);return location?gl.getUniform(handle,location):null;};
      const head=read('kinHead');
      if(!head||head[0]!==gen||head[1]!==data.count)return {ok:false,retry:true,why:head&&head[0]>0?'generation '+head[0]+' instead of '+gen:'masks not written'};
      const spots=[['kinVoi',data.voi],['kinVoiHalf',data.voiHalf],['kinCross[0]',data.cross.subarray(0,4)],['kinEdge[0]',data.edge.subarray(0,4)]];
      if(data.count)spots.push(['kinMeta['+(data.count-1)+']',data.meta.subarray(4*(data.count-1),4*data.count)],['kinProj['+(2*data.count-1)+']',data.proj.subarray(4*(2*data.count-1),4*(2*data.count))]);
      if(data.edges)spots.push(['kinEdge['+(data.edges-1)+']',data.edge.subarray(4*(data.edges-1),4*data.edges)]);
      for(const [name,want] of spots)if(!same(read(name),want))return {ok:false,retry:true,why:'masks differ at '+name};
      return {ok:true};
    }
    // One frame of the written generation, then the checks; resolves to {status, error}.
    function shown(gen,data){
      return new Promise(resolve=>{
        const context=s.context;let retries=0,done=false;
        const wait={finish(status,error){if(done)return;done=true;s.waits.delete(wait);resolve(error?{status,error}:{status});}};
        s.waits.add(wait);
        const settle=info=>{
          if(done)return;
          if(s.closed){wait.finish('cancelled-session');return;}
          let gl=null;try{gl=contextOf().gl;}catch(_){}
          if(s.context!==context||s.lost||!gl||gl.isContextLost()){wait.finish('cancelled-context');return;}
          if(s.latest!==gen){wait.finish('superseded');return;}
          if(!info||info.error){const error=info?.error;wait.finish('failed',typeof error?.message==='string'?error:Error(error?String(error):'VR 화면이 그려졌는지 확인하지 못했습니다.'));return;}
          const result=check(gen,data);
          if(result.ok){wait.finish('ok');return;}
          if(retries<RETRIES&&result.retry){retries++;try{write(gen,data);}catch(error){wait.finish('failed',error);return;}frame();return;}
          wait.finish('failed',Error('VR 가림 표시를 확인하지 못했습니다 ('+result.why+').'));
        };
        const frame=()=>{let reported=false;const report=info=>{if(!reported){reported=true;settle(info);}};try{s.target.frame(report);}catch(error){report({error});}};
        frame();
      });
    }
    function restore(failed){
      let gl=null;try{gl=contextOf().gl;}catch(_){}
      if(s.closed||s.lost||!gl||gl.isContextLost())return Promise.resolve({status:'skipped'});
      if(s.latest!==failed)return Promise.resolve({status:'superseded'});
      const data=committedData(),gen=++generations;s.latest=gen;
      try{write(gen,data);}catch(error){return Promise.resolve({status:'failed',error});}
      return shown(gen,data).then(result=>result.status==='ok'?{status:'ok',gen}:result);
    }
    function apply(request){
      if(s.closed)throw refusal('render-failed','VR 가림 표시가 닫혔습니다.');
      const data=model().pack(request),{gl}=contextOf();
      if(s.lost||gl.isContextLost())throw refusal('context-lost','GPU 연결이 끊겨 VR 가림을 적용할 수 없습니다.');
      ensureInstalled();
      const gen=++generations;s.latest=gen;s.pending={gen,request};
      return new Promise(resolve=>{
        const end=(status,extra)=>{if(s.pending?.gen===gen)s.pending=null;resolve({status,gen,...extra});};
        const failed=error=>{if(s.pending?.gen===gen)s.pending=null;restore(gen).then(restored=>end('failed',{error,restore:restored}));};
        try{write(gen,data);}catch(error){failed(error);return;}
        shown(gen,data).then(result=>{
          if(result.status==='ok'){s.committed={gen,request,data};end('ok');}
          else if(result.status==='failed')failed(result.error);
          else end(result.status);
        });
      });
    }
    // A redraw after a display or crop change shows the committed masks on the variant that frame builds. Without installed
    // masks it is a plain frame; with a request in flight that request's own frame check covers it.
    function render(){
      if(s.closed)return Promise.resolve({status:'cancelled-session'});
      if(s.lost)return Promise.resolve({status:'cancelled-context'});
      if(!s.installed||s.pending)return new Promise(resolve=>{let reported=false;const report=info=>{if(reported)return;reported=true;resolve(info?.error?{status:'failed',error:info.error}:{status:s.pending?'pending':'ok'});};try{s.target.frame(report);}catch(error){report({error});}});
      const data=committedData();let gen;
      try{if(s.written&&s.written.data===data&&s.written.gen===s.latest)gen=s.written.gen;else{gen=++generations;s.latest=gen;write(gen,data);}}
      catch(error){return Promise.resolve({status:'failed',error});}
      return shown(gen,data);
    }
    // Given another render target (a new context), install the fixed program there and apply the committed request again;
    // a pending request is never carried over.
    function reacquire(next){
      if(s.closed)throw refusal('render-failed','VR 가림 표시가 닫혔습니다.');
      s.target=next;listen();invalidate('cancelled-context');s.lost=false;
      const committed=s.committed;if(!committed)return Promise.resolve({status:'ok',gen:null});
      if(contextOf().gl.isContextLost()){s.lost=true;throw refusal('context-lost','GPU 연결이 끊겨 VR 가림을 다시 적용할 수 없습니다.');}
      ensureInstalled();
      const gen=++generations;s.latest=gen;
      try{write(gen,committed.data);}catch(error){return Promise.resolve({status:'failed',gen,error});}
      return shown(gen,committed.data).then(result=>{if(result.status==='ok'&&s.committed===committed)s.committed={...committed,gen};return {...result,gen};});
    }
    // Told of a loss by its owner (the loss may be reported before this context's own event).
    function lost(){if(s.closed||s.lost)return;invalidate('cancelled-context');s.lost=true;}
    function close(){
      if(s.closed)return;s.closed=true;
      for(const wait of [...s.waits])wait.finish('cancelled-session');
      s.pending=null;s.canvas?.removeEventListener?.('webglcontextlost',onLoss);s.canvas=null;
    }
    const state=()=>({status:s.closed?'closed':s.lost?'lost':'open',installed:s.installed,
      committed:s.committed?{gen:s.committed.gen,request:s.committed.request}:null,pending:s.pending?{gen:s.pending.gen,request:s.pending.request}:null});
    return Object.freeze({apply,render,reacquire,lost,close,state});
  }
  root.KinVolumeMaskRenderer=Object.freeze({preflight,session});
})(window);
