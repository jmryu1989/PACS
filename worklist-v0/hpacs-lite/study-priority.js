(function(root){
  'use strict';
  function create({owner,allowed,request,apply,changed,invalidate,notify}){
    const pending=new Map();let bound=owner(),ended=false;
    function update(){try{changed();}catch(e){console.error('Emergency status rendering failed',e);}}
    function sync(){if(owner()!==bound){pending.clear();bound=owner();}}
    function get(uid){sync();return ended?null:pending.get(uid);}
    function observed(uids){sync();for(const uid of uids)if(pending.get(uid)?.phase==='unknown')pending.delete(uid);}
    async function set(uid,desired){
      sync();if(ended||!bound){notify('로그인 계정을 확인한 뒤 다시 시도하세요.',true);return;}
      if(!allowed(uid)||!['E','N'].includes(desired)||pending.has(uid))return;
      const captured=bound,task={phase:'saving',desired};pending.set(uid,task);invalidate();update();
      const active=()=>!ended&&owner()===captured&&pending.get(uid)===task;
      try{
        const state=await request(uid,desired);
        if(!active())return;
        if(state?.em!==desired)throw Error('응급 상태 저장 응답을 확인하지 못했습니다.');
        invalidate();apply(uid,state.em);pending.delete(uid);update();notify('응급 상태를 저장했습니다.');
      }catch(e){
        if(!active())return;
        invalidate();task.phase='unknown';update();notify('응급 상태 저장 결과를 확인하지 못했습니다. Refresh Status로 확인한 뒤 다시 지정하세요. '+e.message,true);
      }
    }
    function end(){ended=true;pending.clear();update();}
    if(root){root.addEventListener('storage',e=>{if(e.key==='kin-session-ended')end();});let channel;
      try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
      root.addEventListener('pagehide',()=>{end();channel?.close();});}
    return {get,set,observed,active:()=>!ended&&!!owner()};
  }
  const api={create};if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.KinStudyPriority=api;
})(typeof window==='object'?window:null);
