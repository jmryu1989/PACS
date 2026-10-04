(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumeVrMasks=api;})(typeof globalThis==='object'?globalThis:this,root=>{
  'use strict';
  // One owned getColorForValue replacement carries every VR mask: the VOI distance test and the sculpt regions. The
  // renderer accepts one owned replacement at a time (volume-mask-renderer.js), so writing the tools separately would let
  // each write erase the other. Crop stays the only source of mapper clipping planes; the VOI adds none, because crop's six
  // planes plus two more could exceed the renderer's plane budget and an overflowing plane would be dropped silently.
  //
  // VR draws the masks through one fixed replacement (pack, TEXT) whose numbers are uniforms, so an edit writes data and
  // compiles nothing (S8-SCULPT-PERF B-u). build keeps producing today's generated replacement: it is the reference the
  // fixed one must decide like, and both share one request check so they accept and refuse exactly the same requests.
  const SIGNATURE='vec4 getColorForValue(vec4 tValue, vec3 posIS, vec3 tstep)\n{',OPEN='\n  {\n',CLOSE='\n  }';
  const MAX_SCULPT=8,MAX_EDGES=64,LIMIT=1e6,EPS=1e-9,OWNED=/kinSculptPoint\d|kinVoiDistance/;
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
  // The accepted sculpt producer's own block for the whole list, or '' without sculpt. Its checks (regions, projections,
  // numbers) are the sculpt part of the request check, for build and pack alike.
  function sculptBlock(r){
    if(!r.sculpt.length)return '';
    let produced;try{produced=sculptModel().shaderReplacement(r.sculpt);}catch(_){throw refusal('vr-limit','VR 조각 적용 정보를 확인하세요.');}
    const text=produced?.replacementValue;
    if(produced?.originalValue!==SIGNATURE||typeof text!=='string'||!text.startsWith(SIGNATURE+OPEN)||!text.endsWith(CLOSE))throw refusal('vr-limit','VR 조각 적용 정보를 확인하세요.');
    return text.slice((SIGNATURE+OPEN).length,text.length-CLOSE.length);
  }
  // The combined replacement, or null when nothing is masked (none applied, or Original View). The sculpt part is the
  // accepted sculpt producer's own block, so a sculpt-only request is exactly what the sculpt model writes.
  function build(value){
    const r=request(value),sculptBody=sculptBlock(r);
    if(r.original||!r.voi&&!sculptBody)return null;
    const lines=[];
    if(r.voi){const p=r.voi;lines.push(`    float kinVoiDistance = ${number(p.base)} + ${number(p.axes[0])} * posIS.x + ${number(p.axes[1])} * posIS.y + ${number(p.axes[2])} * posIS.z;`,`    if (abs(kinVoiDistance) > ${number(p.halfThickness)}) return vec4(0.0);`);}
    if(sculptBody)lines.push(sculptBody);
    return {shaderType:'Fragment',replaceFirst:true,originalValue:SIGNATURE,replacementValue:SIGNATURE+OPEN+lines.join('\n')+CLOSE,replaceAll:false};
  }

  /* The fixed replacement. Each expression is the generator's (volume-sculpt.js regionExpression, the VOI lines above) with
     its literals read from uniforms: the same projected point and operand order, the bounding-box test, the boundary
     distance on the original edge vector, the crossing expression and inside || boundary. Whether an edge's crossing test
     runs is the generator's own rule (|dy| > 1e-9 in doubles), passed as a bit, never by changing the stored edge. This
     text is what the approved native decision rule (O9) and its records were made with; a change to it is a new shader
     that needs that evidence again. kinHead.x <= 0 means the data is incomplete, and the program then draws nothing. */
  const DECL=[
    'uniform ivec4 kinHead;',     // x: committed request generation (<= 0: not written, draw nothing), y: sculpt count
    'uniform ivec4 kinMeta[8];',  // kind (0 polygon, 1 rectangle, 2 ellipse), removed side (1 Inside, 0 Outside), first edge slot, edges
    'uniform vec4 kinProj[16];',  // [2r] = base.xy, axis0.xy; [2r+1] = axis1.xy, axis2.xy
    'uniform vec4 kinBox[8];',    // x0, x1, y0, y1
    'uniform vec4 kinEll[8];',    // ellipse centre.xy, radius.xy
    'uniform vec4 kinEdge[512];', // a.xy, e.xy = c - a (original edge, float32)
    'uniform ivec4 kinCross[4];', // bit s of slot s: 1 = the crossing test runs (|dy| > 1e-9 in doubles)
    'uniform vec4 kinVoi;',       // axes.xyz, base
    'uniform vec2 kinVoiHalf;'    // half thickness, on (1) / off (0)
  ].join('\n');
  const BODY=`
  {
    if (kinHead.x <= 0) return vec4(0.0);
    if (kinVoiHalf.y > 0.5) {
      float kinVoiDistance = kinVoi.w + kinVoi.x * posIS.x + kinVoi.y * posIS.y + kinVoi.z * posIS.z;
      if (abs(kinVoiDistance) > kinVoiHalf.x) return vec4(0.0);
    }
    for (int r = 0; r < 8; ++r) {
      if (r >= kinHead.y) break;
      ivec4 m = kinMeta[r];
      vec4 p0 = kinProj[2 * r], p1 = kinProj[2 * r + 1], b = kinBox[r];
      vec2 q = p0.xy + p0.zw * posIS.x + p1.xy * posIS.y + p1.zw * posIS.z;
      bool inside = false;
      if (m.x == 1) inside = (q.x >= b.x && q.x <= b.y && q.y >= b.z && q.y <= b.w);
      else if (m.x == 2) { vec2 c = kinEll[r].xy, rad = kinEll[r].zw; inside = (dot((q - c) / rad, (q - c) / rad) <= 1.0); }
      else if (q.x >= b.x && q.x <= b.y && q.y >= b.z && q.y <= b.w) {
        bool inPoly = false, boundary = false;
        for (int t = 0; t < 64; ++t) {
          if (t >= m.w) break;
          int s = m.z + t;
          vec4 E = kinEdge[s];
          float cy = kinEdge[m.z + ((t + 1 == m.w) ? 0 : t + 1)].y;
          vec2 a = E.xy, e = E.zw, d = q - a;
          float ee = dot(e, e); float u = clamp(dot(d, e) / max(ee, 1e-20), 0.0, 1.0);
          boundary = boundary || distance(d, u * e) <= 1e-7;
          ivec4 w = kinCross[s >> 7];
          bool crossing = ((w[(s >> 5) & 3] >> (s & 31)) & 1) != 0;
          if (crossing && ((q.y < a.y) != (q.y < cy)) && (q.x < a.x + (q.y - a.y) * e.x / e.y)) inPoly = !inPoly;
        }
        inside = inPoly || boundary;
      }
      if (m.y == 1 ? inside : !inside) return vec4(0.0);
    }
  }`;
  const MAX_SALT=16777215;
  // salt > 0 only for a measuring probe that needs a program no cache has seen: one never-true comparison with a run-time
  // value (tstep > 0), so the image is unchanged and the sources are new. The viewer always uses variant 0.
  function variant(salt=0){
    if(!Number.isInteger(salt)||salt<0||salt>MAX_SALT)throw Error('cache salt must be an integer 0..'+MAX_SALT);
    const text=DECL+'\n'+SIGNATURE+(salt?'\n  if (tstep.x == -'+salt+'.25) return vec4(0.0); // kin cache salt':'')+BODY;
    return Object.freeze({salt,TEXT:text,REPLACEMENT:Object.freeze({shaderType:'Fragment',replaceFirst:true,originalValue:SIGNATURE,replacementValue:text,replaceAll:false})});
  }
  const FIXED=variant(0);

  // The request as the fixed replacement's numbers. Every number is the double the generator prints, rounded to float32 once
  // (as a GLSL literal of it is). The whole request is checked first, exactly as build checks it.
  function pack(value){
    const r=request(value);sculptBlock(r);
    const ops=r.sculpt,on=!!r.voi&&!r.original;
    const meta=new Int32Array(4*MAX_SCULPT),proj=new Float32Array(8*MAX_SCULPT),box=new Float32Array(4*MAX_SCULPT),ell=new Float32Array(4*MAX_SCULPT),
      edge=new Float32Array(4*MAX_SCULPT*MAX_EDGES),cross=new Int32Array(MAX_SCULPT*MAX_EDGES/32);
    let first=0;
    ops.forEach((op,index)=>{
      const region=op.region,b=region.bounds,p=op.projection,kind=region.kind==='Rectangle'?1:region.kind==='Ellipse'?2:0;
      proj.set([p.base[0],p.base[1],p.axes[0][0],p.axes[0][1],p.axes[1][0],p.axes[1][1],p.axes[2][0],p.axes[2][1]],8*index);
      box.set([b[0],b[1],b[2],b[3]],4*index);
      if(kind===2)ell.set([(b[0]+b[1])/2,(b[2]+b[3])/2,(b[1]-b[0])/2,(b[3]-b[2])/2],4*index);
      let edges=0;
      if(kind===0){
        const points=region.points,n=points.length;if(n>MAX_EDGES)throw refusal('vr-limit','VR 조각 적용 정보를 확인하세요.');
        // Slot first+i is the generator's edge i (from the previous point to point i); the next slot starts at point i,
        // so the shader reads the edge's end y there.
        for(let i=0,j=n-1;i<n;j=i++){
          const a=points[j],c=points[i],dy=c[1]-a[1],slot=first+i;
          edge.set([a[0],a[1],c[0]-a[0],dy],4*slot);
          if(Math.abs(dy)>EPS)cross[slot>>5]|=1<<(slot&31);
        }
        edges=n;
      }
      meta.set([kind,op.side==='Inside'?1:0,first,edges],4*index);first+=edges;
    });
    return Object.freeze({count:r.original?0:ops.length,edges:first,meta,proj,box,ell,edge,cross,
      voi:new Float32Array(on?[r.voi.axes[0],r.voi.axes[1],r.voi.axes[2],r.voi.base]:[0,0,0,0]),voiHalf:new Float32Array(on?[r.voi.halfThickness,1]:[0,0])});
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
  return Object.freeze({MAX_SCULPT,SIGNATURE,TEXT:FIXED.TEXT,REPLACEMENT:FIXED.REPLACEMENT,variant,build,pack,owned,properties,ownedText,visible});
});
