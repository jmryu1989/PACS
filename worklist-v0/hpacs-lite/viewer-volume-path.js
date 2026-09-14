window.kinCreateVolumePath=function({target,permitted,alive,owner,host}){
  // Manual 3D path on the three-plane target. The person places every point on a native plane;
  // nothing here reads image content to find, move or smooth a path. Results are derived displays.
  const model=window.KinVolumePath,base=window.KinVolumeCurved,identity=JSON.stringify(owner()),records=new Map(),scalars=new WeakMap(),NS='http://www.w3.org/2000/svg';
  const CAMERA_KEYS=['focalPoint','position','viewUp','viewPlaneNormal'];
  let ended=false,bound=null,armed=false,drag=null,selected=-1,generation=0,settle=null,swallow=false,drawn=null,busy=false,navigation=null,planned={key:null,grid:null};
  const live=()=>{try{return !ended&&alive()&&JSON.stringify(owner())===identity;}catch(_){return false;}};
  const elsewhere=()=>{try{return !!window.kinViewerJobWorkspaceState?.().busy||!!window.kinVolumeBatchState?.busy?.()||!!window.kinMprRenderingState?.busy?.()||!!window.kinMprCurved?.busy?.();}catch(_){return true;}};
  const allowed=()=>{try{return live()&&permitted()&&!elsewhere()&&!busy;}catch(_){return false;}};
  const panel=document.createElement('section');panel.id='kin-mpr-path';panel.style.cssText='border-top:1px solid #657c9f;padding:8px 0';host.append(panel);
  panel.innerHTML='<strong>3D Path</strong><p>세 MPR 평면 어느 곳에서든 사람이 직접 클릭한 제어점을 이어 3차원 경로를 만듭니다. 각 점은 클릭한 평면의 현재 깊이에 놓이며, 영상 내용으로 경로를 자동으로 찾거나 보정하지 않습니다. 경로는 세 평면에 투영해 보여 주며 채운 원은 그 평면 위의 점, 점선 원은 다른 깊이의 점입니다. 점은 그 점이 놓인 평면에서만 끌어 옮길 수 있습니다.</p>'+
    '<p>Go to Path Point는 선택한 경로 위치에서 경로에 수직인 평면 하나와 경로 방향을 포함하는 평행 평면 둘을 세 칸에 표시합니다. 펼친 표시는 경로를 따라 원본 CT 값(HU)을 펼친 재구성 표시이며 원본 영상이 아닙니다. 가로축은 경로를 따라 잰 길이라서 화면 위 직선 거리나 측정 의미가 없습니다. Save New Job으로 경로와 세 평면 표시를 저장합니다.</p>'+
    '<label>Half Height (mm) <input type="number" data-input="height" aria-label="3D Path Half Height" min="1" max="150" step="1" value="20" style="width:70px"></label> <label>Unfold Angle (°) <input type="number" data-input="angle" aria-label="3D Path Unfold Angle" min="0" max="359.99" step="1" value="0" style="width:70px"></label> '+
    '<button type="button" data-action="add">Add Points</button> <button type="button" data-action="finish">Finish Points</button> <button type="button" data-action="delete">Delete Point</button> <button type="button" data-action="clear">Clear Path</button> <button type="button" data-action="reset">Reset Path</button>'+
    '<p data-kin-path-state>No Path</p><p><label>Path Position (column) <input type="number" data-input="column" aria-label="3D Path Position Column" min="0" step="1" value="0" style="width:80px"></label> <span data-kin-path-position></span></p>'+
    '<p><label>Perpendicular Plane <select aria-label="Perpendicular Plane Cell"><option value="0">Cell 1</option><option value="1">Cell 2</option><option value="2">Cell 3</option></select></label> <button type="button" data-action="go">Go to Path Point</button></p>'+
    '<div class="result" hidden><p class="badge" style="color:#ffa94d;font-weight:bold">UNFOLDED 3D PATH · Derived display · Not a source image</p><canvas aria-label="Unfolded 3D path result" style="display:block;width:100%;height:auto;max-height:360px;object-fit:contain;image-rendering:pixelated;background:#000"></canvas><p class="caption"></p><p class="note">가로축은 경로를 따라 잰 길이, 세로축은 경로 기준 방향(Unfold Angle로 돌림)입니다. 노란 세로선은 현재 경로 위치입니다. 화면 위 직선 거리·측정 의미가 없고 원본 영상이 아닙니다. 짙은 파란 표본은 볼륨 밖입니다. 측정·표식·출력은 지원하지 않습니다.</p></div><div class="drafts"></div><p role="status"></p>';
  const input=name=>panel.querySelector('[data-input='+name+']');
  const heightInput=input('height'),angleInput=input('angle'),columnInput=input('column'),cellInput=panel.querySelector('select'),stateText=panel.querySelector('[data-kin-path-state]'),positionText=panel.querySelector('[data-kin-path-position]'),status=panel.querySelector('[role=status]');
  const resultBox=panel.querySelector('.result'),canvas=panel.querySelector('canvas'),caption=panel.querySelector('.caption'),drafts=panel.querySelector('.drafts');
  const buttons=Object.fromEntries([...panel.querySelectorAll('button[data-action]')].map(b=>[b.dataset.action,b]));
  const volume=t=>cornerstone.cache.getVolume(t.views[0].getVolumeId());
  const keyOf=t=>JSON.stringify({study:t.source.uid,series:t.source.series,sops:volume(t).imageIds.map(id=>cornerstone.metaData.get('instance',id).SOPInstanceUID)});
  function record(t){const key=keyOf(t);if(!records.has(key))records.set(key,{source:[t.source.uid,t.source.series],value:null,saved:'null',final:null,preview:null,failed:null,seen:null});return records.get(key);}
  const changed=r=>!!r&&JSON.stringify(r.value)!==r.saved;
  const dirty=()=>live()&&(armed||!!drag||[...records.values()].some(changed));
  // The display window re-rasters a result and the position only moves its marker; everything
  // else in the path defines the unfolded values.
  const signature=value=>{if(!value)return null;const {display,position,...rest}=value;return JSON.stringify(rest);};
  const geometry=t=>{const v=volume(t);return {origin:Array.from(v.origin),direction:Array.from(v.direction),spacing:Array.from(v.spacing),dimensions:Array.from(v.dimensions)};};
  const finest=t=>Math.min(...volume(t).spacing);
  const frameOfReference=t=>cornerstone.metaData.get('instance',volume(t).imageIds[0])?.FrameOfReferenceUID;
  const displayOf=p=>({voiRange:{lower:p?.voiRange?.lower,upper:p?.voiRange?.upper},VOILUTFunction:p?.VOILUTFunction||'LINEAR',invert:!!p?.invert});
  const displayKey=p=>JSON.stringify(displayOf(p));
  const rebuild=(value,changes)=>model.build({frameOfReference:value.frameOfReference,cell:value.cell,points:value.points,initialNormal:value.frame.initialNormal,angle:value.unfold.angle,column:value.position.column,spacing:value.output.spacing,halfHeight:value.output.halfHeight,display:value.display,...changes});
  // Geometry only; recomputed when the defining part of the path changes.
  function gridOf(value){
    const key=value?JSON.stringify([signature(value),value.position]):null;
    if(planned.key!==key){let grid=null;try{grid=value&&model.check(value);}catch(_){grid=null;}planned={key,grid};}
    return planned.grid;
  }
  const near=(a,b,tolerance)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((n,i)=>Number.isFinite(n)&&Math.abs(n-b[i])<=tolerance);

  // The cached native volume scalars are the HU the planes show; they are read once per loaded
  // volume, checked against the native index-to-world map and never rescaled here.
  function source(t){
    const v=volume(t),g=geometry(t),manager=v?.voxelManager;
    if(typeof manager?.getCompleteScalarDataArray!=='function')throw Error('원본 화소 배열을 확인할 수 없어 펼친 표시를 계산하지 않았습니다.');
    const count=g.dimensions.reduce((a,b)=>a*b,1);if(count>base.LIMITS.voxels)throw Error('원본 볼륨이 펼친 표시 계산 한도를 넘습니다.');
    let data=scalars.get(v);if(!data){data=manager.getCompleteScalarDataArray();if(data?.length===count)scalars.set(v,data);}
    if(!data||data.length!==count)throw Error('원본 화소 배열 길이가 볼륨 크기와 달라 펼친 표시를 계산하지 않았습니다.');
    const toIndex=base.affine(g),last=g.dimensions.map(n=>n-1);
    for(const probe of [[0,0,0],last,[last[0],0,Math.floor(last[2]/2)]]){
      const back=toIndex(Array.from(v.imageData.indexToWorld(probe)));
      if(back.some((n,i)=>!(Math.abs(n-probe[i])<=1e-6)))throw Error('원본 볼륨 좌표 변환을 확인할 수 없어 펼친 표시를 계산하지 않았습니다.');
    }
    return {scalars:data,dimensions:g.dimensions,worldToIndex:toIndex};
  }
  // One request at a time: every chunk re-checks generation, owner, screen and the path itself,
  // so a late chunk of an earlier path can never become the shown or saved result.
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
      settle=setTimeout(()=>{if(mine===generation&&!drag)run(r,t,mine,'final');},150);
    })();
  }
  function cancel(){generation++;clearTimeout(settle);armed=false;drag=null;selected=-1;swallow=false;}

  function show(){
    const r=bound&&record(bound),value=r?.value,key=signature(value),loaded=bound&&volume(bound),grid=gridOf(value);let label='No Path',result=null;
    if(value){
      if(!model.normalize(value))label='Incomplete';
      else if(r.final?.signature===key&&r.final.volume===loaded){label='Final';result=r.final.result;}
      else if(r.failed?.signature===key&&r.failed.volume===loaded)label='Failed';
      else if(r.preview?.signature===key&&r.preview.volume===loaded){label='Preview · refining';result=r.preview.result;}
      else label='Stale · recomputing';
    }
    if(armed)label='Adding points · '+label;
    stateText.textContent=label;resultBox.hidden=!result;canvas.dataset.kinPathState=result?label:'';
    positionText.textContent=grid?'At '+(value.position.column*value.output.spacing).toFixed(2)+' mm of '+grid.length.toFixed(2)+' mm along the path (columns 0–'+(grid.columns-1)+')':'';
    if(!result){drawn=null;return;}
    const display=JSON.stringify(value.display),column=value.position.column;
    if(drawn?.result!==result||drawn.display!==display||drawn.column!==column){
      canvas.width=result.columns;canvas.height=result.rows;
      const context=canvas.getContext('2d');context.putImageData(new ImageData(base.raster(result,value.display),result.columns,result.rows),0,0);
      // The position marker is drawn over the raster only; the result values are untouched.
      context.fillStyle='#ffdc7c';context.fillRect(Math.min(result.columns-1,Math.round(column*value.output.spacing/result.spacing)),0,1,result.rows);
      drawn={result,display,column};
    }
    caption.textContent=(label==='Final'?'Final':'Preview · refining · 최종 결과가 아닙니다')+' · Arc length '+result.length.toFixed(2)+' mm · Half height '+value.output.halfHeight+' mm · Spacing '+result.spacing+' mm · '+result.columns+'×'+result.rows+' samples · Outside '+result.outside+' · Unfold angle '+value.unfold.angle+'° · Position '+(column*value.output.spacing).toFixed(2)+' mm';
  }
  function paint(){
    if(!bound||!live())return;
    const value=record(bound).value,points=value?value.points:[],grid=gridOf(value);
    const marker=grid?[0,1,2].map(k=>grid.centres[value.position.column*3+k]):null;
    for(const item of bound.items){
      const {view,overlay}=item,c=view.getCanvas(),camera=view.getCamera();
      const signature=JSON.stringify([points,selected,marker,camera,c.clientWidth,c.clientHeight]);
      if(item.signature===signature)continue;item.signature=signature;overlay.replaceChildren();
      if(!points.length)continue;
      const svg=document.createElementNS(NS,'svg');svg.style.cssText='position:absolute;inset:0;width:100%;height:100%;overflow:hidden';
      const set=(node,attributes)=>{for(const [k,v] of Object.entries(attributes))node.setAttribute(k,String(v));return node;};
      if(points.length>=2)svg.append(set(document.createElementNS(NS,'polyline'),{points:base.polyline(points,'curved').map(p=>Array.from(view.worldToCanvas(p)).join(',')).join(' '),fill:'none',stroke:'#ffa94d','stroke-width':2,'stroke-opacity':.9}));
      let on=0;
      points.forEach((p,i)=>{
        const xy=view.worldToCanvas(p),here=model.onPlane(p,camera),dot=set(document.createElementNS(NS,'circle'),{cx:xy[0],cy:xy[1],r:i===selected?6:4,fill:here?(i===selected?'#ffdc7c':'#ffa94d'):'none',stroke:here?'#10202c':'#ffa94d','stroke-width':here?1:2,...(here?{}:{'stroke-dasharray':'3 2'})});
        dot.dataset.kinPathPoint=String(i);dot.dataset.kinPathOn=here?'on':'off';svg.append(dot);if(here)on++;
      });
      if(marker){const xy=view.worldToCanvas(marker),cross=set(document.createElementNS(NS,'path'),{d:`M${xy[0]-7} ${xy[1]}H${xy[0]+7}M${xy[0]} ${xy[1]-7}V${xy[1]+7}`,stroke:'#ffdc7c','stroke-width':2});cross.dataset.kinPathMarker='position';svg.append(cross);}
      const label=document.createElement('span');label.dataset.kinPathPlane=String(on);label.style.cssText='position:absolute;left:6px;bottom:24px;color:#ffa94d;background:#182030ee;padding:2px 4px;font-size:12px';
      label.textContent='3D Path · '+on+' point(s) on this plane · '+(points.length-on)+' projected from other depths';
      overlay.append(svg,label);
    }
  }

  // Gestures are resolved at window capture, exactly as the curved MPR panel resolves them.
  const control=e=>e.target instanceof Element&&(host.contains(e.target)||!!e.target.closest('button,input,select,textarea,a[href],[role=button],[role=menu],[role=menuitem],[role=dialog]'));
  const itemOf=e=>{
    if(!bound)return null;
    const inside=bound.items.find(item=>e.target instanceof Node&&item.view.element.contains(e.target));
    if(inside||control(e))return inside||null;
    return bound.items.find(item=>{const r=item.view.element.getBoundingClientRect();return e.clientX>=r.left&&e.clientX<r.right&&e.clientY>=r.top&&e.clientY<r.bottom;})||null;
  };
  const at=(item,e)=>{const rect=item.view.element.getBoundingClientRect();return model.round(Array.from(item.view.canvasToWorld([e.clientX-rect.left,e.clientY-rect.top])));};
  const stop=e=>{e.preventDefault();e.stopImmediatePropagation();};
  function hit(item,value,e){
    if(!value)return -1;
    const rect=item.view.element.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;let best=-1,nearest=6;
    value.points.forEach((p,i)=>{const xy=item.view.worldToCanvas(p),d=Math.hypot(xy[0]-x,xy[1]-y);if(d<=nearest){nearest=d;best=i;}});
    return best;
  }
  // The path is fixed to the plane of its first point for its display window only.
  function begin(t,item){
    const display=displayOf(item.view.getProperties()),frame=frameOfReference(t),height=Number(heightInput.value),degrees=Number(angleInput.value);
    if(display.VOILUTFunction!=='LINEAR')throw Error('3D Path 펼친 표시는 LINEAR 창 설정 표시에서만 계산합니다. 창 설정 함수를 LINEAR로 바꾼 뒤 점을 지정하세요.');
    if(!frame)throw Error('원본 좌표계(Frame of Reference)를 확인할 수 없어 경로를 만들지 않았습니다.');
    if(!Number.isFinite(height)||height<1||height>150)throw Error('Half Height는 1~150 mm로 입력하세요.');
    return model.build({frameOfReference:frame,cell:item.index,points:[],initialNormal:[1,0,0],angle:model.angle(degrees),column:0,spacing:finest(t),halfHeight:height,display});
  }
  // Every edit is proposed as a whole path and checked before it replaces the last valid one. The
  // initial normal is re-projected for the new start direction and the resulting vector is stored.
  function propose(t,item,points,previous){
    if(points.some(p=>!base.inside(p,geometry(t))))throw Error('볼륨 밖의 점은 지정할 수 없습니다.');
    const start=previous||begin(t,item);
    if(points.length<2){const value=rebuild(start,{points,initialNormal:[1,0,0],column:0});model.check(value,{partial:true});return value;}
    const normal=model.initialNormal(points,start.output.spacing,previous&&previous.points.length>=2?previous.frame.initialNormal:null);
    let value=rebuild(start,{points,initialNormal:normal,column:0});
    const grid=model.plan(value);value=rebuild(value,{column:Math.min(start.position.column,grid.columns-1)});
    model.check(value);return value;
  }
  function down(e){
    if(e.button!==0||!bound)return;
    const item=itemOf(e);if(!item)return;
    const t=bound,r=record(t);let index=drag?-1:hit(item,r.value,e);
    // While adding, a press over a point projected from another depth adds a point here.
    if(index>=0&&armed&&!model.onPlane(r.value.points[index],item.view.getCamera()))index=-1;
    if(index<0&&!armed)return;
    stop(e);swallow=true;
    try{
      if(!allowed())throw Error('다른 작업을 마친 뒤 경로를 편집하세요.');
      if(index>=0){
        if(!model.onPlane(r.value.points[index],item.view.getCamera()))throw Error('이 평면 위에 있는 점만 끌어 옮길 수 있습니다. 점선 원은 다른 깊이의 점을 투영한 것입니다.');
        selected=index;drag={item,index,before:r.value,pointerId:e.pointerId,moved:false};item.view.element.setPointerCapture?.(e.pointerId);paint();update();show();return;
      }
      const next=propose(t,item,[...(r.value?.points||[]),at(item,e)],r.value);
      if(!r.value)r.seen=displayKey(item.view.getProperties());
      r.value=next;selected=next.points.length-1;
      status.textContent=next.points.length<2?'첫 점을 지정했습니다. 다른 평면이나 깊이에서 다음 점을 클릭하세요.':'점을 추가했습니다. 계속 클릭하거나 Finish Points를 누르세요.';
      paint();update();request();
    }catch(error){status.textContent=error.message;}
  }
  function move(e){
    if(!drag||e.pointerId!==drag.pointerId)return;
    stop(e);
    // An invalid position (outside, too close, a reversal) is not applied; the last valid path stays.
    try{if(!allowed())throw Error('다른 작업이 시작되어 점 이동을 적용하지 않았습니다.');const r=record(bound),points=r.value.points.map(p=>p.slice());points[drag.index]=at(drag.item,e);r.value=propose(bound,drag.item,points,r.value);drag.moved=true;drag.refused=null;paint();update();request({final:false});}
    catch(error){drag.refused=error.message;status.textContent=error.message;}
  }
  function up(e,cancelled=false){
    if(drag&&e.pointerId===drag.pointerId){
      stop(e);const d=drag,r=record(bound);drag=null;swallow=false;try{d.item.view.element.releasePointerCapture?.(e.pointerId);}catch(_){}
      if(cancelled&&d.moved){r.value=d.before;status.textContent='점 이동을 취소했습니다.';}
      // A refused final position is still reported after release, with where the point stayed.
      else if(d.refused)status.textContent=d.refused+' 점은 마지막으로 가능했던 위치에 있습니다.';
      else if(d.moved)status.textContent='점을 옮겼습니다. 최종 결과가 나오면 Save New Job으로 저장할 수 있습니다.';
      paint();update();request();return;
    }
    swallow=false;
  }
  const mouse=e=>{if(drag||swallow&&itemOf(e))stop(e);};
  const listeners=[['pointerdown',down],['pointermove',move],['pointerup',e=>up(e)],['pointercancel',e=>up(e,true)],['mousedown',mouse],['mousemove',mouse],['mouseup',mouse]];
  function bind(t){
    bound={...t,items:t.views.map((view,index)=>{
      const overlay=document.createElement('div');overlay.className='kin-mpr-path-overlay';overlay.style.cssText='position:absolute;inset:0;pointer-events:none;overflow:hidden';view.element.append(overlay);
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
  // The result follows a LINEAR window change on the plane of the first point, as a curve does.
  function follow(){
    if(!bound)return;
    const r=record(bound),item=r.value&&bound.items[r.value.cell];if(!item)return;
    let props;try{props=item.view.getProperties();}catch(_){return;}
    const key=displayKey(props);if(r.seen===key)return;
    const display=displayOf(props);
    if(display.VOILUTFunction!=='LINEAR'||![display.voiRange.lower,display.voiRange.upper].every(Number.isFinite)||display.voiRange.upper<=display.voiRange.lower){r.seen=key;status.textContent='3D Path 펼친 표시는 LINEAR 창 설정만 표시합니다. 이전 표시 조건을 유지합니다.';return;}
    if(!allowed())return;
    r.seen=key;r.value=rebuild(r.value,{display});show();
  }
  function update(){
    const r=bound&&record(bound),can=!!bound&&allowed(),value=r?.value,grid=gridOf(value),clearable=!!bound&&live()&&permitted()&&!elsewhere()&&!busy;
    buttons.add.disabled=!can||armed||!!drag||!!value&&value.points.length>=model.LIMITS.points;
    buttons.finish.disabled=!can||!armed;
    buttons.delete.disabled=!can||!value||selected<0||!!drag;
    buttons.clear.disabled=!clearable||!value&&!armed;
    buttons.reset.disabled=!clearable||!!drag||!changed(r);
    buttons.go.disabled=!can||!grid||!!drag;
    heightInput.disabled=angleInput.disabled=cellInput.disabled=!can||!!drag;
    columnInput.disabled=!can||!grid||!!drag;columnInput.max=String(grid?grid.columns-1:0);
    if(value&&document.activeElement!==heightInput)heightInput.value=String(value.output.halfHeight);
    if(value&&document.activeElement!==angleInput)angleInput.value=String(value.unfold.angle);
    if(value&&document.activeElement!==columnInput)columnInput.value=String(value.position.column);
  }
  function refresh(){
    if(ended||busy)return;
    if(!live()){cancel();unbind();panel.hidden=true;return;}
    const t=target();
    if(t?.group!==bound?.group){cancel();unbind();if(t)bind(t);}
    panel.hidden=!t&&!dirty();
    follow();
    // A path whose loaded volume changed (reload, rollback) is computed again for that volume.
    if(bound){const r=record(bound);if(model.normalize(r.value)&&!(r.requested?.key===signature(r.value)&&r.requested.volume===volume(bound)))request();}
    drafts.replaceChildren();
    const here=bound&&record(bound);
    for(const r of records.values())if(changed(r)&&r!==here){const row=document.createElement('p');row.textContent='Unsaved 3D path · '+r.source.join(' / ')+' · '+(r.value?r.value.points.length+' point(s)':'cleared');drafts.append(row);}
    update();paint();show();
  }

  const setCamera=(v,camera)=>{v.setCamera({flipHorizontal:camera.flipHorizontal,flipVertical:camera.flipVertical});const next={...camera};delete next.rotation;delete next.flipHorizontal;delete next.flipVertical;v.setCamera(next);};
  // Native Crosshairs keep their own center; derive it again from the applied planes.
  const center=v=>{const group=window.cornerstoneTools?.ToolGroupManager?.getToolGroupForViewport(v.id,v.renderingEngineId),tool=group?.getToolInstance?.('Crosshairs');if(tool?.computeToolCenter&&group.getToolOptions?.('Crosshairs')?.mode!=='Disabled')tool.computeToolCenter();};
  // Completion is a native IMAGE_RENDERED event from every viewport, listened for only after the
  // last camera write and then requested; animation frames alone are not proof of a new image.
  function rendered(views,ms=5000){
    return new Promise((resolve,reject)=>{
      const pending=new Set(views),listeners=[],name=cornerstone.Enums.Events.IMAGE_RENDERED;let timer=null,done=false;
      const finish=error=>{if(done)return;done=true;clearTimeout(timer);for(const [element,fn] of listeners)element.removeEventListener(name,fn);error?reject(error):resolve();};
      if(!name)return finish(Error('영상 렌더링 완료 신호를 확인할 수 없습니다.'));
      for(const v of views){const fn=()=>{pending.delete(v);if(!pending.size)finish();};v.element.addEventListener(name,fn);listeners.push([v.element,fn]);}
      timer=setTimeout(()=>finish(Error('경로 평면의 렌더링 완료를 확인하지 못했습니다.')),ms);
      try{for(const v of views)v.render();}catch(error){finish(error);}
    });
  }
  async function goTo(){
    if(busy)return;
    const t=bound;if(!t||!allowed())throw Error('다른 작업을 마친 뒤 경로 위치로 이동하세요.');
    const r=record(t),value=model.normalize(r.value);if(!value)throw Error('점이 두 개 이상인 올바른 경로를 먼저 만드세요.');
    const loaded=volume(t),before=target(true);
    if(!before||before.group!==t.group)throw Error('3평면 화면이 바뀌었습니다. 대상을 확인하고 다시 시도하세요.');
    if(before.cameras.some(c=>c.flipHorizontal||c.flipVertical))throw Error('뒤집어 표시한 평면이 있습니다. 뒤집기를 해제한 뒤 경로 위치로 이동하세요.');
    const perpendicular=Number(cellInput.value),column=value.position.column,grid=model.plan(value),next=model.cameras(grid,column,before.cameras,perpendicular);
    window.KinVolumeOrientation?.intersection(next);
    const views=t.items.map(item=>item.view),key=signature(value);let changed=false;
    busy=true;navigation=null;status.textContent='경로 위치로 이동 중입니다.';update();
    try{
      changed=true;views.forEach((v,i)=>setCamera(v,next[i]));center(views[0]);
      await rendered(views);
      const after=target(true);
      if(!after||after.group!==t.group||after.selection!==before.selection||!live()||bound!==t||volume(t)!==loaded||records.get(keyOf(t))!==r||signature(r.value)!==key||r.value.position.column!==column)throw Error('화면이나 경로가 바뀌어 이동 결과를 확인하지 못했습니다.');
      for(let i=0;i<3;i++)for(const name of CAMERA_KEYS)if(!near(after.cameras[i][name],next[i][name],1e-5))throw Error('경로 평면 카메라를 확인하지 못했습니다.');
      navigation={column,perpendicular,signature:key,rendered:views.length,cameras:after.cameras.map(c=>Object.fromEntries(CAMERA_KEYS.map(name=>[name,Array.from(c[name])])))};
      status.textContent='경로 위치 '+(column*value.output.spacing).toFixed(2)+' mm에서 Cell '+(perpendicular+1)+'에 경로 수직 평면, 나머지 두 칸에 경로 방향을 포함한 평행 평면을 표시했습니다. 원본과 판독문은 그대로입니다.';
    }catch(error){
      let restored=false;
      if(changed&&live())try{
        const now=target();
        if(now?.group===t.group){views.forEach((v,i)=>setCamera(v,before.cameras[i]));center(views[0]);await rendered(views);const back=target();restored=!!back&&back.group===t.group&&[0,1,2].every(i=>CAMERA_KEYS.every(name=>near(back.cameras[i][name],before.cameras[i][name],1e-5)));}
      }catch(_){restored=false;}
      throw Error((error?.message||'경로 위치로 이동하지 못했습니다.')+(changed?(restored?' 이전 화면으로 복구했습니다.':' 이전 화면 복구를 확인하지 못했습니다. 현재 영상을 확인하세요.'):''));
    }finally{busy=false;refresh();}
  }
  const guard=e=>{if(busy&&!panel.contains(e.target)){e.preventDefault();e.stopImmediatePropagation();}};
  for(const name of ['pointerdown','wheel','keydown'])document.addEventListener(name,guard,{capture:true,passive:false});
  const act=fn=>()=>{try{fn();}catch(error){status.textContent=error.message;}};
  const editable=()=>{if(!bound||!allowed())throw Error('다른 작업을 마친 뒤 경로를 편집하세요.');return record(bound);};
  buttons.add.onclick=act(()=>{
    if(!bound||!allowed())throw Error('완전히 로드된 3평면 MPR에서 다른 작업을 마친 뒤 경로를 만드세요.');
    armed=true;selected=-1;
    status.textContent='3D Path: 세 평면 중 어느 평면이든 클릭해 경로 끝에 제어점을 추가하세요. 점은 그 평면의 현재 깊이에 놓입니다. 기존 점은 그 점이 놓인 평면에서 끌어 옮기고, 마치면 Finish Points를 누르세요.';
    update();show();
  });
  buttons.finish.onclick=act(()=>{
    armed=false;const value=bound&&record(bound).value;
    status.textContent=value&&!model.normalize(value)?'경로 점이 두 개 이상이어야 계산합니다.':'경로 점 추가를 마쳤습니다.';update();request();
  });
  buttons.delete.onclick=act(()=>{
    const r=editable();if(!r.value||selected<0)throw Error('삭제할 점을 먼저 선택하세요.');
    const points=r.value.points.filter((_,i)=>i!==selected);
    r.value=points.length?propose(bound,bound.items[r.value.cell],points,r.value):null;selected=-1;
    status.textContent='점을 삭제했습니다.';paint();update();request();
  });
  buttons.clear.onclick=act(()=>{
    if(!bound||!live()||!permitted()||elsewhere()||busy)return;
    const r=record(bound);cancel();r.value=null;r.final=r.preview=r.failed=null;
    status.textContent='경로를 지웠습니다. 저장한 작업은 그대로이며 Reset Path로 저장한 경로로 되돌릴 수 있습니다.';paint();update();show();
  });
  buttons.reset.onclick=act(()=>{
    if(!bound||!live()||!permitted()||elsewhere()||busy)return;
    const r=record(bound);cancel();r.value=JSON.parse(r.saved);
    status.textContent=r.value?'저장한 경로로 되돌렸습니다.':'저장한 경로가 없어 경로를 비웠습니다.';paint();update();request();
  });
  buttons.go.onclick=()=>goTo().catch(error=>{if(live())status.textContent=error.message;});
  const edit=(field,apply)=>()=>{
    const r=bound&&record(bound);if(!r?.value)return;
    try{if(!allowed())throw Error('다른 작업을 마친 뒤 값을 바꾸세요.');const next=apply(r.value);model.check(next,{partial:true});r.value=next;}
    catch(error){status.textContent=error.message;}
    update();paint();show();
  };
  heightInput.onchange=()=>{edit('height',value=>{const height=Number(heightInput.value);if(!Number.isFinite(height)||height<1||height>150)throw Error('Half Height는 1~150 mm로 입력하세요.');return rebuild(value,{halfHeight:height});})();request();};
  angleInput.onchange=()=>{edit('angle',value=>rebuild(value,{angle:model.angle(angleInput.value.trim()===''?NaN:Number(angleInput.value))}))();request();};
  // The position is quantized to arc-length columns and never clamped silently here.
  columnInput.onchange=edit('column',value=>{
    const grid=gridOf(value),column=Number(columnInput.value);
    if(!grid)throw Error('점이 두 개 이상인 올바른 경로에서 위치를 정하세요.');
    if(!Number.isInteger(column)||column<0||column>=grid.columns)throw Error('Path Position은 0~'+(grid.columns-1)+' 사이의 정수입니다.');
    return rebuild(value,{column});
  });
  const beforeUnload=e=>{if(dirty()){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
  const pack=(x,values)=>x&&{signature:x.signature,columns:x.result.columns,rows:x.result.rows,half:x.result.half,length:x.result.length,spacing:x.result.spacing,outside:x.result.outside,...(values?{values:Array.from(x.result.values,v=>Number.isNaN(v)?null:v)}:{})};
  const capability={
    dirty,
    busy:()=>live()&&(!!drag||busy),
    capture(readOnly=false){
      if(!live())throw Error('3D Path 계정이 변경되어 저장하지 않았습니다.');
      if(armed||drag)throw Error('경로 점 추가를 Finish Points로 마친 뒤 저장하세요.');
      if(busy)throw Error('경로 위치 이동이 끝난 뒤 저장하세요.');
      // No path work anywhere: every existing Job shape saves exactly as it did before this tool.
      if(![...records.values()].some(r=>r.value||changed(r)))return null;
      const t=target(true,readOnly);
      if(!t){
        if([...records.values()].some(r=>r.value||changed(r)))throw Error('3D Path가 있는 원본의 3평면 화면을 확인하지 못했습니다. 3평면 화면이 준비된 뒤 저장하거나 Clear Path로 지운 뒤 저장하세요.');
        return null;
      }
      const r=records.get(keyOf(t));if(!r?.value)return null;
      const value=model.normalize(r.value);if(!value)throw Error('경로 점을 두 개 이상 지정하거나 Clear Path로 지운 뒤 저장하세요.');
      if(value.frameOfReference!==frameOfReference(t))throw Error('경로의 좌표계가 현재 원본과 달라 저장하지 않았습니다.');
      const key=signature(value);
      if(r.final?.signature!==key||r.final.volume!==volume(t))throw Error(r.failed?.signature===key?'3D Path 펼친 표시 계산에 실패해 저장하지 않았습니다. 경로를 고치거나 지운 뒤 저장하세요.':'3D Path 펼친 표시의 최종 결과 계산이 끝난 뒤 저장하세요.');
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
      if(!live())throw Error('3D Path 계정이 변경되어 복원하지 않았습니다.');
      // The saved definition is validated as saved; nothing here re-projects or re-derives it.
      const t=target(true,true),next=model.normalize(value);
      if(!t||!next)throw Error('저장한 3D Path 형식이나 3평면 화면을 확인할 수 없습니다.');
      if(next.frameOfReference!==frameOfReference(t))throw Error('저장한 3D Path의 좌표계(Frame of Reference)가 현재 원본과 달라 복원하지 않았습니다.');
      if(Math.abs(next.output.spacing-finest(t))>1e-6)throw Error('저장한 3D Path 출력 간격이 현재 원본 voxel 간격과 달라 복원하지 않았습니다.');
      if(!next.points.every(p=>base.inside(p,geometry(t))))throw Error('저장한 경로 점이 현재 볼륨 밖에 있어 복원하지 않았습니다.');
      const key=keyOf(t),previous=records.get(key);
      const r={source:[t.source.uid,t.source.series],value:next,saved:JSON.stringify(next),final:null,preview:null,failed:null,seen:displayKey(t.views[next.cell].getProperties()),requested:{key:signature(next),volume:volume(t)}};
      records.set(key,r);
      try{
        cancel();refresh();
        if(bound?.group!==t.group)throw Error('3D Path 화면을 연결하지 못해 복원하지 않았습니다.');
        const mine=++generation,outcome=await run(r,bound,mine,'final',{current,deadline});
        if(outcome!=='done')throw Error(r.failed?'저장한 3D Path를 다시 계산하지 못했습니다. '+r.failed.message:'화면이 바뀌었거나 시간이 초과되어 3D Path 복원을 중단했습니다.');
        status.textContent='저장한 경로와 최종 펼친 표시를 복원했습니다.';paint();update();show();
      }catch(error){
        if(records.get(key)===r){if(previous)records.set(key,previous);else records.delete(key);}
        cancel();refresh();throw error;
      }
    },
    clearForJob(){if(!live())throw Error('3D Path 계정이 변경되었습니다.');cancel();navigation=null;records.clear();refresh();},
    inspect({values=false}={}){
      const r=bound&&record(bound);if(!r)return null;
      return {state:stateText.textContent,armed,busy,selected,generation,current:signature(r.value),value:r.value?structuredClone(r.value):null,final:pack(r.final,values),preview:pack(r.preview,values),failed:r.failed?{...r.failed}:null,navigation:navigation&&structuredClone(navigation)};
    }
  };
  window.kinMprPath=capability;const timer=setInterval(refresh,250);refresh();
  return {dispose(){ended=true;clearInterval(timer);cancel();unbind();records.clear();if(window.kinMprPath===capability)delete window.kinMprPath;window.removeEventListener('beforeunload',beforeUnload);for(const name of ['pointerdown','wheel','keydown'])document.removeEventListener(name,guard,true);panel.remove();}};
};
