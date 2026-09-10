/* Only explicit navigation chords are configurable. Native editing, browser and
 * viewer commands stay outside this map; no clinical data enters preferences. */
(function (root) {
  'use strict';
  const defaults = Object.freeze({list:'Digit1',image:'Digit2',prior:'Digit3',report:'Digit4',context:'Digit5',note:'Digit6',tools:'Digit7',nativeTools:'Digit9',previous:'ArrowLeft',next:'ArrowRight'});
  const labels = {list:'Worklist',image:'Image',prior:'Related Report',report:'Report Editor',context:'Study Info & Templates',note:'Image Tech Note',tools:'Tool Panels',nativeTools:'Viewer Toolbar',previous:'Previous Study',next:'Next Study'};
  const prefix = 'kin-workspace-shortcuts:v1:';
  function valid(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== Object.keys(defaults).length) return false;
    const used = new Set();
    return Object.keys(defaults).every(id => {
      const key = value[id];
      if (typeof key !== 'string' || !/^(Digit[1-9]|Key[A-Z]|ArrowLeft|ArrowRight)$/.test(key) || ['KeyC','Digit8'].includes(key) || used.has(key)) return false;
      used.add(key); return true;
    });
  }
  const display = code => 'Control+Alt+' + code.replace(/^Digit|^Key/, '');
  function action(map, e) {
    if (e.defaultPrevented || e.repeat || e.isComposing || e.getModifierState?.('AltGraph') || !e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return null;
    return Object.keys(defaults).find(id => map[id] === e.code) || null;
  }
  function create({host, owner, allowed, changed}) {
    const d = host.ownerDocument;
    const el = (tag, text, parent) => { const n = d.createElement(tag); n.textContent = text; parent?.append(n); return n; };
    let map = {...defaults}, currentOwner = null, ended = false, draftOwner = null, baseline = null;
    let accountRequest=null, accountEpoch=0, accountRevision=null, accountBusy=false;
    const edit = el('button','Edit Shortcuts',host); edit.type='button'; edit.className='chip'; edit.id='workspace-shortcuts-edit';
    const status = el('span','',host); status.id='workspace-shortcuts-status'; status.setAttribute('role','status');
    status.style.cssText='display:block;flex-basis:100%;min-height:1.5em';
    const dialog = el('dialog','',d.body); dialog.id='workspace-shortcuts-dialog'; dialog.style.cssText='max-height:85vh;overflow:auto;width:640px;max-width:95vw;box-sizing:border-box;padding:20px;background:#111c2f;color:#d6e6ff;border:1px solid #718eaa;border-radius:8px';
    const title = el('h2','Workspace Shortcuts',dialog); title.id='workspace-shortcuts-title'; dialog.setAttribute('aria-labelledby',title.id);
    el('p','통합 목록·영상·판독문 공통 · 이 브라우저의 현재 계정에 저장합니다. Ctrl+Alt 조합만 사용합니다. C(환자 ID 복사), 8(영상 배치), 브라우저·입력 키는 예약되어 있습니다. 새로 연 별도 영상 창에도 영상·메모·도구·판독문 복귀 키가 적용됩니다. 열린 창은 현재 키를 유지합니다.',dialog);
    const fields = {};
    for (const id of Object.keys(defaults)) {
      const row=el('label',labels[id],dialog); row.style.cssText='display:grid;grid-template-columns:minmax(100px,1fr) minmax(130px,1fr);align-items:center;gap:12px;margin:8px 0';
      const field=el('input','',row);field.readOnly=true;field.id='workspace-shortcut-'+id;field.setAttribute('aria-label',labels[id]+' 단축키');field.style.cssText='box-sizing:border-box;width:100%;padding:6px;background:#0b1320;color:inherit;border:1px solid #718eaa;border-radius:4px';fields[id]=field;
      field.onkeydown=e=>{
        if (e.key==='Tab'||e.key==='Escape') return;
        e.preventDefault();e.stopPropagation();
        if(e.repeat||e.isComposing||e.getModifierState('AltGraph'))return;
        if(!e.ctrlKey||!e.altKey||e.shiftKey||e.metaKey||!/^(Digit[1-9]|Key[A-Z]|ArrowLeft|ArrowRight)$/.test(e.code)||['KeyC','Digit8'].includes(e.code)) { message.textContent='예약 키입니다. Ctrl+Alt와 숫자 1~9(8 제외), 영문(C 제외), 좌우 방향키를 사용하세요.';return; }
        field.dataset.code=e.code;field.value=display(e.code);message.textContent='적용 전에 중복 단축키를 확인합니다.';
      };
    }
    const message=el('p','',dialog);message.id='workspace-shortcuts-message';message.setAttribute('role','status');
    const button=(text,id,run)=>{const b=el('button',text,dialog);b.type='button';b.className='chip';b.style.marginRight='8px';b.id=id;b.onclick=run;return b;};
    const fill=value=>{for(const id of Object.keys(defaults)){fields[id].dataset.code=value[id];fields[id].value=display(value[id]);}};
    const close=()=>{cancelAccount();dialog.close();draftOwner=null;if(!ended)edit.focus();};
    const draft=()=>Object.fromEntries(Object.keys(defaults).map(id=>[id,fields[id].dataset.code]));
    el('p','계정에서 불러오면 아래 입력란에 채워집니다. 계정 저장은 표시된 키를 보관하며, 현재 브라우저에는 Apply & Save로 적용하세요.',dialog);
    const accountLoad=button('Load from Account','workspace-shortcuts-account-load',()=>accountRun('load'));
    const accountSave=button('Save to Account','workspace-shortcuts-account-save',()=>accountRun('save'));
    const accountStatus=el('p','',dialog);accountStatus.id='workspace-shortcuts-account-status';accountStatus.setAttribute('role','status');
    function refreshAccount(){accountLoad.disabled=ended||accountBusy||!dialog.open||!allowed()||owner()!==draftOwner;accountSave.disabled=accountLoad.disabled||accountRevision===null;}
    function cancelAccount(){accountEpoch++;accountRequest?.abort();accountRequest=null;accountRevision=null;accountBusy=false;}
    async function accountRun(action){
      if(ended||accountBusy||!dialog.open||!allowed()||!draftOwner||owner()!==draftOwner||action==='save'&&accountRevision===null)return;
      const snapshot=draft(), bound=draftOwner, ticket=++accountEpoch;
      if(action==='save'&&!valid(snapshot)){accountStatus.textContent='중복 또는 예약 단축키를 수정하세요.';return;}
      const live=()=>!ended&&ticket===accountEpoch&&dialog.open&&allowed()&&owner()===bound&&draftOwner===bound;
      const controller=new AbortController();accountRequest=controller;accountBusy=true;refreshAccount();
      const timeout=setTimeout(()=>controller.abort(),10000);accountStatus.textContent='계정 단축키를 확인하는 중…';
      try{
        const response=await fetch('/api/workspace-shortcuts',{method:action==='save'?'PUT':'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'X-KIN-CSRF':'1','Content-Type':'application/json'},...(action==='save'?{body:JSON.stringify({expectedOwner:JSON.parse(bound),revision:accountRevision,bindings:snapshot})}:{})});
        if(!live())return;
        if([401,403].includes(response.status))throw Error('계정이나 권한이 변경되었습니다. 다시 로그인하세요.');
        if(!response.ok)throw Error(response.status===409?'다른 창에서 설정이 바뀌었습니다. 불러온 뒤 다시 저장하세요.':'계정 설정을 확인하지 못했습니다. 다시 불러오세요.');
        const data=await response.json();if(!live())return;
        if(JSON.stringify(data.owner)!==bound||!Number.isInteger(data.revision)||data.revision<0||data.revision>2147483647||(data.revision===0?data.bindings!==null||data.invalid===true:!valid(data.bindings)&&!(data.invalid===true&&data.bindings===null)))throw Error('계정 단축키 응답을 확인할 수 없습니다.');
        const check=await fetch('/api/me',{credentials:'same-origin',cache:'no-store',signal:controller.signal});if(!live())return;
        if(!check.ok)throw Error('계정 상태를 확인한 뒤 다시 시도하세요.');
        const me=await check.json();if(!live())return;
        if(me.kind!=='member'||JSON.stringify([me.institution,me.sub])!==bound)throw Error('계정이 변경되었습니다. 다시 로그인하세요.');
        if(action==='load'&&JSON.stringify(snapshot)!==JSON.stringify(draft())){accountRevision=null;accountStatus.textContent='입력이 바뀌어 불러온 설정을 적용하지 않았습니다.';return;}
        accountRevision=data.revision;
        if(data.invalid===true){accountStatus.textContent='저장된 단축키를 읽을 수 없습니다. 현재 입력으로 계정에 다시 저장할 수 있습니다.';return;}
        if(action==='load'&&data.bindings!==null){fill(data.bindings);accountStatus.textContent='계정 단축키를 입력란에 불러왔습니다. Apply & Save로 적용하세요.';}
        else if(action==='save')accountStatus.textContent=JSON.stringify(snapshot)===JSON.stringify(draft())?'단축키를 계정에 저장했습니다.':'요청 당시 단축키를 저장했습니다. 이후 입력 변경은 저장되지 않았습니다.';
        else accountStatus.textContent=data.bindings===null?'계정에 저장된 단축키가 없습니다.':'계정 설정이 있습니다. 불러오면 입력란에 표시합니다.';
      }catch(e){if(live()){accountRevision=null;accountStatus.textContent=e instanceof TypeError||e.name==='AbortError'?'응답을 확인하지 못했습니다. 입력은 유지했습니다. 다시 불러오세요.':e instanceof SyntaxError?'계정 응답 형식을 확인하지 못했습니다.':e.message;}}
      finally{clearTimeout(timeout);if(ticket===accountEpoch){accountRequest=null;accountBusy=false;refreshAccount();}}
    }
    button('Defaults','workspace-shortcuts-default',()=>{fill(defaults);message.textContent='기본값을 적용하려면 저장하세요.';});
    button('Cancel','workspace-shortcuts-cancel',close);
    button('Apply & Save','workspace-shortcuts-apply',()=>{
      if(ended||!allowed()||!draftOwner||owner()!==draftOwner){message.textContent='계정이 바뀌었습니다. 창을 닫고 다시 확인하세요.';return;}
      const next=Object.fromEntries(Object.keys(defaults).map(id=>[id,fields[id].dataset.code]));
      if(!valid(next)){message.textContent='중복 단축키가 있습니다. 서로 다른 키로 지정하세요.';return;}
      try {
        if(localStorage.getItem(prefix+draftOwner)!==baseline){message.textContent='다른 창에서 설정이 바뀌었습니다. 취소 후 다시 열어 확인하세요.';return;}
        localStorage.setItem(prefix+draftOwner,JSON.stringify(next));
      } catch (_) {message.textContent='설정을 저장하지 못했습니다. 입력을 유지했습니다. 다시 시도하세요.';return;}
      map=next;changed(map);status.textContent='단축키를 저장했습니다.';close();
    });
    function sync() {
      if(ended)return;
      const next=allowed()?owner():null;edit.disabled=!next;
      if(next===currentOwner)return;
      cancelAccount();currentOwner=next;map={...defaults};
      if(dialog.open)dialog.close();
      if(next)try{const raw=localStorage.getItem(prefix+next);if(raw!==null){const value=JSON.parse(raw);if(!valid(value))throw Error();map=value;}}catch(_){status.textContent='저장값 오류: 기본 단축키를 사용합니다.';}
      changed(map);
    }
    edit.onclick=()=>{
      sync();if(!currentOwner||ended)return;
      draftOwner=currentOwner;
      try{baseline=localStorage.getItem(prefix+draftOwner);if(baseline!==null){try{const saved=JSON.parse(baseline);if(valid(saved)){map=saved;changed(map);}}catch(_){/* Keep the exact invalid baseline so an explicit reset can replace it. */}}}catch(_){baseline=null;}
      fill(map);message.textContent='각 항목에서 사용할 Ctrl+Alt 조합을 누르세요.';dialog.showModal();fields.list.focus();refreshAccount();accountRun('inspect');
    };
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    dialog.addEventListener('keydown',e=>e.stopPropagation());
    const timer=setInterval(sync,500);sync();
    return {action:e=>{sync();return action(map,e);},end:()=>{ended=true;cancelAccount();clearInterval(timer);map={...defaults};dialog.remove();edit.remove();status.remove();},read:()=>({...map})};
  }
  function read(storage, owner) {
    if(owner)try{const raw=storage.getItem(prefix+owner);if(raw!==null&&raw.length<=2048){const value=JSON.parse(raw);if(valid(value))return value;}}catch(_){}
    return {...defaults};
  }
  const api={defaults,valid,display,action,create,read};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorkspaceShortcuts=api;
})(typeof window==='object'?window:globalThis);
