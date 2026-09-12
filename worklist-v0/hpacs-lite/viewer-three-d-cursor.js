/* REQ-D-3D-CURSOR controller. Explicit pick-point mode over classic CT/MR stack panes.
   It reads viewport state and moves slices only; it never creates, edits or deletes an
   annotation, never activates a tool and never writes storage. Every node and listener is
   owned by this instance, so cleanup can never touch another mounted controller.
   The pinned renderer cannot cancel a request it has started, so an unsettled request
   quarantines that pane instead of being raced by a second one. */
(function(root){
  'use strict';
  const model=typeof require==='function'&&typeof module==='object'?require('./three-d-cursor-model.js'):root.KinThreeDCursorModel;
  const TEXT={'identity-study':'같은 검사가 아닙니다.','identity-patient':'같은 원본 환자가 아닙니다.','identity-frame':'같은 기준 좌표계가 아닙니다.',
    'identity-missing':'원본 식별을 확인하지 못했습니다.','out-of-image':'해당 영상 범위 밖입니다.','out-of-coverage':'해당 시리즈 촬영 범위 밖입니다.',
    'ambiguous-slice':'가장 가까운 영상을 하나로 정할 수 없습니다.','pick-off-plane':'현재 표시된 영상 평면의 점이 아닙니다.',
    'slice-distance-exceeded':'선택점이 이 시리즈의 어느 단면에서도 멀리 있습니다.',
    'source-not-rendered':'현재 표시된 영상을 확인하지 못했습니다.','target-not-confirmed':'대상 영상이 표시된 것을 확인하지 못했습니다.',
    'source-replaced':'영상이 교체되어 취소했습니다.','navigation-failed':'대상 영상으로 이동하지 못했습니다.','user-interrupt':'다른 조작으로 취소했습니다.',
    'context-changed':'세션 또는 도구가 바뀌어 취소했습니다.','pick-slice-unknown':'현재 영상을 원본 목록에서 찾지 못했습니다.',
    'point-outside-viewport':'영상 표시 영역 안을 클릭하세요.','navigation-unsettled':'대상 영상 요청이 끝나지 않아 이 화면을 보류했습니다.',
    'stopped':'3D Cursor를 종료했습니다.','internal':'3D Cursor를 사용할 수 없습니다.','abandoned':'',
    'teardown-unsettled':'끝나지 않은 영상 요청이 있어 3D Cursor를 닫았습니다. 이 창에서는 다시 켤 수 없습니다.',
    'pane-ambiguous':'같은 화면에 두 개가 연결되어 있어 사용할 수 없습니다.','pane-anchor':'영상 표시 요소를 확인하지 못했습니다.',
    'inactive':'3D Cursor가 켜져 있지 않습니다.','point-nonfinite':'선택점 좌표를 확인하지 못했습니다.',
    'off':'3D Cursor를 껐습니다.','no-eligible-pane':'대상 시리즈가 없어 3D Cursor를 켜지 못했습니다.',
    /* One image's own attributes are out of spec. This is the only geometry statement that calls
       an image defective, and it never describes the angle between two series: a series that is
       oblique to another one is ordinary DICOM and produces no reason code at all. */
    'geometry-axes-invalid':'이 영상의 방향 정보가 DICOM 규정을 벗어났습니다.',
    'geometry-missing':'이 영상의 위치·방향 정보를 읽지 못했습니다.','geometry-spacing':'이 영상의 화소 간격 정보를 읽지 못했습니다.',
    'geometry-extent':'이 영상의 행·열 크기 정보를 읽지 못했습니다.',
    /* Unsupported series shapes are a limit of this feature, not a fault of the data: the wording
       says what is not supported and never calls the series abnormal or the DICOM wrong. */
    'stack-too-short':'현재 지원하지 않는 시리즈 구성입니다(단면이 2장 미만).',
    'stack-too-long':'현재 지원하지 않는 시리즈 구성입니다(단면 수가 한도를 넘음).',
    'stack-identity-mixed':'현재 지원하지 않는 시리즈 구성입니다(한 화면에 서로 다른 시리즈).',
    'stack-orientation-mixed':'현재 지원하지 않는 시리즈 구성입니다(한 화면 안에서 단면 방향이 섞임).',
    'stack-spacing-mixed':'현재 지원하지 않는 시리즈 구성입니다(화소 간격이 섞임).',
    'stack-extent-mixed':'현재 지원하지 않는 시리즈 구성입니다(영상 크기가 섞임).',
    'stack-duplicate-sop':'현재 지원하지 않는 시리즈 구성입니다(같은 영상이 중복).',
    'stack-duplicate-position':'현재 지원하지 않는 시리즈 구성입니다(같은 위치의 단면이 중복).',
    'stack-spacing-nonuniform':'현재 지원하지 않는 시리즈 구성입니다(단면 간격이 일정하지 않음).',
    'restored':'원래 영상으로 되돌렸습니다.','restore-unconfirmed':'원래 영상으로 되돌린 것을 확인하지 못했습니다.',
    'restore-failed':'원래 영상으로 되돌리지 못했습니다.','restore-skipped-user':'사용자가 옮긴 화면이라 되돌리지 않았습니다.',
    'restore-skipped-replaced':'영상이 교체되어 되돌리지 않았습니다.','restore-skipped-unbound':'화면이 사라져 되돌리지 않았습니다.',
    'restore-blocked-unsettled':'끝나지 않은 영상 요청이 있어 되돌리지 않았습니다.',
    'restore-blocked-abandoned':'세션이 끝나 되돌리지 않았습니다.','restore-blocked-stopped':'3D Cursor를 종료해 되돌리지 않았습니다.'};
  // Presence in the table decides, not truthiness: 'abandoned' is an entry whose text is
  // deliberately empty, and a fallback sentence there would speak for a run that must say nothing.
  const message=reason=>Object.prototype.hasOwnProperty.call(TEXT,reason)?TEXT[reason]:'3D Cursor를 사용할 수 없습니다.';
  // Every reason code the controller can emit must be in the table above; a code that is not
  // would reach the reader as the bare 'unavailable' sentence, which explains nothing.
  const reasons=()=>Object.keys(TEXT);
  /* The one sentence the reader may see about |n·(p−o)|. It is the distance from the picked
     point to the plane of the slice being shown, not an accuracy, an error or a precision:
     saying '±' or '오차' here would describe the computation instead of the geometry. */
  const distanceText=value=>'선택점에서 단면까지 '+Number(value).toFixed(1)+' mm';
  let mounted=0;

  function mount(options){
    const doc=options.document||root.document,panesOf=options.panes,metaOf=options.meta,context=options.context;
    const tick=options.tick||(()=>new Promise(resolve=>setTimeout(resolve,16)));
    const limit=(value,fallback)=>Number.isInteger(value)&&value>=0?value:fallback;
    const confirmAttempts=limit(options.confirmAttempts,20),navigationAttempts=limit(options.navigationAttempts,625),
      drainAttempts=limit(options.drainAttempts,625);
    const snapTolerance=typeof options.snapTolerance==='number'?options.snapTolerance:0.5;
    // Injected by the caller; the model's constant is the fallback so no call site carries a
    // millimetre literal of its own.
    const sliceDistanceLimit=typeof options.sliceDistanceLimit==='number'&&options.sliceDistanceLimit>=0
      ?options.sliceDistanceLimit:model.SLICE_DISTANCE_LIMIT_MM;
    const owned='kin3d-'+(++mounted);
    let enabled=false,stopped=false,run=0,session=0,poisoned=false,bound=new Map(),marks=new Map(),moved=new Map(),base=null,status='',
      source=null,busy=false,abort=null,active=null,teardown='idle';
    const nodes=new Map(),handlers=new Map(),revoked=new Set(),quarantine=new Map(),reports=new Map();

    /* The only thing the reader can see. hpacs-lite convention (viewer-image-text.js,
       viewer-display-scope.js): a <section id="kin-…"> with an English button label and a Korean
       <p role="status">. Every status string goes through note(), so a path that writes a reason
       and draws nothing cannot exist; the panel is built only when a host is given, so a mount
       without one keeps the headless shape the controller had before. */
    let panel=null,toggleNode=null,statusNode=null;
    /* A pane that could not be confirmed back on its own frame, or that was left holding a
       request nobody can withdraw, is not the same as a restored one and may not disappear from
       the screen just because the run that caused it has ended. The internal status string stays
       exactly what it was; the visible line carries the outstanding restorations as well. */
    function outstanding(){
      const left=[...reports.values()].filter(value=>value!=='restored');
      return left.length?left.length+' pane(s): '+message(left[0]):'';
    }
    function note(value){
      status=value;
      if(statusNode)statusNode.textContent=[value,outstanding()].filter(Boolean).join(' · ');
      return value;
    }
    function refreshUi(){
      if(!toggleNode)return;
      toggleNode.textContent=enabled?'Exit 3D Cursor':'3D Cursor';
      toggleNode.setAttribute('aria-pressed',String(enabled));
      // A poisoned or stopped controller can never be switched on again, so the one way out of
      // the mode must not look available.
      toggleNode.disabled=stopped||poisoned;
    }
    // The button is the whole of the release mechanism: no new keyboard shortcut is registered,
    // because this controller must not take a key away from the host viewer.
    function onToggle(){
      if(stopped||poisoned)return;
      if(enabled)disable('off').catch(()=>{});else enable();
    }
    function buildPanel(host){
      if(!host||!host.append)return;
      panel=doc.createElement('section');panel.id='kin-3d-cursor';panel.setAttribute('data-kin-3d-cursor-panel',owned);
      toggleNode=doc.createElement('button');toggleNode.type='button';toggleNode.id='kin-3d-cursor-toggle';
      toggleNode.setAttribute('aria-pressed','false');toggleNode.textContent='3D Cursor';
      toggleNode.addEventListener('click',onToggle);
      statusNode=doc.createElement('p');statusNode.id='kin-3d-cursor-status';statusNode.setAttribute('role','status');
      statusNode.textContent=status;
      panel.append(toggleNode,statusNode);host.append(panel);
      refreshUi();
    }

    const fingerprint=value=>{try{return JSON.stringify(value??null);}catch(_){return null;}};
    const now=()=>{try{return fingerprint(context?.())??'';}catch(_){return null;}};
    const readIndex=viewport=>{try{const value=viewport.getCurrentImageIdIndex();return Number.isInteger(value)?value:null;}catch(_){return null;}};
    const readId=viewport=>{try{const value=viewport.getCurrentImageId();return typeof value==='string'?value:null;}catch(_){return null;}};
    /* getImageIds() is the live array of the pinned StackViewport and setStack always installs a
       new array (native-race.json N3), so its reference identity is an exact synchronous source
       generation. First/last are compared as well so an in-place rebuild of the same array is
       still visible; a plain user scroll deliberately does not change this token, because a
       reader's own frame is handled by the ownership record instead. */
    function token(viewport){
      try{
        const ids=viewport.getImageIds();
        if(!Array.isArray(ids)||!ids.length)return null;
        return {ids,length:ids.length,first:ids[0],last:ids[ids.length-1],viewportId:viewport.id};
      }catch(_){return null;}
    }
    const same=(a,b)=>!!a&&!!b&&a.ids===b.ids&&a.length===b.length&&a.first===b.first&&a.last===b.last&&a.viewportId===b.viewportId;
    /* The index moves before the pixels load, so only the image the renderer actually holds
       confirms a frame. csImage keeps the previous image across a stack replacement. */
    function rendered(viewport,imageId){
      try{
        return !!imageId&&readId(viewport)===imageId&&viewport.getCornerstoneImage?.()?.imageId===imageId&&viewport.viewportStatus!=='loading';
      }catch(_){return false;}
    }

    /* A started native request cannot be withdrawn, so every await is bounded and its outcome is
       one of resolved / rejected / still pending. Pending is a real state, not a failure. */
    function watch(promise){
      const record={state:'pending'};
      record.done=Promise.resolve(promise).then(value=>{record.state='resolved';record.value=value;},
        error=>{record.state='rejected';record.value=error;});
      return record;
    }
    async function settle(record,attempts){
      for(let i=0;i<=attempts;i++){
        if(record.state!=='pending')return record.state;
        if(i===attempts)break;
        await tick();
      }
      return 'pending';
    }

    function describe(pane){
      const viewport=pane?.viewport;
      if(!pane||!pane.element||!viewport||viewport.type!=='stack')return null;
      const ids=(()=>{try{return viewport.getImageIds();}catch(_){return null;}})();
      if(!Array.isArray(ids)||ids.length<2||!ids.every(id=>typeof id==='string'))return null;
      const metas=[];
      for(const imageId of ids){
        let meta=null;
        try{meta=metaOf(imageId);}catch(_){meta=null;}
        if(!meta||typeof meta!=='object')return {id:pane.id,element:pane.element,viewport,reason:'identity-missing'};
        metas.push({...meta,imageId});
      }
      /* The anchor is the cornerstone enabled element: the one canvasToWorld/worldToCanvas and
         the native mouse mapping are defined against. Clicks are measured on it and the marker
         layer hangs off it, so an enabled element inset inside a larger pane container cannot
         put the drawn point and the picked point in two different origins. */
      const anchor=viewport.element||pane.element;
      const built=model.stack(metas),mark=token(viewport);
      const base={id:pane.id,element:pane.element,anchor,viewport};
      if(anchor!==pane.element&&!(pane.element.contains&&pane.element.contains(anchor)))return {...base,reason:'pane-anchor'};
      if(!built.ok)return {...base,reason:built.reason};
      if(!mark)return {...base,reason:'identity-missing'};
      return {...base,stack:built.stack,token:mark};
    }

    function attach(element){
      if(handlers.has(element))return;
      const record={click:event=>onClick(element,event),competing:event=>onCompeting(element,event)};
      element.addEventListener('click',record.click);
      element.addEventListener('pointerdown',record.competing,true);
      element.addEventListener('wheel',record.competing,true);
      handlers.set(element,record);
    }
    function detach(element){
      const record=handlers.get(element);
      if(!record)return;
      element.removeEventListener('click',record.click);
      element.removeEventListener('pointerdown',record.competing,true);
      element.removeEventListener('wheel',record.competing,true);
      handlers.delete(element);
    }
    const detachAll=()=>{for(const element of [...handlers.keys()])detach(element);};
    /* Only this controller's own inline mutation is undone. A pane positioned by the host
       stylesheet is never written to, so teardown cannot change the viewer layout. */
    function dropNode(id){
      const record=nodes.get(id);
      nodes.delete(id);
      if(!record)return;
      try{record.host.remove();}catch(_){}
      try{
        if(record.priorPosition!==null&&record.anchor.style.position==='relative')record.anchor.style.position=record.priorPosition;
      }catch(_){}
    }
    const dropNodes=()=>{for(const id of [...nodes.keys()])dropNode(id);};

    /* Binding, listeners and owned nodes move together. A pane the host stopped returning keeps
       neither a listener nor a marker, even though it is still in the document. */
    function syncBinding(){
      const next=new Map(),list=(()=>{try{return panesOf()||[];}catch(_){return [];}})();
      for(const pane of list){
        const item=describe(pane);
        if(item&&typeof item.id==='string'&&!next.has(item.id))next.set(item.id,item);
      }
      // Two panes on one element cannot be told apart by a click or by a marker, so both are
      // refused instead of one silently answering for the other.
      const seen=new Map();
      for(const item of next.values())seen.set(item.element,(seen.get(item.element)||0)+1);
      for(const [id,item] of next)if(seen.get(item.element)>1)next.set(id,{id,element:item.element,anchor:item.anchor,viewport:item.viewport,reason:'pane-ambiguous'});
      const live=new Set([...next.values()].filter(item=>item.stack).map(item=>item.element));
      for(const element of [...handlers.keys()])if(!live.has(element))detach(element);
      for(const id of [...nodes.keys()]){
        const item=next.get(id);
        if(!item||!item.stack||nodes.get(id).anchor!==item.anchor)dropNode(id);
      }
      if(enabled)for(const element of live)attach(element);
      for(const [id,mark] of [...marks])if(stale(next.get(id),mark,next.get(id)?.token))marks.delete(id);
      bound=next;
      return bound;
    }
    /* A marker claims that this exact image is on screen at this exact point. The claim dies with
       the pane, with the stack it was measured against, and with the frame itself: the confirming
       observation is rendered(), the same predicate that let the marker be committed. */
    const stale=(item,mark,mark_token)=>!item||!item.stack||item.anchor!==mark.anchor||
      !same(mark_token,mark.token)||!rendered(item.viewport,mark.imageId);
    /* Invalidation alone, for a refresh that arrives while a run is awaiting. Rebinding or moving
       a pane then would take the run's bindings away from it, but leaving a marker that no longer
       matches the displayed frame would keep a stale claim on screen for the whole run. */
    function invalidateMarks(){
      let dropped=false;
      for(const [id,mark] of [...marks]){
        const item=bound.get(id);
        if(stale(item,mark,item&&token(item.viewport))){marks.delete(id);dropped=true;}
      }
      if(dropped)paint();
      return dropped;
    }

    const SIZE=13;
    function layerFor(item){
      const existing=nodes.get(item.id);
      if(existing&&existing.anchor===item.anchor&&existing.host.isConnected&&existing.host.parentElement===item.anchor)return existing.host;
      dropNode(item.id);
      const host=doc.createElement('div');
      host.setAttribute('data-kin-3d-cursor-layer',owned);
      host.style.cssText='position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:20';
      let priorPosition=null;
      try{
        const computed=root.getComputedStyle?root.getComputedStyle(item.anchor):null;
        if(!computed||computed.position==='static'){priorPosition=item.anchor.style.position;item.anchor.style.position='relative';}
      }catch(_){}
      item.anchor.append(host);
      nodes.set(item.id,{anchor:item.anchor,host,priorPosition});
      return host;
    }
    /* worldToCanvas is in the anchor's coordinates, but an absolutely positioned layer starts at
       the anchor's padding box, so the two origins differ by any border. The offset is measured
       rather than assumed, and a point outside the visible box is hidden instead of being drawn
       over a neighbouring pane. */
    function paint(){
      const keep=new Set();
      for(const [id,mark] of [...marks]){
        const item=bound.get(id);
        if(!item||!item.stack){marks.delete(id);continue;}
        let canvas=null;
        try{canvas=item.viewport.worldToCanvas(mark.world);}catch(_){canvas=null;}
        if(!Array.isArray(canvas)||!canvas.slice(0,2).every(Number.isFinite)){marks.delete(id);continue;}
        mark.canvas={x:canvas[0],y:canvas[1]};
        const host=layerFor(item);
        keep.add(id);
        let dot=host.firstElementChild;
        if(!dot){
          dot=doc.createElement('div');dot.setAttribute('data-kin-3d-cursor-mark',owned);dot.setAttribute('role','presentation');
          dot.style.cssText='position:absolute;box-sizing:border-box;width:'+SIZE+'px;height:'+SIZE+'px;margin:'+(-SIZE/2)+'px 0 0 '+
            (-SIZE/2)+'px;border:1px solid #ffd400;border-radius:50%;box-shadow:0 0 0 1px #000';
          host.append(dot);
        }
        let shift={x:0,y:0},box=null;
        try{
          const hostRect=host.getBoundingClientRect(),anchorRect=item.anchor.getBoundingClientRect();
          shift={x:hostRect.left-anchorRect.left,y:hostRect.top-anchorRect.top};
          box={width:anchorRect.width,height:anchorRect.height};
        }catch(_){box=null;}
        mark.visible=!box||(canvas[0]>=0&&canvas[1]>=0&&canvas[0]<=box.width&&canvas[1]<=box.height);
        dot.style.display=mark.visible?'block':'none';
        dot.style.left=(canvas[0]-shift.x)+'px';dot.style.top=(canvas[1]-shift.y)+'px';dot.dataset.kinSop=mark.sop;
      }
      for(const id of [...nodes.keys()])if(!keep.has(id))dropNode(id);
    }
    function clearMarks(reason){
      marks.clear();source=null;note(reason?message(reason):'');
      dropNodes();
    }

    /* Cornerstone maps a mouse event to canvas coordinates as client minus the enabled element's
       bounding rect (pinned 149.bundle getMouseEventPoints), so this must use the same element
       and the same rect. offsetX/offsetY are relative to the child that was hit and would shift
       the physical point silently. */
    function canvasPoint(item,event){
      const element=item.anchor;
      if(!element||!element.isConnected)return null;
      let rect=null;
      try{rect=element.getBoundingClientRect();}catch(_){return null;}
      if(!rect||![rect.left,rect.top,rect.width,rect.height].every(Number.isFinite)||!(rect.width>0)||!(rect.height>0))return null;
      if(!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return null;
      const x=event.clientX-rect.left,y=event.clientY-rect.top;
      if(x<0||y<0||x>rect.width||y>rect.height)return null;
      return {x,y};
    }

    async function confirmRendered(item,imageId,attempts){
      for(let i=0;i<=attempts;i++){
        if(rendered(item.viewport,imageId))return true;
        if(i===attempts)break;
        await tick();
      }
      return false;
    }
    /* One navigation attempt with a bounded wait. A still-pending request quarantines the pane:
       issuing a second request would let two native loads compete for the same viewport. */
    async function navigate(item,index){
      let promise;
      try{promise=item.viewport.setImageIdIndex(index);}catch(_){return 'navigation-failed';}
      const record=watch(promise),outcome=await settle(record,navigationAttempts);
      if(outcome==='pending'){quarantine.set(item.id,{index,token:item.token,record});return 'navigation-unsettled';}
      return outcome==='rejected'?'navigation-failed':null;
    }

    /* Restoration is owned by the run that moved the pane and only ever writes back onto exactly
       what that run left there. A newer user frame, a replaced source, an unsettled request or a
       teardown all leave the pane alone, and an unconfirmed result is never called restored. */
    async function restoreOne(id){
      const record=moved.get(id);
      moved.delete(id);
      if(!record)return null;
      const report=value=>{reports.set(id,value);return value;};
      // A run whose session ended owns nothing any more: it may not write to a viewport, and it
      // may not claim anything about one either.
      if(record.generation!==session)return report('restore-blocked-abandoned');
      const item=bound.get(id)||record.item;
      if(!item)return report('restore-skipped-unbound');
      if(quarantine.has(id))return report('restore-blocked-unsettled');
      if(!same(token(item.viewport),record.token))return report('restore-skipped-replaced');
      if(revoked.has(id))return report('restore-skipped-user');
      const index=readIndex(item.viewport),current=readId(item.viewport);
      // Nothing to write, but the pixels still decide whether this pane really is back.
      if(index===record.startIndex&&current===record.startImageId)
        return report(rendered(item.viewport,record.startImageId)?'restored':'restore-unconfirmed');
      if(index!==record.issuedIndex||current!==record.issuedImageId)return report('restore-skipped-user');
      if(stopped)return report('restore-blocked-stopped');
      const failure=await navigate(item,record.startIndex);
      if(failure==='navigation-unsettled')return report('restore-unconfirmed');
      if(failure)return report('restore-failed');
      return report(await confirmRendered(item,record.startImageId,confirmAttempts)?'restored':'restore-unconfirmed');
    }
    async function restore(){
      for(const id of [...moved.keys()])await restoreOne(id);
    }
    async function finish(reason,generation){
      if(generation!==undefined&&generation!==session){
        // Fence: no run counter, no marks, no status and no navigation from a dead session.
        await restore();
        return;
      }
      run++;
      await restore();
      clearMarks(reason);
    }
    async function drain(){
      if(!active)return 'idle';
      return await settle(watch(active),drainAttempts)==='pending'?'unsettled':'settled';
    }
    async function cancel(reason){
      const why=reason||'user-interrupt';
      if(busy){abort=why;return await drain();}
      await finish(why);
      return 'settled';
    }

    async function runPick(paneId,point){
      const ticket=++run,generation=session;
      moved.clear();revoked.clear();reports.clear();abort=null;clearMarks();
      syncBinding();
      const origin=bound.get(paneId);
      const refuse=reason=>({ok:false,reason,status:note(message(reason))});
      if(!origin||!origin.stack||!origin.token)return refuse(origin?.reason||'identity-missing');
      if(now()!==base)return refuse('context-changed');
      const currentId=readId(origin.viewport),index=readIndex(origin.viewport);
      if(index===null||!rendered(origin.viewport,currentId)||origin.token.ids[index]!==currentId)return refuse('source-not-rendered');
      let world=null;
      try{world=origin.viewport.canvasToWorld([point.x,point.y]);}catch(_){world=null;}
      const picked=model.pick(origin.stack,index,world,snapTolerance);
      if(!picked.ok)return refuse(picked.reason);
      source={paneId,sop:picked.sop,world:picked.world,pixel:picked.pixel};
      marks.set(paneId,{world:picked.world,sop:picked.sop,imageId:currentId,pixel:picked.pixel,token:origin.token,anchor:origin.anchor,origin:true});
      const results=[{paneId,ok:true,sop:picked.sop,origin:true}];
      /* One reason to stop the whole run. Replacing the pane that was picked invalidates the
         point itself, so it stops the run instead of being reported per target pane. A session
         that ended while this run was awaiting is 'abandoned': it stops and writes nothing. */
      const halt=()=>generation!==session?'abandoned':run!==ticket?'context-changed':abort||
        (now()!==base||!enabled||stopped?'context-changed':!same(token(origin.viewport),origin.token)?'source-replaced':null);
      const stopRun=async why=>{
        await finish(why,generation);
        return {ok:false,reason:why,results,status:why==='abandoned'?'':status};
      };
      for(const item of bound.values()){
        if(item.id===paneId)continue;
        if(!item.stack){results.push({paneId:item.id,ok:false,reason:item.reason});continue;}
        const mismatch=model.comparable(origin.stack.id,item.stack.id);
        if(mismatch){results.push({paneId:item.id,ok:false,reason:mismatch});continue;}
        const found=model.locate(item.stack,picked.world,sliceDistanceLimit);
        if(!found.ok){
          // A refusal that measured a distance carries it, so the reader is told how far the
          // point actually was instead of only that it was too far.
          results.push(Number.isFinite(found.distance)
            ?{paneId:item.id,ok:false,reason:found.reason,distance:found.distance,limit:found.limit}
            :{paneId:item.id,ok:false,reason:found.reason});
          continue;
        }
        if(quarantine.has(item.id)){results.push({paneId:item.id,ok:false,reason:'navigation-unsettled'});continue;}
        // Every gate below is re-read in the same tick as the call: a replacement that happened
        // during an earlier await must never receive this stack's index.
        let why=halt();
        if(why)return stopRun(why);
        if(!same(token(item.viewport),item.token)){results.push({paneId:item.id,ok:false,reason:'source-replaced'});continue;}
        const startIndex=readIndex(item.viewport),startImageId=readId(item.viewport);
        if(startIndex===null||startImageId===null){results.push({paneId:item.id,ok:false,reason:'source-not-rendered'});continue;}
        let failure=null;
        if(startIndex!==found.index){
          // Ownership is the exact frame this run issued, so a newer reader frame stays.
          moved.set(item.id,{startIndex,startImageId,issuedIndex:found.index,issuedImageId:found.imageId,token:item.token,item,generation});
          failure=await navigate(item,found.index);
          why=halt();
          if(why)return stopRun(why);
          if(!failure&&!same(token(item.viewport),item.token))failure='source-replaced';
        }
        if(!failure)failure=await confirm(item,found.imageId,halt);
        // Read the stop reason once: two reads of halt() could report a different cause than the
        // one that actually ended the run.
        const ended=halt();
        if(failure==='context-changed'||ended)return stopRun(ended||'context-changed');
        if(failure){
          results.push({paneId:item.id,ok:false,reason:failure});
          await restoreOne(item.id);
          continue;
        }
        // Ownership is kept until the whole run succeeds: a later cancel must be able to roll
        // back panes that had already finished, and only a complete run releases them.
        marks.set(item.id,{world:picked.world,sop:found.sop,imageId:found.imageId,pixel:found.pixel,token:token(item.viewport),anchor:item.anchor,
          distance:found.distance});
        results.push({paneId:item.id,ok:true,sop:found.sop,index:found.index,pixel:found.pixel,distance:found.distance,distanceLimit:found.distanceLimit});
      }
      const ending=halt();
      if(ending)return stopRun(ending);
      moved.clear();paint();
      const missed=results.filter(result=>!result.ok);
      // The worst slice distance among the panes that were actually marked: it is the one the
      // reader is most likely to misread as a point lying in the displayed image.
      const spread=results.filter(result=>result.ok&&Number.isFinite(result.distance)).map(result=>result.distance);
      note(missed.length?missed.length+' pane(s): '+message(missed[0].reason)
        :'3D Cursor 표시됨'+(spread.length?' · '+distanceText(Math.max(...spread)):''));
      return {ok:true,results,status};
    }
    /* setImageIdIndex resolves even when its load was discarded, and resolves at once when the
       index already matched while an earlier load is still in flight, so confirmation re-reads
       the rendered image under a bounded number of attempts. */
    async function confirm(item,expected,halt){
      for(let i=0;i<=confirmAttempts;i++){
        const stop=halt();
        if(stop)return stop;
        if(!same(token(item.viewport),item.token))return 'source-replaced';
        if(rendered(item.viewport,expected))return null;
        if(i===confirmAttempts)break;
        await tick();
      }
      return 'target-not-confirmed';
    }

    function pick(paneId,point){
      if(!enabled||stopped||busy)return Promise.resolve({ok:false,reason:'inactive'});
      busy=true;
      const promise=runPick(paneId,point).catch(error=>{
        note(message('internal'));
        return {ok:false,reason:'internal',error:String(error&&error.message||error)};
      }).then(result=>{busy=false;active=null;refreshUi();return result;});
      active=promise;
      return promise;
    }

    /* A competing interaction wins immediately and revokes that pane for this run: the reader
       owns it from now on, even if its index happens to equal the one the run issued. */
    function onCompeting(element,event){
      if(!enabled||stopped)return;
      const item=[...bound.values()].find(entry=>entry.element===element);
      if(item)revoked.add(item.id);
      if(busy){abort='user-interrupt';return;}
      if(event&&event.type==='pointerdown')clearMarks();else clearMarks('user-interrupt');
    }
    function onClick(element,event){
      const item=[...bound.values()].find(entry=>entry.element===element);
      if(!item||!item.stack)return;
      const point=canvasPoint(item,event);
      if(!point){note(message('point-outside-viewport'));return;}
      pick(item.id,point).catch(()=>{note(message('internal'));});
    }

    /* An unsettled teardown leaves a native request nobody can withdraw, so this controller stays
       closed for good rather than letting a later session share a viewport with it. Only a new
       controller helps with the JS state, and only reopening the viewer window is certain about
       the request itself. */
    function enable(){
      if(enabled)return false;
      // Never a silent no-op: every path that answers false writes the reason where it can be read.
      if(stopped||poisoned){note(message(poisoned?'teardown-unsettled':'stopped'));refreshUi();return false;}
      const probe=now();
      if(probe===null){note(message('context-changed'));refreshUi();return false;}
      base=probe;enabled=true;syncBinding();
      if(![...bound.values()].some(item=>item.stack)){
        enabled=false;detachAll();dropNodes();bound=new Map();base=null;
        note(message('no-eligible-pane'));refreshUi();
        return false;
      }
      note('3D Cursor 대기');refreshUi();
      return true;
    }
    async function disable(reason){
      if(stopped)return teardown;
      const was=enabled;
      enabled=false;
      let result='idle';
      if(busy){abort=reason||'context-changed';result=await drain();}
      else if(was||moved.size){await finish(reason||null);result='settled';}
      // Fence after the drain, never before it: the run being drained must still be able to roll
      // back what it owns. Anything that outlives the drain is abandoned from here on.
      session++;
      if(result==='unsettled')poisoned=true;
      detachAll();marks.clear();source=null;dropNodes();base=null;
      teardown=result;
      note(result==='unsettled'?message('teardown-unsettled'):message(reason||'off'));refreshUi();
      return result;
    }
    /* The host adapter calls this when the renderer says something changed. Confirmation stays a
       poll of rendered(); the call only shortens the wait and triggers invalidation. A render
       event is never treated as proof by itself, because STACK_NEW_IMAGE fires before render. */
    function refresh(){
      if(!enabled||stopped)return;
      if(busy){invalidateMarks();return;}
      if(now()!==base){disable('context-changed');return;}
      syncBinding();paint();
    }
    async function stop(){
      const result=await disable('stopped');
      stopped=true;bound=new Map();
      // The per-run maps are deliberately kept and labelled final instead of being cleared: they
      // are the only record of what was left quarantined or unconfirmed.
      note(message(result==='unsettled'?'teardown-unsettled':'stopped'));refreshUi();
      return result;
    }

    const state=()=>({enabled,stopped,poisoned,busy,run,session,status,teardown,source,sliceDistanceLimit,
      frozen:stopped||poisoned,quarantined:[...quarantine.keys()],restores:Object.fromEntries(reports),
      panes:[...bound.values()].map(item=>({id:item.id,eligible:!!item.stack,reason:item.reason||null,marked:marks.has(item.id),
        sop:marks.get(item.id)?.sop||null,canvas:marks.get(item.id)?.canvas||null,visible:marks.get(item.id)?.visible??null,
        distance:marks.get(item.id)?.distance??null,
        restore:reports.get(item.id)||null}))});
    buildPanel(options.host);
    return {enable,disable,refresh,pick,stop,state,cancel};
  }

  const api={mount,message,reasons};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinViewerThreeDCursor=api;
})(typeof globalThis==='object'?globalThis:this);
