(function(root){
  'use strict';
  const tag=(row,key)=>row?.[key]?.Value?.[0];
  const uid=value=>typeof value==='string'&&value.length<=64&&/^\d+(?:\.\d+)+$/.test(value);
  function inventory(rows,study){
    if(!uid(study)||!Array.isArray(rows)||rows.length>10000)throw Error('영상 목록을 확인할 수 없습니다.');
    const groups=new Map(),seen=new Set();let total=0;
    for(const row of rows){
      const sop=tag(row,'00080018'),series=tag(row,'0020000E');
      if(tag(row,'0020000D')!==study||!uid(sop)||!uid(series)||seen.has(sop))throw Error('원본 영상 참조가 일치하지 않습니다.');seen.add(sop);
      const height=tag(row,'00280010'),width=tag(row,'00280011');if(height===undefined&&width===undefined)continue;
      if(![height,width].every(n=>Number.isSafeInteger(Number(n))&&Number(n)>0&&Number(n)<=65536))throw Error('원본 영상 크기를 확인할 수 없습니다.');
      const frames=tag(row,'00280008')===undefined?1:Number(tag(row,'00280008'));
      if(!Number.isSafeInteger(frames)||frames<1||(total+=frames)>100000)throw Error('원본 프레임 수를 확인할 수 없습니다.');
      if(!groups.has(series))groups.set(series,{uid:series,label:String(tag(row,'0008103E')||'Unnamed Series'),instances:[],total:0});
      const group=groups.get(series);group.instances.push({sop,frames,number:Number(tag(row,'00200013')),gray:['MONOCHROME1','MONOCHROME2'].includes(tag(row,'00280004'))});group.total+=frames;
    }
    if(!groups.size)throw Error('미리볼 수 있는 원본 영상이 없습니다.');
    for(const group of groups.values())group.instances.sort((a,b)=>(Number.isFinite(a.number)?a.number:Number.MAX_SAFE_INTEGER)-(Number.isFinite(b.number)?b.number:Number.MAX_SAFE_INTEGER)||a.sop.localeCompare(b.sop));
    return [...groups.values()];
  }
  function frameAt(group,index){
    if(!group||!Number.isSafeInteger(index)||index<0||index>=group.total)return null;
    for(const instance of group.instances){if(index<instance.frames)return {...instance,frame:index};index-=instance.frames;}
    return null;
  }
  function windowing(width,center){
    if(!String(width).trim()||!String(center).trim())return null;const w=Number(width),c=Number(center);
    return Number.isFinite(w)&&w>=1&&w<=10000000&&Number.isFinite(c)&&Math.abs(c)<=1000000000?{width:w,center:c}:null;
  }
  function mount(options){
    const owner=options.owner();let ended=false,dialog=null,study=null,groups=[],series=0,index=0,windowValue=null,epoch=0,controller=null,chain=Promise.resolve(),url=null;
    const live=()=>!ended&&owner&&options.owner()===owner;
    const current=()=>live()&&study&&options.currentUid()===study.uid;
    const el=selector=>dialog.querySelector(selector);
    function release(){controller?.abort();controller=null;epoch++;if(url){URL.revokeObjectURL(url);url=null;}if(dialog){el('img').removeAttribute('src');el('img').hidden=true;}}
    function close(){release();study=null;groups=[];windowValue=null;if(dialog?.open)dialog.close();}
    function sync(){if(!live())end();else if(study&&!current())close();}
    function controls(){
      const group=groups[series],frame=frameAt(group,index),gray=!!frame?.gray;
      el('[data-prev]').disabled=!frame||index===0;el('[data-next]').disabled=!frame||index===group.total-1;
      el('[data-frame]').disabled=!frame;el('[data-frame]').max=String(group?.total||1);el('[data-frame]').value=String(index+1);
      el('[data-position]').textContent=frame?`${index+1} / ${group.total} · SOP ${frame.sop} · Frame ${frame.frame+1} / ${frame.frames}`:'';
      el('[data-apply]').disabled=el('[data-width]').disabled=el('[data-center]').disabled=!gray;
      el('[data-reset]').disabled=!frame;
    }
    function schedule(initial=false){
      if(!current())return;release();const ticket=epoch,selectedStudy=study,selectedSeries=series,selectedIndex=index,selectedWindow=windowValue;
      el('[data-status]').textContent='원본 영상을 불러오는 중…';controls();
      chain=chain.catch(()=>{}).then(async()=>{
        if(ticket!==epoch||!current())return;
        const abort=controller=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
        const valid=()=>ticket===epoch&&current()&&!abort.signal.aborted;
        try{
          if(initial){
            const fields='0020000D,0020000E,00080018,0008103E,00200013,00280008,00280010,00280011,00280004';
            const response=await fetch(`/dicom-web/studies/${selectedStudy.uid}/instances?includefield=${fields}`,{signal:abort.signal,credentials:'same-origin',cache:'no-store'});
            if(!response.ok){await response.body?.cancel();throw Error(`영상 목록 HTTP ${response.status}`);}
            const rows=await response.json();if(!valid())return;groups=inventory(rows,selectedStudy.uid);
            series=groups.findIndex(g=>g.uid===selectedStudy.series);index=0;
            if(series<0)throw Error('선택한 시리즈가 원본 목록에 없습니다.');
            if(selectedStudy.sop){const instances=groups[series].instances,position=instances.findIndex(i=>i.sop===selectedStudy.sop);if(position<0)throw Error('선택한 영상이 원본 목록에 없습니다.');index=instances.slice(0,position).reduce((n,i)=>n+i.frames,0);}
            const select=el('[data-series]');select.replaceChildren();groups.forEach((g,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=`${i+1} · ${g.label}`;select.append(option);});select.value=String(series);select.disabled=false;
          }else {series=selectedSeries;index=selectedIndex;}
          const group=groups[series],frame=frameAt(group,index);if(!frame)throw Error('원본 프레임을 확인할 수 없습니다.');controls();
          const lookup=await options.api('POST','/dicom/lookup',{studyUid:selectedStudy.uid,sopUid:frame.sop},abort.signal);if(!valid())return;
          if(typeof lookup.id!=='string'||!/^([0-9a-f]{8}-){4}[0-9a-f]{8}$/.test(lookup.id))throw Error('원본 식별자를 확인할 수 없습니다.');
          const query=new URLSearchParams({width:'1024',height:'1024'});
          if(selectedWindow&&frame.gray){query.set('window-width',String(selectedWindow.width));query.set('window-center',String(selectedWindow.center));}
          const response=await fetch(`/instances/${lookup.id}/frames/${frame.frame}/rendered?${query}`,{headers:{Accept:'image/png'},signal:abort.signal,credentials:'same-origin',cache:'no-store'});
          if(!response.ok){await response.body?.cancel();throw Error(`원본 렌더링 HTTP ${response.status}`);}
          if(!response.headers.get('content-type')?.toLowerCase().startsWith('image/png')){await response.body?.cancel();throw Error('원본 영상 응답 형식이 다릅니다.');}
          const blob=await response.blob();if(!valid())return;if(blob.size>16777216)throw Error('미리보기 영상 크기 한도를 넘었습니다.');
          const objectUrl=URL.createObjectURL(blob),image=new Image();image.src=objectUrl;
          try{await image.decode();}catch(e){URL.revokeObjectURL(objectUrl);throw Error('원본 영상을 표시하지 못했습니다.');}
          if(!valid()){URL.revokeObjectURL(objectUrl);return;}
          url=objectUrl;el('img').src=url;el('img').hidden=false;
          el('img').alt=`${selectedStudy.name||''} · ${group.label} · SOP ${frame.sop} · Frame ${frame.frame+1}`;
          el('[data-status]').textContent=selectedWindow&&frame.gray?`Rendered · W ${selectedWindow.width} / L ${selectedWindow.center}`:'Rendered · Original Window';
        }catch(error){if(ticket===epoch&&current()){if(initial){groups=[];el('[data-series]').disabled=true;controls();}el('[data-status]').textContent=abort.signal.aborted?'응답 시간이 초과됐습니다. Retry로 다시 확인하세요.':`${error.message} · Retry로 다시 확인하세요.`;}}
        finally{clearTimeout(timer);if(controller===abort)controller=null;}
      });
    }
    function ensure(){
      if(dialog)return;dialog=document.createElement('dialog');dialog.id='worklist-image-preview';dialog.style.cssText='width:min(1000px,94vw);max-height:92vh;overflow:auto;background:#142237;color:inherit;border:1px solid #355272;padding:18px';
      dialog.innerHTML='<h2>Image Preview</h2><p data-identity></p><p>서버 렌더링 미리보기 · 원본 검사/판독문은 변경하지 않습니다.</p><label>Series <select data-series disabled></select></label><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0"><button class="chip" type="button" data-prev>Previous Frame</button><label>Frame <input data-frame type="number" min="1" step="1" style="width:80px"></label><button class="chip" type="button" data-next>Next Frame</button><label>W <input data-width type="number" min="1" max="10000000" style="width:95px"></label><label>L <input data-center type="number" style="width:95px"></label><button class="chip" type="button" data-apply>Apply W/L</button><button class="chip" type="button" data-reset>Original Window</button></div><p data-position style="overflow-wrap:anywhere"></p><p data-status role="status"></p><div style="height:50vh;min-height:240px;background:#000;display:flex;align-items:center;justify-content:center"><img hidden style="max-width:100%;max-height:100%;object-fit:contain"></div><p><button class="chip" type="button" data-retry>Retry</button> <button class="chip" type="button" data-close>Close</button></p>';
      document.body.append(dialog);
      el('[data-series]').onchange=()=>{const next=Number(el('[data-series]').value);if(!current()||!groups[next])return;series=next;index=0;windowValue=null;el('[data-width]').value=el('[data-center]').value='';schedule();};
      const move=next=>{if(!current()||!frameAt(groups[series],next)){controls();return;}index=next;schedule();};
      el('[data-prev]').onclick=()=>move(index-1);el('[data-next]').onclick=()=>move(index+1);el('[data-frame]').onchange=()=>move(Number(el('[data-frame]').value)-1);
      el('[data-apply]').onclick=()=>{const value=windowing(el('[data-width]').value,el('[data-center]').value);if(!current()||!frameAt(groups[series],index)?.gray)return;if(!value){el('[data-status]').textContent='W는1~10000000, L은유효한 수로 입력하세요.';return;}windowValue=value;schedule();};
      el('[data-reset]').onclick=()=>{windowValue=null;el('[data-width]').value=el('[data-center]').value='';schedule();};
      el('[data-retry]').onclick=()=>schedule(!groups.length);el('[data-close]').onclick=close;
      dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    }
    function open(value){
      if(!live()||!value||!uid(value.uid)||value.uid!==options.currentUid())return;
      ensure();close();study={...value};series=0;index=0;el('[data-series]').replaceChildren();el('[data-series]').disabled=true;el('[data-width]').value=el('[data-center]').value='';
      el('[data-identity]').textContent=`${value.name||''} (${value.id||''}) · ${value.date||''} · Study ${value.uid}`;
      dialog.showModal();schedule(true);
    }
    const storage=e=>{if(e.key==='kin-session-ended')end();};let channel=null;
    function end(){if(ended)return;close();ended=true;dialog?.remove();dialog=null;root.removeEventListener('storage',storage);root.removeEventListener('pagehide',end);channel?.close();}
    root.addEventListener('storage',storage);root.addEventListener('pagehide',end);try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
    return {open,close,sync,end};
  }
  const api={inventory,frameAt,windowing,mount};if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorklistImagePreview=api;
})(globalThis);
