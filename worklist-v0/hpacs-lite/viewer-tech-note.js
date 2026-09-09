/* Standalone viewer note bridge: active loaded stack identity, never URL-first guessing. */
window.kinViewerTechNote=function(services){
  let stop=()=>{};
  function mount(){
    stop();
    const search=location.search,query=new URLSearchParams(search),values=query.getAll('StudyInstanceUIDs'),studies=values.length===1?values[0].split(','):[];
    if(!studies.length||studies.length>2||new Set(studies).size!==studies.length||studies.some(uid=>uid.length>64||!/^\d+(?:\.\d+)+$/.test(uid)))return;
    let ended=false,busy=false,owner=null,channel;const requests=new Set();
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
        return {viewportId:id,uid:match[1],study:{uid:match[1],name:text(ds.PatientName),id:text(ds.PatientID),date:text(ds.StudyDate),desc:text(ds.StudyDescription||ds.SeriesDescription)}};
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
    const toolBar=document.createElement('div');toolBar.id='kin-viewer-tool-focus';panel.prepend(toolBar);
    const toolButtons=new Map();
    for(const [code,label] of [['Digit7','측정 도구로'],['Digit8','비교 작업 도구로'],['Digit2','선택 영상으로']]){
      const b=document.createElement('button');b.type='button';b.textContent=label;b.id='kin-viewer-focus-'+code.slice(-1);b.setAttribute('aria-keyshortcuts','Control+Alt+'+code.slice(-1));b.style.cssText='border:1px solid #718eaa;padding:5px;margin:4px';b.onclick=()=>focusTool(code);toolBar.append(b);toolButtons.set(code,b);
    }
    const toolHint=document.createElement('p');toolHint.textContent='Ctrl+Alt+7 측정 도구 · 8 비교 작업 도구 · 2 선택 영상';toolBar.append(toolHint);
    function focusTool(code){
      if(!live()||!owner||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show'))return;
      const current=selected();if(!current){status.textContent='불러온 스택 영상 칸을 선택한 뒤 도구로 이동하세요.';return;}
      let target;
      try{target=code==='Digit2'?services.cornerstoneViewportService.getCornerstoneViewport(current.viewportId)?.element:document.querySelector(code==='Digit7'?'#kin-viewer-history > summary':'#kin-viewer-layout > summary');}catch(_){}
      if(!target||!target.isConnected||!target.getClientRects().length||target.closest('[inert]')){status.textContent='영상 도구 연결을 확인한 뒤 이동하세요.';return;}
      if(code==='Digit2'&&!target.hasAttribute('tabindex'))target.tabIndex=-1;
      target.focus({preventScroll:true});target.scrollIntoView({block:'nearest'});
    }
    function refresh(){button.disabled=!live()||busy||!owner;retry.disabled=!live()||busy;for(const b of toolButtons.values())b.disabled=!live()||!owner;}
    function end(){if(ended)return;ended=true;owner=null;for(const c of requests)c.abort();note.dispose();refresh();status.textContent='세션이나 영상창이 변경되었습니다. 뷰어를 새로 여세요.';}
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
    const key=e=>{if(e.defaultPrevented||e.repeat||e.isComposing||e.getModifierState('AltGraph')||!e.ctrlKey||!e.altKey||e.shiftKey||e.metaKey||!['Digit6',...toolButtons.keys()].includes(e.code)||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]'))return;e.preventDefault();if(e.code==='Digit6')open();else focusTool(e.code);};
    button.onclick=open;document.addEventListener('keydown',key);
    const storage=e=>{if(e.key==='kin-session-ended')end();};window.addEventListener('storage',storage);window.addEventListener('pagehide',end);
    try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
    const timer=setInterval(()=>{if(!live())end();},500);
    stop=()=>{end();clearInterval(timer);document.removeEventListener('keydown',key);window.removeEventListener('storage',storage);window.removeEventListener('pagehide',end);channel?.close();panel.remove();};
    async function connect(){
      if(!live()||busy)return;
      const restore=document.activeElement===retry;busy=true;refresh();status.textContent='메모 연결 확인 중…';
      try{await authenticate();if(live()){retry.hidden=true;status.textContent='선택한 영상 칸의 검사 메모 · Ctrl+Alt+6';}}
      catch(e){if(live()){retry.hidden=false;status.textContent='메모를 연결하지 못했습니다. 다시 시도하세요.';}}
      finally{busy=false;refresh();if(restore&&live()){const target=retry.hidden?button:retry;target.focus({preventScroll:true});}}
    }
    retry.onclick=connect;connect();
    return true;
  }
  return {mount,stop:()=>stop()};
};
