/* Account-scoped display choices; identity always comes from loaded images. */
window.KinViewerIdentity=(()=>{
  const fonts={default:'inherit',sans:'"Malgun Gothic", sans-serif',serif:'"Batang", serif',mono:'"Consolas", monospace'};
  const colors={default:'#d7f3ff',warm:'#fff1d6',cool:'#d7f3ff',white:'#ffffff'};
  const positions=['top-left','top-right','bottom-left','bottom-right'];
  const modalities=['CT','MR','CR','DX','US','MG','XA','RF','PT','NM','OT'];
  const fields=['name','date','description'],profileKeys='color,date,description,fieldPositions,font,name,position,size',profileOverrideKeys='color,date,description,fieldPositions,font,name,overrides,position,size';
  const plain=v=>{if(!v||typeof v!=='object'||Array.isArray(v))return false;const proto=Object.getPrototypeOf(v);return proto===null||(Object.prototype.toString.call(v)==='[object Object]'&&Object.getPrototypeOf(proto)===null);};
  const base=(color='default')=>({size:12,font:'default',color,name:true,date:true,description:false,position:'top-right',fieldPositions:{name:'top-right',date:'top-right',description:'top-right'},overrides:{}});
  const defaults=()=>({version:3,current:base(),prior:base('warm')});
  function profile(v,withOverrides){
    if(!plain(v)||Object.keys(v).sort().join()!==(withOverrides?profileOverrideKeys:profileKeys))return null;
    if(![12,14,16,18,20].includes(v.size)||typeof v.font!=='string'||typeof v.color!=='string'||!Object.hasOwn(fonts,v.font)||!Object.hasOwn(colors,v.color)||!positions.includes(v.position)||fields.some(k=>typeof v[k]!=='boolean'))return null;
    if(!plain(v.fieldPositions)||Object.keys(v.fieldPositions).sort().join()!=='date,description,name'||fields.some(k=>!positions.includes(v.fieldPositions[k])))return null;
    const clean={size:v.size,font:v.font,color:v.color,name:v.name,date:v.date,description:v.description,position:v.position,fieldPositions:{name:v.fieldPositions.name,date:v.fieldPositions.date,description:v.fieldPositions.description}};
    if(!withOverrides)return clean;
    if(!plain(v.overrides)||Object.keys(v.overrides).some(k=>!modalities.includes(k)))return null;
    clean.overrides={};for(const modality of modalities)if(Object.hasOwn(v.overrides,modality)){const item=profile(v.overrides[modality],false);if(!item)return null;clean.overrides[modality]=item;}
    return clean;
  }
  const normalize=v=>{
    if(!plain(v)||![1,2,3].includes(v.version)||Object.keys(v).sort().join()!=='current,prior,version')return null;
    const result={version:3};
    for(const role of ['current','prior']){
      const p=v[role],keys=v.version===1?'color,date,description,font,name,size':v.version===2?'color,date,description,font,name,position,size':profileOverrideKeys;
      if(!plain(p)||Object.keys(p).sort().join()!==keys)return null;
      if(v.version===3){const clean=profile(p,true);if(!clean)return null;result[role]=clean;continue;}
      if(![12,14,16,18,20].includes(p.size)||typeof p.font!=='string'||typeof p.color!=='string'||!Object.hasOwn(fonts,p.font)||!Object.hasOwn(colors,p.color)||fields.some(k=>typeof p[k]!=='boolean')||(v.version===2&&!positions.includes(p.position)))return null;
      const position=v.version===1?'top-right':p.position;result[role]={size:p.size,font:p.font,color:p.color,name:p.name,date:p.date,description:p.description,position,fieldPositions:{name:position,date:position,description:position},overrides:{}};
    }
    return result;
  };
  const key=owner=>'kin-viewer-identity:v1:'+owner;
  function read(owner){try{const raw=localStorage.getItem(key(owner));return raw&&raw.length<=32768?normalize(JSON.parse(raw))||defaults():defaults();}catch(_){return defaults();}}
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
          let e=labels.get(id);if(!e||e.parentNode!==v.element){e?.remove();e=document.createElement('div');e.className='kin-viewer-identity';v.element.append(e);labels.set(id,e);}
          const role=current.uid===studies[0]?'current':'prior',general=value[role],modality=typeof m.Modality==='string'&&modalities.includes(m.Modality.trim().toUpperCase())?m.Modality.trim().toUpperCase():'',p=modality&&general.overrides[modality]||general;
          e.dataset.role=role;e.dataset.study=current.uid;e.dataset.modality=modality;e.dataset.profile=modality&&general.overrides[modality]?'override':'general';
          const shown={name:text(m.PatientName).slice(0,128),date:text(m.StudyDate).slice(0,16),description:text(m.StudyDescription||m.SeriesDescription).slice(0,128)};
          const titleParts=[(role==='current'?'기준 검사':'비교 검사')+' · '+m.PatientID];for(const field of fields)if(p[field]&&shown[field])titleParts.push(shown[field]);
          titles.set(id,titleParts.concat(text(m.Modality).slice(0,16)).filter(Boolean).join(' · ')+' — 판독 뷰어');
          const groups=new Map([[p.position,[(role==='current'?'기준 검사':'비교 검사')+' · '+m.PatientID]]]);
          for(const field of fields)if(p[field]&&shown[field]){const at=p.fieldPositions[field];if(!groups.has(at))groups.set(at,[]);groups.get(at).push(shown[field]);}
          e.replaceChildren();const primary=document.createElement('span');primary.className='kin-viewer-identity-content';primary.textContent=groups.get(p.position).join(' · ');primary.style.cssText='display:block;box-sizing:border-box;overflow:hidden;overflow-wrap:anywhere;background:#0b182bcc;padding:3px 6px;border-radius:3px';e.append(primary);
          e.style.cssText='position:absolute;box-sizing:border-box;overflow:visible;pointer-events:none;z-index:2;line-height:1.3';
          const bounds=v.element.getBoundingClientRect(),small=bounds.width<140||bounds.height<100,pane=v.element.closest('[data-cy="viewport-pane"]')||v.element.parentElement;
          function place(group,position,root){
            group.style.fontSize=p.size+'px';group.style.fontFamily=fonts[p.font];group.style.color=colors[p.color];group.style.boxSizing='border-box';group.style.overflowWrap='anywhere';
            const horizontal=position.endsWith('left')?'left':'right',vertical=position.startsWith('top')?'top':'bottom',x=small?4:28,y=small?4:38,maxWidth=small?Math.max(0,bounds.width-x*2):bounds.width*.4;
            const left=horizontal==='left'?bounds.left+x:bounds.right-x-maxWidth,right=left+maxWidth,suffix=vertical==='top'?'top':'bottom';let offset=y;
            for(const native of pane?.querySelectorAll('[data-cy="viewport-overlay-'+suffix+'-left"],[data-cy="viewport-overlay-'+suffix+'-right"]')||[]){const b=native.getBoundingClientRect();if(native.textContent.trim()&&b.width&&b.height&&b.right>left&&b.left<right)offset=Math.max(offset,vertical==='top'?b.bottom-bounds.top+6:bounds.bottom-b.top+6);}
            const finalOffset=Math.min(Math.max(y,offset),Math.max(y,bounds.height-y)),maxHeight=Math.max(0,Math.min(small?bounds.height-y*2:bounds.height*.32,bounds.height-finalOffset-y));
            group.style.textAlign=horizontal;group.style.maxWidth=maxWidth+'px';group.style.maxHeight=maxHeight+'px';
            if(root){primary.style.maxWidth=maxWidth+'px';primary.style.maxHeight=maxHeight+'px';for(const side of ['left','right','top','bottom'])group.style[side]='auto';group.style[horizontal]=x+'px';group.style[vertical]=finalOffset+'px';return;}
            group.style.position='absolute';group.style.overflow='hidden';group.style.background='#0b182bcc';group.style.padding='3px 6px';group.style.borderRadius='3px';group.style.width='max-content';group.style.left='0px';group.style.top='0px';
            const rootBox=e.getBoundingClientRect(),box=group.getBoundingClientRect(),absoluteLeft=horizontal==='left'?bounds.left+x:bounds.right-x-Math.min(box.width,maxWidth),absoluteTop=vertical==='top'?bounds.top+finalOffset:bounds.bottom-finalOffset-Math.min(box.height,maxHeight);
            group.style.left=(absoluteLeft-rootBox.left)+'px';group.style.top=(absoluteTop-rootBox.top)+'px';
          }
          place(e,p.position,true);
          for(const position of positions)if(position!==p.position&&groups.has(position)){const group=document.createElement('span');group.className='kin-viewer-identity-group';group.dataset.position=position;group.textContent=groups.get(position).join(' · ');e.append(group);place(group,position,false);}
          const boxes=[primary,...e.querySelectorAll('.kin-viewer-identity-group')].map(node=>node.getBoundingClientRect()),overlap=boxes.some((a,index)=>boxes.slice(index+1).some(b=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top));
          // Four independently anchored labels cannot always fit in a narrow
          // viewport. Keep every configured value, with the required patient
          // identity first, in one bounded label when their measured boxes
          // would cover each other. Ordinary layouts keep their chosen corners.
          if(overlap){primary.textContent=[...groups.values()].flat().join(' · ');for(const group of e.querySelectorAll('.kin-viewer-identity-group'))group.remove();place(e,p.position,true);}
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
  return {positions:[...positions],modalities:[...modalities],defaults,normalize,read,publish,subscribe,mount};
})();
