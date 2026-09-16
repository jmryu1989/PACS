/* MIP Viewer Job model (kin-mip-1): the confirmed MIP Viewer display as a Job block, its save gate and saved state, and the
   restore request. The block names the accepted A11/A11-VOI-1 projection semantics; a runtime volume id, the affine, undo
   history, Original or a pending request never enter it. api/src/viewer-volume-mip.ts applies the same schema rule. */
(function(root){
  const SCHEMA=1,ALGORITHM='kin-mip-1',DIRECTION_ALGORITHM='kin-mip-2',COORDINATES='LPS_mm',LIMIT=1e6,EDGE=1e-6;
  const MODES=['MIP','MinIP','Raysum'],ORIENTATIONS=['Axial','Coronal','Sagittal'];
  /* A11-ORIENT-1: the six anatomical presets are a second algorithm, kin-mip-2, carried by the new snapshot versions 14 and 15.
     The projection semantics are identical (whole volume or VOI Slab, same blend modes, same LPS_mm); only the direction enum
     differs, so each algorithm refuses the other's names and one display has exactly one encoding. Versions 12/13 stay exactly
     kin-mip-1 and their accepted bytes never change. api/src/viewer-volume-mip.ts applies the same binding on the server. */
  const DIRECTIONS=['Anterior','Posterior','Left','Right','Superior','Inferior'];
  const ALGORITHMS=Object.freeze({'kin-mip-1':Object.freeze([...ORIENTATIONS]),'kin-mip-2':Object.freeze([...DIRECTIONS])});
  const VERSIONS=Object.freeze({12:ALGORITHM,13:ALGORITHM,14:DIRECTION_ALGORITHM,15:DIRECTION_ALGORITHM});
  const has=(table,name)=>typeof name==='string'&&Object.prototype.hasOwnProperty.call(table,name);
  const enumOf=algorithm=>has(ALGORITHMS,algorithm)?ALGORITHMS[algorithm]:null;
  // The one algorithm a version carries, and the one algorithm an orientation belongs to.
  const algorithmOf=version=>Object.prototype.hasOwnProperty.call(VERSIONS,version)?VERSIONS[version]:null;
  const algorithmFor=orientation=>DIRECTIONS.includes(orientation)?DIRECTION_ALGORITHM:ALGORITHM;
  /* The one snapshot version a saved pair belongs to: the block's algorithm picks the pair (12/13 or 14/15) and the presence of
     a MIP Batch recipe picks the member of it. Null for a block this viewer does not write. */
  function versionFor(value,batch=null){
    const algorithm=value&&typeof value==='object'?value.algorithm:null;
    if(algorithm!==ALGORITHM&&algorithm!==DIRECTION_ALGORITHM)return null;
    return (algorithm===DIRECTION_ALGORITHM?14:12)+((batch??null)===null?0:1);
  }
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
    generating:'MIP Batch 생성을 마친 뒤 MIP 작업을 저장하세요.',
  });
  const viewerModel=()=>{const model=root.KinVolumeMip;if(!model)throw Error('MIP Viewer 도구를 불러오지 못했습니다. 영상 창을 새로고침하세요.');return model;};
  const exact=(v,want)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===want.length&&Object.keys(v).every(k=>want.includes(k));
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const triple=v=>Array.isArray(v)&&v.length===3&&v.every(n=>finite(n)&&Math.abs(n)<=LIMIT);
  // JSON text is the saved form: jsonb keeps every decimal digit but not the key order, so the comparison text sorts keys.
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  const same=(a,b)=>a!==undefined&&b!==undefined&&canonical(a)===canonical(b);
  const supportedBy=(value,algorithm)=>!!value&&typeof value==='object'&&value.schema===SCHEMA&&value.algorithm===algorithm&&value.coordinates===COORDINATES;
  // kin-mip-1 only, unchanged: every other algorithm is 'reproduce' here, which is what the accepted v12/v13 callers rely on.
  function supported(value){return supportedBy(value,ALGORITHM);}
  // '' for a block this viewer reproduces, 'reproduce' for another algorithm, 'shape' for anything malformed.
  function problem(value){
    if(!supported(value))return 'reproduce';
    return shapeProblem(value,ORIENTATIONS);
  }
  /* The same block rules bound to one algorithm's direction enum. A block naming the OTHER known algorithm is 'shape' — a
     malformed version/algorithm pair, not a computation this viewer cannot reproduce — while an unknown algorithm, schema or
     coordinate system stays 'reproduce'. Only the version-bound callers use this; validate()/supported() stay kin-mip-1. */
  function problemFor(algorithm,value){
    const names=enumOf(algorithm);
    if(!names)return 'reproduce';
    if(supportedBy(value,algorithm))return shapeProblem(value,names);
    const known=!!value&&typeof value==='object'&&value.schema===SCHEMA&&value.coordinates===COORDINATES&&has(ALGORITHMS,value.algorithm);
    return known?'shape':'reproduce';
  }
  function shapeProblem(value,orientations){
    if(!exact(value,KEYS)||!MODES.includes(value.mode)||!orientations.includes(value.orientation))return 'shape';
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
  // The block of one snapshot version: 12/13 accept exactly kin-mip-1, 14/15 exactly kin-mip-2, and an unknown version accepts none.
  const supportedFor=(version,value)=>{const algorithm=algorithmOf(version);return !!algorithm&&supportedBy(value,algorithm);};
  function validateFor(version,value){
    const algorithm=algorithmOf(version);
    const reason=algorithm?problemFor(algorithm,value):'shape';
    if(reason)throw Error(messages[reason]);
    return freeze(value);
  }
  /* The saved block is the confirmed Final request exactly as confirmed: a pending or superseded request, a display before
     its first Final and Original view are refused, and every number is copied without rounding or renormalization. */
  function block(snapshot,{frameOfReference,display}={}){
    const final=snapshot?.final,applied=snapshot?.applied;let confirmed=false;
    try{confirmed=!!final&&!!applied&&snapshot.state==='final'&&viewerModel().sameRequest(applied,final);}catch(_){confirmed=false;}
    if(!confirmed)throw Error(messages.rendering);
    if(final.original===true)throw Error(messages.original);
    const s=final.voiSlab??null;
    // The direction enum the confirmed orientation belongs to names the algorithm, so an Axial/Coronal/Sagittal display still
    // writes exactly the accepted kin-mip-1 bytes and only the six anatomical presets write kin-mip-2.
    const value={schema:SCHEMA,algorithm:algorithmFor(final.orientation),coordinates:COORDINATES,frameOfReference,mode:final.mode,orientation:final.orientation,
      display:{voiRange:{lower:display?.voiRange?.lower,upper:display?.voiRange?.upper},interpolationType:display?.interpolationType},
      voiSlab:s&&{center:[...s.center],normal:[...s.normal],pivot:[...s.pivot],thickness:s.thickness}};
    if(problemFor(value.algorithm,value))throw Error(messages.value);
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
  function restoreRequest(value,binding,version){
    // Without a version this is the accepted kin-mip-1 restore, unchanged: any other algorithm is 'reproduce', never 'shape'.
    // A caller that knows the Job's version passes it, and the block is then held to that version's own algorithm.
    const saved=version===undefined?validate(value):validateFor(version,value);
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
  /* A kept request belongs to the shown display only as the same pair: version 12 with no MIP Batch preview, or version 13 with
     the same recipe. A version 12 body has no mipBatch key at all, so both sides are normalized to null before comparing. */
  function retryable(pending,value,batch=null){
    if(!pending||!value)return false;
    const kept=pending.mipBatch??null,shown=batch??null;
    return pending.version===versionFor(value,shown)&&same(pending.mip,value)&&same(kept,shown);
  }
  // The saved-state identity of a shown display: its block with the recipe of the MIP Batch preview beside it, or null.
  const pair=(value,batch=null)=>value?{mip:value,mipBatch:batch??null}:null;
  /* The first reason a MIP save is refused, in the order a user can act on it: the account, a request in flight, a MIP Batch
     still being made, the display itself, its geometry, an earlier request whose result is unknown, then the title. `batch` is
     the recipe of the MIP Batch preview shown with that display, read in the same turn, or null. */
  function saveGate({writable,busy,generating=false,snapshot,frameOfReference,display,corners,pending=null,title='',retry=false,batch=null}){
    if(!writable)return {message:messages.writable,block:null,batch:null};
    if(busy)return {message:messages.busy,block:null,batch:null};
    if(generating)return {message:messages.generating,block:null,batch:null};
    let value;try{value=block(snapshot,{frameOfReference,display});}catch(error){return {message:error.message,block:null,batch:null};}
    if(!intersects(value.voiSlab,corners))return {message:messages.outside,block:null,batch:null};
    const kept=retryable(pending,value,batch);
    if(retry){if(!kept)return {message:messages.retryOther,block:null,batch:null};}
    else if(pending)return {message:kept?messages.useRetry:messages.useRequest,block:null,batch:null};
    if(!retry&&!String(title).trim())return {message:messages.title,block:null,batch:null};
    return {message:'',block:value,batch:batch??null};
  }
  /* Saved is a committed 200 for this exact display in this open operation: the pair of its block and MIP Batch recipe (pair()),
     or a bare block. A rejected request is Not Saved; an unknown receipt keeps the identical body for an idempotent retry and is
     Save Unconfirmed only while that display is shown. */
  function createSaveState(){
    let operation=null,saved=null,unconfirmed=null,saving=null;
    const key=value=>value===null||value===undefined?null:canonical(value);
    // The VOI Slab work of a pair is its block's; a MIP Batch preview is regenerable from the saved conditions and never counts.
    const record=value=>{const shown=value?.mip??value;return shown?.voiSlab?JSON.stringify([shown.mode,shown.orientation,[...shown.voiSlab.center],[...shown.voiSlab.normal],[...shown.voiSlab.pivot],shown.voiSlab.thickness]):null;};
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
  const api=Object.freeze({schema:SCHEMA,algorithm:ALGORITHM,directionAlgorithm:DIRECTION_ALGORITHM,coordinates:COORDINATES,messages,supported,validate,block,intersects,restoreRequest,presetFor,saveGate,createSaveState,same,retryable,pair,
    algorithmFor,algorithmOf,versionFor,supportedFor,validateFor,problemFor});
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumeMipJob=api;
})(typeof window==='object'?window:globalThis);
