/* Consume the server scope without deriving membership from worklist rows. */
(function(root) {
  'use strict';
  const sourceFields = new Set(['id','name','acc','sourceAcc','date','time','desc','modality','birth','sex','age',
    'institutionName','reqHosp','reqDate','reqDept','reqDoc','ptClass']);
  const copy = value => JSON.parse(JSON.stringify(value));
  function read(value, purpose = 'current') {
    const scope = value?.sources ? value : purpose === 'stored' ? value?.reportScope : value?.examScope;
    if (scope) {
      if (typeof scope.reportUid !== 'string' || !Array.isArray(scope.sources) || !scope.sources.length ||
          scope.sources.some(s => typeof s.studyUid !== 'string' || !['all','include','exclude'].includes(s.series?.mode) || !Array.isArray(s.series.uids)))
        throw new Error('검사 범위를 확인할 수 없습니다. 목록을 새로고침하세요.');
      return copy(scope);
    }
    // Ungrouped list rows omit examScope. They describe only their own source, never an inferred group.
    if (purpose === 'stored' || !value?.uid || value.group || value.origin === 'logical') return null;
    return {reportUid:value.uid,groupId:null,kind:'single',part:null,active:true,
      sources:[{studyUid:value.uid,series:{mode:'all',uids:[]}}],
      generation:JSON.stringify(['single',value.state?.draftEpoch ?? value.draftEpoch ?? null])};
  }
  const key = value => { const s=read(value);return s ? JSON.stringify([s.reportUid,s.groupId??null,s.part??null]) : null; };
  const stamp = value => { const s=read(value);return s ? JSON.stringify([key(s),s.generation??null]) : null; };
  const allows = (source, seriesUid) => source.series.mode === 'all' ||
    (source.series.mode === 'include' ? source.series.uids.includes(seriesUid) : !source.series.uids.includes(seriesUid));
  function metadata(row) {
    const scope=read(row);
    if (!scope) return [];
    const sent=Array.isArray(row?.sourceMetadata)?row.sourceMetadata:[];
    return scope.sources.map(source=>sent.find(s=>(s.uid??s.studyUid)===source.studyUid) ||
      (source.studyUid===row?.uid&&!scope.groupId?row:{uid:source.studyUid}));
  }
  function projections(row) {
    const rows=metadata(row);
    return (rows.length?rows:[row||{}]).map(source=>({...row,...Object.fromEntries([...sourceFields].filter(k=>Object.hasOwn(source,k)).map(k=>[k,source[k]]))}));
  }
  function values(row, field) {
    return (sourceFields.has(field) ? projections(row) : [row]).map(s=>Object.hasOwn(s||{},field)?s[field]:undefined);
  }
  function originals(rows) {
    if(!Array.isArray(rows))return rows;
    const out=[],grouped=new Set();
    for(const row of rows){
      if(!row?.examScope?.groupId){out.push(row);continue;}
      for(const source of metadata(row))if(!grouped.has(source.uid)){grouped.add(source.uid);out.push(source);}
    }
    return out;
  }
  async function fetchScope(api, uid, {purpose='current',version,signal,at}={}) {
    const query=new URLSearchParams({purpose});if(version!=null)query.set('version',String(version));
    const answer=await api('GET','/studies/'+encodeURIComponent(uid)+'/exam-scope?'+query,undefined,signal,at);
    const scope=read(answer?.scope||answer);
    if(!scope)throw new Error('검사 범위를 확인할 수 없습니다.');
    return scope;
  }
  async function dicom(scope, resource, request) {
    const out=[];
    for(const source of read(scope).sources) {
      const rows=await request('/dicom-web/studies/'+encodeURIComponent(source.studyUid)+'/'+resource,source);
      if(!Array.isArray(rows))throw new Error('원본 영상 목록을 확인할 수 없습니다.');
      for(const row of rows) if(allows(source,row?.['0020000E']?.Value?.[0])) out.push({sourceUid:source.studyUid,row});
    }
    return out;
  }
  function viewerInput(current, prior = null, version = null, priorVersion = null) {
    const scope=read(current),comparison=prior?read(prior):null;
    if(!scope || prior&&!comparison)throw new Error('검사 범위를 확인할 수 없습니다.');
    if([...scope.sources,...(comparison?.sources||[])].some(s=>s.studyUid.length>64||!/^\d+(?:\.\d+)+$/.test(s.studyUid)))throw new Error('원본 검사 UID를 확인할 수 없습니다.');
    return {reportUid:scope.reportUid,key:key(scope),generation:scope.generation,current:scope,prior:comparison,version,priorVersion,
      studyUids:[...new Set([...scope.sources,...(comparison?.sources||[])].map(s=>s.studyUid))]};
  }
  function viewerUrl(input, initialSeries = null) {
    // The viewer re-reads these exact scope references. A long Split series list must not overflow the URL.
    const reference=s=>s?{reportUid:s.reportUid,groupId:s.groupId??null,part:s.part??null,generation:s.generation}:null;
    const query=new URLSearchParams({StudyInstanceUIDs:input.studyUids.join(','),kinReportUid:input.reportUid,
      kinExamScopes:JSON.stringify({current:reference(input.current),prior:reference(input.prior),version:input.version,priorVersion:input.priorVersion??null})});
    if(input.current.kind==='merge')query.set('kinExam','merged');
    if(input.prior)query.set('hangingProtocolId','@ohif/hpCompare');
    if(initialSeries)query.set('initialSeriesInstanceUID',initialSeries);
    return '/ohif/viewer?'+query;
  }
  function changes(owner, receive) {
    if(typeof root.BroadcastChannel!=='function')return {send(){},close(){}};
    const channel=new root.BroadcastChannel('kin-exam-changes');
    channel.onmessage=event=>{
      const message=event.data;
      if(message?.owner && message.owner===owner() && Array.isArray(message.uids) && message.uids.every(u=>typeof u==='string'))receive(message.uids);
    };
    return {send(uids){const identity=owner();if(identity)channel.postMessage({owner:identity,uids:[...new Set(uids)]});},close(){channel.close();}};
  }
  function chooseOriginals(row,scope,{title='Download Originals',multiple=true,live=()=>true}={}) {
    return new Promise(resolve=>{
      const dialog=document.createElement('dialog'),heading=document.createElement('h3'),note=document.createElement('p');
      dialog.className='order-dialog';heading.textContent=title;
      note.textContent=scope.kind==='split'?'나눈 시리즈만이 아니라 원본 검사 전체를 내보냅니다. 원본 UID와 영상은 바뀌지 않습니다.':'내보낼 원본 검사를 고르세요. 원본 UID와 영상은 바뀌지 않습니다.';
      dialog.append(heading,note);const choices=[];
      for(const source of scope.sources){
        const original=metadata(row).find(s=>s.uid===source.studyUid),label=document.createElement('label'),input=document.createElement('input');
        input.type=multiple?'checkbox':'radio';input.name='exam-source';input.value=source.studyUid;input.checked=scope.sources.length===1;
        label.append(input,' '+[original?.acc,original?.desc,source.studyUid].filter(Boolean).join(' · '));dialog.append(label,document.createElement('br'));choices.push(input);
      }
      const go=document.createElement('button'),close=document.createElement('button');go.type=close.type='button';go.textContent='Continue';close.textContent='Cancel';
      const update=()=>{go.disabled=!choices.some(c=>c.checked);};dialog.onchange=update;update();
      let result=[];go.onclick=()=>{if(live())result=choices.filter(c=>c.checked).map(c=>c.value);dialog.close();};close.onclick=()=>dialog.close();
      dialog.addEventListener('close',()=>{dialog.remove();resolve(result);},{once:true});dialog.append(go,close);document.body.append(dialog);dialog.showModal();
    });
  }
  const api={read,key,stamp,allows,metadata,projections,values,originals,fetch:fetchScope,dicom,viewerInput,viewerUrl,chooseOriginals,changes};
  root.KinExamScope=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
