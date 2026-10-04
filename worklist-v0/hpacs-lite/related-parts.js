(function(root) {
  'use strict';
  const uidPattern=/^[0-9]+(?:\.[0-9]+)+$/;
  function values(ds,tag) { const v=ds?.[tag]?.Value; return v===undefined?[]:v; }
  function parse(rows,uid) {
    if(!Array.isArray(rows)||!rows.length||rows.length>500)throw Error('시리즈 목록 범위를 확인하지 못했습니다.');
    const seen=new Set(),parts=new Set();
    for(const ds of rows) {
      const study=values(ds,'0020000D'),series=values(ds,'0020000E'),body=values(ds,'00180015');
      if(!Array.isArray(study)||study.length!==1||study[0]!==uid||!Array.isArray(series)||series.length!==1||
        typeof series[0]!=='string'||series[0].length>64||!uidPattern.test(series[0])||seen.has(series[0])||
        !Array.isArray(body)||body.some(v=>v!==null&&(typeof v!=='string'||v.length>64)))throw Error('시리즈 소속 또는 부위 값을 확인하지 못했습니다.');
      seen.add(series[0]);
      const tokens=body.filter(v=>v!==null).flatMap(v=>v.split('\\')).map(v=>v.trim()).filter(Boolean);
      if(!tokens.length)parts.add('');else tokens.forEach(v=>parts.add(v));
    }
    return [...parts].sort();
  }
  function create({owner,changed}) {
    const work=globalThis.KinWorkContext,transport=globalThis.KinSessionTransport.page();
    let resume=null;
    let generation=0,scope='',bound=null,busy=false,ended=false,note='';
    const entries=new Map(),controllers=new Set();
    function cancel(){++generation;busy=false;controllers.forEach(c=>c.abort());controllers.clear();}
    function reset(next){cancel();scope=next;bound=owner();entries.clear();note='';}
    function current(){return !ended&&!!bound&&owner()===bound;}
    function get(uid){return current()?entries.get(uid):undefined;}
    async function read(url,signal,at){
      const response=await transport.request(url,{context:at,read:'response',signal,credentials:'same-origin',cache:'no-store',headers:{Accept:'application/dicom+json'}});
      if(!response.ok){await response.body?.cancel();throw Object.assign(Error('조회 실패 (HTTP '+response.status+').'),{status:response.status});}
      const reader=response.body.getReader(),chunks=[];let size=0;
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();throw Error('응답이 2 MiB 상한을 초과했습니다.');}chunks.push(value);}
      const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    }
    async function load(uids){
      if(work.state()!=='active')return;const at=work.capture('document');resume=[...uids];
      cancel();if(!current()){note='로그인 계정을 확인할 수 없어 조회를 중단했습니다.';changed();return;}
      const mine=generation,queue=[...new Set(uids)];busy=true;entries.clear();note='';changed();
      const active=()=>work.admits(at)&&mine===generation&&current();
      async function worker(){
        while(active()&&queue.length){
          const uid=queue.shift(),controller=new AbortController();controllers.add(controller);
          const timeout=setTimeout(()=>controller.abort(),15000);
          try{
            if(typeof uid!=='string'||uid.length>64||!uidPattern.test(uid))throw Error('검사 UID가 올바르지 않습니다.');
            const rows=await read('/dicom-web/studies/'+encodeURIComponent(uid)+'/series?includefield=0020000D,0020000E,00180015&limit=501',controller.signal,at);
            const parts=parse(rows,uid);work.commit(at,()=>{if(active())entries.set(uid,{parts});});
          }catch(e){work.commit(at,()=>{if(active())entries.set(uid,{error:e.name==='AbortError'?'조회 시간이 초과되었습니다.':e.message});});}
          finally{clearTimeout(timeout);controllers.delete(controller);work.commit(at,()=>{if(active())changed();});}
        }
      }
      await Promise.all([worker(),worker(),worker()]);work.commit(at,()=>{if(active()){busy=false;resume=null;changed();}});
    }
    function end(){ended=true;reset('');changed();}
    work.onInvalidate(event=>{
      if(event.reason==='lifecycle'&&!['active','preparing'].includes(event.state))end();
      if(event.reason==='prepare')cancel();
      if(event.reason==='cancel'&&resume){const uids=resume;resume=null;load(uids);}
    });
    if(root)root.addEventListener('pagehide',end);
    return {get,load,cancel:()=>{cancel();changed();},reset,
      sync(next){if(next!==scope||owner()!==bound)reset(next);},busy:()=>busy&&current(),note:()=>note};
  }
  const api={parse,create};if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.KinRelatedParts=api;
})(typeof window==='object'?window:null);
