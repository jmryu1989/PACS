(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumeVrVoi=api;})(typeof globalThis==='object'?globalThis:this,root=>{
  'use strict';
  // VR VOI Slab: a display-only slab in source LPS mm bound to the volume the VR opened on. The slab geometry itself is
  // volume-voi.js, shared with the MIP Viewer and only called here. This file adds what VR needs on top of it: the
  // thickness bound of the source diagonal, the applied state with a bounded Undo history, and the shader plane numbers.
  // Every refusal carries a contract reason key (kinVrReason) so the viewer and its capability report the same class.
  const HISTORY=32,LIMIT=1e6,EPS=1e-9,ORIENTATIONS=Object.freeze(['Axial','Coronal','Sagittal']),AXES=Object.freeze(['L','P','S']);
  let voiCache=null;
  const voiModel=()=>{if(voiCache)return voiCache;const m=typeof module==='object'&&module.exports&&typeof require==='function'?require('./volume-voi.js'):root.KinVolumeVoi;if(!m)throw refusal('source-unsupported','VOI 도구를 불러오지 못했습니다. VR을 닫고 다시 여세요.');return voiCache=m;};
  function refusal(reason,message){const error=Error(message);error.kinVrReason=reason;return error;}
  const reasonOf=error=>{try{return typeof error?.kinVrReason==='string'?error.kinVrReason:null;}catch(_){return null;}};
  // Only real numbers reach a shader constant: strings, boxed values and objects with valueOf are refused, never coerced.
  const finite=n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=LIMIT;
  const triple=v=>Array.isArray(v)&&v.length===3&&v.every(finite);
  const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  const mm=n=>Number(n.toFixed(3));
  const frozenSlab=s=>Object.freeze({center:Object.freeze([...s.center]),normal:Object.freeze([...s.normal]),pivot:Object.freeze([...s.pivot]),thickness:s.thickness});

  // The binding is taken once from the opened volume: its spatial extent, the index-to-world affine and the longest space
  // diagonal of that extent, which bounds the thickness (a thicker slab cannot cut anything the diagonal does not).
  function binding(imageData){
    try{
      if(!imageData||typeof imageData.getSpatialExtent!=='function'||typeof imageData.indexToWorld!=='function')throw 0;
      const extent=Array.from(imageData.getSpatialExtent());
      if(extent.length!==6||!extent.every(finite)||!(extent[1]>extent[0]&&extent[3]>extent[2]&&extent[5]>extent[4]))throw 0;
      const world=index=>{const p=Array.from(imageData.indexToWorld(index));if(!triple(p))throw 0;return p;};
      const origin=world([extent[0],extent[2],extent[4]]),basis=[[extent[1],extent[2],extent[4]],[extent[0],extent[3],extent[4]],[extent[0],extent[2],extent[5]]].map(i=>sub(world(i),origin));
      const [a,b,c]=basis,det=a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);
      if(!Number.isFinite(det)||det===0)throw 0;
      const zero=world([0,0,0]),affine=[...zero,...[[1,0,0],[0,1,0],[0,0,1]].flatMap(e=>sub(world(e),zero))];
      const diagonal=Math.max(...[[1,1,1],[-1,1,1],[1,-1,1],[1,1,-1]].map(s=>Math.hypot(...[0,1,2].map(m=>s[0]*a[m]+s[1]*b[m]+s[2]*c[m]))));
      if(!affine.every(finite)||!finite(diagonal)||!(diagonal>0))throw 0;
      return Object.freeze({imageData,extent:Object.freeze(extent),affine:Object.freeze(affine),diagonal});
    }catch(_){throw refusal('source-unsupported','VR 원본 좌표를 확인할 수 없어 VOI를 사용할 수 없습니다.');}
  }
  function requireBinding(bound){if(!bound||!bound.imageData||!(bound.diagonal>0))throw refusal('source-unsupported','VR 원본 좌표를 확인할 수 없어 VOI를 사용할 수 없습니다.');return bound;}
  function validSlab(value,bound){
    requireBinding(bound);
    if(!value||typeof value!=='object'||!triple(value.center)||!triple(value.normal)||!triple(value.pivot)||!finite(value.thickness))throw refusal('vr-limit','VOI Center·Pivot·Thickness는 ±1,000,000 mm 안의 숫자로 입력하세요.');
    if(!(value.thickness>0)||value.thickness>bound.diagonal+EPS*Math.max(1,bound.diagonal))throw refusal('vr-limit','VOI Thickness는 0보다 크고 원본 범위 대각선 '+mm(bound.diagonal)+' mm 이하로 입력하세요.');
    try{return frozenSlab(voiModel().validate({center:value.center,normal:value.normal,pivot:value.pivot,thickness:value.thickness}));}
    catch(_){throw refusal('vr-limit','VOI 방향을 확인할 수 없습니다. VOI Preset을 다시 선택하세요.');}
  }
  function requireOrientation(value){if(!ORIENTATIONS.includes(value))throw refusal('vr-limit','VOI Preset을 목록에서 선택하세요.');return value;}
  const record=(orientation,slab)=>Object.freeze({mode:'Slab',orientation,slab});
  function defaults(bound,orientation){
    requireBinding(bound);requireOrientation(orientation);let slab;
    try{slab=voiModel().defaults(bound.imageData,orientation);}catch(_){throw refusal('source-unsupported','VR 원본 좌표로 기본 VOI를 만들 수 없습니다.');}
    return validSlab(slab,bound);
  }

  const sameList=(a,b)=>a.length===b.length&&a.every((n,i)=>n===b[i]);
  function same(a,b){if(!a||!b)return !a&&!b;return a.orientation===b.orientation&&a.slab.thickness===b.slab.thickness&&['center','normal','pivot'].every(key=>sameList(a.slab[key],b.slab[key]));}
  function validRecord(value){return value===null||!!value&&value.mode==='Slab'&&ORIENTATIONS.includes(value.orientation)&&!!value.slab&&triple(value.slab.center)&&triple(value.slab.normal)&&triple(value.slab.pivot)&&finite(value.slab.thickness)&&value.slab.thickness>0;}
  const initial=()=>Object.freeze({voi:null,original:false,history:Object.freeze([])});
  function state(value){
    if(!value||typeof value!=='object'||!validRecord(value.voi)||typeof value.original!=='boolean'||!Array.isArray(value.history)||value.history.length>HISTORY||!value.history.every(validRecord))throw refusal('vr-limit','VOI 상태를 확인할 수 없습니다.');
    return value;
  }
  // Original View shows the source without masks while the masks stay set; an edit there would change a mask nobody sees.
  function editable(value){const s=state(value);if(s.original)throw refusal('vr-not-final','Original View를 끈 뒤 VOI를 바꾸세요.');return s;}
  // A change records the previously applied VOI (null when it was off) so Undo VOI returns to it; the same VOI again is
  // not a change. The oldest record is dropped beyond HISTORY, as in the MIP Viewer.
  function change(s,voi){if(same(voi,s.voi))return s;return Object.freeze({voi,original:false,history:Object.freeze([...s.history,s.voi].slice(-HISTORY))});}
  function requireApplied(s){if(!s.voi)throw refusal('vr-limit','적용된 VOI가 없습니다. Apply VOI로 먼저 적용하세요.');return s.voi;}
  function apply(value,bound,{orientation,slab}={}){const s=editable(value);return change(s,record(requireOrientation(orientation),validSlab(slab,bound)));}
  function move(value,bound,distance){
    const s=editable(value),voi=requireApplied(s);requireBinding(bound);
    if(!finite(distance))throw refusal('vr-limit','VOI Move는 ±1,000,000 mm 안의 숫자로 입력하세요.');
    let moved;try{moved=voiModel().move(voi.slab,distance);}catch(_){throw refusal('vr-limit','VOI 중심이 좌표 범위를 벗어나 옮기지 않았습니다.');}
    return change(s,record(voi.orientation,validSlab(moved,bound)));
  }
  function rotate(value,bound,axis,degrees){
    const s=editable(value),voi=requireApplied(s);requireBinding(bound);
    if(!AXES.includes(axis)||!finite(degrees)||Math.abs(degrees)>180)throw refusal('vr-limit','VOI Rotate Axis는 L/P/S, Degrees는 -180~180으로 입력하세요.');
    let turned;try{turned=voiModel().rotate(voi.slab,axis,degrees);}catch(_){throw refusal('vr-limit','VOI를 돌린 결과가 좌표 범위를 벗어나 적용하지 않았습니다.');}
    return change(s,record(voi.orientation,validSlab(turned,bound)));
  }
  // Reset VOI applies the chosen preset's default slab and leaves it on (contract §7.3), unlike Disable VOI.
  function reset(value,bound,orientation){const s=editable(value);return change(s,record(requireOrientation(orientation),defaults(bound,orientation)));}
  function disable(value){const s=editable(value);requireApplied(s);return change(s,null);}
  function undo(value){
    const s=editable(value);if(!s.history.length)throw refusal('vr-limit','되돌릴 VOI 변경이 없습니다.');
    return Object.freeze({voi:s.history[s.history.length-1],original:false,history:Object.freeze(s.history.slice(0,-1))});
  }
  // Original View needs a mask to lift: the applied VOI, or a sculpt the caller reports (sculpt is not part of this state).
  function setOriginal(value,on,sculpted){
    const s=state(value);if(typeof on!=='boolean')throw refusal('vr-limit','Original View 상태를 확인할 수 없습니다.');
    if(on&&!s.voi&&!sculpted)throw refusal('vr-limit','VOI나 조각 제거를 적용한 뒤 Original View를 볼 수 있습니다.');
    return on===s.original?s:Object.freeze({voi:s.voi,original:on,history:s.history});
  }

  // The shader takes the slab as a signed distance on normalized texture coordinates: volume-voi.js samplePlane, so the
  // VR test and the MIP Viewer's slab read the same affine. Only validated numbers come back.
  function shaderPlane(voi,bound){
    if(!validRecord(voi)||voi===null)throw refusal('vr-limit','VOI 값을 확인할 수 없습니다.');requireBinding(bound);
    let plane;try{plane=voiModel().samplePlane(voi.slab,bound.imageData);}catch(_){throw refusal('vr-limit','VOI를 VR 원본 좌표로 옮길 수 없습니다.');}
    if(!finite(plane.base)||!triple(Array.from(plane.axes))||!finite(plane.halfThickness))throw refusal('vr-limit','VOI를 VR 원본 좌표로 옮길 수 없습니다.');
    return Object.freeze({mode:'Slab',base:plane.base,axes:Object.freeze(Array.from(plane.axes)),halfThickness:plane.halfThickness});
  }
  // The two bounding planes in source LPS mm, normals pointing into the kept slab.
  function planes(voi){
    if(!validRecord(voi)||voi===null)throw refusal('vr-limit','VOI 값을 확인할 수 없습니다.');
    const {center:c,normal:n,thickness:t}=voi.slab,h=t/2;
    return Object.freeze([Object.freeze({origin:Object.freeze(c.map((x,i)=>x-n[i]*h)),normal:Object.freeze([...n])}),Object.freeze({origin:Object.freeze(c.map((x,i)=>x+n[i]*h)),normal:Object.freeze(n.map(x=>-x))})]);
  }
  // The voxel-centre decision of the contract (C-01): the same inclusive bound as volume-voi.js contains.
  function keeps(voi,bound,index){
    if(voi===null)return true;if(!validRecord(voi))throw refusal('vr-limit','VOI 값을 확인할 수 없습니다.');requireBinding(bound);
    if(!triple(index))throw refusal('vr-limit','복셀 위치를 확인할 수 없습니다.');
    return voiModel().contains(voi.slab,Array.from(bound.imageData.indexToWorld(index)));
  }
  return Object.freeze({HISTORY,ORIENTATIONS,refusal,reasonOf,binding,defaults,initial,state,apply,move,rotate,reset,disable,undo,setOriginal,same,shaderPlane,planes,keeps});
});
