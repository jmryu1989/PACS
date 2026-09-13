window.kinCreateVolumeCurved=function({target,permitted,alive,owner,host}){
  // Manual curved/freehand MPR on one plane of the three-plane target. The person places every
  // point; nothing here looks at image content to find a path. Results are derived displays.
  const model=window.KinVolumeCurved,identity=JSON.stringify(owner()),records=new Map(),scalars=new WeakMap(),NS='http://www.w3.org/2000/svg';
  let ended=false,bound=null,armed=false,drag=null,stroke=null,selected=-1,generation=0,settle=null,swallow=false,drawn=null;
  const live=()=>{try{return !ended&&alive()&&JSON.stringify(owner())===identity;}catch(_){return false;}};
  const elsewhere=()=>{try{return !!window.kinViewerJobWorkspaceState?.().busy||!!window.kinVolumeBatchState?.busy?.()||!!window.kinMprRenderingState?.busy?.();}catch(_){return true;}};
  const allowed=()=>{try{return live()&&permitted()&&!elsewhere();}catch(_){return false;}};
  const panel=document.createElement('section');panel.id='kin-mpr-curved';panel.style.cssText='border-top:1px solid #657c9f;padding:8px 0';host.append(panel);
  panel.innerHTML='<strong>Curved MPR</strong><p>한 MPR 평면 위에 사람이 직접 찍거나 그린 곡선을 따라 원본 CT 값(HU)을 펼쳐 보여 주는 재구성 표시입니다. 영상 내용으로 경로를 자동으로 찾지 않습니다. 결과는 원본 영상이 아니며, 가로축은 곡선을 따라 잰 길이라서 화면 위 직선 거리나 측정 의미가 없습니다. Save New Job으로 곡선과 계산·표시 조건을 저장합니다.</p>'+
    '<label>Curve Type <select aria-label="Curve Type"><option value="curved">Curved</option><option value="freehand">Freehand</option></select></label> <label>Half Height (mm) <input type="number" aria-label="Curved MPR Half Height" min="1" max="150" step="1" value="20" style="width:70px"></label> '+
    '<button type="button" data-action="draw">Draw Curve</button> <button type="button" data-action="finish">Finish Drawing</button> <button type="button" data-action="delete">Delete Point</button> <button type="button" data-action="clear">Clear Curve</button> <button type="button" data-action="go">Go to Curve Plane</button>'+
    '<p data-kin-curved-state>No Curve</p><div class="result" hidden><p class="badge" style="color:#5fd0ff;font-weight:bold">CURVED MPR · Derived display · Not a source image</p><canvas aria-label="Curved MPR result" style="display:block;width:100%;height:auto;max-height:360px;object-fit:contain;image-rendering:pixelated;background:#000"></canvas><p class="caption"></p><p class="note">가로축은 곡선을 따라 잰 길이, 세로축은 그리기 평면의 수직 방향입니다. 화면 위 직선 거리·측정 의미가 없고 원본 영상이 아닙니다. 짙은 파란 표본은 볼륨 밖입니다. 측정·표식·출력은 지원하지 않습니다.</p></div><div class="drafts"></div><p role="status"></p>';
  const typeInput=panel.querySelector('select'),heightInput=panel.querySelector('input[type=number]'),stateText=panel.querySelector('[data-kin-curved-state]'),status=panel.querySelector('[role=status]');
  const resultBox=panel.querySelector('.result'),canvas=panel.querySelector('canvas'),caption=panel.querySelector('.caption'),drafts=panel.querySelector('.drafts');
  const buttons=Object.fromEntries([...panel.querySelectorAll('button[data-action]')].map(b=>[b.dataset.action,b]));
  const volume=t=>cornerstone.cache.getVolume(t.views[0].getVolumeId());
  const keyOf=t=>JSON.stringify({study:t.source.uid,series:t.source.series,sops:volume(t).imageIds.map(id=>cornerstone.metaData.get('instance',id).SOPInstanceUID)});
  function record(t){const key=keyOf(t);if(!records.has(key))records.set(key,{source:[t.source.uid,t.source.series],value:null,saved:'null',final:null,preview:null,failed:null,seen:null});return records.get(key);}
  const changed=r=>JSON.stringify(r.value)!==r.saved;
  const dirty=()=>live()&&(armed||!!drag||!!stroke||[...records.values()].some(changed));
  // The display window re-rasters a result; everything else in the curve defines one.
  const signature=value=>{if(!value)return null;const {display,...rest}=value;return JSON.stringify(rest);};
  const geometry=t=>{const v=volume(t);return {origin:Array.from(v.origin),direction:Array.from(v.direction),spacing:Array.from(v.spacing),dimensions:Array.from(v.dimensions)};};
  const finest=t=>Math.min(...volume(t).spacing);
  const frameOfReference=t=>cornerstone.metaData.get('instance',volume(t).imageIds[0])?.FrameOfReferenceUID;
  const displayOf=p=>({voiRange:{lower:p?.voiRange?.lower,upper:p?.voiRange?.upper},VOILUTFunction:p?.VOILUTFunction||'LINEAR',invert:!!p?.invert});
  const displayKey=p=>JSON.stringify(displayOf(p));
  const rebuild=(value,changes)=>model.build({...value,spacing:value.output.spacing,halfHeight:value.output.halfHeight,...changes});

  // The cached native volume scalars are the HU the planes show (proved by the native slope and
  // intercept fixture); they are read once per loaded volume and never rescaled again here.
  function source(t){
    const v=volume(t),g=geometry(t),manager=v?.voxelManager;
    if(typeof manager?.getCompleteScalarDataArray!=='function')throw Error('원본 화소 배열을 확인할 수 없어 곡면 MPR을 계산하지 않았습니다.');
    const count=g.dimensions.reduce((a,b)=>a*b,1);if(count>model.LIMITS.voxels)throw Error('원본 볼륨이 곡면 MPR 계산 한도를 넘습니다.');
    let data=scalars.get(v);if(!data){data=manager.getCompleteScalarDataArray();if(data?.length===count)scalars.set(v,data);}
    if(!data||data.length!==count)throw Error('원본 화소 배열 길이가 볼륨 크기와 달라 곡면 MPR을 계산하지 않았습니다.');
    const toIndex=model.affine(g),last=g.dimensions.map(n=>n-1);
    for(const probe of [[0,0,0],last,[last[0],0,Math.floor(last[2]/2)]]){
      const back=toIndex(Array.from(v.imageData.indexToWorld(probe)));
      if(back.some((n,i)=>!(Math.abs(n-probe[i])<=1e-6)))throw Error('원본 볼륨 좌표 변환을 확인할 수 없어 곡면 MPR을 계산하지 않았습니다.');
    }
    return {scalars:data,dimensions:g.dimensions,worldToIndex:toIndex};
  }
  // One request at a time: every chunk re-checks generation, owner, screen and the curve itself,
  // so a late chunk of an earlier curve can never become the shown or saved result.
  async function run(r,t,mine,kind,{current=()=>true,deadline=Infinity}={}){
    const spec=r.value,key=signature(spec),loaded=volume(t);
    const valid=()=>{try{return mine===generation&&live()&&current()&&Date.now()<deadline&&records.get(keyOf(t))===r&&signature(r.value)===key&&target()?.group===t.group;}catch(_){return false;}};
    try{
      if(!valid())return 'stale';
      const steps=model.reconstruct(spec,source(t),kind==='preview'?{spacing:spec.output.spacing*2}:{});
      for(;;){
        const step=steps.next();
        if(step.done){if(!valid())return 'stale';r[kind]={signature:key,volume:loaded,result:step.value};if(kind==='final')r.failed=null;show();return 'done';}
        await new Promise(resolve=>setTimeout(resolve,0));
        if(!valid())return 'stale';
      }
    }catch(error){
      if(!valid())return 'stale';
      if(kind==='final'){r.failed={signature:key,volume:loaded,message:error.message};status.textContent=error.message;show();}
      return 'failed';
    }
  }
  function request({final=true}={}){
    if(!bound)return;
    const t=bound,r=record(t),mine=++generation,key=signature(r.value);clearTimeout(settle);r.requested={key,volume:volume(t)};show();
    if(!model.normalize(r.value)||r.final?.signature===key&&r.final.volume===volume(t))return;
    (async()=>{
      if(r.preview?.signature!==key&&await run(r,t,mine,'preview')==='stale')return;
      if(!final||mine!==generation)return;
      settle=setTimeout(()=>{if(mine===generation&&!drag&&!stroke)run(r,t,mine,'final');},150);
    })();
  }
  function cancel(){generation++;clearTimeout(settle);armed=false;drag=null;stroke=null;selected=-1;swallow=false;}

  function show(){
    const r=bound&&record(bound),value=r?.value,key=signature(value),loaded=bound&&volume(bound);let label='No Curve',result=null;
    if(value){
      if(!model.normalize(value))label='Incomplete';
      else if(r.final?.signature===key&&r.final.volume===loaded){label='Final';result=r.final.result;}
      else if(r.failed?.signature===key&&r.failed.volume===loaded)label='Failed';
      else if(r.preview?.signature===key&&r.preview.volume===loaded){label='Preview · refining';result=r.preview.result;}
      else label='Stale · recomputing';
    }
    if(armed||stroke)label='Drawing · '+label;
    stateText.textContent=label;resultBox.hidden=!result;canvas.dataset.kinCurvedState=result?label:'';
    if(!result){drawn=null;return;}
    const display=JSON.stringify(value.display);
    if(drawn?.result!==result||drawn.display!==display){
      canvas.width=result.columns;canvas.height=result.rows;
      canvas.getContext('2d').putImageData(new ImageData(model.raster(result,value.display),result.columns,result.rows),0,0);
      drawn={result,display};
    }
    caption.textContent=(label==='Final'?'Final · '+model.ALGORITHM:'Preview · refining · 최종 결과가 아닙니다')+' · '+(value.kind==='curved'?'Curved':'Freehand')+' · Arc length '+result.length.toFixed(2)+' mm · Half height '+value.output.halfHeight+' mm · Spacing '+result.spacing+' mm · '+result.columns+'×'+result.rows+' samples · Outside '+result.outside;
  }
  function paint(){
    if(!bound||!live())return;
    const value=record(bound).value;
    for(const item of bound.items){
      const {view,overlay,index}=item,c=view.getCanvas(),camera=view.getCamera(),drawing=stroke?.item===item;
      const points=drawing?stroke.points:value&&value.cell===index?value.points:[];
      const signature=JSON.stringify([points,value?.plane,value?.kind,selected,camera,c.clientWidth,c.clientHeight]);
      if(item.signature===signature)continue;item.signature=signature;overlay.replaceChildren();
      if(!points.length)continue;
      const state=value?model.planeState(camera,value.plane):{offset:0,aligned:true},on=state.aligned&&Math.abs(state.offset)<=.01;
      const svg=document.createElementNS(NS,'svg');svg.style.cssText='position:absolute;inset:0;width:100%;height:100%;overflow:hidden';
      const line=document.createElementNS(NS,'polyline'),path=drawing||points.length<2?points:model.polyline(points,value.kind);
      for(const [k,v] of Object.entries({points:path.map(p=>Array.from(view.worldToCanvas(p)).join(',')).join(' '),fill:'none',stroke:'#5fd0ff','stroke-width':2,...(on?{}:{'stroke-dasharray':'6 4'})}))line.setAttribute(k,String(v));
      svg.append(line);
      if(!drawing)points.forEach((p,i)=>{const xy=view.worldToCanvas(p),dot=document.createElementNS(NS,'circle');dot.dataset.kinCurvedPoint=String(i);for(const [k,v] of Object.entries({cx:xy[0],cy:xy[1],r:i===selected?6:4,fill:i===selected?'#ffdc7c':'#5fd0ff',stroke:'#10202c'}))dot.setAttribute(k,String(v));svg.append(dot);});
      const label=document.createElement('span');label.dataset.kinCurvedPlane=on?'on':'off';label.style.cssText='position:absolute;left:6px;bottom:6px;color:#5fd0ff;background:#182030ee;padding:2px 4px;font-size:12px';
      label.textContent=on?'Curve plane · Curved MPR path':(state.aligned?(state.offset>0?'+':'')+state.offset.toFixed(2)+' mm off curve plane':'Different orientation from curve plane')+' · editing disabled';
      overlay.append(svg,label);
    }
  }

  // Gestures are resolved at window capture: a host node laid over a pane, or a host capture
  // listener that consumes the first press on a not-yet-active pane, must not lose a point.
  // A press is the pane's when it lands inside the pane element, or over the pane on a host node
  // that is not a control.
  const control=e=>e.target instanceof Element&&(host.contains(e.target)||!!e.target.closest('button,input,select,textarea,a[href],[role=button],[role=menu],[role=menuitem],[role=dialog]'));
  const itemOf=e=>{
    if(!bound)return null;
    const inside=bound.items.find(item=>e.target instanceof Node&&item.view.element.contains(e.target));
    if(inside||control(e))return inside||null;
    return bound.items.find(item=>{const r=item.view.element.getBoundingClientRect();return e.clientX>=r.left&&e.clientX<r.right&&e.clientY>=r.top&&e.clientY<r.bottom;})||null;
  };
  const at=(item,e)=>{const rect=item.view.element.getBoundingClientRect();return model.round(Array.from(item.view.canvasToWorld([e.clientX-rect.left,e.clientY-rect.top])));};
  const stop=e=>{e.preventDefault();e.stopImmediatePropagation();};
  function editable(item,value){
    if(!value)return;
    if(item.index!==value.cell)throw Error('곡선을 그린 평면에서만 점을 편집할 수 있습니다.');
    const state=model.planeState(item.view.getCamera(),value.plane);
    if(!state.aligned||Math.abs(state.offset)>.01)throw Error('그리기 평면에서 벗어나 편집할 수 없습니다. Go to Curve Plane으로 돌아간 뒤 편집하세요.');
  }
  function hit(item,value,e){
    if(!value||item.index!==value.cell)return -1;
    const rect=item.view.element.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;let best=-1,nearest=6;
    value.points.forEach((p,i)=>{const xy=item.view.worldToCanvas(p),d=Math.hypot(xy[0]-x,xy[1]-y);if(d<=nearest){nearest=d;best=i;}});
    return best;
  }
  // The drawing plane is the clicked plane's camera at the first point and never follows it later.
  function start(t,item){
    const camera=item.view.getCamera(),normal=model.unit(camera.viewPlaneNormal),along=camera.viewUp.reduce((s,n,i)=>s+n*normal[i],0);
    const viewUp=model.unit(camera.viewUp.map((n,i)=>n-along*normal[i])),display=displayOf(item.view.getProperties()),frame=frameOfReference(t),height=Number(heightInput.value),kind=typeInput.value;
    if(display.VOILUTFunction!=='LINEAR')throw Error('곡면 MPR은 LINEAR 창 설정 표시에서만 계산합니다. 창 설정 함수를 LINEAR로 바꾼 뒤 그리세요.');
    if(!frame)throw Error('원본 좌표계(Frame of Reference)를 확인할 수 없어 곡선을 그리지 않았습니다.');
    if(!Number.isFinite(height)||height<1||height>150)throw Error('Half Height는 1~150 mm로 입력하세요.');
    return {kind,frameOfReference:frame,cell:item.index,plane:{origin:model.round(camera.focalPoint),normal,viewUp},points:[],spacing:finest(t),halfHeight:height,display};
  }
  function propose(t,item,points,base){
    if(points.some(p=>!model.inside(p,geometry(t))))throw Error('볼륨 밖의 점은 지정할 수 없습니다.');
    const value=base?rebuild(base,{points}):model.build({...start(t,item),points});
    model.check(value,{partial:true});return value;
  }
  function down(e){
    if(e.button!==0||!bound)return;
    const item=itemOf(e);if(!item)return;
    const t=bound,r=record(t),index=drag||stroke?-1:hit(item,r.value,e);
    if(index<0&&!armed)return;
    stop(e);swallow=true;
    try{
      if(!allowed())throw Error('다른 작업을 마친 뒤 곡선을 편집하세요.');
      editable(item,r.value);
      if(index>=0){selected=index;drag={item,index,before:r.value,pointerId:e.pointerId,moved:false};item.view.element.setPointerCapture?.(e.pointerId);paint();update();return;}
      const point=at(item,e);
      if(typeInput.value==='freehand'){
        if(r.value)throw Error('Freehand 곡선은 한 번에 그립니다. Clear Curve로 지운 뒤 다시 그리세요.');
        if(!model.inside(point,geometry(t)))throw Error('볼륨 밖의 점은 지정할 수 없습니다.');
        stroke={item,points:[point],pointerId:e.pointerId};item.view.element.setPointerCapture?.(e.pointerId);paint();show();return;
      }
      const next=propose(t,item,[...(r.value?.points||[]),point],r.value);
      if(!r.value)r.seen=displayKey(item.view.getProperties());
      r.value=next;selected=next.points.length-1;
      status.textContent=next.points.length<2?'첫 점을 지정했습니다. 같은 평면에서 다음 점을 클릭하세요.':'점을 추가했습니다. 계속 클릭하거나 Finish Drawing을 누르세요.';
      paint();update();request();
    }catch(error){status.textContent=error.message;}
  }
  function move(e){
    if(drag&&e.pointerId===drag.pointerId){
      stop(e);
      // An invalid position (outside the volume, over a limit) is not applied; the last valid one stays.
      try{if(!allowed())throw Error('다른 작업이 시작되어 점 이동을 적용하지 않았습니다.');const r=record(bound),points=r.value.points.map(p=>p.slice());points[drag.index]=at(drag.item,e);r.value=propose(bound,drag.item,points,r.value);drag.moved=true;paint();request({final:false});}
      catch(error){status.textContent=error.message;}
      return;
    }
    if(stroke&&e.pointerId===stroke.pointerId){
      stop(e);
      try{const p=at(stroke.item,e),last=stroke.points[stroke.points.length-1];if(Math.hypot(p[0]-last[0],p[1]-last[1],p[2]-last[2])>=.05&&stroke.points.length<20000)stroke.points.push(p);paint();}catch(_){}
    }
  }
  function up(e,cancelled=false){
    if(drag&&e.pointerId===drag.pointerId){
      stop(e);const d=drag,r=record(bound);drag=null;swallow=false;try{d.item.view.element.releasePointerCapture?.(e.pointerId);}catch(_){}
      if(cancelled&&d.moved){r.value=d.before;status.textContent='점 이동을 취소했습니다.';}
      else if(d.moved)status.textContent='점을 옮겼습니다. 최종 결과가 나오면 Save New Job으로 저장할 수 있습니다.';
      paint();update();request();return;
    }
    if(stroke&&e.pointerId===stroke.pointerId){
      stop(e);const s=stroke,t=bound,r=record(t);stroke=null;armed=false;swallow=false;try{s.item.view.element.releasePointerCapture?.(e.pointerId);}catch(_){}
      try{
        if(cancelled)throw Error('Freehand 그리기를 취소했습니다.');
        if(!allowed())throw Error('다른 작업이 시작되어 Freehand 곡선을 적용하지 않았습니다.');
        const points=model.simplify(s.points);
        if(points.length<2)throw Error('Freehand 곡선이 너무 짧습니다. 더 길게 그리세요.');
        if(points.length>model.LIMITS.freehand)throw Error('Freehand 곡선 점이 128개를 넘습니다. 더 짧거나 단순하게 그리세요.');
        const next=propose(t,s.item,points,null);model.check(next);
        r.seen=displayKey(s.item.view.getProperties());r.value=next;selected=-1;
        status.textContent='Freehand 곡선을 그렸습니다. 점을 끌어 고치거나 최종 결과 뒤 Save New Job으로 저장하세요.';request();
      }catch(error){status.textContent=error.message;}
      paint();update();show();return;
    }
    swallow=false;
  }
  // Pointer handling above cancels the compatibility mouse events; these guards keep native
  // tools from also acting on a gesture this panel owns.
  const mouse=e=>{if(drag||stroke||swallow&&itemOf(e))stop(e);};
  const listeners=[['pointerdown',down],['pointermove',move],['pointerup',e=>up(e)],['pointercancel',e=>up(e,true)],['mousedown',mouse],['mousemove',mouse],['mouseup',mouse]];
  function bind(t){
    bound={...t,items:t.views.map((view,index)=>{
      const overlay=document.createElement('div');overlay.className='kin-mpr-curved-overlay';overlay.style.cssText='position:absolute;inset:0;pointer-events:none;overflow:hidden';view.element.append(overlay);
      view.element.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED,paint);
      return {view,overlay,index,signature:''};
    })};
    for(const [name,fn] of listeners)window.addEventListener(name,fn,true);
    if(record(bound).value)request();
  }
  function unbind(){
    if(bound){for(const [name,fn] of listeners)window.removeEventListener(name,fn,true);for(const {view,overlay} of bound.items){view.element.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED,paint);overlay.remove();}}
    bound=null;drawn=null;
  }
  // The result follows a LINEAR window change on the drawing plane; any other function keeps the
  // previous display and says so rather than showing a window the curve cannot reproduce.
  function follow(){
    if(!bound)return;
    const r=record(bound),item=r.value&&bound.items[r.value.cell];if(!item)return;
    let props;try{props=item.view.getProperties();}catch(_){return;}
    const key=displayKey(props);if(r.seen===key)return;
    const display=displayOf(props);
    if(display.VOILUTFunction!=='LINEAR'||![display.voiRange.lower,display.voiRange.upper].every(Number.isFinite)||display.voiRange.upper<=display.voiRange.lower){r.seen=key;status.textContent='곡면 MPR 결과는 LINEAR 창 설정만 표시합니다. 이전 표시 조건을 유지합니다.';return;}
    if(!allowed())return;
    r.seen=key;r.value=rebuild(r.value,{display});show();
  }
  function update(){
    const r=bound&&record(bound),can=!!bound&&allowed(),value=r?.value;
    if(value)typeInput.value=value.kind;
    buttons.draw.disabled=!can||armed||!!drag||!!stroke||!!value&&(value.kind==='freehand'||value.points.length>=model.LIMITS.curved);
    buttons.finish.disabled=!can||!armed;
    buttons.delete.disabled=!can||!value||selected<0||!!drag||!!stroke;
    buttons.clear.disabled=!bound||!live()||!permitted()||elsewhere()||!value&&!armed&&!stroke;
    buttons.go.disabled=!can||!value;
    typeInput.disabled=!can||!!value||armed;
    heightInput.disabled=!can||armed||!!drag||!!stroke;
    if(value&&document.activeElement!==heightInput)heightInput.value=String(value.output.halfHeight);
  }
  function refresh(){
    if(ended)return;
    if(!live()){cancel();unbind();panel.hidden=true;return;}
    const t=target();
    if(t?.group!==bound?.group){cancel();unbind();if(t)bind(t);}
    panel.hidden=!t&&!dirty();
    follow();
    // A curve whose loaded volume changed (reload, rollback) is computed again for that volume.
    if(bound){const r=record(bound);if(model.normalize(r.value)&&!(r.requested?.key===signature(r.value)&&r.requested.volume===volume(bound)))request();}
    drafts.replaceChildren();
    const here=bound&&record(bound);
    for(const r of records.values())if(changed(r)&&r!==here){const row=document.createElement('p');row.textContent='Unsaved curve · '+r.source.join(' / ')+' · '+(r.value?r.value.points.length+' point(s)':'cleared');drafts.append(row);}
    update();paint();show();
  }
  function goToPlane(){
    const t=bound;if(!t||!allowed())throw Error('다른 작업을 마친 뒤 곡선 평면으로 이동하세요.');
    const value=record(t).value;if(!value)throw Error('이동할 곡선이 없습니다.');
    const view=t.items[value.cell].view,before=view.getCamera(),p=value.plane,distance=Math.hypot(...before.position.map((n,i)=>n-before.focalPoint[i]))||1;
    try{
      view.setCamera({focalPoint:p.origin.slice(),position:p.origin.map((n,i)=>n+p.normal[i]*distance),viewUp:p.viewUp.slice(),viewPlaneNormal:p.normal.slice()});view.render();
      const state=model.planeState(view.getCamera(),p);if(!state.aligned||Math.abs(state.offset)>1e-5)throw Error('plane');
    }catch(_){
      try{view.setCamera(before);view.render();}catch(__){throw Error('곡선 평면 이동과 이전 화면 복구에 실패했습니다. 현재 영상을 확인하세요.');}
      throw Error('곡선 평면으로 이동하지 못했습니다. 이전 화면으로 복구했습니다.');
    }
    paint();status.textContent='곡선을 그린 평면으로 돌아왔습니다.';
  }
  const act=fn=>()=>{try{fn();}catch(error){status.textContent=error.message;}};
  buttons.draw.onclick=act(()=>{
    if(!bound||!allowed())throw Error('완전히 로드된 3평면 MPR에서 다른 작업을 마친 뒤 곡선을 그리세요.');
    armed=true;selected=-1;
    status.textContent=typeInput.value==='freehand'?'Freehand: MPR 평면 위에서 누른 채 끌어 곡선을 그리세요. 손을 떼면 끝납니다.':'Curved: MPR 평면을 클릭해 제어점을 추가하세요. 기존 점은 끌어서 옮기고, 마치면 Finish Drawing을 누르세요.';
    update();show();
  });
  buttons.finish.onclick=act(()=>{
    armed=false;stroke=null;const value=bound&&record(bound).value;
    status.textContent=value&&!model.normalize(value)?'곡선 점이 두 개 이상이어야 계산합니다.':'곡선 그리기를 마쳤습니다.';update();request();
  });
  buttons.delete.onclick=act(()=>{
    if(!bound||!allowed())throw Error('다른 작업을 마친 뒤 점을 삭제하세요.');
    const r=record(bound);if(!r.value||selected<0)throw Error('삭제할 점을 먼저 선택하세요.');
    const points=r.value.points.filter((_,i)=>i!==selected);
    r.value=points.length?propose(bound,bound.items[r.value.cell],points,r.value):null;selected=-1;
    status.textContent='점을 삭제했습니다.';paint();update();request();
  });
  buttons.clear.onclick=act(()=>{
    if(!bound||!live()||!permitted()||elsewhere())return;
    const r=record(bound);cancel();r.value=null;r.final=r.preview=r.failed=null;
    status.textContent='곡선을 지웠습니다. 저장한 작업은 그대로입니다.';paint();update();show();
  });
  buttons.go.onclick=act(goToPlane);
  typeInput.onchange=()=>{const value=bound&&record(bound).value;if(value){typeInput.value=value.kind;status.textContent='곡선 종류를 바꾸려면 Clear Curve로 지운 뒤 다시 그리세요.';}};
  heightInput.onchange=()=>{
    const r=bound&&record(bound);if(!r?.value)return;
    try{
      if(!allowed())throw Error('다른 작업을 마친 뒤 Half Height를 바꾸세요.');
      const height=Number(heightInput.value);if(!Number.isFinite(height)||height<1||height>150)throw Error('Half Height는 1~150 mm로 입력하세요.');
      const next=rebuild(r.value,{halfHeight:height});model.check(next,{partial:true});r.value=next;request();
    }catch(error){heightInput.value=String(r.value.output.halfHeight);status.textContent=error.message;}
    update();
  };
  const beforeUnload=e=>{if(dirty()){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
  const pack=(x,values)=>x&&{signature:x.signature,columns:x.result.columns,rows:x.result.rows,half:x.result.half,length:x.result.length,spacing:x.result.spacing,outside:x.result.outside,...(values?{values:Array.from(x.result.values,v=>Number.isNaN(v)?null:v)}:{})};
  const capability={
    dirty,
    busy:()=>live()&&(!!drag||!!stroke),
    capture(readOnly=false){
      if(!live())throw Error('곡면 MPR 계정이 변경되어 저장하지 않았습니다.');
      if(armed||drag||stroke)throw Error('곡선 그리기를 Finish Drawing으로 마친 뒤 저장하세요.');
      // No curve work anywhere: every existing Job shape saves exactly as it did before this tool.
      if(![...records.values()].some(r=>r.value||changed(r)))return null;
      const t=target(true,readOnly);
      if(!t){
        // Without a three-plane target a curve cannot be put into this Job, and saving without
        // it would look like it was kept. Only a screen with no curve anywhere saves as it is.
        if([...records.values()].some(r=>r.value||changed(r)))throw Error('곡면 MPR 곡선이 있는 원본의 3평면 화면을 확인하지 못했습니다. 3평면 화면이 준비된 뒤 저장하거나 Clear Curve로 지운 뒤 저장하세요.');
        return null;
      }
      const r=records.get(keyOf(t));if(!r?.value)return null;
      const value=model.normalize(r.value);if(!value)throw Error('곡선 점을 두 개 이상 지정하거나 Clear Curve로 지운 뒤 저장하세요.');
      if(value.frameOfReference!==frameOfReference(t))throw Error('곡선의 좌표계가 현재 원본과 달라 저장하지 않았습니다.');
      const key=signature(value);
      if(r.final?.signature!==key||r.final.volume!==volume(t))throw Error(r.failed?.signature===key?'곡면 MPR 계산에 실패해 저장하지 않았습니다. 곡선을 고치거나 지운 뒤 저장하세요.':'곡면 MPR 최종 결과 계산이 끝난 뒤 저장하세요.');
      return value;
    },
    saved(value,source){
      try{
        if(!live())return;
        const r=records.get(JSON.stringify(source)),sent=value?model.normalize(value):null;
        if(r&&JSON.stringify(r.value?model.normalize(r.value):null)===JSON.stringify(sent))r.saved=JSON.stringify(r.value);
      }catch(_){}
    },
    async restore(value,current=()=>true,deadline=Date.now()+60000){
      if(!live())throw Error('곡면 MPR 계정이 변경되어 복원하지 않았습니다.');
      const t=target(true,true),next=model.normalize(value);
      if(!t||!next)throw Error('저장한 곡면 MPR 형식이나 3평면 화면을 확인할 수 없습니다.');
      if(next.frameOfReference!==frameOfReference(t))throw Error('저장한 곡면 MPR의 좌표계(Frame of Reference)가 현재 원본과 달라 복원하지 않았습니다.');
      if(Math.abs(next.output.spacing-finest(t))>1e-6)throw Error('저장한 곡면 MPR 출력 간격이 현재 원본 voxel 간격과 달라 복원하지 않았습니다.');
      if(![next.plane.origin,...next.points].every(p=>model.inside(p,geometry(t))))throw Error('저장한 곡선 점이 현재 볼륨 밖에 있어 복원하지 않았습니다.');
      const key=keyOf(t),previous=records.get(key);
      const r={source:[t.source.uid,t.source.series],value:next,saved:JSON.stringify(next),final:null,preview:null,failed:null,seen:displayKey(t.views[next.cell].getProperties()),requested:{key:signature(next),volume:volume(t)}};
      records.set(key,r);
      try{
        cancel();refresh();
        if(bound?.group!==t.group)throw Error('곡면 MPR 화면을 연결하지 못해 복원하지 않았습니다.');
        const mine=++generation,outcome=await run(r,bound,mine,'final',{current,deadline});
        if(outcome!=='done')throw Error(r.failed?'저장한 곡면 MPR을 다시 계산하지 못했습니다. '+r.failed.message:'화면이 바뀌었거나 시간이 초과되어 곡면 MPR 복원을 중단했습니다.');
        status.textContent='저장한 곡선과 최종 곡면 결과를 복원했습니다.';paint();update();show();
      }catch(error){
        if(records.get(key)===r){if(previous)records.set(key,previous);else records.delete(key);}
        cancel();refresh();throw error;
      }
    },
    clearForJob(){if(!live())throw Error('곡면 MPR 계정이 변경되었습니다.');cancel();records.clear();refresh();},
    inspect({values=false}={}){
      const r=bound&&record(bound);if(!r)return null;
      return {state:stateText.textContent,armed,selected,generation,current:signature(r.value),value:r.value?structuredClone(r.value):null,final:pack(r.final,values),preview:pack(r.preview,values),failed:r.failed?{...r.failed}:null};
    }
  };
  window.kinMprCurved=capability;const timer=setInterval(refresh,250);refresh();
  return {dispose(){ended=true;clearInterval(timer);cancel();unbind();records.clear();if(window.kinMprCurved===capability)delete window.kinMprCurved;window.removeEventListener('beforeunload',beforeUnload);panel.remove();}};
};
