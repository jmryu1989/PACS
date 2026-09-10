(function(root){
  'use strict';
  let active=null;
  const emptyRule=()=>({patientId:null,modalities:[],dateFrom:null,dateTo:null,studyUids:[]});
  function open(user){
    if(active){active.focus();return;}
    const owner=(()=>{const s=KinAuth.session();return [s?.institution,s?.sub];})();
    if(!owner.every(Boolean)||user.institution!==owner[0]||!user.enabled)return;
    const dialog=document.createElement('dialog');active=dialog;dialog.id='study-access-dialog';
    dialog.style.cssText='width:min(850px,calc(100vw - 32px));max-height:90vh;overflow:auto';
    dialog.innerHTML=`<form class="dialog-body" id="study-access-form"><h2>Study Access</h2><p data-target></p><p>기존 기관·역할 권한 안에서 검사 접근을 제한합니다. 원본 Patient ID·Modality·Study Date를 사용하며, 한 조건 안은 AND, 조건 사이는 OR입니다. Modality 중 하나가 포함되면 검사 전체에 적용됩니다. 접근 설정 이력이 있는 사용자는 기관 변경 후 새 기관 관리자의 명시적 설정 전까지 차단됩니다.</p><p data-status role="status"></p><fieldset data-editor disabled style="border:0;padding:0"><label>Access Mode<select name="mode"><option value="unrestricted">No Additional Restriction</option><option value="rules">Matching Studies</option><option value="all">All Studies in Existing Scope</option><option value="none">Deny All Studies</option></select></label><div class="form-grid" style="margin-top:12px"><label>Starts At (UTC)<input name="starts" type="datetime-local" step="1"></label><label>Ends At (UTC)<input name="ends" type="datetime-local" step="1"></label></div><p>시작 전·종료 후에는 검사 접근이 차단됩니다. 이미 받은 영상·작성 중인 판독문을 원격으로 지우지는 않습니다.</p><div data-rules></div><button type="button" data-add>Add OR Rule</button><label style="margin-top:12px">Change Reason<input name="reason" maxlength="2000" required autocomplete="off"></label></fieldset><div class="dialog-actions"><button type="button" data-close>Close</button><button type="button" data-reload>Reload</button><button type="button" data-retry hidden>Retry Same Request</button><button type="submit" data-save disabled>Save Access</button></div></form>`;
    const $=q=>dialog.querySelector(q),form=$('form'),status=$('[data-status]'),editor=$('[data-editor]'),rules=$('[data-rules]');
    $('[data-target]').textContent=`${user.name||user.username} · ${user.username} · ${user.institution}`;
    let generation=0,revision=null,pending=null,busy=false,dirty=false,closed=false;
    const sameOwner=()=>{const s=KinAuth.session();return s?.state==='approved'&&JSON.stringify([s.institution,s.sub])===JSON.stringify(owner);};
    function controls(){editor.disabled=busy||revision===null||!!pending;$('[data-save]').disabled=editor.disabled;$('[data-reload]').disabled=busy;$('[data-retry]').hidden=!pending;$('[data-retry]').disabled=busy;}
    function message(text){status.textContent=text;}
    function close(){if(busy||((dirty||pending)&&!confirm('저장되지 않았거나 결과를 확인하지 못한 변경이 있습니다. 닫으시겠습니까?')))return;dispose();}
    async function request(method,body){
      if(!sameOwner())throw Error('계정이 변경되었습니다. 다시 로그인하세요');
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
      try{
        const response=await fetch('/api/admin/users/'+encodeURIComponent(user.id)+'/study-access',{method,credentials:'same-origin',signal:controller.signal,headers:{'Content-Type':'application/json','X-KIN-CSRF':'1'},...(body?{body:JSON.stringify(body)}:{})});
        const result=await response.json().catch(()=>({}));
        if(!sameOwner())throw Error('계정이 변경되었습니다. 응답을 적용하지 않았습니다');
        if(!response.ok){const e=Error(typeof result.message==='string'?result.message:'접근 조건 요청을 처리하지 못했습니다');e.status=response.status;throw e;}
        if(JSON.stringify(result.owner)!==JSON.stringify(owner)||result.subject!==user.id||!Number.isInteger(result.revision))throw Error('접근 조건 응답의 사용자·버전을 확인하지 못했습니다');
        return result;
      }finally{clearTimeout(timer);}
    }
    function addRule(value=emptyRule()){
      if(rules.children.length>=10){message('조건은 최대10개입니다');return;}
      const box=document.createElement('fieldset');box.style.cssText='margin:12px 0;border:1px solid #355272';
      box.innerHTML=`<legend>OR Rule</legend><div class="form-grid"><label>Original Patient ID<input data-field="patientId" maxlength="256" autocomplete="off"></label><label>Modality<input data-field="modalities" placeholder="CT, MR" autocomplete="off"></label><label>Study Date From<input type="date" data-field="dateFrom"></label><label>Study Date To<input type="date" data-field="dateTo"></label><label class="full">Study UIDs<textarea data-field="studyUids" rows="3" maxlength="65000" style="background:#0b1625;color:inherit;border:1px solid #355272"></textarea></label></div><button type="button" data-remove>Remove Rule</button>`;
      for(const key of ['patientId','modalities','dateFrom','dateTo','studyUids'])box.querySelector('[data-field="'+key+'"]').value=Array.isArray(value[key])?value[key].join(key==='studyUids'?'\n':', '):value[key]||'';
      box.querySelector('[data-remove]').onclick=()=>{box.remove();dirty=true;};rules.append(box);
    }
    function modeChanged(){const mode=form.elements.mode.value;rules.hidden=mode!=='rules';$('[data-add]').hidden=mode!=='rules';form.elements.starts.disabled=mode==='unrestricted';form.elements.ends.disabled=mode==='unrestricted';}
    function render(result){
      const p=result.policy;if(!p||p.version!==1||typeof p.restricted!=='boolean'||!Array.isArray(p.rules))throw Error('저장된 접근 조건 형식을 확인하지 못했습니다');
      revision=result.revision;rules.replaceChildren();form.elements.mode.value=!p.restricted?'unrestricted':!p.rules.length?'none':p.rules[0].all?'all':'rules';
      for(const r of p.rules)if(!r.all)addRule(r);
      form.elements.starts.value=p.startsAt?p.startsAt.slice(0,19):'';form.elements.ends.value=p.endsAt?p.endsAt.slice(0,19):'';form.elements.reason.value='';modeChanged();dirty=false;
      message(`Revision ${revision} · ${p.restricted?'Restricted':'No Additional Restriction'}${result.needsInstitutionReview?' · 기관 변경 후 최초 설정이 필요합니다.':''}`);
    }
    async function reload(ask=true){
      if(busy||(ask&&(dirty||pending)&&!confirm('현재 입력·재시도 요청을 버리고 서버 설정을 불러오시겠습니까?')))return;
      const token=++generation;busy=true;controls();message('Loading');
      try{const r=await request('GET');if(closed||token!==generation)return;render(r);pending=null;}
      catch(e){message(e.message||'접근 조건을 불러오지 못했습니다');}
      finally{busy=false;if(!closed)controls();}
    }
    function policy(){
      const mode=form.elements.mode.value;
      const instant=name=>{const value=form.elements[name].value;if(!value)return null;const d=new Date(value+'Z');if(!Number.isFinite(d.getTime()))throw Error('UTC 시각을 확인하세요');return d.toISOString();};
      return {version:1,restricted:mode!=='unrestricted',startsAt:mode==='unrestricted'?null:instant('starts'),endsAt:mode==='unrestricted'?null:instant('ends'),rules:mode==='all'?[{all:true}]:mode!=='rules'?[]:[...rules.children].map(box=>{
        const v=key=>box.querySelector('[data-field="'+key+'"]').value.trim();return {patientId:v('patientId')||null,modalities:v('modalities')?v('modalities').split(/[,\s]+/).map(x=>x.toUpperCase()):[],dateFrom:v('dateFrom')||null,dateTo:v('dateTo')||null,studyUids:v('studyUids')?v('studyUids').split(/[,\s]+/):[]};})};
    }
    async function save(retry=false){
      if(busy||revision===null)return;
      if(!retry){
        if(pending||!form.reportValidity())return;
        try{const p=policy();if(form.elements.mode.value==='rules'&&!p.rules.length)throw Error('조건을 추가하거나 Deny All Studies를 명시적으로 선택하세요');pending={expectedOwner:owner,revision,policy:p,reason:form.elements.reason.value,requestId:crypto.randomUUID()};}
        catch(e){message(e.message);return;}
      }
      busy=true;controls();message('Saving');const token=++generation;
      try{const result=await request('POST',pending);if(closed||token!==generation)return;pending=null;dirty=false;revision=null;message(`Saved · Revision ${result.revision}. Reload로 현재 설정을 확인하세요.`);}
      catch(e){message((e.message||'저장 결과를 확인하지 못했습니다')+' · 입력을 유지했습니다.');if([400,403,404,409].includes(e.status)){pending=null;if(e.status===409)revision=null;}}
      finally{busy=false;if(!closed)controls();}
    }
    form.addEventListener('input',()=>{dirty=true;});form.elements.mode.onchange=modeChanged;
    $('[data-add]').onclick=()=>{addRule();dirty=true;};$('[data-reload]').onclick=()=>reload();$('[data-retry]').onclick=()=>save(true);$('[data-close]').onclick=close;
    form.onsubmit=e=>{e.preventDefault();save();};dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    let channel=null;
    function dispose(){closed=true;generation++;dialog.remove();if(active===dialog)active=null;channel?.close();window.removeEventListener('storage',onStorage);window.removeEventListener('pagehide',dispose);}
    const onStorage=e=>{if(e.key==='kin-session-ended')dispose();};
    try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')dispose();};}catch(e){}
    window.addEventListener('pagehide',dispose,{once:true});
    window.addEventListener('storage',onStorage);
    document.body.append(dialog);dialog.showModal();reload(false);
  }
  root.KinStudyAccessAdmin={open};
})(window);
