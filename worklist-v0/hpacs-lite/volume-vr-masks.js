(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumeVrMasks=api;})(typeof globalThis==='object'?globalThis:this,root=>{
  'use strict';
  // One owned getColorForValue replacement carries every VR mask: the VOI distance test and the sculpt regions. The
  // renderer accepts one owned replacement at a time (volume-mask-renderer.js), so writing the tools separately would let
  // each write erase the other. Crop stays the only source of mapper clipping planes; the VOI adds none, because crop's six
  // planes plus two more could exceed the renderer's plane budget and an overflowing plane would be dropped silently.
  const SIGNATURE='vec4 getColorForValue(vec4 tValue, vec3 posIS, vec3 tstep)\n{',OPEN='\n  {\n',CLOSE='\n  }';
  const MAX_SCULPT=8,LIMIT=1e6,EPS=1e-9,OWNED=/kinSculptPoint\d|kinVoiDistance/;
  // Looked up on first use (the sculpt model may load after this file) and kept, since the voxel decision runs per voxel.
  let sculptCache=null;
  const sculptModel=()=>{if(sculptCache)return sculptCache;const m=typeof module==='object'&&module.exports&&typeof require==='function'?require('./volume-sculpt.js'):root.KinVolumeSculpt;if(!m)throw refusal('vr-limit','VR 조각 도구를 불러오지 못했습니다.');return sculptCache=m;};
  function refusal(reason,message){const error=Error(message);error.kinVrReason=reason;return error;}
  const finite=n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=LIMIT;
  const triple=v=>Array.isArray(v)&&v.length===3&&v.every(finite);
  // The same literal form as the sculpt shader constants; the value is already a validated number.
  function number(value){const text=Object.is(value,-0)?'0.0':String(value);return /[.eE]/.test(text)?text:text+'.0';}

  // Every input is checked before anything is produced: a request over budget, of an unknown mode or side, or with a value
  // that is not a real number yields nothing, so no partial replacement can reach the renderer.
  function plane(value){
    if(value===null)return null;
    if(!value||typeof value!=='object'||value.mode!=='Slab'||!finite(value.base)||!triple(value.axes)||!finite(value.halfThickness)||!(value.halfThickness>0))throw refusal('vr-limit','VOI 가림 값을 확인할 수 없습니다.');
    return {base:value.base,axes:[value.axes[0],value.axes[1],value.axes[2]],halfThickness:value.halfThickness};
  }
  function operations(value){
    if(!Array.isArray(value))throw refusal('vr-limit','VR 조각 적용 정보를 확인하세요.');
    if(value.length>MAX_SCULPT)throw refusal('vr-limit','VR 조각 제거는 최대 8개까지 적용할 수 있습니다.');
    for(const operation of value)if(!operation||typeof operation!=='object'||(operation.side!=='Inside'&&operation.side!=='Outside'))throw refusal('vr-limit','VR 조각 적용 정보를 확인하세요.');
    return value.slice();
  }
  function request(value){
    if(!value||typeof value!=='object'||value.original!==undefined&&typeof value.original!=='boolean')throw refusal('vr-limit','VR 가림 요청을 확인할 수 없습니다.');
    return {voi:plane(value.voi===undefined?null:value.voi),sculpt:operations(value.sculpt===undefined?[]:value.sculpt),original:value.original===true};
  }
  // The combined replacement, or null when nothing is masked (none applied, or Original View). The sculpt part is the
  // accepted sculpt producer's own block, so a sculpt-only request is exactly what the sculpt model writes.
  function build(value){
    const r=request(value);let sculptBody='';
    if(r.sculpt.length){
      let produced;try{produced=sculptModel().shaderReplacement(r.sculpt);}catch(_){throw refusal('vr-limit','VR 조각 적용 정보를 확인하세요.');}
      const text=produced?.replacementValue;
      if(produced?.originalValue!==SIGNATURE||typeof text!=='string'||!text.startsWith(SIGNATURE+OPEN)||!text.endsWith(CLOSE))throw refusal('vr-limit','VR 조각 적용 정보를 확인하세요.');
      sculptBody=text.slice((SIGNATURE+OPEN).length,text.length-CLOSE.length);
    }
    if(r.original||!r.voi&&!sculptBody)return null;
    const lines=[];
    if(r.voi){const p=r.voi;lines.push(`    float kinVoiDistance = ${number(p.base)} + ${number(p.axes[0])} * posIS.x + ${number(p.axes[1])} * posIS.y + ${number(p.axes[2])} * posIS.z;`,`    if (abs(kinVoiDistance) > ${number(p.halfThickness)}) return vec4(0.0);`);}
    if(sculptBody)lines.push(sculptBody);
    return {shaderType:'Fragment',replaceFirst:true,originalValue:SIGNATURE,replacementValue:SIGNATURE+OPEN+lines.join('\n')+CLOSE,replaceAll:false};
  }
  const owned=text=>typeof text==='string'&&OWNED.test(text);
  // Mapper properties for a replacement: the pristine properties (captured before the first owned write) plus the one
  // replacement, or the pristine object itself when nothing is masked so Undo/Disable return to it exactly.
  function properties(pristine,replacement){
    if(!pristine||typeof pristine!=='object')throw refusal('vr-limit','VR 표시 속성을 확인할 수 없습니다.');
    if(!replacement)return pristine;
    const openGL=pristine.OpenGL||{},existing=Array.isArray(openGL.ShaderReplacements)?openGL.ShaderReplacements:[];
    return {...pristine,OpenGL:{...openGL,ShaderReplacements:[...existing,{...replacement}]}};
  }
  function ownedText(value){const list=value?.OpenGL?.ShaderReplacements;if(!Array.isArray(list))return null;for(let i=list.length-1;i>=0;i--)if(owned(list[i]?.replacementValue))return list[i].replacementValue;return null;}

  // The voxel-centre decision the shader makes (contract §7.1): crop index range, VOI signed distance and the sculpt
  // regions at the voxel's normalized position. Used by the model tests to compare against an independent oracle.
  function visible(value,index){
    const r=request(value),extent=value.extent;
    if(!Array.isArray(extent)||extent.length!==6||!extent.every(finite)||!triple(index))throw refusal('vr-limit','복셀 위치를 확인할 수 없습니다.');
    const crop=value.crop??null;
    if(crop!==null){
      for(const [axis,i] of [['i',0],['j',1],['k',2]]){const range=crop[axis];if(!Array.isArray(range)||range.length!==2||!range.every(finite))throw refusal('vr-limit','VR 자르기 범위를 확인할 수 없습니다.');if(index[i]<range[0]||index[i]>range[1])return false;}
    }
    if(r.original)return true;
    const pos=[0,1,2].map(a=>(index[a]-extent[2*a])/(extent[2*a+1]-extent[2*a]));
    if(r.voi){const d=r.voi.base+r.voi.axes[0]*pos[0]+r.voi.axes[1]*pos[1]+r.voi.axes[2]*pos[2];if(Math.abs(d)>r.voi.halfThickness+EPS*Math.max(1,r.voi.halfThickness))return false;}
    for(const operation of r.sculpt){
      const p=operation.projection,q=[0,1].map(m=>p.base[m]+p.axes[0][m]*pos[0]+p.axes[1][m]*pos[1]+p.axes[2][m]*pos[2]);
      const inside=sculptModel().contains(operation.region,q);
      if(operation.side==='Inside'?inside:!inside)return false;
    }
    return true;
  }
  return Object.freeze({MAX_SCULPT,build,owned,properties,ownedText,visible});
});
