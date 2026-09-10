window.kinCreateVolumeCrosshair=function({target,permitted,alive,host}){
  const panel=document.createElement('section');panel.id='kin-volume-crosshair';panel.style.cssText='border-top:1px solid #657c9f;padding:8px 0';
  panel.innerHTML='<strong>Crosshair Display</strong> <label>Style <select aria-label="Crosshair Style"><option value="normal">Normal</option><option value="gap" selected>Center Gap</option><option value="small">Small</option><option value="tapered">Tapered</option></select></label> <button type="button">Show Crosshairs</button><div class="planes"></div><p role="status"></p><p>표시 모양과 평면별 보이기만 바꿉니다. 이동·회전은 위쪽 Crosshairs 도구를 선택하세요. 이 표시 설정은 현재 영상 창에만 유지됩니다.</p>';
  host.append(panel);const select=panel.querySelector('select'),show=panel.querySelector('button'),planes=panel.querySelector('.planes'),status=panel.querySelector('[role=status]');
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
    const originals={},wrappers={},own={};
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
      }catch(error){visibleSegments.delete(ee.viewport.id);status.textContent='교차선 표시를 확인하지 못해 기본 표시로 돌아갑니다.';return original.call(this,ee,helper);}
    });
    replace('_pointNearTool',original=>function(element,annotation,point,proximity){if(!managed())return original.call(this,element,annotation,point,proximity);if(!enabled(element))return false;const lines=visibleSegments.get(viewId(element));if(lines&&!model.near(point,lines,proximity))return false;return original.call(this,element,annotation,point,proximity);});
    replace('getHandleNearImagePoint',original=>function(element,...args){if(managed()&&!enabled(element))return;return original.call(this,element,...args);});
    // Native activation requires a returned annotation; consume hidden-plane input before activation.
    replace('preMouseDownCallback',original=>function(event,...args){if(managed()&&!enabled(event.detail.element)){event.preventDefault();return true;}return original?.call(this,event,...args);});
    // OHIF assigns a different actor UID per viewport even when all actors reference one volume.
    replace('_checkIfViewportsRenderingSameScene',original=>function(view,other){const t=managed();if(!t||!t.views.includes(view)||!t.views.includes(other))return original.call(this,view,other);return view.getActors().length===1&&other.getActors().length===1&&cornerstone.cache.getVolume(view.getVolumeId())===cornerstone.cache.getVolume(other.getVolumeId());});
    bound={key:t.group,group,tool};
    restore=()=>{for(const name of Object.keys(originals))if(tool[name]===wrappers[name]){if(own[name])tool[name]=originals[name];else delete tool[name];}for(const v of t.views)try{v.render();}catch(_){}};
    t.views.forEach((v,index)=>{const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=!hidden.has(v.id);input.setAttribute('aria-label','Crosshair Plane '+(index+1));label.append(input,document.createTextNode(' Plane '+(index+1)+' '));planes.append(label);input.onchange=()=>{if(!usable()){input.checked=!hidden.has(v.id);return;}if(input.checked)hidden.delete(v.id);else hidden.add(v.id);v.render();};});
  }
  function refresh(){
    if(ended)return;const t=target();panel.hidden=!t||!alive();
    if(t&&t.group!==bound?.key)bind(t);
    if(!t&&bound)unbind();
    const disabled=!t||!bound||!usable();for(const control of panel.querySelectorAll('input,select,button'))control.disabled=disabled;
    if(t&&bound)status.textContent=bound.group.getToolOptions('Crosshairs')?.mode==='Disabled'?'교차선이 꺼져 있습니다. Show Crosshairs로 표시하세요.':'교차선 표시 설정 · 현재 창';
  }
  show.onclick=()=>{try{const t=target(true);if(!usable()||t?.group!==bound?.key)return;if(bound.group.getToolOptions('Crosshairs')?.mode==='Disabled')bound.group.setToolEnabled('Crosshairs');else bound.tool.computeToolCenter();renderAll(t);refresh();}catch(error){status.textContent=error.message;}};
  select.onchange=()=>{const t=target();if(usable()&&t?.group===bound?.key)renderAll(t);};
  const timer=setInterval(refresh,500);refresh();
  return {dispose(){ended=true;clearInterval(timer);unbind();panel.remove();}};
};
