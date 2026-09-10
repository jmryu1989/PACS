window.KinConsultations = function(app) {
  const dialog=document.createElement('dialog');dialog.id='consultations-dialog';dialog.setAttribute('aria-labelledby','consultations-title');
  dialog.innerHTML=`<h2 id="consultations-title">Consultations</h2>
    <p>같은 기관 판독의에게 자문을 의뢰합니다. 자문은 판독문·판독자 배정·영상 열람권을 변경하지 않습니다.</p>
    <div class="consultation-actions"><label>Folder <select id="co-direction"><option value="received">Received</option><option value="sent">Sent</option></select></label>
      <button id="co-reload" type="button">Reload</button><button id="co-new" type="button">Request for Selected Study</button></div>
    <div class="consultation-grid"><section aria-label="Consultation list">
      <label>Find in Loaded Requests <input id="co-search" type="search"></label>
      <label>Status <select id="co-state"><option value="">All</option><option>Requested</option><option>Accepted</option><option>Completed</option><option>Cancelled</option></select></label>
      <p id="co-count"></p><div id="co-list"></div><button id="co-more" type="button" hidden>Load More</button>
      <button id="co-filter" type="button">Show These Requests in Worklist</button></section>
    <section aria-label="Consultation details"><h3 id="co-heading">Select a Request</h3><p id="co-study"></p>
      <div id="co-create" hidden><label>Consultant <select id="co-reader"></select></label><label>Reason <textarea id="co-reason" maxlength="2000" rows="5"></textarea></label>
        <button id="co-send" type="button">Send Request</button></div>
      <div id="co-detail" hidden><p id="co-participants"></p><p id="co-current-state"></p><h4>Request Reason</h4><pre id="co-original"></pre>
        <h4>Reply / Cancellation Reason</h4><pre id="co-answer"></pre><button id="co-open-study" type="button">Open Study</button>
        <label>Reply or Cancellation Reason <textarea id="co-note" maxlength="2000" rows="5"></textarea></label>
        <div class="consultation-actions"><button id="co-accept" type="button">Accept</button><button id="co-complete" type="button">Complete with Reply</button><button id="co-cancel-request" type="button">Cancel Request</button></div></div>
    </section></div><p id="co-status" role="status" aria-live="polite"></p>
    <footer><button id="co-retry" type="button" hidden>Retry Same Request</button><button id="co-close" type="button">Close</button></footer>`;
  document.body.append(dialog);
  const $=id=>dialog.querySelector('#co-'+id);
  let owner=null,ended=false,busy=false,sequence=0,controller=null,pending=null,items=[],cursor=null,direction='received',row=null,createUid=null,opener=null;
  const same=()=>!ended&&dialog.open&&app.allowed()&&JSON.stringify(owner)===JSON.stringify(app.identity());
  const dirty=()=>!!$('reason').value||!!$('note').value;
  const identity=uid=>{const s=app.study(uid);return s?[s.name,s.id,s.date,s.desc,uid].filter(Boolean).join(' · '):uid+' · 목록을 새로고침하여 검사 정보를 확인하세요';};
  function controls() {
    for(const el of dialog.querySelectorAll('input,select,textarea,button'))el.disabled=busy||!!pending||!same();
    $('close').disabled=false;$('retry').hidden=!pending;$('retry').disabled=busy||!same();
    $('more').hidden=!cursor;
    const active=row&&['Requested','Accepted'].includes(row.state),recipient=row?.recipientSub===owner?.[1];
    $('accept').disabled=busy||!!pending||!same()||!recipient||row?.state!=='Requested';
    $('complete').disabled=busy||!!pending||!same()||!recipient||!active;
    $('cancel-request').disabled=busy||!!pending||!same()||!active||!(row?.requesterSub===owner?.[1]||app.admin());
    $('note').disabled=busy||!!pending||!same()||!active;
    $('open-study').disabled=busy||!!pending||!same()||!row||!app.study(row.studyUid);
  }
  function verified(value) {
    if(JSON.stringify(value?.owner)!==JSON.stringify(owner)){end();throw Error('자문 계정이 바뀌었습니다');}
    return value;
  }
  function item(value) {
    if(!value||typeof value.id!=='string'||typeof value.studyUid!=='string'||!['Requested','Accepted','Completed','Cancelled'].includes(value.state)
      ||!Number.isInteger(value.revision)||value.revision<1||value.institutionId!==owner?.[0])throw Error('자문 응답을 확인할 수 없습니다');
    return value;
  }
  const shown=()=>{const q=$('search').value.trim().toLocaleLowerCase(),state=$('state').value;
    return items.filter(r=>(!state||r.state===state)&&(!q||[identity(r.studyUid),r.requesterActor,r.recipientName,r.recipientActor,r.reason]
      .some(v=>String(v??'').toLocaleLowerCase().includes(q))));};
  function drawList() {
    const list=shown();$('count').textContent=`${list.length} shown / ${items.length} loaded${cursor?' · More Available':''}`;
    $('list').replaceChildren(...list.map(r=>{const b=document.createElement('button');b.type='button';b.dataset.consultation=r.id;
      b.textContent=`${r.state} · ${identity(r.studyUid)} · ${direction==='received'?r.requesterActor:r.recipientName}`;
      b.setAttribute('aria-pressed',String(row?.id===r.id));b.onclick=()=>{if(mayLeave())loadRow(r.id);};return b;}));controls();
  }
  function clearEditor() {row=null;createUid=null;$('reason').value=$('note').value='';$('create').hidden=$('detail').hidden=true;
    for(const id of ['study','participants','current-state','original','answer'])$(id).textContent='';$('reader').replaceChildren();$('heading').textContent='Select a Request';}
  function drawRow(value) {
    row=item(value);createUid=null;$('create').hidden=true;$('detail').hidden=false;$('heading').textContent='Request Details';
    $('study').textContent=identity(row.studyUid);$('participants').textContent=`From: ${row.requesterActor} · To: ${row.recipientName} · ${row.recipientActor}`;
    $('current-state').textContent=`${row.state} · ${new Date(row.updatedAt).toLocaleString()} · ${row.changedBy}`;
    $('original').textContent=row.reason;$('answer').textContent=row.reply||row.cancelReason||'—';$('reason').value=$('note').value='';drawList();
  }
  async function run(task) {
    if(busy||!same())return;const ticket=++sequence;busy=true;controls();controller=new AbortController();
    const local=controller,timer=setTimeout(()=>local.abort(),15000);
    try {await task(local.signal,()=>ticket===sequence&&same());}
    catch(e){if(ticket===sequence&&same())$('status').textContent='자문 처리 확인 실패: '+e.message+' · 입력은 유지했습니다.';}
    finally{clearTimeout(timer);if(ticket===sequence){busy=false;controller=null;controls();}}
  }
  function mayLeave(){return !busy&&(!pending&&!dirty()||confirm('저장하지 않은 입력이나 결과를 확인하지 못한 요청이 있습니다. 이동할까요?'));}
  function loadList(more=false) {
    if(pending||!same())return;
    const wanted=$('direction').value,next=more?cursor:null;
    run(async(signal,current)=>{
      $('status').textContent='자문 목록을 읽는 중…';
      const value=await app.api('GET','/consultations?direction='+wanted+(next?'&cursor='+encodeURIComponent(next):''),undefined,signal);
      if(!current())return;verified(value);
      if(value.direction!==wanted||!Array.isArray(value.items)||value.items.length>50||value.nextCursor!==null&&typeof value.nextCursor!=='string')throw Error('자문 목록 응답을 확인할 수 없습니다');
      const incoming=value.items.map(item),merged=more?[...items,...incoming]:incoming;
      if(new Set(merged.map(r=>r.id)).size!==merged.length)throw Error('자문 목록이 바뀌었습니다. Reload로 다시 읽으세요');
      direction=wanted;items=merged;cursor=value.nextCursor;drawList();$('status').textContent='현재 불러온 의뢰에서 검색·상태 필터를 적용합니다.';
    });
  }
  function loadRow(id) {
    pending=null;
    run(async(signal,current)=>{const value=await app.api('GET','/consultations/'+encodeURIComponent(id),undefined,signal);
      if(!current())return;verified(value);if(value.item?.id!==id)throw Error('자문 대상이 바뀌었습니다');drawRow(value.item);$('status').textContent='최신 자문 의뢰입니다.';});
  }
  function create() {
    if(!mayLeave())return;const study=app.current();if(!study){$('status').textContent='검사 목록에서 의뢰할 검사를 먼저 선택하세요.';return;}
    pending=null;clearEditor();createUid=study.uid;$('heading').textContent='New Consultation';$('study').textContent=identity(createUid);$('create').hidden=false;
    run(async(signal,current)=>{const value=await app.api('GET','/consultation-candidates',undefined,signal);if(!current())return;verified(value);
      if(!Array.isArray(value.readers))throw Error('수신자 목록을 확인할 수 없습니다');
      const blank=document.createElement('option');blank.value='';blank.textContent='Select Consultant';$('reader').replaceChildren(blank);
      for(const reader of value.readers){const option=document.createElement('option');option.value=reader.sub;option.textContent=reader.name+' · '+reader.actor;$('reader').append(option);}
      $('status').textContent='수신자와 의뢰 사유를 확인한 뒤 Send Request를 누르세요.';});
  }
  function send() {
    if(!pending)return;const request=pending;
    run(async(signal,current)=>{
      $('status').textContent='자문 요청을 저장하는 중…';
      try {
        const value=await app.api('POST',request.path,request.body,signal);if(!current())return;verified(value);
        if(value.item?.studyUid!==request.uid||value.item?.id!==request.id)throw Error('자문 저장 대상을 확인할 수 없습니다');
        const next=item(value.item);pending=null;items=items.map(r=>r.id===next.id?next:r);drawRow(next);$('status').textContent='자문 요청을 저장했습니다. 목록은 Reload로 갱신할 수 있습니다.';
      } catch(e) {
        if(current()&&[400,403,404,409].includes(e.status))pending=null;
        if(current()&&e.status===409&&request.path.startsWith('/consultations/')) {
          const note=$('note').value;
          try {
            const latest=await app.api('GET',request.path,undefined,signal);
            if(current()){verified(latest);if(latest.item?.id!==request.id)throw Error('자문 대상이 바뀌었습니다');const fresh=item(latest.item);items=items.map(r=>r.id===fresh.id?fresh:r);drawRow(fresh);$('note').value=note;e.message+=' · 최신 상태를 표시했습니다';}
          } catch(error) {if(current())e.message+=' · 최신 상태를 확인하지 못했습니다: '+error.message+' · 목록의 요청을 다시 선택하세요';}
        }
        throw e;
      }
    });
  }
  $('send').onclick=()=>{
    if(busy||pending||!same()||!createUid)return;
    if(!$('reader').value||!$('reason').value.trim()){$('status').textContent='수신자와 의뢰 사유를 입력하세요.';return;}
    const id=crypto.randomUUID();pending={id,uid:createUid,path:'/studies/'+encodeURIComponent(createUid)+'/consultations',
      body:{expectedOwner:owner,requestId:id,recipientSub:$('reader').value,reason:$('reason').value}};send();
  };
  for(const [control,action] of [['accept','accept'],['complete','complete'],['cancel-request','cancel']])$(control).onclick=()=>{
    if(busy||pending||!same()||!row)return;const note=action==='accept'?'':$('note').value;
    if(action!=='accept'&&!note.trim()){$('status').textContent='답변 또는 취소 사유를 입력하세요.';return;}
    pending={id:row.id,uid:row.studyUid,path:'/consultations/'+encodeURIComponent(row.id),body:{expectedOwner:owner,requestId:crypto.randomUUID(),revision:row.revision,action,note}};send();
  };
  function close(force=false) {
    if(!force&&(pending||dirty())&&!confirm('저장하지 않은 입력이나 결과를 확인하지 못한 요청이 있습니다. 닫을까요?'))return;sequence++;controller?.abort();controller=null;busy=false;pending=null;owner=null;items=[];cursor=null;clearEditor();$('list').replaceChildren();$('count').textContent=$('status').textContent='';$('search').value=$('state').value='';
    if(dialog.open)dialog.close();if(!force&&opener?.isConnected)opener.focus();opener=null;
  }
  function end(){ended=true;close(true);app.clearFilter();}
  $('close').onclick=()=>close();dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  $('new').onclick=create;$('retry').onclick=send;$('more').onclick=()=>loadList(true);
  $('reload').onclick=()=>{if(mayLeave()){pending=null;clearEditor();loadList();}};
  $('direction').onchange=()=>{if(!mayLeave()){$('direction').value=direction;return;}pending=null;clearEditor();loadList();};
  $('search').oninput=drawList;$('state').onchange=drawList;
  $('filter').onclick=()=>{if(!mayLeave())return;app.filter(shown().map(r=>r.studyUid),direction);close(true);};
  $('open-study').onclick=()=>{if(!row||!mayLeave())return;const uid=row.studyUid;if(!app.study(uid))return;close(true);app.openStudy(uid);};
  let channel;try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
  window.addEventListener('storage',e=>{if(e.key==='kin-session-ended')end();});window.addEventListener('pagehide',()=>{end();channel?.close();});
  return {refresh(){if(dialog.open){controls();if(!same())$('status').textContent='서버 연결과 계정을 확인하세요. 입력은 유지했습니다.';}},open(){if(ended||dialog.open||!app.allowed())return;owner=app.identity();if(!owner)return;opener=document.activeElement;
    direction=$('direction').value='received';$('search').value=$('state').value='';dialog.showModal();controls();loadList();}};
};
