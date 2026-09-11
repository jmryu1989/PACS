(function(root){
  'use strict';
  const uid=value=>typeof value==='string'&&value.length<=64&&/^\d+(?:\.\d+)+$/.test(value);
  const orthanc=value=>typeof value==='string'&&/^([0-9a-f]{8}-){4}[0-9a-f]{8}$/.test(value);
  const PAGE_SIZE=12,WORKERS=4,IMAGE_LIMIT=4*1024*1024,PAGE_LIMIT=48*1024*1024;

  function mount(options){
    const boundOwner=options.owner();
    const host=options.host;
    let ended=false,source=null,view=null,generation=0,controller=null,urls=[],frames=[],page=0,order='ascending',work=Promise.resolve();
    const owned=()=>!ended&&boundOwner&&options.owner()===boundOwner;
    const current=()=>owned()&&source&&options.currentUid()===source.uid;
    const sourceIs=(value)=>current()&&source===value;
    const find=selector=>view?.querySelector(selector);
    function revoke(){for(const value of urls)URL.revokeObjectURL(value);urls=[];}
    function dropUrl(value){const index=urls.indexOf(value);if(index>=0){urls.splice(index,1);URL.revokeObjectURL(value);}}
    function enqueue(task){work=work.catch(()=>{}).then(task);return work;}
    function cancel(){generation++;controller?.abort();controller=null;revoke();}
    function close(){cancel();source=null;frames=[];if(view?.parentNode===host)view.remove();view=null;}
    function sync(){if(!owned())end();else if(source&&!current())close();return !!(source&&current());}
    function end(){if(ended)return;close();ended=true;root.removeEventListener('storage',storage);root.removeEventListener('pagehide',end);channel?.close();}

    function makeView(){
      const selected=source,section=document.createElement('section');section.id='thumb-images-view';section.className='thumb-images-view';
      const active=()=>current()&&source===selected&&view===section;
      section.innerHTML='<div class="thumb-images-toolbar"><button id="thumb-images-back" class="chip" type="button">Back to Series</button><label>Image Order <select id="thumb-images-order" aria-label="Image Order"><option value="ascending">Ascending</option><option value="descending">Descending</option></select></label><button id="thumb-images-retry" class="chip" type="button">Retry Images</button></div><p id="thumb-images-series"></p><p id="thumb-images-status" role="status"></p><div id="thumb-images-grid" class="thumb-images-grid"></div><div class="thumb-images-pages"><button id="thumb-images-prev" class="chip" type="button">Previous Page</button><span id="thumb-images-page"></span><button id="thumb-images-next" class="chip" type="button">Next Page</button></div>';
      section.querySelector('#thumb-images-back').onclick=()=>{if(!active())return;const back=options.onBack;close();back?.();};
      section.querySelector('#thumb-images-order').onchange=e=>{if(!active()||!['ascending','descending'].includes(e.target.value))return;order=e.target.value;page=0;renderPage();};
      section.querySelector('#thumb-images-retry').onclick=()=>{if(active())frames.length?renderPage():startInventory();};
      section.querySelector('#thumb-images-prev').onclick=()=>{if(active()&&page>0){page--;renderPage();}};
      section.querySelector('#thumb-images-next').onclick=()=>{if(active()&&(page+1)*PAGE_SIZE<frames.length){page++;renderPage();}};
      return section;
    }
    function ordered(){return order==='ascending'?frames:[...frames].reverse();}
    function updatePages(){
      if(!view)return;const pages=Math.max(1,Math.ceil(frames.length/PAGE_SIZE));
      find('#thumb-images-prev').disabled=page===0||!frames.length;
      find('#thumb-images-next').disabled=!frames.length||(page+1)>=pages;
      find('#thumb-images-page').textContent=`Page ${frames.length?page+1:0} / ${frames.length?pages:0} · ${frames.length} images`;
    }
    function cardFor(frame,position,op){
      const card=document.createElement('article');card.className='thumb-card thumb-image-card';card.dataset.sop=frame.sop;card.dataset.frame=String(frame.frame);
      const label=document.createElement('div');label.className='thumb-label';
      const number=document.createElement('div');number.className='thumb-number';number.textContent=`Image ${position+1} · Instance ${Number.isFinite(frame.number)?frame.number:'—'}`;
      const detail=document.createElement('div');detail.className='thumb-description';detail.textContent=`SOP ${frame.sop} · Frame ${frame.frame+1} / ${frame.frames}`;
      const preview=document.createElement('div');preview.className='thumb-preview thumb-image-preview';preview.textContent='Not started · Retry Images';
      const button=document.createElement('button');button.type='button';button.className='chip thumb-image-open';button.textContent='Preview Image';button.disabled=true;
      button.setAttribute('aria-label',`Preview Image · Instance ${Number.isFinite(frame.number)?frame.number:'unknown'} · SOP ${frame.sop} · Frame ${frame.frame+1} of ${frame.frames}`);
      button.onclick=()=>{if(op.valid()&&!button.disabled)options.onPreview?.({...op.selected,sop:frame.sop,frame:frame.frame});};
      label.append(number,detail);card.append(label,preview,button);return {card,preview,button,frame};
    }
    async function boundedPng(response,op,account){
      const contentType=response.headers.get('content-type')?.toLowerCase()||'';
      if(!contentType.startsWith('image/png')){await response.body?.cancel();throw Error('PNG 응답 형식이 아닙니다.');}
      const declared=Number(response.headers.get('content-length'));
      if(Number.isFinite(declared)&&(declared>IMAGE_LIMIT||account.bytes+declared>PAGE_LIMIT)){await response.body?.cancel();throw Error('영상 크기 한도를 넘었습니다.');}
      if(!response.body){const blob=await response.blob();if(!op.valid())return null;if(blob.size>IMAGE_LIMIT||account.bytes+blob.size>PAGE_LIMIT)throw Error('영상 크기 한도를 넘었습니다.');account.bytes+=blob.size;return blob;}
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{
        while(true){const part=await reader.read();if(!op.valid()){await reader.cancel();return null;}if(part.done)break;size+=part.value.byteLength;if(size>IMAGE_LIMIT||account.bytes+part.value.byteLength>PAGE_LIMIT){await reader.cancel();throw Error('영상 크기 한도를 넘었습니다.');}account.bytes+=part.value.byteLength;chunks.push(part.value);}
      }catch(error){try{await reader.cancel();}catch(_){ }throw error;}finally{reader.releaseLock?.();}
      return new Blob(chunks,{type:'image/png'});
    }
    async function boundedJson(response,valid){
      const limit=16*1024*1024,declared=Number(response.headers.get('content-length'));
      if(Number.isFinite(declared)&&declared>limit){await response.body?.cancel();throw Error('영상 목록 크기 한도를 넘었습니다.');}
      if(!response.body){const text=await response.text();if(!valid())return null;if(new TextEncoder().encode(text).byteLength>limit)throw Error('영상 목록 크기 한도를 넘었습니다.');return JSON.parse(text);}
      const reader=response.body.getReader(),decoder=new TextDecoder(),parts=[];let size=0;
      try{
        while(true){const part=await reader.read();if(!valid()){await reader.cancel();return null;}if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader.cancel();throw Error('영상 목록 크기 한도를 넘었습니다.');}parts.push(decoder.decode(part.value,{stream:true}));}
      }catch(error){try{await reader.cancel();}catch(_){ }throw error;}finally{reader.releaseLock?.();}
      parts.push(decoder.decode());return JSON.parse(parts.join(''));
    }
    async function loadCard(item,op,account){
      item.preview.textContent='Loading…';
      const lookup=await options.api('POST','/dicom/lookup',{studyUid:op.selected.uid,sopUid:item.frame.sop},op.abort.signal);if(!op.valid())return;
      if(!orthanc(lookup?.id))throw Error('원본 식별자를 확인할 수 없습니다.');
      const response=await fetch(`/instances/${lookup.id}/frames/${item.frame.frame}/rendered?width=256&height=256`,{headers:{Accept:'image/png'},signal:op.abort.signal,credentials:'same-origin',cache:'no-store'});if(!op.valid()){await response.body?.cancel();return;}
      if(!response.ok){await response.body?.cancel();throw Object.assign(Error(`원본 렌더링 HTTP ${response.status}`),{status:response.status});}
      const blob=await boundedPng(response,op,account);if(!blob||!op.valid())return;
      const objectUrl=URL.createObjectURL(blob),image=new Image();urls.push(objectUrl);image.alt=`Instance ${Number.isFinite(item.frame.number)?item.frame.number:'unknown'} · SOP ${item.frame.sop} · Frame ${item.frame.frame+1} of ${item.frame.frames}`;image.src=objectUrl;
      try{await image.decode();}catch(error){dropUrl(objectUrl);if(error?.name==='AbortError')throw error;throw Error('원본 영상을 표시하지 못했습니다.');}
      if(!op.valid()){dropUrl(objectUrl);return;}
      item.preview.replaceChildren(image);item.button.disabled=false;
    }
    function renderPage(){
      if(!current()||!view)return;cancel();const ticket=generation,selected=source,abort=controller=new AbortController();
      const op={selected,abort,valid:()=>ticket===generation&&!abort.signal.aborted&&sourceIs(selected)};
      const list=ordered(),start=page*PAGE_SIZE,batch=list.slice(start,start+PAGE_SIZE),grid=find('#thumb-images-grid');grid.replaceChildren();
      const cards=batch.map((frame,index)=>cardFor(frame,start+index,op));for(const item of cards)grid.append(item.card);
      find('#thumb-images-status').textContent=batch.length?'현재 페이지 영상을 확인하는 중…':'표시할 원본 영상이 없습니다.';updatePages();
      enqueue(async()=>{
        if(!op.valid())return;const account={bytes:0};let next=0,halted=false,completed=0;
        const timer=setTimeout(()=>{op.timedOut=true;abort.abort();if(ticket===generation&&sourceIs(selected)){cards.forEach(item=>{item.button.disabled=true;if(item.preview.textContent==='Loading…'||item.preview.textContent.startsWith('Not started'))item.preview.textContent='Not loaded · Retry Images';});find('#thumb-images-status').textContent='응답 시간이 초과됐습니다. Retry Images로 다시 확인하세요.';}},15000);
        const worker=async()=>{
          while(op.valid()&&!halted&&next<cards.length){
            const item=cards[next++];
            try{await loadCard(item,op,account);if(op.valid())completed++;}
            catch(error){
              if(!op.valid())return;
              item.preview.textContent=`Unavailable · ${error.message} · Retry Images`;item.button.disabled=true;
              if(error instanceof TypeError||error.status===401||error.status===403)halted=true;
            }
          }
        };
        try{
          await Promise.allSettled(Array.from({length:Math.min(WORKERS,cards.length)},worker));
          if(!op.valid())return;
          if(halted)cards.slice(next).forEach(item=>{item.preview.textContent='Not loaded · Retry Images';item.button.disabled=true;});
          find('#thumb-images-status').textContent=halted?'일부 요청이 중단됐습니다. Retry Images로 다시 확인하세요.':`${completed} / ${cards.length} images ready`;
        }finally{clearTimeout(timer);if(controller===abort)controller=null;}
      });
    }
    async function loadInventory(selected,ticket,abort){
      const fields='0020000D,0020000E,00080018,0008103E,00200013,00280008,00280010,00280011,00280004';
      try{
        const response=await fetch(`/dicom-web/studies/${selected.uid}/instances?includefield=${fields}`,{signal:abort.signal,credentials:'same-origin',cache:'no-store'});if(ticket!==generation||!sourceIs(selected)){await response.body?.cancel();return;}
        if(!response.ok){await response.body?.cancel();throw Error(`영상 목록 HTTP ${response.status}`);}
        const inventoryValid=()=>ticket===generation&&!abort.signal.aborted&&sourceIs(selected);
        const rows=await boundedJson(response,inventoryValid);if(!rows||ticket!==generation||!sourceIs(selected))return;
        const groups=root.KinWorklistImagePreview.inventory(rows,selected.uid),group=groups.find(value=>value.uid===selected.series);
        if(!group)throw Error('선택한 시리즈가 원본 목록에 없습니다.');
        frames=[];for(const instance of group.instances)for(let frame=0;frame<instance.frames;frame++)frames.push({...instance,frame});
        find('#thumb-images-series').textContent=`${group.label} · Series ${group.uid}`;find('#thumb-images-order').disabled=false;find('#thumb-images-retry').disabled=false;page=0;renderPage();
      }catch(error){
        if(ticket!==generation||!sourceIs(selected))return;find('#thumb-images-status').textContent=abort.signal.aborted?'응답 시간이 초과됐습니다. Retry Images로 다시 확인하세요.':`${error.message} · Retry Images로 다시 확인하세요.`;find('#thumb-images-retry').disabled=false;updatePages();
      }finally{if(controller===abort)controller=null;}
    }
    function startInventory(){
      if(!current())return;cancel();frames=[];page=0;find('#thumb-images-grid').replaceChildren();find('#thumb-images-status').textContent='원본 영상 목록을 불러오는 중…';find('#thumb-images-order').disabled=true;find('#thumb-images-retry').disabled=true;updatePages();
      const ticket=generation,selected=source,abort=controller=new AbortController();
      enqueue(async()=>{if(ticket!==generation||!sourceIs(selected))return;const timer=setTimeout(()=>{abort.abort();if(ticket===generation&&sourceIs(selected)){find('#thumb-images-status').textContent='응답 시간이 초과됐습니다. Retry Images로 다시 확인하세요.';find('#thumb-images-retry').disabled=false;}},15000);try{await loadInventory(selected,ticket,abort);}finally{clearTimeout(timer);}});
    }
    function open(value){
      if(!owned()||!host||!value||!uid(value.uid)||value.uid!==options.currentUid()||!uid(value.series))return false;
      close();source={...value};order='ascending';page=0;view=makeView();host.replaceChildren(view);find('#thumb-images-series').textContent=`Series ${value.series}`;find('#thumb-images-status').textContent='원본 영상 목록을 불러오는 중…';find('#thumb-images-order').disabled=true;find('#thumb-images-retry').disabled=true;updatePages();
      startInventory();return true;
    }
    const storage=e=>{if(e.key==='kin-session-ended')end();};let channel=null;
    root.addEventListener('storage',storage);root.addEventListener('pagehide',end);try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){ }
    return {open,close,sync,end};
  }
  const api={mount};if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorklistImageThumbnails=api;
})(globalThis);
