window.kinCreateVolumeSculpt=function({controlsPane,canvasPane,canvasHost,getOperation,check,render,fail,status,setDrawing}){
  const model=window.KinVolumeSculpt,svgNS='http://www.w3.org/2000/svg';
  const el=(tag,text,parent)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;parent?.append(node);return node;};
  const fieldset=el('fieldset',undefined,controlsPane);fieldset.id='kin-vr-sculpt';el('legend','Manual Sculpt',fieldset);
  const select=(label,values)=>{const wrap=el('label',label+' ',fieldset),input=el('select',undefined,wrap);input.setAttribute('aria-label',label);for(const value of values){const option=el('option',value,input);option.value=value;}return input;};
  const tool=select('Sculpt Tool',['Freehand Area','Freehand Line','Curved Area','Curved Line','Ellipse','Rectangle']),side=select('Removal Side',['Inside','Outside']);
  const draw=el('button','Draw Region',fieldset),finish=el('button','Finish Region',fieldset),apply=el('button','Apply Sculpt',fieldset),cancelButton=el('button','Cancel Sculpt',fieldset),undo=el('button','Undo Sculpt',fieldset),clear=el('button','Clear Sculpt',fieldset);
  for(const button of [draw,finish,apply,cancelButton,undo,clear])button.type='button';
  el('p','화면에 그린 영역을 원본 좌표에 무한 깊이로 고정해 표시에서만 제거합니다. Area는 끝점을 직선으로 닫고 Line은 양 끝을 가까운 화면 가장자리와 시계 방향 테두리로 닫습니다. Inside는 빨강, Outside는 파랑으로 제거 쪽을 미리 봅니다.',fieldset);
  const originalPosition=canvasPane.style.position;let changedPosition=false,overlay=null,draft=null,ended=false;
  const geometryMessages=new Map([
    ['Sculpt points must be finite normalized coordinates.','조각 경계점은 화면 안의 유효한 좌표여야 합니다.'],
    ['Sculpt query must contain finite coordinates.','조각 좌표를 확인하세요.'],
    ['Sculpt boundary cannot be simplified to 64 points within tolerance.','경계가 너무 복잡합니다. 더 단순하게 다시 그리세요.'],
    ['Sculpt boundary is degenerate.','조각 영역의 너비와 높이를 충분히 크게 그리세요.'],
    ['Invalid sculpt region.','조각 영역 형식을 확인하세요.'],
    ['Rectangle and ellipse require two corner points.','사각형 또는 타원을 드래그해 두 모서리를 지정하세요.'],
    ['Freehand sculpt input exceeds 2048 points.','자유형 경계점은 최대 2048개까지 입력할 수 있습니다.'],
    ['Curved sculpt input exceeds 128 control points.','곡선 제어점은 최대 128개까지 입력할 수 있습니다.'],
    ['Invalid sculpt projection.','VR 조각 투영 정보를 확인하세요.'],
    ['Invalid sculpt spatial extent.','VR 영상의 공간 범위를 확인하세요.'],
    ['Invalid sculpt operation.','VR 조각 적용 정보를 확인하세요.'],
    ['Invalid sculpt numeric value.','VR 조각 수치가 유효하지 않습니다.'],
    ['At most 8 sculpt operations are supported.','VR 조각 제거는 최대 8개까지 적용할 수 있습니다.']
  ]);

  function verify(op){try{check(op);}catch(error){error.kinSculptStale=true;throw error;}}
  function geometry(action){try{return action();}catch(error){const translated=geometryMessages.get(error?.message);if(translated)throw Error(translated);throw error;}}
  function ready(){
    if(ended)throw Error('VR 조각 도구가 종료되었습니다.');const op=getOperation?.();if(!op?.ready)throw Error('준비된 VR 표시를 확인하세요.');
    verify(op);
    if(op.libraryBusy)throw Error('VR 프리셋 저장을 마친 뒤 조각 영역을 편집하세요.');
    return op;
  }
  function report(op,error,nativeChanged=false){if(nativeChanged||error?.kinSculptStale)fail(op,error);else status.textContent=error?.message||'조각 영역을 확인하세요.';}
  function operationState(op){
    if(!Array.isArray(op.sculptOperations))op.sculptOperations=[];
    if(!op.sculptPristineMapperProperties)op.sculptPristineMapperProperties=op.mapper.getViewSpecificProperties()||{};
    return {operations:op.sculptOperations,pristine:op.sculptPristineMapperProperties};
  }
  function replacementProperties(op,operations){
    const {pristine}=operationState(op),openGL=pristine.OpenGL||{},existing=Array.isArray(openGL.ShaderReplacements)?openGL.ShaderReplacements:[];
    if(!operations.length)return pristine;
    return {...pristine,OpenGL:{...openGL,ShaderReplacements:[...existing,geometry(()=>model.shaderReplacement(operations))]}};
  }
  function requireMapper(op){
    if(!model||typeof model.makeRegion!=='function'||typeof model.projection!=='function'||typeof model.makeOperation!=='function'||typeof model.shaderReplacement!=='function')throw Error('VR 조각 도구를 불러오지 못했습니다.');
    if(!op.mapper||typeof op.mapper.getViewSpecificProperties!=='function'||typeof op.mapper.setViewSpecificProperties!=='function'||!op.imageData||typeof op.view?.worldToCanvas!=='function')throw Error('이 뷰어에서는 VR 조각 표시를 사용할 수 없습니다.');
    const camera=op.view.getCamera?.(),width=canvasHost.clientWidth,height=canvasHost.clientHeight;
    if(camera?.parallelProjection!==true||![width,height].every(value=>Number.isFinite(value)&&value>0))throw Error('평행 투영 VR 화면 크기를 확인하세요.');
    return {width,height,projection:geometry(()=>model.projection(op.imageData,point=>op.view.worldToCanvas(point),width,height))};
  }
  function point(event){const rect=overlay.getBoundingClientRect();if(!(rect.width>0&&rect.height>0))throw Error('조각 미리보기 화면 크기를 확인하세요.');return [Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))];}
  const px=(value,size)=>Number((value*size).toFixed(3));
  function regionPath(region,width,height){
    if(region.kind==='Rectangle'){const [x0,x1,y0,y1]=region.bounds;return `M${px(x0,width)} ${px(y0,height)}H${px(x1,width)}V${px(y1,height)}H${px(x0,width)}Z`;}
    if(region.kind==='Ellipse'){const [x0,x1,y0,y1]=region.bounds,cx=px((x0+x1)/2,width),cy=px((y0+y1)/2,height),rx=px((x1-x0)/2,width),ry=px((y1-y0)/2,height);return `M${cx-rx} ${cy}A${rx} ${ry} 0 1 0 ${cx+rx} ${cy}A${rx} ${ry} 0 1 0 ${cx-rx} ${cy}Z`;}
    if(region.kind==='Polygon')return region.points.map((p,index)=>(index?'L':'M')+px(p[0],width)+' '+px(p[1],height)).join('')+'Z';
    throw Error('조각 미리보기 형식을 확인할 수 없습니다.');
  }
  function rawPath(points,width,height){return points.map((p,index)=>(index?'L':'M')+px(p[0],width)+' '+px(p[1],height)).join('');}
  function preview(){
    if(!overlay||!draft)return;overlay.replaceChildren();const {width,height}=draft;
    if(!draft.region){if(draft.points.length){const path=document.createElementNS(svgNS,'path');path.setAttribute('d',rawPath(draft.points,width,height));path.setAttribute('fill','none');path.setAttribute('stroke','#ffdb55');path.setAttribute('stroke-width','2');path.setAttribute('pointer-events','none');overlay.append(path);}refresh();return;}
    const inside=regionPath(draft.region,width,height),fill=document.createElementNS(svgNS,'path'),boundary=document.createElementNS(svgNS,'path');
    fill.setAttribute('d',draft.side==='Outside'?`M0 0H${width}V${height}H0Z${inside}`:inside);fill.setAttribute('fill',draft.side==='Inside'?'rgba(255,70,70,.32)':'rgba(65,150,255,.28)');fill.setAttribute('fill-rule','evenodd');
    fill.setAttribute('pointer-events','none');boundary.setAttribute('d',inside);boundary.setAttribute('fill','none');boundary.setAttribute('stroke',draft.side==='Inside'?'#ff7777':'#70b7ff');boundary.setAttribute('stroke-width','2');boundary.setAttribute('vector-effect','non-scaling-stroke');boundary.setAttribute('pointer-events','none');overlay.append(fill,boundary);refresh();
  }
  function refresh(){const active=!!draft;tool.disabled=active;draw.disabled=active;finish.disabled=!active||!!draft.region;apply.disabled=!draft?.region;cancelButton.disabled=!active;undo.disabled=active;clear.disabled=active;}
  function cleanup(){overlay?.remove();overlay=null;draft=null;try{setDrawing(false);}catch(_){}refresh();}
  function complete(){
    if(!draft||draft.region)return;const op=draft.op;try{verify(op);draft.region=geometry(()=>model.makeRegion(draft.mode,draft.points,.002));preview();status.textContent='조각 제거 영역을 미리 봅니다. Apply Sculpt로 적용하세요.';}catch(error){if(error.kinSculptStale||getOperation?.()!==op)report(op,Object.assign(error,{kinSculptStale:true}));else status.textContent=error.message;}
  }
  function appendPoint(event){
    if(!draft)return;const op=draft.op;try{verify(op);const next=point(event),limit=draft.mode.startsWith('Curved')?128:2048;if(draft.points.length>=limit){cleanup();throw Error('그린 점이 너무 많아 미리보기를 취소했습니다. 더 단순한 경계로 다시 그리세요.');}const previous=draft.points.at(-1);if(!previous||Math.hypot(next[0]-previous[0],next[1]-previous[1])>=.002)draft.points.push(next);event.preventDefault();preview();}catch(error){report(op,error);}
  }
  function begin(){let op;try{
    op=ready();const capture=requireMapper(op);cleanup();if(getComputedStyle(canvasPane).position==='static'){canvasPane.style.position='relative';changedPosition=true;}
    overlay=document.createElementNS(svgNS,'svg');overlay.dataset.kinVrSculpt='1';overlay.setAttribute('aria-label','Sculpt removal preview');overlay.setAttribute('viewBox',`0 0 ${capture.width} ${capture.height}`);overlay.style.cssText='position:absolute;inset:0;width:100%;height:100%;z-index:3;touch-action:none;cursor:crosshair';canvasPane.append(overlay);
    draft={op,mode:tool.value,side:side.value,projection:capture.projection,width:capture.width,height:capture.height,points:[],pointer:null,region:null};setDrawing(true);refresh();status.textContent=draft.mode.startsWith('Curved')?'화면을 눌러 제어점을 추가하고 Finish Region 또는 오른쪽 클릭으로 마치세요.':'화면에서 제거 영역을 드래그하세요.';
    }catch(error){if(draft?.op===op)cleanup();if(op)report(op,error);else status.textContent=error.message;}}
  function applyDraft(){const op=draft?.op||getOperation?.();let changed=false;try{
    const current=ready();if(!draft?.region||current!==op)throw Error('적용할 조각 영역을 먼저 완성하세요.');const state=operationState(op);if(state.operations.length>=8)throw Error('VR 조각 제거는 최대 8개까지 적용할 수 있습니다.');
    const operation=geometry(()=>model.makeOperation(draft.region,draft.projection,draft.side)),next=[...state.operations,operation],properties=replacementProperties(op,next);changed=true;op.mapper.setViewSpecificProperties(properties);verify(op);op.sculptOperations=next;render(op);cleanup();status.textContent='VR 조각 제거를 적용했습니다.';
  }catch(error){report(op,error,changed);}}
  function restore(op,next,message){let changed=false;try{verify(op);const state=operationState(op),properties=replacementProperties(op,next);changed=true;op.mapper.setViewSpecificProperties(properties);verify(op);op.sculptOperations=next;render(op);if(message)status.textContent=message;return true;}catch(error){report(op,error,changed);return false;}}
  function undoLast(){let op;try{op=ready();if(draft)throw Error('현재 미리보기를 취소한 뒤 되돌리세요.');const operations=Array.isArray(op.sculptOperations)?op.sculptOperations:[];if(!operations.length)throw Error('되돌릴 VR 조각 제거가 없습니다.');restore(op,operations.slice(0,-1),'마지막 VR 조각 제거를 되돌렸습니다.');}catch(error){if(op)report(op,error);else status.textContent=error.message;}}
  function clearAll(){let op;try{op=ready();if(draft)throw Error('현재 미리보기를 취소한 뒤 모두 지우세요.');const operations=Array.isArray(op.sculptOperations)?op.sculptOperations:[];if(!operations.length)throw Error('지울 VR 조각 제거가 없습니다.');restore(op,[],'VR 조각 제거를 모두 지웠습니다.');}catch(error){if(op)report(op,error);else status.textContent=error.message;}}

  draw.onclick=begin;finish.onclick=()=>{let op;try{op=ready();if(!draft||draft.op!==op)throw Error('그릴 조각 영역을 시작하세요.');complete();}catch(error){if(op)report(op,error);else status.textContent=error.message;}};apply.onclick=applyDraft;cancelButton.onclick=()=>{let op;try{op=ready();if(!draft)throw Error('취소할 조각 미리보기가 없습니다.');cleanup();status.textContent='VR 조각 미리보기를 취소했습니다.';}catch(error){if(op)report(op,error);else status.textContent=error.message;}};undo.onclick=undoLast;clear.onclick=clearAll;
  const pointerDown=event=>{if(event.target!==overlay||!draft)return;const op=draft.op;try{verify(op);if(draft.region){event.preventDefault();return;}if(draft.mode.startsWith('Curved')){if(event.button===0)appendPoint(event);return;}if(event.button!==0)return;draft.points=[point(event)];if(['Ellipse','Rectangle'].includes(draft.mode))draft.points.push(draft.points[0]);draft.pointer=event.pointerId;overlay.setPointerCapture(event.pointerId);event.preventDefault();}catch(error){report(op,error);}};
  const pointerMove=event=>{if(!draft||draft.pointer!==event.pointerId)return;event.preventDefault();try{verify(draft.op);if(['Ellipse','Rectangle'].includes(draft.mode))draft.points[1]=point(event);else appendPoint(event);preview();}catch(error){report(draft.op,error);}};
  const endPointer=event=>{if(!draft||draft.pointer!==event.pointerId)return;event.preventDefault();draft.pointer=null;try{overlay.releasePointerCapture(event.pointerId);}catch(_){}complete();};
  const cancelPointer=event=>{if(!draft||draft.pointer!==event.pointerId)return;event.preventDefault();const op=draft.op;let error;try{verify(op);}catch(caught){error=caught;}cleanup();if(error)report(op,error);else status.textContent='포인터 입력이 취소되어 조각 미리보기를 지웠습니다.';};
  const contextMenu=event=>{if(event.target!==overlay||!draft)return;event.preventDefault();if(!draft.region)complete();};
  canvasPane.addEventListener('pointerdown',pointerDown);canvasPane.addEventListener('pointermove',pointerMove);canvasPane.addEventListener('pointerup',endPointer);canvasPane.addEventListener('pointercancel',cancelPointer);canvasPane.addEventListener('contextmenu',contextMenu);
  side.onchange=()=>{let op;try{op=ready();if(draft?.op===op){draft.side=side.value;preview();}}catch(error){if(op)report(op,error);else status.textContent=error.message;}};
  refresh();
  return {fieldset,reset(op){cleanup();if(!op)return;const operations=Array.isArray(op.sculptOperations)?op.sculptOperations:[];if(!operations.length){op.sculptOperations=[];return;}if(!restore(op,[],null))throw Error('VR 조각 제거를 초기화하지 못했습니다.');},cancel:cleanup,dispose(){ended=true;cleanup();for(const [name,handler] of [['pointerdown',pointerDown],['pointermove',pointerMove],['pointerup',endPointer],['pointercancel',cancelPointer],['contextmenu',contextMenu]])canvasPane.removeEventListener(name,handler);fieldset.remove();if(changedPosition)canvasPane.style.position=originalPosition;}};
};
