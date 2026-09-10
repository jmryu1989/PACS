/* Audio follows explicit list changes, never inferred clinical priority. */
(function(root){
  'use strict';
  const defaults=()=>({version:2,newStudies:false,emergency:false,initialEmergency:false,volume:0.3});
  function normalize(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==(value.version===1?'emergency,newStudies,version,volume':'emergency,initialEmergency,newStudies,version,volume')||![1,2].includes(value.version)||typeof value.newStudies!=='boolean'||typeof value.emergency!=='boolean'||(value.version===2&&typeof value.initialEmergency!=='boolean')||![0.1,0.3,0.6].includes(value.volume))return null;
    return {...value,version:2,initialEmergency:value.version===1?false:value.initialEmergency};
  }
  function initialObserver(){
    let seen=false,done=false,pending=new Set();
    return {
      observe(rows,enabled){
        const urgent=new Set(rows.filter(r=>r.em==='E').map(r=>r.uid));
        if(!seen){seen=true;if(enabled&&!done)pending=urgent;}
        else pending=new Set([...pending].filter(uid=>urgent.has(uid)));
      },
      count:()=>pending.size,
      clear(){pending.clear();done=true;},
      consume(play){if(done||!pending.size)return false;if(!play())return false;pending.clear();done=true;return true;}
    };
  }
  function observer(){
    let previous=null;
    return {reset(){previous=null;},observe(rows){
      if(!Array.isArray(rows)||rows.length>20000)throw Error('목록 알림은 20,000개 이하에서 사용할 수 있습니다. 검사 목록은 그대로 유지됩니다.');
      const next=new Map();
      for(const row of rows){
        if(!row||typeof row.uid!=='string'||row.uid.length>64||!/^\d+(?:\.\d+)+$/.test(row.uid)||next.has(row.uid)||!['E','N',null,undefined,''].includes(row.em))throw Error('검사 목록의 알림 기준을 확인하지 못했습니다.');
        next.set(row.uid,row.em==='E');
      }
      let newStudies=0,emergency=0;
      if(previous)for(const [uid,urgent] of next){if(!previous.has(uid))newStudies++;if(urgent&&previous.get(uid)!==true)emergency++;}
      const baseline=previous===null;previous=next;return {baseline,newStudies,emergency};
    }};
  }
  function mount({button,owner,available,refresh=async()=>{}}){
    const bound=owner(),key=bound&&'kin-worklist-alerts:v1:'+bound,model=observer(),initial=initialObserver();
    let ended=false,settings=defaults(),audio=null,armed=false,busy=false,channel,storage,feedback='',last='Waiting for List',generation=0,observations=0;
    const tones=new Set(),live=()=>!ended&&!!bound&&owner()===bound&&available();
    try{storage=root.localStorage;const raw=key?storage.getItem(key):null;if(raw!==null){const value=raw.length<=256&&normalize(JSON.parse(raw));if(value)settings=value;else feedback='저장된 설정 오류 · 기본 Off';}}catch(_){feedback='저장소 사용 불가 · 이 창에서만 설정합니다.';}
    const initialEnabled=settings.initialEmergency;
    const dialog=document.createElement('dialog');dialog.id='worklist-alerts-dialog';dialog.setAttribute('aria-labelledby','worklist-alerts-title');
    dialog.style.cssText='width:540px;max-width:calc(100vw - 32px);max-height:85vh;overflow:auto;background:#101e32;color:#e1ecfc;border:1px solid #657c9f;border-radius:10px;padding:20px';
    dialog.innerHTML='<h2 id="worklist-alerts-title">Worklist Alerts</h2><p>이 계정의 현재 브라우저 설정입니다. 목록에 새로 나타난 검사 또는 사람이 지정한 EM=E 변화를 알립니다. Initial Emergency List는 다음 로그인 첫 목록의 기존 응급 검사도 한 번 알립니다. 소리 허용 전 해제되거나 목록에서 사라진 대상은 제외합니다.</p><p><label><input type="checkbox" id="alerts-new"> New to List</label></p><p><label><input type="checkbox" id="alerts-emergency"> Emergency Changes</label></p><p><label><input type="checkbox" id="alerts-initial"> Initial Emergency List</label></p><p><label for="alerts-volume">Volume</label> <select id="alerts-volume"><option value="0.1">Low</option><option value="0.3">Normal</option><option value="0.6">High</option></select></p><p>소리는 이 창에서 직접 허용해야 합니다. 수신 시각이나 임상적 우선순위를 추정하지 않습니다. 한 번의 목록 확인은 소리 한 번으로 묶습니다.</p><p id="alerts-audio-state" role="status"></p><p id="alerts-list-state"></p><p id="alerts-feedback" role="status"></p><button type="button" class="chip" id="alerts-enable">Enable Sound</button> <button type="button" class="chip" id="alerts-test">Test Sound</button> <button type="button" class="chip" id="alerts-done">Done</button>';
    document.body.append(dialog);
    const fresh=dialog.querySelector('#alerts-new'),urgent=dialog.querySelector('#alerts-emergency'),initialBox=dialog.querySelector('#alerts-initial'),volume=dialog.querySelector('#alerts-volume'),enable=dialog.querySelector('#alerts-enable'),test=dialog.querySelector('#alerts-test'),done=dialog.querySelector('#alerts-done');
    function render(){
      const active=live();button.disabled=!active;fresh.disabled=urgent.disabled=initialBox.disabled=volume.disabled=!active;
      enable.disabled=test.disabled=!active||busy;enable.textContent=armed?'Disable Sound':'Enable Sound';
      fresh.checked=settings.newStudies;urgent.checked=settings.emergency;initialBox.checked=settings.initialEmergency;volume.value=String(settings.volume);
      dialog.querySelector('#alerts-audio-state').textContent=busy?'Connecting Audio':armed&&audio?.state==='running'?'Sound Ready':'Sound Off';
      dialog.querySelector('#alerts-list-state').textContent=last+(initial.count()?' · Initial Emergency '+initial.count()+' Pending':'');dialog.querySelector('#alerts-feedback').textContent=feedback;
    }
    function stopTones(){for(const oscillator of tones){try{oscillator.stop();}catch(_){}try{oscillator.disconnect();}catch(_){}}tones.clear();}
    function tone(emergency){
      if(!live()||!armed||audio?.state!=='running'){feedback='목록 변화가 있습니다. 소리 알림은 Enable Sound로 직접 허용하세요.';return false;}
      let gain,oscillator;
      try{
        const now=audio.currentTime;gain=audio.createGain();oscillator=audio.createOscillator();
        gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(settings.volume,now+0.015);gain.gain.exponentialRampToValueAtTime(0.001,now+0.22);
        oscillator.type='sine';oscillator.frequency.setValueAtTime(emergency?1046.5:783.99,now);oscillator.connect(gain);gain.connect(audio.destination);
        tones.add(oscillator);oscillator.onended=()=>{tones.delete(oscillator);oscillator.disconnect();gain.disconnect();};oscillator.start(now);oscillator.stop(now+0.24);return true;
      }catch(_){
        armed=false;tones.delete(oscillator);try{oscillator?.stop();}catch(_){}try{oscillator?.disconnect();gain?.disconnect();}catch(_){}
        feedback='소리 재생에 실패했습니다. 출력 장치를 확인한 뒤 Test Sound로 다시 시도하세요.';return false;
      }
    }
    function initialSound(){
      if(document.hidden||!settings.initialEmergency||!armed)return false;
      const count=initial.count(),played=initial.consume(()=>tone(true));
      if(played)feedback='첫 목록에 있던 응급 검사 '+count+'건의 묶음 알림을 재생했습니다.';
      return played;
    }
    async function sound(testing){
      if(!live()||busy)return;const ticket=++generation;busy=true;feedback='';render();
      try{
        if(!testing&&armed){armed=false;stopTones();await audio.suspend();}
        else{
          const Audio=root.AudioContext||root.webkitAudioContext;if(!Audio)throw Error('이 브라우저는 소리 알림을 지원하지 않습니다.');
          if(!audio){audio=new Audio();audio.onstatechange=()=>{if(audio?.state!=='running')armed=false;render();};}
          await audio.resume();
          if(!live()||ticket!==generation)return;
          if(audio.state!=='running')throw Error('브라우저에서 소리를 허용한 뒤 다시 시도하세요.');
          armed=true;if(testing){if(tone(false))feedback='시험음 재생을 요청했습니다. 실제 스피커와 음량을 확인하세요.';}else if(initial.count()&&settings.initialEmergency){const before=observations;await refresh();if(live()&&ticket===generation&&observations===before)feedback='최신 목록을 확인하지 못해 첫 목록 알림을 보류했습니다. Refresh 후 다시 확인하세요.';}
        }
      }catch(e){if(live()&&ticket===generation){armed=false;feedback=e.message==='이 브라우저는 소리 알림을 지원하지 않습니다.'?e.message:'소리를 시작하지 못했습니다. 브라우저 권한·출력 장치를 확인하고 다시 시도하세요.';}}
      finally{if(ticket===generation){busy=false;render();}}
    }
    fresh.onchange=urgent.onchange=initialBox.onchange=volume.onchange=()=>{
      if(!live()){render();return;}
      settings={version:2,newStudies:fresh.checked,emergency:urgent.checked,initialEmergency:initialBox.checked,volume:Number(volume.value)};
      if(!settings.initialEmergency)initial.clear();
      try{storage.setItem(key,JSON.stringify(settings));feedback='설정 저장됨 · 이 브라우저';}catch(_){feedback='설정을 저장하지 못해 이 창에서만 적용됩니다.';}render();
    };
    enable.onclick=()=>sound(false);test.onclick=()=>sound(true);done.onclick=()=>dialog.close();
    button.onclick=()=>{render();if(live()){dialog.showModal();fresh.focus();}};
    dialog.addEventListener('close',()=>{if(live())button.focus();});
    function end(){if(ended)return;ended=true;generation++;armed=false;busy=false;model.reset();initial.clear();stopTones();if(audio){audio.onstatechange=null;audio.close().catch(()=>{});}channel?.close();if(dialog.open)dialog.close();render();}
    root.addEventListener('storage',e=>{if(e.key==='kin-session-ended')end();});root.addEventListener('pagehide',end);
    try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
    render();
    return {observe(rows){
      if(!live())return;
      try{
        const result=model.observe(rows);observations++;initial.observe(rows,initialEnabled&&settings.initialEmergency);last=result.baseline?'List Baseline Ready':'New to List '+result.newStudies+' · Emergency Changes '+result.emergency;
        const initialPlayed=initialSound();
        if(!initialPlayed&&!result.baseline&&!document.hidden&&(settings.newStudies&&result.newStudies>0||settings.emergency&&result.emergency>0)){
          tone(settings.emergency&&result.emergency>0);
        }
      }catch(e){model.reset();initial.clear();last='Alerts Unverified';feedback=e.message;}
      render();
    },end};
  }
  const api={defaults,normalize,observer,initialObserver,mount};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorklistAlerts=api;
})(globalThis);
