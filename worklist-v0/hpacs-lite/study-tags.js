window.KinStudyTags=function(app){
  const d=document.createElement('dialog');d.id='study-tag-dialog';d.setAttribute('aria-labelledby','study-tag-title');
  d.innerHTML=`<h2 id="study-tag-title">검사 태그 관리·검색</h2><p>개인 태그는 이 계정에서만 보입니다. 기관 태그 이름은 관리자가 관리하고, 검사 부여·해제는 기관 업무 사용자가 할 수 있습니다. 태그를 지워도 원검사·판독문은 유지됩니다.</p>
    <label>태그 범위<select id="study-tag-scope"><option value="personal">개인 태그</option><option value="institution">기관 태그</option></select></label>
    <div class="study-tag-layout"><aside><label>새 태그 이름<input id="study-tag-new" maxlength="120"></label><button id="study-tag-create" type="button">태그 만들기</button><div id="study-tag-list"></div></aside>
    <section><label>태그 이름<input id="study-tag-name" maxlength="120"></label><button id="study-tag-rename" type="button">이름 변경</button> <button id="study-tag-delete" type="button">태그 삭제</button>
    <p id="study-tag-current"></p><p id="study-tag-assigned"></p><button id="study-tag-add" type="button">선택 검사에 부여</button> <button id="study-tag-remove" type="button">선택 검사에서 해제</button><p id="study-tag-count"></p><button id="study-tag-apply" type="button">이 태그의 검사 목록 보기</button></section></div>
    <p id="study-tag-status" role="status"></p><footer><button id="study-tag-retry" type="button" hidden>같은 요청 다시 시도</button><button id="study-tag-reload" type="button">최신 목록 다시 읽기</button><button id="study-tag-close" type="button">닫기</button></footer>`;document.body.append(d);
  const $=id=>d.querySelector('#study-tag-'+id);let owner=null,state=null,scope='personal',selected=null,current=null,busy=false,pending=null,seq=0,abort=null,ended=false,opener=null;
  const same=()=>!ended&&d.open&&app.allowed()&&JSON.stringify(owner)===JSON.stringify(app.identity());
  const catalog=()=>state?.catalogs.find(x=>x.scope===scope),tag=()=>catalog()?.tags.find(x=>x.id===selected);
  const manages=()=>scope==='personal'||state?.canManageInstitution===true;
  const dirty=()=>!!$('new').value||!!tag()&&$('name').value!==tag().name;
  const label=uid=>{const s=app.study(uid);return s?[s.name,s.id,s.date,s.desc,uid].filter(Boolean).join(' · '):uid;};
  const message=text=>$('status').textContent=text;
  function controls(){d.querySelectorAll('button,input,select').forEach(x=>x.disabled=busy||!!pending||!same());
    $('retry').hidden=!pending;$('retry').disabled=busy;$('reload').disabled=busy;$('close').disabled=busy;
    for(const id of ['create','rename','delete'])$(id).disabled=busy||!!pending||!same()||!manages()||(id!=='create'&&!tag());
    $('name').disabled=busy||!!pending||!tag()||!manages();$('new').disabled=busy||!!pending||!manages();
    for(const id of ['add','remove','apply'])$(id).disabled=busy||!!pending||!same()||!tag()||(id!=='apply'&&!current);
  }
  function adopt(value){
    if(!value||JSON.stringify(value.owner)!==JSON.stringify(owner)){end();app.notice('태그 계정이 바뀌었습니다. 페이지를 새로고침하세요.');throw new Error('태그 계정 변경');}
    if(!Array.isArray(value.catalogs)||value.catalogs.length!==2||new Set(value.catalogs.map(c=>c.scope)).size!==2||value.catalogs.some(c=>!['personal','institution'].includes(c.scope)||!Number.isInteger(c.revision)||!Array.isArray(c.tags)||c.tags.some(t=>typeof t.id!=='string'||typeof t.name!=='string'||!Array.isArray(t.uids)||t.uids.some(x=>typeof x!=='string'))))throw new Error('태그 목록 형식을 확인할 수 없습니다');
    state=value;app.changed(value);
  }
  function draw(preserve=false){const previous=selected;if(!tag())selected=catalog()?.tags[0]?.id??null;$('scope').value=scope;$('list').replaceChildren();
    for(const t of catalog()?.tags??[]){const b=document.createElement('button');b.type='button';b.dataset.tagId=t.id;b.textContent=t.name+' · '+t.uids.length+'건'+(current&&t.uids.includes(current)?' · 선택 검사에 부여됨':'');b.setAttribute('aria-pressed',String(t.id===selected));b.onclick=()=>{if(t.id!==selected&&dirty()&&!confirm('저장하지 않은 태그 이름 입력을 버릴까요?'))return;$('new').value='';selected=t.id;draw();};$('list').append(b);}
    const t=tag();if(!preserve||previous!==selected)$('name').value=t?.name??'';$('current').textContent=current?'대상 검사 · '+label(current):'목록에서 검사를 먼저 선택하세요.';
    $('assigned').textContent=t&&current?(t.uids.includes(current)?'이 검사에 부여된 태그입니다.':'이 검사에는 아직 부여되지 않았습니다.'):'태그를 선택하세요.';
    $('count').textContent=t?'접근 가능한 검사 '+t.uids.length+'건'+(t.unavailable?' · 접근 불가 '+t.unavailable+'건':''):'';controls();}
  async function request(method,body){abort=new AbortController();const local=abort,timer=setTimeout(()=>local.abort(),12000);try{return await app.api(method,'/study-tags',body,local.signal);}finally{clearTimeout(timer);if(abort===local)abort=null;}}
  async function load(){if(busy||!same())return;const ticket=++seq,unresolved=pending;busy=true;controls();message('태그를 읽는 중…');
    try{const value=await request('GET');if(ticket!==seq||!same())return;adopt(value);pending=unresolved&&catalog()?.revision===unresolved.revision?unresolved:null;draw(true);message(pending?'요청이 아직 반영되지 않았습니다. 같은 요청을 다시 시도할 수 있습니다.':unresolved?'최신 목록을 읽고 재시도 대기를 해제했습니다. 반영 결과를 확인하세요.':'계정의 최신 태그 목록입니다.');}
    catch(e){if(ticket===seq&&same())message('태그 조회 실패: '+e.message);}finally{if(ticket===seq){busy=false;controls();}}}
  async function command(action,extra={}){if(busy||pending||!same()||!catalog())return;
    if(['add','remove'].includes(action)&&current!==app.current()){current=app.current();draw(true);message('선택 검사가 바뀌었습니다. 대상을 확인하고 다시 누르세요.');return;}
    if(action==='create'&&tag()&&$('name').value!==tag().name&&!confirm('저장하지 않은 태그 이름 변경을 버리고 새 태그를 만들까요?'))return;
    pending={expectedOwner:owner,scope,revision:catalog().revision,requestId:crypto.randomUUID(),tagId:action==='create'?crypto.randomUUID():selected,action,...extra};await send();}
  async function send(){if(busy||!pending||!same())return;const ticket=++seq,body=pending;busy=true;controls();message('태그 변경을 저장하는 중…');
    try{const value=await request('POST',body);if(ticket!==seq||!same())return;adopt(value);pending=null;if(body.action==='create'){selected=body.tagId;$('new').value='';}draw(['add','remove'].includes(body.action));message('저장되었습니다.');}
    catch(e){if(ticket===seq&&same()){if([400,403,404,409].includes(e.status))pending=null;message('저장 확인 실패: '+e.message+(pending?' · 같은 요청을 다시 시도하거나 최신 목록을 읽으세요.':' · 입력을 확인하거나 최신 목록을 읽으세요.')+' 입력은 유지했습니다.');}}
    finally{if(ticket===seq){busy=false;controls();}}}
  async function apply(){if(busy||pending||!same()||!tag()||dirty()&&!confirm('저장하지 않은 태그 이름 입력을 버리고 목록을 볼까요?'))return;const ticket=++seq,wanted=selected;busy=true;controls();
    try{const value=await request('GET');if(ticket!==seq||!same())return;adopt(value);if(!catalog().tags.some(x=>x.id===wanted))throw new Error('태그가 삭제되었습니다');app.apply(value,scope,wanted);busy=false;const focus=opener;close(true);if(focus?.isConnected)focus.focus();}
    catch(e){if(ticket===seq&&same())message('태그 목록 적용 실패: '+e.message);}finally{if(ticket===seq){busy=false;controls();}}}
  function close(force=false){if(!force&&(busy||pending&&!confirm('처리 결과를 아직 확인하지 못했습니다. 닫고 다시 열어 결과를 확인할까요?')||!pending&&dirty()&&!confirm('저장하지 않은 태그 이름 입력을 버리고 닫을까요?')))return;
    ++seq;abort?.abort();abort=null;busy=false;pending=null;owner=state=current=selected=null;$('list').replaceChildren();$('new').value=$('name').value='';$('current').textContent=$('assigned').textContent=$('count').textContent='';message('');if(d.open)d.close();if(!force&&opener?.isConnected)opener.focus();opener=null;}
  function end(){ended=true;close(true);app.ended();}
  $('scope').onchange=()=>{const next=$('scope').value;if(dirty()&&!confirm('저장하지 않은 태그 이름 입력을 버리고 범위를 바꿀까요?')){$('scope').value=scope;return;}scope=next;selected=null;$('new').value='';draw();};
  $('create').onclick=()=>command('create',{name:$('new').value});$('rename').onclick=()=>command('rename',{name:$('name').value});$('delete').onclick=()=>{if(tag()&&confirm('태그와 검사 연결만 삭제합니다. 원검사와 판독문은 유지됩니다. 계속할까요?'))command('delete');};
  $('add').onclick=()=>command('add',{uid:current});$('remove').onclick=()=>command('remove',{uid:current});$('apply').onclick=apply;$('retry').onclick=send;$('reload').onclick=load;$('close').onclick=()=>close();d.addEventListener('cancel',e=>{e.preventDefault();close();});
  let channel;try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
  window.addEventListener('storage',e=>{if(e.key==='kin-session-ended')end();});window.addEventListener('pagehide',()=>{end();channel?.close();});
  return {open(){if(ended||d.open||!app.allowed())return;owner=app.identity();if(!owner)return;scope='personal';current=app.current();opener=document.activeElement;d.showModal();draw();load();}};
};
