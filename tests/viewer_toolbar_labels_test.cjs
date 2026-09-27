// S5-UI5 (VUI-04, F#4): the fixed viewer's toolbar gets English names (aria-label), Korean descriptions (title) and a pressed
// state that is not colour alone; tool IDs, data-cy, commands, order and shortcuts stay the viewer's. A document that is not
// a confirmed writer (clinician-only included) loses Capture with the authoring buttons. The branding block and the toolbar
// trim rule of config/ohif.js are sliced out and run against a small element model, with the shipped viewer-tech-note.js loaded
// beside them; the real OHIF bundle (its toolbar DOM, class names and where split-button lists render) lives only in the
// container and is not judged here.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
// A Windows checkout (core.autocrlf) has CRLF in the working tree; the anchors below are written with \n.
const read=path=>fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n');
const source=read('config/ohif.js');
const techNote=read('worklist-v0/hpacs-lite/viewer-tech-note.js');
// Values made in the vm context have that context's prototypes; compare their JSON shape.
const plain=value=>JSON.parse(JSON.stringify(value));
const start=source.indexOf('const KIN_VIEWER_DEFAULT_TITLE'),end=source.indexOf('const kinStackPrecision');
assert.ok(start>=0&&end>start,'branding block anchors');
const block=source.slice(start,end);

// The selector forms the scripts under test use: compounds of a tag (or *), #id, .class, [attr] and [attr="value"], joined by
// descendant spaces, in comma lists. Any other form throws, so a changed selector shows up here instead of matching nothing.
function compound(text){
  const parts=/^(\*|[a-z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(text);
  if(!text||!parts)throw new Error('selector outside the element model: '+text);
  const checks=[];
  if(parts[1]&&parts[1]!=='*')checks.push(e=>e.localName===parts[1]);
  for(const [,sign,name,value] of parts[2].matchAll(/([#.[])([\w-]+)(?:="([^"]*)")?\]?/g))
    checks.push(sign==='#'?e=>e.getAttribute('id')===name:sign==='.'?e=>(e.getAttribute('class')||'').split(/\s+/).includes(name)
      :value===undefined?e=>e.hasAttribute(name):e=>e.getAttribute(name)===value);
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

let writes=0;
class El{
  constructor(doc,tag,text){this.doc=doc;this.localName=tag;this.nodeType=1;this.children=[];this.parentElement=null;this.own=text||'';this.attrs=new Map();this.dataset={};
    const styles=new Map();this.style={setProperty:(k,v)=>styles.set(k,v),getPropertyValue:k=>styles.get(k)||''};}
  get childElementCount(){return this.children.length;}
  get childNodes(){return this.children.length?this.children:this.own?[{nodeType:3,data:this.own,parentElement:this}]:[];}
  get textContent(){return this.children.length?this.children.map(c=>c.textContent).join(''):this.own;}
  set textContent(v){this.children.forEach(c=>{c.parentElement=null;});this.children=[];this.own=String(v);}
  setAttribute(k,v){writes++;this.attrs.set(k,String(v));this.doc.changed(this,{type:'attributes',attributeName:k});}
  removeAttribute(k){writes++;this.attrs.delete(k);this.doc.changed(this,{type:'attributes',attributeName:k});}
  hasAttribute(k){return this.attrs.has(k);}
  getAttribute(k){return this.attrs.has(k)?this.attrs.get(k):null;}
  contains(n){for(;n;n=n.parentElement)if(n===this)return true;return false;}
  closest(sel){const match=matcher(sel);for(let n=this;n;n=n.parentElement)if(match(n))return n;return null;}
  querySelectorAll(sel){const match=matcher(sel),out=[];const walk=e=>e.children.forEach(c=>{if(match(c))out.push(c);walk(c);});walk(this);return out;}
  querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
  append(...kids){kids.forEach(k=>{k.parentElement=this;this.children.push(k);});this.doc.changed(this,{type:'childList',addedNodes:kids});return this;}
  remove(){const p=this.parentElement;if(!p)return;p.children.splice(p.children.indexOf(this),1);this.parentElement=null;this.doc.changed(p,{type:'childList'});}
  // A React re-render of the toolbar section: new button nodes in place of the old ones.
  replaceChildren(...kids){this.children.forEach(c=>{c.parentElement=null;});this.children=[];this.append(...kids);}
  // Laid out while it is in the document and not hidden; focus is the document's active element.
  getClientRects(){return this.doc.connected(this)&&!this.closest('[hidden]')?[{}]:[];}
  focus(){this.doc.activeElement=this;}
  scrollIntoView(){}
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
    createElement:tag=>new El(doc,tag),
    getElementById:id=>html.querySelectorAll('*').find(e=>e.getAttribute('id')===id)||null,
    querySelectorAll:sel=>html.querySelectorAll(sel),querySelector:sel=>html.querySelector(sel)};
  const el=(tag,text,...kids)=>{const e=new El(doc,tag,text);kids.forEach(k=>{k.parentElement=e;e.children.push(k);});return e;};
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
  const ctx={document:doc,MutationObserver,Node:{ELEMENT_NODE:1},BroadcastChannel:class{addEventListener(){}removeEventListener(){}close(){}},
    queueMicrotask,URLSearchParams,location:{search:'?StudyInstanceUIDs=1.2.840.99.1',hash:''},top:{},
    getComputedStyle:e=>({visibility:e.style.getPropertyValue('visibility')||'visible'}),addEventListener(){},removeEventListener(){}};
  ctx.window=ctx;
  vm.createContext(ctx);
  const [Brand,labels]=vm.runInContext(block+';[KinViewerBrand,kinViewerToolbarLabels]',ctx);
  vm.runInContext(techNote,ctx,{filename:'viewer-tech-note.js'});
  let cleanup=null;
  const React={useEffect:fn=>{cleanup=fn();},createElement:(...a)=>({a})};
  return {doc,body:doc.body,el,labels,ctx,mount:()=>Brand({React}),unmount:()=>cleanup&&cleanup()};
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
const SECTION=['MeasurementTools','Zoom','Pan','TrackballRotate','WindowLevel','Capture','Layout','Crosshairs','MoreTools'];
const MEASURE=[['Length','Length'],['Bidirectional','Bidirectional'],['ArrowAnnotate','Arrow Annotate'],['EllipticalROI','Ellipse'],['LivewireContour','']];
const MORE=[['Reset','Reset View'],['rotate-right','Rotate Right'],['ImageSliceSync','Image Slice Sync'],['Cine','Cine'],['TagBrowser','']];
function toolbar(el,ids=SECTION,active='WindowLevel'){
  return ids.map(id=>tool(el,id,{active:id===active,items:id==='MeasurementTools'?MEASURE:id==='MoreTools'?MORE:null}));
}
function header(el,bar){
  const brand=el('div','',el('span','KOREA IMAGING'));brand.attrs.set('id','kin-viewer-brand');
  const h=el('div','',brand,bar,el('div','',el('button','⚙')));h.attrs.set('class','bg-secondary-dark z-20 flex');
  return h;
}
const byCy=(root,v)=>root.querySelectorAll('*').find(e=>e.getAttribute('data-cy')===v);
const order=root=>root.querySelectorAll('*').map(e=>e.getAttribute('data-cy')).filter(Boolean);
const hangul=s=>/[가-힣]/.test(s);

test('source: the nine names are the toolbar editor catalog, which is unchanged; descriptions are Korean',()=>{
  const line=techNote.match(/const catalog=(\[\[.*?\]\]);/);
  assert.ok(line,'catalog line');
  assert.equal(line[0],"const catalog=[['MeasurementTools','Measurements'],['Zoom','Zoom'],['Pan','Pan'],['TrackballRotate','3D Rotate'],['WindowLevel','Window / Level'],['Capture','Capture'],['Layout','Layout'],['Crosshairs','Crosshairs'],['MoreTools','More Tools']];",'the catalog (viewer-tech-note.js) is not changed');
  const catalog=plain(vm.runInNewContext(line[1]));
  const {labels}=world();
  assert.deepEqual(Object.keys(labels.PRIMARY),catalog.map(x=>x[0]));
  assert.deepEqual(catalog.map(([id])=>labels.PRIMARY[id][0]),catalog.map(x=>x[1]),'the English names are the ones the Edit Toolbar dialog shows');
  for(const [id,[name,description]] of [...Object.entries(labels.PRIMARY),...Object.entries(labels.ITEMS)]){
    assert.ok(!hangul(name),id+' name is English');assert.ok(hangul(description),id+' description is Korean');
  }
  assert.equal(labels.PRIMARY.Capture[1],'현재 화면을 PNG로 저장(검사 저장 아님)');
  assert.equal(labels.PRIMARY.Crosshairs[1],'MPR 교차선(3D/MPR에서만 동작)');
  assert.equal(labels.PRIMARY.TrackballRotate[1],'3D 회전(볼륨에서만 동작)');
  assert.equal(labels.PRIMARY.WindowLevel[1],'창/레벨 조절(드래그)');
  assert.equal(labels.ITEMS.EllipticalROI.join('|'),'Ellipse ROI|타원 ROI(HU)');
  assert.deepEqual(plain([...labels.TOGGLES].sort()),['Crosshairs','MeasurementTools','Pan','TrackballRotate','WindowLevel','Zoom']);
});

test('apply: names, Korean descriptions and a pressed state for tool buttons; ids, data-cy and order untouched',()=>{
  const w=world();
  const bar=w.el('div','',...toolbar(w.el));
  const h=header(w.el,bar);
  // The native pressed state, where the viewer gives one, is kept as it is.
  const nativePressed=byCy(bar,'Pan');nativePressed.attrs.set('aria-pressed','false');
  const before=order(h);
  w.labels.apply(h);
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
});

test('apply: a second pass writes nothing; unknown data-cy and text are left alone',()=>{
  const w=world();
  const other=cy(w.el('button','Series'),'seriesList-btn');
  const bar=w.el('div','',...toolbar(w.el),other);
  const h=header(w.el,bar);
  w.labels.apply(h);
  const texts=h.querySelectorAll('*').map(e=>e.textContent);
  writes=0;
  w.labels.apply(h);
  assert.equal(writes,0,'idempotent: no attribute written twice');
  assert.deepEqual(h.querySelectorAll('*').map(e=>e.textContent),texts,'no text changed');
  assert.deepEqual([...other.attrs.keys()],['data-cy']);
});

// The model's observer sends only the records its options ask for, so these results depend on what the branding block observes.
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
  for(const id of trimmed.filter(id=>id!=='MoreTools'))assert.equal(byCy(bar,id).getAttribute('aria-label'),w.labels.PRIMARY[id][0],id);
  assert.equal(byCy(bar,'Capture'),undefined);
  writes=0;
  bar.append(w.el('span',''));
  await tick();
  assert.equal(writes,0,'another header change writes no label again');
  // The user picks Zoom: the viewer moves its active class; the pressed state and the text follow.
  byCy(bar,'WindowLevel').setAttribute('class','');
  byCy(bar,'Zoom').setAttribute('class','bg-primary-light');
  await tick();
  assert.deepEqual(['WindowLevel','Zoom'].map(id=>[byCy(bar,id).getAttribute('aria-pressed'),byCy(bar,id).getAttribute('title')]),
    [['false','창/레벨 조절(드래그)'],['true','확대/축소 · 사용 중']]);
  w.unmount();
});

// The trim rule itself (config/ohif.js kinCreateViewerHistory authoring), run on the pinned longitudinal buttons. Its second
// argument is the screen-export switch kinCreateViewerHistory sets from the session: on for a clinician-only document and while the
// account is unconfirmed, off for a writer (also after a writer's login ended in that mount). Capture's presence in each of those
// states is run on the real toolbar of the shipped config by clinician_viewer_dom_test.py 08/13/28.
const statementAt=(name,from=0)=>{const re=new RegExp('\\bconst\\s+'+name+'\\s*=','g');re.lastIndex=from;const m=re.exec(source);return m?m.index:-1;};
test('trim rule: Capture leaves with the authoring buttons for a document that is not a writer; viewing buttons and order stay',()=>{
  const viewAt=statementAt('VIEW_TOOLS'),from=statementAt('ACTIVATING'),to=statementAt('TOOLBAR',from);
  assert.ok(viewAt>=0&&from>0&&to>from,'trim rule anchors');
  const authoring=vm.runInNewContext(source.slice(viewAt,source.indexOf(';',viewAt)+1)+'\n'+source.slice(from,to)+';authoring');
  const command={commandName:'setToolActiveToolbar',commandOptions:{toolGroupIds:['default','mpr']}};
  const buttons={Zoom:command,WindowLevel:command,Pan:command,TrackballRotate:command,Capture:'showDownloadViewportModal',Layout:undefined,
    Crosshairs:{commandName:'setToolActiveToolbar',commandOptions:{toolGroupIds:['mpr']}}};
  // The plain buttons of the section, in its order (the split buttons are judged item by item; clinician_viewer_dom_test.py 08/28).
  const kept=exporting=>SECTION.filter(id=>id in buttons&&!authoring({id,commands:buttons[id]},exporting));
  assert.deepEqual(kept(true),['Zoom','Pan','TrackballRotate','WindowLevel','Layout','Crosshairs'],'clinician-only or unconfirmed: Capture leaves');
  assert.deepEqual(kept(false),['Zoom','Pan','TrackballRotate','WindowLevel','Capture','Layout','Crosshairs'],'a writer: Capture stays in its place');
  assert.deepEqual(SECTION.filter(id=>id in buttons&&!authoring({id,commands:buttons[id]})),kept(true),'the switch is on unless it is turned off');
  for(const exporting of [true,false]){
    assert.equal(authoring({id:'Length',commands:command},exporting),true,'an authoring tool leaves either way');
    assert.equal(authoring({id:'Reset',commands:'resetViewport'},exporting),false,'a viewing action stays either way');
  }
  // The screen export is judged by its command, in the object form too and on a button with another id.
  assert.equal(authoring({id:'Capture',commands:[{commandName:'showDownloadViewportModal'}]},true),true);
  assert.equal(authoring({id:'SYN-Download',commands:'showDownloadViewportModal'},true),true);
  assert.equal(authoring({id:'SYN-Download',commands:[{commandName:'showDownloadViewportModal'}]},false),false);
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
