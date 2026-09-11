/* Patient LPS camera operations; no voxel values or source cameras are edited. */
(function(root){
  const dot=(a,b)=>a.reduce((n,x,i)=>n+x*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const unit=a=>{const d=Math.hypot(...a);if(!Number.isFinite(d)||d<1e-8)throw Error('VR 방향을 확인할 수 없습니다.');return a.map(n=>n/d);};
  const turn=(v,axis,r)=>{const a=unit(axis),c=Math.cos(r),s=Math.sin(r),x=cross(a,v),p=dot(a,v);return v.map((n,i)=>n*c+x[i]*s+a[i]*p*(1-c));};
  function rotate(camera,dx,dy){
    if(![dx,dy].every(Number.isFinite)||Math.abs(dx)>360||Math.abs(dy)>360)throw Error('VR 회전 범위를 확인하세요.');
    const offset=camera.position.map((n,i)=>n-camera.focalPoint[i]),up=unit(camera.viewUp),normal=unit(offset),right=unit(cross(up,normal));
    const yaw=turn(offset,up,-dx*Math.PI/180),pitched=turn(yaw,right,dy*Math.PI/180),nextUp=turn(up,right,dy*Math.PI/180);
    return {position:camera.focalPoint.map((n,i)=>n+pitched[i]),focalPoint:[...camera.focalPoint],viewUp:unit(nextUp),viewPlaneNormal:unit(pitched)};
  }
  const directions={Anterior:[[0,-1,0],[0,0,1]],Posterior:[[0,1,0],[0,0,1]],Left:[[1,0,0],[0,0,1]],Right:[[-1,0,0],[0,0,1]],Superior:[[0,0,1],[0,-1,0]],Inferior:[[0,0,-1],[0,1,0]]};
  function orient(camera,name){const d=directions[name];if(!d)throw Error('VR 방향을 선택하세요.');const length=Math.hypot(...camera.position.map((n,i)=>n-camera.focalPoint[i]));if(!Number.isFinite(length)||length<1e-8)throw Error('VR 중심을 확인할 수 없습니다.');return {focalPoint:[...camera.focalPoint],position:camera.focalPoint.map((n,i)=>n+d[0][i]*length),viewPlaneNormal:[...d[0]],viewUp:[...d[1]]};}
  const cropKeys=['i','j','k'];
  function validateCropBounds(bounds,dimensions){
    if(!bounds||!Array.isArray(dimensions)||dimensions.length!==3||!dimensions.every((n)=>Number.isInteger(n)&&n>0))throw Error('VR 원본 크기를 확인할 수 없습니다.');
    const result={};
    cropKeys.forEach((axis,index)=>{
      const pair=bounds[axis];
      if(!Array.isArray(pair)||pair.length!==2||!pair.every(Number.isFinite)||!pair.every(Number.isInteger))throw Error(axis.toUpperCase()+' 범위는 정수로 입력하세요.');
      if(pair[0]<0||pair[1]>=dimensions[index]||pair[0]>pair[1])throw Error(axis.toUpperCase()+' 범위를 0~'+(dimensions[index]-1)+' 안에서 순서대로 입력하세요.');
      result[axis]=[pair[0],pair[1]];
    });
    return result;
  }
  function cropPlanes(bounds,dimensions,indexToWorld){
    const b=validateCropBounds(bounds,dimensions),convert=typeof indexToWorld==='function'?indexToWorld:indexToWorld?.indexToWorld?.bind(indexToWorld);
    if(!convert)throw Error('VR 원본 좌표 변환을 확인할 수 없습니다.');
    const world=(point)=>{const value=convert([...point]);if(!value||value.length!==3||!Array.from(value).every(Number.isFinite))throw Error('VR 원본 좌표 변환을 확인할 수 없습니다.');return Array.from(value);};
    const zero=world([0,0,0]),basis=[[1,0,0],[0,1,0],[0,0,1]].map(point=>world(point).map((n,i)=>n-zero[i])),scale=basis.reduce((n,v)=>n*Math.hypot(...v),1),determinant=dot(basis[0],cross(basis[1],basis[2]));
    if(!Number.isFinite(scale)||scale<1e-18||Math.abs(determinant)<=scale*1e-10)throw Error('VR 원본 좌표축을 확인할 수 없습니다.');
    const normal=(axis)=>{const others=[0,1,2].filter(n=>n!==axis),raw=cross(basis[others[0]],basis[others[1]]),aligned=dot(raw,basis[axis])<0?raw.map(n=>-n):raw;return unit(aligned);};
    const center=[(b.i[0]+b.i[1])/2,(b.j[0]+b.j[1])/2,(b.k[0]+b.k[1])/2];
    return cropKeys.flatMap((axis,index)=>{
      const inward=normal(index),minimum=[...center],maximum=[...center];minimum[index]=b[axis][0]-.5;maximum[index]=b[axis][1]+.5;
      return [{axis:axis.toUpperCase(),side:'min',origin:world(minimum),normal:inward},{axis:axis.toUpperCase(),side:'max',origin:world(maximum),normal:inward.map(n=>-n)}];
    });
  }
  // VolumeViewport3D inherits a camera updater that rewrites the first two mapper
  // planes as slab planes. Crop planes deliberately reject those writes so camera
  // rotation cannot move an index-aligned crop in world space.
  function createCropPlane(definition){
    if(!definition||![definition.origin,definition.normal].every(value=>Array.isArray(value)&&value.length===3&&value.every(Number.isFinite)))throw Error('VR 자르기 평면을 확인할 수 없습니다.');
    const origin=Object.freeze([...definition.origin]),normal=Object.freeze([...definition.normal]);
    return Object.freeze({isA:name=>name==='vtkPlane',getOrigin:()=>[...origin],getNormal:()=>[...normal],setOrigin:()=>false,setNormal:()=>false});
  }
  function validateTransferKnots(knots){
    if(!Array.isArray(knots)||knots.length<2||knots.length>16)throw Error('전달함수 점은 2~16개로 입력하세요.');
    const result=knots.map((k,index)=>{
      const numeric=value=>(typeof value==='number'&&Number.isFinite(value))||(typeof value==='string'&&value.trim()!==''&&Number.isFinite(Number(value)))?Number(value):NaN,hu=numeric(k?.hu),opacity=numeric(k?.opacity),color=typeof k?.color==='string'?k.color:'';
      if(!Number.isFinite(hu)||hu<-32768||hu>65535)throw Error('점 '+(index+1)+' HU를 -32768~65535 범위로 입력하세요.');
      if(!Number.isFinite(opacity)||opacity<0||opacity>1)throw Error('점 '+(index+1)+' 불투명도를 0~1 범위로 입력하세요.');
      if(!/^#[0-9a-fA-F]{6}$/.test(color))throw Error('점 '+(index+1)+' 색상을 #RRGGBB 형식으로 입력하세요.');
      return {hu,opacity,color:color.toUpperCase()};
    });
    for(let i=1;i<result.length;i++)if(result[i-1].hu>=result[i].hu)throw Error('전달함수 HU는 작은 값부터 중복 없이 입력하세요.');
    return result;
  }
  function hexToRgb(hex){const value=parseInt(hex.slice(1),16);return [(value>>16)/255,((value>>8)&255)/255,(value&255)/255];}
  const presetNames=['CT-Bone','CT-Soft-Tissue','CT-Fat'],presetStorePrefix='kin-vr-display-presets:v1:';
  const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
  function normalizeOwner(owner){
    if(!Array.isArray(owner)||owner.length!==2||owner.some(value=>typeof value!=='string'||value.length<1||value.length>256||/[\u0000-\u001f\u007f]/.test(value)))throw Error('VR 개인 설정의 기관과 계정을 확인할 수 없습니다.');
    return [...owner];
  }
  function presetStoreKey(owner){return presetStorePrefix+JSON.stringify(normalizeOwner(owner));}
  function normalizePresetName(name){
    if(typeof name!=='string')throw Error('프리셋 이름을 입력하세요.');
    const value=name.normalize('NFKC').trim().replace(/\s+/gu,' ');
    if(Array.from(value).length<1||Array.from(value).length>64)throw Error('프리셋 이름은 1~64자로 입력하세요.');
    return value;
  }
  const nameIdentity=name=>normalizePresetName(name).toLocaleLowerCase('en-US');
  function normalizeDisplay(value){
    const keys=['transferMode','preset','knots','opacity','shading'];
    if(!exactKeys(value,keys)||!['Preset','Custom'].includes(value.transferMode)||value.transferMode==='Preset'&&!presetNames.includes(value.preset)||value.transferMode==='Custom'&&value.preset!==null||typeof value.opacity!=='number'||!Number.isFinite(value.opacity)||value.opacity<0||value.opacity>100||typeof value.shading!=='boolean')throw Error('저장된 VR 표시 조건 형식을 확인할 수 없습니다.');
    let knots;
    if(value.transferMode==='Preset'){
      if(!Array.isArray(value.knots)||value.knots.length!==0)throw Error('저장된 VR 표시 조건 형식을 확인할 수 없습니다.');
      knots=[];
    }else{
      if(!Array.isArray(value.knots)||value.knots.some(k=>!exactKeys(k,['hu','opacity','color'])||typeof k.hu!=='number'||!Number.isFinite(k.hu)||typeof k.opacity!=='number'||!Number.isFinite(k.opacity)||typeof k.color!=='string'))throw Error('저장된 VR 표시 조건 형식을 확인할 수 없습니다.');
      knots=validateTransferKnots(value.knots);
    }
    return {transferMode:value.transferMode,preset:value.preset,knots,opacity:value.opacity,shading:value.shading};
  }
  function emptyPresetLibrary(owner){return {version:1,owner:normalizeOwner(owner),presets:[]};}
  function normalizePresetLibrary(value,expectedOwner){
    if(!exactKeys(value,['version','owner','presets'])||value.version!==1||!Array.isArray(value.presets)||value.presets.length>20)throw Error('저장된 VR 프리셋 목록 형식을 확인할 수 없습니다.');
    const owner=normalizeOwner(value.owner),expected=normalizeOwner(expectedOwner);
    if(JSON.stringify(owner)!==JSON.stringify(expected))throw Error('저장된 VR 프리셋의 계정을 확인할 수 없습니다.');
    const seen=new Set(),presets=value.presets.map(entry=>{
      if(!exactKeys(entry,['name','display']))throw Error('저장된 VR 프리셋 목록 형식을 확인할 수 없습니다.');
      const name=normalizePresetName(entry.name),identity=nameIdentity(name);
      if(name!==entry.name||seen.has(identity))throw Error('저장된 VR 프리셋 이름을 확인할 수 없습니다.');
      seen.add(identity);return {name,display:normalizeDisplay(entry.display)};
    });
    return {version:1,owner,presets};
  }
  function readPresetLibrary(storage,owner){
    if(!storage||typeof storage.getItem!=='function')throw Error('브라우저 VR 프리셋 저장소를 사용할 수 없습니다.');
    const key=presetStoreKey(owner);let raw;
    try{raw=storage.getItem(key);}catch(_){throw Error('VR 프리셋 목록을 읽지 못했습니다.');}
    if(raw===null)return {key,raw,library:emptyPresetLibrary(owner)};
    if(typeof raw!=='string'||raw.length>131072||new TextEncoder().encode(raw).byteLength>131072)throw Error('저장된 VR 프리셋 목록 크기를 확인할 수 없습니다. 목록을 덮어쓰지 않았습니다.');
    let parsed;try{parsed=JSON.parse(raw);}catch(_){throw Error('저장된 VR 프리셋 목록이 손상되었습니다. 목록을 덮어쓰지 않았습니다.');}
    try{return {key,raw,library:normalizePresetLibrary(parsed,owner)};}catch(error){throw Error(error.message+' 목록을 덮어쓰지 않았습니다.');}
  }
  function changePresetLibrary(library,command){
    const current=normalizePresetLibrary(library,library?.owner);
    if(!exactKeys(command,command?.type==='add'?['type','name','display']:command?.type==='replace'?['type','name','display']:command?.type==='delete'?['type','name']:[]))throw Error('VR 프리셋 작업을 확인할 수 없습니다.');
    const name=normalizePresetName(command.name),identity=nameIdentity(name),index=current.presets.findIndex(item=>nameIdentity(item.name)===identity);
    if(command.type==='add'){
      if(index!==-1)throw Error('같은 이름의 VR 프리셋이 이미 있습니다.');
      if(current.presets.length>=20)throw Error('VR 프리셋은 최대 20개까지 저장할 수 있습니다.');
      current.presets.push({name,display:normalizeDisplay(command.display)});
    }else if(command.type==='replace'){
      if(index===-1)throw Error('바꿀 VR 프리셋을 선택하세요.');
      current.presets[index]={name:current.presets[index].name,display:normalizeDisplay(command.display)};
    }else if(command.type==='delete'){
      if(index===-1)throw Error('삭제할 VR 프리셋을 선택하세요.');
      current.presets.splice(index,1);
    }
    return normalizePresetLibrary(current,current.owner);
  }
  function writePresetLibrary(storage,snapshot,command){
    if(!snapshot||typeof snapshot.key!=='string'||!Object.prototype.hasOwnProperty.call(snapshot,'raw'))throw Error('VR 프리셋 목록 상태를 먼저 불러오세요.');
    const checked=normalizePresetLibrary(snapshot.library,snapshot.library?.owner);if(snapshot.key!==presetStoreKey(checked.owner))throw Error('VR 프리셋 저장소의 계정을 확인할 수 없습니다.');
    let actual;try{actual=storage.getItem(snapshot.key);}catch(_){throw Error('VR 프리셋 저장소 상태를 확인하지 못했습니다.');}
    if(actual!==snapshot.raw)throw Error('다른 창에서 VR 프리셋 목록이 변경되었습니다. Reload Presets를 누르세요.');
    const library=changePresetLibrary(checked,command),raw=JSON.stringify(library);
    try{storage.setItem(snapshot.key,raw);}catch(_){throw Error('VR 프리셋을 저장하지 못했습니다. 입력 내용은 유지됩니다.');}
    return {key:snapshot.key,raw,library:normalizePresetLibrary(library,library.owner)};
  }
  const api={rotate,orient,validateCropBounds,cropPlanes,createCropPlane,validateTransferKnots,hexToRgb,directions:Object.keys(directions),presetNames:[...presetNames],presetStorePrefix,presetStoreKey,normalizeOwner,normalizePresetName,normalizeDisplay,emptyPresetLibrary,normalizePresetLibrary,readPresetLibrary,changePresetLibrary,writePresetLibrary};if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumeRendering=api;
})(typeof window==='object'?window:globalThis);
