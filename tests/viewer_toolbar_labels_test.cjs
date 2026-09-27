// S5-UI5 (VUI-04, F#4): the fixed viewer's toolbar gets English names (aria-label), Korean descriptions (title) and a pressed
// state that is not colour alone; tool IDs, data-cy, commands, order and shortcuts stay the viewer's. The shipped config/ohif.js
// runs whole in a small element model and its logo component (whiteLabeling.createLogoComponentFn, what the viewer mounts) labels
// the toolbar; the shipped viewer-tech-note.js is loaded beside it for its Edit Toolbar dialog and its Tech Note bridge. The real
// OHIF bundle (its toolbar DOM, class names and where split-button lists render) lives only in the container and is not judged
// here. Which buttons a document that is not a confirmed writer keeps (Capture with the authoring buttons) is run on the shipped
// config by clinician_viewer_dom_test.py 08/13/28. No source text is matched: every case runs the shipped code (D73 §1-B).
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const config=fs.readFileSync('config/ohif.js','utf8');
const techNote=fs.readFileSync('worklist-v0/hpacs-lite/viewer-tech-note.js','utf8');

// The selector forms the scripts under test use: compounds of a tag (or *), #id, .class, [attr] and [attr="value"], optionally
// :not(:disabled), joined by descendant spaces, in comma lists. Any other form throws, so a changed selector shows up here instead
// of matching nothing.
function compound(text){
  const parts=/^(\*|[a-z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)(:not\(:disabled\))?$/i.exec(text);
  if(!text||!parts)throw new Error('selector outside the element model: '+text);
  const checks=[];
  if(parts[1]&&parts[1]!=='*')checks.push(e=>e.localName===parts[1]);
  for(const [,sign,name,value] of parts[2].matchAll(/([#.[])([\w-]+)(?:="([^"]*)")?\]?/g))
    checks.push(sign==='#'?e=>e.getAttribute('id')===name:sign==='.'?e=>(e.getAttribute('class')||'').split(/\s+/).includes(name)
      :value===undefined?e=>e.hasAttribute(name):e=>e.getAttribute(name)===value);
  if(parts[3])checks.push(e=>!e.disabled);
  return e=>checks.every(check=>check(e));
}
function matcher(selector){
  const chains=selector.split(',').map(part=>part.trim().split(/\s+/).map(compound));
  return element=>chains.some(chain=>{
    if(!chain[chain.length-1](element))return false;
    let i=chain.length-2;
    for(let n=element.parentElement;n&&i>=0;n=n.parentElement)if(chain[i](n))i--;
    return i<0;
  });
}

const dataName=key=>'data-'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());
class Text{
  constructor(data){this.nodeType=3;this.data=String(data);this.parentElement=null;}
  get textContent(){return this.data;}
}
// An element as the DOM gives it to these scripts: attributes (id and dataset reflect them), child nodes with text nodes among
// them, and a mutation record for every attribute write and child change while it is in the document.
class El{
  constructor(doc,tag){this.doc=doc;this.localName=tag;this.nodeType=1;this.nodes=[];this.parentElement=null;this.attrs=new Map();
    this.disabled=false;this.listeners=new Map();
    const styles=new Map();this.style={setProperty:(k,v)=>styles.set(k,v),getPropertyValue:k=>styles.get(k)||''};
    this.dataset=new Proxy({},{get:(_,k)=>typeof k==='string'&&this.hasAttribute(dataName(k))?this.getAttribute(dataName(k)):undefined,
      set:(_,k,v)=>{this.setAttribute(dataName(k),v);return true;},has:(_,k)=>this.hasAttribute(dataName(k)),
      deleteProperty:(_,k)=>{this.removeAttribute(dataName(k));return true;}});}
  get id(){return this.getAttribute('id')??'';}
  set id(v){this.setAttribute('id',v);}
  get children(){return this.nodes.filter(n=>n.nodeType===1);}
  get childElementCount(){return this.children.length;}
  get childNodes(){return this.nodes;}
  get textContent(){return this.nodes.map(n=>n.textContent).join('');}
  set textContent(v){this.nodes.forEach(n=>{n.parentElement=null;});this.nodes=String(v)?[new Text(v)]:[];this.nodes.forEach(n=>{n.parentElement=this;});
    this.doc.changed(this,{type:'childList'});}
  get isConnected(){return this.doc.connected(this);}
  setAttribute(k,v){this.attrs.set(k,String(v));this.doc.changed(this,{type:'attributes',attributeName:k});}
  removeAttribute(k){if(!this.attrs.has(k))return;this.attrs.delete(k);this.doc.changed(this,{type:'attributes',attributeName:k});}
  hasAttribute(k){return this.attrs.has(k);}
  getAttribute(k){return this.attrs.has(k)?this.attrs.get(k):null;}
  contains(n){for(;n;n=n.parentElement)if(n===this)return true;return false;}
  closest(sel){const match=matcher(sel);for(let n=this;n;n=n.parentElement)if(match(n))return n;return null;}
  querySelectorAll(sel){const match=matcher(sel),out=[];const walk=e=>e.children.forEach(c=>{if(match(c))out.push(c);walk(c);});walk(this);return out;}
  querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
  append(...kids){
    kids=kids.map(k=>typeof k==='string'?new Text(k):k);
    kids.forEach(k=>{if(k.parentElement)k.parentElement.nodes.splice(k.parentElement.nodes.indexOf(k),1);k.parentElement=this;this.nodes.push(k);});
    this.doc.changed(this,{type:'childList',addedNodes:kids});return this;}
  remove(){const p=this.parentElement;if(!p)return;p.nodes.splice(p.nodes.indexOf(this),1);this.parentElement=null;this.doc.changed(p,{type:'childList'});}
  // A React re-render of the toolbar section: new button nodes in place of the old ones.
  replaceChildren(...kids){this.nodes.forEach(c=>{c.parentElement=null;});this.nodes=[];this.append(...kids);}
  // Laid out while it is in the document and not hidden; focus is the document's active element.
  getClientRects(){return this.doc.connected(this)&&!this.closest('[hidden]')?[{}]:[];}
  focus(){this.doc.activeElement=this;}
  scrollIntoView(){}
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
  // A <dialog>: showModal and close set and clear its open attribute.
  showModal(){this.setAttribute('open','');}
  close(){this.removeAttribute('open');}
  get open(){return this.hasAttribute('open');}
  // A user's click: the handler the script gave the element.
  click(){this.onclick?.({type:'click',target:this});}
}
function world(){
  const observers=new Set();let html;
  const doc={title:'',activeElement:null,
    connected:e=>{for(let n=e;n;n=n.parentElement)if(n===html)return true;return false;},
    changed:(target,record)=>{
      if(!doc.connected(target))return;
      const full={target,addedNodes:[],...record};
      observers.forEach(o=>{if(o.on&&o.wants(full))queueMicrotask(()=>{if(o.on)o.cb([full]);});});
    },
    createElement:tag=>new El(doc,tag),createTextNode:data=>new Text(data),
    getElementById:id=>html.querySelectorAll('*').find(e=>e.getAttribute('id')===id)||null,
    querySelectorAll:sel=>html.querySelectorAll(sel),querySelector:sel=>html.querySelector(sel)};
  const el=(tag,text,...kids)=>{const e=new El(doc,tag);if(text)e.nodes.push(Object.assign(new Text(text),{parentElement:e}));
    kids.forEach(k=>{k.parentElement=e;e.nodes.push(k);});return e;};
  doc.head=el('head');doc.body=el('body');html=el('html','',doc.head,doc.body);
  // A record reaches the callback only as a real observer with these options would send it: its kind asked for (an attribute
  // filter asks for attributes), the attribute in the filter, and a record below the observed node only with subtree.
  class MutationObserver{
    constructor(cb){this.cb=cb;this.on=false;}
    observe(target,options){this.target=target;this.options=options;this.on=true;observers.add(this);}
    disconnect(){this.on=false;observers.delete(this);}
    wants(record){
      const o=this.options,asked=record.type==='attributes'?!!(o.attributes||o.attributeFilter):!!o[record.type];
      return asked&&(record.type!=='attributes'||!o.attributeFilter||o.attributeFilter.includes(record.attributeName))
        &&(record.target===this.target||!!o.subtree&&this.target.contains(record.target));
    }
  }
  // An embedded viewer (window.top is another window) showing one study, as the Tech Note bridge reads it.
  const stored=new Map();
  const ctx={document:doc,MutationObserver,Node:{ELEMENT_NODE:1},BroadcastChannel:class{addEventListener(){}removeEventListener(){}close(){}},
    queueMicrotask,URLSearchParams,location:{search:'?StudyInstanceUIDs=1.2.840.99.1',hash:''},top:{},
    localStorage:{getItem:k=>stored.has(k)?stored.get(k):null,setItem:(k,v)=>{stored.set(k,String(v));},removeItem:k=>{stored.delete(k);}},
    getComputedStyle:e=>({visibility:e.style.getPropertyValue('visibility')||'visible'}),addEventListener(){},removeEventListener(){}};
  ctx.window=ctx;
  vm.createContext(ctx);
  vm.runInContext(config,ctx,{filename:'config/ohif.js'});
  vm.runInContext(techNote,ctx,{filename:'viewer-tech-note.js'});
  // The viewer mounts the logo the configuration gives it; its effect runs once and its clean-up at unmount.
  let cleanup=null;
  const React={useEffect:fn=>{cleanup=fn();},createElement:(type,props)=>({type,props})};
  const mount=()=>{const logo=ctx.window.config.whiteLabeling.createLogoComponentFn(React);logo.type(logo.props);};
  return {doc,body:doc.body,el,ctx,mount,unmount:()=>cleanup&&cleanup()};
}
const tick=()=>new Promise(r=>setImmediate(r));
const cy=(e,v)=>{e.attrs.set('data-cy',v);return e;};
const icon=el=>el('svg','',el('title','tool icon'));
// One primary-section button as the pinned viewer renders it (icon only), or a split button's primary and list parts.
function tool(el,id,{active=false,items=null}={}){
  if(!items){const b=cy(el('button','',icon(el)),id);if(active)b.attrs.set('class','bg-primary-light');return b;}
  const primary=cy(el('button','',icon(el)),id+'-split-button-primary'),secondary=cy(el('button','',icon(el)),id+'-split-button-secondary');
  if(active)primary.attrs.set('class','bg-primary-light');
  const list=el('div','',...items.map(([item,shown])=>cy(el('div','',icon(el),...(shown?[el('span',shown)]:[])),item)));
  return el('div','',primary,secondary,list);
}
// The pinned longitudinal mode's primary section, and the list items of its two split buttons (clinician_viewer_dom_test.py
// PRIMARY_SECTION / toolbarButtons).
const SECTION=['MeasurementTools','Zoom','Pan','TrackballRotate','WindowLevel','Capture','Layout','Crosshairs','MoreTools'];
const MEASURE_ITEMS=['Length','Bidirectional','ArrowAnnotate','EllipticalROI','RectangleROI','CircleROI','PlanarFreehandROI','SplineROI','LivewireContour'];
const MORE_ITEMS=['Reset','rotate-right','flipHorizontal','ImageSliceSync','ReferenceLines','ImageOverlayViewer','StackScroll','invert','Probe',
  'Cine','Angle','CobbAngle','Magnify','CalibrationLine','TagBrowser','AdvancedMagnify','UltrasoundDirectionalTool','WindowLevelRegion'];
const MEASURE=[['Length','Length'],['Bidirectional','Bidirectional'],['ArrowAnnotate','Arrow Annotate'],['EllipticalROI','Ellipse'],['LivewireContour','']];
const MORE=[['Reset','Reset View'],['rotate-right','Rotate Right'],['ImageSliceSync','Image Slice Sync'],['Cine','Cine'],['TagBrowser','']];
// The English names VUI-04 gives the primary buttons (the names the Edit Toolbar dialog shows).
const NAMES={MeasurementTools:'Measurements',Zoom:'Zoom',Pan:'Pan',TrackballRotate:'3D Rotate',WindowLevel:'Window / Level',Capture:'Capture',
  Layout:'Layout',Crosshairs:'Crosshairs',MoreTools:'More Tools'};
function toolbar(el,ids=SECTION,active='WindowLevel',lists={MeasurementTools:MEASURE,MoreTools:MORE}){
  return ids.map(id=>tool(el,id,{active:id===active,items:lists[id]||null}));
}
function header(el,bar){
  const brand=el('div','',el('span','KOREA IMAGING'));brand.attrs.set('id','kin-viewer-brand');
  const h=el('div','',brand,bar,el('div','',el('button','⚙')));h.attrs.set('class','bg-secondary-dark z-20 flex');
  return h;
}
const byCy=(root,v)=>root.querySelectorAll('*').find(e=>e.getAttribute('data-cy')===v);
const order=root=>root.querySelectorAll('*').map(e=>e.getAttribute('data-cy')).filter(Boolean);
const hangul=s=>/[가-힣]/.test(s);
// The toolbar's primary buttons in the order they are on screen, with the name each is read by (a split button by its primary part).
const primaryNames=bar=>bar.querySelectorAll('*').map(e=>[e.getAttribute('data-cy'),e]).filter(([v])=>v)
  .map(([v,e])=>[v.replace(/-split-button-primary$/,''),e]).filter(([id])=>SECTION.includes(id)).map(([id,e])=>[id,e.getAttribute('aria-label')]);
// Every attribute record under `root` from now on, as any other observer of the page would receive it.
function recorder(w,root){
  const seen=[],o=new w.ctx.MutationObserver(records=>seen.push(...records.filter(r=>r.type==='attributes').map(r=>r.attributeName)));
  o.observe(root,{attributes:true,subtree:true});
  return {seen,stop:()=>o.disconnect()};
}
function labelled(w,ids=SECTION,lists){
  const bar=w.el('div','',...toolbar(w.el,ids,'WindowLevel',lists)),h=header(w.el,bar);
  w.body.append(h);w.mount();
  return {bar,h};
}

test('names: every tool of the pinned toolbar is read by an English name and explained in Korean; the pressed state only on tools that switch on',async()=>{
  const w=world();
  // Icon-only list items: every item name comes from the labels, none from shown text.
  const {h}=labelled(w,SECTION,{MeasurementTools:MEASURE_ITEMS.map(id=>[id,'']),MoreTools:MORE_ITEMS.map(id=>[id,''])});
  for(const id of [...SECTION.map(id=>['MeasurementTools','MoreTools'].includes(id)?id+'-split-button-primary':id),
    'MeasurementTools-split-button-secondary','MoreTools-split-button-secondary',...MEASURE_ITEMS,...MORE_ITEMS]){
    const e=byCy(h,id),name=e.getAttribute('aria-label'),description=e.getAttribute('title');
    assert.ok(name&&!hangul(name),id+' has an English name: '+name);
    assert.ok(description&&hangul(description),id+' has a Korean description: '+description);
  }
  assert.deepEqual(primaryNames(h).map(([id,name])=>[id,name]),SECTION.map(id=>[id,NAMES[id]]),'the nine names, in the viewer\'s order');
  const title=id=>byCy(h,id).getAttribute('title');
  assert.equal(title('Capture'),'현재 화면을 PNG로 저장(검사 저장 아님)');
  assert.equal(title('Crosshairs'),'MPR 교차선(3D/MPR에서만 동작)');
  assert.equal(title('TrackballRotate'),'3D 회전(볼륨에서만 동작)');
  assert.equal(title('WindowLevel'),'창/레벨 조절(드래그) · 사용 중');
  assert.deepEqual([byCy(h,'EllipticalROI').getAttribute('aria-label'),title('EllipticalROI')],['Ellipse ROI','타원 ROI(HU)']);
  const pressed=h.querySelectorAll('[aria-pressed]').map(e=>e.getAttribute('data-cy').replace(/-split-button-primary$/,'')).sort();
  assert.deepEqual(pressed,['Crosshairs','MeasurementTools','Pan','TrackballRotate','WindowLevel','Zoom'],'Capture, Layout and More Tools are actions or lists');
  w.unmount();
});

// The Edit Toolbar dialog (viewer-tech-note.js kinCreateViewerToolbarPreferences, as the Tech Note bridge mounts it) over the pinned
// viewer's toolbarService: its primary section as the dialog reads and writes it.
function viewerSection(ids){
  const sections={primary:ids.slice()};
  return {sections,service:{EVENTS:{TOOL_BAR_MODIFIED:'syn-toolbar-modified'},subscribe:()=>({unsubscribe(){}}),
    getButtonSection:key=>(sections[key]||[]).map(id=>({id})),clearButtonSection:key=>{sections[key]=[];},
    createButtonSection:(key,list)=>{sections[key]=[...(sections[key]||[]),...list];}}};
}
function preferences(w,viewer){
  const host=w.el('div','');w.body.append(host);
  const controller=w.ctx.kinCreateViewerToolbarPreferences({services:{toolbarService:viewer.service},host,owner:()=>['SYN-INST','SYN-SUB'],live:()=>true});
  return {controller,host};
}
const button=(root,text)=>root.querySelectorAll('button').find(b=>b.textContent===text);
// The open dialog's rows as a user reads them: the tool's name, whether it is shown, whether that can change, and its checkbox name.
function editorRows(w){
  const dialog=w.doc.querySelector('dialog[open]');
  assert.ok(dialog,'the Edit Toolbar dialog is open');
  return dialog.querySelectorAll('label').map(label=>{const check=label.querySelector('input');
    return {name:label.textContent.trim(),shown:check.checked,locked:check.disabled,check:check.getAttribute('aria-label'),row:label.parentElement,box:check};});
}

test('Edit Toolbar: the dialog lists the toolbar\'s tools by the names the toolbar reads, in its order; a change keeps the viewer\'s ids',async()=>{
  const w=world();
  const {bar}=labelled(w);
  const viewer=viewerSection(SECTION),{controller,host}=preferences(w,viewer);
  assert.ok(controller,'the editor takes the viewer\'s own section');
  button(host,'Edit Toolbar').click();
  let rows=editorRows(w);
  const onBar=primaryNames(bar);
  assert.deepEqual(rows.map(r=>r.name),onBar.map(([,name])=>name),'the dialog\'s names are the names the toolbar buttons are read by, in the same order');
  assert.deepEqual(rows.map(r=>r.check),rows.map(r=>'Show '+r.name));
  assert.deepEqual(rows.map(r=>[r.shown,r.locked]),onBar.map(([id])=>[true,id==='Zoom']),'all shown; Zoom stays for the keyboard entry');
  // The user moves Measurements down one place, hides Capture and applies.
  button(rows[0].row,'Move Down').click();
  rows=editorRows(w);
  assert.deepEqual(rows.map(r=>r.name).slice(0,2),[NAMES.Zoom,NAMES.MeasurementTools]);
  const capture=rows.find(r=>r.name===NAMES.Capture).box;capture.checked=false;capture.onchange();
  button(w.doc.querySelector('dialog[open]'),'Apply').click();
  assert.equal(w.doc.querySelector('dialog[open]'),null,'Apply closes the dialog');
  const applied=['Zoom','MeasurementTools','Pan','TrackballRotate','WindowLevel','Layout','Crosshairs','MoreTools'];
  assert.deepEqual(viewer.sections.primary,applied,'the viewer\'s section: its own ids, in the chosen order, Capture left out');
  // The viewer renders that section; the toolbar labels name it again, and the reopened dialog reads the same names.
  bar.replaceChildren(...toolbar(w.el,viewer.sections.primary));
  await tick();
  assert.deepEqual(primaryNames(bar),applied.map(id=>[id,NAMES[id]]));
  button(host,'Edit Toolbar').click();
  rows=editorRows(w);
  assert.deepEqual(rows.filter(r=>r.shown).map(r=>r.name),primaryNames(bar).map(([,name])=>name));
  assert.deepEqual(rows.map(r=>[r.name,r.shown]),[...applied.slice(0,5),'Capture',...applied.slice(5)].map(id=>[NAMES[id],id!=='Capture']));
  w.unmount();
});

test('Edit Toolbar: a section in another order or with another tool is not the viewer\'s, and the dialog is not offered',()=>{
  for(const ids of [['Zoom','MeasurementTools',...SECTION.slice(2)],[...SECTION.slice(0,-1),'SYN-Tool'],SECTION.slice(1)]){
    const w=world();
    const viewer=viewerSection(ids),{controller,host}=preferences(w,viewer);
    assert.equal(controller,null,ids.join(','));
    assert.equal(button(host,'Edit Toolbar'),undefined);
    assert.deepEqual(viewer.sections.primary,ids,'the section is left as the viewer made it');
  }
});

test('mount: names, Korean descriptions and a pressed state for tool buttons; ids, data-cy and order untouched',()=>{
  const w=world();
  const bar=w.el('div','',...toolbar(w.el));
  const h=header(w.el,bar);
  // The native pressed state, where the viewer gives one, is kept as it is.
  const nativePressed=byCy(bar,'Pan');nativePressed.attrs.set('aria-pressed','false');
  const before=order(h);
  w.body.append(h);w.mount();
  assert.deepEqual(order(h),before,'no data-cy changed, added or moved');
  const seen=id=>{const e=byCy(h,id);return [e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('aria-pressed')];};
  assert.deepEqual(seen('WindowLevel'),['Window / Level','창/레벨 조절(드래그) · 사용 중','true'],'the active tool says so in text and state');
  assert.deepEqual(seen('Zoom'),['Zoom','확대/축소','false']);
  assert.deepEqual(seen('Pan'),['Pan','이동','false'],'native aria-pressed kept');
  assert.equal(nativePressed.hasAttribute('data-kin-pressed'),false);
  assert.deepEqual(seen('TrackballRotate'),['3D Rotate','3D 회전(볼륨에서만 동작)','false']);
  assert.deepEqual(seen('Crosshairs'),['Crosshairs','MPR 교차선(3D/MPR에서만 동작)','false']);
  assert.deepEqual(seen('Capture'),['Capture','현재 화면을 PNG로 저장(검사 저장 아님)',null],'an action has no pressed state');
  assert.deepEqual(seen('Layout'),['Layout','화면 배치',null]);
  assert.deepEqual(seen('MeasurementTools-split-button-primary'),['Measurements','측정 도구','false']);
  assert.deepEqual(seen('MeasurementTools-split-button-secondary'),['Measurements Menu','측정 도구 목록 열기',null]);
  assert.deepEqual(seen('MoreTools-split-button-primary'),['More Tools','기타 도구',null]);
  assert.deepEqual(seen('MoreTools-split-button-secondary'),['More Tools Menu','기타 도구 목록 열기',null]);
  // List items: the shown name stays the read name; an icon-only item gets the table name; every item has its description.
  assert.deepEqual(seen('Length'),['Length','길이',null]);
  assert.deepEqual(seen('ArrowAnnotate'),['Arrow Annotate','화살표 주석',null]);
  assert.deepEqual(seen('EllipticalROI'),['Ellipse','타원 ROI(HU)',null]);
  assert.deepEqual(seen('LivewireContour'),['Livewire Contour','라이브와이어 윤곽',null]);
  assert.deepEqual(seen('Reset'),['Reset View','재설정(현재 영상 칸의 화면 조작을 처음으로)',null]);
  assert.deepEqual(seen('TagBrowser'),['Tag Browser','DICOM 태그 보기',null]);
  for(const id of [...SECTION.filter(id=>!['MeasurementTools','MoreTools'].includes(id)),'Length','Reset'])
    assert.equal(byCy(h,id).getAttribute('data-kin-tool-label'),id);
  w.unmount();
});

test('mount: labelling again after a header change changes no attribute; unknown data-cy and text are left alone',async()=>{
  const w=world();
  const other=cy(w.el('button','Series'),'seriesList-btn');
  const bar=w.el('div','',...toolbar(w.el),other);
  const h=header(w.el,bar);
  w.body.append(h);w.mount();
  const elements=h.querySelectorAll('*'),texts=elements.map(e=>e.textContent);
  const attributes=recorder(w,h);
  bar.append(w.el('span',''));
  await tick();
  assert.deepEqual(attributes.seen,[],'the header change runs the labels again and no attribute is written');
  assert.deepEqual(elements.map(e=>e.textContent),texts,'no text changed');
  assert.deepEqual([...other.attrs.keys()],['data-cy']);
  attributes.stop();w.unmount();
});

// The model's observer sends only the records its options ask for, so these results depend on what the logo component observes.
test('mounted: a toolbar built again (the not-writer trim, an account toolbar) is labelled once; the active class moves the state',async()=>{
  const w=world();
  const bar=w.el('div','',...toolbar(w.el));
  const h=header(w.el,bar);
  // The same tool ids outside the logo header (a measurement panel row) are not toolbar buttons.
  const panelRow=cy(w.el('div','Length 12.3 mm'),'Length');
  w.body.append(h,w.el('aside','',panelRow));
  w.mount();
  assert.equal(byCy(h,'Capture').getAttribute('aria-label'),'Capture','labelled at mount');
  assert.deepEqual([...panelRow.attrs.keys()],['data-cy']);
  // Not a writer: the section is built again without Measurements and Capture, in the same order otherwise.
  const trimmed=SECTION.filter(id=>!['MeasurementTools','Capture'].includes(id));
  bar.replaceChildren(...toolbar(w.el,trimmed));
  await tick();
  const section=[...new Set(order(bar).map(v=>v.replace(/-split-button-(primary|secondary)$/,'')).filter(v=>SECTION.includes(v)))];
  assert.deepEqual(section,trimmed,'order is the viewer\'s');
  assert.deepEqual(primaryNames(bar),trimmed.map(id=>[id,NAMES[id]]));
  assert.equal(byCy(bar,'Capture'),undefined);
  const attributes=recorder(w,h);
  bar.append(w.el('span',''));
  await tick();
  assert.deepEqual(attributes.seen,[],'another header change writes no label again');
  // The user picks Zoom: the viewer moves its active class; the pressed state and the text follow.
  byCy(bar,'WindowLevel').setAttribute('class','');
  byCy(bar,'Zoom').setAttribute('class','bg-primary-light');
  await tick();
  assert.deepEqual(['WindowLevel','Zoom'].map(id=>[byCy(bar,id).getAttribute('aria-pressed'),byCy(bar,id).getAttribute('title')]),
    [['false','창/레벨 조절(드래그)'],['true','확대/축소 · 사용 중']]);
  attributes.stop();w.unmount();
});

// The Tech Note bridge (viewer-tech-note.js kinViewerTechNote) as the mode's onModeEnter mounts it and onModeExit stops it
// (config/ohif.js kin.viewer-tech-note), here in an embedded viewer; its keyboard entry to the viewer's Zoom button, the focus style
// and their clean-up are the same code in a viewer window (e2e/test_native_toolbar.py 03 runs that one).
const enterNote=w=>{const note=w.ctx.kinViewerTechNote({},null);assert.equal(note.mount(),true,'the bridge mounts');return note;};
function page(w){
  const h=header(w.el,w.el('div','',...toolbar(w.el))),root=w.el('div','',h);root.attrs.set('id','root');
  w.body.append(root);
  return byCy(h,'Zoom');
}
const same=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);

test('tech note: mode exit takes back its focus entry, its style and the Zoom name it gave; a second entry and exit do the same',()=>{
  const w=world();const zoom=page(w);const head=[...w.doc.head.children];
  for(const pass of ['first','again']){
    const note=enterNote(w);
    const added=w.doc.head.children.filter(e=>!head.includes(e));
    assert.ok(added.length&&added.every(e=>e.localName==='style'),pass+': the mount adds its focus style');
    const entry=w.ctx.kinViewerFocusNativeToolbar;
    assert.equal(entry(),true,pass);
    assert.equal(w.doc.activeElement,zoom,pass+': keyboard focus is on the viewer\'s own Zoom button');
    assert.equal(zoom.getAttribute('aria-label'),'Zoom',pass+': an unnamed Zoom button is named for the entry');
    w.doc.activeElement=null;
    note.stop();
    assert.equal('kinViewerFocusNativeToolbar' in w.ctx,false,pass+': the entry is gone');
    assert.equal(entry(),false,pass+': a kept reference does nothing');
    assert.equal(w.doc.activeElement,null);
    assert.ok(same(w.doc.head.children,head)&&added.every(e=>e.parentElement===null),pass+': its style is gone');
    assert.equal(zoom.hasAttribute('aria-label'),false,pass+': the name it gave is taken back');
  }
});

test('tech note: the name and description the toolbar labels gave Zoom stay through mode exit and a new entry, whichever came first',async()=>{
  for(const first of ['toolbar labels','tech note']){
    const w=world();const zoom=page(w);
    const named=()=>[zoom.getAttribute('aria-label'),zoom.getAttribute('data-kin-tool-label'),zoom.getAttribute('title')];
    let note;
    if(first==='toolbar labels'){w.mount();note=enterNote(w);}
    else{note=enterNote(w);assert.equal(w.ctx.kinViewerFocusNativeToolbar(),true);w.mount();}
    assert.deepEqual(named(),['Zoom','Zoom','확대/축소'],first);
    for(const pass of ['exit','exit after a new entry']){
      if(pass!=='exit')note=enterNote(w);
      w.doc.activeElement=null;
      assert.equal(w.ctx.kinViewerFocusNativeToolbar(),true,first+', '+pass);
      assert.equal(w.doc.activeElement,zoom,first+', '+pass+': the entry still reaches Zoom');
      note.stop();
      assert.deepEqual(named(),['Zoom','Zoom','확대/축소'],first+', '+pass+': the toolbar\'s name and description stay');
      assert.equal('kinViewerFocusNativeToolbar' in w.ctx,false);
    }
    // The toolbar labels keep working after the exit: the user picks Zoom and its state follows.
    byCy(w.body,'WindowLevel').setAttribute('class','');
    zoom.setAttribute('class','bg-primary-light');
    await tick();
    assert.deepEqual([...named(),zoom.getAttribute('aria-pressed')],['Zoom','Zoom','확대/축소 · 사용 중','true'],first);
    w.unmount();
  }
});
