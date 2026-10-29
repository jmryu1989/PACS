/* Minhoon item 12 (MH-4): one account's colour and line thickness for measurement marks.
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
  const colorOf=Object.fromEntries(colors.map(([id,,value])=>[id,value])),factorOf=Object.fromEntries(widths.map(([id,,value])=>[id,value]));
  const defaults=()=>({version:1,color:'default',width:'standard'});
  const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
  const normalize=v=>plain(v)&&v.version===1&&Object.keys(v).sort().join()==='color,version,width'&&
    typeof v.color==='string'&&Object.hasOwn(colorOf,v.color)&&typeof v.width==='string'&&Object.hasOwn(factorOf,v.width)?{version:1,color:v.color,width:v.width}:null;
  const key=owner=>'kin-marker-style:v1:'+owner;
  const storage=()=>{try{return globalThis.localStorage||null;}catch(_){return null;}};
  function read(owner){try{const raw=storage()?.getItem(key(owner));return raw&&raw.length<=256?normalize(JSON.parse(raw))||defaults():defaults();}catch(_){return defaults();}}
  function publish(owner,value){
    const clean=normalize(value);if(!owner||!clean)return false;
    let saved=false;try{const s=storage();if(s){s.setItem(key(owner),JSON.stringify(clean));saved=true;}}catch(_){}
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
    const stored=e=>{if(e.key===key(owner))apply(read(owner));};
    w.addEventListener?.('kin-marker-style-change',local);w.addEventListener?.('storage',stored);
    try{if(w.parent&&w.parent!==w){parent=w.parent;parent.addEventListener('kin-marker-style-change',local);}}catch(_){parent=null;}
    try{channel=new BroadcastChannel('kin-marker-style');channel.onmessage=e=>{if(e.data?.owner===owner)apply(read(owner));};}catch(_){}
    return()=>{w.removeEventListener?.('kin-marker-style-change',local);w.removeEventListener?.('storage',stored);try{parent?.removeEventListener('kin-marker-style-change',local);}catch(_){}channel?.close();};
  }
  // The viewer's default tool styles with the account's choice laid over them. A tool-specific
  // default replaces only what it already sets, since it would otherwise shadow the global one.
  function styles(baseline,value){
    const clean=normalize(value)||defaults(),color=colorOf[clean.color],factor=factorOf[clean.width],result={};
    const scale=v=>{const n=Number(v);return String((Number.isFinite(n)&&n>0?n:1)*factor);};
    const entries=Object.entries(plain(baseline)?baseline:{});if(!entries.some(([scope])=>scope==='global'))entries.push(['global',{}]);
    for(const [scope,entry] of entries){
      if(!plain(entry)){result[scope]=entry;continue;}
      const next={...entry},everywhere=scope==='global';
      if(color)for(const name of colorKeys)if(everywhere||Object.hasOwn(entry,name))next[name]=color;
      if(factor!==1)for(const name of Object.keys(entry).concat(everywhere&&!Object.hasOwn(entry,'lineWidth')?['lineWidth']:[]))
        if(/^lineWidth(?:[A-Z]|$)/.test(name))next[name]=scale(entry[name]);
      result[scope]=next;
    }
    return result;
  }
  // The viewer's style before any choice, kept per style registry for the document's life:
  // a later mount must not mistake an earlier choice for the viewer's own style.
  const baselines=new WeakMap();
  function mount({tools,cornerstone,owner}){
    const registry=tools?.annotation?.config?.style;
    if(!owner||typeof registry?.getDefaultToolStyles!=='function'||typeof registry.setDefaultToolStyles!=='function')return null;
    if(!baselines.has(registry))baselines.set(registry,JSON.parse(JSON.stringify(registry.getDefaultToolStyles()||{})));
    const baseline=baselines.get(registry);let shown=null,ended=false;
    function redraw(){
      for(const engine of cornerstone?.getRenderingEngines?.()||[])for(const viewport of engine.getViewports?.()||[]){
        try{if(typeof tools.utilities?.triggerAnnotationRender==='function'&&viewport.element)tools.utilities.triggerAnnotationRender(viewport.element);else viewport.render?.();}catch(_){}
      }
    }
    function apply(value){
      const clean=normalize(value)||defaults(),signature=JSON.stringify(clean);
      if(ended||signature===shown)return;
      try{registry.setDefaultToolStyles(styles(baseline,clean));shown=signature;}catch(_){return;}
      redraw();
    }
    apply(read(owner));const stop=subscribe(owner,apply);
    return {value:()=>shown&&JSON.parse(shown),dispose(){if(ended)return;ended=true;stop();}};
  }
  return {colors:colors.map(([id,label])=>[id,label]),widths:widths.map(([id,label])=>[id,label]),defaults,normalize,key,read,publish,subscribe,styles,mount};
});
