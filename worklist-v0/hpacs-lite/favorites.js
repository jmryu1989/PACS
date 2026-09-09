/* Personal study links; no original or report writes belong in this dialog. */
window.KinFavorites = function (app) {
  const d=document.createElement('dialog');d.id='favorite-dialog';d.setAttribute('aria-labelledby','favorite-title');
  d.innerHTML=`<h2 id="favorite-title">개인 즐겨찾기</h2><p>검사 링크를 계정에 저장합니다. 폴더·링크를 제거해도 원검사와 판독문은 유지됩니다.</p>
    <div class="favorite-layout"><aside><label>새 폴더 이름<input id="favorite-new-name" maxlength="120"></label><button id="favorite-create" type="button">폴더 만들기</button><div id="favorite-folders"></div></aside>
    <section><label>폴더 이름<input id="favorite-name" maxlength="120"></label><button id="favorite-rename" type="button">이름 변경</button> <button id="favorite-delete" type="button">폴더 삭제</button>
    <button id="favorite-apply" type="button">이 폴더의 검사 목록 보기</button><p>기존 검색 조건과 함께 적용합니다. 목록의 범위 해제로 돌아갈 수 있습니다.</p>
    <p id="favorite-current"></p><button id="favorite-add" type="button">현재 선택 검사 추가</button><p id="favorite-count"></p><div id="favorite-links"></div></section></div>
    <section id="favorite-view-editor" hidden><label>연결할 저장 보기<select id="favorite-view-choice"></select></label> <button id="favorite-view-save" type="button">보기 연결 저장</button> <button id="favorite-view-cancel" type="button">취소</button><p>저장한 영상 배치·표시 상태에 연결합니다. 열 때 원본과 현재 접근 권한을 다시 확인합니다.</p></section>
    <p id="favorite-status" role="status"></p><footer><button id="favorite-retry" type="button" hidden>같은 요청 다시 시도</button><button id="favorite-reload" type="button">최신 목록 다시 읽기</button><button id="favorite-close" type="button">닫기</button></footer>`;
  document.body.append(d);const $=id=>d.querySelector('#favorite-'+id);
  let owner=null,state=null,selected=null,current=null,seq=0,busy=false,pending=null,abort=null,ended=false,opener=null,viewUid=null;
  const same=()=>!ended&&d.open&&app.allowed()&&JSON.stringify(owner)===JSON.stringify(app.identity());
  const folder=()=>state?.folders.find(f=>f.id===selected);
  const renamed=()=>!!folder()&&$('name').value!==folder().name;
  const dirty=()=>!!$('new-name').value||renamed();
  const label=uid=>{const s=app.study(uid);return s?[s.name,s.id,s.date,s.desc,uid].filter(Boolean).join(' · '):'현재 불러온 목록에 없는 검사 · '+uid;};
  function controls(){
    d.querySelectorAll('button,input,select').forEach(el=>el.disabled=busy||!!pending);
    $('retry').hidden=!pending;$('retry').disabled=busy;
    for(const id of ['create','rename','delete','add','apply'])$(id).disabled=busy||!!pending||!same()||(id!=='create'&&!folder())||(id==='add'&&!current);
    $('name').disabled=busy||!!pending||!folder();$('new-name').disabled=busy||!!pending;
    $('reload').disabled=busy;
    $('close').disabled=busy;
    if(viewUid){d.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);$('view-choice').disabled=busy||!!pending;$('view-save').disabled=busy||!!pending||!$('view-choice').value;$('view-cancel').disabled=busy||!!pending;$('retry').disabled=busy;$('close').disabled=busy;}
  }
  function message(text){$('status').textContent=text;}
  function adopt(value){
    if(value&&JSON.stringify(value.owner)!==JSON.stringify(owner)){end();app.notice('계정이 바뀌었습니다. 페이지를 새로고침하세요.');throw new Error('즐겨찾기 계정이 바뀌었습니다');}
    if(!value||!Number.isInteger(value.revision)||!Array.isArray(value.folders)
       ||value.folders.some(f=>typeof f.id!=='string'||typeof f.name!=='string'||!Array.isArray(f.uids)||f.uids.some(x=>typeof x!=='string')))
      throw new Error('즐겨찾기 계정·목록 형식을 확인할 수 없습니다');
    state=value;app.changed?.(value);
  }
  function button(text,action,parent){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=action;parent.append(b);return b;}
  function draw(preserve=false){
    const previous=selected;
    if(!folder())selected=state?.folders[0]?.id??null;
    $('folders').replaceChildren();
    for(const f of state?.folders??[]){const b=button(f.name+' · '+f.uids.length+'건',()=>{if(f.id!==selected&&renamed()&&!confirm('저장하지 않은 폴더 이름 변경을 버릴까요?'))return;selected=f.id;draw();},$('folders'));b.dataset.folderId=f.id;b.setAttribute('aria-pressed',String(f.id===selected));}
    const f=folder();if(!preserve||previous!==selected)$('name').value=f?.name??'';
    $('links').replaceChildren();$('count').textContent=f?`접근 가능한 링크 ${f.uids.length}건`+(f.unavailable?` · 접근 불가 ${f.unavailable}건`:''):'폴더를 만들거나 선택하세요.';
    for(const uid of f?.uids??[]){const row=document.createElement('div');row.className='favorite-link';row.dataset.uid=uid;
      const text=document.createElement('span');text.textContent=label(uid);row.append(text);
      button('검사 선택',()=>choose(uid),row);button('보기 상태 연결',()=>editView(uid),row);if(f.views?.[uid]){button('저장 보기 열기',()=>openView(uid),row);button('보기 연결 해제',()=>command('view',{uid,jobId:null}),row);}button('링크 제거',()=>command('remove',{uid}),row);$('links').append(row);}
    $('current').textContent=current?'추가할 선택 검사 · '+label(current):'목록에서 검사를 선택하면 폴더에 추가할 수 있습니다.';controls();
  }
  async function request(method,body,path='/favorite-folders'){abort=new AbortController();const timer=setTimeout(()=>abort?.abort(),12000);try{return await app.api(method,path,body,abort.signal);}finally{clearTimeout(timer);abort=null;}}
  async function load(){
    if(busy||!same())return;const unresolved=pending;const ticket=++seq;busy=true;controls();message('즐겨찾기를 읽는 중…');
    try{const value=await request('GET');if(ticket!==seq||!same())return;adopt(value);pending=unresolved&&value.revision===unresolved.revision?unresolved:null;draw(true);message(pending?'요청이 아직 반영되지 않았습니다. 같은 요청을 다시 시도할 수 있습니다.':unresolved?'최신 목록을 읽었습니다. 이전 요청은 재시도 대기에서 해제했습니다. 반영 결과를 확인하세요.':'계정의 최신 즐겨찾기입니다.');}
    catch(e){if(ticket===seq&&same()){if(e.status===401){end();app.notice('로그인이 만료되었습니다. 다시 로그인하세요.');return;}message('조회 실패: '+e.message);}}
    finally{if(ticket===seq){busy=false;controls();}}
  }
  async function command(action,extra={}){
    if(busy||pending||!same()||!state)return;
    if(action==='add'&&current!==app.current()){current=app.current();draw(true);message('선택 검사가 바뀌었습니다. 추가할 검사를 확인하고 다시 누르세요.');return;}
    if(action==='create'&&renamed()&&!confirm('저장하지 않은 폴더 이름 변경을 버리고 새 폴더를 만들까요?'))return;
    pending={expectedOwner:owner,revision:state.revision,requestId:crypto.randomUUID(),folderId:action==='create'?crypto.randomUUID():selected,action,...extra};
    await send();
  }
  async function send(){
    if(busy||!pending||!same())return;const ticket=++seq,body=pending;busy=true;controls();message('변경을 저장하는 중…');
    try{const value=await request('POST',body);if(ticket!==seq||!same())return;adopt(value);pending=null;
      if(body.action==='view'){viewUid=null;$('view-editor').hidden=true;$('view-choice').replaceChildren();}
      if(body.action==='create'){selected=body.folderId;$('new-name').value='';}draw();message('저장되었습니다.');}
    catch(e){if(ticket===seq&&same()){
      if(e.status===401){end();app.notice('로그인이 만료되었습니다. 다시 로그인하세요.');return;}
      if([400,403,404,409].includes(e.status))pending=null;
      message('저장 확인 실패: '+e.message+(pending?' · 같은 요청을 다시 시도하거나 최신 목록을 읽으세요.':' · 입력을 확인하거나 최신 목록을 읽으세요.')+' 입력은 유지했습니다.');
    }}
    finally{if(ticket===seq){busy=false;controls();}}
  }
  async function editView(uid){
    if(busy||pending||!same()||dirty()&&!confirm('저장하지 않은 폴더 이름 입력을 버리고 보기 상태를 고를까요?'))return;
    const ticket=++seq,wanted=selected;busy=true;controls();message('저장 보기 목록을 확인하는 중…');
    try{const value=await request('GET');if(ticket!==seq||!same())return;adopt(value);
      if(!state.folders.find(f=>f.id===wanted)?.uids.includes(uid))throw new Error('폴더에서 제거된 검사입니다');
      const data=await request('GET',undefined,'/studies/'+encodeURIComponent(uid)+'/viewer-jobs');if(ticket!==seq||!same())return;
      if(!Array.isArray(data.jobs))throw new Error('저장 보기 목록을 확인할 수 없습니다');
      viewUid=uid;$('view-choice').replaceChildren();
      for(const job of data.jobs){const option=document.createElement('option');option.value=job.id;option.textContent=job.title+' · '+job.id;$('view-choice').append(option);}
      $('view-editor').hidden=false;message(data.jobs.length?'연결할 저장 보기를 선택하세요.':'이 검사에 저장된 보기 상태가 없습니다. 영상에서 비교 작업을 먼저 저장하세요.');
    }catch(e){if(ticket===seq&&same())message('보기 목록 확인 실패: '+e.message);}
    finally{if(ticket===seq){busy=false;controls();}}
  }
  async function openView(uid){
    if(busy||pending||!same()||dirty()&&!confirm('저장하지 않은 폴더 이름 입력을 버리고 저장 보기를 열까요?'))return;
    const ticket=++seq,wanted=selected;busy=true;controls();message('저장 보기의 원본과 접근 권한을 확인하는 중…');
    try{const value=await request('GET');if(ticket!==seq||!same())return;adopt(value);
      const f=state.folders.find(f=>f.id===wanted),id=f?.views?.[uid];
      if(!f?.uids.includes(uid)||!id||!app.study(uid))throw new Error('연결된 저장 보기나 현재 검사 목록을 확인할 수 없습니다');
      const job=await request('GET',undefined,'/studies/'+encodeURIComponent(uid)+'/viewer-jobs/'+encodeURIComponent(id));if(ticket!==seq||!same())return;
      if(job.id!==id||job.studyUid!==uid)throw new Error('저장 보기의 검사가 일치하지 않습니다');
      busy=false;close(true);app.openSavedView(uid,job);
    }catch(e){if(ticket===seq&&same())message('저장 보기를 열지 않았습니다: '+e.message);}
    finally{if(ticket===seq){busy=false;controls();}}
  }
  async function applyFolder(){
    if(busy||pending||!same()||!folder()||dirty()&&!confirm('저장하지 않은 폴더 이름 입력을 버리고 목록을 볼까요?'))return;
    const ticket=++seq,wanted=selected;busy=true;controls();message('폴더를 확인하는 중…');
    try{const value=await request('GET');if(ticket!==seq||!same())return;adopt(value);
      if(!state.folders.some(f=>f.id===wanted)){draw();message('이 폴더는 삭제되었습니다. 다른 폴더를 선택하세요.');return;}
      app.applyFolder(state,wanted);const focus=opener;busy=false;close(true);if(focus?.isConnected)focus.focus();
    }catch(e){if(ticket===seq&&same())message('목록 적용 실패: '+e.message);}
    finally{if(ticket===seq){busy=false;controls();}}
  }
  async function choose(uid){
    if(busy||pending||!same()||dirty()&&!confirm('저장하지 않은 폴더 이름 입력을 버리고 검사를 선택할까요?'))return;const ticket=++seq,wanted=selected;busy=true;controls();
    try{const value=await request('GET');if(ticket!==seq||!same())return;adopt(value);
      if(!state.folders.find(f=>f.id===wanted)?.uids.includes(uid)||!app.study(uid)){draw();message('이 검사를 지금 열 수 없습니다. 목록을 새로고침하거나 접근 권한을 확인하세요.');return;}
      busy=false;const focus=opener;close(true);app.select(uid);if(focus?.isConnected)focus.focus();
    }catch(e){if(ticket===seq&&same())message('검사 확인 실패: '+e.message);}
    finally{if(ticket===seq){busy=false;controls();}}
  }
  function close(force=false){
    if(!force&&(busy||pending&&!confirm('처리 결과를 아직 확인하지 못했습니다. 닫은 뒤 다시 열어 최신 목록을 확인하세요. 닫을까요?')))return;
    if(!force&&!pending&&dirty()&&!confirm('저장하지 않은 폴더 이름 입력을 버리고 닫을까요?'))return;
    ++seq;abort?.abort();abort=null;busy=false;pending=null;state=null;owner=null;current=null;selected=null;
    viewUid=null;$('view-editor').hidden=true;$('view-choice').replaceChildren();
    $('folders').replaceChildren();$('links').replaceChildren();$('current').textContent=$('count').textContent='';$('name').value=$('new-name').value='';message('');
    if(d.open)d.close();if(!force&&opener?.isConnected)opener.focus();opener=null;
  }
  $('create').onclick=()=>command('create',{name:$('new-name').value});$('rename').onclick=()=>command('rename',{name:$('name').value});
  $('delete').onclick=()=>{if(folder()&&confirm('이 폴더와 즐겨찾기 링크만 삭제합니다. 원검사와 판독문은 유지됩니다. 계속할까요?'))command('delete');};
  $('view-save').onclick=()=>{if(viewUid&&$('view-choice').value)command('view',{uid:viewUid,jobId:$('view-choice').value});};
  $('view-cancel').onclick=()=>{viewUid=null;$('view-editor').hidden=true;$('view-choice').replaceChildren();controls();};
  $('apply').onclick=applyFolder;
  $('add').onclick=()=>command('add',{uid:current});$('retry').onclick=send;$('reload').onclick=load;$('close').onclick=()=>close();
  d.addEventListener('cancel',e=>{e.preventDefault();close();});
  function end(){ended=true;close(true);app.ended?.();}
  let channel;function connect(){try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}}connect();
  window.addEventListener('storage',e=>{if(e.key==='kin-session-ended')end();});window.addEventListener('pagehide',()=>{close(true);channel?.close();});
  window.addEventListener('pageshow',e=>{if(e.persisted){close(true);connect();}});
  return {open(){if(ended||d.open||!app.allowed())return;owner=app.identity();if(!owner)return;current=app.current();opener=document.activeElement;d.showModal();draw();load();}};
};
