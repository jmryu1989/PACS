/* Shared loaded-image clipboard UI, used in the viewer's own document. */
window.kinCreateViewerPatientCopy=function(options){
  let ended=false,channel,identity;
  const {services,selected}=options,owner=options.owner,live=()=>!ended&&options.live();
  const blocked=()=>options.blocked?.()||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show');
  const text=v=>v&&typeof v==='object'?String(v.Alphabetic??v.Ideographic??v.Phonetic??''):String(v??'');
  const toolBar=document.createElement('section');toolBar.id='kin-viewer-patient-copy';options.host.append(toolBar);
    const copy=document.createElement('button');copy.id='kin-viewer-copy-id';copy.type='button';copy.textContent='Copy Patient ID';copy.setAttribute('aria-keyshortcuts','Control+Alt+C');copy.setAttribute('aria-describedby','kin-viewer-copy-context');toolBar.append(copy);
    const copyContext=document.createElement('p');copyContext.id='kin-viewer-copy-context';toolBar.append(copyContext);
    const copyStatus=document.createElement('p');copyStatus.id='kin-viewer-copy-status';copyStatus.setAttribute('role','status');toolBar.append(copyStatus);
    let copyBusy=false,copyEpoch=0,copySignature='',copyTracked=false,copyMenuOpen=false,restoreCopyMenu=()=>{};
    function copyTarget(){
      if(!live()||!owner()||!copyTracked)return null;
      try{
        const current=selected(),m=current&&window.cornerstone?.metaData?.get('instance',current.image);
        if(!current||!m||m.StudyInstanceUID!==current.uid||m.SeriesInstanceUID!==current.series||m.SOPInstanceUID!==current.sop||
          typeof m.PatientID!=='string'||!m.PatientID.trim()||m.PatientID.length>64||(current.study.id&&m.PatientID!==current.study.id))return null;
        // The pinned display-set summary omits PatientID; the loaded instance is
        // authoritative after its full study/series/SOP identity has matched.
        return {...current,study:{...current.study,name:text(m.PatientName),date:text(m.StudyDate)},patientId:m.PatientID};
      }catch(_){return null;}
    }
    function refreshCopy(){
      const current=copyTarget(),signature=current?JSON.stringify([current.viewportId,current.uid,current.image,current.patientId,current.sourceSignature||'']):'';
      if(signature!==copySignature){copySignature=signature;copyEpoch++;copyStatus.textContent='';}
      copy.disabled=!current;copy.setAttribute('aria-disabled',String(!current||copyBusy));copy.setAttribute('aria-busy',String(copyBusy));
      copyContext.textContent=current?(current.sourceSignature?'선택 볼륨 원본':'선택 영상')+' · '+current.study.name+' ('+current.patientId+') · '+current.study.date+' · 검사 '+current.uid:'환자 ID가 확인되는 영상 칸을 선택하세요.';
      if(!identity&&live()&&owner())identity=window.KinViewerIdentity?.mount({services,resolve:selected,owner,allowed:live,studies:options.studies});
    }
    async function copyPatientId(expected=null){
      refreshCopy();const current=copyTarget();
      const announce=message=>{copyStatus.textContent=message;if(expected)services.uiNotificationService?.show({title:'환자 ID 복사',message,type:'info'});};
      if(expected&&(expected.epoch!==copyEpoch||expected.signature!==copySignature||expected.owner!==JSON.stringify(owner()))){if(live())announce('영상 선택이나 세션이 바뀌었습니다. 메뉴를 다시 열어 대상을 확인하세요.');return;}
      if(!current||copyBusy||blocked())return;
      const ticket=copyEpoch;
      if(!navigator.clipboard?.writeText){announce('이 브라우저는 복사를 지원하지 않습니다. 표시된 ID를 직접 선택해 복사하세요.');return;}
      copyBusy=true;refreshCopy();copyStatus.textContent='환자 ID 복사 중…';
      try{
        // Keep the explicit gesture and loaded image identity together. A completed
        // OS write cannot be recalled; navigation invalidates only its late UI result.
        await navigator.clipboard.writeText(current.patientId);refreshCopy();
        if(ticket===copyEpoch&&live())announce('환자 ID를 복사했습니다.');
      }catch(_){refreshCopy();if(ticket===copyEpoch&&live())announce('복사가 허용되지 않았거나 실패했습니다. 다시 시도하세요.');}
      finally{copyBusy=false;refreshCopy();}
    }
    copy.onclick=()=>copyPatientId();
    const copyChanged=()=>{copyEpoch++;options.onSelection?.();copyStatus.textContent='';refreshCopy();};
    const copySubscriptions=[];const copyStackEvent=window.cornerstone?.Enums?.Events?.STACK_NEW_IMAGE;
    const volumeEvents=['VOLUME_NEW_IMAGE','CAMERA_MODIFIED'].map(k=>window.cornerstone?.Enums?.Events?.[k]).filter(Boolean);
    // Camera drags can fire every frame. Invalidate the ticket immediately;
    // scan all source identities only on the regular refresh or explicit copy.
    const volumeChanged=e=>{try{const v=services.cornerstoneViewportService.getCornerstoneViewport(e.detail?.viewportId);if(v&&['orthographic','volume3d'].includes(v.type)){copyEpoch++;copyStatus.textContent='';options.onSelection?.({contextOnly:true});}}catch(_){copyEpoch++;}};
    try{
      const grid=services.viewportGridService,events=Object.values(grid.EVENTS);
      if(!copyStackEvent||!events.length)throw new Error('image observation unavailable');
      for(const event of new Set(events))copySubscriptions.push(grid.subscribe(event,copyChanged));
      document.addEventListener(copyStackEvent,copyChanged,true);copyTracked=true;
      for(const event of volumeEvents)document.addEventListener(event,volumeChanged,true);
    }catch(_){copySubscriptions.forEach(s=>s.unsubscribe());copySubscriptions.length=0;}
    // The pinned tools do not emit the measurement-menu command on blank
    // right clicks. Use the DOM gesture, but leave nearby annotations untouched.
    const menuCommands=services.customizationService?.commandsManager;
    let copyGesture=null;
    const copyMenuTarget=e=>{
      refreshCopy();const current=copyTarget(),element=current&&services.cornerstoneViewportService.getCornerstoneViewport(current.viewportId)?.element;
      if(!current||!element?.contains(e.target)||copyBusy||blocked())return null;
      const canvas=element.querySelector('canvas');if(!canvas)return null;
      const bounds=canvas.getBoundingClientRect(),xy=[e.clientX-bounds.left,e.clientY-bounds.top];
      try{if(!menuCommands?.getCommand('getNearbyToolData','CORNERSTONE')||menuCommands.runCommand('getNearbyToolData',{element,canvasCoordinates:xy},'CORNERSTONE'))return;}catch(_){return;}
      return {current,element};
    };
    const showCopyMenu=e=>{
      const target=copyMenuTarget(e);if(!target)return;
      const {current,element}=target;
      const expected={epoch:copyEpoch,signature:copySignature,owner:JSON.stringify(owner())};
      e.preventDefault();copyMenuOpen=true;
      try{menuCommands.runCommand('showContextMenu',{event:{detail:{element,currentPoints:{client:[e.clientX,e.clientY]}}},element,menuId:'kin-patient-copy',menus:[{id:'kin-patient-copy',items:[{
        label:(current.sourceSignature?'Volume Source · ':'')+'Copy Patient ID · '+current.patientId+' · '+current.study.date,
        action:(_item,props)=>{props.onClose();copyMenuOpen=false;copyPatientId(expected);}
      }]}]});}catch(_){copyMenuOpen=false;copyStatus.textContent='메뉴를 열지 못했습니다. 복사 버튼이나 Ctrl+Alt+C를 사용하세요.';}
    };
    const copyMouseDown=e=>{
      if(copyMenuOpen&&!e.target.closest?.('[data-cy="context-menu"]')){services.uiDialogService?.dismiss({id:'context-menu'});copyMenuOpen=false;}
      copyGesture=e.button===2&&!e.altKey&&!e.ctrlKey&&!e.shiftKey&&!e.metaKey?{x:e.clientX,y:e.clientY,time:Date.now(),drag:false,up:false,event:null}:null;
    };
    const copyMouseMove=e=>{if(copyGesture&&Math.hypot(e.clientX-copyGesture.x,e.clientY-copyGesture.y)>3)copyGesture.drag=true;};
    const copyMouseUp=e=>{
      if(e.button!==2||!copyGesture)return;copyMouseMove(e);const gesture=copyGesture;gesture.up=true;
      // Some platforms emit contextmenu on down, others after up. Wait for a
      // completed click in either order; never put a menu over a right drag.
      if(gesture.event&&!gesture.drag)setTimeout(()=>{if(copyGesture===gesture&&live())showCopyMenu(gesture.event);},0);
    };
    const openCopyMenu=e=>{
      const gesture=copyGesture;if(!gesture||gesture.drag||e.button!==2||Date.now()-gesture.time>1500||!copyMenuTarget(e))return;
      e.preventDefault();if(gesture.up)showCopyMenu(e);else gesture.event=e;
    };
    const clearCopyGesture=()=>{copyGesture=null;};
    document.addEventListener('mousedown',copyMouseDown,true);document.addEventListener('mousemove',copyMouseMove,true);document.addEventListener('mouseup',copyMouseUp,true);window.addEventListener('blur',clearCopyGesture);
    document.addEventListener('contextmenu',openCopyMenu);
    restoreCopyMenu=()=>{copyGesture=null;document.removeEventListener('mousedown',copyMouseDown,true);document.removeEventListener('mousemove',copyMouseMove,true);document.removeEventListener('mouseup',copyMouseUp,true);window.removeEventListener('blur',clearCopyGesture);document.removeEventListener('contextmenu',openCopyMenu);if(copyMenuOpen)services.uiDialogService?.dismiss({id:'context-menu'});copyMenuOpen=false;};

  const key=e=>{if(e.defaultPrevented||e.repeat||e.isComposing||e.getModifierState('AltGraph')||!e.ctrlKey||!e.altKey||e.shiftKey||e.metaKey||e.code!=='KeyC'||blocked()||e.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'))return;e.preventDefault();copyPatientId();};
  document.addEventListener('keydown',key);
  const timer=setInterval(refreshCopy,500);
  const storage=e=>{if(e.key==='kin-session-ended')end();};window.addEventListener('storage',storage);window.addEventListener('pagehide',end);
  try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
  function end(){if(ended)return;ended=true;identity?.dispose();copyTracked=false;clearInterval(timer);restoreCopyMenu();document.removeEventListener('keydown',key);window.removeEventListener('storage',storage);window.removeEventListener('pagehide',end);if(copyStackEvent)document.removeEventListener(copyStackEvent,copyChanged,true);for(const event of volumeEvents)document.removeEventListener(event,volumeChanged,true);copySubscriptions.forEach(s=>s.unsubscribe());channel?.close();refreshCopy();}
  refreshCopy();return {refresh:refreshCopy,tracked:()=>copyTracked,end,dispose(){end();toolBar.remove();}};
};

/* Change only the native primary section's IDs. Button definitions, command
 * bindings, evaluation and active tools remain owned by the pinned viewer. */
window.kinCreateViewerToolbarPreferences=function(options){
  const catalog=[['MeasurementTools','Measurements'],['Zoom','Zoom'],['Pan','Pan'],['TrackballRotate','3D Rotate'],['WindowLevel','Window / Level'],['Capture','Capture'],['Layout','Layout'],['Crosshairs','Crosshairs'],['MoreTools','More Tools']];
  const ids=catalog.map(x=>x[0]),labels=Object.fromEntries(catalog),service=options.services.toolbarService;
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),read=()=>service.getButtonSection('primary').map(b=>b?.id);
  const defaults=()=>({version:1,order:ids.slice(),hidden:[]});
  const normalize=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')==='hidden,order,version'&&v.version===1&&Array.isArray(v.order)&&v.order.length===ids.length&&new Set(v.order).size===ids.length&&v.order.every(id=>ids.includes(id))&&Array.isArray(v.hidden)&&new Set(v.hidden).size===v.hidden.length&&v.hidden.every(id=>ids.includes(id)&&id!=='Zoom')?{version:1,order:v.order.slice(),hidden:v.hidden.slice()}:null;
  if(!service||typeof service.getButtonSection!=='function'||typeof service.clearButtonSection!=='function'||typeof service.createButtonSection!=='function')return null;
  const baseline=read();if(!same(baseline,ids))return null;
  const initialOwner=JSON.stringify(options.owner()),key='kin-viewer-toolbar:v1:'+initialOwner;
  let ended=false,applying=false,suspended=false,current=defaults(),draft,applied=baseline.slice(),opener,channel;
  const live=()=>!ended&&options.live()&&JSON.stringify(options.owner())===initialOwner;
  function notify(type){for(const target of window.parent===window?[window]:[window,window.parent])try{target.dispatchEvent(new target.CustomEvent('kin-toolbar-preference-'+type,{detail:{owner:initialOwner,value:normalize(current)}}));}catch(_){} }
  function persist(){notify('changed');try{localStorage.setItem(key,JSON.stringify(current));status.textContent='도구 모음을 기억했습니다 · 이 브라우저';}catch(_){status.textContent='저장하지 못해 이 창에만 적용합니다.';}}
  const box=document.createElement('section');box.id='kin-native-toolbar-settings';options.host.append(box);
  const button=document.createElement('button');button.type='button';button.id='kin-native-toolbar-edit';button.textContent='Edit Toolbar';box.append(button);
  const status=document.createElement('span');status.id='kin-native-toolbar-status';status.setAttribute('role','status');status.textContent='이 브라우저 · 현재 계정';box.append(status);
  const dialog=document.createElement('dialog');dialog.id='kin-native-toolbar-dialog';dialog.setAttribute('aria-labelledby','kin-native-toolbar-title');
  dialog.style.cssText='background:#101e32;color:#e1ecfc;border:1px solid #718eaa;border-radius:8px;max-height:85vh;max-width:90vw;overflow:auto;padding:18px';document.body.append(dialog);
  const title=document.createElement('h2');title.id='kin-native-toolbar-title';title.textContent='Image Toolbar';dialog.append(title);
  const hint=document.createElement('p');hint.textContent='표시할 도구와 순서를 정한 뒤 적용하세요. 숨겨도 현재 조작은 바뀌지 않습니다. 확대·축소는 키보드 진입을 위해 유지합니다.';hint.style.maxWidth='560px';dialog.append(hint);
  const rows=document.createElement('div');rows.id='kin-native-toolbar-rows';dialog.append(rows);
  const action=(id,text,fn)=>{const b=document.createElement('button');b.type='button';b.id=id;b.textContent=text;b.style.cssText='margin:6px;padding:6px;border:1px solid #718eaa';b.onclick=fn;dialog.append(b);return b;};
  function close(){dialog.close();if(opener?.isConnected&&!opener.disabled&&opener.getClientRects().length)opener.focus({preventScroll:true});}
  function render(focus){
    rows.replaceChildren();
    draft.order.forEach((id,index)=>{
      const row=document.createElement('div');row.dataset.tool=id;row.style.cssText='display:flex;gap:8px;align-items:center;margin:6px 0';rows.append(row);
      const label=document.createElement('label');label.style.cssText='flex:1;min-width:170px';const check=document.createElement('input');check.type='checkbox';check.checked=!draft.hidden.includes(id);check.disabled=id==='Zoom';check.setAttribute('aria-label','Show '+labels[id]);label.append(check,document.createTextNode(' '+labels[id]));row.append(label);
      check.onchange=()=>{draft.hidden=draft.hidden.filter(x=>x!==id);if(!check.checked)draft.hidden.push(id);};
      for(const [step,text] of [[-1,'Move Up'],[1,'Move Down']]){
        const b=document.createElement('button');b.type='button';b.textContent=text;b.dataset.move=String(step);b.setAttribute('aria-label',labels[id]+' '+text);b.disabled=index+step<0||index+step>=draft.order.length;b.style.cssText='padding:4px;border:1px solid #718eaa';row.append(b);
        b.onclick=()=>{const next=index+step;if(next<0||next>=draft.order.length)return;[draft.order[index],draft.order[next]]=[draft.order[next],draft.order[index]];render({id,step});};
      }
    });
    if(focus){const row=rows.querySelector('[data-tool="'+focus.id+'"]');(row.querySelector('[data-move="'+focus.step+'"]:not(:disabled)')||row.querySelector('[data-move]:not(:disabled)'))?.focus();}
  }
  function write(next){
    // Detect another extension changing the section; never overwrite its state.
    if(!same(read(),applied)){suspended=true;status.textContent='도구 모음이 변경되었습니다. 영상을 다시 연 뒤 편집하세요.';return false;}
    const section=next.order.filter(id=>!next.hidden.includes(id)),before=applied.slice();
    applying=true;
    try{service.clearButtonSection('primary');service.createButtonSection('primary',section.slice());if(!same(read(),section))throw Error('section mismatch');applied=section;current=next;return true;}
    catch(_){try{service.clearButtonSection('primary');service.createButtonSection('primary',before);}catch(_){}suspended=true;status.textContent='도구 모음을 적용하지 못했습니다. 영상을 다시 열어 확인하세요.';return false;}
    finally{applying=false;}
  }
  action('kin-native-toolbar-default','Reset to Default',()=>{draft=defaults();render();});
  action('kin-native-toolbar-apply','Apply',()=>{
    if(!live()||suspended){status.textContent='현재 영상과 계정을 확인한 뒤 다시 여세요.';close();return;}
    const next=normalize(draft);if(!next||!write(next))return;
    persist();
    close();
  });
  action('kin-native-toolbar-cancel','Cancel',close);
  dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  // The viewer's document hotkeys otherwise consume Escape and may operate
  // on the image while a native settings dialog has keyboard focus.
  dialog.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'&&!e.isComposing){e.preventDefault();close();}},true);
  for(const event of ['keyup','keypress'])dialog.addEventListener(event,e=>e.stopPropagation(),true);
  button.onclick=()=>{if(!live()||suspended||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show'))return;opener=document.activeElement;draft=normalize(current);render();dialog.showModal();};
  let subscription;
  function end(){
    if(ended)return;ended=true;subscription?.unsubscribe();window.removeEventListener('storage',storage);channel?.close();
    if(window.kinViewerToolbarPreferences===controller)delete window.kinViewerToolbarPreferences;
    if(same(read(),applied)&&!same(applied,baseline)){applying=true;try{service.clearButtonSection('primary');service.createButtonSection('primary',baseline.slice());}catch(_){}finally{applying=false;}}
    dialog.remove();box.remove();
  }
  function storage(e){if(e.key==='kin-session-ended')end();else if(e.key===key){let matches=false;try{matches=e.newValue?.length<=2048&&same(normalize(JSON.parse(e.newValue)),current);}catch(_){}if(!matches)status.textContent='다른 창의 도구 설정 변경 · 현재 창 유지';}}
  try{const raw=localStorage.getItem(key);if(raw!==null){const value=raw.length<=2048?normalize(JSON.parse(raw)):null;if(value){if(write(value))status.textContent='기억한 도구 모음 · 이 브라우저';}else status.textContent='저장값 오류 · 기본 도구 모음';}}catch(_){status.textContent='저장소 사용 불가 · 이 창';}
  subscription=service.subscribe(service.EVENTS.TOOL_BAR_MODIFIED,()=>{if(!ended&&!applying&&!same(read(),applied)){suspended=true;button.disabled=true;status.textContent='도구 모음이 변경되었습니다. 영상을 다시 연 뒤 편집하세요.';}});
  window.addEventListener('storage',storage);
  try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
  const canApply=next=>live()&&!suspended&&!dialog.open&&!!normalize(next)&&same(read(),applied);
  const controller={dispose:end,preference:()=>ended?null:normalize(current),canApply,
    applyPreference:next=>{if(!canApply(next)||!write(normalize(next)))return false;persist();return true;}};
  window.kinViewerToolbarPreferences=controller;notify('mounted');return controller;
};

/* Viewer study bridge: verified loaded source identity, never URL-first guessing. */
window.kinViewerTechNote=function(services){
  let stop=()=>{};
  function mount(){
    stop();
    const search=location.search,query=new URLSearchParams(search),values=query.getAll('StudyInstanceUIDs'),studies=values.length===1?values[0].split(','):[];
    if(!studies.length||studies.length>2||new Set(studies).size!==studies.length||studies.some(uid=>uid.length>64||!/^\d+(?:\.\d+)+$/.test(uid)))return;
    let ended=false,busy=false,owner=null,channel,dock,windowLink;const requests=new Set();
    const live=()=>!ended&&location.search===search;
    const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    const text=v=>v&&typeof v==='object'?String(v.Alphabetic??v.Ideographic??v.Phonetic??''):String(v??'');
    function selectedStack(viewportId){
      if(!live())return null;
      try{
        const grid=services.viewportGridService.getState(),id=viewportId??grid.activeViewportId,cell=grid.viewports.get(id),ids=cell?.displaySetInstanceUIDs;
        const viewport=services.cornerstoneViewportService.getCornerstoneViewport(id),image=viewport?.type==='stack'&&viewport.getCurrentImageId?.();
        const match=typeof image==='string'&&image.match(/\/studies\/([0-9.]+)\/series\/([0-9.]+)\/instances\/([0-9.]+)\/frames\/([1-9][0-9]*)(?:$|[?#])/);
        if(!match||ids?.length!==1||!studies.includes(match[1]))return null;
        const ds=services.displaySetService.getDisplaySetByUID(ids[0]);if(ds?.StudyInstanceUID!==match[1]||ds.SeriesInstanceUID!==match[2])return null;
        return {viewportId:id,uid:match[1],series:match[2],sop:match[3],image,study:{uid:match[1],name:text(ds.PatientName),id:text(ds.PatientID),date:text(ds.StudyDate),desc:text(ds.StudyDescription||ds.SeriesDescription)}};
      }catch(_){return null;}
    }
    // Reconstructed planes need not coincide with any original slice. Resolve
    // source identity from every image of one loaded volume. The clipboard needs
    // a verified source instance; study-level actions must not call it a plane.
    function selectedCopy(viewportId){
      const stack=selectedStack(viewportId);if(stack)return stack;
      if(!live())return null;
      try{
        const core=window.cornerstone,events=core?.Enums?.Events;
        if(!events?.VOLUME_NEW_IMAGE||!events.CAMERA_MODIFIED)return null;
        const grid=services.viewportGridService.getState(),id=viewportId??grid.activeViewportId,cell=grid.viewports.get(id),sets=cell?.displaySetInstanceUIDs;
        const v=services.cornerstoneViewportService.getCornerstoneViewport(id);
        if(!['orthographic','volume3d'].includes(v?.type)||sets?.length!==1)return null;
        const actors=v.getActors(),volumeId=v.getVolumeId();
        if(actors.length!==1||(actors[0].referencedId||actors[0].uid)!==volumeId)return null;
        const volume=core.cache.getVolume(volumeId),images=volume?.imageIds,ds=services.displaySetService.getDisplaySetByUID(sets[0]);
        if(!volume?.loadStatus?.loaded||volume.loadStatus.loading||volume.loadStatus.cancelled||!Array.isArray(images)||!images.length||!studies.includes(ds?.StudyInstanceUID))return null;
        // Streaming marks "loaded" after processing even failed requests.
        // Patient copy requires all original frames to have loaded successfully.
        if(volume.framesLoaded!==images.length||volume.totalNumFrames!==images.length)return null;
        let first,identity;
        for(const image of images){
          const ref=typeof image==='string'&&image.match(/\/studies\/([0-9.]+)\/series\/([0-9.]+)\/instances\/([0-9.]+)\/frames\/([1-9][0-9]*)(?:$|[?#])/);
          const m=core.metaData.get('instance',image);
          if(!ref||!m||ref[1]!==ds.StudyInstanceUID||ref[2]!==ds.SeriesInstanceUID||m.StudyInstanceUID!==ref[1]||m.SeriesInstanceUID!==ref[2]||m.SOPInstanceUID!==ref[3]||typeof m.PatientID!=='string'||!m.PatientID.trim()||m.PatientID.length>64||(ds.PatientID&&text(ds.PatientID)!==m.PatientID))return null;
          const value=JSON.stringify([m.PatientID,text(m.PatientName),text(m.StudyDate)]);
          if(identity&&identity!==value)return null;
          identity=value;first||={viewportId:id,uid:ref[1],series:ref[2],sop:ref[3],image,study:{uid:ref[1],id:m.PatientID,name:text(m.PatientName),date:text(m.StudyDate)}};
        }
        return {...first,sourceSignature:JSON.stringify([volumeId,images])};
      }catch(_){return null;}
    }
    let studyEpoch=0,studySignature='',studyContext='',nextStudyVolume=0;
    const studyVolumeIds=new WeakMap();
    function observeStudyContext(){
      let signature='',volume=null;
      try{
        if(live()){
          const grid=services.viewportGridService.getState(),id=grid.activeViewportId,cell=grid.viewports.get(id),v=services.cornerstoneViewportService.getCornerstoneViewport(id);
          const volumeId=['orthographic','volume3d'].includes(v?.type)?v.getVolumeId():null;
          volume=volumeId?window.cornerstone?.cache.getVolume(volumeId):null;
          // Observe replacement without retaining evicted volume pixel buffers.
          if(volume&&!studyVolumeIds.has(volume))studyVolumeIds.set(volume,++nextStudyVolume);
          signature=JSON.stringify([id,v?.type,cell?.displaySetInstanceUIDs,volumeId,volume?studyVolumeIds.get(volume):null,volumeId?v.getActors().map(a=>a.referencedId||a.uid):null,
            volume?.imageIds?.length,volume?.framesLoaded,volume?.loadStatus?.loaded,volume?.loadStatus?.loading,volume?.loadStatus?.cancelled]);
        }
      }catch(_){}
      if(signature!==studyContext){studyContext=signature;studyEpoch++;}
    }
    function selectedStudy(){
      observeStudyContext();
      const source=selectedCopy();let target=source;
      if(source?.sourceSignature){
        const {viewportId,uid,series,study,sourceSignature}=source;
        target={viewportId,uid,series,study,sourceSignature,kind:'volume'};
      }
      // Study actions survive slice scrolling and camera changes within the
      // verified source context, while viewport/study/source replacement cancels.
      const signature=target?JSON.stringify([target.viewportId,target.uid,target.series,target.study,target.sourceSignature]):'';
      if(signature!==studySignature){studySignature=signature;studyEpoch++;}
      return target?{...target,selectionEpoch:studyEpoch}:null;
    }
    // Focus the pinned viewer's real button; entering the toolbar must not
    // select a tool, invoke a command or change the active viewport.
    const nativeFocusStyle=document.createElement('style');
    nativeFocusStyle.textContent='#root button[data-cy]:focus-visible { outline: 2px solid #facc15 !important; outline-offset: 2px; }';
    document.head.append(nativeFocusStyle);
    const nativeLabels=new Map();
    function focusNativeToolbar(){
      if(!live()||window.top===window&&!owner||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show'))return false;
      const targets=[...document.querySelectorAll('#root button[data-cy="Zoom"]')].filter(b=>!b.disabled&&b.getAttribute('aria-disabled')!=='true'&&b.getClientRects().length&&!b.closest('[inert],[hidden],[aria-hidden="true"]')&&getComputedStyle(b).visibility==='visible');
      if(targets.length!==1)return false;
      const target=targets[0];
      if(!target.hasAttribute('aria-label')){target.setAttribute('aria-label','Zoom');nativeLabels.set(target,'Zoom');}
      target.focus({preventScroll:true});target.scrollIntoView({block:'nearest',inline:'nearest'});
      return document.activeElement===target;
    }
    window.kinViewerFocusNativeToolbar=focusNativeToolbar;
    function disposeNativeFocus(){
      if(window.kinViewerFocusNativeToolbar===focusNativeToolbar)delete window.kinViewerFocusNativeToolbar;
      nativeFocusStyle.remove();
      for(const [target,label] of nativeLabels)if(target.getAttribute('aria-label')===label)target.removeAttribute('aria-label');
      nativeLabels.clear();
    }
    if(window.top!==window){
      window.kinViewerSelectedNoteTarget=selectedStudy;
      let patientCopy,toolbarPreferences;
      const enable=options=>{
        if(patientCopy)return true;
        const host=document.querySelector('#kin-viewer-layout');if(!host||typeof options?.owner!=='function'||typeof options?.allowed!=='function')return false;
        let bound,identity;try{bound=options.owner();identity=JSON.parse(bound);}catch(_){return false;}
        if(!Array.isArray(identity)||identity.length!==2||identity.some(v=>typeof v!=='string'||!v))return false;
        const contextLive=()=>{try{return live()&&options.allowed()&&options.owner()===bound;}catch(_){return false;}};
        patientCopy=window.kinCreateViewerPatientCopy({services,selected:selectedCopy,studies,host,owner:()=>identity,live:contextLive,onSelection:event=>event?.contextOnly?observeStudyContext():selectedStudy()});
        toolbarPreferences=window.kinCreateViewerToolbarPreferences({services,host,owner:()=>identity,live:()=>{try{return live()&&options.owner()===bound&&(options.toolbarAllowed||options.allowed)();}catch(_){return false;}}});
        return true;
      };
      window.kinViewerEnablePatientCopy=enable;
      stop=()=>{ended=true;toolbarPreferences?.dispose();disposeNativeFocus();patientCopy?.dispose();if(window.kinViewerSelectedNoteTarget===selectedStudy)delete window.kinViewerSelectedNoteTarget;if(window.kinViewerEnablePatientCopy===enable)delete window.kinViewerEnablePatientCopy;};
      return true;
    }
    const host=document.querySelector('#kin-viewer-layout');if(!host){disposeNativeFocus();return;}
    let toolbarPreferences;
    const panel=document.createElement('section');panel.id='kin-viewer-tech-note';
    const button=document.createElement('button');button.id='kin-viewer-note-open';button.type='button';button.textContent='Tech Note';button.setAttribute('aria-keyshortcuts','Control+Alt+6');button.style.cssText='border:1px solid #718eaa;padding:5px;margin:4px 0';
    const retry=document.createElement('button');retry.id='kin-viewer-note-retry';retry.type='button';retry.textContent='Retry Connection';retry.hidden=true;
    const status=document.createElement('p');status.id='kin-viewer-note-status';status.setAttribute('role','status');panel.append(button,retry,status);host.append(panel);
    const arrange=document.createElement('button');arrange.id='kin-viewer-dock-enable';arrange.type='button';arrange.textContent='Open Tools';panel.prepend(arrange);
    function arrangeTools(){
      if(!live()||!owner)return;
      dock=window.KinViewerWorkspaceDock?.(window,{owner:()=>owner&&JSON.stringify(owner),allowed:()=>live()&&!!owner});
      if(dock){arrange.hidden=true;dock.querySelector('nav').append(returnStatus);}
      else status.textContent='도구 영역을 연결하지 못했습니다. 다시 시도하세요.';
    }
    arrange.onclick=()=>{arrangeTools();const tab=dock?.querySelector('nav button[aria-controls="kin-viewer-layout"]');if(tab){if(tab.getAttribute('aria-expanded')!=='true')tab.click();tab.focus({preventScroll:true});}};
    const toolBar=document.createElement('div');toolBar.id='kin-viewer-tool-focus';panel.prepend(toolBar);
    const toolButtons=new Map();
    for(const [code,label] of [['Digit7','Focus Measurements'],['Digit8','Focus Comparison'],['Digit9','Image Tools'],['Digit2','Active Image'],['Digit4','Return to Report']]){
      const b=document.createElement('button');b.type='button';b.textContent=label;b.id='kin-viewer-focus-'+code.slice(-1);b.setAttribute('aria-keyshortcuts','Control+Alt+'+code.slice(-1));b.style.cssText='border:1px solid #718eaa;padding:5px;margin:4px';b.onclick=()=>focusTool(code);toolBar.append(b);toolButtons.set(code,b);
    }
    let shortcutMap=null;
    const shortcutActions={image:'Digit2',report:'Digit4',note:'Digit6',tools:'Digit7',nativeTools:'Digit9'};
    const toolHint=document.createElement('p');toolHint.textContent='Ctrl+Alt+7 측정 도구 · 8 비교 작업 도구 · 9 기본 영상 도구 (Tab 이동·Enter 선택) · 2 선택 영상 · 4 판독문으로';toolBar.append(toolHint);
    const returnStatus=document.createElement('span');returnStatus.id='kin-viewer-return-status';returnStatus.setAttribute('role','status');returnStatus.style.cssText='display:inline-block;margin-left:8px;font-size:12px';(host.querySelector(':scope > summary')||toolBar).append(returnStatus);
    let readingChannel=null,pendingReturn=null,returnTimer=null,returnEpoch=0,returnSignature='';
    function refreshReturnSelection(event){
      // Camera events must not walk thousands of source images. Keep immediate
      // context ABA detection; polls and explicit actions still verify every source.
      if(event?.contextOnly){const before=studyEpoch;observeStudyContext();if(before!==studyEpoch)returnEpoch++;return;}
      const current=selectedStudy(),signature=current?JSON.stringify([current.viewportId,current.uid,current.selectionEpoch]):'';if(signature!==returnSignature){returnSignature=signature;returnEpoch++;}
    }
    function finishReturn(message){clearTimeout(returnTimer);returnTimer=null;pendingReturn=null;returnStatus.textContent=message;refresh();if(returnStatus.getClientRects().length)returnStatus.scrollIntoView({block:'nearest',inline:'nearest'});}
    function bindReturn(){
      const cancelled=!!pendingReturn;readingChannel?.close();readingChannel=null;clearTimeout(returnTimer);returnTimer=null;pendingReturn=null;
      if(!live())return;
      const params=new URLSearchParams(location.hash.slice(1)),tokens=params.getAll('kin-reading-return'),token=tokens.length===1?tokens[0]:'';
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)){returnStatus.textContent='판독 화면의 영상 새 창으로 열면 돌아갈 수 있습니다.';refresh();return;}
      try{
        readingChannel=new BroadcastChannel('kin-reading-return:'+token);
        readingChannel.onmessage=e=>{
          const m=e.data,p=pendingReturn;if(!p||m?.type!=='result'||m.request!==p.request)return;
          refreshReturnSelection();
          if(!live()||JSON.stringify(owner)!==p.owner||returnEpoch!==p.epoch){finishReturn('영상 선택이나 세션이 바뀌어 복귀 결과를 적용하지 않았습니다.');return;}
          const messages={focused:'판독문으로 돌아왔습니다.',ready:'판독문 위치를 준비했습니다. 목록 창을 선택하세요.',session:'세션이 바뀌었습니다. 판독 화면에서 다시 연결하세요.',context:'판독 대상이나 화면이 바뀌었습니다. 목록 창에서 확인하세요.',modal:'판독 화면의 대화상자를 닫은 뒤 다시 시도하세요.',unavailable:'판독문 입력란을 확인한 뒤 다시 시도하세요.'};
          if(Object.hasOwn(messages,m.result))finishReturn(messages[m.result]);
        };
        returnStatus.textContent=cancelled?'이전 복귀 요청은 취소되었습니다. 다시 눌러 돌아가세요.':'연결된 판독문으로 · '+(shortcutMap?window.KinWorkspaceShortcuts.display(shortcutMap.report):'Control+Alt+4');
      }catch(_){returnStatus.textContent='이 브라우저에서 창 연결을 사용할 수 없습니다. 목록 창을 직접 선택하세요.';}
      refresh();
    }
    function returnToReading(){
      if(!live()||!owner||!patientCopy.tracked()||!readingChannel||pendingReturn||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show'))return;
      const current=selectedStudy();if(!current){returnStatus.textContent='원본 검사가 확인되는 영상 칸을 선택한 뒤 돌아가세요.';return;}
      refreshReturnSelection();const request=crypto.randomUUID();pendingReturn={request,owner:JSON.stringify(owner),epoch:returnEpoch};returnStatus.textContent='판독 화면에 복귀 요청 중…';refresh();
      try{readingChannel.postMessage({type:'request',request,owner:pendingReturn.owner,studies,activeUid:current.uid});returnTimer=setTimeout(()=>finishReturn('판독 화면의 응답이 없습니다. 목록 창에서 영상 새 창을 다시 눌러 연결하세요.'),2500);}
      catch(_){finishReturn('판독 화면 연결을 확인하지 못했습니다. 목록 창을 직접 선택하세요.');}
    }
    const patientCopy=window.kinCreateViewerPatientCopy({services,selected:selectedCopy,studies,owner:()=>owner,live,host:toolBar,onSelection:refreshReturnSelection});
    function focusTool(code){
      if(code==='Digit4'){returnToReading();return;}
      if(!live()||!owner||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show'))return;
      if(code==='Digit9'){if(!focusNativeToolbar())status.textContent='기본 영상 도구 연결을 확인한 뒤 이동하세요.';return;}
      const current=selectedStudy();if(!current){status.textContent='원본 검사가 확인되는 영상 칸을 선택한 뒤 도구로 이동하세요.';return;}
      let target;
      try{const id=code==='Digit7'?'kin-viewer-history':'kin-viewer-layout';target=code==='Digit2'?services.cornerstoneViewportService.getCornerstoneViewport(current.viewportId)?.element:document.querySelector('#kin-workspace-dock nav button[aria-controls="'+id+'"]')||document.querySelector('#'+id+' > summary');}catch(_){}
      if(!target||!target.isConnected||!target.getClientRects().length||target.closest('[inert]')){status.textContent='영상 도구 연결을 확인한 뒤 이동하세요.';return;}
      if(code==='Digit2'&&!target.hasAttribute('tabindex'))target.tabIndex=-1;
      target.focus({preventScroll:true});target.scrollIntoView({block:'nearest'});
    }
    function refresh(){button.disabled=!live()||busy||!owner;arrange.disabled=!live()||!owner;retry.disabled=!live()||busy;for(const [code,b] of toolButtons){b.disabled=!live()||!owner||(code==='Digit4'&&(!readingChannel||!patientCopy.tracked()));if(code==='Digit4'){b.setAttribute('aria-busy',String(!!pendingReturn));b.setAttribute('aria-disabled',String(b.disabled||!!pendingReturn));}}patientCopy.refresh();}
    function end(){if(ended)return;ended=true;windowLink?.dispose();owner=null;toolbarPreferences?.dispose();disposeNativeFocus();patientCopy.end();readingChannel?.close();readingChannel=null;clearTimeout(returnTimer);returnTimer=null;pendingReturn=null;returnStatus.textContent='세션이나 영상 창이 변경되었습니다.';window.removeEventListener('hashchange',bindReturn);window.removeEventListener('kin-reading-link-changed',bindReturn);dock?.end();for(const c of requests)c.abort();note.dispose();refresh();status.textContent='세션이나 영상창이 변경되었습니다. 뷰어를 새로 여세요.';}
    async function raw(method,path,body){
      if(!live())throw new Error('영상창이 변경되었습니다');
      const controller=new AbortController();requests.add(controller);const timer=setTimeout(()=>controller.abort(),12000);
      try{const r=await fetch('/api'+path,{method,credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'X-KIN-CSRF':'1',...(owner?{'X-KIN-Subject':owner[1],'X-KIN-Institution':owner[0]}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
        if(!live())throw new Error('영상창이 변경되었습니다');
        if([401,403].includes(r.status)){end();throw new Error('메모 계정 또는 접근 권한을 확인하세요');}
        const value=await r.json().catch(()=>null);if(!r.ok||!value)throw Object.assign(new Error(typeof value?.message==='string'?value.message:'서버 응답을 확인하세요'),{status:r.status});return value;
      }finally{clearTimeout(timer);requests.delete(controller);}
    }
    async function authenticate(){const me=await raw('GET','/me');const next=[me.institution,me.sub];if(me.kind!=='member'||next.some(v=>typeof v!=='string'||!v)||owner&&!same(owner,next)){end();throw new Error('메모 계정이 변경되었습니다');}owner=next;return next;}
    const note=KinTechNote({allowed:()=>live()&&!!owner,api:async(method,path,body)=>{const before=await authenticate();const result=await raw(method,path,body);if(!live()||!same(before,await authenticate()))throw new Error('메모 계정이 변경되었습니다');return result;}});
    async function open(){
      if(!live()||busy||!owner||document.querySelector('dialog[open]'))return;
      const focus=document.activeElement,target=selectedStudy();if(!target){status.textContent='원본 검사가 확인되는 영상 칸을 선택하세요. 메모 대상을 확인할 수 없습니다.';return;}
      busy=true;refresh();
      try{await authenticate();const current=selectedStudy();if(!live()||!current||target.uid!==current.uid||target.viewportId!==current.viewportId||target.selectionEpoch!==current.selectionEpoch)throw new Error('선택 영상이 바뀌었습니다. 대상을 확인하고 다시 누르세요');busy=false;refresh();if(focus?.isConnected)focus.focus({preventScroll:true});note.open(target.study);status.textContent=(target.kind==='volume'?'볼륨 원본 검사 메모 · ':'메모 대상 검사 · ')+target.uid;}
      catch(e){if(live())status.textContent=e.message;}finally{busy=false;refresh();}
    }
    function bindShortcuts(){
      if(shortcutMap||!owner)return;
      const api=window.KinWorkspaceShortcuts;
      let storage;try{storage=window.localStorage;}catch(_){}
      shortcutMap=api.read(storage,JSON.stringify(owner));
      if(readingChannel&&!pendingReturn)returnStatus.textContent='연결된 판독문으로 · '+api.display(shortcutMap.report);
      for(const [action,code] of Object.entries(shortcutActions)){
        const target=action==='note'?button:toolButtons.get(code);
        target.setAttribute('aria-keyshortcuts',api.display(shortcutMap[action]));
      }
      toolHint.textContent=Object.entries(shortcutActions).map(([action,code])=>(action==='note'?button:toolButtons.get(code)).textContent+' '+api.display(shortcutMap[action])).join(' · ')+' · Focus Comparison Control+Alt+8 (Tab 이동·Enter 선택)';
    }
    const key=e=>{
      if(!live()||!owner||!shortcutMap||e.defaultPrevented||e.repeat||e.isComposing||e.getModifierState('AltGraph')||!e.ctrlKey||!e.altKey||e.shiftKey||e.metaKey||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show'))return;
      const action=window.KinWorkspaceShortcuts.action(shortcutMap,e);
      const code=e.code==='Digit8'?'Digit8':shortcutActions[action];
      if(!code)return;
      e.preventDefault();if(code==='Digit6')open();else focusTool(code);
    };
    button.onclick=open;document.addEventListener('keydown',key);
    const storage=e=>{if(e.key==='kin-session-ended')end();};window.addEventListener('storage',storage);window.addEventListener('pagehide',end);
    try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
    const timer=setInterval(()=>{if(!live())end();else refreshReturnSelection();},500);
    stop=()=>{end();dock?.dispose();dock=null;clearInterval(timer);document.removeEventListener('keydown',key);window.removeEventListener('storage',storage);window.removeEventListener('pagehide',end);patientCopy.dispose();channel?.close();returnStatus.remove();panel.remove();};
    async function connect(){
      if(!live()||busy)return;
      const restore=document.activeElement===retry;busy=true;refresh();status.textContent='메모 연결 확인 중…';
      try{await authenticate();if(live()){windowLink||=window.KinViewerWindows?.connect({owner:()=>owner,live});toolbarPreferences||=window.kinCreateViewerToolbarPreferences({services,host,owner:()=>owner,live:()=>live()&&!!owner});arrangeTools();bindShortcuts();retry.hidden=true;status.textContent='선택한 영상 칸의 검사 메모 · '+window.KinWorkspaceShortcuts.display(shortcutMap.note);}}
      catch(e){if(live()){retry.hidden=false;status.textContent='메모를 연결하지 못했습니다. 다시 시도하세요.';}}
      finally{busy=false;refresh();if(restore&&live()){const target=retry.hidden?(host.hidden?dock?.querySelector('nav button[aria-controls="kin-viewer-layout"]'):button):retry;target?.focus({preventScroll:true});}}
    }
    window.addEventListener('hashchange',bindReturn);window.addEventListener('kin-reading-link-changed',bindReturn);bindReturn();retry.onclick=connect;connect();
    return true;
  }
  return {mount,stop:()=>stop()};
};
