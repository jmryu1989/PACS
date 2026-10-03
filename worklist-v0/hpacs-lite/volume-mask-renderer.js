(function(root){
  'use strict';
  const signature='vec4 getColorForValue(vec4 tValue, vec3 posIS, vec3 tstep)\n{';
  const owned=text=>/kinSculptPoint\d|kinVoiDistance/.test(text);
  function removeMasks(source){
    const start=source.indexOf(signature);
    if(start<0)throw Error('VR GPU 표본 함수를 확인할 수 없습니다.');
    const prefix=source.slice(0,start+signature.length);let tail=source.slice(start+signature.length);
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
  // The renderer keeps every program it compiled in its own cache, keyed by the full sources, and its next frame binds the
  // entry for the sources it builds. An entry it already compiled and linked from exactly these sources, in this live
  // context, has answered the compile and link question for that frame, so a second copy is not built just to be deleted.
  // Only reads: nothing is compiled, bound, inserted, released or rendered here, and any doubt falls back to the full check.
  function linkedProgram(windowGL,gl,vertex,fragment,geometry){
    if(typeof windowGL.getShaderCache!=='function'||typeof gl.isContextLost!=='function'||gl.isContextLost())return null;
    const programs=windowGL.getShaderCache()?.get?.('shaderPrograms')?.shaderPrograms;
    if(!programs||typeof programs!=='object')return null;
    for(const entry of Object.values(programs)){
      try{
        if(entry?.getCompiled?.()!==true||entry.getLinked?.()!==true||entry.get?.('context')?.context!==gl)continue;
        if(entry.getVertexShader().getSource()!==vertex||entry.getFragmentShader().getSource()!==fragment||(entry.getGeometryShader?.()?.getSource?.()??'')!==geometry)continue;
        // A context restored after a loss keeps the cache object but not its programs.
        const handle=entry.getHandle?.();if(handle&&gl.isProgram(handle))return entry;
      }catch(_){}
    }
    return null;
  }
  function preflight(op,properties){
    const windowGL=op.engine.offscreenMultiRenderWindow.getOpenGLRenderWindow(),gl=windowGL.getContext();
    const program=windowGL.getViewNodeFor(op.mapper)?.get('tris')?.tris?.getProgram();
    if(!program?.getCompiled()||!program.getLinked())throw Error('VR GPU 준비가 끝난 뒤 다시 적용하세요.');
    let fragment=removeMasks(program.getFragmentShader().getSource());
    const replacements=(properties.OpenGL?.ShaderReplacements||[]).filter(r=>owned(r.replacementValue||''));
    if(replacements.length>1)throw Error('VR GPU 가림 설정이 중복되었습니다.');
    for(const replacement of replacements){
      if(replacement.originalValue!==signature||replacement.shaderType!=='Fragment'||replacement.replaceAll!==false||replacement.replaceFirst!==true)throw Error('VR GPU 가림 형식을 확인할 수 없습니다.');
      fragment=fragment.replace(signature,replacement.replacementValue);
    }
    const vertex=program.getVertexShader().getSource();
    if(linkedProgram(windowGL,gl,vertex,fragment,program.getGeometryShader?.()?.getSource?.()??''))return;
    let candidate=null;const shaders=[];
    try{
      // Compile and link unattached objects without binding a program or running
      // the shared rendering engine. A bad candidate cannot stall its RAF loop.
      for(const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){
        const shader=gl.createShader(type);if(!shader)throw Error('VR GPU shader를 만들 수 없습니다.');
        shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);
        if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error('VR 가림을 GPU에서 컴파일하지 못했습니다. 기존 표시를 유지합니다.');
      }
      candidate=gl.createProgram();if(!candidate)throw Error('VR GPU program을 만들 수 없습니다.');
      for(const shader of shaders)gl.attachShader(candidate,shader);
      gl.linkProgram(candidate);
      if(!gl.getProgramParameter(candidate,gl.LINK_STATUS))throw Error('VR 가림을 GPU에서 연결하지 못했습니다. 기존 표시를 유지합니다.');
    }finally{
      if(candidate)gl.deleteProgram(candidate);
      for(const shader of shaders)gl.deleteShader(shader);
    }
  }
  root.KinVolumeMaskRenderer=Object.freeze({preflight});
})(window);
