/* Mammography object facts for display and comparison (E-MG).
   Input is the DICOM JSON model (PS3.18 F.2) of each stored instance. Nothing here reads or
   computes pixels: a synthetic 2D view is only ever the object the device stored, and a DBT
   object is only ever navigated as stored. Classification follows PS3.3 C.8.11.7 Image Type and
   the X-Ray 3D frame type; a series description never confirms a kind. */
(function(root){
  'use strict';
  const SOP_MG='1.2.840.10008.5.1.4.1.1.1.2',SOP_MG_PROCESSING='1.2.840.10008.5.1.4.1.1.1.2.1',SOP_DBT='1.2.840.10008.5.1.4.1.1.13.1.3';
  const MAX_FRAMES=2000,MAX_INSTANCES=4000,POSITION_EPSILON=1e-3,SPACING_TOLERANCE=0.01;
  const KINDS=['conventional','generated2d','dbt'],ROLES=['current','prior'],SIDES=['R','L'],STANDARD_VIEWS=['CC','MLO'];
  const uid=v=>typeof v==='string'&&v.length<=64&&/^\d+(?:\.\d+)+$/.test(v);

  // DICOM JSON accessors. Values are read as given; an absent or malformed value is absent.
  function values(item,tag){const e=item&&typeof item==='object'?item[tag]:null;return e&&typeof e==='object'&&Array.isArray(e.Value)?e.Value:[];}
  function text(item,tag,index=0){
    const v=values(item,tag)[index];
    if(v&&typeof v==='object'&&typeof v.Alphabetic==='string')return v.Alphabetic.trim();
    return typeof v==='string'?v.trim():typeof v==='number'&&Number.isFinite(v)?String(v):'';
  }
  function number(item,tag,index=0){
    const v=values(item,tag)[index],n=typeof v==='number'?v:typeof v==='string'&&v.trim()!==''?Number(v):NaN;
    return Number.isFinite(n)?n:null;
  }
  function numbers(item,tag,count){
    const list=values(item,tag);if(list.length!==count)return null;
    const out=list.map(v=>typeof v==='number'?v:typeof v==='string'&&v.trim()!==''?Number(v):NaN);
    return out.every(Number.isFinite)?out:null;
  }
  const items=(item,tag)=>values(item,tag).filter(x=>x&&typeof x==='object'&&!Array.isArray(x));
  const tokens=(item,tag)=>values(item,tag).map(v=>typeof v==='string'?v.trim().toUpperCase():'');

  // Functional group macros: a per-frame item overrides the shared item (PS3.3 C.7.6.16).
  const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
  function groups(item){
    const e=item&&item['52009229'];
    const valid=e===undefined||(object(e)&&e.vr==='SQ'&&Array.isArray(e.Value)&&e.Value.length===1&&object(e.Value[0]));
    return {shared:valid&&e?e.Value[0]:null,perFrame:items(item,'52009230'),valid};
  }
  function macro(fg,frame,tag){
    const own=fg.perFrame[frame-1],found=own?items(own,tag)[0]:null;
    return found||(fg.shared?items(fg.shared,tag)[0]||null:null);
  }

  // CID 4014 View for Mammography (SCT codes and their legacy SRT/SNM3 values).
  const VIEW_CODES={'399260004':'ML','R-10224':'ML','399368009':'MLO','R-10226':'MLO','399352003':'LM','R-10228':'LM',
    '399099002':'LMO','R-10230':'LMO','399162004':'CC','R-10242':'CC','399196006':'FB','R-10244':'FB','399188001':'SIO','R-102D0':'SIO',
    '441555000':'ISO','R-40AAA':'ISO','399192008':'XCCL','R-1024A':'XCCL','399101009':'XCCM','R-1024B':'XCCM','127457009':'SPECIMEN','G-8310':'SPECIMEN'};
  // CID 4015 View Modifier for Mammography.
  const MODIFIER_CODES={'399161006':'Cleavage','R-102D2':'Cleavage','399011000':'Axillary Tail','R-102D1':'Axillary Tail',
    '399197002':'Rolled Lateral','R-102D3':'Rolled Lateral','399226006':'Rolled Medial','R-102D4':'Rolled Medial',
    '414493004':'Rolled Inferior','R-102CA':'Rolled Inferior','415670009':'Rolled Superior','R-102C9':'Rolled Superior',
    '399209000':'Implant Displaced','R-102D5':'Implant Displaced','399163009':'Magnification','R-102D6':'Magnification',
    '399055006':'Spot Compression','R-102D7':'Spot Compression','399110001':'Tangential','R-102C2':'Tangential',
    '442581004':'Nipple In Profile','R-40AB3':'Nipple In Profile','441752004':'Anterior Compression','P2-00161':'Anterior Compression',
    '442593008':'Infra-Mammary Fold','R-40ABE':'Infra-Mammary Fold','442580003':'Axillary Tissue','R-40AB2':'Axillary Tissue'};
  const SCHEMES={SCT:'SCT',SRT:'SRT',SNM3:'SRT'};
  function code(item){
    const scheme=SCHEMES[text(item,'00080102').toUpperCase()],value=text(item,'00080100');
    if(!scheme||!value)return null;
    // An SCT designator only carries numeric concept ids; a legacy designator only alphanumeric SRT ids.
    if(scheme==='SCT'!==/^\d+$/.test(value))return null;
    return value;
  }
  function view(item){
    const list=items(item,'00540220');
    if(!list.length)return {value:null,modifiers:[],issue:'view-missing',evidence:[]};
    if(list.length>1)return {value:null,modifiers:[],issue:'view-multiple',evidence:[]};
    const key=code(list[0]),value=key?VIEW_CODES[key]||null:null;
    const modifierItems=[...items(list[0],'00540222'),...items(item,'00540222')];
    const modifiers=modifierItems.map(m=>{const k=code(m);return k&&MODIFIER_CODES[k]||'Unknown Modifier';});
    const evidence=['View Code='+text(list[0],'00080102')+'|'+text(list[0],'00080100')];
    if(!value)return {value:null,modifiers,issue:'view-code-unknown',evidence};
    const position=text(item,'00185101').toUpperCase();
    if(position&&position!==value)return {value:null,modifiers,issue:'view-conflict',evidence:[...evidence,'View Position='+position]};
    return {value,modifiers,issue:null,evidence};
  }

  function laterality(item,fg){
    const found=[];
    const add=(source,v)=>{if(v)found.push([source,v.toUpperCase()]);};
    add('Image Laterality',text(item,'00200062'));
    add('Laterality',text(item,'00200060'));
    if(fg.shared){const a=items(fg.shared,'00209071')[0];if(a)add('Frame Laterality',text(a,'00209072'));}
    for(const f of fg.perFrame){const a=items(f,'00209071')[0];if(a)add('Frame Laterality',text(a,'00209072'));}
    const distinct=[...new Set(found.map(x=>x[1]))],evidence=[...new Set(found.map(([s,v])=>s+'='+v))];
    if(!distinct.length)return {value:null,issue:'laterality-missing',evidence};
    if(distinct.length>1)return {value:null,issue:'laterality-conflict',evidence};
    if(!['R','L','B'].includes(distinct[0]))return {value:null,issue:'laterality-invalid',evidence};
    return {value:distinct[0],issue:null,evidence};
  }

  const STEREO=new Set(['STEREO_SCOUT','STEREO_MINUS','STEREO_PLUS','PREFIRE_MINUS','PREFIRE_PLUS','POSTFIRE_MINUS','POSTFIRE_PLUS',
    'POSTBIOPSY_MINUS','POSTBIOPSY_PLUS','POSTBIOPSY','POSTMARKER_MINUS','POSTMARKER_PLUS','POSTMARKER']);
  // Header contradictions after which no class is trusted (decision row 0).
  const BLOCKING=new Set(['identity-invalid','laterality-conflict','laterality-invalid','view-conflict','view-multiple','partial-view-conflict']);
  // ---- Shared mammography classification contract D735 (E-MG and EMR-E read headers the same way) ----
  // Result fields: class, baseClass, status, partial (yes/no/unknown/conflict), presentation, representation,
  // fullViewAutoMatch, sourceClassEligible, basis, declared source references. status=verified means only
  // that the header satisfies this contract; it certifies no display, diagnosis or acquisition coverage.
  const RULE_VERSION='D744-2';
  const FAMILY={[SOP_MG]:'MG-P',[SOP_MG_PROCESSING]:'MG-R',[SOP_DBT]:'BTO'};
  const BIOPSY3=new Set(['TOMO_SCOUT','PREFIRE','POSTFIRE','POSTBIOPSY','POSTMARKER']);
  const GENERATED3=new Set(['TOMOSYNTHESIS',...BIOPSY3]);
  const SLAB_PAIRS=new Set(['NONE|MAX_IP','MAXIMUM|MAX_IP','NONE|MIN_IP','MAXIMUM|TOMOSYNTHESIS','MEAN|TOMOSYNTHESIS']);
  const THIN_MAX_MM=3,GEOMETRY_EPSILON=1e-3;
  const lengthTolerance=d=>Math.max(0.05,0.01*d);
  // Older software marked its synthetic view only in free text or private tags. Such a hint never
  // confirms a kind, but it does stop the object from being treated as a confirmed conventional view.
  // "Tomosynthesis" itself is no such hint: a 2D exposure of a combo examination is described that way.
  const LEGACY_HINT=/\bc-?view\b|synthetic|synthesi[sz]ed|\bv-?preview\b|intelligent\s*2d|\bs-?view\b|insight\s*2d|generated\s*2d|2d\s*generated/i;
  // Verified device profiles (R1 support limits, not DICOM conformance verdicts; C.8.21.6 allows a
  // generated 2D Breast Tomosynthesis object). Evidence: TCIA EA1141 v2 EA1141-4339969 (D735 rule H).
  const HOLOGIC_MANUFACTURERS=['HOLOGIC','HOLOGIC, INC.'],HOLOGIC_MODEL='SELENIA DIMENSIONS';
  const PROFILE_SYNTHETIC={id:'hologic-selenia-dimensions-bto-generated-2d',software:['AWS:1.9.1.8']};
  const PROFILE_SLICES={id:'hologic-selenia-1mm-slices',software:['AWS:1.8.3.63','AWS:1.9.1.8']};
  function hologic(item,profile){
    const manufacturer=text(item,'00080070').toUpperCase(),model=text(item,'00081090').toUpperCase();
    const software=values(item,'00181020').map(v=>typeof v==='string'?v.trim():'');
    return HOLOGIC_MANUFACTURERS.includes(manufacturer)&&model===HOLOGIC_MODEL&&profile.software.some(s=>software.includes(s));
  }
  // Image/Frame Type values in position; null when the element is absent or carries no value.
  function typeOf(item,tag){
    const e=item&&typeof item==='object'?item[tag]:null;
    if(!e||typeof e!=='object'||!Array.isArray(e.Value)||!e.Value.length)return null;
    return e.Value.map(v=>typeof v==='string'?v.trim().toUpperCase():v===null||v===undefined?'':String(v).toUpperCase());
  }
  // An optional empty fifth value and an absent one mean the same; anything else keeps its place.
  const normalizedType=t=>{const out=t.slice();while(out.length>4&&out[out.length-1]==='')out.pop();return out.join('\\');};

  // CID 4005 Partial View Section for Mammography.
  const PARTIAL_CODES={'255549009':'Anterior','R-404CC':'Anterior','255551008':'Posterior','R-404CE':'Posterior',
    '264217000':'Superior','R-42191':'Superior','261089000':'Inferior','R-4094A':'Inferior','255561001':'Medial','R-404D5':'Medial',
    '49370004':'Lateral','G-A104':'Lateral','26216008':'Central','G-A110':'Central'};
  // Rule P: any partial evidence (flag YES, a section code, a description) makes the view partial; the
  // absence of all three proves nothing (unknown); a wrong flag, NO beside evidence, more than two codes
  // or a magnification/spot modifier beside partial evidence is a conflict.
  function partialView(item,modifiers){
    const flagElement=item['00281350'],description=text(item,'00281351');
    let declaration='ABSENT';
    if(Object.prototype.hasOwnProperty.call(item,'00281350')){
      if(!object(flagElement)||flagElement.vr!=='CS'||('Value' in flagElement&&!Array.isArray(flagElement.Value)))declaration='INVALID';
      else{
        const vs=flagElement.Value||[];
        if(!vs.length||vs.length===1&&(vs[0]===null||typeof vs[0]==='string'&&!vs[0].trim()))declaration='EMPTY';
        else if(vs.length!==1||typeof vs[0]!=='string')declaration='INVALID';
        else{const value=vs[0].trim().toUpperCase();declaration=['YES','NO'].includes(value)?value:'INVALID';}
      }
    }
    const flag=['YES','NO'].includes(declaration)?declaration:'';
    const sq=item['00281352'];
    const malformed=Object.prototype.hasOwnProperty.call(item,'00281352')&&
      (!object(sq)||sq.vr!=='SQ'||('Value' in sq&&(!Array.isArray(sq.Value)||!sq.Value.every(object))));
    const codeItems=items(item,'00281352');
    const sections=codeItems.map(c=>{const k=code(c);return k&&PARTIAL_CODES[k]||'Unknown Section';});
    const evidence=codeItems.length>0||!!description;
    let state;
    const modifierItems=[...items(item,'00540222'),...items(item,'00540220').flatMap(v=>items(v,'00540222'))];
    const wrongContainer=modifierItems.some(m=>!!PARTIAL_CODES[code(m)]);
    if(declaration==='INVALID'||malformed||wrongContainer)state='conflict';
    else if(codeItems.length>2)state='conflict';
    else if(flag==='NO'&&evidence)state='conflict';
    else if((flag==='YES'||evidence)&&modifiers.some(m=>m==='Magnification'||m==='Spot Compression'))state='conflict';
    else if(flag==='YES'||evidence)state='yes';
    else if(flag==='NO')state='no';
    else state='unknown';
    const notes=[...(flag?['Partial View='+flag]:[]),...sections.map(s=>'Partial View Section='+s),...(description?['Partial View Description present']:[])];
    return {state,declaration,sections,codes:codeItems.map(c=>text(c,'00080102')+'|'+text(c,'00080100')).sort(),yesWithoutCodes:flag==='YES'&&!codeItems.length,notes};
  }

  // Raw source references as the device stored them: Source Image Sequence at the top level, inside the
  // X-Ray 3D Acquisition items and inside Derivation Image (top level, shared and per-frame groups).
  function declaredSources(item){
    const found=new Map();
    const take=(holder,path)=>items(holder,'00082112').forEach((s,i)=>{
      const frames=values(s,'00081160').map(Number);
      const ref={path:path+'SourceImageSequence['+i+']',sopClass:text(s,'00081150'),sop:text(s,'00081155'),frames:frames.length?frames:null};
      const key=[ref.sopClass,ref.sop,JSON.stringify(ref.frames)].join('|');
      if(!found.has(key))found.set(key,ref);
    });
    take(item,'');
    items(item,'00189507').forEach((a,i)=>take(a,'XRay3DAcquisitionSequence['+i+']/'));
    const derivations=(holder,path)=>items(holder,'00089124').forEach((d,i)=>take(d,path+'DerivationImageSequence['+i+']/'));
    derivations(item,'');
    items(item,'52009229').forEach((g,i)=>derivations(g,'SharedFunctionalGroupsSequence['+i+']/'));
    items(item,'52009230').forEach((g,i)=>derivations(g,'PerFrameFunctionalGroupsSequence['+i+']/'));
    return [...found.values()];
  }

  // Rule G: stored geometry of every frame, read from that frame (no first-frame shortcut, no hidden
  // shared/per-frame override). Returns {ok, thickness, spacing} or {ok:false, reason}.
  function geometry(item,fg,frames){
    const thickness=[],positions=[];let orientation=null;
    for(let k=1;k<=frames;k++){
      const pm=macro(fg,k,'00289110'),pp=macro(fg,k,'00209113'),po=macro(fg,k,'00209116');
      const t=pm?number(pm,'00180050'):null,ipp=pp?numbers(pp,'00200032',3):null,iop=po?numbers(po,'00200037',6):null;
      if(!(t>0)||!ipp||!iop)return {ok:false,reason:'geometry-incomplete'};
      if(orientation&&iop.some((v,i)=>Math.abs(v-orientation[i])>GEOMETRY_EPSILON))return {ok:false,reason:'orientation-not-uniform'};
      orientation=orientation||iop;thickness.push(t);positions.push(ipp);
    }
    const row=orientation.slice(0,3),column=orientation.slice(3,6),normal=cross(row,column);
    if(Math.abs(dot(row,row)-1)>GEOMETRY_EPSILON||Math.abs(dot(column,column)-1)>GEOMETRY_EPSILON||Math.abs(dot(row,column))>GEOMETRY_EPSILON)
      return {ok:false,reason:'orientation-invalid'};
    const z=positions.map(p=>dot(p,normal)).sort((a,b)=>a-b);
    const gaps=z.slice(1).map((v,i)=>v-z[i]);
    if(gaps.some(g=>g<GEOMETRY_EPSILON))return {ok:false,reason:'duplicate-position'};
    const sorted=gaps.slice().sort((a,b)=>a-b),d=sorted.length?sorted[Math.floor(sorted.length/2)]:null;
    if(d===null)return {ok:false,reason:'single-frame'};
    const tol=lengthTolerance(d);
    if(gaps.some(g=>Math.abs(g-d)>tol))return {ok:false,reason:'irregular-spacing'};
    if(thickness.some(t=>Math.abs(t-thickness[0])>lengthTolerance(thickness[0])))return {ok:false,reason:'thickness-not-uniform'};
    // A declared spacing is checked against the real one, never used instead of it.
    const declared=[item,...(fg.shared?[fg.shared]:[]),...fg.perFrame].flatMap(h=>[number(h,'00180088'),...items(h,'00289110').map(m=>number(m,'00180088'))]).filter(v=>v!==null);
    if(declared.some(s=>Math.abs(Math.abs(s)-d)>tol))return {ok:false,reason:'spacing-tag-conflict'};
    return {ok:true,thickness:thickness[0],spacing:d};
  }

  function classify(item){
    const fg=groups(item),sopClass=text(item,'00080016'),family=FAMILY[sopClass]||null,type=typeOf(item,'00080008');
    const out={sop:text(item,'00080018'),series:text(item,'0020000E'),study:text(item,'0020000D'),sopClass,
      instanceNumber:number(item,'00200013'),seriesNumber:number(item,'00200011'),frames:null,
      kind:null,status:'unverified',presentation:null,laterality:null,view:null,modifiers:[],partial:false,partialState:'unknown',partialSections:[],
      biopsy:null,sliceKind:null,sliceThickness:null,basis:null,evidence:[],issues:[],notes:[],standard:false,partialSlot:false,
      fullViewAutoMatch:false,contract:null,sources:[]};
    const issue=v=>{if(v&&!out.issues.includes(v))out.issues.push(v);};
    const unverified=reason=>{issue(reason);return null;};
    out.presentation=family==='MG-P'?'presentation':family==='MG-R'?'processing':null;
    const lat=laterality(item,fg);out.laterality=lat.value;out.evidence.push(...lat.evidence);issue(lat.issue);
    const v=view(item);out.view=v.value;out.modifiers=v.modifiers;out.evidence.push(...v.evidence);issue(v.issue);
    const pv=partialView(item,out.modifiers);out.partialState=pv.state;out.partial=pv.state==='yes';out.partialSections=pv.sections;out.notes.push(...pv.notes);
    if(pv.state==='conflict')issue('partial-view-conflict');
    out.evidence.push('SOP Class='+sopClass,'Image Type='+(type?type.join('\\'):'(absent)'));
    out.sources=declaredSources(item);
    let base=null,representation=null;
    const ids=uid(out.sop)&&uid(out.series)&&uid(out.study);
    // T: identity, modality, supported IOD and frame count before any per-frame work.
    if(!ids)unverified('identity-invalid');
    else if(text(item,'00080060').toUpperCase()!=='MG'){out.kind='other';unverified('modality-not-mg');}
    else if(!family){out.kind='other';out.basis='unsupported-sop';unverified('sop-class-not-mammography-image');}
    else if(!fg.valid)unverified('shared-functional-groups-invalid');
    else if(family==='BTO')base=classifyTomosynthesis(item,fg,type,out,issue);
    else base=classifyMammography(item,fg,type,family,out,issue);
    // Header contradictions in laterality/view/partial override any class (decision row 0); a Breast
    // View partial flag needs its section code (Type 1C), unlike the Type 3 code of Digital Mammography.
    if(out.issues.some(x=>BLOCKING.has(x)))base=null;
    if(family==='BTO'&&pv.yesWithoutCodes&&base){issue('partial-section-code-missing');base=null;}
    // Representation describes a DBT volume only: verified slices/slab, or "unspecified" for a volume
    // candidate that could not be verified; generated 2D and projection objects have none.
    if(family==='BTO'){
      const volumeCandidate=!type||type[3]!=='GENERATED_2D'&&type[2]!=='TOMO_PROJ';
      representation=base&&base.startsWith('dbt')?out.sliceKind:!base&&(volumeCandidate||pv.yesWithoutCodes)?'unspecified':null;
    }
    out.status=base?'verified':'unverified';
    if(!base){out.kind=out.kind==='other'?'other':null;out.sliceKind=representation;}
    if(family==='BTO')out.presentation=base==='device-synthetic-2d'||base==='projection'?'presentation':null;
    const cls=base&&pv.state==='yes'?'partial-view':base||'unverified';
    // Absent/empty partial declarations permit hanging, without claiming anatomical completeness.
    const plain=!!base&&base!=='projection'&&base!=='conventional-2d-processing'&&out.presentation!=='processing'&&
      SIDES.includes(out.laterality)&&STANDARD_VIEWS.includes(out.view)&&!out.modifiers.length&&!out.biopsy;
    out.fullViewAutoMatch=plain&&(pv.state==='no'||pv.state==='unknown');
    out.standard=out.fullViewAutoMatch;
    out.partialDeclaration=pv.declaration;
    out.fullness=pv.state==='conflict'?'conflict':pv.state==='yes'?'partial':pv.state==='no'?'declared-not-partial':out.fullViewAutoMatch?'inferred-for-hanging':'undetermined';
    out.partialSlot=plain&&pv.state==='yes';
    out.contract={ruleVersion:RULE_VERSION,class:cls,baseClass:base||'unverified',status:out.status,partial:pv.state,
      presentation:out.presentation,representation,fullViewAutoMatch:out.fullViewAutoMatch,partialDeclaration:out.partialDeclaration,fullness:out.fullness,
      sourceClassEligible:['dbt-slices','dbt-slab','projection'].includes(base),basis:out.basis,declaredSourceCount:out.sources.length,
      sourceLinks:out.sources.length?'unresolved-not-in-input-store':null};
    return out;
  }

  // Decision rows 2-4 and 8 for Digital Mammography For Presentation / For Processing.
  function classifyMammography(item,fg,type,family,out,issue){
    const intent=text(item,'00080068').toUpperCase(),declared=values(item,'00280008').length?number(item,'00280008'):1;
    out.frames=Number.isInteger(declared)&&declared>=1&&declared<=MAX_FRAMES?declared:null;
    if(declared!==1){issue(out.frames?'single-frame-iod-with-frames':'frame-count-invalid');return null;}
    if(intent!==(family==='MG-P'?'FOR PRESENTATION':'FOR PROCESSING')){issue(intent?'presentation-intent-conflict':'presentation-intent-missing');return null;}
    if(!type){issue('image-type-missing');return null;}
    if(!['ORIGINAL','DERIVED'].includes(type[0])||!['PRIMARY','SECONDARY'].includes(type[1])){issue('image-type-unknown');return null;}
    // A Frame Type outside this single-frame IOD is a second, conflicting claim.
    if(fg.shared||fg.perFrame.length){issue('functional-groups-outside-iod');return null;}
    const v3=type.length>2?type[2]:null,v4=type.length>3?type[3]:'',rest=type.slice(4);
    if(rest.some(x=>x!=='')||v4&&!['NONE','GENERATED_2D'].includes(v4)){out.basis='unmapped-image-type-extension';
      issue(['ADDITION','SUBTRACTION'].includes(v4)?'contrast-enhanced-not-supported':'image-type-unknown');return null;}
    if(v4==='GENERATED_2D'){
      if(!GENERATED3.has(v3)){issue('generated-2d-value3-contradiction');return null;}
      out.kind='generated2d';out.biopsy=v3==='TOMOSYNTHESIS'?null:v3;out.basis='digital-mammography-generated-2d';
      return 'device-synthetic-2d';
    }
    if(v3==='TOMO_PROJ'){out.kind='projection';out.basis='digital-mammography-projection';issue('tomosynthesis-projection');return 'projection';}
    if(v3==='TOMOSYNTHESIS'){issue('tomosynthesis-without-generated-2d');return null;}
    if(v3&&(BIOPSY3.has(v3)||STEREO.has(v3))){issue('biopsy-image');return null;}
    if(v3&&['PRE_CONTRAST','POST_CONTRAST'].includes(v3)){issue('contrast-enhanced-not-supported');return null;}
    if(v3){issue('image-type-unknown');return null;}
    if(['0008103E','00181030','00082111'].some(tag=>LEGACY_HINT.test(text(item,tag)))){issue('possible-legacy-generated-2d');return null;}
    // Value 1 DERIVED describes pixel processing, not synthesis; with no Value 3/4 type this is a 2D exposure.
    out.kind='conventional';out.basis=v3===null?'digital-mammography-legacy-null-v3':'digital-mammography';
    if(family==='MG-R')issue('for-processing-display-not-validated');
    return family==='MG-P'?'conventional-2d-presentation':'conventional-2d-processing';
  }

  // Decision rows 5-8 for Breast Tomosynthesis: homogeneous Image/Frame Types on every frame, matching
  // root/frame summaries, then the named device exception or stored geometry (G) with S or A evidence.
  function classifyTomosynthesis(item,fg,type,out,issue){
    const declared=values(item,'00280008').length?number(item,'00280008'):null;
    if(!Number.isInteger(declared)||declared<1||declared>MAX_FRAMES){issue('frame-count-invalid');return null;}
    out.frames=declared;
    if(fg.perFrame.length!==declared){issue('per-frame-count-mismatch');return null;}
    if(fg.shared&&items(fg.shared,'00189504').length){issue('frame-type-in-shared-group');return null;}
    const sharedKeys=fg.shared?Object.keys(fg.shared):[];
    if(fg.perFrame.some(f=>Object.keys(f).some(k=>sharedKeys.includes(k)))){issue('shared-and-per-frame-macro');return null;}
    if(!type){issue('image-type-missing');return null;}
    const imageType=normalizedType(type),volumetric=text(item,'00089206').toUpperCase(),technique=text(item,'00089207').toUpperCase();
    for(const f of fg.perFrame){
      const t=items(f,'00189504');
      if(t.length!==1||!typeOf(t[0],'00089007')){issue('frame-type-missing');return null;}
      if(normalizedType(typeOf(t[0],'00089007'))!==imageType){issue('image-frame-type-conflict');return null;}
      if(text(t[0],'00089206').toUpperCase()!==volumetric||text(t[0],'00089207').toUpperCase()!==technique){issue('frame-summary-conflict');return null;}
    }
    out.evidence.push('Frame Type='+imageType+' on all '+declared+' frames','Volumetric Properties='+(volumetric||'(absent)'),'Volume Based Calculation Technique='+(technique||'(absent)'));
    const [v1,v2,v3,v4]=imageType.split('\\');
    if(!['ORIGINAL','DERIVED'].includes(v1)||v2!=='PRIMARY'||!v3||!v4||imageType.split('\\').length>4){issue('heterogeneous-profile-not-supported');return null;}
    if(!['VOLUME','SAMPLED'].includes(volumetric)||!technique){issue('volumetric-profile-not-supported');return null;}
    if(v1==='ORIGINAL'&&(v4!=='NONE'||technique!=='NONE')){issue('original-requires-none');return null;}
    if(v4==='GENERATED_2D'){
      const exact=imageType===PROFILE_SYNTHETIC_TYPE&&declared===1&&volumetric==='VOLUME'&&technique==='MAX_IP';
      if(!exact||!hologic(item,PROFILE_SYNTHETIC)){issue('unsupported-device-profile');return null;}
      out.kind='generated2d';out.basis=PROFILE_SYNTHETIC.id;out.notes.push('device-profile:'+PROFILE_SYNTHETIC.id);
      return 'device-synthetic-2d';
    }
    if(v3==='TOMO_PROJ'){
      if(v4!=='NONE'){issue('image-type-unknown');return null;}
      out.kind='projection';out.basis='breast-tomosynthesis-projection';issue('tomosynthesis-projection');return 'projection';
    }
    if(!['TOMOSYNTHESIS','VOLUME'].includes(v3)||!['NONE','MAXIMUM','MEAN'].includes(v4)){issue('image-type-unknown');return null;}
    if(declared<2){issue('single-plane-not-a-volume');out.sliceKind='unspecified';return null;}
    const g=geometry(item,fg,declared);
    const dims=g.ok?frameIndex(item).issues.filter(x=>x.startsWith('dimension')):[];
    if(!g.ok||dims.length){issue(g.ok?dims[0]:g.reason);out.sliceKind='unspecified';return null;}
    out.sliceThickness=g.thickness;
    const tol=lengthTolerance(g.spacing),contiguous=Math.abs(g.thickness-g.spacing)<=tol;
    const hologicSlices=hologic(item,PROFILE_SLICES)&&Math.abs(g.thickness-1)<=0.05&&Math.abs(g.spacing-1)<=0.05&&
      volumetric==='VOLUME'&&technique==='MAX_IP'&&v4==='NONE';
    if(hologicSlices){out.kind='dbt';out.sliceKind='slices';out.basis=PROFILE_SLICES.id;return 'dbt-slices';}
    if(g.thickness<=THIN_MAX_MM&&contiguous&&v4==='NONE'&&['TOMOSYNTHESIS','NONE'].includes(technique)){
      out.kind='dbt';out.sliceKind='slices';out.basis='regular-thin-sections';return 'dbt-slices';
    }
    if(g.thickness>THIN_MAX_MM&&g.thickness+tol>=g.spacing&&SLAB_PAIRS.has(v4+'|'+technique)){
      out.kind='dbt';out.sliceKind=technique==='MAX_IP'?'mip-slab':technique==='MIN_IP'?'minip-slab':'slab';out.basis='thick-aggregation-and-geometry';
      return 'dbt-slab';
    }
    issue('slice-or-slab-evidence-missing');out.sliceKind='unspecified';return null;
  }
  const PROFILE_SYNTHETIC_TYPE='DERIVED\\PRIMARY\\TOMOSYNTHESIS\\GENERATED_2D';

  // Only the supplied reference graph is knowable. Missing nodes remain unresolved; a reachable
  // back edge is a contradiction, including a cycle that does not lead back to the result itself.
  function sourceCycle(item,stored){
    const nodes=new Map(stored.filter(o=>o&&o.dicom).map(o=>[text(o.dicom,'00080018'),o.dicom]));
    const start=text(item,'00080018');nodes.set(start,item);
    const visiting=new Set(),done=new Set(),stack=[[start,false]];
    while(stack.length){
      const [id,leave]=stack.pop();
      if(leave){visiting.delete(id);done.add(id);continue;}
      if(visiting.has(id))return true;
      if(done.has(id)||!nodes.has(id))continue;
      visiting.add(id);stack.push([id,true]);
      for(const ref of declaredSources(nodes.get(id)))stack.push([ref.sop,false]);
    }
    return false;
  }

  // Source references (D735 source contract): a verified stored target of an eligible class, of the same
  // patient, institution and study, same side and view, consistent partial scope, and the referenced SOP
  // class and frame. Raw references are always kept; unresolved and rejected are kept apart.
  function verifySources(item,context){
    const self=classify(item),refs=self.sources;
    const stored=Array.isArray(context&&context.storedObjects)?context.storedObjects:[];
    const validKey=v=>typeof v==='string'&&v.trim().length>0;
    const cyclic=sourceCycle(item,stored);
    const states=refs.map(ref=>{
      if(cyclic||ref.sop===self.sop)return 'rejected';
      const target=stored.find(o=>o&&o.dicom&&text(o.dicom,'00080018')===ref.sop);
      if(!target)return 'unresolved';
      if(![context.patientKey,context.institutionKey,target.patientKey,target.institutionKey].every(validKey))return 'unresolved';
      if(text(target.dicom,'00080016')!==ref.sopClass)return 'rejected';
      if(target.patientKey!==context.patientKey||target.institutionKey!==context.institutionKey)return 'rejected';
      if(text(target.dicom,'0020000D')!==self.study)return 'rejected';
      const t=classify(target.dicom);
      if(t.status!=='verified'||!t.contract.sourceClassEligible)return 'rejected';
      if(ref.frames&&ref.frames.some(f=>!Number.isInteger(f)||f<1||f>(t.frames||0)))return 'rejected';
      if(!self.laterality||!t.laterality||!self.view||!t.view)return 'unresolved';
      if(self.laterality!==t.laterality||self.view!==t.view)return 'rejected';
      if(self.modifiers.includes('Unknown Modifier')||t.modifiers.includes('Unknown Modifier'))return 'unresolved';
      if([...new Set(self.modifiers)].sort().join('|')!==[...new Set(t.modifiers)].sort().join('|')||self.biopsy!==t.biopsy)return 'rejected';
      const a=self.partialState,b=t.partialState;
      if(a==='unknown'||b==='unknown')return 'unresolved';
      if(a!==b)return 'rejected';
      if(a==='yes'){
        const ca=self.partialSections,cb=t.partialSections;
        if(!ca.length||!cb.length||ca.includes('Unknown Section')||cb.includes('Unknown Section'))return 'unresolved';
        if([...new Set(ca)].sort().join('|')!==[...new Set(cb)].sort().join('|'))return 'rejected';
      }
      return 'verified';
    });
    const eligibleResult=self.status==='verified'&&self.contract.baseClass==='device-synthetic-2d';
    const status=!refs.length?'none':!eligibleResult||states.includes('rejected')?'rejected':states.includes('unresolved')?'unresolved':'verified';
    return {sourceLinkStatus:status,sourceAccepted:status==='verified',rawReferenceRetained:true,references:refs.map((r,i)=>({...r,status:states[i]}))};
  }
  // The shared contract result for one stored object, with source verification when a context is given.
  function contract(item,context){
    const c=classify(item).contract,result={...c};
    if(context){const s=verifySources(item,context);Object.assign(result,{sourceLinkStatus:s.sourceLinkStatus,sourceAccepted:s.sourceAccepted,
      rawReferenceRetained:s.rawReferenceRetained,sourceLinks:s.sourceLinkStatus});}
    return result;
  }

  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  // Every stored frame keeps its own (SOP, 1-based frame) identity; display order, total and position
  // are reported separately and an inconsistency is reported, never smoothed over.
  function frameIndex(item){
    const sop=text(item,'00080018'),fg=groups(item),declared=values(item,'00280008').length?number(item,'00280008'):1;
    const issues=[],issue=v=>{if(!issues.includes(v))issues.push(v);};
    if(!fg.valid)issue('shared-functional-groups-invalid');
    if(!uid(sop))issue('identity-invalid');
    if(!Number.isInteger(declared)||declared<1||declared>MAX_FRAMES)return {sop,total:0,entries:[],complete:false,issues:['frame-count-invalid'],spacing:null,thickness:null};
    const multi=declared>1||fg.perFrame.length>0||text(item,'00080016')===SOP_DBT;
    if(!multi)return {sop,total:1,entries:[{sop,frame:1,index:1,total:1,position:{status:'not-applicable'}}],complete:issues.length===0,issues,spacing:null,thickness:null};
    if(fg.perFrame.length!==declared)issue('per-frame-count-mismatch');
    const stored=[];
    for(let frame=1;frame<=declared;frame++){
      const o=macro(fg,frame,'00209116'),p=macro(fg,frame,'00209113');
      const ipp=p?numbers(p,'00200032',3):null;
      if(p&&!ipp)issue('position-invalid');
      stored.push({frame,orientation:o?numbers(o,'00200037',6):null,ipp});
    }
    const first=stored.find(s=>s.orientation)?.orientation;
    let normal=null;
    if(!first)issue('orientation-missing');
    else{
      normal=cross(first.slice(0,3),first.slice(3,6));
      if(Math.abs(dot(normal,normal)-1)>POSITION_EPSILON||Math.abs(dot(first.slice(0,3),first.slice(3,6)))>POSITION_EPSILON){issue('orientation-invalid');normal=null;}
      if(stored.some(s=>!s.orientation||s.orientation.some((v,i)=>Math.abs(v-first[i])>POSITION_EPSILON))){issue('mixed-orientation');normal=null;}
    }
    // A per-frame list of another length cannot be paired with stored frames, so no position is trusted.
    const trusted=normal&&!issues.includes('per-frame-count-mismatch');
    for(const s of stored){
      s.projection=trusted&&s.ipp?dot(s.ipp,normal):null;
      if(trusted&&!s.ipp&&!issues.includes('position-invalid'))issue('position-missing');
    }
    const known=stored.every(s=>s.projection!==null);
    let order=stored.slice();
    if(known){
      const sorted=stored.slice().sort((a,b)=>a.projection-b.projection);
      for(let i=1;i<sorted.length;i++)if(Math.abs(sorted[i].projection-sorted[i-1].projection)<POSITION_EPSILON)issue('duplicate-position');
      const steps=stored.slice(1).map((s,i)=>s.projection-stored[i].projection);
      const monotonic=steps.every(d=>d>0)||steps.every(d=>d<0);
      if(!monotonic){
        // Stored order is not a walk through the volume: show it in position order, in the overall
        // direction of the stored sequence, and keep each frame's own identity.
        const descending=stored[stored.length-1].projection<stored[0].projection;
        order=descending?sorted.reverse():sorted;issue('reordered-by-position');
      }
    }
    let spacing=null;
    if(known&&!issues.includes('duplicate-position')){
      const gaps=order.slice(1).map((s,i)=>Math.abs(s.projection-order[i].projection));
      const step=gaps.length?gaps.reduce((a,b)=>a+b,0)/gaps.length:null;
      if(step!==null&&gaps.every(g=>Math.abs(g-step)<=Math.max(SPACING_TOLERANCE*step,POSITION_EPSILON)))spacing=step;
      else if(step!==null)issue('irregular-spacing');
    }
    dimensionCheck(item,fg,stored,known).forEach(issue);
    const origin=known?order[0].projection:null,sign=known&&order.length>1&&order[order.length-1].projection<order[0].projection?-1:1;
    const entries=order.map((s,i)=>({sop,frame:s.frame,index:i+1,total:declared,
      position:known?{status:'verified',offset:(s.projection-origin)*sign||0,projection:s.projection,unit:'mm',basis:'Plane Position · Plane Orientation'}
        :{status:'unverified',reason:issues.find(x=>/orientation|position|per-frame/.test(x))||'position-missing'}}));
    const t=macro(fg,1,'00289110');
    const informational=new Set(['reordered-by-position']);
    return {sop,total:declared,entries,complete:issues.every(x=>informational.has(x)),issues,spacing,thickness:t?number(t,'00180050'):null};
  }

  // Dimension Index Values (PS3.3 C.7.6.17) must agree with the values they index: per dimension the
  // index and the referenced value pair one to one, and an index on Image Position follows the
  // position order. A contradiction is reported; stored frames stay reachable but never "complete".
  function dimensionCheck(item,fg,stored,known){
    const dims=items(item,'00209222');
    if(!dims.length)return [];
    const found=[],issue=v=>{if(!found.includes(v))found.push(v);};
    const rows=stored.map(s=>{const fc=macro(fg,s.frame,'00209111');return fc?values(fc,'00209157').map(Number):[];});
    if(rows.some(r=>r.length!==dims.length||!r.every(n=>Number.isSafeInteger(n)&&n>=1)))return ['dimension-index-invalid'];
    if(new Set(rows.map(r=>r.join(','))).size!==rows.length)issue('dimension-index-duplicate');
    dims.forEach((d,k)=>{
      const pointer=text(d,'00209165').toUpperCase(),group=text(d,'00209167').toUpperCase();
      const referenced=stored.map(s=>{
        if(pointer==='00200032')return known?String(Math.round(s.projection/POSITION_EPSILON)):null;
        const holder=group?macro(fg,s.frame,group):item;
        return holder&&values(holder,pointer).length?JSON.stringify(values(holder,pointer)):null;
      });
      if(referenced.some(r=>r===null)){issue('dimension-reference-missing');return;}
      const byIndex=new Map(),byValue=new Map();
      rows.forEach((r,i)=>{
        const index=r[k],value=referenced[i];
        if(byIndex.has(index)&&byIndex.get(index)!==value||byValue.has(value)&&byValue.get(value)!==index)issue('dimension-index-conflict');
        byIndex.set(index,value);byValue.set(value,index);
      });
      if(pointer==='00200032'&&known){
        const order=stored.map((s,i)=>[rows[i][k],s.projection]).sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
        const steps=order.slice(1).map((p,i)=>p-order[i]);
        if(!(steps.every(x=>x>0)||steps.every(x=>x<0)))issue('dimension-index-conflict');
      }
    });
    return found;
  }

  // Display coverage counts only frames the renderer confirmed; a frame outside the index never counts.
  function createCoverage(index){
    const valid=new Set(index.entries.map(e=>e.sop+'#'+e.frame)),seen=new Set();
    return {
      mark(ref){const key=ref&&ref.sop+'#'+ref.frame;if(!valid.has(key))return false;const before=seen.size;seen.add(key);return seen.size!==before;},
      snapshot(){return {total:index.total,seen:seen.size,complete:index.complete&&valid.size===index.total&&seen.size===index.total};},
    };
  }

  function patientOf(item){return {id:text(item,'00100020'),issuer:text(item,'00100021'),birthDate:text(item,'00100030')};}
  function samePatient(a,b){
    if(!a||!b||!a.id||a.id!==b.id||a.issuer!==b.issuer)return false;
    return !(a.birthDate&&b.birthDate&&a.birthDate!==b.birthDate);
  }
  const isoDate=v=>/^\d{8}$/.test(v)?v.slice(0,4)+'-'+v.slice(4,6)+'-'+v.slice(6,8):null;

  function study(input){
    const out={uid:input&&input.uid,role:input&&input.role,institution:input&&input.institution,date:null,patient:null,objects:[],issues:[]};
    const list=Array.isArray(input&&input.instances)?input.instances:null;
    if(!uid(out.uid)||!ROLES.includes(out.role)||typeof out.institution!=='string'||!out.institution||!list||!list.length||list.length>MAX_INSTANCES){out.issues.push('study-invalid');return out;}
    const patients=new Map(),dates=new Set(),sops=new Set();
    for(const item of list){
      const c=classify(item);
      if(c.study!==out.uid)c.issues.push('wrong-study');
      if(sops.has(c.sop))c.issues.push('duplicate-object');
      sops.add(c.sop);
      if(c.issues.includes('wrong-study')||c.issues.includes('duplicate-object')){c.status='unverified';c.standard=false;}
      const p=patientOf(item);patients.set(JSON.stringify(p),p);dates.add(text(item,'00080020'));
      out.objects.push({...c,date:isoDate(text(item,'00080020')),role:out.role,item});
    }
    if(patients.size!==1)out.issues.push('patient-mixed');else out.patient=[...patients.values()][0];
    if(dates.size===1)out.date=isoDate([...dates][0]);
    if(out.patient&&!out.patient.id)out.issues.push('patient-missing');
    return out;
  }

  const DBT_RANK={slices:1,slab:2,'mip-slab':3,'minip-slab':3,unspecified:4};
  // Current/prior x side x view x kind. A duplicate is never resolved by picking one; the only order
  // applied is slices before slabs inside DBT, and every alternative stays listed.
  function plan(manifest){
    const studies=Array.isArray(manifest&&manifest.studies)?manifest.studies:[];
    const current=studies.filter(s=>s&&s.role==='current'),prior=studies.filter(s=>s&&s.role==='prior');
    if(current.length!==1||prior.length>1||studies.length!==current.length+prior.length||typeof manifest.institution!=='string'||!manifest.institution)
      return {status:'refused',reason:'manifest-invalid',slots:{},objects:[],current:null,prior:null};
    const cur=study(current[0]);
    if(cur.issues.length||cur.institution!==manifest.institution)return {status:'refused',reason:cur.issues[0]||'institution-mismatch',slots:{},objects:cur.objects,current:cur,prior:null};
    let pri=prior.length?study(prior[0]):null,priorStatus=pri?'ok':'absent',priorReason=null;
    if(pri){
      if(pri.uid===cur.uid){priorStatus='refused';priorReason='prior-same-study';}
      else if(pri.issues.length){priorStatus='refused';priorReason=pri.issues.includes('patient-mixed')?'prior-patient-mixed':'prior-invalid';}
      else if(pri.institution!==cur.institution){priorStatus='refused';priorReason='prior-different-institution';}
      else if(!samePatient(cur.patient,pri.patient)){priorStatus='refused';priorReason='prior-different-patient';}
    }
    const usable=[cur,...(priorStatus==='ok'?[pri]:[])];
    const slots={};
    for(const role of ROLES)for(const side of SIDES)for(const v of STANDARD_VIEWS)for(const kind of KINDS){
      const key=[role,side,v,kind].join('|');
      if(role==='prior'&&priorStatus!=='ok'){slots[key]={key,status:priorStatus==='absent'?'missing':'refused',reason:priorReason};continue;}
      const s=usable.find(x=>x.role===role);
      const found=s.objects.filter(o=>o.standard&&o.kind===kind&&o.laterality===side&&o.view===v);
      let best=found;
      if(kind==='dbt'&&found.length>1){
        const rank=o=>DBT_RANK[o.sliceKind]??Infinity;
        const top=Math.min(...found.map(rank));best=found.filter(o=>rank(o)===top);
      }
      const alternatives=found.filter(o=>!best.includes(o));
      const partials=s.objects.filter(o=>o.partialSlot&&o.kind===kind&&o.laterality===side&&o.view===v);
      slots[key]=!best.length?(partials.length?{key,status:'partial',candidates:partials}:{key,status:'missing'})
        :best.length>1?{key,status:'ambiguous',candidates:best,alternatives,partials}:{key,status:'ready',object:best[0],alternatives,partials};
    }
    const objects=[cur,...(pri?[pri]:[])].flatMap(s=>s.objects.map(o=>({...o,use:s===pri&&priorStatus!=='ok'?'refused':o.standard?'slot':o.partialSlot?'partial':'other'})));
    return {status:'ok',institution:manifest.institution,current:{uid:cur.uid,date:cur.date,patient:cur.patient},
      prior:pri?{uid:pri.uid,date:pri.date,status:priorStatus,reason:priorReason,newer:!!(pri.date&&cur.date&&pri.date>cur.date)}:null,slots,objects};
  }

  const ARRANGEMENTS={
    current:[['current','R','CC'],['current','L','CC'],['current','R','MLO'],['current','L','MLO']],
    'compare-cc':[['current','R','CC'],['current','L','CC'],['prior','R','CC'],['prior','L','CC']],
    'compare-mlo':[['current','R','MLO'],['current','L','MLO'],['prior','R','MLO'],['prior','L','MLO']],
  };
  function arrangement(id){return ARRANGEMENTS[id]?ARRANGEMENTS[id].map(([role,side,v])=>({role,side,view:v})):null;}

  // Standard mammography display: right breast with the chest wall at the screen right, left breast at
  // the screen left; CC with lateral up, oblique/lateral views with superior up. A flip is derived only
  // from Patient Orientation / the frame's Image Orientation; without them the image is shown exactly as
  // stored and marked Unverified, never flipped by its screen position.
  const CC_FAMILY=new Set(['CC','XCCL','XCCM','FB']),VERTICAL_FAMILY=new Set(['MLO','ML','LM','LMO','SIO','ISO']);
  // Patient-space letters of a direction cosine (LPS: +x left, +y posterior, +z head), strongest first.
  function letters(vector){
    const names=[['R','L'],['A','P'],['F','H']];
    return [0,1,2].filter(i=>Math.abs(vector[i])>=0.2).sort((a,b)=>Math.abs(vector[b])-Math.abs(vector[a]))
      .map(i=>names[i][vector[i]>0?1:0]).join('');
  }
  // The flips for one display frame from one pair of direction letters.
  function decide(row,column,basis,c){
    const unverified=reason=>({status:'unverified',reason,row,column,basis,flipH:false,flipV:false});
    if(!/^[APRLHF]+$/.test(row)||!/^[APRLHF]+$/.test(column))return unverified('patient-orientation-missing');
    if(!SIDES.includes(c.laterality))return unverified('laterality-unknown');
    const has=(s,a,b)=>s.includes(a)!==s.includes(b);
    if(!has(row,'A','P'))return unverified('row-not-anterior-posterior');
    const flipH=c.laterality==='R'?row.includes('A'):row.includes('P');
    let flipV;
    // CC family: the column direction (downwards) points medially when lateral is up.
    if(CC_FAMILY.has(c.view)){if(!has(column,'L','R'))return unverified('column-not-medial-lateral');flipV=column.includes(c.laterality);}
    else if(VERTICAL_FAMILY.has(c.view)){if(!has(column,'H','F'))return unverified('column-not-head-foot');flipV=column.includes('H');}
    else return unverified('view-unknown');
    return {status:'verified',row,column,basis,flipH,flipV};
  }
  // Orientation of the REQUESTED frame: Patient Orientation (one per object) and that frame's own
  // Image Orientation (per-frame or shared Plane Orientation). If both decide and disagree, the frame is
  // Unverified and shown as stored; one that cannot decide gives way to the one that can.
  function orientation(item,c,frame){
    const fg=groups(item),poRow=text(item,'00200020',0).toUpperCase(),poColumn=text(item,'00200020',1).toUpperCase();
    const plane=macro(fg,frame,'00209116'),iop=(plane?numbers(plane,'00200037',6):null)||numbers(item,'00200037',6);
    const fromPO=poRow||poColumn?decide(poRow,poColumn,'Patient Orientation',c):null;
    const fromIOP=iop?decide(letters(iop.slice(0,3)),letters(iop.slice(3,6)),'Image Orientation (Patient), frame '+frame,c):null;
    if(fromPO&&fromIOP&&fromPO.status==='verified'&&fromIOP.status==='verified'){
      if(fromPO.flipH!==fromIOP.flipH||fromPO.flipV!==fromIOP.flipV)
        return {status:'unverified',reason:'orientation-conflict',row:fromPO.row,column:fromPO.column,basis:fromPO.basis+' vs '+fromIOP.basis,flipH:false,flipV:false};
      return {...fromPO,basis:'Patient Orientation + '+fromIOP.basis};
    }
    if(fromPO&&fromPO.status==='verified')return fromPO;
    if(fromIOP&&fromIOP.status==='verified')return fromIOP;
    return fromPO||fromIOP||decide('','',null,c);
  }
  function displaySpec(item,frame=1){
    const c=classify(item),fg=groups(item),issues=[];
    const rows=number(item,'00280010'),columns=number(item,'00280011');
    const photometric=text(item,'00280004').toUpperCase(),shape=text(item,'20500020').toUpperCase();
    const pvt=macro(fg,frame,'00289145');
    const slope=(pvt?number(pvt,'00281053'):null)??number(item,'00281053')??1,intercept=(pvt?number(pvt,'00281052'):null)??number(item,'00281052')??0;
    const voiItem=macro(fg,frame,'00289132');
    let center=voiItem?number(voiItem,'00281050'):number(item,'00281050'),width=voiItem?number(voiItem,'00281051'):number(item,'00281051');
    let fn=((voiItem?text(voiItem,'00281056'):'')||text(item,'00281056')||'LINEAR').toUpperCase(),source=voiItem?'Frame VOI LUT':'Window Center/Width',status='verified';
    if(!['LINEAR','LINEAR_EXACT','SIGMOID'].includes(fn)){issues.push('voi-function-unknown');fn='LINEAR';status='unverified';}
    if(values(item,'00283010').length&&(center===null||width===null))issues.push('voi-lut-table-not-applied');
    if(center===null||width===null||!(width>0)){
      const bits=number(item,'00280101'),signed=number(item,'00280103')===1;
      if(!Number.isInteger(bits)||bits<1||bits>16){center=null;width=null;status='unverified';issues.push('voi-unknown');}
      else{const low=signed?-(2**(bits-1)):0,high=signed?2**(bits-1)-1:2**bits-1;const a=low*slope+intercept,b=high*slope+intercept;
        center=(a+b)/2;width=Math.abs(b-a)+1;source='Bits Stored range';fn='LINEAR';status='unverified';}
    }
    if(!['MONOCHROME1','MONOCHROME2'].includes(photometric))issues.push('photometric-not-monochrome');
    const invert=photometric==='MONOCHROME1';
    if(shape&&(shape==='INVERSE')!==invert)issues.push('presentation-lut-conflict');
    const spacing=numbers(item,'00280030',2),imager=numbers(item,'00181164',2),measures=macro(fg,frame,'00289110');
    const frameSpacing=measures?numbers(measures,'00280030',2):null;
    const pixel=frameSpacing?{row:frameSpacing[0],column:frameSpacing[1],basis:'Pixel Measures'}:spacing?{row:spacing[0],column:spacing[1],basis:'Pixel Spacing'}
      :imager?{row:imager[0],column:imager[1],basis:'Imager Pixel Spacing'}:null;
    return {rows:Number.isInteger(rows)&&rows>0?rows:null,columns:Number.isInteger(columns)&&columns>0?columns:null,
      orientation:orientation(item,c,frame),voi:{status:issues.some(x=>x.startsWith('voi'))?'unverified':status,center,width,fn,source},
      modality:{slope,intercept},invert,photometric,spacing:pixel,issues};
  }

  // Camera rules: Fit shows the whole acquired matrix; panning may bring any stored pixel to the centre.
  function fitScale(view,image){
    if(!(view&&view.width>0&&view.height>0&&image&&image.rows>0&&image.columns>0))return null;
    return Math.min(view.width/image.columns,view.height/image.rows);
  }
  function clampPan(pan,scale,image){
    const x=Number(pan&&pan.x)||0,y=Number(pan&&pan.y)||0,hx=image.columns*scale/2,hy=image.rows*scale/2;
    return {x:Math.max(-hx,Math.min(hx,x)),y:Math.max(-hy,Math.min(hy,y))};
  }

  // A ticket is current only while it is the latest request of its slot in the same mount
  // generation; returning to the same image (A -> B -> A) does not revive an older ticket.
  function createGate(){
    let generation=1,sequence=0,ended=false;const latest=new Map();
    return {
      begin(slot,key){const seq=++sequence;latest.set(slot,{seq,key});return {slot,key,seq,generation};},
      current(t){const now=t&&latest.get(t.slot);return !ended&&!!now&&t.generation===generation&&now.seq===t.seq;},
      reset(){generation++;latest.clear();},
      end(){ended=true;generation++;latest.clear();},
      get ended(){return ended;},
    };
  }
  function sameIdentity(a,b){
    const keys=['institution','subject','sequence'];
    return !!a&&!!b&&keys.every(k=>(typeof a[k]==='string'||Number.isSafeInteger(a[k]))&&a[k]!==''&&a[k]===b[k]);
  }

  const api={classify,contract,verifySources,frameIndex,createCoverage,plan,arrangement,displaySpec,fitScale,clampPan,createGate,sameIdentity,samePatient,
    KINDS:KINDS.slice(),SOP:{MG:SOP_MG,MG_PROCESSING:SOP_MG_PROCESSING,DBT:SOP_DBT}};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinMammographyModel=api;
})(globalThis);
