/* A single optional initial selection; never a policy for subsequent refreshes. */
(function(root) {
  'use strict';
  function normalize(value) {
    return value && typeof value==='object' && !Array.isArray(value)
      && Object.keys(value).sort().join()==='selectFirst,version' && value.version===1
      && typeof value.selectFirst==='boolean' ? {version:1,selectFirst:value.selectFirst} : null;
  }
  function once({enabled,current,select,rows,allowed}) {
    let touched=false,consumed=false;
    return {
      touch(){touched=true;},
      afterList(){
        if(consumed)return;consumed=true;
        if(!enabled||touched||!allowed()||current())return;
        const list=rows();if(Array.isArray(list)&&list[0]?.uid)select(list[0].uid);
      },
    };
  }
  function mount({host,owner,current,select,rows,allowed}) {
    const bound=owner(),key=bound&&'kin-worklist-startup:v1:'+bound;
    let state={version:1,selectFirst:false},ended=false,note='';
    try {
      const raw=key&&root.localStorage.getItem(key);
      if(raw){const saved=raw.length<=100&&normalize(JSON.parse(raw));if(saved)state=saved;else note='저장된 시작 설정을 확인할 수 없어 자동 선택을 껐습니다.';}
    } catch(_){note='시작 설정을 읽지 못해 자동 선택을 껐습니다.';}
    const section=document.createElement('section');section.innerHTML='<label><input id="worklist-select-first" type="checkbox"> Select First Result on Sign In</label><p>로그인 후 첫 목록에서 현재 검색·정렬의 첫 검사만 선택합니다. 영상 창은 직접 열며, 이미 선택하거나 입력한 경우에는 자동 선택하지 않습니다.</p><p id="worklist-startup-status" role="status"></p>';
    host.insertBefore(section,host.querySelector('.image-opening-actions'));
    const checkbox=section.querySelector('input'),status=section.querySelector('[role=status]');
    checkbox.checked=state.selectFirst;checkbox.disabled=!bound;status.textContent=note;
    const active=()=>!ended&&!!bound&&owner()===bound&&allowed();
    const initial=once({enabled:state.selectFirst,current,select,rows,allowed:active});
    for(const event of ['pointerdown','keydown','input'])document.addEventListener(event,()=>initial.touch(),{capture:true,once:true});
    checkbox.onchange=()=>{
      if(ended||!bound||owner()!==bound){checkbox.disabled=true;return;}
      state={version:1,selectFirst:checkbox.checked};
      try{root.localStorage.setItem(key,JSON.stringify(state));status.textContent='설정을 저장했습니다. 다음 로그인부터 적용합니다.';}
      catch(_){status.textContent='시작 설정을 저장하지 못했습니다. 다음 로그인에는 적용되지 않습니다.';}
    };
    host.querySelector('#image-opening-reset').addEventListener('click',()=>{if(!ended&&bound&&owner()===bound){checkbox.checked=false;checkbox.onchange();}});
    function end(){ended=true;checkbox.disabled=true;initial.touch();}
    let channel;try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
    root.addEventListener('storage',e=>{if(e.key==='kin-session-ended')end();});root.addEventListener('pagehide',()=>{end();channel?.close();});
    return {afterList:()=>initial.afterList()};
  }
  const api={normalize,once,mount};
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.KinWorklistStartup=api;
})(typeof window==='object'?window:null);
