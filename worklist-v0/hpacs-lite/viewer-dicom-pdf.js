/* Source DICOM PDF opening stays bound to the selected native OHIF display set. */
(function(root){
  'use strict';
  const HANDLER='@ohif/extension-dicom-pdf.sopClassHandlerModule.dicom-pdf';
  const PDF_SOP='1.2.840.10008.5.1.4.1.1.104.1';
  const uid=value=>typeof value==='string'&&value.length<=64&&/^\d+(?:\.\d+)+$/.test(value);
  const ownerOf=value=>value&&value.kind==='member'&&typeof value.institution==='string'&&value.institution&&typeof value.sub==='string'&&value.sub?{institution:value.institution,subject:value.sub}:null;
  const sameOwner=(a,b)=>!!a&&!!b&&a.institution===b.institution&&a.subject===b.subject;
  const json=async response=>{try{return await response.json();}catch(_){throw Error('응답 형식을 확인할 수 없습니다.');}};

  function create(services,options={}){
    const grid=services?.viewportGridService,sets=services?.displaySetService;
    const fetcher=options.fetch||root.fetch?.bind(root),openWindow=options.open||root.open?.bind(root);
    const timeoutMs=Number.isInteger(options.timeoutMs)&&options.timeoutMs>0?options.timeoutMs:10000;
    let ended=false,mounted=false,hostTimer=null,channel=null,boundOwner=null,ownerError=null,source=null,generation=0,request=null,sourceRequest=null,ownerRequest=null,pendingWindow=null,nativeRetryNeeded=false,nativeRetryPending=false,nativeRetrySource=null;
    const subscriptions=[];
    const panel=root.document.createElement('section');panel.id='kin-source-pdf';panel.hidden=true;
    panel.innerHTML='<style>#kin-source-pdf{border-top:1px solid #355272;padding:8px 10px}#kin-source-pdf h3{margin:0 0 5px;font-size:14px}#kin-source-pdf p{margin:3px 0;overflow-wrap:anywhere}#kin-source-pdf button{margin-top:5px;padding:4px 7px;border:1px solid #657c9f;border-radius:4px}</style><h3>Source Documents</h3><p data-title></p><p data-role></p><p data-patient></p><p id="kin-source-pdf-status" role="status"></p><button id="kin-source-pdf-open" type="button" disabled>Open Source PDF</button>';
    const title=panel.querySelector('[data-title]'),role=panel.querySelector('[data-role]'),patient=panel.querySelector('[data-patient]'),status=panel.querySelector('[role=status]'),button=panel.querySelector('button');
    const currentState=()=>grid?.getState?.();
    function studies(){
      const all=new URLSearchParams(root.location.search).getAll('StudyInstanceUIDs');if(all.length!==1)return null;
      const values=all[0].split(',');return values.length>=1&&values.length<=2&&values.every(uid)&&new Set(values).size===values.length?values:null;
    }
    function selection(){
      const state=currentState(),viewportId=state?.activeViewportId||grid?.getActiveViewportId?.(),viewport=state?.viewports?.get?.(viewportId),ids=viewport?.displaySetInstanceUIDs;
      if(!viewportId||!Array.isArray(ids)||!ids.length)return {kind:'none'};
      const selected=ids.map(id=>sets?.getDisplaySetByUID?.(id)).filter(Boolean),pdf=selected.filter(value=>value.SOPClassHandlerId===HANDLER);
      if(!pdf.length)return {kind:'none'};if(ids.length!==1||pdf.length!==1)return {kind:'invalid'};
      const displaySet=pdf[0],instance=displaySet?.instance,scope=studies();
      if(!instance||!scope||displaySet.SOPClassUID!==PDF_SOP||instance.SOPClassUID!==PDF_SOP)return {kind:'invalid'};
      const study=displaySet.StudyInstanceUID,series=displaySet.SeriesInstanceUID,sop=displaySet.SOPInstanceUID;
      const patientId=instance.PatientID;
      if(![study,series,sop].every(uid)||instance.StudyInstanceUID!==study||instance.SeriesInstanceUID!==series||instance.SOPInstanceUID!==sop||!scope.includes(study)||typeof patientId!=='string'||!patientId.trim()||patientId.length>64||displaySet.PatientID!==undefined&&displaySet.PatientID!==patientId)return {kind:'invalid'};
      if(instance.MIMETypeOfEncapsulatedDocument!=='application/pdf'||instance.EncapsulatedDocument?.DirectRetrieveURL||instance.EncapsulatedDocument?.InlineBinary)return {kind:'invalid'};
      const views=[...state.viewports.values()].map(v=>[v.viewportId,v.x??null,v.y??null,v.width??null,v.height??null,v.displaySetInstanceUIDs||[]]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
      const layout=state.layout||{};const gridSignature=JSON.stringify([state.activeViewportId,layout.layoutType??null,layout.numRows??null,layout.numCols??null,views]);
      return {kind:'valid',value:{viewportId,displaySetId:ids[0],displaySet,study,series,sop,patientId,gridSignature,role:scope.indexOf(study)===0?'Current':'Related',title:typeof displaySet.SeriesDescription==='string'&&displaySet.SeriesDescription.trim()?displaySet.SeriesDescription.trim():'PDF Document',pdfUrl:displaySet.pdfUrl}};
    }
    const candidate=()=>{const selected=selection();return selected.kind==='valid'?selected.value:null;};
    const sameSource=(a,b)=>!!a&&!!b&&a.viewportId===b.viewportId&&a.displaySetId===b.displaySetId&&a.displaySet===b.displaySet&&a.study===b.study&&a.series===b.series&&a.sop===b.sop&&a.patientId===b.patientId&&a.gridSignature===b.gridSignature&&a.search===b.search;
    const sameNativeSource=(value,displaySet,pdfUrl)=>!!value&&value.displaySet===displaySet&&value.pdfUrl===pdfUrl;
    const snapshot=value=>value&&({...value,search:root.location.search});
    const live=value=>!ended&&sameSource(value,snapshot(candidate()));
    function closeWindow(target){if(target&&!target.closed)try{target.close();}catch(_){} }
    function cancelOperation(){const active=request;request=null;if(!active)return;active.controller.abort();if(pendingWindow===active.popup)pendingWindow=null;closeWindow(active.popup);}
    function cancelSource(){sourceRequest?.controller.abort();sourceRequest=null;}
    function unavailable(message='Select a supported source PDF document.'){
      source=null;generation++;cancelOperation();cancelSource();panel.hidden=true;button.textContent='Open Source PDF';button.disabled=true;patient.textContent='';status.textContent=message;
    }
    async function resolveSource(value,ticket){
      const controller=new AbortController(),signal=controller.signal,operation={controller,value};cancelSource();sourceRequest=operation;
      const init=(method='GET',body)=>({method,credentials:'same-origin',cache:'no-store',signal,headers:{'X-KIN-CSRF':'1',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      const sourceOwns=()=>!ended&&sourceRequest===operation&&ticket===generation&&live(value),sourceLive=()=>sourceOwns()&&!signal.aborted;
      const reply=async(path,options)=>{const result=await fetcher(path,options);if(!sourceLive())throw Error('선택한 원본 문서가 변경되었습니다.');if(!result?.ok){const error=Error(result?.status===401||result?.status===403?'로그인 또는 검사 접근 권한을 확인하세요.':'원본 PDF 확인 요청을 완료하지 못했습니다.');error.retryable=!result||result.status===429||result.status>=500;throw error;}const data=await json(result);if(!sourceLive())throw Error('선택한 원본 문서가 변경되었습니다.');return data;};
      const work=(async()=>{
        const raw=await value.pdfUrl;if(!sourceLive())return;
        if(typeof raw!=='string')throw Error('원본 PDF 경로를 확인할 수 없습니다.');
        const parsed=new URL(raw,root.location.href),expected='/dicom-web/studies/'+value.study+'/series/'+value.series+'/instances/'+value.sop+'/rendered';
        if(parsed.origin!==root.location.origin||parsed.pathname!==expected||parsed.search||parsed.hash||parsed.username||parsed.password)throw Error('원본 PDF 경로를 확인할 수 없습니다.');
        const first=ownerOf(await reply('/api/me',init()));if(!first)throw Error('로그인 세션을 확인할 수 없습니다.');if(!sameOwner(first,boundOwner))throw Error('계정이 변경되어 원본 PDF를 표시하지 않았습니다.');
        const lookup=await reply('/api/dicom/lookup',init('POST',{studyUid:value.study,sopUid:value.sop}));
        if(!lookup||Object.keys(lookup).length!==1||typeof lookup.id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(lookup.id))throw Error('원본 PDF 식별을 확인할 수 없습니다.');
        const last=ownerOf(await reply('/api/me',init()));if(!sameOwner(first,last)||!sameOwner(last,boundOwner))throw Error('계정이 변경되어 원본 PDF를 표시하지 않았습니다.');
        const url=new URL('/instances/'+lookup.id+'/pdf',root.location.origin),path='/instances/'+lookup.id+'/pdf';
        if(url.origin!==root.location.origin||url.pathname!==path||url.search||url.hash||url.username||url.password)throw Error('원본 PDF 경로를 확인할 수 없습니다.');
        if(!sourceLive())return;source={...value,url:url.href,orthancId:lookup.id,owner:first};const nativeError=options.nativeFailureFor?.(value.displaySet,value.pdfUrl);
        if(nativeError){nativeRetryNeeded=true;nativeRetryPending=false;nativeRetrySource={displaySet:value.displaySet,pdfUrl:value.pdfUrl};button.textContent='Retry Source PDF';button.disabled=false;status.textContent=nativeError.message||'원본 PDF 표시를 완료하지 못했습니다. 다시 시도하세요.';}
        else{button.textContent='Open Source PDF';button.disabled=false;status.textContent='Ready · 브라우저 PDF 도구에서 페이지 이동·검색·인쇄를 사용할 수 있습니다.';}
      })();
      let timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{const error=Error('원본 PDF 확인 시간이 지났습니다. 다시 시도하세요.');error.retryable=true;reject(error);controller.abort();},timeoutMs);});
      const stopped=new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
      try{await Promise.race([work,deadline,stopped]);}
      catch(error){if(sourceOwns()){source=null;const retryable=!!error?.retryable||error?.name==='AbortError'||error instanceof TypeError;button.textContent=retryable?'Retry Source PDF':'Open Source PDF';button.disabled=!retryable||!boundOwner;status.textContent=ownerError||(error?.name==='AbortError'||error instanceof TypeError?'원본 PDF 확인 요청을 완료하지 못했습니다.':error.message)||'원본 PDF 경로를 확인할 수 없습니다.';}}
      finally{clearTimeout(timer);if(sourceRequest===operation)sourceRequest=null;}
    }
    function refresh(){
      if(ended)return;const next=snapshot(candidate());
      if(nativeRetrySource&&!sameNativeSource(next,nativeRetrySource.displaySet,nativeRetrySource.pdfUrl)){nativeRetryNeeded=false;nativeRetryPending=false;nativeRetrySource=null;}
      if(source&&sameSource(source,next)){const ready=sameOwner(boundOwner,source.owner);if(nativeRetryNeeded){button.textContent='Retry Source PDF';button.disabled=!!request||nativeRetryPending||!boundOwner;return;}button.textContent='Open Source PDF';button.disabled=!!request||!ready;if(!request)status.textContent=ready?'Ready · 브라우저 PDF 도구에서 페이지 이동·검색·인쇄를 사용할 수 있습니다.':(ownerError||'계정이 변경되어 원본 PDF를 표시하지 않았습니다.');return;}
      if(sourceRequest&&sameSource(sourceRequest.value,next)){button.disabled=true;status.textContent=ownerError||'Checking source path…';return;}
      generation++;cancelOperation();cancelSource();source=null;patient.textContent='';
      if(!next){const selected=selection();if(selected.kind==='invalid'){panel.hidden=false;title.textContent='';role.textContent='';status.textContent='선택한 원본 PDF를 지원하지 않거나 식별 정보가 일치하지 않습니다.';button.textContent='Open Source PDF';button.disabled=true;}else unavailable();return;}
      panel.hidden=false;title.textContent=next.title;role.textContent=next.role+' source PDF';status.textContent=ownerError||(!boundOwner?'Checking session…':'Checking source path…');button.disabled=true;
      if(!boundOwner)return;
      resolveSource(next,generation);
    }
    function assertLive(operation){if(request!==operation||operation.controller.signal.aborted||operation.generation!==generation||!live(operation.before)||source?.url!==operation.before.url||source?.orthancId!==operation.before.orthancId||!sameOwner(source?.owner,operation.before.owner))throw Error('선택한 원본 문서가 변경되어 열지 않았습니다.');if(operation.popup.closed)throw Error('PDF 창이 닫혀 열기를 취소했습니다.');}
    async function response(path,init,operation){
      const result=await fetcher(path,init);assertLive(operation);if(!result?.ok)throw Error(result?.status===401||result?.status===403?'로그인 또는 검사 접근 권한을 확인하세요.':'원본 PDF 확인 요청을 완료하지 못했습니다.');const data=await json(result);assertLive(operation);return data;
    }
    async function preflight(operation,init){
      assertLive(operation);const result=await fetcher(operation.before.url,init);assertLive(operation);
      const type=result?.headers?.get?.('content-type')?.split(';',1)[0].trim().toLowerCase(),valid=result?.status===200&&result.ok&&type==='application/pdf';
      let cancelError=null;try{await result?.body?.cancel?.();}catch(error){cancelError=error;}assertLive(operation);
      if(!valid)throw Error('원본 PDF 응답을 확인할 수 없습니다.');
      if(cancelError)throw cancelError;
    }
    async function open(){
      if(ended||request||!boundOwner)return;if(nativeRetryNeeded){if(nativeRetryPending||!nativeRetrySource)return;nativeRetryPending=true;options.onRetry?.(nativeRetrySource.displaySet,nativeRetrySource.pdfUrl);button.textContent='Retry Source PDF';button.disabled=true;status.textContent='Checking native PDF…';return;}if(!source){button.disabled=true;button.textContent='Retry Source PDF';refresh();return;}
      let popup;try{popup=openWindow('','_blank');if(!popup)throw Error('popup');popup.opener=null;}catch(_){try{popup?.close();}catch(__){}status.textContent='팝업이 차단되어 Source PDF를 열지 못했습니다.';return;}
      const before=snapshot(source),owner={...boundOwner},controller=new AbortController(),operation={popup,controller,before,generation};pendingWindow=popup;request=operation;const signal=controller.signal,timer=setTimeout(()=>controller.abort(),10000);button.disabled=true;patient.textContent='';status.textContent='Verifying source PDF…';
      const init=(method='GET',body)=>({method,credentials:'same-origin',cache:'no-store',signal,headers:{'X-KIN-CSRF':'1',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      try{
        const first=ownerOf(await response('/api/me',init(),operation));if(!sameOwner(first,owner))throw Error('계정이 변경되어 PDF를 열지 않았습니다.');assertLive(operation);
        const lookup=await response('/api/dicom/lookup',init('POST',{studyUid:before.study,sopUid:before.sop}),operation);
        if(!lookup||Object.keys(lookup).length!==1||typeof lookup.id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(lookup.id))throw Error('원본 PDF 식별을 확인할 수 없습니다.');assertLive(operation);
        const parsed=new URL(before.url,root.location.href),expected='/instances/'+lookup.id+'/pdf';if(lookup.id!==before.orthancId||parsed.origin!==root.location.origin||parsed.pathname!==expected||parsed.search||parsed.hash||parsed.username||parsed.password)throw Error('원본 PDF 식별을 확인할 수 없습니다.');assertLive(operation);
        const listing=await response('/api/studies',init(),operation),matches=Array.isArray(listing?.studies)?listing.studies.filter(item=>item?.uid===before.study):[];
        if(matches.length!==1||matches[0].id!==before.patientId)throw Error('원본 환자 식별을 확인할 수 없습니다.');assertLive(operation);
        await preflight(operation,init());assertLive(operation);
        const last=ownerOf(await response('/api/me',init(),operation));if(!sameOwner(last,owner))throw Error('계정이 변경되어 PDF를 열지 않았습니다.');assertLive(operation);
        patient.textContent='Verified Patient ID: '+matches[0].id;try{popup.location.replace(before.url);}catch(_){throw Error('PDF 창을 열 수 없습니다.');}if(pendingWindow===popup)pendingWindow=null;if(request===operation)status.textContent='Opened source PDF · 브라우저 PDF 도구에서 페이지 이동·검색·인쇄를 사용할 수 있습니다.';
      }catch(error){closeWindow(popup);if(pendingWindow===popup)pendingWindow=null;if(!ended&&request===operation){patient.textContent='';status.textContent=error?.name==='AbortError'||error instanceof TypeError?'원본 PDF 확인 요청을 완료하지 못했습니다.':error.message;}}
      finally{clearTimeout(timer);if(request===operation){request=null;if(!ended){const ready=!!source&&sameOwner(boundOwner,source.owner);button.textContent=nativeRetryNeeded||!ready?'Retry Source PDF':'Open Source PDF';button.disabled=nativeRetryNeeded?nativeRetryPending||!boundOwner:!ready;}}}
    }
    button.addEventListener('click',open);
    async function bindOwner(){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);ownerRequest=controller;
      try{const reply=await fetcher('/api/me',{credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'X-KIN-CSRF':'1'}}),data=reply?.ok?await json(reply):null,next=ownerOf(data);if(!next)throw Error();if(!ended&&ownerRequest===controller){boundOwner=next;refresh();}}
      catch(_){if(!ended&&ownerRequest===controller){boundOwner=null;ownerError='로그인 세션을 확인할 수 없습니다. 뷰어를 다시 여세요.';status.textContent=ownerError;button.disabled=true;}}
      finally{clearTimeout(timer);if(ownerRequest===controller)ownerRequest=null;}
    }
    function attach(){const host=root.document.querySelector('#kin-viewer-layout');if(!host)return false;if(!panel.isConnected)host.append(panel);mounted=true;refresh();return true;}
    function mount(){
      if(ended||mounted)return api;let attempts=0;if(!attach())hostTimer=setInterval(()=>{if(ended||attach()){clearInterval(hostTimer);hostTimer=null;}else if(++attempts>=200)stop();},100);
      try{for(const event of new Set(Object.values(grid?.EVENTS||{})))subscriptions.push(grid.subscribe(event,refresh));}catch(_){subscriptions.splice(0).forEach(item=>item.unsubscribe?.());}
      root.addEventListener?.('storage',storageEnd);try{channel=new BroadcastChannel('kin-session');channel.onmessage=event=>{if(event.data?.type==='session-ended')stop();};}catch(_){}
      bindOwner();return api;
    }
    function stop(){if(ended)return;ended=true;generation++;cancelOperation();cancelSource();ownerRequest?.abort();ownerRequest=null;if(hostTimer)clearInterval(hostTimer);hostTimer=null;subscriptions.splice(0).forEach(item=>item.unsubscribe?.());channel?.close();root.removeEventListener?.('storage',storageEnd);panel.remove();}
    function nativeFailure(error,displaySet,pdfUrl){const selected=snapshot(candidate());if(ended||!sameNativeSource(selected,displaySet,pdfUrl))return;nativeRetryNeeded=true;nativeRetryPending=false;nativeRetrySource={displaySet,pdfUrl};button.textContent='Retry Source PDF';button.disabled=!!request||!boundOwner;status.textContent=error?.message||'원본 PDF 표시를 완료하지 못했습니다. 다시 시도하세요.';}
    function nativeReady(displaySet,pdfUrl){const selected=snapshot(candidate());if(ended||!nativeRetryNeeded||!nativeRetrySource||nativeRetrySource.displaySet!==displaySet||nativeRetrySource.pdfUrl!==pdfUrl||!sameNativeSource(selected,displaySet,pdfUrl))return;nativeRetryNeeded=false;nativeRetryPending=false;nativeRetrySource=null;button.textContent='Open Source PDF';const ready=!!source&&sameOwner(boundOwner,source.owner);button.disabled=!ready;status.textContent=ready?'Ready · 브라우저 PDF 도구에서 페이지 이동·검색·인쇄를 사용할 수 있습니다.':'Checking source path…';}
    const storageEnd=event=>{if(event.key==='kin-session-ended')stop();};
    const api={mount,stop,nativeFailure,nativeReady};return api;
  }
  root.KinDicomPdf={create};if(typeof module==='object'&&module.exports)module.exports=root.KinDicomPdf;
})(typeof globalThis==='object'?globalThis:this);
