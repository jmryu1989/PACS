/* Only explicit workspace chords are configurable; no clinical data enters preferences.
 * Resolving a chord never cancels a browser command: the caller must actually run it. */
(function (root) {
  'use strict';
  const defaults = Object.freeze({list:'Digit1',image:'Digit2',prior:'Digit3',report:'Digit4',context:'Digit5',note:'Digit6',tools:'Digit7',nativeTools:'Digit9',previous:'ArrowLeft',next:'ArrowRight'});
  const labels = {list:'Worklist',image:'Image',prior:'Related Report',report:'Report Editor',context:'Study Info & Templates',note:'Image Tech Note',tools:'Tool Panels',nativeTools:'Viewer Toolbar',previous:'Previous Study',next:'Next Study',finalize:'Finalize (Approve)'};
  const defaultsV2 = Object.freeze({version:2,...Object.fromEntries(Object.entries(defaults).map(([id,key])=>[id,'Control+Alt+'+key])),finalize:'Control+KeyS'});
  const ids = Object.keys(labels);
  const prefix = 'kin-workspace-shortcuts:v2:', legacyPrefix = 'kin-workspace-shortcuts:v1:';
  const chord = key => typeof key==='string' && (/^Control\+Alt\+(Digit[1-9]|Key[A-Z]|ArrowLeft|ArrowRight)$/.test(key) && !['Control+Alt+KeyC','Control+Alt+Digit8'].includes(key) || key==='Control+KeyS');
  function valid(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v2=value.version===2, names=v2?['version',...ids]:Object.keys(defaults);
    if(Object.keys(value).sort().join(',')!==names.slice().sort().join(','))return false;
    const used = new Set();
    return (v2?ids:Object.keys(defaults)).every(id => {
      const key = value[id];
      if(v2&&key===null)return true;
      if (!(v2?chord(key):typeof key==='string'&&/^(Digit[1-9]|Key[A-Z]|ArrowLeft|ArrowRight)$/.test(key)&&!['KeyC','Digit8'].includes(key)) || used.has(key)) return false;
      used.add(key); return true;
    });
  }
  function migrate(value) {
    if(value===null)return {map:{...defaultsV2},notices:[]};
    const map={version:2},notices=[],used=new Map();
    const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
    const supported=source.version===undefined||source.version===2;
    for(const id of ids){
      if(id==='finalize'&&!Object.hasOwn(source,id)&&supported)continue;
      const raw=supported?source[id]:null;
      const key=source.version===2?raw:typeof raw==='string'?'Control+Alt+'+raw:null;
      map[id]=chord(key)&&!used.has(key)?key:null;
      if(map[id])used.set(key,id);
      else if(raw!==null)notices.push(labels[id]+': 알 수 없거나 중복된 키를 미배정으로 두었습니다. Shortcuts에서 지정하세요.');
    }
    if(!Object.hasOwn(map,'finalize')){
      const key=defaultsV2.finalize;
      map.finalize=used.has(key)?null:key;
      if(used.has(key))notices.push(display(key)+'는 이미 '+labels[used.get(key)]+'에 지정됨 — Shortcuts에서 지정하세요.');
    }
    return {map,notices};
  }
  const display = code => code ? (code.includes('+')?code:'Control+Alt+'+code).replace(/Digit|Key/g,'') : 'Unassigned';
  const eventChord = e => e.ctrlKey&&!e.shiftKey&&!e.metaKey ? 'Control+'+(e.altKey?'Alt+':'')+e.code : null;
  function action(map, e) {
    if (!map || e.defaultPrevented || e.repeat || e.isComposing || e.keyCode===229 || e.getModifierState?.('AltGraph')) return null;
    const key=eventChord(e);if(!chord(key))return null;
    return ids.find(id => map[id] && (map.version===2?map[id]:'Control+Alt+'+map[id])===key) || null;
  }
  function create({host, owner, allowed, changed}) {
    const work=root.KinWorkContext,transport=root.KinSessionTransport.page();
    const storage=()=>{try{return root.localStorage;}catch(_){return undefined;}};
    const d = host.ownerDocument;
    const el = (tag, text, parent) => { const n = d.createElement(tag); n.textContent = text; parent?.append(n); return n; };
    let map = {...defaultsV2}, currentOwner = null, ended = false, draftOwner = null, baseline = null;
    let accountRequest=null, accountEpoch=0, accountRevision=null, accountBusy=false;
    const edit = el('button','Edit Shortcuts',host); edit.type='button'; edit.className='chip'; edit.id='workspace-shortcuts-edit';
    const status = el('span','',host); status.id='workspace-shortcuts-status'; status.setAttribute('role','status');
    status.style.cssText='display:block;flex-basis:100%;min-height:1.5em';
    const dialog = el('dialog','',d.body); dialog.id='workspace-shortcuts-dialog'; dialog.style.cssText='max-height:85vh;overflow:auto;width:640px;max-width:95vw;box-sizing:border-box;padding:20px;background:#111c2f;color:#d6e6ff;border:1px solid #718eaa;border-radius:8px';
    const title = el('h2','Workspace Shortcuts',dialog); title.id='workspace-shortcuts-title'; dialog.setAttribute('aria-labelledby',title.id);
    el('p','이 브라우저의 현재 계정에 저장합니다. Ctrl+Alt 조합 또는 Ctrl+S를 지정하세요. Ctrl+Alt+C(환자 ID 복사), Ctrl+Alt+8(영상 배치)과 나머지 브라우저·입력 키는 예약되어 있습니다. Backspace/Delete로 미배정할 수 있습니다. Viewer의 새 키는 다음 열기부터 적용하며 열린 창은 현재 키를 유지합니다.',dialog);
    const tabs=el('div','',dialog);tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Shortcut scope');
    const panels={},tabButtons={};
    function showTab(name,focus=false){for(const key of Object.keys(panels)){const active=key===name;panels[key].hidden=!active;tabButtons[key].setAttribute('aria-selected',String(active));tabButtons[key].tabIndex=active?0:-1;}if(focus)tabButtons[name].focus();}
    for(const name of ['Worklist','Viewer']){
      const tab=el('button',name,tabs);tab.type='button';tab.id='workspace-shortcuts-tab-'+name.toLowerCase();tab.setAttribute('role','tab');
      const panel=el('div','',dialog);panel.id=tab.id+'-panel';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);tab.setAttribute('aria-controls',panel.id);panels[name]=panel;tabButtons[name]=tab;
      tab.onclick=()=>showTab(name);
      tab.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();showTab(e.key==='Home'?'Worklist':e.key==='End'?'Viewer':name==='Worklist'?'Viewer':'Worklist',true);}};
    }
    showTab('Worklist');
    const fields = {};
    for (const id of ids) {
      const row=el('label',labels[id],panels[['image','note','tools','nativeTools'].includes(id)?'Viewer':'Worklist']); row.style.cssText='display:grid;grid-template-columns:minmax(100px,1fr) minmax(130px,1fr);align-items:center;gap:12px;margin:8px 0';
      const field=el('input','',row);field.readOnly=true;field.id='workspace-shortcut-'+id;field.setAttribute('aria-label',labels[id]+' 단축키');field.style.cssText='box-sizing:border-box;width:100%;padding:6px;background:#0b1320;color:inherit;border:1px solid #718eaa;border-radius:4px';fields[id]=field;
      field.onkeydown=e=>{
        if (e.key==='Tab'||e.key==='Escape') return;
        e.preventDefault();e.stopPropagation();
        if(e.repeat||e.isComposing||e.getModifierState('AltGraph'))return;
        if(!e.ctrlKey&&!e.altKey&&!e.shiftKey&&!e.metaKey&&['Backspace','Delete'].includes(e.key)){field.dataset.code='';field.value=display(null);message.textContent='미배정했습니다. 적용하려면 저장하세요.';return;}
        const key=eventChord(e);
        if(!chord(key)) { message.textContent='예약 키입니다. Ctrl+Alt와 숫자 1~9(8 제외), 영문(C 제외), 좌우 방향키 또는 Ctrl+S를 사용하세요.';return; }
        field.dataset.code=key;field.value=display(key);message.textContent='적용 전에 중복 단축키를 확인합니다.';
      };
    }
    const message=el('p','',dialog);message.id='workspace-shortcuts-message';message.setAttribute('role','status');
    const button=(text,id,run)=>{const b=el('button',text,dialog);b.type='button';b.className='chip';b.style.marginRight='8px';b.id=id;b.onclick=run;return b;};
    const fill=value=>{for(const id of ids){fields[id].dataset.code=value[id]||'';fields[id].value=display(value[id]);}};
    const close=()=>{cancelAccount();dialog.close();draftOwner=null;if(!ended)edit.focus();};
    const draft=()=>({version:2,...Object.fromEntries(ids.map(id=>[id,fields[id].dataset.code||null]))});
    el('p','계정에서 불러오면 아래 입력란에 채워집니다. 계정 저장은 표시된 키를 보관하며, 현재 브라우저에는 Apply & Save로 적용하세요.',dialog);
    const accountLoad=button('Load from Account','workspace-shortcuts-account-load',()=>accountRun('load'));
    const accountSave=button('Save to Account','workspace-shortcuts-account-save',()=>accountRun('save'));
    const accountStatus=el('p','',dialog);accountStatus.id='workspace-shortcuts-account-status';accountStatus.setAttribute('role','status');
    function refreshAccount(){accountLoad.disabled=ended||accountBusy||!dialog.open||!allowed()||owner()!==draftOwner;accountSave.disabled=accountLoad.disabled||accountRevision===null;}
    function cancelAccount(){accountEpoch++;accountRequest?.abort();accountRequest=null;accountRevision=null;accountBusy=false;}
    let interruptedAction=null;
    async function accountRun(action){
      if(work.state()!=='active')return;const at=work.capture('document');
      if(ended||accountBusy||!dialog.open||!allowed()||!draftOwner||owner()!==draftOwner||action==='save'&&accountRevision===null)return;
      const snapshot=draft(), bound=draftOwner, ticket=++accountEpoch;
      if(action==='save'&&!valid(snapshot)){accountStatus.textContent='중복 또는 예약 단축키를 수정하세요.';return;}
      const live=()=>!ended&&ticket===accountEpoch&&dialog.open&&allowed()&&owner()===bound&&draftOwner===bound;
      const controller=new AbortController();accountRequest=controller;accountBusy=true;interruptedAction=action;refreshAccount();
      const timeout=setTimeout(()=>controller.abort(),10000);accountStatus.textContent='계정 단축키를 확인하는 중…';
      try{
        const response=await transport.request('/api/workspace-shortcuts',{context:at,method:action==='save'?'PUT':'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'X-KIN-CSRF':'1','Content-Type':'application/json'},...(action==='save'?{body:JSON.stringify({expectedOwner:JSON.parse(bound),revision:accountRevision,bindings:snapshot})}:{})});
        if(!live())return;

        if(!response.ok)throw Error(response.status===409?'다른 창에서 설정이 바뀌었습니다. 불러온 뒤 다시 저장하세요.':'계정 설정을 확인하지 못했습니다. 다시 불러오세요.');
        const data=response.body;if(!live())return;
        if(JSON.stringify(data.owner)!==bound||!Number.isInteger(data.revision)||data.revision<0||data.revision>2147483647||(data.revision===0?data.bindings!==null||data.invalid===true:!valid(data.bindings)&&!(data.invalid===true&&data.bindings===null)))throw Error('계정 단축키 응답을 확인할 수 없습니다.');
        work.commit(at,()=>{
        if(action==='load'&&JSON.stringify(snapshot)!==JSON.stringify(draft())){accountRevision=null;accountStatus.textContent='입력이 바뀌어 불러온 설정을 적용하지 않았습니다.';return;}
        accountRevision=data.revision;
        if(data.invalid===true){accountStatus.textContent='저장된 단축키를 읽을 수 없습니다. 현재 입력으로 계정에 다시 저장할 수 있습니다.';return;}
        if(action==='load'&&data.bindings!==null){const migrated=migrate(data.bindings);fill(migrated.map);message.textContent=migrated.notices.join(' ');accountStatus.textContent='계정 단축키를 입력란에 불러왔습니다. Apply & Save로 적용하세요.';}
        else if(action==='save')accountStatus.textContent=JSON.stringify(snapshot)===JSON.stringify(draft())?'단축키를 계정에 저장했습니다.':'요청 당시 단축키를 저장했습니다. 이후 입력 변경은 저장되지 않았습니다.';
        else accountStatus.textContent=data.bindings===null?'계정에 저장된 단축키가 없습니다.':'계정 설정이 있습니다. 불러오면 입력란에 표시합니다.';
        });
      }catch(e){work.commit(at,()=>{if(live()){accountRevision=null;accountStatus.textContent=e instanceof TypeError||e.name==='AbortError'?'응답을 확인하지 못했습니다. 입력은 유지했습니다. 다시 불러오세요.':e instanceof SyntaxError?'계정 응답 형식을 확인하지 못했습니다.':e.message;}});}
      finally{clearTimeout(timeout);if(ticket===accountEpoch){accountRequest=null;accountBusy=false;work.commit(at,()=>{interruptedAction=null;refreshAccount();});}}
    }
    button('Defaults','workspace-shortcuts-default',()=>{fill(defaultsV2);message.textContent='기본값을 적용하려면 저장하세요.';});
    button('Cancel','workspace-shortcuts-cancel',close);
    button('Apply & Save','workspace-shortcuts-apply',()=>{
      if(ended||!allowed()||!draftOwner||owner()!==draftOwner){message.textContent='계정이 바뀌었습니다. 창을 닫고 다시 확인하세요.';return;}
      const next=draft();
      if(!valid(next)){message.textContent='중복 단축키가 있습니다. 서로 다른 키로 지정하세요.';return;}
      try {
        if(localBaseline(storage(),draftOwner)!==baseline){message.textContent='다른 창에서 설정이 바뀌었습니다. 취소 후 다시 열어 확인하세요.';return;}
        storage().setItem(prefix+draftOwner,JSON.stringify(next));
      } catch (_) {message.textContent='설정을 저장하지 못했습니다. 입력을 유지했습니다. 다시 시도하세요.';return;}
      map=next;changed(map);status.textContent='단축키를 저장했습니다. 열린 Viewer의 새 키는 다음 열기부터 적용됩니다.';close();
    });
    function sync() {
      if(ended)return;
      const next=allowed()?owner():null;edit.disabled=!next;
      if(next===currentOwner)return;
      cancelAccount();currentOwner=next;map={...defaultsV2};status.textContent='';
      if(dialog.open)dialog.close();
      if(next){const saved=readLocal(storage(),next);map=saved.map;status.textContent=saved.notices.join(' ');}
      changed(map);
    }
    edit.onclick=()=>{
      sync();if(!currentOwner||ended)return;
      draftOwner=currentOwner;
      try{baseline=localBaseline(storage(),draftOwner);}catch(_){baseline=null;}
      const saved=readLocal(storage(),draftOwner);map=saved.map;changed(map);
      fill(map);message.textContent=saved.notices.join(' ')||'각 항목에서 사용할 조합을 누르세요.';showTab('Worklist');dialog.showModal();fields.list.focus();refreshAccount();accountRun('inspect');
    };
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    dialog.addEventListener('keydown',e=>e.stopPropagation());
    let timer;
    function startTimer(){clearInterval(timer);const at=work.capture('document');timer=setInterval(()=>work.commit(at,sync),500);}
    function end(){ended=true;cancelAccount();clearInterval(timer);map={...defaultsV2};dialog.remove();edit.remove();status.remove();}
    work.onInvalidate(event=>{
      if(event.reason==='lifecycle'&&!['active','preparing'].includes(event.state))end();
      if(event.reason==='prepare')clearInterval(timer);
      if(event.reason==='lifecycle'&&event.state==='active'){startTimer();sync();}
      if(event.reason==='cancel'){const action=interruptedAction;interruptedAction=null;accountEpoch++;accountRequest=null;accountBusy=false;refreshAccount();startTimer();if(action&&dialog.open)accountRun(action==='load'?'load':'inspect');}
    });
    startTimer();sync();
    return {action:e=>{sync();return action(map,e);},end,read:()=>({...map})};
  }
  function localBaseline(storage,owner){return JSON.stringify([storage.getItem(prefix+owner),storage.getItem(legacyPrefix+owner)]);}
  function readLocal(storage,owner){
    if(!owner)return migrate(null);
    try{
      const raw=storage.getItem(prefix+owner)??storage.getItem(legacyPrefix+owner);
      if(raw===null)return migrate(null);
      if(raw.length>4096)throw Error();
      const value=JSON.parse(raw);if(value===null)throw Error();
      return migrate(value);
    }catch(_){return {map:{version:2,...Object.fromEntries(ids.map(id=>[id,null]))},notices:['저장된 단축키를 확인할 수 없어 미배정으로 두었습니다. Shortcuts에서 확인하세요.']};}
  }
  function readV2(storage,owner){return readLocal(storage,owner).map;}
  function read(storage, owner) {
    const map=readV2(storage,owner);
    return Object.fromEntries(Object.keys(defaults).map(id=>[id,map[id]?.startsWith('Control+Alt+')?map[id].slice(12):null]));
  }
  const api={defaults,defaultsV2,valid,display,action,create,read,readV2,migrate};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorkspaceShortcuts=api;
})(typeof window==='object'?window:globalThis);
