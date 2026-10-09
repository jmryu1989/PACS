/* E-MG viewer: current/prior mammography comparison inside one host element.
   Pixels reach the screen only through the injected viewport seam (the pinned OHIF renderer once
   wired); this module never decodes, synthesizes or projects an image. What it reports through
   `events` is the seam the EMR-E access contract will bind to: requested, transferred and actually
   rendered frames are separate records, and none of them is a legal access record by itself.

   mount({host, source, viewport, identity, events}) -> {dispose()}
     source.manifest  {institution, studies:[{uid, role:'current'|'prior', institution, instances:[DICOM JSON]}]}
     source.load(ref, {signal, purpose}) -> image {sop, frame, rows, columns, ...renderer data}
       ref = {study, series, sop, frame}; a permission or session loss rejects with error.refusal
       'denied' | 'ended', an abort with AbortError; anything else is treated as a passing delay.
     viewport.attach(element, {slot}) -> {render(image, display, {current}) -> {rendered, sop, frame} | {rendered:false, superseded:true}, detach()}
       The renderer calls current() immediately before it paints and paints nothing when it returns false:
       the latest navigation intent always wins, also against a render already on its way.
     identity {institution, subject, sequence, studies:[uid], check() -> {institution, subject, sequence}, onEnd(fn) -> unsubscribe}
     events {requested(record), loaded(record), displayed(record)} - all optional */
(function(root){
  'use strict';
  const KIND_LABEL={conventional:'Conventional',generated2d:'Synthetic 2D',dbt:'DBT',projection:'Projection'};
  const SLICE_LABEL={slices:'Slices',slab:'Slab','mip-slab':'MIP Slab','minip-slab':'MinIP Slab',unspecified:'Slices Unspecified'};
  const ROLE_LABEL={current:'Current',prior:'Prior'};
  const partialLabel=o=>'Partial '+(o.partialSections.length&&o.partialSections.every(s=>s!=='Unknown Section')?o.partialSections.join('/'):'View');
  const LAYOUTS=[['current','Current'],['compare-cc','Compare CC'],['compare-mlo','Compare MLO']];
  const CACHE_LIMIT=8,ZOOM_STEP=1.25,ZOOM_MAX=8;
  const MESSAGE={
    refused:'비교할 검사 정보를 확인하지 못해 영상을 표시하지 않았습니다.',
    priorRefused:'과거 검사의 환자 또는 기관 정보가 현재 검사와 달라 비교에 사용하지 않았습니다.',
    priorNewer:'선택된 과거 검사가 현재 검사보다 나중 날짜입니다. 날짜를 확인하세요.',
    layoutKept:'일부 영상을 불러오지 못해 배치를 바꾸지 않았습니다. 현재 화면은 그대로입니다. 다시 시도하세요.',
    layoutRestored:'영상을 화면에 표시하지 못해 이전 배치로 되돌렸습니다. 다시 시도하세요.',
    delayed:'영상을 불러오지 못했습니다. 현재 영상과 위치는 그대로입니다. Retry를 누르세요.',
    renderFailed:'영상을 화면에 표시하지 못했습니다. 현재 위치는 그대로입니다. Retry를 누르세요.',
    mismatch:'요청한 프레임과 다른 영상이 도착해 표시하지 않았습니다. Retry를 누르세요.',
    ended:'접근 권한 또는 계정이 바뀌어 영상을 닫았습니다. 뷰어를 다시 여세요.',
    ambiguous:'같은 위치의 영상이 여러 개입니다. 표시할 영상을 고르세요.',
    partial:'이 위치에는 부분 촬영(Partial View)만 있습니다. 표시할 영상을 고르세요.',
    unusable:'프레임 정보를 확인하지 못해 이 영상을 표시하지 않았습니다.',
  };
  // Why an object is not placed in a standard slot; every such object stays listed.
  const REASON={
    'view-missing':'촬영 방향 정보가 없습니다.','view-code-unknown':'확인되지 않은 촬영 방향 코드입니다.','view-conflict':'촬영 방향 정보가 서로 다릅니다.',
    'view-multiple':'촬영 방향이 여러 개로 기록돼 있습니다.','laterality-missing':'좌우 정보가 없습니다.','laterality-conflict':'좌우 정보가 서로 다릅니다.',
    'laterality-invalid':'좌우 정보를 확인하지 못했습니다.','modality-not-mg':'유방촬영 영상이 아닙니다.','sop-class-not-mammography-image':'유방촬영 영상 종류가 아닙니다.',
    'for-processing-display-not-validated':'처리 전(For Processing) 영상이라 판독 표시 대상이 아닙니다.','possible-legacy-generated-2d':'합성 2D일 수 있으나 표준 정보로 확인되지 않았습니다.',
    'generated-2d-value3-contradiction':'합성 2D 표시가 표준 규칙과 맞지 않습니다.','tomosynthesis-without-generated-2d':'영상 종류 표시가 표준 규칙과 맞지 않습니다.',
    'generated-2d-on-tomosynthesis-object':'영상 종류 표시가 표준 규칙과 맞지 않습니다.','image-type-unknown':'영상 종류를 확인하지 못했습니다.',
    'contrast-enhanced-not-supported':'조영 유방촬영은 이 비교 화면에서 지원하지 않습니다.','tomosynthesis-projection':'단층 투영 원본 영상입니다.',
    'biopsy-image':'생검 관련 영상입니다.','mixed-frame-types':'프레임 종류가 섞여 있습니다.','presentation-intent-conflict':'표시 용도 정보가 서로 다릅니다.',
    'identity-invalid':'영상 식별 정보를 확인하지 못했습니다.','wrong-study':'다른 검사의 영상입니다.','duplicate-object':'같은 영상이 두 번 들어 있습니다.',
    'frame-count-invalid':'프레임 수가 없거나 허용 범위를 벗어났습니다.','image-frame-type-conflict':'영상 종류(Image Type)와 프레임 종류(Frame Type)가 서로 다릅니다.',
    'frame-type-missing':'프레임 종류 정보가 없습니다.','partial-view-conflict':'부분 촬영 정보가 서로 달라 자동 배치하지 않았습니다.',
    'partial-section-code-missing':'부분 촬영 영역 정보가 없어 자동 배치하지 않았습니다.',
    'shared-functional-groups-invalid':'공통 프레임 정보의 구조를 확인하지 못했습니다.',
    'unsupported-device-profile':'검증된 장비 프로필이 아닌 합성 2D 표시입니다.','slice-or-slab-evidence-missing':'단면 두께와 위치로 단면·slab 여부를 확인하지 못했습니다.',
    'unmapped-image-type-extension':'확인되지 않은 영상 종류 값이 있습니다.','presentation-intent-missing':'표시 용도 정보가 없습니다.','image-type-missing':'영상 종류 정보가 없습니다.',
    'frame-summary-conflict':'영상 전체와 프레임의 계산 정보가 서로 다릅니다.','shared-and-per-frame-macro':'같은 정보가 공통·프레임별로 중복돼 있습니다.',
  };

  function mount(options){
    const model=root.KinMammographyModel||(typeof require==='function'&&typeof module==='object'?require('./mammography-model.js'):null);
    const {host,source,viewport,identity,events}=options||{};
    if(!model||!host||typeof host.append!=='function'||!source||typeof source.load!=='function'||!source.manifest||
      !viewport||typeof viewport.attach!=='function'||!identity)throw Error('유방영상 비교 화면을 시작할 입력이 부족합니다.');
    const doc=host.ownerDocument,bound={institution:identity.institution,subject:identity.subject,sequence:identity.sequence};
    const opened=Array.isArray(identity.studies)?identity.studies.slice():[];
    const plan=model.plan(source.manifest),gate=model.createGate(),cache=new Map(),prefetching=new Map(),memory=new Map(),controllers=new Set();
    let ended=false,disposed=false,cells=[],layout='current',kind=null,want={layout:'current',kind:null},active=null,busy=false,queued=null,cellSerial=0,unsubscribe=null;
    const choices=new Map();

    const el=(tag,attrs={},...children)=>{
      const e=doc.createElement(tag);
      for(const [k,v] of Object.entries(attrs)){if(v===null||v===undefined)continue;if(k==='text')e.textContent=v;else if(k==='style')e.style.cssText=v;else e.setAttribute(k,v);}
      e.append(...children);return e;
    };
    const section=el('section',{'aria-label':'Mammography',style:'display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:#000;color:#ddd;font:12px sans-serif'});
    const toolbar=el('div',{role:'toolbar','aria-label':'Mammography Tools',style:'display:flex;flex-wrap:wrap;gap:4px;padding:4px'});
    const status=el('p',{role:'status',style:'margin:0;padding:2px 4px;min-height:1.4em'});
    const gridHolder=el('div',{style:'flex:1;min-height:0;position:relative'});
    const others=el('details',{style:'padding:2px 4px'});
    section.append(toolbar,status,gridHolder,others);host.append(section);
    // Clicks build on the latest request, not on the last committed one, so Conventional then
    // Compare MLO in quick succession asks for conventional MLO.
    const layoutButtons=LAYOUTS.map(([id,label])=>{const b=el('button',{type:'button','aria-pressed':'false',text:label});b.dataset.layout=id;b.onclick=()=>request(id,want.kind);return b;});
    const kindButtons=model.KINDS.map(k=>{const b=el('button',{type:'button','aria-pressed':'false',text:KIND_LABEL[k]});b.dataset.kind=k;b.onclick=()=>request(want.layout,k);return b;});
    const fitButton=el('button',{type:'button',text:'Fit'}),pixelButton=el('button',{type:'button',text:'1:1'});
    fitButton.onclick=()=>camera(active,{mode:'fit',scale:null,pan:{x:0,y:0}});
    pixelButton.onclick=()=>camera(active,{mode:'pixel',scale:1,pan:{x:0,y:0}});
    toolbar.append(...layoutButtons,el('span',{style:'width:8px'}),...kindButtons,el('span',{style:'width:8px'}),fitButton,pixelButton);

    function emit(name,record){try{if(events&&typeof events[name]==='function')events[name](Object.freeze(record));}catch(_){}}
    function say(text){if(!disposed)status.textContent=text||'';}
    function live(){
      if(ended)return false;
      let now=null;try{now=typeof identity.check==='function'?identity.check():bound;}catch(_){now=null;}
      if(!model.sameIdentity(bound,now)){stop(MESSAGE.ended);return false;}
      return true;
    }
    const usable=cell=>!ended&&!cell.disposed;
    const refused=error=>error&&(error.refusal==='denied'||error.refusal==='ended');
    const aborted=error=>error&&error.name==='AbortError';
    const sameFrame=(image,entry)=>!!image&&image.sop===entry.sop&&image.frame===entry.frame;

    function stop(message){
      if(ended)return;
      ended=true;gate.end();
      for(const c of controllers)c.abort();controllers.clear();
      for(const cell of cells)retire(cell);cells=[];
      // Access ended: the images are removed from the screen, not merely frozen.
      gridHolder.replaceChildren();cache.clear();prefetching.clear();
      for(const b of toolbar.querySelectorAll('button'))b.disabled=true;
      try{unsubscribe&&unsubscribe();}catch(_){}
      say(message);
    }
    function retire(cell){
      if(cell.disposed)return;cell.disposed=true;
      if(cell.resize)cell.resize.disconnect();
      for(const c of cell.controllers){c.abort();controllers.delete(c);}
      try{cell.handle&&cell.handle.detach();}catch(_){}
    }
    function track(cell){const c=new AbortController();controllers.add(c);cell.controllers.add(c);return c;}
    function untrack(cell,c){controllers.delete(c);cell.controllers.delete(c);}

    function slotFor(spec,k){
      const slot=plan.slots[[spec.role,spec.side,spec.view,k].join('|')]||{status:'missing'};
      // Duplicates and partial-only slots are filled only by the doctor's explicit choice.
      if(slot.status!=='ambiguous'&&slot.status!=='partial')return {slot,object:slot.status==='ready'?slot.object:null};
      const chosen=slot.candidates.find(o=>o.sop===choices.get(slot.key));
      return {slot,object:chosen||null};
    }
    function draft(spec,k){
      const {slot,object}=slotFor(spec,k),id='cell-'+(++cellSerial);
      const cell={id,spec,kind:k,slot,object,index:null,coverage:null,position:1,intent:1,reported:null,image:null,failed:null,drawing:0,
        camera:{mode:'fit',scale:null,pan:{x:0,y:0}},controllers:new Set(),queue:Promise.resolve(),disposed:false,handle:null};
      if(object){
        cell.index=model.frameIndex(object.item);
        // An object without any reachable frame is never handed on: the cell says so and loads nothing.
        if(!cell.index.entries.length){cell.object=null;cell.slot={...slot,status:'unusable'};cell.index=null;build(cell);return cell;}
        cell.coverage=model.createCoverage(cell.index);
        const kept=memory.get(object.sop);
        if(kept){cell.position=Math.min(kept.position,cell.index.entries.length)||1;cell.intent=cell.position;cell.camera={...kept.camera,pan:{...kept.camera.pan}};}
      }
      build(cell);return cell;
    }
    function build(cell){
      const s=cell.spec,name=ROLE_LABEL[s.role]+' '+s.side+' '+s.view;
      cell.label=el('div',{style:'padding:2px 4px;flex-shrink:0;white-space:normal;overflow-wrap:anywhere;background:#111'});
      cell.view=el('div',{style:'flex:1;min-height:0;position:relative;overflow:hidden;touch-action:none'});
      cell.note=el('div',{style:'padding:2px 4px;min-height:1.2em;flex-shrink:0;overflow-wrap:anywhere'});
      cell.element=el('div',{role:'group','aria-label':name,tabindex:'0',style:'display:flex;flex-direction:column;min-width:0;min-height:0;border:1px solid #333;outline:none;background:#000'},cell.label,cell.view,cell.note);
      cell.element.addEventListener('focus',()=>activate(cell));
      cell.element.addEventListener('pointerdown',()=>activate(cell));
      cell.element.addEventListener('keydown',event=>key(cell,event));
      cell.view.addEventListener('wheel',event=>wheel(cell,event),{passive:false});
      cell.view.addEventListener('pointerdown',event=>drag(cell,event));
      if(cell.slot.status==='unusable')cell.note.textContent=MESSAGE.unusable;
      if((cell.slot.status==='ambiguous'||cell.slot.status==='partial')&&!cell.object){
        cell.note.textContent=cell.slot.status==='partial'?MESSAGE.partial:MESSAGE.ambiguous;
        cell.slot.candidates.forEach((o,i)=>{
          const name=o.partial?partialLabel(o):o.instanceNumber!==null?'Img '+o.instanceNumber:'Image '+(i+1);
          const b=el('button',{type:'button',title:o.sop,text:'Use '+name});
          b.onclick=()=>{choices.set(cell.slot.key,o.sop);replace(cell);};cell.note.append(' ',b);
        });
      }
      relabel(cell);
    }
    function relabel(cell){
      if(cell.disposed)return;
      const s=cell.spec,study=s.role==='current'?plan.current:plan.prior&&plan.prior.status==='ok'?plan.prior:null;
      // A refused or absent prior shows no date: its date says nothing about this patient.
      const parts=[ROLE_LABEL[s.role],...(study?[study.date||'Date Unverified']:[]),s.side+' '+s.view,KIND_LABEL[cell.kind]];
      if(cell.slot.status==='refused')parts.push('Refused');
      else if(cell.slot.status==='missing')parts.push('Missing');
      else if(cell.slot.status==='unusable')parts.push('Frames Unverified');
      else if(!cell.object)parts.push((cell.slot.status==='partial'?'Partial Only (':'Ambiguous (')+cell.slot.candidates.length+')');
      else{
        const o=cell.object,entry=cell.index.entries[cell.position-1];
        if(o.partial)parts.push(partialLabel(o));
        if(o.instanceNumber!==null)parts.push('Img '+o.instanceNumber);
        if(cell.slot.status==='ambiguous')parts.push('Chosen of '+cell.slot.candidates.length);
        if(o.kind==='dbt'){
          parts.push(SLICE_LABEL[o.sliceKind]+(o.sliceThickness?' '+o.sliceThickness+' mm':''));
          parts.push('Slice '+cell.position+' / '+cell.index.total);
          parts.push(entry&&entry.position.status==='verified'?'Pos '+entry.position.offset.toFixed(1)+' mm':'Pos Unverified');
          const c=cell.coverage.snapshot();parts.push('Seen '+c.seen+' / '+c.total);
        }
        if(!cell.index.complete)parts.push('Frames Unverified');
        const spec=model.displaySpec(o.item,entry?entry.frame:1);
        if(spec.orientation.status!=='verified')parts.push('Orientation Unverified');
        if(spec.voi.status!=='verified')parts.push('VOI Unverified');
        if(cell.slot.alternatives&&cell.slot.alternatives.length)parts.push('+'+cell.slot.alternatives.length+' Alt');
        if(cell.slot.partials&&cell.slot.partials.length)parts.push('+'+cell.slot.partials.length+' Partial');
      }
      cell.label.textContent=parts.join(' · ');
      cell.label.title=cell.object?cell.object.sop:'';
    }
    function activate(cell){
      if(!usable(cell))return;active=cell;
      for(const c of cells)c.element.style.borderColor=c===cell?'#4a90d9':'#333';
      for(const c of cells)c.element.setAttribute('aria-current',c===cell?'true':'false');
    }
    function record(cell,entry,purpose){
      const o=cell.object;
      return {role:cell.spec.role,side:cell.spec.side,view:cell.spec.view,kind:cell.kind,study:o.study,series:o.series,sop:entry.sop,
        frame:entry.frame,index:entry.index,total:entry.total,purpose:purpose||null};
    }

    async function load(cell,entry,purpose,signal){
      emit('requested',record(cell,entry,purpose));
      const image=await source.load({study:cell.object.study,series:cell.object.series,sop:entry.sop,frame:entry.frame},{signal,purpose});
      const spec=model.displaySpec(cell.object.item,entry.frame);
      if(!sameFrame(image,entry)||image.rows!==spec.rows||image.columns!==spec.columns){const e=Error(MESSAGE.mismatch);e.name='KinFrameMismatch';throw e;}
      emit('loaded',record(cell,entry,purpose));
      return image;
    }
    function remember(key,image){if(ended)return;cache.delete(key);cache.set(key,image);while(cache.size>CACHE_LIMIT)cache.delete(cache.keys().next().value);}
    async function obtain(cell,entry,signal){
      const key=entry.sop+'#'+entry.frame;
      if(cache.has(key)){const image=cache.get(key);remember(key,image);return image;}
      // A neighbour already being prefetched is awaited rather than transferred twice.
      if(prefetching.has(key)){const image=await prefetching.get(key);if(image)return image;}
      const image=await load(cell,entry,'display',signal);remember(key,image);return image;
    }
    function display(cell,image,entry){
      const spec=model.displaySpec(cell.object.item,entry.frame),size={rows:spec.rows,columns:spec.columns};
      const box={width:cell.view.clientWidth,height:cell.view.clientHeight},fit=model.fitScale(box,size)||1;
      const scale=cell.camera.mode==='fit'?fit:cell.camera.mode==='pixel'?1:cell.camera.scale;
      const pan=cell.camera.mode==='fit'?{x:0,y:0}:model.clampPan(cell.camera.pan,scale,size);
      cell.camera.pan=pan;
      return {rows:spec.rows,columns:spec.columns,flipH:spec.orientation.flipH,flipV:spec.orientation.flipV,invert:spec.invert,
        voi:{center:spec.voi.center,width:spec.voi.width,fn:spec.voi.fn},modality:{...spec.modality},scale,pan:{...pan},
        width:box.width,height:box.height};
    }
    // This is the only paint gate. Requests contain an opening/slot/generation/frame ticket, never
    // a captured displayed image. Camera, recovery and resize requests resolve the latest target here.
    // Loading may overlap, but visible renders are serial and validate again at paint and receipt.
    function paintTicket(cell){
      const entry=cell.index.entries[cell.intent-1];
      return {...gate.begin(cell.id,entry.sop+'#'+entry.frame),opening:bound};
    }
    function requestPaint(cell,ticket){
      cell.pending=paint(cell,ticket);
      return cell.pending;
    }
    function paintFailure(cell,target,message,recovery){
      // A failed recovery keeps Retry and never starts another recovery, even without ResizeObserver.
      if(recovery)return 'failed';
      cell.failed=target;
      // Relative navigation resumes at the image on screen; Retry alone remembers the failed target.
      cell.intent=cell.position;
      cell.note.textContent=message;cell.note.append(' ',retry(cell));
      if(cell.image)requestPaint(cell,{...paintTicket(cell),recovery:true});
      return 'failed';
    }
    async function paint(cell,ticket){
      const latest=()=>usable(cell)&&gate.current(ticket)&&ticket.opening===bound&&
        ticket.key===cell.index.entries[cell.intent-1].sop+'#'+cell.index.entries[cell.intent-1].frame&&live();
      if(!latest())return 'superseded';
      const wanted=cell.index.entries[cell.intent-1];
      if(!ticket.recovery&&(!cell.supply||cell.supply.key!==ticket.key)){
        const c=track(cell);c.display=true;
        const supply={key:ticket.key,promise:obtain(cell,wanted,c.signal).finally(()=>untrack(cell,c))};
        cell.supply=supply;
      }
      const supply=cell.supply;
      let image;
      // The last confirmed image remains available even if the transfer cache has evicted it.
      try{image=ticket.recovery?cell.image:await supply.promise;}
      catch(error){
        if(cell.supply===supply)cell.supply=null;
        if(!latest())return 'superseded';
        if(refused(error)){stop(MESSAGE.ended);return 'superseded';}
        return paintFailure(cell,cell.intent,error&&error.name==='KinFrameMismatch'?MESSAGE.mismatch:MESSAGE.delayed,ticket.recovery);
      }
      if(!latest())return 'superseded';
      cell.drawing++;
      const run=cell.queue.then(async()=>{
        if(!latest())return 'superseded';
        const entry=cell.index.entries[cell.intent-1];
        if(!sameFrame(image,entry))return 'superseded';
        let result=null;
        try{result=await cell.handle.render(image,display(cell,image,entry),{current:latest});}catch(_){result=null;}
        if(!usable(cell)||!live())return 'superseded';
        const painted=!!result&&!result.superseded&&result.rendered===true&&result.sop===entry.sop&&result.frame===entry.frame;
        const current=latest();
        if(!current)return 'superseded';
        if(!painted){
          return paintFailure(cell,entry.index,MESSAGE.renderFailed,ticket.recovery);
        }
        // No external observer or await separates this validation from the visible state/coverage commit.
        cell.position=entry.index;cell.image=image;
        const fresh=!cell.reported||cell.reported.sop!==entry.sop||cell.reported.frame!==entry.frame;
        if(!ticket.recovery&&cell.failed===entry.index)cell.failed=null;
        if(cell.failed===null)cell.note.textContent='';
        memory.set(cell.object.sop,{position:cell.position,camera:{...cell.camera,pan:{...cell.camera.pan}}});
        if(fresh){cell.reported={sop:entry.sop,frame:entry.frame};cell.coverage.mark(entry);}
        relabel(cell);
        if(fresh&&latest())emit('displayed',record(cell,entry,'display'));
        if(fresh&&latest())prefetch(cell);
        return 'painted';
      }).finally(()=>{cell.drawing--;});
      cell.queue=run.catch(()=>'failed');
      return run;
    }
    function retry(cell){const b=el('button',{type:'button',text:'Retry'});b.onclick=()=>go(cell,cell.failed||cell.position);return b;}
    function prefetch(cell){
      if(!usable(cell)||cell.index.entries.length<2)return;
      for(const step of [1,-1]){
        const entry=cell.index.entries[cell.position-1+step],key=entry&&entry.sop+'#'+entry.frame;
        if(!entry||cache.has(key)||prefetching.has(key))continue;
        const c=track(cell);
        // A refused prefetch means access ended as surely as a refused display request.
        const pending=load(cell,entry,'prefetch',c.signal).then(image=>{if(usable(cell))remember(key,image);return image;},
          error=>{if(refused(error)&&usable(cell))stop(MESSAGE.ended);return null;})
          .finally(()=>{untrack(cell,c);prefetching.delete(key);});
        prefetching.set(key,pending);
      }
    }
    async function go(cell,target){
      if(!cell||!cell.object||!usable(cell)||!live())return;
      const total=cell.index.entries.length;target=Math.max(1,Math.min(total,target));
      // Every request, also one back to the slice already on screen, supersedes every older one.
      cell.intent=target;const ticket=paintTicket(cell);
      cell.failed=null;cell.note.textContent='';
      for(const c of cell.controllers)if(c.display){c.abort();untrack(cell,c);}
      cell.supply=null;
      // Frame equality alone cannot establish camera, display or viewport-size equality.
      return requestPaint(cell,ticket);
    }
    function key(cell,event){
      if(!cell.object||cell.index.entries.length<2)return;
      const moves={ArrowDown:1,PageDown:1,ArrowUp:-1,PageUp:-1};
      let target=null;
      // Steps build on the latest intent, so a burst of keys or wheel notches moves as far as asked.
      if(event.key in moves)target=cell.intent+moves[event.key];
      else if(event.key==='Home')target=1;else if(event.key==='End')target=cell.index.entries.length;
      if(target===null)return;
      event.preventDefault();go(cell,target);
    }
    function wheel(cell,event){
      if(!cell.object)return;
      event.preventDefault();
      if(event.ctrlKey){zoom(cell,event.deltaY<0?ZOOM_STEP:1/ZOOM_STEP);return;}
      if(cell.index.entries.length>1&&event.deltaY)go(cell,cell.intent+(event.deltaY>0?1:-1));
    }
    function scaleOf(cell){
      if(cell.camera.mode==='pixel')return 1;
      if(cell.camera.mode==='custom')return cell.camera.scale;
      const spec=model.displaySpec(cell.object.item,1);
      return model.fitScale({width:cell.view.clientWidth,height:cell.view.clientHeight},{rows:spec.rows,columns:spec.columns})||1;
    }
    function zoom(cell,factor){
      const base=scaleOf(cell),spec=model.displaySpec(cell.object.item,1);
      const floor=(model.fitScale({width:cell.view.clientWidth,height:cell.view.clientHeight},{rows:spec.rows,columns:spec.columns})||1)/4;
      camera(cell,{mode:'custom',scale:Math.max(floor,Math.min(ZOOM_MAX,base*factor)),pan:{...cell.camera.pan}});
    }
    function drag(cell,event){
      if(!cell.object||event.button!==0)return;
      const start={x:event.clientX,y:event.clientY},origin={...cell.camera.pan},scale=scaleOf(cell);
      let pending=false,dragging=false;
      const move=e=>{
        // A click that jitters a pixel or two is a click, not a pan that leaves Fit.
        if(!dragging&&Math.hypot(e.clientX-start.x,e.clientY-start.y)<3)return;
        dragging=true;
        const pan={x:origin.x+e.clientX-start.x,y:origin.y+e.clientY-start.y};
        cell.camera={mode:cell.camera.mode==='pixel'?'pixel':'custom',scale,pan};
        if(!pending){pending=true;Promise.resolve().then(()=>{pending=false;repaint(cell);});}
      };
      const up=()=>{doc.removeEventListener('pointermove',move);doc.removeEventListener('pointerup',up);};
      doc.addEventListener('pointermove',move);doc.addEventListener('pointerup',up);
    }
    function camera(cell,next){if(!cell||!cell.object||!usable(cell))return;cell.camera=next;repaint(cell);}
    function repaint(cell){
      if(!cell.object||!usable(cell)||!live())return;
      return requestPaint(cell,paintTicket(cell));
    }

    function grid(list){
      const g=el('div',{style:'position:absolute;inset:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:2px'});
      g.append(...list.map(c=>c.element));return g;
    }
    function attach(cell){
      if(!cell.object)return;
      cell.handle=viewport.attach(cell.view,{slot:{role:cell.spec.role,side:cell.spec.side,view:cell.spec.view,kind:cell.kind}});
      if(typeof root.ResizeObserver==='function'){
        let size=[cell.view.clientWidth,cell.view.clientHeight].join('|');
        cell.resize=new root.ResizeObserver(()=>{
          const next=[cell.view.clientWidth,cell.view.clientHeight].join('|');
          if(size!==next){size=next;if(cell.view.clientWidth&&cell.view.clientHeight)repaint(cell);}
        });
        cell.resize.observe(cell.view);
      }
    }
    function pressed(){
      for(const b of layoutButtons)b.setAttribute('aria-pressed',String(b.dataset.layout===layout));
      for(const b of kindButtons)b.setAttribute('aria-pressed',String(b.dataset.kind===kind));
    }
    function notice(){
      const lines=[];
      if(plan.prior&&plan.prior.status==='refused')lines.push(MESSAGE.priorRefused);
      if(plan.prior&&plan.prior.newer)lines.push(MESSAGE.priorNewer);
      return lines.join(' ');
    }
    function request(nextLayout,nextKind){
      if(ended||!live())return;
      want={layout:nextLayout,kind:nextKind};
      if(busy){queued=[nextLayout,nextKind];return;}
      apply(nextLayout,nextKind);
    }
    async function firstPaint(cell){
      if(!cell.object)return 'painted';
      for(;;){
        const pending=cell.pending,outcome=await pending;
        if(!usable(cell)||!live())return 'superseded';
        // Once established, the cell owns subsequent navigation failures, including during apply.
        if(cell.image)return 'painted';
        if(pending!==cell.pending)continue;
        return outcome;
      }
    }
    // A layout or kind change replaces the whole arrangement or nothing: every new image is
    // obtained first, and the current arrangement stays on screen if any of them cannot be.
    async function apply(nextLayout,nextKind){
      const specs=model.arrangement(nextLayout);if(!specs||!model.KINDS.includes(nextKind))return false;
      const ticket=gate.begin('layout',nextLayout+'|'+nextKind);
      const drafts=specs.map(spec=>draft(spec,nextKind));
      const firstImages=await Promise.all(drafts.map(async cell=>{
        if(!cell.object)return {ok:true,image:null};
        const entry=cell.index.entries[cell.position-1],c=track(cell);c.display=true;
        try{return {ok:true,image:await obtain(cell,entry,c.signal)};}catch(error){return {ok:false,error};}finally{untrack(cell,c);}
      }));
      const discard=()=>{for(const cell of drafts)retire(cell);};
      if(!gate.current(ticket)||!live()){discard();return false;}
      if(firstImages.some(r=>!r.ok&&refused(r.error))){discard();stop(MESSAGE.ended);return false;}
      const failed=firstImages.filter(r=>!r.ok);
      if(failed.length){discard();want={layout,kind};say(MESSAGE.layoutKept);return false;}
      busy=true;
      const previous=cells,previousGrid=gridHolder.firstElementChild,next=grid(drafts);
      if(previousGrid){previousGrid.hidden=true;previousGrid.style.display='none';}
      gridHolder.append(next);
      for(const cell of drafts)attach(cell);
      for(const cell of drafts)if(cell.object)go(cell,cell.intent);
      // Superseded first paints follow their replacements until each cell has established an image.
      const shown=await Promise.all(drafts.map(firstPaint));
      busy=false;
      if(ended||!live()){discard();return false;}
      if(shown.some(outcome=>outcome!=='painted')){
        discard();next.remove();
        if(previousGrid){previousGrid.hidden=false;previousGrid.style.display='grid';for(const cell of previous)repaint(cell);}
        if(!queued)want={layout,kind};
        say(MESSAGE.layoutRestored);drainQueue();return false;
      }
      for(const cell of previous)retire(cell);
      if(previousGrid)previousGrid.remove();
      cells=drafts;layout=nextLayout;kind=nextKind;pressed();activate(cells.find(c=>c.object)||cells[0]);
      say(notice());drainQueue();return true;
    }
    function drainQueue(){if(queued&&!ended){const [l,k]=queued;queued=null;apply(l,k);}}
    async function replace(cell){
      // Choosing among duplicates changes one cell only; the rest of the arrangement is untouched.
      if(!usable(cell)||!live())return;
      const fresh=draft(cell.spec,cell.kind),i=cells.indexOf(cell);if(i<0){retire(fresh);return;}
      cell.element.replaceWith(fresh.element);retire(cell);cells[i]=fresh;attach(fresh);activate(fresh);
      if(fresh.object)await go(fresh,fresh.position);
    }

    function listOthers(){
      const rows=plan.objects.filter(o=>o.use!=='slot');
      others.replaceChildren(el('summary',{text:'Other Images ('+rows.length+')'}));
      const list=el('ul',{style:'margin:2px 0;padding-left:16px'});
      for(const o of rows){
        const why=o.use==='refused'?MESSAGE.priorRefused:(o.issues.map(x=>REASON[x]).find(Boolean)||
          (o.modifiers.length?o.modifiers.join(', ')+' 추가 촬영입니다.':o.partial?'부분 촬영(Partial View)입니다.':o.laterality==='B'?'양측(B) 영상입니다.':'표준 4방향 영상이 아닙니다.'));
        const date=o.use==='refused'?[]:[o.date||'Date Unverified'];
        const partialStatus=o.partialState==='conflict'?'Partial View Conflict':o.issues.includes('partial-section-code-missing')?'Partial View Unverified':null;
        list.append(el('li',{text:[ROLE_LABEL[o.role],...date,(o.laterality||'?')+' '+(o.view||'?'),KIND_LABEL[o.kind]||'Unverified',...(partialStatus?[partialStatus]:[])].join(' · ')+' — '+why}));
      }
      others.append(list);
    }

    // Start: the opening must be the one the manifest describes, for the bound account.
    const manifestStudies=(source.manifest.studies||[]).map(s=>s&&s.uid);
    if(plan.status!=='ok'||source.manifest.institution!==bound.institution||!model.sameIdentity(bound,bound)||
      !manifestStudies.every(u=>opened.includes(u))){
      ended=true;gate.end();for(const b of toolbar.querySelectorAll('button'))b.disabled=true;say(MESSAGE.refused);
    }else{
      try{unsubscribe=typeof identity.onEnd==='function'?identity.onEnd(()=>stop(MESSAGE.ended)):null;}catch(_){unsubscribe=null;}
      listOthers();
      const has=k=>model.arrangement('current').some(spec=>{const s=plan.slots[[spec.role,spec.side,spec.view,k].join('|')];return s&&(s.status==='ready'||s.status==='ambiguous');});
      kind=model.KINDS.find(has)||'conventional';want={layout,kind};
      cells=model.arrangement(layout).map(spec=>draft(spec,kind));
      gridHolder.append(grid(cells));
      for(const cell of cells)attach(cell);
      pressed();activate(cells.find(c=>c.object)||cells[0]);say(notice());
      for(const cell of cells)if(cell.object)go(cell,cell.position);
    }

    function dispose(){
      if(disposed)return;
      stop('');disposed=true;section.remove();
    }
    return {dispose};
  }
  const api={mount};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinViewerMammography=api;
})(globalThis);
