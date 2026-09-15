/* MIP Viewer Job model (kin-mip-1): the confirmed MIP Viewer display as a Job block, its save gate and saved state, and the
   restore request. The block names the accepted A11/A11-VOI-1 projection semantics; a runtime volume id, the affine, undo
   history, Original or a pending request never enter it. api/src/viewer-volume-mip.ts applies the same schema rule. */
(function(root){
  const SCHEMA=1,ALGORITHM='kin-mip-1',COORDINATES='LPS_mm',LIMIT=1e6,EDGE=1e-6;
  const MODES=['MIP','MinIP','Raysum'],ORIENTATIONS=['Axial','Coronal','Sagittal'];
  const KEYS=['schema','algorithm','coordinates','frameOfReference','mode','orientation','display','voiSlab'];
  // The VOI Slab tool's preset normals (volume-voi.js orientationNormals), in its list order.
  const PRESETS=[['Axial',[0,0,1]],['Coronal',[0,1,0]],['Sagittal',[1,0,0]]];
  const messages=Object.freeze({
    reproduce:'이 MIP 작업의 계산 방식을 이 뷰어가 재현할 수 없어 복원하지 않았습니다.',
    shape:'저장한 MIP 작업의 형식을 확인할 수 없어 복원하지 않았습니다.',
    frame:'저장한 MIP 작업의 좌표계(Frame of Reference)가 현재 원본과 달라 복원하지 않았습니다.',
    value:'MIP Viewer 표시의 원본 좌표나 값을 확인할 수 없어 저장하지 않았습니다.',
    writable:'판독의 계정에서 MIP 작업을 저장할 수 있습니다.',
    busy:'영상 작업 처리가 끝난 뒤 MIP 작업을 저장하세요.',
    rendering:'최종 표시를 확인한 뒤 MIP 작업을 저장하세요.',
    original:'Original 보기를 끈 뒤 저장하세요.',
    outside:'VOI Slab이 CT 볼륨과 겹치지 않아 MIP 작업을 저장하지 않았습니다.',
    useRetry:'이전 MIP 저장 요청의 결과를 먼저 Retry MIP Save로 확인하세요.',
    useRequest:'이전 요청의 결과가 남아 있습니다. MIP Viewer를 닫고 Retry Request로 먼저 확인하세요.',
    retryOther:'재시도할 MIP 저장 요청이 현재 표시와 같지 않습니다. MIP Viewer를 닫고 Retry Request로 이전 요청을 확인하세요.',
    title:'MIP Job Title을 입력하세요.',
  });
  const viewerModel=()=>{const model=root.KinVolumeMip;if(!model)throw Error('MIP Viewer 도구를 불러오지 못했습니다. 영상 창을 새로고침하세요.');return model;};
  const exact=(v,want)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===want.length&&Object.keys(v).every(k=>want.includes(k));
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const triple=v=>Array.isArray(v)&&v.length===3&&v.every(n=>finite(n)&&Math.abs(n)<=LIMIT);
  // JSON text is the saved form: jsonb keeps every decimal digit but not the key order, so the comparison text sorts keys.
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  const same=(a,b)=>a!==undefined&&b!==undefined&&canonical(a)===canonical(b);
  function supported(value){return !!value&&typeof value==='object'&&value.schema===SCHEMA&&value.algorithm===ALGORITHM&&value.coordinates===COORDINATES;}
  // '' for a block this viewer reproduces, 'reproduce' for another algorithm, 'shape' for anything malformed.
  function problem(value){
    if(!supported(value))return 'reproduce';
    if(!exact(value,KEYS)||!MODES.includes(value.mode)||!ORIENTATIONS.includes(value.orientation))return 'shape';
    if(typeof value.frameOfReference!=='string'||value.frameOfReference.length>64||!/^[0-9]+(\.[0-9]+)*$/.test(value.frameOfReference))return 'shape';
    const d=value.display;
    if(!exact(d,['voiRange','interpolationType'])||!exact(d.voiRange,['lower','upper'])||![0,1,2].includes(d.interpolationType)||
      ![d.voiRange.lower,d.voiRange.upper].every(n=>finite(n)&&Math.abs(n)<=1e9)||!(d.voiRange.upper>d.voiRange.lower))return 'shape';
    const s=value.voiSlab;
    if(s!==null&&(!exact(s,['center','normal','pivot','thickness'])||!triple(s.center)||!triple(s.normal)||!triple(s.pivot)||
      !finite(s.thickness)||!(s.thickness>0)||s.thickness>LIMIT||!(Math.abs(Math.hypot(...s.normal)-1)<=EDGE)))return 'shape';
    return '';
  }
  const freeze=value=>Object.freeze({...value,display:Object.freeze({voiRange:Object.freeze({...value.display.voiRange}),interpolationType:value.display.interpolationType}),
    voiSlab:value.voiSlab&&Object.freeze({center:Object.freeze([...value.voiSlab.center]),normal:Object.freeze([...value.voiSlab.normal]),pivot:Object.freeze([...value.voiSlab.pivot]),thickness:value.voiSlab.thickness})});
  function validate(value){const reason=problem(value);if(reason)throw Error(messages[reason]);return freeze(value);}
  /* The saved block is the confirmed Final request exactly as confirmed: a pending or superseded request, a display before
     its first Final and Original view are refused, and every number is copied without rounding or renormalization. */
  function block(snapshot,{frameOfReference,display}={}){
    const final=snapshot?.final,applied=snapshot?.applied;let confirmed=false;
    try{confirmed=!!final&&!!applied&&snapshot.state==='final'&&viewerModel().sameRequest(applied,final);}catch(_){confirmed=false;}
    if(!confirmed)throw Error(messages.rendering);
    if(final.original===true)throw Error(messages.original);
    const s=final.voiSlab??null;
    const value={schema:SCHEMA,algorithm:ALGORITHM,coordinates:COORDINATES,frameOfReference,mode:final.mode,orientation:final.orientation,
      display:{voiRange:{lower:display?.voiRange?.lower,upper:display?.voiRange?.upper},interpolationType:display?.interpolationType},
      voiSlab:s&&{center:[...s.center],normal:[...s.normal],pivot:[...s.pivot],thickness:s.thickness}};
    if(problem(value))throw Error(messages.value);
    return freeze(value);
  }
  // A slab keeps at least one voxel centre: the eight voxel-centre corners are not all beyond one side (1e-6 mm edge).
  function intersects(slab,corners){
    if(slab===null)return true;
    if(!slab||!Array.isArray(corners)||corners.length!==8||!corners.every(triple))return false;
    const half=slab.thickness/2,n=slab.normal,c=slab.center;
    const d=corners.map(p=>(p[0]-c[0])*n[0]+(p[1]-c[1])*n[1]+(p[2]-c[2])*n[2]);
    return d.every(Number.isFinite)&&Math.min(...d)<=half+EDGE&&Math.max(...d)>=-half-EDGE;
  }
  /* The saved record bound to this runtime volume with its numbers unchanged. normalizeVoi divides the normal by its length
     again, which is not idempotent for every unit normal, so that division is left to the renderer's own write and never
     feeds back into the record the saved state is compared with. Undo starts empty and Original is off. */
  function restoreRequest(value,binding){
    const saved=validate(value);
    if(!binding||typeof binding.frameOfReference!=='string'||saved.frameOfReference!==binding.frameOfReference)throw Error(messages.frame);
    const s=saved.voiSlab;
    if(s&&(typeof binding.volumeId!=='string'||!binding.volumeId||!Array.isArray(binding.affine)||binding.affine.length!==12||!binding.affine.every(finite)))throw Error(messages.shape);
    const request={mode:saved.mode,orientation:saved.orientation,
      voiSlab:s&&Object.freeze({volumeId:binding.volumeId,affine:Object.freeze([...binding.affine]),center:s.center,normal:s.normal,pivot:s.pivot,thickness:s.thickness}),
      original:false,history:Object.freeze([])};
    viewerModel().normalizeRequest(request);
    return request;
  }
  // The editor preset closest to a restored normal; an oblique slab keeps the axis it lies nearest to.
  function presetFor(normal){
    if(!triple(normal))return 'Axial';
    let best=PRESETS[0],score=-1;
    for(const entry of PRESETS){const value=Math.abs(entry[1][0]*normal[0]+entry[1][1]*normal[1]+entry[1][2]*normal[2]);if(value>score){score=value;best=entry;}}
    return best[0];
  }
  /* The first reason a MIP save is refused, in the order a user can act on it: the account, a request in flight, the
     display itself, its geometry, an earlier request whose result is unknown, then the title. */
  function saveGate({writable,busy,snapshot,frameOfReference,display,corners,pending=null,title='',retry=false}){
    if(!writable)return {message:messages.writable,block:null};
    if(busy)return {message:messages.busy,block:null};
    let value;try{value=block(snapshot,{frameOfReference,display});}catch(error){return {message:error.message,block:null};}
    if(!intersects(value.voiSlab,corners))return {message:messages.outside,block:null};
    const retryable=!!pending&&pending.version===12&&same(pending.mip,value);
    if(retry){if(!retryable)return {message:messages.retryOther,block:null};}
    else if(pending)return {message:retryable?messages.useRetry:messages.useRequest,block:null};
    if(!retry&&!String(title).trim())return {message:messages.title,block:null};
    return {message:'',block:value};
  }
  /* Saved is a committed 200 for this exact block in this open operation. A rejected request is Not Saved; an unknown
     receipt keeps the identical body for an idempotent retry and is Save Unconfirmed only while that block is shown. */
  function createSaveState(){
    let operation=null,saved=null,unconfirmed=null,saving=null;
    const key=value=>value===null||value===undefined?null:canonical(value);
    const record=value=>value?.voiSlab?JSON.stringify([value.mode,value.orientation,[...value.voiSlab.center],[...value.voiSlab.normal],[...value.voiSlab.pivot],value.voiSlab.thickness]):null;
    return {
      open(op){operation=op??null;saved=unconfirmed=saving=null;},
      begin(op,value){if(!op||op!==operation||saving)return null;saving={op,key:key(value)};return saving;},
      committed(op,value){if(!op||op!==operation)return false;const k=key(value);saved=k;if(unconfirmed===k)unconfirmed=null;return true;},
      rejected(ticket){if(!ticket||ticket.op!==operation)return false;if(unconfirmed===ticket.key)unconfirmed=null;return true;},
      unknown(ticket){if(!ticket||ticket.op!==operation)return false;unconfirmed=ticket.key;return true;},
      end(ticket){if(ticket&&saving===ticket)saving=null;},
      restored(op,value){if(!op||op!==operation)return false;saved=key(value);unconfirmed=null;return true;},
      saving:op=>!!op&&op===operation&&!!saving,
      label(op,value){
        if(!op||op!==operation)return 'Not Saved';
        if(saving)return 'Saving';
        const k=key(value);
        return k!==null&&k===saved?'Saved':k!==null&&k===unconfirmed?'Save Unconfirmed · Retry MIP Save':'Not Saved';
      },
      // Work that closing would lose: a typed title or description, or a confirmed VOI Slab that is not the saved one.
      // A display without a VOI Slab is two selections and is not counted.
      dirty(op,final,{title='',description=''}={}){
        if(!op||op!==operation)return false;
        if(title||description)return true;
        const shown=record(final);
        return shown!==null&&shown!==record(saved===null?null:JSON.parse(saved));
      },
    };
  }
  const api=Object.freeze({schema:SCHEMA,algorithm:ALGORITHM,coordinates:COORDINATES,messages,supported,validate,block,intersects,restoreRequest,presetFor,saveGate,createSaveState,same});
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumeMipJob=api;
})(typeof window==='object'?window:globalThis);
