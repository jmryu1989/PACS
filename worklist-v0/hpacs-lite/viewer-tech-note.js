/* Standalone viewer note bridge: active loaded stack identity, never URL-first guessing. */
window.kinViewerTechNote=function(services){
  let stop=()=>{};
  function mount(){
    stop();
    const search=location.search,query=new URLSearchParams(search),values=query.getAll('StudyInstanceUIDs'),studies=values.length===1?values[0].split(','):[];
    if(!studies.length||studies.length>2||new Set(studies).size!==studies.length||studies.some(uid=>uid.length>64||!/^\d+(?:\.\d+)+$/.test(uid)))return;
    let ended=false,busy=false,owner=null,channel,dock;const requests=new Set();
    const live=()=>!ended&&location.search===search;
    const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    const text=v=>v&&typeof v==='object'?String(v.Alphabetic??v.Ideographic??v.Phonetic??''):String(v??'');
    function selected(){
      if(!live())return null;
      try{
        const grid=services.viewportGridService.getState(),id=grid.activeViewportId,cell=grid.viewports.get(id),ids=cell?.displaySetInstanceUIDs;
        const viewport=services.cornerstoneViewportService.getCornerstoneViewport(id),image=viewport?.type==='stack'&&viewport.getCurrentImageId?.();
        const match=typeof image==='string'&&image.match(/\/studies\/([0-9.]+)\/series\/([0-9.]+)\/instances\/([0-9.]+)\/frames\/([1-9][0-9]*)(?:$|[?#])/);
        if(!match||ids?.length!==1||!studies.includes(match[1]))return null;
        const ds=services.displaySetService.getDisplaySetByUID(ids[0]);if(ds?.StudyInstanceUID!==match[1]||ds.SeriesInstanceUID!==match[2])return null;
        return {viewportId:id,uid:match[1],series:match[2],sop:match[3],image,study:{uid:match[1],name:text(ds.PatientName),id:text(ds.PatientID),date:text(ds.StudyDate),desc:text(ds.StudyDescription||ds.SeriesDescription)}};
      }catch(_){return null;}
    }
    if(window.top!==window){
      window.kinViewerSelectedNoteTarget=selected;
      stop=()=>{ended=true;if(window.kinViewerSelectedNoteTarget===selected)delete window.kinViewerSelectedNoteTarget;};
      return true;
    }
    const host=document.querySelector('#kin-viewer-layout');if(!host)return;
    const panel=document.createElement('section');panel.id='kin-viewer-tech-note';
    const button=document.createElement('button');button.id='kin-viewer-note-open';button.type='button';button.textContent='선택 영상 Tech 메모';button.setAttribute('aria-keyshortcuts','Control+Alt+6');button.style.cssText='border:1px solid #718eaa;padding:5px;margin:4px 0';
    const retry=document.createElement('button');retry.id='kin-viewer-note-retry';retry.type='button';retry.textContent='메모 연결 다시 시도';retry.hidden=true;
    const status=document.createElement('p');status.id='kin-viewer-note-status';status.setAttribute('role','status');panel.append(button,retry,status);host.append(panel);
    const arrange=document.createElement('button');arrange.id='kin-viewer-dock-enable';arrange.type='button';arrange.textContent='도구 영역으로 모으기';panel.prepend(arrange);
    function arrangeTools(){
      if(!live()||!owner)return;
      dock=window.KinViewerWorkspaceDock?.(window,{owner:()=>owner&&JSON.stringify(owner),allowed:()=>live()&&!!owner});
      if(dock){arrange.hidden=true;dock.querySelector('nav').append(returnStatus);}
      else status.textContent='도구 영역을 연결하지 못했습니다. 다시 시도하세요.';
    }
    arrange.onclick=()=>{arrangeTools();const tab=dock?.querySelector('nav button[aria-controls="kin-viewer-layout"]');if(tab){if(tab.getAttribute('aria-expanded')!=='true')tab.click();tab.focus({preventScroll:true});}};
    const toolBar=document.createElement('div');toolBar.id='kin-viewer-tool-focus';panel.prepend(toolBar);
    const toolButtons=new Map();
    for(const [code,label] of [['Digit7','측정 도구로'],['Digit8','비교 작업 도구로'],['Digit2','선택 영상으로'],['Digit4','판독문으로 돌아가기']]){
      const b=document.createElement('button');b.type='button';b.textContent=label;b.id='kin-viewer-focus-'+code.slice(-1);b.setAttribute('aria-keyshortcuts','Control+Alt+'+code.slice(-1));b.style.cssText='border:1px solid #718eaa;padding:5px;margin:4px';b.onclick=()=>focusTool(code);toolBar.append(b);toolButtons.set(code,b);
    }
    const toolHint=document.createElement('p');toolHint.textContent='Ctrl+Alt+7 측정 도구 · 8 비교 작업 도구 · 2 선택 영상 · 4 판독문으로';toolBar.append(toolHint);
    const returnStatus=document.createElement('span');returnStatus.id='kin-viewer-return-status';returnStatus.setAttribute('role','status');returnStatus.style.cssText='display:inline-block;margin-left:8px;font-size:12px';(host.querySelector(':scope > summary')||toolBar).append(returnStatus);
    let readingChannel=null,pendingReturn=null,returnTimer=null,returnEpoch=0,returnSignature='';
    function refreshReturnSelection(){const current=selected(),signature=current?JSON.stringify([current.viewportId,current.image,current.uid]):'';if(signature!==returnSignature){returnSignature=signature;returnEpoch++;}}
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
        returnStatus.textContent=cancelled?'이전 복귀 요청은 취소되었습니다. 다시 눌러 돌아가세요.':'연결된 판독문으로 · Ctrl+Alt+4';
      }catch(_){returnStatus.textContent='이 브라우저에서 창 연결을 사용할 수 없습니다. 목록 창을 직접 선택하세요.';}
      refresh();
    }
    function returnToReading(){
      if(!live()||!owner||!copyTracked||!readingChannel||pendingReturn||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show'))return;
      const current=selected();if(!current){returnStatus.textContent='불러온 스택 영상 칸을 선택한 뒤 돌아가세요.';return;}
      refreshReturnSelection();const request=crypto.randomUUID();pendingReturn={request,owner:JSON.stringify(owner),epoch:returnEpoch};returnStatus.textContent='판독 화면에 복귀 요청 중…';refresh();
      try{readingChannel.postMessage({type:'request',request,owner:pendingReturn.owner,studies,activeUid:current.uid});returnTimer=setTimeout(()=>finishReturn('판독 화면의 응답이 없습니다. 목록 창에서 영상 새 창을 다시 눌러 연결하세요.'),2500);}
      catch(_){finishReturn('판독 화면 연결을 확인하지 못했습니다. 목록 창을 직접 선택하세요.');}
    }
    const copy=document.createElement('button');copy.id='kin-viewer-copy-id';copy.type='button';copy.textContent='선택 영상 환자 ID 복사';copy.setAttribute('aria-keyshortcuts','Control+Alt+C');copy.setAttribute('aria-describedby','kin-viewer-copy-context');toolBar.append(copy);
    const copyContext=document.createElement('p');copyContext.id='kin-viewer-copy-context';toolBar.append(copyContext);
    const copyStatus=document.createElement('p');copyStatus.id='kin-viewer-copy-status';copyStatus.setAttribute('role','status');toolBar.append(copyStatus);
    let copyBusy=false,copyEpoch=0,copySignature='',copyTracked=false,copyMenuOpen=false,restoreCopyMenu=()=>{};
    function copyTarget(){
      if(!live()||!owner||!copyTracked)return null;
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
      const current=copyTarget(),signature=current?JSON.stringify([current.viewportId,current.uid,current.image,current.patientId]):'';
      if(signature!==copySignature){copySignature=signature;copyEpoch++;copyStatus.textContent='';}
      copy.disabled=!current;copy.setAttribute('aria-disabled',String(!current||copyBusy));copy.setAttribute('aria-busy',String(copyBusy));
      copyContext.textContent=current?'선택 영상'+' · '+current.study.name+' ('+current.patientId+') · '+current.study.date+' · 검사 '+current.uid:'환자 ID가 확인되는 스택 영상 칸을 선택하세요.';
    }
    async function copyPatientId(expected=null){
      refreshCopy();const current=copyTarget();
      const announce=message=>{copyStatus.textContent=message;if(expected)services.uiNotificationService?.show({title:'환자 ID 복사',message,type:'info'});};
      if(expected&&(expected.epoch!==copyEpoch||expected.signature!==copySignature||expected.owner!==JSON.stringify(owner))){if(live())announce('영상 선택이나 세션이 바뀌었습니다. 메뉴를 다시 열어 대상을 확인하세요.');return;}
      if(!current||copyBusy||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show'))return;
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
    const copyChanged=()=>{copyEpoch++;refreshReturnSelection();copyStatus.textContent='';refreshCopy();};
    const copySubscriptions=[];const copyStackEvent=window.cornerstone?.Enums?.Events?.STACK_NEW_IMAGE;
    try{
      const grid=services.viewportGridService,events=Object.values(grid.EVENTS);
      if(!copyStackEvent||!events.length)throw new Error('image observation unavailable');
      for(const event of new Set(events))copySubscriptions.push(grid.subscribe(event,copyChanged));
      document.addEventListener(copyStackEvent,copyChanged,true);copyTracked=true;
    }catch(_){copySubscriptions.forEach(s=>s.unsubscribe());copySubscriptions.length=0;}
    // The pinned tools do not emit the measurement-menu command on blank
    // right clicks. Use the DOM gesture, but leave nearby annotations untouched.
    const menuCommands=services.customizationService?.commandsManager;
    let copyGesture=null;
    const copyMenuTarget=e=>{
      refreshCopy();const current=copyTarget(),element=current&&services.cornerstoneViewportService.getCornerstoneViewport(current.viewportId)?.element;
      if(!current||!element?.contains(e.target)||copyBusy||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show'))return null;
      const canvas=element.querySelector('canvas');if(!canvas)return null;
      const bounds=canvas.getBoundingClientRect(),xy=[e.clientX-bounds.left,e.clientY-bounds.top];
      try{if(!menuCommands?.getCommand('getNearbyToolData','CORNERSTONE')||menuCommands.runCommand('getNearbyToolData',{element,canvasCoordinates:xy},'CORNERSTONE'))return;}catch(_){return;}
      return {current,element};
    };
    const showCopyMenu=e=>{
      const target=copyMenuTarget(e);if(!target)return;
      const {current,element}=target;
      const expected={epoch:copyEpoch,signature:copySignature,owner:JSON.stringify(owner)};
      e.preventDefault();copyMenuOpen=true;
      try{menuCommands.runCommand('showContextMenu',{event:{detail:{element,currentPoints:{client:[e.clientX,e.clientY]}}},element,menuId:'kin-patient-copy',menus:[{id:'kin-patient-copy',items:[{
        label:'환자 ID 복사 · '+current.patientId+' · '+current.study.date,
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
    function focusTool(code){
      if(code==='Digit4'){returnToReading();return;}
      if(!live()||!owner||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show'))return;
      const current=selected();if(!current){status.textContent='불러온 스택 영상 칸을 선택한 뒤 도구로 이동하세요.';return;}
      let target;
      try{const id=code==='Digit7'?'kin-viewer-history':'kin-viewer-layout';target=code==='Digit2'?services.cornerstoneViewportService.getCornerstoneViewport(current.viewportId)?.element:document.querySelector('#kin-workspace-dock nav button[aria-controls="'+id+'"]')||document.querySelector('#'+id+' > summary');}catch(_){}
      if(!target||!target.isConnected||!target.getClientRects().length||target.closest('[inert]')){status.textContent='영상 도구 연결을 확인한 뒤 이동하세요.';return;}
      if(code==='Digit2'&&!target.hasAttribute('tabindex'))target.tabIndex=-1;
      target.focus({preventScroll:true});target.scrollIntoView({block:'nearest'});
    }
    function refresh(){button.disabled=!live()||busy||!owner;arrange.disabled=!live()||!owner;retry.disabled=!live()||busy;for(const [code,b] of toolButtons){b.disabled=!live()||!owner||(code==='Digit4'&&(!readingChannel||!copyTracked));if(code==='Digit4'){b.setAttribute('aria-busy',String(!!pendingReturn));b.setAttribute('aria-disabled',String(b.disabled||!!pendingReturn));}}refreshCopy();}
    function end(){if(ended)return;ended=true;owner=null;restoreCopyMenu();readingChannel?.close();readingChannel=null;clearTimeout(returnTimer);returnTimer=null;pendingReturn=null;returnStatus.textContent='세션이나 영상 창이 변경되었습니다.';window.removeEventListener('hashchange',bindReturn);window.removeEventListener('kin-reading-link-changed',bindReturn);dock?.end();for(const c of requests)c.abort();note.dispose();refresh();status.textContent='세션이나 영상창이 변경되었습니다. 뷰어를 새로 여세요.';}
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
      const focus=document.activeElement,target=selected();if(!target){status.textContent='불러온 스택 영상 칸을 선택하세요. 메모 대상을 확인할 수 없습니다.';return;}
      busy=true;refresh();
      try{await authenticate();const current=selected();if(!live()||!current||target.uid!==current.uid||target.viewportId!==current.viewportId)throw new Error('선택 영상이 바뀌었습니다. 대상을 확인하고 다시 누르세요');busy=false;refresh();if(focus?.isConnected)focus.focus({preventScroll:true});note.open(target.study);status.textContent='메모 대상 검사 · '+target.uid;}
      catch(e){if(live())status.textContent=e.message;}finally{busy=false;refresh();}
    }
    const key=e=>{if(e.defaultPrevented||e.repeat||e.isComposing||e.getModifierState('AltGraph')||!e.ctrlKey||!e.altKey||e.shiftKey||e.metaKey||!['KeyC','Digit6',...toolButtons.keys()].includes(e.code)||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]'))return;
      if(e.code==='KeyC'&&e.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'))return;
      e.preventDefault();if(e.code==='KeyC')copyPatientId();else if(e.code==='Digit6')open();else focusTool(e.code);};
    button.onclick=open;document.addEventListener('keydown',key);
    const storage=e=>{if(e.key==='kin-session-ended')end();};window.addEventListener('storage',storage);window.addEventListener('pagehide',end);
    try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
    const timer=setInterval(()=>{if(!live())end();else{refreshReturnSelection();refreshCopy();}},500);
    stop=()=>{end();dock?.dispose();dock=null;clearInterval(timer);document.removeEventListener('keydown',key);window.removeEventListener('storage',storage);window.removeEventListener('pagehide',end);if(copyStackEvent)document.removeEventListener(copyStackEvent,copyChanged,true);copySubscriptions.forEach(s=>s.unsubscribe());channel?.close();returnStatus.remove();panel.remove();};
    async function connect(){
      if(!live()||busy)return;
      const restore=document.activeElement===retry;busy=true;refresh();status.textContent='메모 연결 확인 중…';
      try{await authenticate();if(live()){let remembered=false;try{const raw=localStorage.getItem('kin-viewer-dock:v1:'+JSON.stringify(owner));remembered=raw!==null&&raw.length<=128&&!!window.KinViewerWorkspaceDock?.normalize(JSON.parse(raw));}catch(_){}if(remembered)arrangeTools();retry.hidden=true;status.textContent='선택한 영상 칸의 검사 메모 · Ctrl+Alt+6';}}
      catch(e){if(live()){retry.hidden=false;status.textContent='메모를 연결하지 못했습니다. 다시 시도하세요.';}}
      finally{busy=false;refresh();if(restore&&live()){const target=retry.hidden?(host.hidden?dock?.querySelector('nav button[aria-controls="kin-viewer-layout"]'):button):retry;target?.focus({preventScroll:true});}}
    }
    window.addEventListener('hashchange',bindReturn);window.addEventListener('kin-reading-link-changed',bindReturn);bindReturn();retry.onclick=connect;connect();
    return true;
  }
  return {mount,stop:()=>stop()};
};
