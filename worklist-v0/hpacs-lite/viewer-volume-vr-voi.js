window.kinCreateVolumeVrVoi=function({controlsPane,getOperation,check,commit,refuse,masked,status}){
  const model=window.KinVolumeVrVoi;
  const el=(tag,text,parent)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;parent?.append(node);return node;};
  const fieldset=el('fieldset',undefined,controlsPane);el('legend','VOI',fieldset);
  el('p','원본 환자 좌표(LPS, mm)에 고정한 두 평면 사이(Slab)만 VR에 표시합니다. 끌어 회전·확대와 View From은 Slab을 옮기지 않습니다. 입력값은 Apply VOI를 눌러야 표시에 적용됩니다.',fieldset);
  // Visible labels carry the unit; the accessible names are the contract control names.
  const field=(text,name,title,parent=fieldset)=>{const label=el('label',text+' ',parent),input=el('input',undefined,label);input.type='number';input.step='any';input.setAttribute('aria-label',name);input.title=title;return input;};
  const choice=(text,name,values,title,parent=fieldset)=>{const label=el('label',text+' ',parent),input=el('select',undefined,label);input.setAttribute('aria-label',name);input.title=title;for(const value of values){const option=el('option',value,input);option.value=value;}return input;};
  const button=(text,title,parent=fieldset)=>{const node=el('button',text,parent);node.type='button';node.title=title;return node;};
  const preset=choice('Preset','VOI Preset',['Axial','Coronal','Sagittal'],'선택한 방향으로 원본 전체를 덮는 기본 Slab 값을 입력합니다. 표시에는 Apply VOI 또는 Reset VOI로 적용합니다.');
  const center=['L','P','S'].map(axis=>field('Center '+axis+' (mm)','VOI Center '+axis,'Slab 중심의 환자 좌표(LPS, mm)입니다.'));
  const pivot=['L','P','S'].map(axis=>field('Pivot '+axis+' (mm)','VOI Pivot '+axis,'Rotate Slab의 회전 기준점(LPS, mm)입니다. 기준점만 바꾸면 Slab은 움직이지 않습니다.'));
  const thickness=field('Thickness (mm)','VOI Thickness','Slab 두께(mm)입니다. 0보다 크고 원본 범위 대각선 이하여야 합니다.');
  const normalText=el('span','',fieldset);
  const moveInput=field('Move (mm)','VOI Move','적용된 Slab을 법선 방향으로 옮길 거리(mm)입니다. 음수는 반대 방향입니다.'),moveButton=button('Move Slab','적용된 Slab을 입력한 거리만큼 옮겨 적용합니다.');
  const axis=choice('Rotate Axis','VOI Rotate Axis',['L','P','S'],'회전축(환자 좌표 L/P/S)입니다.'),degrees=field('Degrees','VOI Rotate Degrees','기준점을 중심으로 돌릴 각도(도, -180~180)입니다.'),rotateButton=button('Rotate Slab','적용된 Slab을 기준점 둘레로 돌려 적용합니다. 화면 회전과는 따로입니다.');
  const applyButton=button('Apply VOI','입력한 Slab을 VR 표시에 적용합니다.'),undoButton=button('Undo VOI','직전에 적용한 VOI 상태로 되돌립니다.'),resetButton=button('Reset VOI','선택한 Preset의 기본 Slab을 적용합니다.'),disableButton=button('Disable VOI','VOI를 끕니다. 입력값과 다른 표시 조건은 그대로입니다.');
  const originalLabel=el('label','Original View ',fieldset),original=el('input',undefined,originalLabel);original.type='checkbox';original.setAttribute('aria-label','Original View');original.title='VOI와 조각 제거 가림을 잠시 끈 보기입니다. 가림 설정은 유지되고, 켜 있는 동안 가림 편집은 잠깁니다.';
  const stateLine=el('p','',fieldset),note=el('p','',fieldset);
  el('p','VR에만 적용: 이 가림은 VR 화면에만 적용되며 MPR·MIP Viewer·Endo·출력·원본 DICOM에는 적용되지 않습니다. 표시에서 가릴 뿐 원본 영상과 판독 입력은 그대로입니다.',fieldset);
  let draftNormal=null;
  const editors=[preset,...center,...pivot,thickness,moveInput,axis,degrees];

  function writeEditors(slab,orientation){
    center.forEach((input,i)=>{input.value=String(slab.center[i]);});pivot.forEach((input,i)=>{input.value=String(slab.pivot[i]);});thickness.value=String(slab.thickness);
    draftNormal=Object.freeze([...slab.normal]);normalText.textContent='Normal L/P/S '+slab.normal.map(n=>n.toFixed(3)).join(' / ');
    if(orientation)preset.value=orientation;
  }
  function number(input,name){const text=input.value.trim(),value=text===''?NaN:Number(text);if(!Number.isFinite(value))throw model.refusal('vr-limit',name+' 값을 숫자로 입력하세요.');return value;}
  function draft(){
    if(!draftNormal)throw model.refusal('vr-limit','VOI Preset을 먼저 선택하세요.');
    return {center:center.map((input,i)=>number(input,'VOI Center '+'LPS'[i])),normal:[...draftNormal],pivot:pivot.map((input,i)=>number(input,'VOI Pivot '+'LPS'[i])),thickness:number(thickness,'VOI Thickness')};
  }
  const mm=n=>Number(n.toFixed(1));
  function refresh(){
    const op=getOperation?.(),s=op?.ready?op.voiState:null,usable=!!s&&!op.voiProblem,locked=!!s?.original;
    for(const input of [...editors,applyButton,resetButton])input.disabled=!usable||locked;
    moveButton.disabled=rotateButton.disabled=disableButton.disabled=!usable||locked||!s.voi;
    undoButton.disabled=!usable||locked||!s.history.length;
    let anyMask=false;try{anyMask=!!s&&(!!s.voi||!!masked?.(op));}catch(_){}
    original.checked=locked;original.disabled=!usable||!locked&&!anyMask;
    stateLine.textContent=!s?'':locked?'VOI · Original View':s.voi?'VOI · On · '+s.voi.orientation+' · '+mm(s.voi.slab.thickness)+' mm':'VOI · Off';
  }
  // Invalid input and Original View refuse before any native call; an accepted transition goes through the one mask path.
  function act(build,message,after){
    const op=getOperation?.();if(!op?.ready)return;let next;
    try{check(op);if(op.voiProblem)throw model.refusal('source-unsupported',op.voiProblem);next=build(op,op.voiState);}
    catch(error){refuse(op,error);refresh();return;}
    if(next===op.voiState){status.textContent='이미 표시에 적용된 VOI 상태입니다.';refresh();return;}
    if(commit(op,next,message))after?.(next);
    refresh();
  }
  const written=next=>{if(next.voi)writeEditors(next.voi.slab,next.voi.orientation);};
  applyButton.onclick=()=>act((op,s)=>model.apply(s,op.voiBinding,{orientation:preset.value,slab:draft()}),'VOI를 적용했습니다.',written);
  moveButton.onclick=()=>act((op,s)=>model.move(s,op.voiBinding,number(moveInput,'VOI Move')),'VOI를 옮겨 적용했습니다.',written);
  rotateButton.onclick=()=>act((op,s)=>model.rotate(s,op.voiBinding,axis.value,number(degrees,'VOI Rotate Degrees')),'VOI를 돌려 적용했습니다.',written);
  resetButton.onclick=()=>act((op,s)=>model.reset(s,op.voiBinding,preset.value),'선택한 Preset의 기본 VOI를 적용했습니다.',written);
  disableButton.onclick=()=>act((op,s)=>model.disable(s),'VOI를 껐습니다. 입력값은 그대로입니다.');
  undoButton.onclick=()=>act((op,s)=>model.undo(s),'직전 VOI 상태로 되돌렸습니다.',written);
  original.onchange=()=>{const on=original.checked;act((op,s)=>model.setOriginal(s,on,!!masked?.(op)),on?'Original View: 가림을 잠시 끈 보기입니다. 가림 설정은 유지됩니다.':'Original View를 끄고 가림을 다시 적용했습니다.');};
  preset.onchange=()=>{const op=getOperation?.();if(!op?.ready||op.voiProblem)return;try{check(op);writeEditors(model.defaults(op.voiBinding,preset.value));}catch(error){refuse(op,error);}};

  return {fieldset,refresh,
    // A fresh VR binds the VOI to the volume it opened on; a source that cannot bind keeps VR usable without VOI.
    ready(op){
      op.voiProblem=null;note.textContent='';
      try{op.voiBinding=model.binding(op.imageData);writeEditors(model.defaults(op.voiBinding,'Axial'),'Axial');}
      catch(error){op.voiBinding=null;op.voiProblem=error.message;note.textContent=error.message;op.lastRefusal=model.reasonOf(error);}
      moveInput.value=degrees.value='';axis.value='L';refresh();
    },
    reset(op){if(op?.voiBinding){try{writeEditors(model.defaults(op.voiBinding,'Axial'),'Axial');}catch(_){}}moveInput.value=degrees.value='';axis.value='L';refresh();},
    clear(){draftNormal=null;for(const input of [...center,...pivot,thickness,moveInput,degrees])input.value='';preset.value='Axial';axis.value='L';normalText.textContent=note.textContent='';original.checked=false;refresh();},
    dispose(){fieldset.remove();}};
};
