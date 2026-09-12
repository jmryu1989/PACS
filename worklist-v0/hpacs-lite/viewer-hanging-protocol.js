(function(root){
  'use strict';
  function mount(options){
    const model=options.model||root.KinHangingProtocolModel,services=options.services,host=options.host;
    if(!model||!services?.viewportGridService||!services?.displaySetService||!host)throw Error('Hanging Protocol 연결을 확인할 수 없습니다.');
    const boundOwner=model.owner(options.owner),key=model.ownerKey(boundOwner),storage=options.storage||root.localStorage;
    const live=options.live||(()=>true),fetcher=options.fetcher||root.fetch.bind(root),endpoint=options.endpoint||'/api/hanging-protocols';
    const grid=services.viewportGridService,displaySets=services.displaySetService,objects=new WeakMap();let objectSequence=0;
    let library=model.empty(),selected=null,revision=null,busy=false,ended=false,generation=0,request=null,channel=null,storageError='',appliedCursor=null,appliedFingerprint=null,appliedName=null,layoutQuarantined=false;
    let ownedPlanes=new Map();
    const subscriptions=[];
    try{library=model.read(storage,key)||model.empty();selected=library.activeRuleId||library.rules[0]?.id||null;}catch(error){library=model.empty();storageError=error.message;}
    host.textContent='';host.classList.add('kin-hanging-protocols');
    function make(tag,text,id){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(id)node.id=id;return node;}
    const style=make('style',`
      .kin-hanging-protocols { font:13px/1.45 sans-serif; min-width:0; }
      .kin-hanging-protocols fieldset { min-width:0; border:1px solid #536984; margin:12px 0; padding:10px; border-radius:5px; }
      .kin-hanging-protocols label { display:block; margin:8px 0; overflow-wrap:anywhere; }
      .kin-hanging-protocols label > input:not([type=checkbox]), .kin-hanging-protocols label > select { display:block; width:100%; box-sizing:border-box; margin-top:3px; }
      .kin-hanging-protocols input, .kin-hanging-protocols select, .kin-hanging-protocols button { font:inherit; max-width:100%; }
      .kin-hanging-protocols input:not([type=checkbox]), .kin-hanging-protocols select { background:#17283e; color:#eef4ff; border:1px solid #657c9f; border-radius:4px; padding:5px; }
      .kin-hanging-protocols button { background:#243d5c; color:#eef4ff; border:1px solid #657c9f; border-radius:4px; padding:5px 8px; }
      .kin-hanging-protocols button:disabled { opacity:.5; }
      .kin-hanging-protocols .kin-hp-toolbar, .kin-hanging-protocols .kin-hp-operations { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
      .kin-hanging-protocols .kin-hp-toolbar > select { flex-basis:100%; }
      .kin-hanging-protocols section[data-selector] { border-bottom:1px solid #536984; padding-bottom:12px; margin-bottom:12px; }
      .kin-hanging-protocols h4 { margin:8px 0; }
    `);host.append(style);
    const title=make('h3','Hanging Protocols');host.append(title);
    const note=make('p','규칙을 편집한 뒤 Apply로 현재 영상에 적용합니다. 저장과 적용은 서로 독립적입니다.');host.append(note);
    const toolbar=make('div');toolbar.className='kin-hp-toolbar';host.append(toolbar);
    const choose=make('select',undefined,'kin-hp-rule');choose.setAttribute('aria-label','Hanging Protocol Rule');toolbar.append(choose);
    const actions={new:'New',duplicate:'Duplicate',delete:'Delete',up:'Move Up',down:'Move Down'};
    for(const [action,label] of Object.entries(actions)){const button=make('button',label,'kin-hp-'+action);button.type='button';button.dataset.action=action;toolbar.append(button);}
    const editor=make('div');editor.id='kin-hp-editor';host.append(editor);
    const operations=make('div');operations.className='kin-hp-operations';host.append(operations);
    for(const [action,label] of [['previous','Previous Protocol'],['next','Next Protocol'],['apply','Apply'],['apply-first','Apply First Match'],['save-local','Save Draft'],['load-account','Load from Account'],['save-account','Save to Account'],['reset-account','Reset Account'],['export','Export']]){
      const button=make('button',label,'kin-hp-'+action);button.type='button';button.dataset.operation=action;operations.append(button);
    }
    const importLabel=make('label','Import');const importInput=make('input',undefined,'kin-hp-import');importInput.type='file';importInput.accept='application/json,.json';importLabel.append(importInput);operations.append(importLabel);
    const applied=make('p','Applied Protocol: None','kin-hp-applied');host.append(applied);
    const status=make('p',storageError, 'kin-hp-status');status.setAttribute('role','status');host.append(status);
    const buttons=()=>[...host.querySelectorAll('button,input,select')];
    const clone=v=>structuredClone(v),fold=v=>v.normalize('NFKC').toLocaleLowerCase('en-US');
    function cleanText(input,max){const value=input.value.trim();return value.slice(0,max);}
    function invalidateApplied(){appliedCursor=appliedFingerprint=appliedName=null;applied.textContent='Applied Protocol: None';}
    function markChanged(){generation++;invalidateApplied();refresh();}
    function current(){return library.rules.find(rule=>rule.id===selected)||null;}
    function selectActive(){const rule=current();library.activeRuleId=rule?.enabled?rule.id:null;}
    function addInput(parent,label,value,onchange,options){
      const wrap=make('label',label);let input;
      if(options){input=make('select');for(const [v,t] of options){const option=make('option',t);option.value=v;input.append(option);}input.value=value??'';}
      if(!options){input=make('input');input.value=value??'';}
      input.addEventListener('change',()=>{onchange(input);markChanged();render();});wrap.append(input);parent.append(wrap);return input;
    }
    function conditionEditor(parent,target,includeLaterality){
      addInput(parent,'Modality (empty = Any)',target.modality||'',i=>target.modality=cleanText(i,16).toUpperCase()).placeholder='Any';
      addInput(parent,'Retrieve AE Title (0008,0054, empty = Any)',target.retrieveAE||'',i=>target.retrieveAE=cleanText(i,16).toUpperCase()).placeholder='Any';
      addInput(parent,'Body Part (empty = Any)',target.bodyPart||'',i=>target.bodyPart=cleanText(i,64).toUpperCase()).placeholder='Any';
      const row=make('div');row.className='kin-hp-description';parent.append(row);
      addInput(row,'Description',target.description?.value||'',i=>{const value=cleanText(i,128);target.description=value?{operator:row.querySelector('select').value,value}:null;});
      const op=make('select');for(const v of ['equals','contains']){const o=make('option',v);o.value=v;op.append(o);}op.value=target.description?.operator||'contains';
      op.setAttribute('aria-label','Description Operator');op.onchange=()=>{if(target.description){target.description.operator=op.value;markChanged();}render();};row.prepend(op);
      if(includeLaterality)addInput(parent,'Laterality',target.laterality||'',i=>target.laterality=i.value||null,[['','Any'],['L','L'],['R','R'],['B','B']]);
    }
    const PLANE_LABELS={axial:'Axial',sagittal:'Sagittal',coronal:'Coronal'};
    const spec=cell=>cell===null?null:model.cellSpec(cell);
    const plane=cell=>{const value=spec(cell);return value&&value.view!=='stack'?{view:value.view,orientation:value.orientation}:null;};
    // One cell stays one viewport. A plane reuses the combination the saved MPR job already
    // uses (viewer-volume-job.js), including viewportOptions.id: the native position cache keys
    // on it, so a fresh id keeps a cached oblique presentation off a new axial viewport.
    function viewportRequest(id,sets,cellPlane){
      const viewportOptions=cellPlane?{id,viewportId:id,viewportType:'volume',toolGroupId:'mpr',orientation:cellPlane.orientation,allowUnmatchedView:true}
        :{viewportId:id,viewportType:'stack',toolGroupId:'default',allowUnmatchedView:true};
      return {displaySetInstanceUIDs:sets,displaySetOptions:[{}],viewportOptions};
    }
    // The select carries one string per cell; the alias charset excludes '|', so it separates.
    function cellValue(cell){const value=spec(cell);return !value?'':value.view==='stack'?value.alias:[value.alias,value.view,value.orientation].join('|');}
    function cellFromValue(value){const [alias,view,orientation]=String(value||'').split('|');return !alias?null:view?{alias,view,orientation}:alias;}
    function renameCell(cell,from,to){const value=spec(cell);if(!value||value.alias!==from)return cell;return value.view==='stack'?to:{...value,alias:to};}
    function cellOptions(rule){
      return [['','Vacancy'],...rule.selectors.flatMap(selector=>[[selector.alias,selector.alias],
        ...model.VIEWS.flatMap(view=>model.ORIENTATIONS.map(orientation=>
          [[selector.alias,view,orientation].join('|'),`${selector.alias} · ${view.toUpperCase()} ${PLANE_LABELS[orientation]||orientation}`]))])];
    }
    function blankRule(){return {id:crypto.randomUUID(),name:'New Protocol',enabled:true,match:{modality:null,retrieveAE:null,bodyPart:null,description:null},
      selectors:[{alias:'Current1',role:'current',historical:false,modality:null,retrieveAE:null,bodyPart:null,description:null,laterality:null,order:'ascending',occurrence:1}],layout:{rows:1,cols:1,cells:['Current1']}};}
    function uniqueName(base){const used=new Set(library.rules.map(r=>fold(r.name))),stem=base.slice(0,56);let name=stem,n=2;while(used.has(fold(name)))name=(stem+' '+n++).slice(0,64);return name;}
    function render(){
      choose.textContent='';for(const rule of library.rules){const o=make('option',rule.name);o.value=rule.id;choose.append(o);}choose.value=selected||'';editor.textContent='';
      const rule=current();if(!rule){editor.append(make('p','저장된 규칙이 없습니다. New를 선택하세요.'));refresh();return;}
      addInput(editor,'Name',rule.name,i=>rule.name=cleanText(i,64));
      const enabled=make('input');enabled.type='checkbox';enabled.checked=rule.enabled;enabled.onchange=()=>{rule.enabled=enabled.checked;selectActive();markChanged();};const enabledLabel=make('label','Enabled');enabledLabel.prepend(enabled);editor.append(enabledLabel);
      const study=make('fieldset');study.append(make('legend','Study Match · empty means Any'));conditionEditor(study,rule.match,false);editor.append(study);
      const selectors=make('fieldset');selectors.append(make('legend','Series Selectors'));editor.append(selectors);
      rule.selectors.forEach((selector,index)=>{const box=make('section');box.dataset.selector=String(index);box.append(make('h4',selector.alias));
        addInput(box,'Alias (ASCII letter, then letters/numbers/_/-)',selector.alias,i=>{const old=selector.alias,next=cleanText(i,32);selector.alias=next;rule.layout.cells=rule.layout.cells.map(c=>renameCell(c,old,next));});
        addInput(box,'Role',selector.role,i=>{selector.role=i.value;selector.historical=selector.role==='related'&&selector.historical;},[['current','Current'],['related','Related']]);
        const historical=make('input');historical.type='checkbox';historical.checked=selector.historical;historical.disabled=selector.role!=='related';historical.onchange=()=>{selector.historical=historical.checked;markChanged();};const hlabel=make('label','Require strictly earlier study');hlabel.prepend(historical);box.append(hlabel);
        conditionEditor(box,selector,true);
        addInput(box,'Order',selector.order,i=>selector.order=i.value,[['ascending','Series Number ascending'],['descending','Series Number descending']]);
        addInput(box,'Occurrence',String(selector.occurrence),i=>selector.occurrence=Number(i.value));box.lastElementChild.querySelector('input').type='number';box.lastElementChild.querySelector('input').min='1';box.lastElementChild.querySelector('input').max='500';
        const remove=make('button','Remove Selector');remove.type='button';remove.onclick=()=>{rule.selectors.splice(index,1);rule.layout.cells=rule.layout.cells.map(c=>spec(c)?.alias===selector.alias?null:c);markChanged();render();};box.append(remove);selectors.append(box);});
      const add=make('button','Add Selector');add.type='button';add.dataset.requiresSelectorSlot='true';add.disabled=rule.selectors.length>=model.MAX_SELECTORS;add.onclick=()=>{const alias=uniqueAlias(rule,'Series');rule.selectors.push({alias,role:'related',historical:false,modality:null,retrieveAE:null,bodyPart:null,description:null,laterality:null,order:'ascending',occurrence:1});markChanged();render();};selectors.append(add);
      const layout=make('fieldset');layout.append(make('legend','Cell Layout · Vacancy leaves the cell empty'));editor.append(layout);
      layout.append(make('p','MPR 평면은 재구성할 수 있는 CT 시리즈에서만 적용됩니다. 같은 시리즈의 Axial·Sagittal·Coronal 세 칸이 일반적인 3평면 배치이며, 조건에 맞지 않으면 현재 화면을 그대로 둡니다.'));
      addInput(layout,'Grid',rule.layout.rows+'x'+rule.layout.cols,i=>{const [rows,cols]=i.value.split('x').map(Number),old=rule.layout.cells;rule.layout={rows,cols,cells:Array(rows*cols).fill(null).map((_,n)=>old[n]??null)};},[['1x1','1 × 1'],['1x2','1 × 2'],['2x2','2 × 2']]);
      rule.layout.cells.forEach((cell,index)=>addInput(layout,'Cell '+(index+1),cellValue(cell),i=>rule.layout.cells[index]=cellFromValue(i.value),cellOptions(rule)));
      refresh();
    }
    function uniqueAlias(rule,base){const used=new Set(rule.selectors.map(s=>fold(s.alias)));let alias=base,n=2;while(used.has(fold(alias)))alias=base+n++;return alias;}
    function strict(){const value=model.normalize(library);if(!value)throw Error('규칙의 이름, 조건, selector, Current cell을 확인하세요.');return value;}
    function saveLocal(value,message='이 브라우저에 규칙 초안을 저장했습니다.'){
      library=model.write(storage,key,value);selected=library.activeRuleId||library.rules[0]?.id||null;invalidateApplied();status.textContent=message;render();return library;
    }
    const ordered=state=>[...state.viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x);
    function stateSignature(){const state=grid.getState(),views=ordered(state);return JSON.stringify([state.layout,state.activeViewportId,views.map(v=>[v.viewportId,v.x,v.y,v.width,v.height,v.displaySetInstanceUIDs])]);}
    function objectId(value){if(!value||typeof value!=='object')return null;if(!objects.has(value))objects.set(value,++objectSequence);return objects.get(value);}
    function interactionFingerprint(){
      const state=grid.getState(),views=ordered(state).map(info=>{const viewport=services.cornerstoneViewportService?.getCornerstoneViewport?.(info.viewportId);let camera=null,properties=null;
        try{camera=viewport?.getCamera?.()||null;properties=viewport?.getProperties?.()||null;}catch(_){camera=properties='unavailable';}
        return [objectId(viewport),info.viewportId,info.displaySetInstanceUIDs,viewport?.getCurrentImageId?.()||null,viewport?.getCurrentImageIdIndex?.()??null,camera,properties];});
      const sources=displaySets.getActiveDisplaySets().map(value=>[objectId(value),objectId(value.images),value.displaySetInstanceUID,value.StudyInstanceUID,value.SeriesInstanceUID,value.images?.length??null]);
      return JSON.stringify([stateSignature(),views,sources]);
    }
    function navigationFingerprint(){
      const state=grid.getState(),layout=state.layout,views=ordered(state).map(value=>[value.x,value.y,value.width,value.height,value.displaySetInstanceUIDs]);
      const sources=displaySets.getActiveDisplaySets().map(value=>[objectId(value),objectId(value.images),value.displaySetInstanceUID,value.StudyInstanceUID,value.SeriesInstanceUID,value.images?.length??null]);
      return JSON.stringify([[layout?.layoutType,layout?.numRows,layout?.numCols],views,sources]);
    }
    // The camera keys the saved MPR job already treats as the physical position of a plane
    // (viewer-volume-job.js:43), so a rollback can put the user's own work back.
    const CAMERA_KEYS=['focalPoint','position','viewUp','viewPlaneNormal','parallelScale','flipHorizontal','flipVertical'];
    function cameraOf(viewportId){
      try{
        const camera=services.cornerstoneViewportService?.getCornerstoneViewport?.(viewportId)?.getCamera?.();if(!camera)return null;
        const value={};
        for(const key of CAMERA_KEYS){
          const part=camera[key];
          if(key==='parallelScale'){if(!Number.isFinite(part))return null;value[key]=part;continue;}
          if(key==='flipHorizontal'||key==='flipVertical'){value[key]=!!part;continue;}
          if(!Array.isArray(part)||part.length!==3||!part.every(Number.isFinite))return null;
          value[key]=[...part];
        }
        return value;
      }catch(_){return null;}
    }
    const sameCamera=(a,b)=>!!a&&!!b&&CAMERA_KEYS.every(key=>Array.isArray(a[key])?Array.isArray(b[key])&&a[key].every((n,i)=>Math.abs(n-b[key][i])<1e-6):typeof a[key]==='number'?Math.abs(a[key]-b[key])<1e-6:a[key]===b[key]);
    // Flips first, then the physical camera, exactly as viewer-volume-job.js:116 restores one.
    function setCamera(viewportId,camera){
      try{const viewport=services.cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);if(viewport?.type!=='orthographic')return;
        viewport.setCamera?.({flipHorizontal:camera.flipHorizontal,flipVertical:camera.flipVertical});
        const next={...camera};delete next.flipHorizontal;delete next.flipVertical;viewport.setCamera?.(next);viewport.render?.();}catch(_){}
    }
    function rollbackSnapshot(){
      const state=grid.getState(),layout=state.layout,views=ordered(state),rows=layout?.numRows,cols=layout?.numCols;
      if(layout?.layoutType!=='grid'||!Number.isInteger(rows)||!Number.isInteger(cols)||views.length!==rows*cols)return null;
      const cells=views.map((view,index)=>{const viewport=services.cornerstoneViewportService?.getCornerstoneViewport?.(view.viewportId);
        const sets=[...(view.displaySetInstanceUIDs||[])];
        if(Math.abs(view.x-(index%cols)/cols)>1e-6||Math.abs(view.y-Math.floor(index/cols)/rows)>1e-6)return null;
        if(!sets.length||viewport?.type==='stack')return {id:view.viewportId,sets,plane:null};
        // Only a plane this controller itself built can be rebuilt; any other non-stack
        // screen (a saved MPR job, VR) stays unknown and keeps refusing the whole apply.
        const owned=ownedPlanes.get(view.viewportId);
        if(!owned||viewport?.type!=='orthographic'||sets.length!==1||sets[0]!==owned.set)return null;
        // The rollback owes the user the screen actually in front of them, including a plane
        // the Crosshairs tool has since rotated. Without a readable camera we cannot promise
        // that, so the whole apply is refused here, before anything is destroyed.
        const camera=cameraOf(view.viewportId);
        return camera?{id:view.viewportId,sets,plane:owned.plane,camera}:null;});
      return cells.some(cell=>cell===null)?null:{rows,cols,active:state.activeViewportId,cells};
    }
    const PLANE_AXIS={axial:2,sagittal:0,coronal:1};
    // A fully loaded single volume of exactly the requested series, the same thing the MPR job
    // (viewer-volume-job.js:7-12) and the MPR Orientation panel (viewer-volume-orientation.js:23)
    // require before they trust a plane.
    function planeVolumeSops(viewport){
      const native=root.cornerstone,volume=native?.cache?.getVolume?.(viewport.getVolumeId?.()),ids=volume?.imageIds;
      if(!volume?.loadStatus?.loaded||!Array.isArray(ids)||ids.length<2||ids.length>256||volume.framesLoaded!==ids.length)return null;
      const sops=ids.map(id=>native?.metaData?.get?.('instance',id)?.SOPInstanceUID);
      return sops.every(value=>typeof value==='string'&&value)&&new Set(sops).size===sops.length?sops:null;
    }
    // A plane that silently fell back to a stack, never loaded its volume, or stood on another
    // plane than the cell asked for is not the requested cell.
    function planeIsCurrent(plane,viewportId,displaySet){
      if(!plane)return true;
      try{
        const viewport=services.cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);
        if(viewport?.type!=='orthographic'||viewport.getActors?.().length!==1)return false;
        const sops=planeVolumeSops(viewport),expected=displaySet?.images?.map(image=>image?.SOPInstanceUID);
        if(!sops||!Array.isArray(expected)||expected.length!==sops.length||expected.some(value=>!sops.includes(value)))return false;
        // Only the axis is asserted, not its sign: native orientation presets differ in sign
        // between versions, while an oblique or reset camera misses the axis entirely.
        const axis=PLANE_AXIS[plane.orientation],normal=viewport.getCamera?.()?.viewPlaneNormal;
        return Number.isInteger(axis)&&Array.isArray(normal)&&normal.length===3&&normal.every(value=>Number.isFinite(value))&&
          normal.every((value,index)=>Math.abs(index===axis?Math.abs(value)-1:value)<=1e-3);
      }catch(_){return false;}
    }
    // Layout identity is what this controller owns and can roll back; the plane reality below
    // is what makes an apply acceptable. Keeping them apart means a volume that failed or is
    // still loading is rolled back to the previous screen instead of quarantining the panel.
    function layoutIsCurrent(ids,result){const state=grid.getState(),views=ordered(state);
      return state.layout?.numRows===result.rule.layout.rows&&state.layout?.numCols===result.rule.layout.cols&&views.length===ids.length&&views.every((view,index)=>view.viewportId===ids[index]&&JSON.stringify(view.displaySetInstanceUIDs||[])===JSON.stringify(result.cells[index]?[result.cells[index].displaySetInstanceUID]:[]));}
    function targetIsCurrent(ids,result){const planes=result.rule.layout.cells.map(plane);
      return layoutIsCurrent(ids,result)&&planes.every((value,index)=>planeIsCurrent(value,ids[index],result.cells[index]));}
    function boundedNative(promise,{signal=null,timeout=0}={}){
      const task=Promise.resolve(promise);task.catch(()=>{});
      return new Promise((resolve,reject)=>{
        let settled=false,timer=null;const finish=(fn,value)=>{if(settled)return;settled=true;if(timer!==null)clearTimeout(timer);signal?.removeEventListener?.('abort',aborted);fn(value);};
        const aborted=()=>finish(reject,new DOMException('Aborted','AbortError'));
        task.then(value=>finish(resolve,value),error=>finish(reject,error));
        if(signal){if(signal.aborted)aborted();else signal.addEventListener('abort',aborted,{once:true});}
        if(timeout>0&&!settled)timer=setTimeout(()=>finish(reject,Error('Native layout timeout')),timeout);
      });
    }
    // A plane has to load its volume before it can be judged, so a rule with plane cells waits
    // the volume budget the saved MPR job also allows itself (viewer-volume-job.js:71).
    const planeBudget=result=>result.rule.layout.cells.some(plane)?{limit:1200,timeout:30000}:{limit:80,timeout:10000};
    // A plane whose volume is already loaded on a ready cell will not start standing on the
    // requested series or plane by waiting longer; that is a failure now, not in 30 seconds.
    function planeSettledWrong(ids,result){
      const state=grid.getState();
      return result.rule.layout.cells.map(plane).some((value,index)=>{
        if(!value||!state.viewports.get(ids[index])?.isReady)return false;
        try{
          const viewport=services.cornerstoneViewportService?.getCornerstoneViewport?.(ids[index]);
          if(viewport?.type!=='orthographic'||viewport.getActors?.().length!==1||!planeVolumeSops(viewport))return false;
        }catch(_){return false;}
        return !planeIsCurrent(value,ids[index],result.cells[index]);
      });
    }
    async function waitForTarget(ids,result,signal,beforeGeneration){
      const {limit}=planeBudget(result);
      for(let count=0;count<limit;count++){
        if(targetIsCurrent(ids,result))return;
        if(layoutIsCurrent(ids,result)&&planeSettledWrong(ids,result))break;
        if(signal.aborted)throw new DOMException('Aborted','AbortError');
        if(ended||!live()||beforeGeneration!==generation)throw Error('규칙이나 영상 표시 상태가 변경되어 적용하지 않았습니다.');
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw Error(layoutIsCurrent(ids,result)&&result.rule.layout.cells.some(plane)
        ?'요청한 MPR 볼륨이나 평면 방향을 확인하지 못해 이전 화면으로 되돌립니다.'
        :'영상 배치 완료를 확인하지 못해 현재 적용 기준을 갱신하지 않았습니다.');
    }
    function snapshotIsCurrent(snapshot){const state=grid.getState(),views=ordered(state);return state.layout?.numRows===snapshot.rows&&state.layout?.numCols===snapshot.cols&&views.length===snapshot.cells.length&&views.every((view,index)=>view.viewportId===snapshot.cells[index].id&&JSON.stringify(view.displaySetInstanceUIDs||[])===JSON.stringify(snapshot.cells[index].sets))&&
      // A plane rebuilt on its recorded orientation is not the screen the user was working in.
      snapshot.cells.every(cell=>!cell.plane||sameCamera(cameraOf(cell.id),cell.camera));}
    async function observeLateTarget(ids,result,beforeGeneration,beforeInteraction,userChanged){
      for(let count=0;count<80;count++){
        if(ended||!live()||beforeGeneration!==generation||userChanged()||!workspaceSafe())return null;
        if(layoutIsCurrent(ids,result))return interactionFingerprint();
        if(interactionFingerprint()!==beforeInteraction)return null;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      return null;
    }
    async function restoreOwnedTarget(snapshot,ids,result,ownedFingerprint,beforeGeneration,userChanged){
      if(ended||!live()||beforeGeneration!==generation||userChanged()||!workspaceSafe()||!layoutIsCurrent(ids,result)||interactionFingerprint()!==ownedFingerprint)return false;
      const deadline=Date.now()+2000;try{await boundedNative(restore(snapshot),{timeout:2000});}catch(_){return false;}
      for(let count=0;count<80&&Date.now()<deadline;count++){
        restorePlaneCameras(snapshot);
        if(snapshotIsCurrent(snapshot))return true;
        if(ended||!live()||beforeGeneration!==generation||userChanged()||!workspaceSafe()||!layoutIsCurrent(ids,result)||interactionFingerprint()!==ownedFingerprint)return false;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      return false;
    }
    const restore=snapshot=>grid.setLayout({numRows:snapshot.rows,numCols:snapshot.cols,activeViewportId:snapshot.active,isHangingProtocolLayout:false,
      findOrCreateViewport:index=>viewportRequest(snapshot.cells[index].id,snapshot.cells[index].sets,snapshot.cells[index].plane)});
    // Rebuilding the plane restores the requested orientation, not the camera the user left
    // behind; the recorded one is put back as soon as the rebuilt plane can take it.
    function restorePlaneCameras(snapshot){for(const cell of snapshot.cells)if(cell.plane&&!sameCamera(cameraOf(cell.id),cell.camera))setCamera(cell.id,cell.camera);}
    function workspaceSafe(){
      for(const name of ['kinViewerJobWorkspaceState','kinViewerHistoryWorkspaceState']){const value=typeof root[name]==='function'?root[name]():null;if(value?.dirty||value?.busy)return false;}
      if(typeof root.kinViewerHistoryHasUnsaved==='function'&&root.kinViewerHistoryHasUnsaved())return false;
      if(root.kinMprMarks?.dirty?.())return false;
      return true;
    }
    function urlStudies(){const query=new URLSearchParams(location.search),all=query.getAll('StudyInstanceUIDs');if(all.length!==1)return null;const values=all[0].split(',');return values.length>=1&&values.length<=2?values:null;}
    async function json(response){try{return await response.json();}catch(_){throw Error('계정 응답 형식을 확인할 수 없습니다.');}}
    function sameOwner(value){return !!boundOwner&&value&&value.institution===boundOwner.institution&&value.subject===boundOwner.subject&&Object.keys(value).length===2;}
    function accountValue(data){if(!data||!sameOwner(data.owner)||!Number.isInteger(data.revision)||data.revision<0||data.revision>2147483647||data.value!==null&&!model.normalize(data.value))throw Error('계정 Hanging Protocol 응답을 확인할 수 없습니다.');return data;}
    async function session(signal){const response=await fetcher('/api/me',{credentials:'same-origin',cache:'no-store',signal,headers:{'X-KIN-CSRF':'1'}});if(!response.ok)throw Error('계정 세션을 확인할 수 없습니다.');const me=await json(response);if(!boundOwner||me.kind!=='member'||me.institution!==boundOwner.institution||me.sub!==boundOwner.subject)throw Error('계정이 변경되어 작업을 적용하지 않았습니다.');return me;}
    async function verifiedContext(signal){
      if(typeof options.access==='function')return options.access({signal,owner:boundOwner});
      await session(signal);const response=await fetcher('/api/studies',{credentials:'same-origin',cache:'no-store',signal,headers:{'X-KIN-CSRF':'1'}});if(!response.ok)throw Error('검사 접근 권한을 확인할 수 없습니다.');
      const data=await json(response),uids=urlStudies();if(!uids||!Array.isArray(data.studies))throw Error('현재 검사 범위를 확인할 수 없습니다.');const studies=uids.map(uid=>data.studies.find(s=>s.uid===uid));if(studies.some(v=>!v))throw Error('현재 검사 접근 권한을 확인할 수 없습니다.');return {studies,displaySets:displaySets.getActiveDisplaySets()};
    }
    async function runApply(firstMatch=false,navigation=null){
      if(busy||ended||!live())return;if(layoutQuarantined){status.textContent='이전 배치 요청의 완료를 확인하지 못했습니다. 뷰어 창을 닫고 다시 열어 주세요.';return;}if(!workspaceSafe()){status.textContent='저장하지 않은 영상 작업이 있어 배치를 변경하지 않았습니다.';return;}
      let value;try{value=strict();}catch(error){status.textContent=error.message;return;}
      if(navigation&&appliedCursor&&appliedFingerprint!==navigationFingerprint())invalidateApplied();
      busy=true;refresh();const before=interactionFingerprint(),beforeGeneration=generation;request=new AbortController();let timer=setTimeout(()=>request.abort(),10000);let interactionArmed=false,userInteracted=false;
      const noteInteraction=()=>{if(interactionArmed)userInteracted=true;};for(const type of ['pointerdown','wheel','keydown'])document.addEventListener(type,noteInteraction,true);queueMicrotask(()=>interactionArmed=true);status.textContent='검사와 규칙을 확인 중…';
      try{
        const context=await boundedNative(verifiedContext(request.signal),{signal:request.signal});if(request.signal.aborted||ended||!live()||beforeGeneration!==generation||before!==interactionFingerprint())throw Error('규칙이나 영상 표시 상태가 변경되어 적용하지 않았습니다.');
        const resolveContext={studies:context.studies,displaySets:context.displaySets||displaySets.getActiveDisplaySets()};
        const result=navigation?model.navigate(value,resolveContext,appliedCursor,navigation):model.resolve(value,resolveContext,firstMatch?null:selected);
        if(result.kind==='no-match'){
          status.textContent=navigation?(result.reason==='end'?`${navigation==='next'?'Next':'Previous'} Protocol: 저장 순서의 끝입니다. 현재 배치를 유지합니다.`:`${navigation==='next'?'Next':'Previous'} Protocol: 현재 검사와 일치하는 규칙이 없습니다. 현재 배치를 유지합니다.`):'일치하는 규칙이 없어 현재 배치를 유지합니다.';return;
        }
        if(!workspaceSafe())throw Error('영상 작업 상태가 바뀌어 배치를 변경하지 않았습니다.');
        const snapshot=rollbackSnapshot();if(!snapshot)throw Error('일반 영상 격자 또는 이 규칙으로 만든 MPR 배치에서만 Hanging Protocol을 적용할 수 있습니다. 현재 배치를 유지합니다.');
        const ids=result.cells.map(()=>`kin-hp-${crypto.randomUUID()}`),active=result.cells.findIndex(Boolean);
        const planes=result.rule.layout.cells.map(plane);
        // The network phase keeps its 10s bound; only a plane apply gets the volume budget.
        const budget=planeBudget(result);if(budget.timeout!==10000){clearTimeout(timer);timer=setTimeout(()=>request.abort(),budget.timeout);}
        let targetFingerprint=null,nativeSettled=false;
        try{const pending=Promise.resolve(grid.setLayout({numRows:result.rule.layout.rows,numCols:result.rule.layout.cols,activeViewportId:ids[Math.max(0,active)],isHangingProtocolLayout:false,
          findOrCreateViewport:index=>viewportRequest(ids[index],result.cells[index]?[result.cells[index].displaySetInstanceUID]:[],planes[index])}));
          pending.then(()=>nativeSettled=true,()=>nativeSettled=true);
          if(targetIsCurrent(ids,result))targetFingerprint=interactionFingerprint();await boundedNative(pending,{signal:request.signal});if(!targetIsCurrent(ids,result))await waitForTarget(ids,result,request.signal,beforeGeneration);if(targetFingerprint===null)targetFingerprint=interactionFingerprint();
          if(request.signal.aborted)throw new DOMException('Aborted','AbortError');
          if(ended||!live()||beforeGeneration!==generation||!targetIsCurrent(ids,result)||targetFingerprint!==interactionFingerprint())throw Error('규칙이나 영상 표시 상태가 변경되어 적용 기준을 갱신하지 않았습니다.');}
        catch(error){
          let owned=targetFingerprint!==null&&!userInteracted&&workspaceSafe()&&layoutIsCurrent(ids,result)&&targetFingerprint===interactionFingerprint()?targetFingerprint:null;
          if(owned===null&&targetFingerprint===null&&beforeGeneration===generation&&live()&&!ended)owned=await observeLateTarget(ids,result,beforeGeneration,before,()=>userInteracted);
          const restored=owned!==null&&await restoreOwnedTarget(snapshot,ids,result,owned,beforeGeneration,()=>userInteracted);
          if(!restored||!nativeSettled){layoutQuarantined=true;invalidateApplied();const uncertain=Error('배치 요청 또는 복원 완료를 확인하지 못했습니다. 현재 영상을 확인하고 뷰어 창을 닫은 뒤 다시 열어 주세요.');uncertain.name='KinLayoutUnconfirmed';throw uncertain;}
          throw error;
        }
        // Remember the planes this apply owns so a later apply can still roll back to them.
        ownedPlanes=new Map(ids.map((id,index)=>[id,{plane:planes[index],set:result.cells[index]?.displaySetInstanceUID??null}]).filter(([,value])=>value.plane));
        appliedCursor=result.rule.id;appliedFingerprint=navigationFingerprint();appliedName=result.rule.name;applied.textContent=`Applied Protocol: ${appliedName}`;status.textContent=`Applied: ${result.rule.name} · Current/Related 영상을 확인하세요.`;
      }catch(error){if(!ended)status.textContent=error?.name==='AbortError'?'응답 시간이 지나 현재 배치를 유지합니다.':error.message;}finally{clearTimeout(timer);for(const type of ['pointerdown','wheel','keydown'])document.removeEventListener(type,noteInteraction,true);request=null;busy=false;refresh();}
    }
    async function account(action){
      if(busy||ended||!boundOwner)return;let value=null;
      try{if(action==='save')value=strict();}catch(error){status.textContent=error.message;return;}
      if(action!=='load'&&revision===null){status.textContent='먼저 Load from Account로 최신 revision을 확인하세요.';return;}
      busy=true;refresh();const before=generation;request=new AbortController();const timer=setTimeout(()=>request.abort(),10000);status.textContent='계정 설정 확인 중…';
      try{
        const method=action==='load'?'GET':'PUT',body=method==='GET'?undefined:JSON.stringify({expectedOwner:boundOwner,revision,value:action==='reset'?null:value});
        const response=await fetcher(endpoint,{method,credentials:'same-origin',cache:'no-store',signal:request.signal,headers:{'X-KIN-CSRF':'1',...(body?{'Content-Type':'application/json'}:{})},body});const raw=await json(response);
        if(!response.ok)throw Error(response.status===409?'다른 창에서 규칙이 바뀌었습니다. 다시 불러오세요.':'계정 저장 여부를 확인하지 못했습니다. 다시 불러오세요.');
        const data=accountValue(raw);
        await session(request.signal);if(ended||!live())return;
        if(action==='load'&&before!==generation)throw Error('편집 중 규칙이 바뀌어 계정 값을 불러오지 않았습니다.');
        revision=data.revision;
        if(action==='load'){invalidateApplied();if(data.value)saveLocal(data.value,'계정 규칙을 불러와 이 브라우저에 저장했습니다. Apply를 눌러 적용하세요.');else status.textContent='계정에 저장된 Hanging Protocol이 없습니다.';}
        else if(action==='reset')status.textContent='계정 규칙을 초기화했습니다. 현재 초안과 화면은 유지됩니다.';
        else status.textContent=before===generation?'계정에 규칙을 저장했습니다.':'요청 당시 규칙을 저장했습니다. 이후 편집은 저장되지 않았습니다.';
      }catch(error){if(!ended)status.textContent=error?.name==='AbortError'||error instanceof TypeError?'계정 응답을 확인하지 못했습니다. 다시 불러오세요.':error.message;}finally{clearTimeout(timer);request=null;busy=false;refresh();}
    }
    function refresh(){buttons().forEach(control=>{
      if(control.id==='kin-hp-import'){control.disabled=busy||ended||!boundOwner;return;}
      if(control.tagName!=='BUTTON')return;
      const needsRule=['kin-hp-duplicate','kin-hp-delete','kin-hp-up','kin-hp-down','kin-hp-apply'].includes(control.id)||control.textContent==='Remove Selector';
      const needsOwner=['kin-hp-save-local','kin-hp-load-account','kin-hp-save-account','kin-hp-reset-account'].includes(control.id);
      const needsRevision=['kin-hp-save-account','kin-hp-reset-account'].includes(control.id);
      control.disabled=busy||ended||layoutQuarantined&&['kin-hp-apply','kin-hp-apply-first','kin-hp-previous','kin-hp-next'].includes(control.id)||needsRule&&!current()||needsOwner&&!boundOwner||needsRevision&&revision===null||control.dataset.requiresSelectorSlot==='true'&&current()?.selectors.length>=model.MAX_SELECTORS||control.id==='kin-hp-new'&&library.rules.length>=model.MAX_RULES||['kin-hp-apply-first','kin-hp-previous','kin-hp-next'].includes(control.id)&&!library.rules.some(rule=>rule.enabled);
    });choose.disabled=busy||ended||library.rules.length===0;}
    choose.onchange=()=>{selected=choose.value||null;selectActive();generation++;refresh();render();};
    toolbar.addEventListener('click',event=>{const action=event.target.dataset.action;if(!action)return;const index=library.rules.findIndex(r=>r.id===selected),rule=current();
      if(action==='new'){const next=blankRule();next.name=uniqueName(next.name);library.rules.push(next);selected=next.id;}
      if(action==='duplicate'&&rule){const next=clone(rule);next.id=crypto.randomUUID();next.name=uniqueName(rule.name+' Copy');library.rules.splice(index+1,0,next);selected=next.id;}
      if(action==='delete'&&rule){library.rules.splice(index,1);selected=library.rules[Math.min(index,library.rules.length-1)]?.id||null;}
      if(action==='up'&&index>0)[library.rules[index-1],library.rules[index]]=[library.rules[index],library.rules[index-1]];
      if(action==='down'&&index>=0&&index<library.rules.length-1)[library.rules[index],library.rules[index+1]]=[library.rules[index+1],library.rules[index]];
      selectActive();markChanged();render();});
    operations.addEventListener('click',event=>{const action=event.target.dataset.operation;if(!action)return;
      if(action==='apply'||action==='apply-first')runApply(action==='apply-first');else if(action==='previous'||action==='next')runApply(false,action);else if(action==='save-local'){try{saveLocal(strict());}catch(error){status.textContent=error.message;}}
      else if(action==='load-account')account('load');else if(action==='save-account')account('save');else if(action==='reset-account')account('reset');
      else if(action==='export'){try{const blob=new Blob([JSON.stringify(strict(),null,2)+'\n'],{type:'application/json'}),a=make('a');a.href=URL.createObjectURL(blob);a.download='hanging-protocols.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),0);status.textContent='환자 정보 없이 규칙 정의를 내보냈습니다.';}catch(error){status.textContent=error.message;}}});
    importInput.onchange=async()=>{
      const file=importInput.files?.[0],before=generation;importInput.value='';if(!file)return;
      try{
        if(file.size>65536)throw Error('가져올 파일이 너무 큽니다.');
        const value=model.normalize(JSON.parse(await file.text()));
        if(ended||!live())return;
        if(before!==generation)throw Error('편집 중 규칙이 바뀌어 파일을 가져오지 않았습니다.');
        if(!value)throw Error('가져올 규칙 형식이 잘못되었습니다.');
        library=value;selected=value.activeRuleId||value.rules[0]?.id||null;markChanged();render();status.textContent='규칙을 초안으로 가져왔습니다. Save Draft 또는 Save to Account를 선택하세요.';
      }catch(error){if(!ended)status.textContent=error instanceof SyntaxError?'가져올 JSON 형식이 잘못되었습니다.':error.message;}
    };
    function end(){ended=true;request?.abort();channel?.close();subscriptions.splice(0).forEach(value=>{try{value?.unsubscribe?.();}catch(_){}});root.removeEventListener?.('storage',storageEnd);refresh();}
    const storageEnd=event=>{if(event.key==='kin-session-ended')end();};root.addEventListener?.('storage',storageEnd);try{channel=new BroadcastChannel('kin-session');channel.onmessage=event=>{if(event.data?.type==='session-ended')end();};}catch(_){}
    const navigationChanged=()=>{if(!busy&&appliedCursor&&appliedFingerprint!==navigationFingerprint()){invalidateApplied();refresh();}};
    for(const service of [grid,displaySets])for(const event of new Set(Object.values(service?.EVENTS||{})))try{subscriptions.push(service.subscribe(event,navigationChanged));}catch(_){}
    render();return {read:()=>clone(library),apply:runApply,end,account,save:()=>saveLocal(strict()),generation:()=>generation};
  }
  root.KinViewerHangingProtocol={mount};if(typeof module==='object'&&module.exports)module.exports=root.KinViewerHangingProtocol;
})(typeof globalThis==='object'?globalThis:this);
