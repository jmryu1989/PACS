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
  function groups(item){return {shared:items(item,'52009229')[0]||null,perFrame:items(item,'52009230')};}
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

  const TOMO_BIOPSY=new Set(['PREFIRE','POSTFIRE','POSTBIOPSY','POSTMARKER']);
  const STEREO=new Set(['STEREO_SCOUT','STEREO_MINUS','STEREO_PLUS','PREFIRE_MINUS','PREFIRE_PLUS','POSTFIRE_MINUS','POSTFIRE_PLUS',
    'POSTBIOPSY_MINUS','POSTBIOPSY_PLUS','POSTBIOPSY','POSTMARKER_MINUS','POSTMARKER_PLUS','POSTMARKER']);
  const CONTRAST3=new Set(['PRE_CONTRAST','POST_CONTRAST']),CONTRAST4=new Set(['ADDITION','SUBTRACTION']);
  // Issues after which the object's kind is not trusted for display labels or automatic matching.
  const BLOCKING=new Set(['identity-invalid','laterality-conflict','laterality-invalid','view-conflict','view-multiple',
    'presentation-intent-conflict','generated-2d-on-tomosynthesis-object','generated-2d-value3-contradiction',
    'tomosynthesis-without-generated-2d','image-type-unknown','possible-legacy-generated-2d','mixed-frame-types']);
  // Older software marked its synthetic view only in free text or private tags. Such a hint never
  // confirms a kind, but it does stop the object from being treated as a confirmed conventional view.
  // "Tomosynthesis" itself is no such hint: a 2D exposure of a combo examination is described that way.
  const LEGACY_HINT=/\bc-?view\b|synthetic|synthesi[sz]ed|\bv-?preview\b|intelligent\s*2d|\bs-?view\b|insight\s*2d|generated\s*2d|2d\s*generated/i;

  function dbtKind(item,fg,frames){
    // Frames without a frame type item add nothing here; a frame count that does not match the
    // per-frame list is the frame index's finding, not a second kind.
    const seen=new Set();
    for(let k=1;k<=frames;k++){
      const t=macro(fg,k,'00189504');
      if(t)seen.add([tokens(t,'00089007').join('\\'),text(t,'00089206').toUpperCase(),text(t,'00089207').toUpperCase()].join('|'));
    }
    if(seen.size>1)return {sliceKind:null,issue:'mixed-frame-types',evidence:[...seen].map(s=>'Frame Type='+s)};
    let [,volumetric,technique]=(seen.size?[...seen][0]:'||').split('|');
    volumetric=volumetric||text(item,'00089206').toUpperCase();technique=technique||text(item,'00089207').toUpperCase();
    const evidence=['Volumetric Properties='+(volumetric||'(absent)'),'Volume Based Calculation Technique='+(technique||'(absent)')];
    if(technique==='MAX_IP'||technique==='MIN_IP')return {sliceKind:'mip-slab',technique,issue:null,evidence};
    if(technique==='TOMOSYNTHESIS'&&volumetric==='VOLUME')return {sliceKind:'slices',technique,issue:null,evidence};
    if(technique==='TOMOSYNTHESIS'&&volumetric==='SAMPLED')return {sliceKind:'sampled',technique,issue:null,evidence};
    return {sliceKind:'unspecified',technique:technique||null,issue:null,evidence};
  }

  function classify(item){
    const fg=groups(item),sopClass=text(item,'00080016'),type=tokens(item,'00080008');
    const frames=values(item,'00280008').length?number(item,'00280008'):1;
    const out={sop:text(item,'00080018'),series:text(item,'0020000E'),study:text(item,'0020000D'),sopClass,
      instanceNumber:number(item,'00200013'),seriesNumber:number(item,'00200011'),frames:Number.isInteger(frames)?frames:null,
      kind:null,status:'unverified',presentation:null,laterality:null,view:null,modifiers:[],partial:false,biopsy:null,
      sliceKind:null,sliceThickness:null,evidence:[],issues:[],standard:false};
    const issue=v=>{if(v&&!out.issues.includes(v))out.issues.push(v);};
    if(!uid(out.sop)||!uid(out.series)||!uid(out.study))issue('identity-invalid');
    const lat=laterality(item,fg);out.laterality=lat.value;out.evidence.push(...lat.evidence);issue(lat.issue);
    const v=view(item);out.view=v.value;out.modifiers=v.modifiers;out.evidence.push(...v.evidence);issue(v.issue);
    out.partial=text(item,'00281350').toUpperCase()==='YES';
    out.evidence.push('SOP Class='+sopClass,'Image Type='+type.join('\\'));
    if(text(item,'00080060').toUpperCase()!=='MG'){out.kind='other';issue('modality-not-mg');}
    else if(sopClass===SOP_DBT){
      if(type.includes('GENERATED_2D')){out.kind=null;issue('generated-2d-on-tomosynthesis-object');}
      else{
        const d=dbtKind(item,fg,out.frames||0);out.evidence.push(...d.evidence);
        if(d.issue){issue(d.issue);}else{out.kind='dbt';out.sliceKind=d.sliceKind;out.status='verified';}
        const t=macro(fg,1,'00289110');out.sliceThickness=t?number(t,'00180050'):null;
      }
    }else if(sopClass===SOP_MG||sopClass===SOP_MG_PROCESSING){
      const v3=type[2]||'',v4=type[3]||'';
      if(v4==='GENERATED_2D'){
        if(v3==='TOMOSYNTHESIS'||TOMO_BIOPSY.has(v3)){out.kind='generated2d';out.status='verified';out.biopsy=v3==='TOMOSYNTHESIS'?null:v3;}
        else issue('generated-2d-value3-contradiction');
      }else if(CONTRAST3.has(v3)||CONTRAST4.has(v4)){out.kind='other';issue('contrast-enhanced-not-supported');}
      else if(v3==='TOMOSYNTHESIS')issue('tomosynthesis-without-generated-2d');
      else if(v3==='TOMO_PROJ'||v3==='TOMO_SCOUT'){out.kind='other';issue('tomosynthesis-projection');}
      else if(STEREO.has(v3)||TOMO_BIOPSY.has(v3)){out.kind='other';issue('biopsy-image');}
      else if(v3||v4)issue('image-type-unknown');
      else if(['0008103E','00181030','00082111'].some(tag=>LEGACY_HINT.test(text(item,tag))))issue('possible-legacy-generated-2d');
      // Value 1 DERIVED describes pixel processing, not synthesis; with no Value 3/4 type this is a 2D exposure.
      else{out.kind='conventional';out.status='verified';}
      const intent=text(item,'00080068').toUpperCase();
      if(sopClass===SOP_MG_PROCESSING){out.presentation='processing';issue('for-processing-display-not-validated');}
      else{out.presentation='presentation';if(intent&&intent!=='FOR PRESENTATION')issue('presentation-intent-conflict');}
    }else{out.kind='other';issue('sop-class-not-mammography-image');}
    if(out.issues.some(x=>BLOCKING.has(x)))out.status='unverified';
    out.standard=out.status==='verified'&&KINDS.includes(out.kind)&&out.presentation!=='processing'&&SIDES.includes(out.laterality)&&
      STANDARD_VIEWS.includes(out.view)&&!out.modifiers.length&&!out.partial;
    return out;
  }

  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  // Every stored frame keeps its own (SOP, 1-based frame) identity; display order, total and position
  // are reported separately and an inconsistency is reported, never smoothed over.
  function frameIndex(item){
    const sop=text(item,'00080018'),fg=groups(item),declared=values(item,'00280008').length?number(item,'00280008'):1;
    const issues=[],issue=v=>{if(!issues.includes(v))issues.push(v);};
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
    const origin=known?order[0].projection:null,sign=known&&order.length>1&&order[order.length-1].projection<order[0].projection?-1:1;
    const entries=order.map((s,i)=>({sop,frame:s.frame,index:i+1,total:declared,
      position:known?{status:'verified',offset:(s.projection-origin)*sign||0,projection:s.projection,unit:'mm',basis:'Plane Position · Plane Orientation'}
        :{status:'unverified',reason:issues.find(x=>/orientation|position|per-frame/.test(x))||'position-missing'}}));
    const t=macro(fg,1,'00289110');
    const informational=new Set(['reordered-by-position']);
    return {sop,total:declared,entries,complete:issues.every(x=>informational.has(x)),issues,spacing,thickness:t?number(t,'00180050'):null};
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

  const DBT_RANK={slices:1,sampled:2,'mip-slab':3,unspecified:4};
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
      if(kind==='dbt'&&found.length>1){const top=Math.min(...found.map(o=>DBT_RANK[o.sliceKind]));best=found.filter(o=>DBT_RANK[o.sliceKind]===top);}
      const alternatives=found.filter(o=>!best.includes(o));
      slots[key]=!found.length?{key,status:'missing'}:best.length>1?{key,status:'ambiguous',candidates:best,alternatives}:{key,status:'ready',object:best[0],alternatives};
    }
    const objects=[cur,...(pri?[pri]:[])].flatMap(s=>s.objects.map(o=>({...o,use:s===pri&&priorStatus!=='ok'?'refused':o.standard?'slot':'other'})));
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
  // from Patient Orientation; without it the image is shown exactly as stored and marked Unverified.
  const CC_FAMILY=new Set(['CC','XCCL','XCCM','FB']),VERTICAL_FAMILY=new Set(['MLO','ML','LM','LMO','SIO','ISO']);
  // Patient-space letters of a direction cosine (LPS: +x left, +y posterior, +z head), strongest first.
  function letters(vector){
    const names=[['R','L'],['A','P'],['F','H']];
    return [0,1,2].filter(i=>Math.abs(vector[i])>=0.2).sort((a,b)=>Math.abs(vector[b])-Math.abs(vector[a]))
      .map(i=>names[i][vector[i]>0?1:0]).join('');
  }
  function orientationLetters(item,fg){
    const row=text(item,'00200020',0).toUpperCase(),column=text(item,'00200020',1).toUpperCase();
    if(row||column)return {row,column,basis:'Patient Orientation'};
    const o=macro(fg,1,'00209116'),iop=(o?numbers(o,'00200037',6):null)||numbers(item,'00200037',6);
    return iop?{row:letters(iop.slice(0,3)),column:letters(iop.slice(3,6)),basis:'Image Orientation (Patient)'}:{row:'',column:'',basis:null};
  }
  function orientation(item,c){
    const {row,column,basis}=orientationLetters(item,groups(item));
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
      orientation:orientation(item,c),voi:{status:issues.some(x=>x.startsWith('voi'))?'unverified':status,center,width,fn,source},
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

  const api={classify,frameIndex,createCoverage,plan,arrangement,displaySpec,fitScale,clampPan,createGate,sameIdentity,samePatient,
    KINDS:KINDS.slice(),SOP:{MG:SOP_MG,MG_PROCESSING:SOP_MG_PROCESSING,DBT:SOP_DBT}};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinMammographyModel=api;
})(globalThis);
