/* REQ-D-3D-CURSOR controller. Explicit pick-point mode over classic CT/MR stack panes.
   It reads viewport state and moves slices only; it never creates, edits or deletes an
   annotation, never activates a tool and never writes storage. Markers are owned DOM
   nodes that disappear with the mode, the run or the marked image. */
(function(root){
  'use strict';
  const model=typeof require==='function'&&typeof module==='object'?require('./three-d-cursor-model.js'):root.KinThreeDCursorModel;
  const TEXT={'identity-study':'같은 검사가 아닙니다.','identity-patient':'같은 원본 환자가 아닙니다.','identity-frame':'같은 기준 좌표계가 아닙니다.',
    'identity-missing':'원본 식별을 확인하지 못했습니다.','out-of-image':'해당 영상 범위 밖입니다.','out-of-coverage':'해당 시리즈 촬영 범위 밖입니다.',
    'ambiguous-slice':'가장 가까운 영상을 하나로 정할 수 없습니다.','pick-off-plane':'현재 표시된 영상 평면의 점이 아닙니다.',
    'source-not-rendered':'현재 표시된 영상을 확인하지 못했습니다.','target-not-confirmed':'대상 영상이 표시된 것을 확인하지 못했습니다.',
    'source-replaced':'영상이 교체되어 취소했습니다.','navigation-failed':'대상 영상으로 이동하지 못했습니다.','user-interrupt':'다른 조작으로 취소했습니다.',
    'context-changed':'세션 또는 도구가 바뀌어 취소했습니다.','pick-slice-unknown':'현재 영상을 원본 목록에서 찾지 못했습니다.'};
  const message=reason=>TEXT[reason]||'3D Cursor를 사용할 수 없습니다.';

  function mount(options){
    const doc=options.document||root.document,panesOf=options.panes,metaOf=options.meta,context=options.context;
    const tick=options.tick||(()=>new Promise(resolve=>setTimeout(resolve,16))),attempts=Number.isInteger(options.confirmAttempts)?options.confirmAttempts:20;
    const snapTolerance=typeof options.snapTolerance==='number'?options.snapTolerance:0.5;
    let enabled=false,stopped=false,run=0,bound=new Map(),marks=new Map(),moved=new Map(),base=null,status='',source=null,busy=false,abort=null;

    const fingerprint=value=>{try{return JSON.stringify(value??null);}catch(_){return null;}};
    const now=()=>{try{return fingerprint(context?.())??'';}catch(_){return null;}};
    /* getImageIds() is the live array of the pinned StackViewport and setStack always installs
       a new array, so its reference identity is an exact synchronous source generation. */
    function token(viewport){
      try{
        const ids=viewport.getImageIds();
        if(!Array.isArray(ids))return null;
        return {ids,length:ids.length,current:viewport.getCurrentImageId(),viewportId:viewport.id};
      }catch(_){return null;}
    }
    const same=(a,b)=>!!a&&!!b&&a.ids===b.ids&&a.length===b.length&&a.viewportId===b.viewportId;
    /* The index moves before the pixels load, so only the image the renderer actually holds
       confirms a frame. csImage keeps the previous image across a stack replacement. */
    function rendered(viewport,imageId){
      try{
        return viewport.getCurrentImageId()===imageId&&viewport.getCornerstoneImage?.()?.imageId===imageId&&viewport.viewportStatus!=='loading';
      }catch(_){return false;}
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
      const built=model.stack(metas);
      if(!built.ok)return {id:pane.id,element:pane.element,viewport,reason:built.reason};
      return {id:pane.id,element:pane.element,viewport,stack:built.stack,token:token(viewport)};
    }

    /* Bindings are rebuilt from the host on every entry point: a pane list or a pane's stack
       may have been replaced since the mode was entered, and a stale binding is never reused. */
    function rebind(){
      const next=new Map(),list=(()=>{try{return panesOf()||[];}catch(_){return [];}})();
      for(const pane of list){
        const item=describe(pane);
        if(item&&typeof item.id==='string')next.set(item.id,item);
      }
      for(const [id,mark] of [...marks])if(!next.get(id)?.stack||!same(next.get(id).token,mark.token)||!rendered(next.get(id).viewport,mark.imageId))marks.delete(id);
      bound=next;
      return bound;
    }

    function layer(item){
      let host=item.element.querySelector(':scope > [data-kin-3d-cursor-layer]');
      if(!host){
        host=doc.createElement('div');host.setAttribute('data-kin-3d-cursor-layer','');
        host.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:20';
        if(!item.element.style.position)item.element.style.position='relative';
        item.element.append(host);
      }
      return host;
    }
    function paint(){
      for(const item of bound.values()){
        const host=item.element.querySelector(':scope > [data-kin-3d-cursor-layer]');
        const mark=marks.get(item.id);
        if(!mark){host?.remove();continue;}
        let canvas=null;
        try{canvas=item.viewport.worldToCanvas(mark.world);}catch(_){canvas=null;}
        if(!Array.isArray(canvas)||!canvas.slice(0,2).every(Number.isFinite)){marks.delete(item.id);host?.remove();continue;}
        mark.canvas={x:canvas[0],y:canvas[1]};
        const target=layer(item);
        let dot=target.querySelector('[data-kin-3d-cursor-mark]');
        if(!dot){
          dot=doc.createElement('div');dot.setAttribute('data-kin-3d-cursor-mark','');dot.setAttribute('role','presentation');
          dot.style.cssText='position:absolute;width:13px;height:13px;margin:-7px 0 0 -7px;border:1px solid #ffd400;border-radius:50%;box-shadow:0 0 0 1px #000';
          target.append(dot);
        }
        dot.style.left=canvas[0]+'px';dot.style.top=canvas[1]+'px';
        dot.dataset.kinSop=mark.sop;
      }
    }
    function clearMarks(reason){
      if(!marks.size&&!status)return;
      marks.clear();source=null;status=reason?message(reason):'';
      for(const item of bound.values())item.element.querySelector(':scope > [data-kin-3d-cursor-layer]')?.remove();
    }

    /* Restoration only ever writes into the very source that was moved; after a replacement
       the pre-run index belongs to a stack that no longer exists and is discarded. */
    async function restoreOne(item){
      const record=moved.get(item.id);
      moved.delete(item.id);
      if(!record||!same(token(item.viewport),record.token))return;
      try{if(item.viewport.getCurrentImageIdIndex()!==record.index)await item.viewport.setImageIdIndex(record.index);}catch(_){}
    }
    async function restore(){
      for(const id of [...moved.keys()]){
        const item=bound.get(id);
        if(item)await restoreOne(item);else moved.delete(id);
      }
    }
    /* Only the running pick restores what it moved. An outside cancel that arrives while a
       navigation is awaited just raises the flag, so two callers never drive one viewport. */
    async function finish(reason){
      run++;if(moved.size)await restore();clearMarks(reason);
    }
    async function cancel(reason){
      if(busy){abort=reason||'user-interrupt';return;}
      await finish(reason);
    }

    /* setImageIdIndex resolves even when its load was discarded, and resolves at once when
       the index already matched while an earlier load is still in flight, so confirmation
       re-reads the rendered image under a bounded number of attempts. */
    async function confirm(item,expected,halt){
      for(let i=0;i<=attempts;i++){
        const stop=halt();
        if(stop)return stop;
        if(!same(token(item.viewport),item.token))return 'source-replaced';
        if(rendered(item.viewport,expected))return null;
        if(i===attempts)break;
        await tick();
      }
      return 'target-not-confirmed';
    }

    async function pick(paneId,point){
      if(!enabled||stopped||busy)return {ok:false,reason:'inactive'};
      busy=true;
      try{
        const ticket=++run;
        moved.clear();abort=null;clearMarks();
        rebind();
        const origin=bound.get(paneId);
        if(!origin||!origin.stack)return {ok:false,reason:origin?.reason||'identity-missing',status:status=message(origin?.reason||'identity-missing')};
        if(now()!==base)return {ok:false,reason:'context-changed',status:status=message('context-changed')};
        const currentId=(()=>{try{return origin.viewport.getCurrentImageId();}catch(_){return null;}})();
        const index=(()=>{try{return origin.viewport.getCurrentImageIdIndex();}catch(_){return -1;}})();
        if(!rendered(origin.viewport,currentId)||origin.token.ids[index]!==currentId)return {ok:false,reason:'source-not-rendered',status:status=message('source-not-rendered')};
        let world=null;
        try{world=origin.viewport.canvasToWorld([point.x,point.y]);}catch(_){world=null;}
        const picked=model.pick(origin.stack,index,world,snapTolerance);
        if(!picked.ok)return {ok:false,reason:picked.reason,status:status=message(picked.reason)};
        source={paneId,sop:picked.sop,world:picked.world,pixel:picked.pixel};
        marks.set(paneId,{world:picked.world,sop:picked.sop,imageId:currentId,pixel:picked.pixel,token:origin.token,origin:true});
        const results=[{paneId,ok:true,sop:picked.sop,origin:true}];
        /* One reason to stop the whole run. Replacing the pane that was picked invalidates the
           point itself, so it stops the run instead of being reported per target pane. */
        const halt=()=>run!==ticket?'context-changed':abort||(now()!==base||!enabled||stopped?'context-changed':
          !same(token(origin.viewport),origin.token)?'source-replaced':null);
        const stopRun=async why=>{await finish(why);return {ok:false,reason:why,results,status};};
        for(const item of bound.values()){
          if(item.id===paneId)continue;
          if(!item.stack){results.push({paneId:item.id,ok:false,reason:item.reason});continue;}
          const mismatch=model.comparable(origin.stack.id,item.stack.id);
          if(mismatch){results.push({paneId:item.id,ok:false,reason:mismatch});continue;}
          const found=model.locate(item.stack,picked.world);
          if(!found.ok){results.push({paneId:item.id,ok:false,reason:found.reason});continue;}
          // Every gate below is re-read in the same tick as the call: a replacement that
          // happened during an earlier await must never receive this stack's index.
          let why=halt();
          if(why)return stopRun(why);
          if(!same(token(item.viewport),item.token)){results.push({paneId:item.id,ok:false,reason:'source-replaced'});continue;}
          const startIndex=item.viewport.getCurrentImageIdIndex();
          let failure=null;
          if(startIndex!==found.index){
            moved.set(item.id,{index:startIndex,token:item.token});
            try{await item.viewport.setImageIdIndex(found.index);}catch(_){failure='navigation-failed';}
            why=halt();
            if(why)return stopRun(why);
            if(!failure&&!same(token(item.viewport),item.token))failure='source-replaced';
          }
          if(!failure)failure=await confirm(item,found.imageId,halt);
          if(failure){
            if(failure==='context-changed'||failure==='source-replaced'&&halt())return stopRun(halt()||'context-changed');
            results.push({paneId:item.id,ok:false,reason:failure});
            // A replaced stack keeps no restorable index; anything else returns this pane alone.
            if(failure==='source-replaced')moved.delete(item.id);
            else await restoreOne(item);
            continue;
          }
          marks.set(item.id,{world:picked.world,sop:found.sop,imageId:found.imageId,pixel:found.pixel,token:token(item.viewport)});
          results.push({paneId:item.id,ok:true,sop:found.sop,index:found.index,pixel:found.pixel});
        }
        const ending=halt();
        if(ending)return stopRun(ending);
        moved.clear();paint();
        const missed=results.filter(r=>!r.ok);
        status=missed.length?missed.length+' pane(s): '+message(missed[0].reason):'3D Cursor 표시됨';
        return {ok:true,results,status};
      }finally{busy=false;}
    }

    /* A competing interaction wins immediately: the run stops issuing navigation at its next
       gate and the marker of a half-finished run is never left on screen. */
    const competing=event=>{
      if(!enabled||stopped)return;
      if(busy){abort='user-interrupt';return;}
      if(event&&event.type==='pointerdown')clearMarks();else clearMarks('user-interrupt');
    };
    const onClick=event=>{
      const item=[...bound.values()].find(entry=>entry.element===event.currentTarget);
      if(item)pick(item.id,{x:event.offsetX,y:event.offsetY});
    };
    function listen(on){
      for(const item of bound.values()){
        const element=item.element;
        element[on?'addEventListener':'removeEventListener']('click',onClick);
        for(const type of ['pointerdown','wheel'])element[on?'addEventListener':'removeEventListener'](type,competing,true);
      }
    }

    function enable(){
      if(stopped||enabled)return false;
      base=now();
      if(base===null)return false;
      enabled=true;rebind();listen(true);status='3D Cursor 대기';
      return [...bound.values()].some(item=>item.stack);
    }
    async function disable(reason){
      if(!enabled)return;
      listen(false);enabled=false;abort=reason||'context-changed';
      await cancel(reason||null);
      for(const item of bound.values())item.element.querySelector(':scope > [data-kin-3d-cursor-layer]')?.remove();
      status='';
    }
    function refresh(){
      if(!enabled||stopped)return;
      if(now()!==base){disable('context-changed');return;}
      const before=[...bound.keys()].join('|');
      listen(false);rebind();listen(true);
      if(before!==[...bound.keys()].join('|'))clearMarks();
      paint();
    }
    async function stop(){await disable(null);stopped=true;bound=new Map();marks.clear();moved.clear();}

    const state=()=>({enabled,stopped,busy,run,status,source,
      panes:[...bound.values()].map(item=>({id:item.id,eligible:!!item.stack,reason:item.reason||null,marked:marks.has(item.id),
        sop:marks.get(item.id)?.sop||null,canvas:marks.get(item.id)?.canvas||null}))});
    return {enable,disable,refresh,pick,stop,state,cancel:reason=>{abort=reason||'user-interrupt';return cancel(abort);}};
  }

  const api={mount,message};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinViewerThreeDCursor=api;
})(typeof globalThis==='object'?globalThis:this);
