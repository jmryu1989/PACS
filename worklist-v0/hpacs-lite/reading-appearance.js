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
  const colorKey=initialOwner?'kin-reading-color:v1:'+initialOwner:null;
  const colors={default:'var(--kin-text)',warm:'#fff1d6',cool:'#d7f3ff',white:'#ffffff'};
  const defaultColors=()=>({version:1,list:'default',current:'default',prior:'default'});
  const normalizeColors=v=>v&&typeof v==='object'&&!Array.isArray(v)&&v.version===1&&Object.keys(v).length===4&&
    ['list','current','prior'].every(k=>typeof v[k]==='string'&&Object.hasOwn(colors,v[k]))?{version:1,list:v.list,current:v.current,prior:v.prior}:null;
  let colorValue=defaultColors();
  const normalize=v=>v&&typeof v==='object'&&!Array.isArray(v)&&v.version===1&&
    Object.keys(v).length===4&&['list','current','prior'].every(k=>sizes.includes(v[k]))?{version:1,list:v.list,current:v.current,prior:v.prior}:null;
  let value=defaults(),ended=false,storage,channel,generation=0;
  const dockKey=initialOwner?'kin-viewer-dock:v1:'+initialOwner:null,normalizeDock=window.KinViewerWorkspaceDock.normalize;
  let dockValue={version:2,placement:'bottom',panel:-1,autoHide:false};
  const live=()=>!ended&&!!key&&owner()===initialOwner;
  const style=document.createElement('style');style.textContent=`
    #rows td, #rows td span, #relrows td, #relrows td span { font-size:var(--kin-list-text,var(--kin-column-text,12px)); font-family:var(--kin-list-font,var(--kin-column-font,inherit)); }
    .redit textarea { font-size:var(--kin-current-text,12px); font-family:var(--kin-current-font,inherit); }
    .prior-report-value { font-size:var(--kin-prior-text,12px); font-family:var(--kin-prior-font,inherit); }
    #rows td, #relrows td { color:var(--kin-list-color,var(--kin-column-color,var(--kin-text))); }
    .redit textarea { color:var(--kin-current-color,var(--kin-text)); }
    .prior-report-value { color:var(--kin-prior-color,var(--kin-text)); }
    #reading-appearance-dialog { width:440px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;background:#172333;color:#dce7f5;border:1px solid #819bb7;border-radius:8px;padding:20px;font:14px 'Malgun Gothic','Segoe UI',sans-serif; }
    #reading-appearance-dialog::backdrop { background:#0008; }
    #reading-appearance-dialog label { display:flex;justify-content:space-between;align-items:center;gap:16px;margin:14px 0; }
    #reading-appearance-dialog select, #reading-appearance-dialog button { font:inherit;padding:6px 10px;background:#263b53;color:#e1ebf7;border:1px solid #849bb4;border-radius:4px; }
    #reading-appearance-dialog footer { display:flex;gap:12px;justify-content:flex-end;margin-top:16px; }
    #reading-appearance-dialog h2 { margin:0 0 12px;font-size:18px; }
  `;document.head.append(style);
  const dialog=document.createElement('dialog');dialog.id='reading-appearance-dialog';dialog.setAttribute('aria-labelledby','reading-appearance-title');
  const element=(tag,text,parent)=>{const e=document.createElement(tag);e.textContent=text;if(parent)parent.append(e);return e;};
  const title=element('h2','글자·도구 설정',dialog);title.id='reading-appearance-title';
  element('p','글자 크기·글꼴·색과 도구 위치를 계정에 저장하고 다른 기기에서 함께 불러올 수 있습니다. 이전 설정에 없는 항목은 현재 값을 유지합니다.',dialog);
  const fields={};
  for(const [name,label] of [['list','검사 목록'],['current','작성 중 판독문'],['prior','과거 판독문']]){
    const row=element('label',label,dialog),select=element('select','',row);select.id='reading-text-'+name;
    for(const size of sizes){const option=element('option',size+' px',select);option.value=String(size);}
    fields[name]=select;select.onchange=()=>{if(!live()){end();return;}value={...value,[name]:Number(select.value)};apply();save();};
  }
  const fontSection=element('fieldset','',dialog);element('legend','글꼴',fontSection);
  element('p','설치되지 않은 글꼴은 기기의 대체 글꼴로 표시합니다.',fontSection);
  const fontFields={};
  for(const [name,label] of [['list','검사 목록 글꼴'],['current','작성 중 판독문 글꼴'],['prior','과거 판독문 글꼴']]){
    const row=element('label',label,fontSection),select=element('select','',row);select.id='reading-font-'+name;
    for(const [id,text] of [['default','기본'],['sans','고딕'],['serif','명조'],['mono','고정폭']]){const option=element('option',text,select);option.value=id;}
    fontFields[name]=select;select.onchange=()=>{if(!live()){end();return;}const clean=normalizeFonts({...fontValue,[name]:select.value});if(!clean)return;fontValue=clean;applyFonts();saveFonts();};
  }
  const fontStatus=element('p','',fontSection);fontStatus.id='reading-font-status';fontStatus.setAttribute('role','status');
  const fontReset=element('button','기본 글꼴',fontSection);fontReset.type='button';fontReset.id='reading-font-reset';
  fontReset.onclick=()=>{if(!live()){end();return;}fontValue=defaultFonts();applyFonts();saveFonts();};
  const colorSection=element('fieldset','',dialog);element('legend','글자색',colorSection);
  element('p','기본 글자색만 바꿉니다. 검사 상태색과 선택 표시는 유지합니다.',colorSection);
  const colorFields={};
  for(const [name,label] of [['list','검사 목록 글자색'],['current','작성 중 판독문 글자색'],['prior','과거 판독문 글자색']]){
    const row=element('label',label,colorSection),select=element('select','',row);select.id='reading-color-'+name;
    for(const [id,text] of [['default','기본'],['warm','따뜻한 흰색'],['cool','차가운 흰색'],['white','흰색']]){const option=element('option',text,select);option.value=id;}
    colorFields[name]=select;select.onchange=()=>{if(!live()){end();return;}const clean=normalizeColors({...colorValue,[name]:select.value});if(!clean)return;colorValue=clean;applyColors();saveColors();};
  }
  const colorStatus=element('p','',colorSection);colorStatus.id='reading-color-status';colorStatus.setAttribute('role','status');
  const colorReset=element('button','기본 글자색',colorSection);colorReset.type='button';colorReset.id='reading-color-reset';
  colorReset.onclick=()=>{if(!live()){end();return;}colorValue=defaultColors();applyColors();saveColors();};
  const dockSection=element('fieldset','',dialog);element('legend','영상 도구 영역',dockSection);
  element('p','현재 통합 영상과 다음 영상 창에 적용합니다. 이미 열린 다른 영상 창은 유지합니다.',dockSection);
  const dockFields={};
  for(const [name,label,choices] of [['placement','도구 위치',[['bottom','아래'],['top','위']]],['panel','열 도구',[['-1','접기'],['0','측정·주석'],['1','비교 작업·배치']]]]){
    const row=element('label',label,dockSection),select=element('select','',row);select.id='reading-dock-'+name;dockFields[name]=select;
    for(const [id,text] of choices){const option=element('option',text,select);option.value=id;}
    select.onchange=()=>{if(!live()){end();return;}setDock({...dockValue,[name]:name==='panel'?Number(select.value):select.value});};
  }
  const autoLabel=element('label','도구 패널 자동 숨김 ',dockSection),autoInput=element('input','',autoLabel);autoInput.type='checkbox';autoInput.id='reading-dock-autohide';dockFields.autoHide=autoInput;
  autoInput.onchange=()=>{if(!live()){end();return;}setDock({...dockValue,autoHide:autoInput.checked});};
  const dockStatus=element('p','',dockSection);dockStatus.id='reading-dock-status';dockStatus.setAttribute('role','status');
  const viewer=window.KinViewerIdentity;let viewerValue=viewer.read(initialOwner);
  const viewerFields={},viewerSection=element('fieldset','',dialog);element('legend','영상 식별 표시',viewerSection);
  element('p','기준 검사와 비교 검사의 글자를 따로 설정합니다. 환자 ID와 기준/비교 표시는 항상 유지합니다. 설치되지 않은 글꼴은 기기의 대체 글꼴을 사용합니다.',viewerSection);
  for(const [role,label] of [['current','기준 영상'],['prior','비교 영상']]){
    const group=element('fieldset','',viewerSection);element('legend',label,group);viewerFields[role]={};
    for(const [field,caption,choices] of [['size','크기',[12,14,16,18,20].map(n=>[String(n),n+' px'])],['font','글꼴',[['default','기본'],['sans','고딕'],['serif','명조'],['mono','고정폭']]],['color','글자색',[['default','기본'],['warm','따뜻한 흰색'],['cool','차가운 흰색'],['white','흰색']]]]){
      const row=element('label',label+' '+caption,group),select=element('select','',row);select.id='viewer-identity-'+role+'-'+field;viewerFields[role][field]=select;
      for(const [id,text] of choices){const option=element('option',text,select);option.value=id;}
      select.onchange=()=>changeViewer(role,field,field==='size'?Number(select.value):select.value);
    }
    for(const [field,caption] of [['name','환자 이름'],['date','검사일'],['description','검사 설명']]){const row=element('label',label+' '+caption,group),input=element('input','',row);input.type='checkbox';input.id='viewer-identity-'+role+'-'+field;viewerFields[role][field]=input;input.onchange=()=>changeViewer(role,field,input.checked);}
  }
  const viewerStatus=element('p','',viewerSection);viewerStatus.id='viewer-identity-status';viewerStatus.setAttribute('role','status');
  function showViewer(){for(const role of ['current','prior'])for(const [field,e] of Object.entries(viewerFields[role])){if(e.type==='checkbox')e.checked=viewerValue[role][field];else e.value=String(viewerValue[role][field]);}}
  function setViewer(next){const clean=viewer.normalize(next);if(!live()||!clean)return false;viewerValue=clean;generation++;showViewer();const saved=viewer.publish(initialOwner,clean);viewerStatus.textContent=saved?'영상 표시를 기억했습니다 · 이 브라우저':'저장소를 사용할 수 없어 현재 화면에만 적용합니다.';return true;}
  function changeViewer(role,field,value){if(!live()){end();return;}setViewer({...viewerValue,[role]:{...viewerValue[role],[field]:value}});}
  const stopViewer=viewer.subscribe(initialOwner,next=>{if(!live())return;if(JSON.stringify(viewerValue)!==JSON.stringify(next)){viewerValue=next;generation++;showViewer();viewerStatus.textContent='같은 계정의 영상 표시 변경을 적용했습니다.';}});showViewer();
  function showDock(){dockFields.placement.value=dockValue.placement;dockFields.panel.value=String(dockValue.panel);dockFields.autoHide.checked=!!dockValue.autoHide;}
  function setDock(next){
    let clean=normalizeDock(next);if(!live()||!clean)return false;clean={...clean,version:2,autoHide:clean.autoHide??dockValue.autoHide};
    const dock=options.getDock?.();
    if(dock){if(!dock.applyPreference(clean))return false;generation++;dockValue=clean;showDock();dockStatus.textContent=dock.querySelector('#kin-dock-preference-status').textContent;return true;}
    dockValue=clean;generation++;showDock();
    try{storage.setItem(dockKey,JSON.stringify(clean));dockStatus.textContent='다음 영상 창에 적용합니다 · 이 브라우저';}
    catch(_){dockStatus.textContent='저장소를 사용할 수 없어 설정을 이 창에만 유지합니다.';}
    return true;
  }
  function dockChanged(e){if(!live()||e.detail?.owner!==initialOwner)return;let clean=normalizeDock(e.detail.value);if(!clean)return;clean={...clean,version:2,autoHide:clean.autoHide??dockValue.autoHide};if(e.type==='kin-dock-preference-changed'||JSON.stringify(clean)!==JSON.stringify(dockValue))generation++;dockValue=clean;showDock();}
  window.addEventListener('kin-dock-preference-changed',dockChanged);window.addEventListener('kin-dock-preference-mounted',dockChanged);
  const status=element('p','',dialog);status.id='reading-appearance-status';status.setAttribute('role','status');
  const account=element('section','계정 저장 기능을 연결하지 못했습니다. 현재 브라우저 설정은 사용할 수 있습니다.',dialog);
  account.id='reading-appearance-account';account.style.cssText='border-top:1px solid #819bb7;padding-top:12px;display:flex;flex-wrap:wrap;gap:8px';
  const footer=element('footer','',dialog),reset=element('button','기본 크기',footer),close=element('button','닫기',footer);
  reset.type=close.type='button';reset.id='reading-appearance-reset';close.id='reading-appearance-close';
  document.body.append(dialog);
  // An absent global preference must not silently replace saved column typography.
  // Explicit edits/account loads (including defaults) retain global precedence.
  function apply(explicit=true){for(const name of ['list','current','prior']){const property='--kin-'+name+'-text';if(name==='list'&&!explicit)document.documentElement.style.removeProperty(property);else document.documentElement.style.setProperty(property,value[name]+'px');fields[name].value=String(value[name]);}}
  function applyFonts(explicit=true){for(const name of ['list','current','prior']){const property='--kin-'+name+'-font';if(name==='list'&&!explicit)document.documentElement.style.removeProperty(property);else document.documentElement.style.setProperty(property,name==='list'&&fontValue[name]==='default'?getComputedStyle(document.body).fontFamily:fonts[fontValue[name]]);fontFields[name].value=fontValue[name];}}
  function saveFonts(){
    if(!live())return;
    generation++;
    try{storage.setItem(fontKey,JSON.stringify(fontValue));fontStatus.textContent='글꼴을 기억했습니다 · 이 브라우저';}
    catch(_){fontStatus.textContent='저장소를 사용할 수 없어 글꼴을 이 창에만 적용합니다.';}
  }
  function applyColors(explicit=true){for(const name of ['list','current','prior']){const property='--kin-'+name+'-color';if(name==='list'&&!explicit)document.documentElement.style.removeProperty(property);else document.documentElement.style.setProperty(property,colors[colorValue[name]]);colorFields[name].value=colorValue[name];}}
  function saveColors(){
    if(!live())return;
    generation++;
    try{storage.setItem(colorKey,JSON.stringify(colorValue));colorStatus.textContent='글자색을 기억했습니다 · 이 브라우저';}
    catch(_){colorStatus.textContent='저장소를 사용할 수 없어 글자색을 이 창에만 적용합니다.';}
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
    stopViewer();for(const fields of Object.values(viewerFields))for(const e of Object.values(fields))e.disabled=true;
    ended=true;opener.disabled=true;for(const f of Object.values(fields))f.disabled=true;reset.disabled=true;
    if(dialog.open)dialog.close();value=defaults();apply();fontValue=defaultFonts();applyFonts();
    for(const f of Object.values(fontFields))f.disabled=true;fontReset.disabled=true;
    colorValue=defaultColors();applyColors();for(const f of Object.values(colorFields))f.disabled=true;colorReset.disabled=true;
    for(const f of Object.values(dockFields))f.disabled=true;
    window.removeEventListener('kin-dock-preference-changed',dockChanged);window.removeEventListener('kin-dock-preference-mounted',dockChanged);
    window.removeEventListener('storage',onStorage);window.removeEventListener('pagehide',end);channel?.close();
  }
  function onStorage(e){if(e.key==='kin-session-ended')end();else if(dockKey&&e.key===dockKey){
    // A child iframe's own write also emits storage in this parent. Its custom
    // change event already updated the live value and generation synchronously.
    let matches=false;try{const clean=e.newValue?.length<=128?normalizeDock(JSON.parse(e.newValue)):null;matches=clean&&JSON.stringify(clean)===JSON.stringify(dockValue);}catch(_){}
    if(!matches){generation++;dockStatus.textContent='다른 창의 도구 설정 변경 · 현재 창 유지';}
  }else if(e.key===key)status.textContent='다른 창에서 글자 크기가 바뀌었습니다. 현재 창은 유지하며 페이지를 다시 열 때 불러옵니다.';else if(e.key===fontKey)fontStatus.textContent='다른 창에서 글꼴이 바뀌었습니다. 현재 창은 유지하며 페이지를 다시 열 때 불러옵니다.';else if(e.key===colorKey)colorStatus.textContent='다른 창에서 글자색이 바뀌었습니다. 현재 창은 유지하며 페이지를 다시 열 때 불러옵니다.';}
  let hasText=true,hasFont=true,hasColor=true;
  try{
    storage=localStorage;const raw=key?storage.getItem(key):null;
    hasText=raw!==null;
    if(raw!==null){const clean=raw.length<=256?normalize(JSON.parse(raw)):null;if(clean){value=clean;status.textContent='기억한 글자 크기를 불러왔습니다.';}else status.textContent='저장된 글자 크기 오류 · 기본 크기를 적용했습니다.';}
    else status.textContent='기본 글자 크기입니다.';
  }catch(_){status.textContent='저장된 설정을 읽지 못해 기본 크기를 적용했습니다.';}
  try{
    const raw=fontKey?storage.getItem(fontKey):null;
    hasFont=raw!==null;
    if(raw!==null){const clean=raw.length<=256?normalizeFonts(JSON.parse(raw)):null;if(clean){fontValue=clean;fontStatus.textContent='기억한 글꼴을 불러왔습니다.';}else fontStatus.textContent='저장된 글꼴 오류 · 기본 글꼴을 적용했습니다.';}
    else fontStatus.textContent='기본 글꼴입니다.';
  }catch(_){fontStatus.textContent='저장된 글꼴을 읽지 못해 기본 글꼴을 적용했습니다.';}
  try{
    const raw=colorKey?storage.getItem(colorKey):null;
    hasColor=raw!==null;
    if(raw!==null){const clean=raw.length<=256?normalizeColors(JSON.parse(raw)):null;if(clean){colorValue=clean;colorStatus.textContent='기억한 글자색을 불러왔습니다.';}else colorStatus.textContent='저장된 글자색 오류 · 기본 글자색을 적용했습니다.';}
    else colorStatus.textContent='기본 글자색입니다.';
  }catch(_){colorStatus.textContent='저장된 글자색을 읽지 못해 기본 글자색을 적용했습니다.';}
  try{const raw=dockKey?storage.getItem(dockKey):null;if(raw!==null){const clean=raw.length<=128?normalizeDock(JSON.parse(raw)):null;if(clean)dockValue={...clean,version:2,autoHide:clean.autoHide??false};else dockStatus.textContent='저장된 도구 설정 오류 · 기본값';}}catch(_){dockStatus.textContent='도구 설정을 읽지 못해 기본값을 표시합니다.';}
  apply(hasText);applyFonts(hasFont);applyColors(hasColor);showDock();opener.disabled=!live();
  window.addEventListener('storage',onStorage);window.addEventListener('pagehide',end);
  try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
  const normalizeAccount=v=>{
    const legacy=normalize(v);if(legacy)return legacy;
    if(!v||typeof v!=='object'||Array.isArray(v)||![2,3,4,5].includes(v.version)||Object.keys(v).sort().join(',')!==(v.version>=4?'colors,current,dock,fonts,list,prior,version,viewer':v.version===3?'colors,current,dock,fonts,list,prior,version':'colors,current,fonts,list,prior,version'))return null;
    const clean=normalize({version:1,list:v.list,current:v.current,prior:v.prior}),f=normalizeFonts(v.fonts),c=normalizeColors(v.colors);
    const dock=v.version>=3?normalizeDock(v.dock):null,view=v.version>=4?viewer.normalize(v.viewer):null;
    return clean&&f&&c&&(v.version===2||dock)&&(v.version<4||view)&&(v.version<3||dock?.version===(v.version===5?2:1))?{...clean,version:v.version,fonts:f,colors:c,...(dock?{dock}:{}),...(view?{viewer:view}:{})}:null;
  };
  return {host:account,read:()=>({...value,version:5,fonts:{...fontValue},colors:{...colorValue},dock:{...dockValue},viewer:viewer.normalize(viewerValue)}),generation:()=>generation,normalize:normalizeAccount,allowed:live,
    apply:next=>{const clean=normalizeAccount(next);if(!live()||!clean)return false;
      if(clean.version>=3&&!setDock(clean.dock))return false;
      if(clean.version>=4&&!setViewer(clean.viewer))return false;
      value={version:1,list:clean.list,current:clean.current,prior:clean.prior};
      if(clean.version>=2){fontValue=clean.fonts;colorValue=clean.colors;applyFonts();applyColors();saveFonts();saveColors();}
      apply();save();return true;}};
};
