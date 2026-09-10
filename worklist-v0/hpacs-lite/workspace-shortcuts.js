/* Only explicit navigation chords are configurable. Native editing, browser and
 * viewer commands stay outside this map; no clinical data enters preferences. */
(function (root) {
  'use strict';
  const defaults = Object.freeze({list:'Digit1',image:'Digit2',prior:'Digit3',report:'Digit4',context:'Digit5',note:'Digit6',tools:'Digit7',nativeTools:'Digit9',previous:'ArrowLeft',next:'ArrowRight'});
  const labels = {list:'검사 목록',image:'영상으로',prior:'과거 판독문',report:'판독문 작성',context:'검사 정보·상용구',note:'영상 Tech 메모',tools:'작업 패널',nativeTools:'기본 영상 도구',previous:'이전 검사',next:'다음 검사'};
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
    const edit = el('button','단축키 편집',host); edit.type='button'; edit.className='chip'; edit.id='workspace-shortcuts-edit';
    const status = el('span','',host); status.id='workspace-shortcuts-status'; status.setAttribute('role','status');
    status.style.cssText='display:block;flex-basis:100%;min-height:1.5em';
    const dialog = el('dialog','',d.body); dialog.id='workspace-shortcuts-dialog'; dialog.style.cssText='max-height:85vh;overflow:auto;width:640px;max-width:95vw;box-sizing:border-box;padding:20px;background:#111c2f;color:#d6e6ff;border:1px solid #718eaa;border-radius:8px';
    const title = el('h2','작업공간 단축키',dialog); title.id='workspace-shortcuts-title'; dialog.setAttribute('aria-labelledby',title.id);
    el('p','통합 목록·영상·판독문 공통 · 이 브라우저의 현재 계정에 저장합니다. Ctrl+Alt 조합만 사용합니다. C(환자 ID 복사), 8(영상 배치), 브라우저·입력 키는 예약되어 있습니다. 별도 영상 창은 기본 단축키를 사용합니다.',dialog);
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
    const close=()=>{dialog.close();draftOwner=null;if(!ended)edit.focus();};
    button('기본값','workspace-shortcuts-default',()=>{fill(defaults);message.textContent='기본값을 적용하려면 저장하세요.';});
    button('취소','workspace-shortcuts-cancel',close);
    button('적용·저장','workspace-shortcuts-apply',()=>{
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
      currentOwner=next;map={...defaults};
      if(dialog.open)dialog.close();
      if(next)try{const raw=localStorage.getItem(prefix+next);if(raw!==null){const value=JSON.parse(raw);if(!valid(value))throw Error();map=value;}}catch(_){status.textContent='저장값 오류: 기본 단축키를 사용합니다.';}
      changed(map);
    }
    edit.onclick=()=>{
      sync();if(!currentOwner||ended)return;
      draftOwner=currentOwner;
      try{baseline=localStorage.getItem(prefix+draftOwner);if(baseline!==null){try{const saved=JSON.parse(baseline);if(valid(saved)){map=saved;changed(map);}}catch(_){/* Keep the exact invalid baseline so an explicit reset can replace it. */}}}catch(_){baseline=null;}
      fill(map);message.textContent='각 항목에서 사용할 Ctrl+Alt 조합을 누르세요.';dialog.showModal();fields.list.focus();
    };
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    dialog.addEventListener('keydown',e=>e.stopPropagation());
    const timer=setInterval(sync,500);sync();
    return {action:e=>{sync();return action(map,e);},end:()=>{ended=true;clearInterval(timer);map={...defaults};dialog.remove();edit.remove();status.remove();},read:()=>({...map})};
  }
  const api={defaults,valid,display,action,create};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorkspaceShortcuts=api;
})(typeof window==='object'?window:globalThis);
