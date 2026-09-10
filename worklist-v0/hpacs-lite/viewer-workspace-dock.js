/* Keep viewer controls in their own document so their live state and listeners
 * survive panel switches. Reserve space instead of covering diagnostic pixels. */
window.KinViewerWorkspaceDock = function (w, preferences) {
  'use strict';
  preferences=preferences||{};
  const d = w.document;
  const existing = d.getElementById('kin-workspace-dock');
  if (existing) { existing.refreshPanels(); return existing; }
  const root = d.getElementById('root');
  const panels = ['kin-viewer-history', 'kin-viewer-layout'].map(id => d.getElementById(id));
  if (!root || panels.some(p => !p)) return;
  const origins=panels.map(p=>({panel:p,parent:p.parentNode,next:p.nextSibling,open:p.open,hidden:p.hidden}));
  const initialOwner=preferences.owner?.(),key=initialOwner?'kin-viewer-dock:v1:'+initialOwner:null;
  const normalize=window.KinViewerWorkspaceDock.normalize;
  let ended=false,placement='bottom',selected=-1,autoHide=false,autoHidden=false,hover=false,held=false,pointerButton=null,timer,storage,channel,initialMessage='도구 영역 · 이 창';
  const live=()=>!ended&&preferences.allowed?.()!==false&&(!initialOwner||preferences.owner?.()===initialOwner);
  try{storage=w.localStorage;const raw=key?storage.getItem(key):null;if(raw!==null){const value=raw.length<=128?normalize(JSON.parse(raw)):null;if(value){placement=value.placement;selected=value.panel;autoHide=value.autoHide??false;initialMessage='기억한 도구 영역';}else initialMessage='저장값 오류 · 기본 도구 영역';}else if(key)initialMessage='도구 영역 · 이 브라우저';}catch(_){initialMessage='저장소 사용 불가 · 이 창';}
  const style = d.createElement('style');
  style.textContent = `
    body.kin-docked { --kin-dock-height: 42px; }
    body.kin-docked.kin-dock-open { --kin-dock-height: min(280px, 45vh); }
    body.kin-docked #root { height: calc(100vh - var(--kin-dock-height)); overflow: hidden; }
    body.kin-docked.kin-dock-top #root { margin-top: var(--kin-dock-height); }
    body.kin-docked #root > div { height: 100%; display: flex; flex-direction: column; }
    body.kin-docked #root > div > * { flex-shrink: 0; }
    body.kin-docked #root > div > .flex { flex: 1; min-height: 0; height: auto !important; }
    #kin-workspace-dock { position: fixed; bottom: 0; left: 0; right: 0; height: var(--kin-dock-height); display: flex; flex-direction: column; background: #101e32; color: #e1ecfc; border-top: 1px solid #657c9f; font: 13px sans-serif; }
    body.kin-dock-top #kin-workspace-dock { top: 0; bottom: auto; border-top: 0; border-bottom: 1px solid #657c9f; }
    #kin-workspace-dock nav { display: flex; gap: 8px; align-items: center; height: 42px; padding: 4px 10px; flex: none; overflow-x: auto; white-space: nowrap; }
    #kin-workspace-dock nav > * { flex-shrink: 0; }
    #kin-workspace-dock button, #kin-workspace-dock select { border: 1px solid #657c9f; border-radius: 4px; padding: 5px 10px; background:#101e32;color:#e1ecfc; }
    #kin-workspace-dock button[aria-expanded=true] { background: #315681; }
    #kin-workspace-dock > details { position: static !important; width: 100% !important; max-width: none !important; max-height: none !important; min-height: 0; flex: 1; overflow: auto !important; border: 0 !important; border-radius: 0 !important; margin: 0; }
    #kin-workspace-dock > details[hidden] { display: none !important; }
    #kin-workspace-dock > details > summary { display: none; }
    #kin-workspace-dock label { max-width: 650px; display: block; }
  `;
  d.head.append(style);
  const dock = d.createElement('section'); dock.id = 'kin-workspace-dock'; dock.setAttribute('aria-label', '영상 도구');
  const nav = d.createElement('nav'); nav.setAttribute('aria-label', '영상 도구 패널'); dock.append(nav);
  const buttons = ['측정·주석', '비교 작업·배치'].map((label, i) => {
    const b = d.createElement('button'); b.type = 'button'; b.textContent = label;
    b.setAttribute('aria-controls', panels[i].id); b.setAttribute('aria-expanded', 'false');
    b.onclick = () => {
      if(!live()){end();return;}
      pointerButton=null;selected = selected === i && !autoHidden ? -1 : i;autoHidden=false;
      apply();save();
    };
    nav.append(b); return b;
  });
  const label=d.createElement('label');label.textContent='도구 위치 ';nav.append(label);
  const location=d.createElement('select');location.id='kin-dock-placement';location.setAttribute('aria-label','도구 영역 위치');label.append(location);
  for(const [value,text] of [['bottom','아래'],['top','위']]){const option=d.createElement('option');option.value=value;option.textContent=text;location.append(option);}
  location.onchange=()=>{if(!live()){end();return;}if(!['bottom','top'].includes(location.value))return;placement=location.value;apply();save();};
  const autoLabel=d.createElement('label');autoLabel.textContent='자동 숨김 ';nav.append(autoLabel);
  const auto=d.createElement('input');auto.type='checkbox';auto.id='kin-dock-autohide';auto.setAttribute('aria-label','도구 패널 자동 숨김');autoLabel.append(auto);
  autoLabel.title='영상 화면 안에서 도구 밖 조작을 마치면 패널을 접습니다. 버튼이나 키보드로 다시 열 수 있습니다.';
  auto.onchange=()=>{if(!live()){end();return;}autoHide=auto.checked;autoHidden=false;apply();save();};
  const reset=d.createElement('button');reset.type='button';reset.id='kin-dock-reset';reset.textContent='도구 영역 초기화';nav.append(reset);
  reset.onclick=()=>{if(!live()){end();return;}placement='bottom';selected=-1;autoHide=false;autoHidden=false;apply();save();};
  const status=d.createElement('span');status.id='kin-dock-preference-status';status.setAttribute('role','status');status.textContent=initialMessage;nav.append(status);
  function resizeVisible(){
    // Resizing a hidden iframe's zero-size image can corrupt its camera scale.
    // The workspace redraws the retained viewer when it becomes visible again.
    const frame=w.frameElement,r=root.getBoundingClientRect();
    if(r.width>0&&r.height>0&&(!frame||frame.getBoundingClientRect().width>0&&frame.getBoundingClientRect().height>0))w.dispatchEvent(new w.Event('resize'));
  }
  function apply(){
    const visible=autoHidden?-1:selected;
    panels.forEach((p,n)=>{p.hidden=visible!==n;p.open=true;buttons[n].setAttribute('aria-expanded',String(visible===n));});
    d.body.classList.toggle('kin-dock-open',visible!==-1);d.body.classList.toggle('kin-dock-top',placement==='top');location.value=placement;auto.checked=autoHide;
    w.requestAnimationFrame(resizeVisible);
    schedule();
  }
  const value=()=>({version:2,placement,panel:selected,autoHide});
  function save(){
    window.dispatchEvent(new window.CustomEvent('kin-dock-preference-changed',{detail:{owner:initialOwner,value:value()}}));
    if(!key){status.textContent='도구 영역 · 이 창';return;}
    try{storage.setItem(key,JSON.stringify(value()));status.textContent='도구 영역을 기억했습니다 · 이 브라우저';}
    catch(_){status.textContent='저장하지 못해 이 창에만 적용합니다.';}
  }
  function schedule(){
    w.clearTimeout(timer);if(ended||!autoHide||autoHidden||selected<0)return;
    timer=w.setTimeout(()=>{
      let blocked=true;
      try{blocked=!live()||hover||held||dock.contains(d.activeElement)||d.hidden||!d.hasFocus()||!!d.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')||!!dock.querySelector('[aria-busy="true"]')||!!w.kinViewerJobWorkspaceState?.().busy||!!w.kinViewerHistoryWorkspaceState?.().busy;}catch(_){}
      if(blocked){schedule();return;}
      autoHidden=true;apply();
    },1200);
  }
  const enter=e=>{if(e.target===dock){hover=true;schedule();}},leave=e=>{if(e.target===dock){hover=false;schedule();}};
  // Pointer focus must not pre-toggle the subsequent click. Keyboard focus
  // reveals the saved category; only explicit activation changes that preference.
  const focus=e=>{if(autoHidden&&!held&&e.target!==pointerButton&&buttons.includes(e.target)){autoHidden=false;apply();}schedule();};
  const down=e=>{held=true;pointerButton=buttons.find(b=>b.contains(e.target))||null;schedule();},up=e=>{held=false;if(e.type==='pointercancel'||pointerButton&&!pointerButton.contains(e.target))pointerButton=null;schedule();},blur=e=>{if(e.target===w){held=false;pointerButton=null;w.clearTimeout(timer);}};
  const move=e=>{if(held&&e.buttons===0){held=false;pointerButton=null;schedule();}},keyboardActivity=()=>{pointerButton=null;schedule();};
  const listeners=[[dock,'pointerenter',enter],[dock,'pointerleave',leave],[dock,'focusin',focus],[dock,'focusout',schedule],[d,'pointerdown',down],[d,'pointerup',up],[d,'pointercancel',up],[d,'pointermove',move],[d,'wheel',schedule],[d,'keydown',keyboardActivity],[w,'blur',blur],[w,'focus',schedule]];
  for(const [target,event,handler] of listeners)target.addEventListener(event,handler,true);
  function end(){if(ended)return;ended=true;w.clearTimeout(timer);for(const [target,event,handler] of listeners)target.removeEventListener(event,handler,true);placement='bottom';selected=-1;autoHide=false;autoHidden=false;apply();for(const b of buttons)b.disabled=true;location.disabled=reset.disabled=auto.disabled=true;w.removeEventListener('storage',onStorage);w.removeEventListener('pagehide',end);channel?.close();}
  function onStorage(e){if(e.key==='kin-session-ended')end();else if(e.key===key)status.textContent='다른 창의 설정 변경 · 현재 창 유지';}
  panels.forEach(p => { p.hidden = true; dock.append(p); });
  // OHIF can re-enter a mode without replacing the document. Adopt replacement
  // panels after their owners mount them, retaining the selected tool category.
  dock.refreshPanels = () => {
    if(!live()){end();return;}
    ['kin-viewer-history', 'kin-viewer-layout'].forEach((id, i) => {
      const next = d.getElementById(id);
      if (next && next !== panels[i]) {
        origins.push({panel:next,parent:next.parentNode,next:next.nextSibling,open:next.open,hidden:next.hidden});
        panels[i] = next; next.hidden = autoHidden || selected !== i; next.open = true; dock.append(next);
      }
    });
  };
  dock.end=end;
  dock.applyPreference=next=>{const clean=normalize(next);if(!live()||!clean)return false;placement=clean.placement;selected=clean.panel;autoHide=clean.autoHide??autoHide;autoHidden=false;apply();save();return true;};
  dock.preference=()=>live()?value():null;
  dock.dispose=()=>{
    end();
    for(const origin of origins){const p=origin.panel;if(p.parentNode!==dock)continue;const parent=origin.parent.isConnected?origin.parent:d.body;parent.insertBefore(p,origin.next?.parentNode===parent?origin.next:null);p.open=origin.open;p.hidden=origin.hidden;}
    dock.remove();style.remove();d.body.classList.remove('kin-docked','kin-dock-open','kin-dock-top');
    w.requestAnimationFrame(resizeVisible);
  };
  d.body.append(dock); d.body.classList.add('kin-docked');
  apply();w.addEventListener('storage',onStorage);w.addEventListener('pagehide',end);
  try{channel=new w.BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
  window.dispatchEvent(new window.CustomEvent('kin-dock-preference-mounted',{detail:{owner:initialOwner,value:value()}}));
  return dock;
};
window.KinViewerWorkspaceDock.normalize=v=>v&&typeof v==='object'&&!Array.isArray(v)&&[1,2].includes(v.version)&&Object.keys(v).sort().join(',')===(v.version===2?'autoHide,panel,placement,version':'panel,placement,version')&&(v.version===1||typeof v.autoHide==='boolean')&&['bottom','top'].includes(v.placement)&&[-1,0,1].includes(v.panel)?{version:v.version,placement:v.placement,panel:v.panel,...(v.version===2?{autoHide:v.autoHide}:{})}:null;
