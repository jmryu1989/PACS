/* MH-4, A1 FB-111: one account's colour, line thickness, line style, arrowheads and text font for measurement marks.
 * Display only. The points, values and SR content of a mark never depend on it, so a choice
 * applies at once to every mark on this account's screens, old or new; another reader sees
 * their own choice. Printouts keep their fixed print style (viewer-job-print.js). */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.KinMarkerStyle=api;})(globalThis,()=>{
  // 'default' and 'standard' keep the viewer's own style exactly; green stays the selection colour.
  const colors=[['default','Default (Yellow)',null],['red','Red','rgb(255, 64, 64)'],['cyan','Cyan','rgb(0, 255, 255)'],['magenta','Magenta','rgb(255, 0, 255)'],['white','White','rgb(255, 255, 255)']];
  // Factors of the viewer's own width, so every step differs from the standard one on any build.
  const widths=[['standard','Standard',1],['thick','Thick',2],['extra-thick','Extra Thick',3]];
  // Locked marks (saved, or another reader's) follow the choice too: the decision covers every mark.
  // Highlighted and selected colours stay, since they show which mark the pointer is on.
  const colorKeys=['color','colorLocked','textBoxColor','textBoxColorLocked'];
  // Line style: 'default' keeps the viewer's own dashes (e.g. SR previews), 'solid' and 'dashed' apply to every mark.
  const lines=[['default','Default'],['solid','Solid'],['dashed','Dashed']];
  // Arrowheads of the marks drawn as arrows; the shaft, points and text stay.
  const arrowheads=[['on','On'],['off','Off']];
  // The value text font; the same families as the image text fonts of Appearance & Tools.
  const fonts=[['default','Default',null],['sans','Sans Serif','"Malgun Gothic", "Noto Sans KR", sans-serif'],['serif','Serif','"Batang", "Noto Serif KR", serif'],['mono','Monospace','"D2Coding", "Consolas", monospace']];
  const colorOf=Object.fromEntries(colors.map(([id,,value])=>[id,value])),factorOf=Object.fromEntries(widths.map(([id,,value])=>[id,value]));
  const fontOf=Object.fromEntries(fonts.map(([id,,value])=>[id,value])),lineIds=lines.map(([id])=>id),headIds=arrowheads.map(([id])=>id);
  const defaults=()=>({version:2,color:'default',width:'standard',line:'default',arrowheads:'on',font:'default'});
  const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
  const one=(v,ids)=>typeof v==='string'&&ids.includes(v);
  // Version 1 (colour and thickness only) is read as version 2 with the viewer's own line, arrowheads and font.
  const normalize=v=>{
    if(!plain(v)||!one(v.color,Object.keys(colorOf))||!one(v.width,Object.keys(factorOf)))return null;
    if(v.version===1&&Object.keys(v).sort().join()==='color,version,width')return {...defaults(),color:v.color,width:v.width};
    return v.version===2&&Object.keys(v).sort().join()==='arrowheads,color,font,line,version,width'&&one(v.line,lineIds)&&one(v.arrowheads,headIds)&&one(v.font,Object.keys(fontOf))?
      {version:2,color:v.color,width:v.width,line:v.line,arrowheads:v.arrowheads,font:v.font}:null;
  };
  // Version 2 has its own key: a page still running the version 1 code reads and writes only the old key, so it
  // cannot erase the new fields. The old key is kept current with the colour and thickness for such a page.
  const key=owner=>'kin-marker-style:v2:'+owner,oldKey=owner=>'kin-marker-style:v1:'+owner;
  const storage=()=>{try{return globalThis.localStorage||null;}catch(_){return null;}};
  function stored(name){const raw=storage()?.getItem(name);return raw&&raw.length<=256?normalize(JSON.parse(raw)):null;}
  function read(owner){try{const s=storage(),raw=s?.getItem(key(owner));if(raw!=null)return stored(key(owner))||defaults();return stored(oldKey(owner))||defaults();}catch(_){return defaults();}}
  function publish(owner,value){
    const clean=normalize(value);if(!owner||!clean)return false;
    let saved=false;try{const s=storage();if(s){s.setItem(key(owner),JSON.stringify(clean));saved=true;try{s.setItem(oldKey(owner),JSON.stringify({version:1,color:clean.color,width:clean.width}));}catch(_){}}}catch(_){}
    // The embedded viewer also listens here, so it follows even when storage refuses the write.
    host().dispatchEvent?.(new CustomEvent('kin-marker-style-change',{detail:{owner,value:clean}}));
    if(saved)try{const c=new BroadcastChannel('kin-marker-style');c.postMessage({owner});c.close();}catch(_){}
    return saved;
  }
  function host(){return globalThis.window||globalThis;}
  // Same-window and parent events carry the value; storage and channel notices re-read it,
  // so a late message from another window cannot replace a newer stored choice.
  function subscribe(owner,apply){
    const w=host();let parent=null,channel=null;
    const local=e=>{if(e.detail?.owner!==owner)return;const value=normalize(e.detail.value);if(value)apply(value);};
    const stored=e=>{if(e.key===key(owner)||e.key===oldKey(owner))apply(read(owner));};
    w.addEventListener?.('kin-marker-style-change',local);w.addEventListener?.('storage',stored);
    try{if(w.parent&&w.parent!==w){parent=w.parent;parent.addEventListener('kin-marker-style-change',local);}}catch(_){parent=null;}
    try{channel=new BroadcastChannel('kin-marker-style');channel.onmessage=e=>{if(e.data?.owner===owner)apply(read(owner));};}catch(_){}
    return()=>{w.removeEventListener?.('kin-marker-style-change',local);w.removeEventListener?.('storage',stored);try{parent?.removeEventListener('kin-marker-style-change',local);}catch(_){}channel?.close();};
  }
  // The viewer's default tool styles with the account's choice laid over them. A tool-specific
  // default replaces only what it already sets, since it would otherwise shadow the global one.
  // A tool group's own styles (OHIF dashes the SR preview tools there) outrank the defaults, so the same overlay is
  // laid over them without a global entry of its own.
  function styles(baseline,value,group=false){
    const clean=normalize(value)||defaults(),color=colorOf[clean.color],factor=factorOf[clean.width],dash=dashOf(clean),font=fontOf[clean.font],result={};
    const scale=v=>{const n=Number(v);return String((Number.isFinite(n)&&n>0?n:1)*factor);};
    const entries=Object.entries(plain(baseline)?baseline:{});if(!group&&!entries.some(([scope])=>scope==='global'))entries.push(['global',{}]);
    for(const [scope,entry] of entries){
      if(!plain(entry)){result[scope]=entry;continue;}
      const next={...entry},everywhere=!group&&scope==='global',set=name=>everywhere||Object.hasOwn(entry,name);
      if(color)for(const name of colorKeys)if(set(name))next[name]=color;
      if(factor!==1)for(const name of Object.keys(entry).concat(everywhere&&!Object.hasOwn(entry,'lineWidth')?['lineWidth']:[]))
        if(/^lineWidth(?:[A-Z]|$)/.test(name))next[name]=scale(entry[name]);
      // The value text's dotted link line (textBoxLinkLineDash) keeps its own dashes.
      if(dash!==null&&set('lineDash'))next.lineDash=dash;
      if(font&&set('textBoxFontFamily'))next.textBoxFontFamily=font;
      result[scope]=next;
    }
    return result;
  }
  // null keeps the viewer's own dashes; '' is a solid line. Dashes grow with the chosen thickness.
  function dashOf(clean){const f=factorOf[clean.width];return clean.line==='solid'?'':clean.line==='dashed'?6*f+','+4*f:null;}
  // For marks drawn outside Cornerstone (the manual MPR 3D annotations): the chosen colour, or null
  // for the painter's own, the factor for its own line width, the dash ('' or null: its own solid line) and the font.
  function look(value){const clean=normalize(value)||defaults();return {color:colorOf[clean.color],factor:factorOf[clean.width],dash:dashOf(clean)||null,font:fontOf[clean.font]};}
  // Arrowheads (no Cornerstone style covers them). drawArrow draws the shaft as line '<uid>' and the two head
  // strokes as lines '2' and '3' of the same annotation; the SVG node cache names them '<annotationUID>::line::2|3'.
  // Hiding sets visibility, an attribute the drawing code never writes, after each annotation render.
  const arrowTools=new Set(['ArrowAnnotate','SRArrowAnnotate','SRSCOORD3DPoint']);
  const drawsArrow=a=>arrowTools.has(a?.metadata?.toolName)||a?.metadata?.toolName==='DICOMSRDisplay'&&!!a.data?.renderableData?.POINT?.length;
  function heads(tools){
    const event=tools?.Enums?.Events?.ANNOTATION_RENDERED||'CORNERSTONE_TOOLS_ANNOTATION_RENDERED',doc=globalThis.document;
    const changed=new Map();let hidden=false;
    const restore=node=>{const was=changed.get(node);if(was===null)node.removeAttribute('visibility');else node.setAttribute('visibility',was);changed.delete(node);};
    function paint(detail){
      for(const node of [...changed.keys()])if(node.isConnected===false)changed.delete(node);
      if(!hidden){for(const node of [...changed.keys()])restore(node);return;}
      const cache=tools?.state?.svgNodeCache?.[detail?.viewportId+':'+detail?.renderingEngineId];
      for(const [name,entry] of Object.entries(cache||{})){
        const match=/^(.+)::line::[23]$/.exec(name),node=entry?.domRef;if(!match||!node?.setAttribute||changed.has(node))continue;
        let annotation=null;try{annotation=tools.annotation.state.getAnnotation(match[1]);}catch(_){}
        if(!drawsArrow(annotation))continue;
        changed.set(node,node.hasAttribute?.('visibility')?node.getAttribute('visibility'):null);node.setAttribute('visibility','hidden');
      }
    }
    const listener=e=>{try{paint(e.detail);}catch(_){}};
    doc?.addEventListener?.(event,listener,{capture:true});
    return {set(off){hidden=off;if(!off)for(const node of [...changed.keys()])restore(node);},dispose(){doc?.removeEventListener?.(event,listener,{capture:true});for(const node of [...changed.keys()])restore(node);}};
  }
  // The choice this document's viewer draws with, so those painters show the same as Cornerstone's marks.
  // Like the style registry it stays after a mount ends; null before any mount.
  let applied=null;
  const current=()=>applied&&{...applied};
  // The viewer's style before any choice, kept per style registry for the document's life:
  // a later mount must not mistake an earlier choice for the viewer's own style.
  const baselines=new WeakMap();
  // The tool groups' own styles as they stood before any choice (the SR preview group's dashes).
  function groupBaseline(registry){
    if(typeof registry.getToolGroupToolStyles!=='function'||typeof registry.setToolGroupToolStyles!=='function')return {};
    const out={};for(const id of Object.keys(plain(registry.config?.toolGroups)?registry.config.toolGroups:{})){const own=registry.getToolGroupToolStyles(id);if(plain(own))out[id]=JSON.parse(JSON.stringify(own));}
    return out;
  }
  function mount({tools,cornerstone,owner}){
    const registry=tools?.annotation?.config?.style;
    if(!owner||typeof registry?.getDefaultToolStyles!=='function'||typeof registry.setDefaultToolStyles!=='function')return null;
    if(!baselines.has(registry))baselines.set(registry,{global:JSON.parse(JSON.stringify(registry.getDefaultToolStyles()||{})),groups:groupBaseline(registry)});
    const {global:baseline,groups}=baselines.get(registry);let shown=null,ended=false;
    // Registered before the first redraw so the first render already hides heads when they are off.
    const arrows=heads(tools);
    function redraw(){
      for(const engine of cornerstone?.getRenderingEngines?.()||[])for(const viewport of engine.getViewports?.()||[]){
        try{if(typeof tools.utilities?.triggerAnnotationRender==='function'&&viewport.element)tools.utilities.triggerAnnotationRender(viewport.element);else viewport.render?.();}catch(_){}
      }
    }
    function apply(value){
      const clean=normalize(value)||defaults(),signature=JSON.stringify(clean);
      if(ended||signature===shown)return;
      try{registry.setDefaultToolStyles(styles(baseline,clean));for(const [id,own] of Object.entries(groups))registry.setToolGroupToolStyles(id,styles(own,clean,true));shown=signature;}catch(_){return;}
      arrows.set(clean.arrowheads==='off');applied=clean;redraw();
      host().dispatchEvent?.(new CustomEvent('kin-marker-style-shown',{detail:{...clean}}));
    }
    apply(read(owner));const stop=subscribe(owner,apply);
    return {value:()=>shown&&JSON.parse(shown),dispose(){if(ended)return;ended=true;stop();arrows.dispose();}};
  }
  return {colors:colors.map(([id,label])=>[id,label]),widths:widths.map(([id,label])=>[id,label]),lines:lines.map(r=>[...r]),arrowheads:arrowheads.map(r=>[...r]),fonts:fonts.map(([id,label])=>[id,label]),
    defaults,normalize,key,oldKey,read,publish,subscribe,styles,look,current,mount};
});
