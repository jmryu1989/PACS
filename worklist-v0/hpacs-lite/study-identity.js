/* S4-U5 study identity display model. Engineering only; pure (no storage, network or DOM). */
(function(root){
  'use strict';
  /*
   * The server compares; this module only reads its answer. Each list row carries the tags the server read for that
   * row and, for an own-institution row linked both ways to an own-institution order, one relation per field. The
   * tags are taken from the response row, never from the worklist row object, which carries the display overlay.
   * Nothing here decides who a patient is: Same Value means two recorded strings are equal under a stated rule.
   */
  const SOURCE='engineering_only',MARKER='Engineering Only',OBSERVATION_UNAVAILABLE='관측 불가';
  const FIELDS=['accession','patientId','patientName','birth','sex'];
  const PATIENT_FIELDS=['patientId','patientName','birth','sex'];
  const IDENTITY_KEYS=['accession','birth','oid','patientId','patientName','sex','source'];
  const RELATIONS=['match','mismatch','not_comparable'];
  const validUid=value=>typeof value==='string'&&value.length<=64&&/^\d+(?:\.\d+)+$/.test(value);
  const validOid=value=>typeof value==='string'&&value.length>0&&value.length<=64&&!/[\u0000-\u001f\u007f]/.test(value);
  const validTime=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
  const exactKeys=(row,keys)=>{const own=Object.keys(row).sort();return own.length===keys.length&&own.every((key,index)=>key===keys[index]);};
  const textOf=value=>typeof value==='string'?value:'';
  const pad=value=>String(value).padStart(2,'0');
  const localTime=iso=>{const d=new Date(iso);
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());};

  const NAME_SCOPE='Patient Name은 Alphabetic 그룹만 읽고 표시하고 비교합니다. Ideographic·Phonetic 표기는 표시하지도 비교하지도 않습니다.';
  const RELATION_TEXT=Object.freeze({match:'Same Value',mismatch:'Different Value',not_comparable:'Not Comparable',not_compared:'Not Compared'});
  const RELATION_TITLE=Object.freeze({
    match:'규칙으로 비교한 두 기록 값이 같습니다. 같은 환자임을 확인한 것은 아닙니다.',
    mismatch:'DICOM 값과 오더 값이 규칙상 다릅니다. 표기 차이인지 다른 검사·환자인지는 이 화면이 판정하지 않습니다.',
    not_comparable:'한쪽 값이 없거나 읽을 수 없는 형식이라 비교하지 않았습니다. 같음도 다름도 아닙니다.',
    not_compared:'Study Description은 비교하지 않고 표시만 합니다.'});
  // (0010,0010): the server reads only the Alphabetic group of the PN, so its absence is said as exactly that (M-3).
  const TAGS=Object.freeze([
    Object.freeze({key:'uid',tag:'(0020,000D)',label:'Study Instance UID',field:null,absent:'Absent',title:''}),
    Object.freeze({key:'acc',tag:'(0008,0050)',label:'Accession Number',field:'accession',absent:'Absent',title:''}),
    Object.freeze({key:'id',tag:'(0010,0020)',label:'Patient ID',field:'patientId',absent:'Absent',title:''}),
    Object.freeze({key:'name',tag:'(0010,0010)',label:'Patient Name · Alphabetic',field:'patientName',absent:'Alphabetic Absent',
      title:NAME_SCOPE+' ^는 공백으로 보입니다.'}),
    Object.freeze({key:'birth',tag:'(0010,0030)',label:'Patient Birth Date',field:'birth',absent:'Absent',title:''}),
    Object.freeze({key:'sex',tag:'(0010,0040)',label:'Patient Sex',field:'sex',absent:'Absent',title:''}),
    Object.freeze({key:'desc',tag:'(0008,1030)',label:'Study Description',field:'not_compared',absent:'Absent',title:''})]);
  const ORDER_TITLE=Object.freeze({
    linked:'KIN에 저장된 오더와 서버가 읽은 검사 태그를 규칙으로 비교한 엔지니어링 확인 결과입니다. 권위 있는 병원 오더 출처가 연결되지 않았으므로 대사 결과나 환자 판정으로 쓰지 마세요.',
    no_linked_order:'이 검사에 연결된 오더가 없어 비교하지 않았습니다.',
    tele:'원격판독으로 받은 검사의 오더는 보유 기관의 일입니다.',
    unknown:'이번 관측으로 연결 상태를 판정하지 못했습니다.'});
  const SUMMARY_TITLE='KIN 서버가 성공한 관측에서 읽은 검사 수준 DICOM 태그입니다. 오더와의 비교는 엔지니어링 확인 전용입니다.';
  const PATIENT_MISMATCH_TITLE=' Patient Mismatch: 연결된 오더와 Patient ID·Patient Name(Alphabetic)·Birth Date·Sex 중 하나 이상이 규칙상 다릅니다. 표기 차이일 수도 있으며 이 화면은 사람을 판정하지 않습니다.';
  const ACCESSION_MISMATCH_TITLE=' Accession Mismatch: 연결된 오더의 accession과 검사의 Accession Number가 규칙상 다릅니다.';
  const UNAVAILABLE_TITLE=' KIN 관측 요청이 실패했습니다.';
  const GUIDANCE_W='오더 연결이 잘못됐다면 Unmatch 후 올바른 오더로 Match하세요. Modify Exam은 화면 표시값만 바꾸며 이 비교 결과를 바꾸지 않습니다. 원본 DICOM은 이 제품에서 수정하지 않습니다.';

  /* The one legitimate next step, only while a Different Value is shown or after a refused correction. At RS other
     than W the server refuses Match, Unmatch and Modify Exam; this names no report action. */
  function guidance(rs,show,tele){
    if(tele||!show)return '';
    const current=typeof rs==='string'&&rs?rs:'W';
    if(current==='W')return GUIDANCE_W;
    return '판독이 시작된 검사(현재 RS: '+current+')는 서버 규칙상 Match·Unmatch·Modify Exam으로 바꿀 수 없습니다. 판독 기록은 그대로 보존됩니다. 불일치가 의심되면 담당 판독의·관리자와 확인하세요.';
  }

  function start(){return {owner:null,observedAt:null,available:null,rows:null,refused:null};}
  const usable=model=>model&&typeof model==='object'&&'available' in model&&'rows' in model?model:start();

  // null/absent: the server did not relate this row. Any other shape is not an answer this build can show.
  function read(value){
    if(value===null||value===undefined)return {state:'none'};
    if(!value||typeof value!=='object'||Array.isArray(value)||!exactKeys(value,IDENTITY_KEYS)||value.source!==SOURCE||!validOid(value.oid))
      return {state:'unreadable'};
    const identity={oid:value.oid};
    for(const field of FIELDS){if(!RELATIONS.includes(value[field]))return {state:'unreadable'};identity[field]=value[field];}
    return {state:'identity',identity};
  }

  // The rows ride on a readable observation and are replaced whole; the last refused correction is kept for its uid.
  function succeeded(model,result){
    const base=usable(model),owner=Array.isArray(result?.owner)?JSON.stringify(result.owner):null,observation=result?.observation;
    if(!owner||!observation||typeof observation!=='object'||!validTime(observation.observedAt)||!Array.isArray(result.studies))return failed(base);
    const rows=new Map();
    for(const row of result.studies){
      if(!row||typeof row!=='object'||!validUid(row.uid)||rows.has(row.uid))continue;
      rows.set(row.uid,{tags:{uid:row.uid,acc:textOf(row.acc),id:textOf(row.id),name:textOf(row.name),
        birth:textOf(row.birth),sex:textOf(row.sex),desc:textOf(row.desc)},tele:row.tele===true,order:read(row.orderIdentity)});
    }
    return {owner,observedAt:observation.observedAt,available:true,rows,refused:base.owner===owner?base.refused:null};
  }

  // A failed or unreadable observation empties nothing: the last tags, relations and their time stay.
  function failed(model){return {...usable(model),available:false};}

  function correction(model,uid,ok){
    const base=usable(model);
    return {...base,refused:ok?(base.refused===uid?null:base.refused):uid};
  }

  // The last server-read tags of a row (for repainting a row after Unmatch), or null when none are held.
  function tags(model,uid){
    const row=usable(model).rows?.get(uid);
    return row?{...row.tags}:null;
  }

  /*
   * `state` is the row state this screen holds (appState): a relation is shown only while that state is matched to
   * the same order the answer names. An unlinked state is No Linked Order at once; a matched state the answer does not
   * name (a newer link, a null answer, an unreadable one) is Unknown, never Same Value.
   */
  function view(model,uid,state,format=localTime){
    const m=usable(model);
    if(m.available===null)return {hidden:true};
    const tail=m.available===false?' · '+OBSERVATION_UNAVAILABLE+(m.observedAt?' · 마지막 관측 '+format(m.observedAt)+' 기준':''):'';
    const unavailableTitle=m.available===false?UNAVAILABLE_TITLE+(m.observedAt?' 아래 값은 마지막으로 성공한 관측의 것입니다.':''):'';
    const row=m.rows?.get(uid)??null;
    if(!row){
      // A cold failure or a study the last observation did not carry: nothing is invented.
      if(m.available!==false)return {hidden:true};
      return {hidden:false,key:'unavailable',summary:{text:'DICOM Identity'+tail,title:SUMMARY_TITLE+unavailableTitle},
        order:null,rows:[],guidance:'',patientMismatch:false,accessionMismatch:false};
    }
    const own=state&&typeof state==='object'?state:{};
    const matched=own.matched??'U';
    let key;
    if(row.tele)key='tele';
    else if(matched==='U')key='no_linked_order';
    else if(matched==='M'&&row.order.state==='identity'&&row.order.identity.oid===own.oid)key='linked';
    else key='unknown';
    const identity=key==='linked'?row.order.identity:null;
    const rows=TAGS.map(tag=>{
      const value=row.tags[tag.key];
      let relation='',title='';
      if(identity&&tag.field==='not_compared'){relation=RELATION_TEXT.not_compared;title=RELATION_TITLE.not_compared;}
      else if(identity&&tag.field){
        relation=RELATION_TEXT[identity[tag.field]];
        title=RELATION_TITLE[identity[tag.field]]+(tag.key==='name'?' '+NAME_SCOPE:'');
      }
      return {key:tag.key,tag:tag.tag,label:tag.label,value:value===''?tag.absent:value,valueTitle:tag.title,relation,title};
    });
    const patientMismatch=!!identity&&PATIENT_FIELDS.some(field=>identity[field]==='mismatch');
    const accessionMismatch=!!identity&&identity.accession==='mismatch';
    const order=key==='linked'?{text:'Linked Order '+identity.oid+' · '+MARKER,title:ORDER_TITLE.linked}
      :key==='tele'?{text:'Tele-received · Not Compared',title:ORDER_TITLE.tele}
      :key==='no_linked_order'?{text:'No Linked Order',title:ORDER_TITLE.no_linked_order}
      :{text:'Unknown',title:ORDER_TITLE.unknown};
    const summary={
      text:'DICOM Identity'+(patientMismatch?' · Patient Mismatch':'')+(accessionMismatch?' · Accession Mismatch':'')+tail,
      title:SUMMARY_TITLE+(patientMismatch?PATIENT_MISMATCH_TITLE:'')+(accessionMismatch?ACCESSION_MISMATCH_TITLE:'')+unavailableTitle};
    const show=patientMismatch||accessionMismatch||m.refused===uid;
    return {hidden:false,key,summary,order,rows,guidance:guidance(own.rs,show,key==='tele'),patientMismatch,accessionMismatch};
  }

  const api={start,read,succeeded,failed,correction,tags,view,guidance,SOURCE,MARKER,TAGS,RELATION_TEXT,RELATION_TITLE,
    ORDER_TITLE,GUIDANCE_W,NAME_SCOPE,PHRASES:Object.freeze({observationUnavailable:OBSERVATION_UNAVAILABLE})};
  root.KinStudyIdentity=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis==='object'?globalThis:this);
