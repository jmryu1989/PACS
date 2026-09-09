/* Display-only browser preferences; never store clinical text or viewer state. */
window.KinReadingAppearance = function (options) {
  'use strict';
  const {owner}=options;
  const opener=document.querySelector('#reading-appearance-open');
  const prefix='kin-reading-text:v1:',initialOwner=owner();
  const key=initialOwner?prefix+initialOwner:null,sizes=[12,14,16,18,20];
  const defaults=()=>({version:1,list:12,current:12,prior:12});
  const fontKey=initialOwner?'kin-reading-font:v1:'+initialOwner:null;
  const fonts={default:'inherit',sans:'"Malgun Gothic", "Noto Sans KR", sans-serif',serif:'"Batang", "Noto Serif KR", serif',mono:'"D2Coding", "Consolas", monospace'};
  const defaultFonts=()=>({version:1,list:'default',current:'default',prior:'default'});
  const normalizeFonts=v=>v&&typeof v==='object'&&!Array.isArray(v)&&v.version===1&&Object.keys(v).length===4&&
    ['list','current','prior'].every(k=>typeof v[k]==='string'&&Object.hasOwn(fonts,v[k]))?{version:1,list:v.list,current:v.current,prior:v.prior}:null;
  let fontValue=defaultFonts();
  const normalize=v=>v&&typeof v==='object'&&!Array.isArray(v)&&v.version===1&&
    Object.keys(v).length===4&&['list','current','prior'].every(k=>sizes.includes(v[k]))?{version:1,list:v.list,current:v.current,prior:v.prior}:null;
  let value=defaults(),ended=false,storage,channel,generation=0;
  const live=()=>!ended&&!!key&&owner()===initialOwner;
  const style=document.createElement('style');style.textContent=`
    #rows td, #rows td span, #relrows td, #relrows td span { font-size:var(--kin-list-text,12px); font-family:var(--kin-list-font,inherit); }
    .redit textarea { font-size:var(--kin-current-text,12px); font-family:var(--kin-current-font,inherit); }
    .prior-report-value { font-size:var(--kin-prior-text,12px); font-family:var(--kin-prior-font,inherit); }
    #reading-appearance-dialog { width:360px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;background:#172333;color:#dce7f5;border:1px solid #819bb7;border-radius:8px;padding:20px;font:14px 'Malgun Gothic','Segoe UI',sans-serif; }
    #reading-appearance-dialog::backdrop { background:#0008; }
    #reading-appearance-dialog label { display:flex;justify-content:space-between;align-items:center;gap:16px;margin:14px 0; }
    #reading-appearance-dialog select, #reading-appearance-dialog button { font:inherit;padding:6px 10px;background:#263b53;color:#e1ebf7;border:1px solid #849bb4;border-radius:4px; }
    #reading-appearance-dialog footer { display:flex;gap:12px;justify-content:flex-end;margin-top:16px; }
    #reading-appearance-dialog h2 { margin:0 0 12px;font-size:18px; }
  `;document.head.append(style);
  const dialog=document.createElement('dialog');dialog.id='reading-appearance-dialog';dialog.setAttribute('aria-labelledby','reading-appearance-title');
  const element=(tag,text,parent)=>{const e=document.createElement(tag);e.textContent=text;if(parent)parent.append(e);return e;};
  const title=element('h2','글자 설정',dialog);title.id='reading-appearance-title';
  element('p','글자 크기는 현재 브라우저에 기억하며, 계정에 저장한 뒤 다른 기기에서 불러올 수 있습니다.',dialog);
  const fields={};
  for(const [name,label] of [['list','검사 목록'],['current','작성 중 판독문'],['prior','과거 판독문']]){
    const row=element('label',label,dialog),select=element('select','',row);select.id='reading-text-'+name;
    for(const size of sizes){const option=element('option',size+' px',select);option.value=String(size);}
    fields[name]=select;select.onchange=()=>{if(!live()){end();return;}value={...value,[name]:Number(select.value)};apply();save();};
  }
  const fontSection=element('fieldset','',dialog);element('legend','글꼴 · 이 브라우저',fontSection);
  element('p','이 계정의 현재 브라우저에만 기억합니다. 설치되지 않은 글꼴은 기기의 대체 글꼴로 표시합니다.',fontSection);
  const fontFields={};
  for(const [name,label] of [['list','검사 목록 글꼴'],['current','작성 중 판독문 글꼴'],['prior','과거 판독문 글꼴']]){
    const row=element('label',label,fontSection),select=element('select','',row);select.id='reading-font-'+name;
    for(const [id,text] of [['default','기본'],['sans','고딕'],['serif','명조'],['mono','고정폭']]){const option=element('option',text,select);option.value=id;}
    fontFields[name]=select;select.onchange=()=>{if(!live()){end();return;}const clean=normalizeFonts({...fontValue,[name]:select.value});if(!clean)return;fontValue=clean;applyFonts();saveFonts();};
  }
  const fontStatus=element('p','',fontSection);fontStatus.id='reading-font-status';fontStatus.setAttribute('role','status');
  const fontReset=element('button','기본 글꼴',fontSection);fontReset.type='button';fontReset.id='reading-font-reset';
  fontReset.onclick=()=>{if(!live()){end();return;}fontValue=defaultFonts();applyFonts();saveFonts();};
  const status=element('p','',dialog);status.id='reading-appearance-status';status.setAttribute('role','status');
  const account=element('section','계정 저장 기능을 연결하지 못했습니다. 현재 브라우저 설정은 사용할 수 있습니다.',dialog);
  account.id='reading-appearance-account';account.style.cssText='border-top:1px solid #819bb7;padding-top:12px;display:flex;flex-wrap:wrap;gap:8px';
  const footer=element('footer','',dialog),reset=element('button','기본 크기',footer),close=element('button','닫기',footer);
  reset.type=close.type='button';reset.id='reading-appearance-reset';close.id='reading-appearance-close';
  document.body.append(dialog);
  function apply(){for(const name of ['list','current','prior']){document.documentElement.style.setProperty('--kin-'+name+'-text',value[name]+'px');fields[name].value=String(value[name]);}}
  function applyFonts(){for(const name of ['list','current','prior']){document.documentElement.style.setProperty('--kin-'+name+'-font',fonts[fontValue[name]]);fontFields[name].value=fontValue[name];}}
  function saveFonts(){
    if(!live())return;
    try{storage.setItem(fontKey,JSON.stringify(fontValue));fontStatus.textContent='글꼴을 기억했습니다 · 이 브라우저';}
    catch(_){fontStatus.textContent='저장소를 사용할 수 없어 글꼴을 이 창에만 적용합니다.';}
  }
  function save(){
    const clean=normalize(value);if(!live()||!clean){end();return;}
    generation++;
    try{storage.setItem(key,JSON.stringify(clean));status.textContent='글자 크기를 기억했습니다 · 이 브라우저';}
    catch(_){status.textContent='저장소를 사용할 수 없어 이 창에만 적용합니다.';}
  }
  reset.onclick=()=>{if(!live()){end();return;}value=defaults();apply();save();};
  close.onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{if(live()&&opener.isConnected)opener.focus({preventScroll:true});});
  opener.onclick=()=>{if(!live()){end();return;}if(!dialog.open)dialog.showModal();};
  function end(){
    ended=true;opener.disabled=true;for(const f of Object.values(fields))f.disabled=true;reset.disabled=true;
    if(dialog.open)dialog.close();value=defaults();apply();fontValue=defaultFonts();applyFonts();
    for(const f of Object.values(fontFields))f.disabled=true;fontReset.disabled=true;
    window.removeEventListener('storage',onStorage);window.removeEventListener('pagehide',end);channel?.close();
  }
  function onStorage(e){if(e.key==='kin-session-ended')end();else if(e.key===key)status.textContent='다른 창에서 글자 크기가 바뀌었습니다. 현재 창은 유지하며 페이지를 다시 열 때 불러옵니다.';else if(e.key===fontKey)fontStatus.textContent='다른 창에서 글꼴이 바뀌었습니다. 현재 창은 유지하며 페이지를 다시 열 때 불러옵니다.';}
  try{
    storage=localStorage;const raw=key?storage.getItem(key):null;
    if(raw!==null){const clean=raw.length<=256?normalize(JSON.parse(raw)):null;if(clean){value=clean;status.textContent='기억한 글자 크기를 불러왔습니다.';}else status.textContent='저장된 글자 크기 오류 · 기본 크기를 적용했습니다.';}
    else status.textContent='기본 글자 크기입니다.';
  }catch(_){status.textContent='저장된 설정을 읽지 못해 기본 크기를 적용했습니다.';}
  try{
    const raw=fontKey?storage.getItem(fontKey):null;
    if(raw!==null){const clean=raw.length<=256?normalizeFonts(JSON.parse(raw)):null;if(clean){fontValue=clean;fontStatus.textContent='기억한 글꼴을 불러왔습니다.';}else fontStatus.textContent='저장된 글꼴 오류 · 기본 글꼴을 적용했습니다.';}
    else fontStatus.textContent='기본 글꼴입니다.';
  }catch(_){fontStatus.textContent='저장된 글꼴을 읽지 못해 기본 글꼴을 적용했습니다.';}
  apply();applyFonts();opener.disabled=!live();
  window.addEventListener('storage',onStorage);window.addEventListener('pagehide',end);
  try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
  return {host:account,read:()=>({...value}),generation:()=>generation,normalize,allowed:live,
    apply:next=>{const clean=normalize(next);if(!live()||!clean)return false;value=clean;apply();save();return true;}};
};
