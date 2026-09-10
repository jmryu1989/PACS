(function(root){
  'use strict';
  const copy=value=>JSON.parse(JSON.stringify(value));
  function normalize(value){
    return value?.version===1&&['automatic','manual'].includes(value.mode)&&typeof value.clearResults==='boolean'
      &&Object.keys(value).sort().join()==='clearResults,mode,version'?copy(value):null;
  }
  function create(initial,preferences){
    let applied=copy(initial),empty=false,prefs=normalize(preferences)||{version:1,mode:'automatic',clearResults:false};
    return {
      read(current){return {criteria:copy(prefs.mode==='automatic'&&!empty?current:applied),empty,pending:!empty&&prefs.mode==='manual'&&JSON.stringify(applied)!==JSON.stringify(current)};},
      apply(current){applied=copy(current);empty=false;},
      change(current){if(prefs.mode==='automatic'){applied=copy(current);empty=false;}},
      clear(current){applied=copy(current);empty=prefs.clearResults;},
      configure(next,current){const valid=normalize(next);if(!valid)return false;if(valid.mode!==prefs.mode){applied=copy(current);empty=false;}prefs=valid;return true;},
      preferences:()=>copy(prefs),
    };
  }
  function mount({host,owner,snapshot,render}){
    const bound=owner(),key=bound&&'kin-worklist-search:v1:'+bound;let saved=null,note='',ended=false;
    try{const raw=key&&root.localStorage.getItem(key);if(raw){saved=raw.length<=200&&normalize(JSON.parse(raw));if(!saved)note='저장된 검색 설정을 확인할 수 없어 기본값을 적용했습니다.';}}
    catch(_){note='검색 설정을 읽지 못해 기본값을 적용했습니다.';}
    const state=create(snapshot(),saved),container=document.createElement('span');container.style.cssText='display:flex;gap:6px;align-items:center;flex-wrap:wrap';
    container.innerHTML='<label>Search Mode <select class="chip" data-search-mode><option value="automatic">Automatic</option><option value="manual">Manual</option></select></label><button class="chip" type="button" data-search-apply>Search</button><label><input type="checkbox" data-search-clear> Clear Results on Clear</label><small data-search-status role="status"></small>';
    host.append(container);const mode=container.querySelector('select'),clear=container.querySelector('input'),status=container.querySelector('[role=status]');
    mode.value=state.preferences().mode;clear.checked=state.preferences().clearResults;
    const live=()=>!ended&&bound&&owner()===bound;
    function show(){const result=state.read(snapshot());status.textContent=result.empty?'검색 결과를 비웠습니다. Search로 다시 검색하세요.':result.pending?'조건 변경 미적용 · 목록은 이전 검색 결과입니다.':note;}
    function apply(){if(!live())return;state.apply(snapshot());note='';render();show();}
    function configure(){if(!live())return;state.configure({version:1,mode:mode.value,clearResults:clear.checked},snapshot());
      try{root.localStorage.setItem(key,JSON.stringify(state.preferences()));note='';}catch(_){note='검색 설정을 저장하지 못했습니다. 현재 창에만 적용합니다.';}render();show();}
    mode.onchange=clear.onchange=configure;container.querySelector('button').onclick=apply;
    function end(){ended=true;state.clear({});container.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);}
    const storage=e=>{if(e.key==='kin-session-ended')end();};let channel;
    root.addEventListener('storage',storage);root.addEventListener('pagehide',()=>{end();channel?.close();root.removeEventListener('storage',storage);});
    try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
    show();return {read:current=>live()?state.read(current):{criteria:current,empty:true,pending:false},apply,
      change(){if(live())state.change(snapshot());show();},clear(){if(live())state.clear(snapshot());show();},show};
  }
  const api={normalize,create,mount};if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorklistSearch=api;
})(globalThis);
