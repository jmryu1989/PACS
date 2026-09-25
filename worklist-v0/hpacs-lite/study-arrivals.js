/* Pure comparison of completed, permission-filtered worklist snapshots. */
(function(root){
  'use strict';
  const validUid=value=>typeof value==='string'&&value.length<=64&&/^\d+(?:\.\d+)+$/.test(value);
  // null is the server's "unknown" (tag absent or non-integer in QIDO). It is neither 0 nor an
  // error: a snapshot that carries it is still comparable on the axes that are known.
  const validCount=value=>value===null||(Number.isSafeInteger(value)&&value>=0);
  // Growth needs two known values. unknown->known is a first observation, not an arrival, and
  // known->unknown is a lost observation; neither may raise a "new images" notice.
  const added=(before,after)=>before!==null&&after!==null&&after>before?after-before:0;
  const invalid=(name,reason,index)=>({error:name+':'+reason+(index===undefined?'':':'+index)});

  function snapshot(rows,name){
    if(!Array.isArray(rows))return invalid(name,'not-array');
    const values=new Map();
    for(let index=0;index<rows.length;index++){
      const row=rows[index];
      if(!row||typeof row!=='object'||Array.isArray(row)||!validUid(row.uid))
        return invalid(name,'invalid-uid',index);
      if(values.has(row.uid))return invalid(name,'duplicate-uid',index);
      if(!validCount(row.count)||!validCount(row.series))
        return invalid(name,'invalid-count',index);
      values.set(row.uid,{count:row.count,series:row.series});
    }
    return {values};
  }

  function diff(previous,next){
    const before=snapshot(previous,'previous');if(before.error)return {ok:false,changes:[],error:before.error};
    const after=snapshot(next,'next');if(after.error)return {ok:false,changes:[],error:after.error};
    const changes=[];
    for(const [uid,current] of after.values){
      const old=before.values.get(uid);if(!old)continue;
      const addedInstances=added(old.count,current.count),addedSeries=added(old.series,current.series);
      if(!addedInstances&&!addedSeries)continue;
      changes.push({uid,previousCount:old.count,count:current.count,previousSeries:old.series,series:current.series,
        addedInstances,addedSeries});
    }
    return {ok:true,changes};
  }

  /*
   * S4-U1b: what KIN observed, kept apart from institution assignment (axis A) and from what a
   * Gateway reported (axis C). Everything below is session-local and in memory only: the server
   * stores no observation history, so a page load, another account or a known<->unknown count
   * starts the comparison over instead of inventing a baseline.
   */
  const validTime=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
  const PHASES=['pending','announcing','sending','retry','failed','complete'];
  // Only the receipt/observation labels are held to this; ordinary UI text is not scanned.
  const BANNED=/완료|수신 완료|안정|다 옴|received|complete|stable/i;
  // IF-W09: three different situations, three phrases. None of them may stand in for another.
  const PHRASES=Object.freeze({orderWithoutImages:'영상 없는 주문',observationUnavailable:'관측 불가',viewerLoadFailed:'뷰어 로딩 실패'});
  const pad=value=>String(value).padStart(2,'0');
  const localTime=iso=>{const d=new Date(iso);
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());};

  function observationStart(){return {owner:null,observedAt:null,available:null,rows:new Map(),notObserved:null};}

  // null/absent means the server could not decide absence (failed or partly unknown enumeration).
  // It stays unknown; turning it into [] would claim every row was checked.
  // S4-F01V: the own Gateway receipt of an item rides along only when the server sent the key. It is judged later
  // by the same label and retry rules as the receipt of a row, so an unreadable one never fails the observation.
  function readNotObserved(value,observed){
    if(value===null||value===undefined)return {rows:null};
    if(!Array.isArray(value))return {error:'notObserved:not-array'};
    const seen=new Set(),rows=[];
    for(let index=0;index<value.length;index++){
      const row=value[index];
      if(!row||typeof row!=='object'||Array.isArray(row)||!validUid(row.uid)||seen.has(row.uid)||observed.has(row.uid)
        ||typeof row.origin!=='string'||!row.origin||row.origin.length>32||!validTime(row.createdAt))
        return {error:'notObserved:invalid:'+index};
      seen.add(row.uid);rows.push({uid:row.uid,origin:row.origin,createdAt:row.createdAt,...(row.gatewayReceipt===undefined?{}:{gatewayReceipt:row.gatewayReceipt})});
    }
    return {rows};
  }

  // Two observations of one UID are comparable only when both instance counts are known and the
  // series count is known in both or in neither; any known<->unknown step is a reset, not a change.
  function compare(previous,current){
    if(!previous||previous.count===null||current.count===null||(previous.series===null)!==(current.series===null))return null;
    const series=current.series!==null;
    if(current.count<previous.count||series&&current.series<previous.series)return 'decreased';
    if(current.count>previous.count||series&&current.series>previous.series)return 'increased';
    return 'no_observed_change';
  }

  function observationSucceeded(model,result){
    const base=model&&model.rows instanceof Map?model:observationStart();
    const owner=Array.isArray(result?.owner)?JSON.stringify(result.owner):null,observation=result?.observation;
    if(!owner||!observation||typeof observation!=='object'||!validTime(observation.observedAt))return {ok:false,error:'observation:invalid'};
    const current=snapshot(result.studies,'next');if(current.error)return {ok:false,error:current.error};
    const absent=readNotObserved(observation.notObserved,current.values);if(absent.error)return {ok:false,error:absent.error};
    const at=observation.observedAt;
    // Another account, or a server clock that went backwards, cannot continue this session's comparison.
    const prior=base.owner===owner&&(base.observedAt===null||Date.parse(at)>=Date.parse(base.observedAt))?base.rows:new Map();
    const rows=new Map();
    for(const [uid,value] of current.values){
      // Only the immediately preceding successful observation counts; a UID that left the list and came
      // back has no predecessor here, so leaving a page, filter or scope is never a decrease.
      const previous=prior.get(uid),kind=compare(previous,value);
      const row={count:value.count,series:value.series,observedAt:at,change:null,valueSince:value.count===null?null:at,changedAt:null,needsCheck:false,decreasedAt:null};
      if(kind==='no_observed_change')Object.assign(row,{change:{kind,since:previous.valueSince},valueSince:previous.valueSince,
        changedAt:previous.changedAt,needsCheck:previous.needsCheck,decreasedAt:previous.decreasedAt});
      else if(kind)Object.assign(row,{change:{kind,since:previous.observedAt},changedAt:at,
        needsCheck:kind==='decreased'||previous.needsCheck,decreasedAt:kind==='decreased'?at:previous.decreasedAt});
      rows.set(uid,row);
    }
    return {ok:true,model:{owner,observedAt:at,available:true,rows,notObserved:absent.rows}};
  }

  // A failed observation empties nothing: rows, their observedAt and the last absence list stay as
  // they were, and only availability changes. A cold start keeps observedAt null (no snapshot).
  function observationFailed(model){
    const base=model&&model.rows instanceof Map?model:observationStart();
    return {...base,available:false};
  }

  function studyObservation(model,uid){
    const m=model&&model.rows instanceof Map?model:observationStart(),row=m.rows.get(uid)||null;
    const absent=m.notObserved?m.notObserved.find(item=>item.uid===uid)||null:null;
    if(m.available===false)return {state:'observation_unavailable',
      last:row?{count:row.count,series:row.series,observedAt:row.observedAt}:absent?{notObserved:true,observedAt:m.observedAt}:null,
      changedAt:row?row.changedAt:null,needsCheck:!!row&&row.needsCheck,decreasedAt:row?row.decreasedAt:null};
    if(m.available!==true)return {state:'not_attempted'};
    if(row)return {state:'observed',count:row.count,series:row.series,observedAt:row.observedAt,change:row.change,
      changedAt:row.changedAt,needsCheck:row.needsCheck,decreasedAt:row.decreasedAt};
    if(absent)return {state:'not_observed',observedAt:m.observedAt,origin:absent.origin,createdAt:absent.createdAt};
    return {state:'outside_list'};
  }

  function kinHeld(count,at,format){return (count===null?'KIN 보유 개수 모름':'KIN 보유 '+count+'건')+'('+format(at)+')';}

  function assignmentLabel(value){
    if(value==='assigned')return {key:'assigned',text:'Institution Assigned',title:'검사가 기관에 연결되어 있습니다. 영상 수신 상태가 아닙니다.'};
    if(value==='unassigned')return {key:'unassigned',text:'Institution Unmatched',
      title:'DICOM 기관명이 등록된 별칭과 맞지 않아 기관이 정해지지 않았습니다. 영상 수신 상태가 아닙니다.'};
    throw new TypeError('assignment');
  }

  function observationLabel(b,format){
    if(b.state==='observed')return {key:'observed',text:kinHeld(b.count,b.observedAt,format),
      title:'성공한 KIN 관측 시각의 보유 개수입니다.'+(b.count===null?' 개수 태그가 없거나 정수가 아니어서 알 수 없습니다.':'')};
    if(b.state==='not_observed')return {key:'not_observed',text:'Not Observed('+format(b.observedAt)+')',
      title:'성공한 KIN 관측에 이 검사의 영상 행이 없습니다. 예고만 된 검사·아직 저장 전·제거된 검사를 구분하지 않습니다.'};
    if(b.state==='observation_unavailable')return {key:'observation_unavailable',
      text:PHRASES.observationUnavailable+(!b.last?'':b.last.notObserved?' · 마지막 관측('+format(b.last.observedAt)+') Not Observed':' · 마지막 '+kinHeld(b.last.count,b.last.observedAt,format)),
      title:'KIN 관측 요청이 실패했습니다. 마지막으로 성공한 관측값과 그 시각을 그대로 보여 줍니다.'};
    if(b.state==='outside_list')return {key:'outside_list',text:'Outside Observed List',title:'이번 관측 목록에 없는 검사입니다. 삭제나 감소로 보지 않습니다.'};
    if(b.state==='not_attempted')return {key:'not_attempted',text:'',title:''};
    throw new TypeError('observation');
  }

  function changeLabel(b,format){
    if(b.state!=='observed'||!b.change)return null;
    const since=format(b.change.since),context='이 세션에서 관측한 변화';
    if(b.change.kind==='increased')return {key:'increased',text:context+': 증가('+since+' 이후)'};
    if(b.change.kind==='decreased')return {key:'decreased',text:context+': 감소('+since+' 이후) · Needs Check'};
    if(b.change.kind==='no_observed_change')return {key:'no_observed_change',text:context+' 없음('+since+' 이후)'};
    throw new TypeError('change');
  }

  const count=value=>Number.isSafeInteger(value)&&value>=0;
  function gatewayLabel(receipt,b,format){
    if(receipt===null||receipt===undefined)return {label:{key:'none',text:'No Gateway Report',
      title:'Gateway 전송 보고가 없습니다. 장비 직송·이전 버전 agent·미설치에서도 정상이며 실패나 오프라인을 뜻하지 않습니다.'},reasons:[]};
    const M=receipt?.successCount,N=receipt?.localCount;
    if(typeof receipt!=='object'||!PHASES.includes(receipt.phase)||!count(M)||!count(N)||M>N||!validTime(receipt.serverReceivedAt))
      return {label:{key:'reported_unreadable',text:'Gateway 보고 형식을 확인할 수 없습니다',title:'보고 내용을 해석하지 못해 비교하지 않았습니다.'},reasons:['receipt_unreadable']};
    const reasons=[];
    // K<M needs a known K from an available observation; null is never read as zero.
    const K=b.state==='observed'?b.count:null,comparable=K!==null;
    if(comparable&&K<M)reasons.push('kin_below_reported');
    if(b.state==='not_observed'&&M>=1)reasons.push('not_observed_with_reported_transfer');
    if(b.changedAt&&Date.parse(receipt.serverReceivedAt)<Date.parse(b.changedAt))reasons.push('receipt_older_than_change');
    return {label:{key:'reported',text:'Gateway 보고('+format(receipt.serverReceivedAt)+'): 병원 보유 '+N+'건 중 '+M+'건 전송',
      title:'Gateway가 보고한 전송 수입니다. 검사 종료나 영상 수신 여부를 뜻하지 않습니다.'+(comparable?'':' KIN 보유 개수를 알 수 없어 비교하지 않았습니다.')},reasons};
  }

  /*
   * S4-U4 Now Retry. Only a readable `retry` receipt offers the request, keyed by the exact receipt it was
   * drawn from (epoch|agentSeq), so an answer can never be written over a newer state. `failed` is F-01:
   * the same bytes cannot succeed, so it gets the sentence and never a control. The Gateway label above is
   * not touched by any of this. A request is stored, not run: nothing here says the retry happened.
   */
  const RETRY_EPOCH=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const RETRY_TEXT=Object.freeze({
    unsupported:'같은 바이트로는 성공할 수 없습니다 — 지원 범위 밖(F-01)',
    unsupportedTitle:'Gateway가 보낼 수 없는 영상(단일 인스턴스가 전송 상한을 넘음)이라 다시 시도해도 같은 결과입니다. 요청할 수 없습니다.',
    button:'Now Retry',
    buttonTitle:'KIN에 재시도 요청을 남깁니다. Gateway가 30초 주기로 가져가 대기 중인 재시도를 앞당기며, 진행 중인 전송이 있으면 그 뒤에 반영됩니다.',
    requestedTitle:'요청이 KIN에 저장됐다는 뜻이며 재시도가 실행됐다는 뜻은 아닙니다. Gateway는 30초 주기로 요청을 가져가고, 진행 중인 전송이 있으면 그 전송이 끝난 뒤에 가져갑니다.',
    notFound:'검사를 찾을 수 없어 요청하지 않았습니다.',
    notRetry:'지금은 재시도 대기 상태가 아니어서 요청하지 않았습니다. 목록이 갱신되면 다시 확인하세요.',
    busy:'요청이 겹쳐 처리하지 못했습니다. 잠시 후 다시 시도하세요.',
    failed:'재시도 요청을 보내지 못했습니다. 다시 시도하세요.'});
  const readableReceipt=receipt=>!!receipt&&typeof receipt==='object'&&PHASES.includes(receipt.phase)
    &&count(receipt.successCount)&&count(receipt.localCount)&&receipt.successCount<=receipt.localCount&&validTime(receipt.serverReceivedAt);

  function gatewayRetryAction(receipt){
    if(!readableReceipt(receipt))return null;
    if(receipt.phase==='failed')return {kind:'unsupported_f01',text:RETRY_TEXT.unsupported,title:RETRY_TEXT.unsupportedTitle};
    if(receipt.phase!=='retry'||!count(receipt.agentSeq)||typeof receipt.epoch!=='string'||!RETRY_EPOCH.test(receipt.epoch))return null;
    return {kind:'now_retry',key:receipt.epoch+'|'+receipt.agentSeq,text:RETRY_TEXT.button,title:RETRY_TEXT.buttonTitle};
  }

  // The one POST's answer as fixed text. Server wording is never echoed; only these sentences are shown.
  function gatewayRetryAnswer(uid,answer,error,format=localTime){
    if(!error&&answer&&typeof answer==='object'&&answer.studyUid===uid&&(answer.result==='requested'||answer.result==='already_requested')
      &&validTime(answer.requestedAt))
      return {requested:true,text:'Retry Requested ('+format(answer.requestedAt)+')',title:RETRY_TEXT.requestedTitle};
    const status=error?.status,code=error?.code;
    const text=status===404?RETRY_TEXT.notFound:status===409&&code==='GATEWAY_RETRY_UNSUPPORTED_F01'?RETRY_TEXT.unsupported
      :status===409&&code==='GATEWAY_RETRY_NOT_RETRY'?RETRY_TEXT.notRetry:status===503?RETRY_TEXT.busy:RETRY_TEXT.failed;
    return {requested:false,text,title:''};
  }

  // One study's three axes. The axes never feed each other: a Gateway report of M-of-N, whatever
  // its phase, cannot change the observation label, and assignment says nothing about receipt.
  function receiptLabels({assignment,observation,gateway},format=localTime){
    const b=observation;
    if(!b||typeof b!=='object')throw new TypeError('observation');
    const a=assignmentLabel(assignment),o=observationLabel(b,format),change=changeLabel(b,format),g=gatewayLabel(gateway,b,format);
    const reasons=[...(b.needsCheck?['decreased_in_session']:[]),...g.reasons];
    return {assignment:a,observation:o,change,gateway:g.label,needsCheck:reasons.length>0,reasons,retry:gatewayRetryAction(gateway)};
  }

  // The list-level line. `notObserved` is the last successful answer (or null when absence was never
  // decided); while unavailable it is shown as that observation's answer, never as a new one.
  function observationSummary(model,format=localTime){
    const m=model&&model.rows instanceof Map?model:observationStart();
    let needsCheck=0;for(const row of m.rows.values())if(row.needsCheck)needsCheck++;
    const tail=needsCheck?' · Needs Check '+needsCheck:'';
    if(m.available===false)return {key:'observation_unavailable',
      text:PHRASES.observationUnavailable+(m.observedAt?' · 마지막 관측 '+format(m.observedAt)+' 유지':'')+tail,
      title:m.observedAt?'KIN 관측 요청이 실패했습니다. 목록·개수·관측 시각은 마지막으로 성공한 관측값입니다.':'아직 성공한 KIN 관측이 없습니다. 개수를 표시하지 않습니다.',
      notObserved:m.notObserved,needsCheck};
    if(m.available!==true)return {key:'not_attempted',text:'',title:'',notObserved:null,needsCheck};
    const absent=m.notObserved===null?' · Not Observed Unknown':m.notObserved.length?' · Not Observed '+m.notObserved.length:'';
    return {key:'observed',text:'Observed '+format(m.observedAt)+absent+tail,
      title:'KIN이 이 시각에 성공한 관측으로 확인한 목록입니다.'+(m.notObserved===null?' 이번 관측으로는 부재를 판정하지 못했습니다.':''),
      notObserved:m.notObserved,needsCheck};
  }

  function phrase(kind){if(!Object.prototype.hasOwnProperty.call(PHRASES,kind))throw new TypeError('phrase');return PHRASES[kind];}

  const api={diff,observationStart,observationSucceeded,observationFailed,studyObservation,receiptLabels,observationSummary,phrase,formatTime:localTime,
    gatewayRetryAction,gatewayRetryAnswer,RETRY_TEXT,PHASES:Object.freeze([...PHASES]),BANNED,PHRASES};root.KinStudyArrivals=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis==='object'?globalThis:this);
