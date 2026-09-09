/* Keep viewer controls in their own document so their live state and listeners
 * survive panel switches. Reserve space instead of covering diagnostic pixels. */
window.KinViewerWorkspaceDock = function (w, preferences) {
  'use strict';
  preferences=preferences||{};
  const d = w.document;
  const existing = d.getElementById('kin-workspace-dock');
  if (existing) { existing.refreshPanels(); return; }
  const root = d.getElementById('root');
  const panels = ['kin-viewer-history', 'kin-viewer-layout'].map(id => d.getElementById(id));
  if (!root || panels.some(p => !p)) return;
  const initialOwner=preferences.owner?.(),key=initialOwner?'kin-viewer-dock:v1:'+initialOwner:null;
  const normalize=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')==='panel,placement,version'&&v.version===1&&['bottom','top'].includes(v.placement)&&[-1,0,1].includes(v.panel)?{version:1,placement:v.placement,panel:v.panel}:null;
  let ended=false,placement='bottom',selected=-1,storage,channel,initialMessage='도구 영역 · 이 창';
  const live=()=>!ended&&preferences.allowed?.()!==false&&(!initialOwner||preferences.owner?.()===initialOwner);
  try{storage=w.localStorage;const raw=key?storage.getItem(key):null;if(raw!==null){const value=raw.length<=128?normalize(JSON.parse(raw)):null;if(value){placement=value.placement;selected=value.panel;initialMessage='기억한 도구 영역';}else initialMessage='저장값 오류 · 기본 도구 영역';}else if(key)initialMessage='도구 영역 · 이 브라우저';}catch(_){initialMessage='저장소 사용 불가 · 이 창';}
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
      selected = selected === i ? -1 : i;
      apply();save();
    };
    nav.append(b); return b;
  });
  const label=d.createElement('label');label.textContent='도구 위치 ';nav.append(label);
  const location=d.createElement('select');location.id='kin-dock-placement';location.setAttribute('aria-label','도구 영역 위치');label.append(location);
  for(const [value,text] of [['bottom','아래'],['top','위']]){const option=d.createElement('option');option.value=value;option.textContent=text;location.append(option);}
  location.onchange=()=>{if(!live()){end();return;}if(!['bottom','top'].includes(location.value))return;placement=location.value;apply();save();};
  const reset=d.createElement('button');reset.type='button';reset.id='kin-dock-reset';reset.textContent='도구 영역 초기화';nav.append(reset);
  reset.onclick=()=>{if(!live()){end();return;}placement='bottom';selected=-1;apply();save();};
  const status=d.createElement('span');status.id='kin-dock-preference-status';status.setAttribute('role','status');status.textContent=initialMessage;nav.append(status);
  function apply(){
    panels.forEach((p,n)=>{p.hidden=selected!==n;p.open=true;buttons[n].setAttribute('aria-expanded',String(selected===n));});
    d.body.classList.toggle('kin-dock-open',selected!==-1);d.body.classList.toggle('kin-dock-top',placement==='top');location.value=placement;
    w.requestAnimationFrame(()=>w.dispatchEvent(new w.Event('resize')));
  }
  function save(){
    if(!key){status.textContent='도구 영역 · 이 창';return;}
    try{storage.setItem(key,JSON.stringify({version:1,placement,panel:selected}));status.textContent='도구 영역을 기억했습니다 · 이 브라우저';}
    catch(_){status.textContent='저장하지 못해 이 창에만 적용합니다.';}
  }
  function end(){if(ended)return;ended=true;placement='bottom';selected=-1;apply();for(const b of buttons)b.disabled=true;location.disabled=reset.disabled=true;w.removeEventListener('storage',onStorage);w.removeEventListener('pagehide',end);channel?.close();}
  function onStorage(e){if(e.key==='kin-session-ended')end();else if(e.key===key)status.textContent='다른 창의 설정 변경 · 현재 창 유지';}
  panels.forEach(p => { p.hidden = true; dock.append(p); });
  // OHIF can re-enter a mode without replacing the document. Adopt replacement
  // panels after their owners mount them, retaining the selected tool category.
  dock.refreshPanels = () => {
    if(!live()){end();return;}
    ['kin-viewer-history', 'kin-viewer-layout'].forEach((id, i) => {
      const next = d.getElementById(id);
      if (next && next !== panels[i]) {
        panels[i] = next; next.hidden = selected !== i; next.open = true; dock.append(next);
      }
    });
  };
  d.body.append(dock); d.body.classList.add('kin-docked');
  apply();w.addEventListener('storage',onStorage);w.addEventListener('pagehide',end);
  try{channel=new w.BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
};
