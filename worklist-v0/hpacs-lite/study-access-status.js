(function(root){
  'use strict';
  function mount(options){
    const button=options.button;if(!button)return;
    const owner=()=>{const s=options.session();return s?.state==='approved'&&!s.demo&&s.sub&&s.institution?[s.institution,s.sub]:null;};
    const initial=owner();if(!initial)return;
    let last=null,lastVerified=null,needsRefresh=false,busy=false,ended=false,dialog=null,controller=null;
    const current=()=>!ended&&JSON.stringify(owner())===JSON.stringify(initial);
    button.disabled=false;button.textContent='Study Access';
    function render(){
      button.textContent=!last?'Study Access: Unverified':!last.restricted?'Study Access':last.denied?'Study Access: Denied':'Study Access: Restricted';
      button.title='현재 사용자에게 적용되는 검사 접근 조건 상태';
      if(dialog){
        dialog.querySelector('[data-status]').textContent=!last?'접근 조건을 확인하지 못했습니다.':`Revision ${last.revision} · ${!last.restricted?'No Additional Restriction':last.denied?'Denied':'Restricted'}`;
        dialog.querySelector('[data-period]').textContent=last?.needsInstitutionReview?'기관이 변경되어 새 기관 관리자의 접근 설정이 필요합니다.':last?.restricted?`UTC ${last.startsAt||'Open Start'} → ${last.endsAt||'Open End'}`:'';
      }
    }
    async function check(refresh=false){
      if(busy||!current())return;busy=true;controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
      try{
        const r=await fetch('/api/study-access',{credentials:'same-origin',cache:'no-store',signal:controller.signal});const value=await r.json();
        if(!current())return;
        if(!r.ok||JSON.stringify(value.owner)!==JSON.stringify(initial)||!Number.isInteger(value.revision)||typeof value.restricted!=='boolean'||typeof value.windowOpen!=='boolean'||typeof value.denied!=='boolean')throw Error();
        const changed=lastVerified&&(lastVerified.revision!==value.revision||lastVerified.windowOpen!==value.windowOpen||lastVerified.denied!==value.denied||lastVerified.needsInstitutionReview!==value.needsInstitutionReview);
        needsRefresh=needsRefresh||!!changed||refresh;last=value;lastVerified=value;render();
        // Refresh through the worklist's existing owner/epoch and unsaved-editor
        // protection. Never directly replace a report or discard local text.
        if(needsRefresh)needsRefresh=(await options.refresh())===false;
      }catch(e){if(current()){last=null;render();}}
      finally{clearTimeout(timer);busy=false;controller=null;}
    }
    button.onclick=()=>{
      if(!current())return;
      if(!dialog){dialog=document.createElement('dialog');dialog.id='study-access-status';dialog.style.cssText='max-width:520px;color:inherit;background:#142237;border:1px solid #355272;padding:20px';dialog.innerHTML='<h2>Study Access</h2><p data-status role="status"></p><p data-period></p><p>검사 목록·영상·판독·저장 참조에 추가 조건이 적용됩니다. 접근 기간이 끝나면 새 요청이 차단됩니다. 작성 중인 판독문은 지우지 않습니다. 조건 변경은 기관 관리자에게 요청하세요.</p><button type="button" data-refresh>Refresh Status</button> <button type="button" data-close>Close</button>';dialog.querySelector('[data-refresh]').onclick=()=>check(true);dialog.querySelector('[data-close]').onclick=()=>dialog.close();document.body.append(dialog);}
      render();dialog.showModal();check();
    };
    function end(){if(ended)return;ended=true;clearInterval(interval);controller?.abort();last=null;lastVerified=null;needsRefresh=false;dialog?.remove();dialog=null;button.disabled=true;button.textContent='Study Access';channel?.close();}
    const interval=setInterval(()=>{if(!document.hidden)check();},30000);let channel=null;
    try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(e){}
    window.addEventListener('storage',e=>{if(e.key==='kin-session-ended')end();});window.addEventListener('pagehide',end);
    check();return {check,end};
  }
  root.KinStudyAccessStatus={mount};
})(window);
