window.kinCreateVolumeCrosshair=function({target,permitted,alive,host}){
  const panel=document.createElement('section');panel.id='kin-volume-crosshair';panel.style.cssText='border-top:1px solid #657c9f;padding:8px 0';
  panel.innerHTML='<strong>Crosshair Display</strong> <label>Style <select aria-label="Crosshair Style"><option value="normal">Normal</option><option value="gap" selected>Center Gap</option><option value="small">Small</option><option value="tapered">Tapered</option></select></label> <button type="button">Show Crosshairs</button><div class="planes"></div><p role="status"></p><p>교차선 모양과 평면별 표시를 설정합니다. 이동·회전은 위쪽 Crosshairs 도구를 선택하세요. 이 표시 설정은 현재 영상 창에만 유지됩니다.</p>';
  host.append(panel);const select=panel.querySelector('select'),show=panel.querySelector('button'),planes=panel.querySelector('.planes'),status=panel.querySelector('[role=status]');
  const wheelLabel=document.createElement('label'),wheel=document.createElement('input');wheel.type='checkbox';wheel.setAttribute('aria-label','Wheel Changes Thickness');wheelLabel.append(wheel,document.createTextNode(' Wheel Changes Thickness'));planes.after(wheelLabel);
  const wheelHelp=document.createElement('p');wheelHelp.textContent='조작할 창을 먼저 선택하세요. Crosshairs 도구와 휠 두께 조절을 켠 뒤 교차선 위에서 휠을 돌리면 그 선에 대응하는 평면의 전체 두께가 한 칸당 1 mm씩 바뀝니다. 처음에는 Average로 표시하며, 선 밖에서는 기존 슬라이스 이동을 유지합니다.';wheelLabel.after(wheelHelp);
  let messageUntil=0;const announce=text=>{status.textContent=text;messageUntil=Date.now()+8000;};
  let ended=false,bound=null,preferenceGroup=null,restore=()=>{};const hidden=new Set(),visibleSegments=new Map(),model=window.KinVolumeCrosshair;
  const usable=()=>{try{return !ended&&alive()&&permitted();}catch(_){return false;}};
  const viewId=element=>{try{return cornerstone.getEnabledElement(element).viewport.id;}catch(_){return null;}};
  const managed=()=>{try{const t=target();return t&&bound?.key===t.group?t:null;}catch(_){return null;}};
  function unbind(){const previous=restore;restore=()=>{};bound=null;visibleSegments.clear();previous();}
  function renderAll(t){for(const v of t.views)v.render();}
  function bind(t){
    unbind();if(preferenceGroup!==t.group){hidden.clear();preferenceGroup=t.group;}planes.replaceChildren();
    const groups=t.views.map(v=>cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId));
    if(!groups[0]||groups.some(g=>g!==groups[0]))return;
    const group=groups[0],tool=group.getToolInstance('Crosshairs');if(!tool?.renderAnnotation||!tool._pointNearTool)return;
    const originals={},wrappers={},own={},activeElements=new Set();
    const replace=(name,wrap)=>{own[name]=Object.hasOwn(tool,name);originals[name]=tool[name];wrappers[name]=wrap(originals[name]);tool[name]=wrappers[name];};
    const enabled=element=>usable()&&!hidden.has(viewId(element));
    replace('renderAnnotation',original=>function(ee,helper){
      if(!managed()){visibleSegments.delete(ee.viewport.id);return original.call(this,ee,helper);}
      if(hidden.has(ee.viewport.id)){visibleSegments.delete(ee.viewport.id);return false;}
      if(!usable()){visibleSegments.delete(ee.viewport.id);return original.call(this,ee,helper);}
      try{
      const lines=[];const isReference=key=>/::line::[01](?:One|Two)$/.test(key);
      // Capture only the native reference-line nodes, leaving other annotations and handles intact.
      const proxy={...helper,getSvgNode:key=>isReference(key)?undefined:helper.getSvgNode(key),appendNode:(node,key)=>{if(isReference(key))lines.push({node,key});else helper.appendNode(node,key);}};
      const gap=this.configuration.referenceLinesCenterGapRadius;let result;
      try{this.configuration.referenceLinesCenterGapRadius=0;result=original.call(this,ee,proxy);}finally{this.configuration.referenceLinesCenterGapRadius=gap;}
      const segments=[],pending=[];
      const center=ee.viewport.worldToCanvas(this.toolCenter),canvas=ee.viewport.getCanvas();
      for(let index=0;index<2;index++){
        const source=lines.find(line=>new RegExp('::'+index+'(?:One|Two)$').test(line.key)&&Math.hypot(Number(line.node.getAttribute('x2'))-Number(line.node.getAttribute('x1')),Number(line.node.getAttribute('y2'))-Number(line.node.getAttribute('y1')))>1e-8);if(!source)continue;
        const n=source.node,dx=Number(n.getAttribute('x2'))-Number(n.getAttribute('x1')),dy=Number(n.getAttribute('y2'))-Number(n.getAttribute('y1'));
        if(Math.hypot(dx,dy)<1e-8)continue;
        const parts=model.segments(Array.from(center),[dx,dy],canvas.clientWidth,canvas.clientHeight,select.value);segments.push(...parts);
        parts.forEach((part,i)=>pending.push({part,key:source.key+'::kin-'+select.value+'-'+i,index,n,dx,dy}));
      }
      for(const {part,key,index,n,dx,dy} of pending){
          const tag=select.value==='tapered'?'polygon':'line';let node=helper.getSvgNode(key);
          if(!node){node=document.createElementNS('http://www.w3.org/2000/svg',tag);helper.appendNode(node,key);}else helper.setNodeTouched(key);
          node.setAttribute('data-kin-crosshair',String(index));
          if(tag==='line'){
            for(const [name,value] of Object.entries({x1:part.start[0],y1:part.start[1],x2:part.end[0],y2:part.end[1],stroke:n.getAttribute('stroke'),'stroke-width':n.getAttribute('stroke-width')}))node.setAttribute(name,String(value));
          }else{
            const length=Math.hypot(dx,dy),normal=[-dy/length,dx/length],extent=Math.max(Math.abs(part.range[0]),Math.abs(part.range[1]),1);
            const points=[...[[part.start,part.range[0],1],[part.end,part.range[1],1],[part.end,part.range[1],-1],[part.start,part.range[0],-1]]].map(([point,d,sign])=>point.map((x,j)=>x+normal[j]*sign*(.25+1.75*Math.abs(d)/extent)).join(','));
            node.setAttribute('points',points.join(' '));node.setAttribute('fill',n.getAttribute('stroke'));node.setAttribute('stroke','none');
          }
      }
      visibleSegments.set(ee.viewport.id,segments);return result;
      }catch(error){visibleSegments.delete(ee.viewport.id);announce('교차선 표시를 확인하지 못해 기본 표시로 돌아갑니다.');return original.call(this,ee,helper);}
    });
    replace('_pointNearTool',original=>function(element,annotation,point,proximity){if(!managed())return original.call(this,element,annotation,point,proximity);if(!enabled(element))return false;const lines=visibleSegments.get(viewId(element));if(lines&&!model.near(point,lines,proximity))return false;return original.call(this,element,annotation,point,proximity);});
    replace('getHandleNearImagePoint',original=>function(element,...args){if(managed()&&!enabled(element))return;return original.call(this,element,...args);});
    // Native activation requires a returned annotation; consume hidden-plane input before activation.
    replace('preMouseDownCallback',original=>function(event,...args){if(managed()&&!enabled(event.detail.element)){event.preventDefault();return true;}return original?.call(this,event,...args);});
    // OHIF assigns a different actor UID per viewport even when all actors reference one volume.
    replace('_checkIfViewportsRenderingSameScene',original=>function(view,other){const t=managed();if(!t||!t.views.includes(view)||!t.views.includes(other))return original.call(this,view,other);return view.getActors().length===1&&other.getActors().length===1&&cornerstone.cache.getVolume(view.getVolumeId())===cornerstone.cache.getVolume(other.getVolumeId());});
    replace('_activateModify',original=>function(element){activeElements.add(element);return original.call(this,element);});
    replace('_deactivateModify',original=>function(element){activeElements.delete(element);return original.call(this,element);});
    replace('_dragCallback',original=>function(event){
      const t=managed(),element=event.detail.element;
      // The pinned native ROTATE operation is 2. Other operations retain their native path.
      // EventTarget invokes listeners with the element as `this`; native callbacks
      // are arrow functions, so consult the captured tool instead.
      if(!t||tool.editData?.annotation?.data?.handles.activeOperation!==2)return original.call(tool,event);
      if(!enabled(element))return;
      const active=t.views.find(v=>v.element===element);if(!active)return;
      let pivot;
      try{pivot=window.KinVolumeOrientation.intersection(t.cameras);}catch(_){return original.call(tool,event);}
      let changed=false;
      try{
        const center=Array.from(active.worldToCanvas(pivot)),point=Array.from(event.detail.currentPoints.canvas),previous=point.map((n,i)=>n-event.detail.deltaPoints.canvas[i]);
        const origin=active.canvasToWorld(center),x=active.canvasToWorld([center[0]+1,center[1]]).map((n,i)=>n-origin[i]),y=active.canvasToWorld([center[0],center[1]+1]).map((n,i)=>n-origin[i]);
        const normal=active.getCamera().viewPlaneNormal,cross=[x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0]];
        // Derive canvas handedness from the actual mapping, including flipped views.
        const handedness=Math.sign(cross.reduce((sum,n,i)=>sum+n*normal[i],0));
        const angle=-handedness*model.rotationDegrees(center,previous,point);if(!angle)return;
        // Per-event rounding to 0.01 radians loses slow motion and compounds
        // angle error. Apply the actual pointer angle to both linked planes.
        const next=window.KinVolumeOrientation.rotate(t.cameras,active.getCamera().viewPlaneNormal,angle);
        changed=true;t.views.forEach((v,i)=>{if(v!==active){const {position,focalPoint,viewUp,viewPlaneNormal}=next[i];v.setCamera({position,focalPoint,viewUp,viewPlaneNormal});v.render();}});
      }catch(error){const now=managed();if(changed&&now?.group===t.group&&now.selection===t.selection)for(let i=0;i<t.views.length;i++)try{const {position,focalPoint,viewUp,viewPlaneNormal}=t.cameras[i];t.views[i].setCamera({position,focalPoint,viewUp,viewPlaneNormal});t.views[i].render();}catch(_){}announce(error.message||'MPR 회전 방향을 확인하지 못했습니다.');}
    });
    let wheelRemainder=0,wheelTarget='';
    wheel.onchange=()=>{wheelRemainder=0;wheelTarget='';};
    const onWheel=event=>{
      if(!wheel.checked||group.getToolOptions('Crosshairs')?.mode!=='Active'||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||!Number.isFinite(event.deltaY)||event.deltaY===0)return;
      const current=managed();if(!current)return;
      const consume=()=>{event.preventDefault();event.stopImmediatePropagation();};
      if(!usable()||activeElements.size){consume();wheelRemainder=0;return;}
      if(hidden.has(viewId(event.currentTarget))){wheelRemainder=0;return;}
      const active=current.views.find(v=>v.element===event.currentTarget);if(!active)return;
      const canvas=active.getCanvas(),rect=canvas.getBoundingClientRect(),point=[(event.clientX-rect.left)*canvas.clientWidth/rect.width,(event.clientY-rect.top)*canvas.clientHeight/rect.height];
      const lines=visibleSegments.get(active.id);if(!lines||!model.near(point,lines,6)){wheelRemainder=0;return;}
      consume();const changed=[];
      try{
        const ee=cornerstone.getEnabledElement(active.element),annotation=tool.filterInteractableAnnotationsForElement(active.element,tool._getAnnotations(ee))[0];
        const center=Array.from(active.worldToCanvas(tool.toolCenter)),views=new Set();
        for(const [world,other] of annotation?.data.handles.rotationPoints||[]){
          if(!current.views.includes(other)||other===active)continue;
          const q=active.worldToCanvas(world),parts=model.segments(center,[q[0]-center[0],q[1]-center[1]],canvas.clientWidth,canvas.clientHeight,select.value);
          if(model.near(point,parts,6))views.add(other);
        }
        if(!views.size)throw Error('교차선의 대상 평면을 확인하지 못했습니다.');
        const key=JSON.stringify([current.group,active.id,[...views].map(v=>v.id)]);if(key!==wheelTarget){wheelTarget=key;wheelRemainder=0;}
        let steps;
        if(event.deltaMode===0&&Math.abs(event.deltaY)>=50){steps=Math.sign(event.deltaY);wheelRemainder=0;}
        else{wheelRemainder+=event.deltaY*(event.deltaMode===1?40:event.deltaMode===2?120:1);steps=Math.trunc(wheelRemainder/120);wheelRemainder-=steps*120;}
        if(!steps)return;
        const checked=target(true);if(!checked||checked.group!==current.group||checked.selection!==current.selection||!usable())throw Error('화면이 바뀌었습니다. 대상 평면을 다시 확인하세요.');
        for(const v of views){
          const volume=cornerstone.cache.getVolume(v.getVolumeId()),max=Math.min(1000,Math.hypot(...volume.dimensions.map((n,i)=>(n-1)*volume.spacing[i]))),before=v.getSlabThickness(),blend=v.getActors()[0].actor.getMapper().getBlendMode();
          if(![0,1,2,3].includes(blend)||!Number.isFinite(before)||before<=0)throw Error('현재 투영 모드와 두께를 확인하세요.');
          const total=Math.min(max,Math.max(.2,before*2-steps)),next=blend===0?3:blend;
          if(next===3)window.kinPrepareVolumeAverage(v,volume);
          changed.push({v,before,blend});v.setBlendMode(next);v.setSlabThickness(total/2);v.render();
          if(Math.abs(v.getSlabThickness()*2-total)>1e-6||v.getActors()[0].actor.getMapper().getBlendMode()!==next)throw Error('휠 두께 적용 결과를 확인하지 못했습니다.');
        }
        renderAll(current);announce(changed.map(({v})=>'Plane '+(current.views.indexOf(v)+1)+' · '+Number((v.getSlabThickness()*2).toFixed(3))+' mm').join(' / '));
      }catch(error){const now=managed();if(now?.group===current.group&&now.selection===current.selection)for(const {v,before,blend} of changed)try{v.setBlendMode(blend);v.setSlabThickness(before);v.render();}catch(_){}announce(error.message||'휠 두께를 적용하지 못했습니다.');}
    };
    for(const v of t.views)v.element.addEventListener('wheel',onWheel,{capture:true,passive:false});
    bound={key:t.group,group,tool};
    restore=()=>{for(const v of t.views)v.element.removeEventListener('wheel',onWheel,true);for(const element of activeElements)try{originals._deactivateModify.call(tool,element);element.style.cursor='';}catch(_){}if(activeElements.size){const data=tool.editData?.annotation?.data;if(data){data.handles.activeOperation=null;data.activeViewportIds=[];}tool.editData=null;activeElements.clear();}for(const name of Object.keys(originals))if(tool[name]===wrappers[name]){if(own[name])tool[name]=originals[name];else delete tool[name];}for(const v of t.views)try{v.render();}catch(_){}};
    t.views.forEach((v,index)=>{const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=!hidden.has(v.id);input.setAttribute('aria-label','Crosshair Plane '+(index+1));label.append(input,document.createTextNode(' Plane '+(index+1)+' '));planes.append(label);input.onchange=()=>{if(!usable()){input.checked=!hidden.has(v.id);return;}if(input.checked)hidden.delete(v.id);else hidden.add(v.id);v.render();};});
  }
  function refresh(){
    if(ended)return;const t=target();panel.hidden=!t||!alive();
    if(t&&t.group!==bound?.key)bind(t);
    if(!t&&bound)unbind();
    const disabled=!t||!bound||!usable();for(const control of panel.querySelectorAll('input,select,button'))control.disabled=disabled;
    if(t&&bound&&Date.now()>=messageUntil)status.textContent=bound.group.getToolOptions('Crosshairs')?.mode==='Disabled'?'교차선이 꺼져 있습니다. Show Crosshairs로 표시하세요.':'교차선 표시 설정 · 현재 창';
  }
  show.onclick=()=>{try{const t=target(true);if(!usable()||t?.group!==bound?.key)return;if(bound.group.getToolOptions('Crosshairs')?.mode==='Disabled')bound.group.setToolEnabled('Crosshairs');else bound.tool.computeToolCenter();renderAll(t);refresh();}catch(error){announce(error.message);}};
  select.onchange=()=>{const t=target();if(usable()&&t?.group===bound?.key)renderAll(t);};
  const timer=setInterval(refresh,500);refresh();
  return {dispose(){ended=true;clearInterval(timer);unbind();panel.remove();}};
};
