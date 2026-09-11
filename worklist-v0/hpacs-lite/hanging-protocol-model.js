(function(root){
  'use strict';
  const VERSION=1,MAX_RULES=20,MAX_SELECTORS=4,PREFIX='kin-hanging-protocols:v1:';
  const own=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
  const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
  const uid=v=>typeof v==='string'&&v.length<=64&&/^[0-9]+(?:\.[0-9]+)*$/.test(v);
  const folded=v=>v.normalize('NFKC').toLocaleLowerCase('en-US');
  function text(v,max){return typeof v==='string'&&v===v.trim()&&v.length>=1&&v.length<=max?v:null;}
  function token(v,max){if(v===null)return null;const s=text(v,max);return s&&s===s.toUpperCase()?s:null;}
  function description(v){
    if(v===null)return null;
    return own(v,['operator','value'])&&['equals','contains'].includes(v.operator)&&text(v.value,128)?{operator:v.operator,value:v.value}:null;
  }
  const alias=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(v)?v:null;
  function condition(v,laterality,strict=true){
    const keys=['modality','retrieveAE','bodyPart','description',...(laterality?['laterality']:[])];
    if(strict&&!own(v,keys))return null;
    const clean={modality:token(v.modality,16),retrieveAE:token(v.retrieveAE,16),bodyPart:token(v.bodyPart,64),description:description(v.description)};
    if((v.modality!==null&&clean.modality===null)||(v.retrieveAE!==null&&clean.retrieveAE===null)||(v.bodyPart!==null&&clean.bodyPart===null)||(v.description!==null&&clean.description===null))return null;
    if(laterality){if(v.laterality!==null&&!['L','R','B'].includes(v.laterality))return null;clean.laterality=v.laterality;}
    return clean;
  }
  function normalize(value){
    try{if(new TextEncoder().encode(JSON.stringify(value)).length>65536)return null;}catch(_){return null;}
    if(!own(value,['version','activeRuleId','rules'])||value.version!==VERSION||!Array.isArray(value.rules)||value.rules.length>MAX_RULES)return null;
    if(value.activeRuleId!==null&&!uuid(value.activeRuleId))return null;
    const names=new Set(),ids=new Set(),rules=[];
    for(const rule of value.rules){
      const id=typeof rule?.id==='string'?rule.id.toLowerCase():rule?.id;
      if(!own(rule,['id','name','enabled','match','selectors','layout'])||!uuid(rule.id)||ids.has(id)||typeof rule.enabled!=='boolean')return null;
      const name=text(rule.name,64),nameKey=name&&folded(name),match=condition(rule.match,false);
      if(!name||names.has(nameKey)||!match||!Array.isArray(rule.selectors)||rule.selectors.length<1||rule.selectors.length>MAX_SELECTORS)return null;
      const aliases=new Set(),selectors=[];
      for(const selector of rule.selectors){
        if(!own(selector,['alias','role','historical','modality','retrieveAE','bodyPart','description','laterality','order','occurrence']))return null;
        const aliasValue=alias(selector.alias),aliasKey=aliasValue&&selector.alias.toLowerCase(),fields=condition(selector,true,false);
        if(!aliasValue||aliases.has(aliasKey)||!['current','related'].includes(selector.role)||typeof selector.historical!=='boolean'||
          selector.role==='current'&&selector.historical||!fields||!['ascending','descending'].includes(selector.order)||
          !Number.isInteger(selector.occurrence)||selector.occurrence<1||selector.occurrence>500)return null;
        aliases.add(aliasKey);selectors.push({alias:aliasValue,role:selector.role,historical:selector.historical,...fields,order:selector.order,occurrence:selector.occurrence});
      }
      const layout=rule.layout;
      if(!own(layout,['rows','cols','cells'])||![[1,1],[1,2],[2,2]].some(([r,c])=>layout.rows===r&&layout.cols===c)||
        !Array.isArray(layout.cells)||layout.cells.length!==layout.rows*layout.cols)return null;
      const byAlias=new Map(selectors.map(s=>[s.alias.toLowerCase(),s])),cells=[];
      for(const cell of layout.cells){
        if(cell===null){cells.push(null);continue;}
        const aliasValue=alias(cell),selector=aliasValue&&byAlias.get(aliasValue.toLowerCase());if(!selector||aliasValue!==selector.alias)return null;cells.push(aliasValue);
      }
      if(!cells.some(cell=>cell!==null&&byAlias.get(cell.toLowerCase()).role==='current'))return null;
      ids.add(id);names.add(nameKey);rules.push({id,name,enabled:rule.enabled,match,selectors,layout:{rows:layout.rows,cols:layout.cols,cells}});
    }
    const activeRuleId=value.activeRuleId===null?null:value.activeRuleId.toLowerCase();
    if(activeRuleId!==null&&!rules.some(rule=>rule.id===activeRuleId&&rule.enabled))return null;
    const clean={version:VERSION,activeRuleId,rules};
    return new TextEncoder().encode(JSON.stringify(clean)).length<=65536?clean:null;
  }
  const empty=()=>({version:VERSION,activeRuleId:null,rules:[]});
  function owner(value){
    const institution=Array.isArray(value)?value[0]:value?.institution,subject=Array.isArray(value)?value[1]:value?.subject;
    return [institution,subject].every(v=>typeof v==='string'&&v.length>0&&v.length<=256)?{institution,subject}:null;
  }
  const ownerKey=value=>{const clean=owner(value);return clean?PREFIX+JSON.stringify([clean.institution,clean.subject]):null;};
  function read(storage,key){
    if(!key)throw Error('계정 정보를 확인할 수 없습니다.');const raw=storage.getItem(key);if(raw===null)return null;
    const clean=typeof raw==='string'&&raw.length<=65536?normalize(JSON.parse(raw)):null;if(!clean)throw Error('저장한 Hanging Protocol이 손상되었거나 지원하지 않는 형식입니다.');return clean;
  }
  function write(storage,key,value){const clean=normalize(value);if(!key||!clean)throw Error('Hanging Protocol을 저장할 수 없습니다.');storage.setItem(key,JSON.stringify(clean));return clean;}
  function date(value){
    if(typeof value!=='string')return null;const s=value.replaceAll('-','');if(!/^\d{8}$/.test(s))return null;
    const y=+s.slice(0,4),m=+s.slice(4,6),d=+s.slice(6,8),x=new Date(Date.UTC(y,m-1,d));return y>0&&x.getUTCFullYear()===y&&x.getUTCMonth()===m-1&&x.getUTCDate()===d?s:null;
  }
  function exactToken(value,max){return typeof value==='string'&&value.trim()&&value.trim().length<=max?value.trim().toUpperCase():null;}
  function uniform(sources,names,max){
    if(!Array.isArray(sources)||sources.length===0)return null;let result;
    for(const source of sources){let value=null;for(const name of names)if(source?.[name]!=null){value=exactToken(source[name],max);break;}
      if(!value||result&&result!==value)return null;result=value;}
    return result||null;
  }
  function displayMetadata(displaySet){
    const sources=displaySet?.images;
    return {modality:exactToken(displaySet?.Modality,16),retrieveAE:uniform(sources,['RetrieveAETitle'],16),bodyPart:uniform(sources,['BodyPartExamined'],64),
      description:typeof displaySet?.SeriesDescription==='string'?displaySet.SeriesDescription.trim().slice(0,128):'',
      laterality:uniform(sources,['Laterality','ImageLaterality'],1),seriesNumber:Number.isFinite(Number(displaySet?.SeriesNumber))?Number(displaySet.SeriesNumber):null};
  }
  function descriptionMatches(actual,rule){if(rule===null)return true;if(typeof actual!=='string')return false;const a=folded(actual.trim()),b=folded(rule.value);return rule.operator==='equals'?a===b:a.includes(b);}
  function fieldsMatch(actual,rule){return ['modality','retrieveAE','bodyPart','laterality'].every(k=>!(k in rule)||rule[k]===null||actual[k]===rule[k])&&descriptionMatches(actual.description,rule.description);}
  function common(values){if(!values.length||values.some(value=>value===null)||new Set(values).size!==1)return null;return values[0];}
  function studyMetadata(study,sets){
    const metadata=sets.map(displayMetadata);
    return {modality:exactToken(study?.modality??study?.ModalitiesInStudy,16),retrieveAE:exactToken(study?.retrieveAE??study?.RetrieveAETitle,16)??common(metadata.map(value=>value.retrieveAE)),
      bodyPart:exactToken(study?.bodyPart??study?.BodyPartExamined,64)??common(metadata.map(value=>value.bodyPart)),description:String(study?.desc??study?.StudyDescription??'')};
  }
  function resolve(value,context,selectedRuleId=null){
    const library=normalize(value);if(!library)throw Error('Hanging Protocol 형식이 잘못되었습니다.');
    const studies=context?.studies,sets=context?.displaySets;
    if(!Array.isArray(studies)||studies.length<1||studies.length>2||!Array.isArray(sets))throw Error('현재 검사 정보를 확인할 수 없습니다.');
    if(studies.some(s=>!uid(s?.uid??s?.StudyInstanceUID)))throw Error('현재 검사 식별자를 확인할 수 없습니다.');
    const source=studies[0]?.sourcePatientKey;
    if(typeof source!=='string'||!source||studies.some(s=>s.sourcePatientKey!==source))throw Error('현재/관련 검사가 같은 원본 환자인지 확인할 수 없습니다.');
    const current=studies[0],related=studies[1]||null,currentDate=date(current.date??current.StudyDate),relatedDate=date(related?.date??related?.StudyDate);
    const candidates=selectedRuleId===null?library.rules.filter(r=>r.enabled):library.rules.filter(r=>r.id===selectedRuleId&&r.enabled);
    if(selectedRuleId!==null&&!uuid(selectedRuleId))throw Error('선택한 규칙을 확인할 수 없습니다.');
    for(const rule of candidates){
      const currentUid=current.uid??current.StudyInstanceUID,currentSets=sets.filter(ds=>ds?.StudyInstanceUID===currentUid);
      if(!fieldsMatch(studyMetadata(current,currentSets),rule.match))continue;
      const chosen=new Map(),byAlias=new Map(rule.selectors.map(s=>[s.alias,s]));let failed=false;
      for(const alias of new Set(rule.layout.cells.filter(Boolean))){
        const selector=byAlias.get(alias),study=selector.role==='current'?current:related;
        if(!study||selector.historical&&(!currentDate||!relatedDate||relatedDate>=currentDate)){failed=true;break;}
        const studyUid=study.uid??study.StudyInstanceUID;
        const pool=sets.filter(ds=>ds?.StudyInstanceUID===studyUid&&uid(ds.SeriesInstanceUID)&&typeof ds.displaySetInstanceUID==='string'&&ds.displaySetInstanceUID&&Array.isArray(ds.images)&&ds.images.length>0&&fieldsMatch(displayMetadata(ds),selector));
        const seriesCounts=new Map();for(const ds of pool)seriesCounts.set(ds.SeriesInstanceUID,(seriesCounts.get(ds.SeriesInstanceUID)||0)+1);
        if([...seriesCounts.values()].some(n=>n!==1)){failed=true;break;}
        pool.sort((a,b)=>{const am=displayMetadata(a),bm=displayMetadata(b),an=am.seriesNumber,bn=bm.seriesNumber;
          if(an===null||bn===null){if(an===null&&bn===null){const tied=a.SeriesInstanceUID.localeCompare(b.SeriesInstanceUID);return selector.order==='ascending'?tied:-tied;}return an===null?1:-1;}
          const ordered=an-bn||a.SeriesInstanceUID.localeCompare(b.SeriesInstanceUID);return selector.order==='ascending'?ordered:-ordered;});
        const selected=pool[selector.occurrence-1];if(!selected){failed=true;break;}chosen.set(alias,selected);
      }
      if(!failed)return {kind:'match',rule,cells:rule.layout.cells.map(alias=>alias===null?null:chosen.get(alias))};
    }
    return {kind:'no-match'};
  }
  root.KinHangingProtocolModel={VERSION,MAX_RULES,MAX_SELECTORS,PREFIX,empty,normalize,owner,ownerKey,read,write,date,displayMetadata,resolve};
  if(typeof module==='object'&&module.exports)module.exports=root.KinHangingProtocolModel;
})(typeof globalThis==='object'?globalThis:this);
