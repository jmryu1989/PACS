/* Account-scoped display choices; identity always comes from loaded images. */
window.KinViewerIdentity=(()=>{
  const fonts={default:'inherit',sans:'"Malgun Gothic", sans-serif',serif:'"Batang", serif',mono:'"Consolas", monospace'};
  const colors={default:'#d7f3ff',warm:'#fff1d6',cool:'#d7f3ff',white:'#ffffff'};
  const defaults=()=>({version:1,current:{size:12,font:'default',color:'default',name:true,date:true,description:false},prior:{size:12,font:'default',color:'warm',name:true,date:true,description:false}});
  const normalize=v=>{
    if(!v||typeof v!=='object'||Array.isArray(v)||v.version!==1||Object.keys(v).sort().join()!=='current,prior,version')return null;
    const result={version:1};
    for(const role of ['current','prior']){const p=v[role];if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join()!=='color,date,description,font,name,size'||![12,14,16,18,20].includes(p.size)||typeof p.font!=='string'||typeof p.color!=='string'||!Object.hasOwn(fonts,p.font)||!Object.hasOwn(colors,p.color)||['name','date','description'].some(k=>typeof p[k]!=='boolean'))return null;result[role]={size:p.size,font:p.font,color:p.color,name:p.name,date:p.date,description:p.description};}
    return result;
  };
  const key=owner=>'kin-viewer-identity:v1:'+owner;
  function read(owner){try{const raw=localStorage.getItem(key(owner));return raw&&raw.length<=1024?normalize(JSON.parse(raw))||defaults():defaults();}catch(_){return defaults();}}
  function publish(owner,value){const clean=normalize(value);if(!owner||!clean)return false;let saved=true;try{localStorage.setItem(key(owner),JSON.stringify(clean));}catch(_){saved=false;}
    window.dispatchEvent(new CustomEvent('kin-viewer-identity-change',{detail:{owner,value:clean}}));
    // Messages from separate windows may arrive late. Persisted notifications
    // carry no preference snapshot; receivers re-read the latest local value.
    if(saved)try{const c=new BroadcastChannel('kin-viewer-identity');c.postMessage({owner,persisted:true});c.close();}catch(_){}return saved;
  }
  function subscribe(owner,apply){
    const receive=data=>{const v=data?.owner===owner&&normalize(data.value);if(v)apply(v);};
    const raw=()=>{try{return localStorage.getItem(key(owner));}catch(_){return undefined;}};let seen=raw();
    const persisted=()=>{const next=raw();if(next===undefined||next===seen)return;seen=next;apply(read(owner));};
    // A delayed notification for an unchanged stored value must not erase a
    // newer in-memory choice made while persistence was unavailable.
    const local=e=>{if(e.detail?.owner!==owner)return;seen=raw();receive(e.detail);},storage=e=>{if(e.key===key(owner))persisted();};let channel,parent;
    window.addEventListener('kin-viewer-identity-change',local);window.addEventListener('storage',storage);
    try{if(window.parent!==window){parent=window.parent;parent.addEventListener('kin-viewer-identity-change',local);}}catch(_){}
    try{channel=new BroadcastChannel('kin-viewer-identity');channel.onmessage=e=>{if(e.data?.owner===owner&&e.data.persisted===true)persisted();};}catch(_){}
    return ()=>{window.removeEventListener('kin-viewer-identity-change',local);window.removeEventListener('storage',storage);try{parent?.removeEventListener('kin-viewer-identity-change',local);}catch(_){}channel?.close();};
  }
  function mount({services,resolve,owner,allowed,studies}){
    const bound=JSON.stringify(owner());let value=read(bound),ended=false,observing=false;const labels=new Map(),loading=new Map(),titles=new Map();
    const neutral='판독 뷰어 — KOREA IMAGING NETWORK';let frame;try{frame=window.frameElement;}catch(_){}
    function setTitle(title){if(document.title!==title)document.title=title;if(frame?.isConnected&&frame.contentWindow===window)frame.title=title===neutral?'영상 뷰어':title;}
    function syncTitle(){setTitle(titles.get(services.viewportGridService.getState().activeViewportId)||neutral);}
    const text=v=>v&&typeof v==='object'?String(v.Alphabetic??v.Ideographic??v.Phonetic??''):String(v??'');
    function clear(){for(const e of labels.values())e.remove();labels.clear();titles.clear();setTitle(neutral);}
    function refresh(wanted){
      try{
        if(ended||!observing||!allowed()||JSON.stringify(owner())!==bound){clear();return;}
        const ids=new Set(services.viewportGridService.getState().viewports.keys());
        for(const [id,e] of labels)if(!ids.has(id)){e.remove();labels.delete(id);titles.delete(id);}
        for(const id of loading.keys())if(!ids.has(id))loading.delete(id);
        for(const id of ids){
          if(typeof wanted==='string'&&wanted!==id)continue;
          if(loading.has(id)){labels.get(id)?.remove();labels.delete(id);titles.delete(id);continue;}
          const current=resolve(id),m=current&&window.cornerstone.metaData.get('instance',current.image),v=services.cornerstoneViewportService.getCornerstoneViewport(id);
          if(!current||!m||!v?.element||v.viewportStatus!==window.cornerstone.Enums.ViewportStatus.RENDERED||!studies.includes(current.uid)||m.StudyInstanceUID!==current.uid||m.SeriesInstanceUID!==current.series||m.SOPInstanceUID!==current.sop||typeof m.PatientID!=='string'||!m.PatientID.trim()||m.PatientID.length>64||(current.study.id&&current.study.id!==m.PatientID)){labels.get(id)?.remove();labels.delete(id);titles.delete(id);continue;}
          let e=labels.get(id);if(!e||e.parentNode!==v.element){e?.remove();e=document.createElement('div');e.className='kin-viewer-identity';e.style.cssText='position:absolute;right:28px;top:38px;max-width:40%;max-height:32%;overflow:hidden;overflow-wrap:anywhere;text-align:right;pointer-events:none;background:#0b182bcc;padding:3px 6px;border-radius:3px;z-index:2;line-height:1.3';v.element.append(e);labels.set(id,e);}
          const role=current.uid===studies[0]?'current':'prior',p=value[role];e.dataset.role=role;e.dataset.study=current.uid;
          const parts=[(role==='current'?'기준 검사':'비교 검사')+' · '+m.PatientID];
          if(p.name)parts.push(text(m.PatientName).slice(0,128));if(p.date)parts.push(text(m.StudyDate).slice(0,16));if(p.description)parts.push(text(m.StudyDescription||m.SeriesDescription).slice(0,128));
          titles.set(id,parts.concat(text(m.Modality).slice(0,16)).filter(Boolean).join(' · ')+' — 판독 뷰어');
          e.textContent=parts.filter(Boolean).join(' · ');e.style.fontSize=p.size+'px';e.style.fontFamily=fonts[p.font];e.style.color=colors[p.color];
          const bounds=v.element.getBoundingClientRect(),right=bounds.right-28,left=right-bounds.width*.4;
          const pane=v.element.closest('[data-cy="viewport-pane"]')||v.element.parentElement;let top=38;
          for(const native of pane?.querySelectorAll('[data-cy="viewport-overlay-top-left"],[data-cy="viewport-overlay-top-right"]')||[]){const b=native.getBoundingClientRect();if(native.textContent.trim()&&b.width&&b.height&&b.right>left&&b.left<right)top=Math.max(top,b.bottom-bounds.top+6);}
          e.style.top=top+'px';
        }
        syncTitle();
      }catch(_){clear();}
    }
    // Clear before a replacement can paint; validate after the native state
    // update. A changed stack refreshes only its own label, not every volume.
    const pending=new Set();let queued=false,all=false;
    function changed(id){
      if(ended)return;
      if(typeof id==='string'){labels.get(id)?.remove();labels.delete(id);titles.delete(id);pending.add(id);syncTitle();}else{clear();all=true;}
      if(queued)return;queued=true;queueMicrotask(()=>{queued=false;if(ended)return;const refreshAll=all;all=false;const ids=[...pending];pending.clear();if(refreshAll)refresh();else for(const id of ids)refresh(id);});
    }
    const coreEvents=window.cornerstone?.Enums?.Events;
    const gridChanged=()=>changed(),imageChanged=e=>{
      const id=e.detail?.viewportId;if(typeof id!=='string'){changed();return;}
      if(e.type===coreEvents.PRE_STACK_NEW_IMAGE)loading.set(id,{image:e.detail.imageId,ready:false});
      else if(e.type===coreEvents.STACK_NEW_IMAGE){const pending=loading.get(id);if(!pending||pending.image===e.detail.imageId)loading.set(id,{image:e.detail.imageId,ready:true});}
      else if(e.type===coreEvents.VOLUME_VIEWPORT_NEW_VOLUME)loading.set(id,{ready:true});
      else if(e.type===coreEvents.IMAGE_RENDERED){
        const pending=loading.get(id),v=services.cornerstoneViewportService.getCornerstoneViewport(id);
        if(pending&&(!pending.ready||(pending.image&&pending.image!==v?.getCurrentImageId?.())))return;
        if(v?.viewportStatus!==window.cornerstone.Enums.ViewportStatus.RENDERED)return;
        loading.delete(id);if(labels.has(id))return;
      }
      changed(id);
    },subscriptions=[];
    // A completed fetch can precede the actual canvas render. Failed loads stay
    // unlabeled until a subsequent successful image/render or viewport removal.
    const events=['PRE_STACK_NEW_IMAGE','STACK_NEW_IMAGE','VOLUME_VIEWPORT_NEW_VOLUME','IMAGE_RENDERED'].map(k=>coreEvents?.[k]);
    try{const grid=services.viewportGridService,keys=Object.values(grid.EVENTS);if(!keys.length||events.some(e=>!e))throw new Error('identity events unavailable');for(const event of new Set(keys))subscriptions.push(grid.subscribe(event,gridChanged));for(const event of events)document.addEventListener(event,imageChanged,true);observing=true;}catch(_){subscriptions.forEach(s=>s.unsubscribe());subscriptions.length=0;for(const event of events.filter(Boolean))document.removeEventListener(event,imageChanged,true);}
    const unsubscribe=subscribe(bound,next=>{value=next;refresh();}),timer=setInterval(refresh,500);refresh();
    return {dispose(){ended=true;clearInterval(timer);unsubscribe();subscriptions.forEach(s=>s.unsubscribe());for(const event of events.filter(Boolean))document.removeEventListener(event,imageChanged,true);loading.clear();clear();}};
  }
  return {defaults,normalize,read,publish,subscribe,mount};
})();
