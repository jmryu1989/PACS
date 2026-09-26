// S5-UI4: the viewer settings menu loses OHIF's About entry (its upstream version/link window) and the open-source
// notice moves to one line at the bottom of the login page. The branding block of config/ohif.js is sliced out and run
// against a small element model; the real OHIF bundle lives only in the container, so its DOM is not judged here.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('config/ohif.js','utf8');
const start=source.indexOf('const KIN_VIEWER_DEFAULT_TITLE'),end=source.indexOf('const kinStackPrecision');
assert.ok(start>=0&&end>start,'branding block anchors');
const block=source.slice(start,end);
const login=fs.readFileSync('worklist-v0/hpacs-lite/index.html','utf8');

// Elements with text are leaves holding one text node, so childNodes and a characterData record can be modelled.
class El{
  constructor(doc,tag,text){this.doc=doc;this.localName=tag;this.nodeType=1;this.children=[];this.parentElement=null;this.own=text||'';
    this.attrs=new Map();this.dataset={};const styles=new Map();this.styles=styles;
    this.style={setProperty:(k,v,p)=>styles.set(k,v+(p?' !'+p:'')),getPropertyValue:k=>styles.get(k)||''};}
  get childElementCount(){return this.children.length;}
  get childNodes(){return this.children.length?this.children:this.own?[{nodeType:3,data:this.own,parentElement:this}]:[];}
  get textContent(){return this.children.length?this.children.map(c=>c.textContent).join(''):this.own;}
  set textContent(v){this.children.forEach(c=>{c.parentElement=null;});this.children=[];this.own=String(v);}
  setAttribute(k,v){this.attrs.set(k,String(v));}
  hasAttribute(k){return this.attrs.has(k);}
  getAttribute(k){return this.attrs.has(k)?this.attrs.get(k):null;}
  contains(n){for(;n;n=n.parentElement)if(n===this)return true;return false;}
  // Only the class-list selector the branding block uses for its menu boundary.
  closest(sel){assert.match(sel,/^(\.[\w-]+)+$/);const want=sel.slice(1).split('.');
    for(let n=this;n;n=n.parentElement){const has=(n.getAttribute('class')||'').split(/\s+/);if(want.every(c=>has.includes(c)))return n;}return null;}
  querySelectorAll(sel){assert.equal(sel,'*');const out=[];const walk=e=>e.children.forEach(c=>{out.push(c);walk(c);});walk(this);return out;}
  append(...kids){kids.forEach(k=>{k.parentElement=this;this.children.push(k);});if(this.doc.connected(this))this.doc.notify({target:this,addedNodes:kids});return this;}
  // A text node's data changes in place: a characterData record whose target is the text node, nothing added.
  setText(v){this.own=String(v);if(this.doc.connected(this))this.doc.notify({target:this.childNodes[0],addedNodes:[]});}
}
function world(){
  const observers=new Set(),pending=[];let body;
  const doc={title:'',connected:e=>{for(let n=e;n;n=n.parentElement)if(n===body)return true;return false;},
    getElementById:id=>body.querySelectorAll('*').find(e=>e.getAttribute('id')===id)||null,
    notify(record){observers.forEach(o=>{if(o.on){pending.push([o,record]);queueMicrotask(()=>{const job=pending.shift();if(job&&job[0].on)job[0].cb([job[1]]);});}});}};
  body=new El(doc,'body');doc.body=body;
  class MutationObserver{constructor(cb){this.cb=cb;this.on=false;}observe(target,opts){assert.equal(target,body);assert.equal(JSON.stringify(opts),'{"childList":true,"subtree":true,"characterData":true}');this.on=true;observers.add(this);}disconnect(){this.on=false;observers.delete(this);}}
  const el=(tag,text,...kids)=>{const e=new El(doc,tag,text);kids.forEach(k=>{k.parentElement=e;e.children.push(k);});return e;};
  const ctx={document:doc,MutationObserver,Node:{ELEMENT_NODE:1},BroadcastChannel:class{addEventListener(){}removeEventListener(){}close(){}},
    window:{addEventListener(){},removeEventListener(){}},queueMicrotask};
  vm.createContext(ctx);
  const Brand=vm.runInContext(block+';KinViewerBrand',ctx);
  let cleanup=null;
  const React={useEffect:fn=>{cleanup=fn();},createElement:(...a)=>({a})};
  return {doc,body,el,observers,mount:()=>Brand({React}),unmount:()=>cleanup&&cleanup()};
}
// OHIF 3.9 header dropdown shape (from memory of @ohif/ui Dropdown, unverified here): a list of rows, each an icon svg
// (whose <title> carries text) and a title element. The svg titles make row text differ from the title text.
function menu(el,...titles){
  return el('div','',...titles.map(t=>el('div','',el('svg','',el('title',t==='About'?'info':'settings')),el('span',t))));
}
// The menu boundary: the header that holds this repository's own logo (#kin-viewer-brand), matched by the same class
// list the branding CSS has styled since 865f064. The gear and its dropdown sit inside it in this model.
function header(el,...kids){
  const brand=el('div','',el('span','KOREA IMAGING'));brand.setAttribute('id','kin-viewer-brand');
  const h=el('div','',brand,el('div','',el('button','⚙'),...kids));h.setAttribute('class','bg-secondary-dark z-20 flex');
  return h;
}
const hidden=row=>row.getAttribute('inert')===''&&row.getAttribute('aria-hidden')==='true'&&row.style.getPropertyValue('display')==='none !important'&&row.dataset.kinRemoved==='about';
const untouched=row=>!row.hasAttribute('inert')&&!row.hasAttribute('aria-hidden')&&row.style.getPropertyValue('display')===''&&!('kinRemoved' in row.dataset);
const allUntouched=root=>[root,...root.querySelectorAll('*')].every(untouched);
const tick=()=>new Promise(r=>setImmediate(r));

test('source: the About rename rows and About-window link rows are gone and the menu removal is in the branding block',()=>{
  assert.doesNotMatch(block,/new Map\(/,'the rename table is gone');
  assert.doesNotMatch(block,/\['About', '[^']*'\],/);
  assert.doesNotMatch(block,/\['About OHIF Viewer', '[^']*'\],/);
  assert.doesNotMatch(block,/오픈소스 정보/);
  assert.doesNotMatch(block,/\['OHIF Viewer', 'KIN 판독 뷰어'\]/);
  assert.doesNotMatch(block,/github\.com\/OHIF/);
  assert.match(block,/const ABOUT_TITLES = new Set\(\['About', 'About OHIF Viewer'\]\);/);
  assert.match(block,/document\.getElementById\('kin-viewer-brand'\)\?\.closest\('\.bg-secondary-dark\.z-20'\)/,'the menu boundary is the logo header');
  assert.match(block,/if \(ABOUT_TITLES\.has\(text\) && scope\?\.contains\(element\)\) return;/);
  assert.match(block,/row\.setAttribute\('inert', ''\);/);
  assert.doesNotMatch(block,/hideAboutRows\(document\.body\)/,'the About rule never scans the whole page');
  assert.equal((source.match(/ABOUT_TITLES/g)||[]).length,3,'the About titles are used only by the branding block');
});

test('mount: About leaves the settings menu, Preferences stays, and a late menu loses About too',async()=>{
  const w=world();
  const list=menu(w.el,'About','Preferences');
  const h=header(w.el,list);
  w.body.append(h);
  w.mount();
  const [about,prefs]=list.children;
  assert.ok(hidden(about),'mounted About row hidden, inert and out of the accessibility tree');
  assert.ok(untouched(prefs),'Preferences row untouched');
  assert.equal(prefs.textContent,'settingsPreferences');
  assert.equal(about.parentElement,list,'the React-owned row stays in place so later reconciliation cannot throw');
  assert.equal(w.observers.size,1);

  const late=menu(w.el,'About OHIF Viewer','Preferences');
  const portal=w.el('div','',late);
  h.append(portal);
  assert.ok(untouched(late.children[0]),'nothing happens before the observer runs');
  await tick();
  assert.ok(hidden(late.children[0]),'late About OHIF Viewer row hidden by the observer');
  assert.ok(untouched(late.children[1]));
  assert.equal(late.children[0].textContent,'settingsAbout OHIF Viewer','the menu title is judged, not renamed');

  const outside=menu(w.el,'About','Preferences');
  w.body.append(w.el('div','',outside));
  await tick();
  assert.ok(allUntouched(outside),'the same rows outside the logo header are not the settings menu (fail open)');

  const prefsOnly=menu(w.el,'Preferences');
  h.append(prefsOnly);
  await tick();
  assert.ok(untouched(prefsOnly.children[0]));
  const lateRow=menu(w.el,'About').children[0];
  prefsOnly.append(lateRow);
  await tick();
  assert.ok(hidden(lateRow),'a single About row added next to an existing Preferences row is hidden');

  w.unmount();
  assert.equal(w.observers.size,0,'unmount disconnects the observer');
  assert.equal(w.doc.title,'판독 뷰어 — KOREA IMAGING NETWORK');
});

test('About text outside the settings menu is not hidden',async()=>{
  const w=world();
  const overlay=w.el('div','',w.el('span','About'),w.el('span','Series 3'));
  const lone=w.el('div','',w.el('div','',w.el('span','About')));
  w.body.append(overlay,lone);
  w.mount();
  assert.ok(untouched(overlay.children[0]),'About beside other text is not a menu row');
  assert.ok(overlay.children.every(untouched));
  const walk=e=>[e,...e.querySelectorAll('*')];
  assert.ok(walk(lone).every(untouched),'About with no Preferences sibling is left visible (fail open, not guessed)');
  assert.equal(overlay.children[0].textContent,'About','no rename either');
  w.unmount();
});

// S5-UI4-R-001 F01: a Preferences control near content that reads About made the old rule hide the content region.
test('F01: About content next to a Preferences control outside the menu is left as it is',async()=>{
  const w=world();
  const section=w.el('section','',w.el('div','',w.el('span','About')));
  const aside=w.el('aside','',w.el('button','Preferences'));
  const main=w.el('main','',section,aside);
  w.body.append(header(w.el),main);
  w.mount();
  assert.ok(allUntouched(main),'section and every descendant keep display, inert and aria-hidden');
  assert.equal(section.textContent,'About');
  assert.equal(aside.textContent,'Preferences');
  const late=w.el('main','',w.el('section','',w.el('div','',w.el('span','About'))),w.el('aside','',w.el('button','Preferences')));
  w.body.append(late);
  await tick();
  assert.ok(allUntouched(late),'the same content added later is left alone too');
  w.unmount();
});

test('F01: with report and study text on the page, only the settings menu About row is hidden',async()=>{
  const w=world();
  const list=menu(w.el,'About','Preferences');
  const study=w.el('div','',w.el('span','About'),w.el('span','Preferences'));
  const report=w.el('div','',w.el('div','',w.el('p','About')),w.el('div','',w.el('p','Preferences')));
  const note=w.el('div','',w.el('div','',w.el('svg','',w.el('title','info')),w.el('span','About')),w.el('div','',w.el('span','Preferences')));
  w.body.append(header(w.el,list),w.el('div','',study,report,note));
  w.mount();
  assert.ok(hidden(list.children[0]),'the menu About row is hidden');
  assert.ok(untouched(list.children[1]),'Preferences stays');
  for(const region of [study,report,note])assert.ok(allUntouched(region),'clinical text keeps its layout and accessibility');
  assert.deepEqual([study,report,note].map(r=>r.textContent),['AboutPreferences','AboutPreferences','infoAboutPreferences']);
  w.unmount();
});

// S5-UI4-R-001 F02: the observer judged only added subtrees, so a row completed after its neighbours stayed visible.
test('F02: an About label added to an existing icon-only row is hidden',async()=>{
  const w=world();
  const aboutRow=w.el('div','',w.el('svg','',w.el('title','info')));
  const prefsRow=w.el('div','',w.el('svg','',w.el('title','settings')),w.el('span','Preferences'));
  const list=w.el('div','',aboutRow,prefsRow);
  w.body.append(header(w.el,list));
  w.mount();
  assert.ok(untouched(aboutRow),'an icon-only row is not About yet');
  aboutRow.append(w.el('span','About'));
  await tick();
  assert.ok(hidden(aboutRow),'the row is judged again once its label arrives');
  assert.ok(untouched(prefsRow)&&allUntouched(prefsRow));

  const textRow=w.el('div','',w.el('svg','',w.el('title','info')),w.el('span','Help'));
  list.append(textRow);
  await tick();
  assert.ok(untouched(textRow));
  textRow.children[1].setText('About');
  await tick();
  assert.ok(hidden(textRow),'a label whose text changes in place to About is hidden (characterData)');
  w.unmount();
});

test('F02: an About row mounted before its Preferences row is hidden when Preferences arrives',async()=>{
  const w=world();
  const list=menu(w.el,'About');
  const aboutRow=list.children[0];
  w.body.append(header(w.el,list));
  w.mount();
  assert.ok(untouched(aboutRow),'no Preferences row yet, so not judged a settings menu');
  const prefsRow=menu(w.el,'Preferences').children[0];
  list.append(prefsRow);
  await tick();
  assert.ok(hidden(aboutRow),'the existing About row is hidden once Preferences joins the list');
  assert.ok(untouched(prefsRow));
  w.unmount();
});

test('other upstream wording is still neutralized',async()=>{
  const w=world();
  const a=w.el('span','Powered by OHIF'),b=w.el('span','Open Health Imaging Foundation'),c=w.el('span','OHIF Viewer'),d=w.el('span','Series 3');
  const lateOhif=w.el('p','ohif tools');
  w.body.append(w.el('div','',a,b,c,d));
  w.mount();
  assert.equal(a.textContent,'Powered by 업스트림');
  assert.equal(b.textContent,'업스트림 오픈소스 프로젝트');
  assert.equal(c.textContent,'업스트림 Viewer','OHIF Viewer now falls to the general rule');
  assert.equal(d.textContent,'Series 3');
  w.body.append(w.el('div','',lateOhif));
  await tick();
  assert.equal(lateOhif.textContent,'업스트림 tools');
  const aboutModalTitle=w.el('h2','About OHIF Viewer');
  w.body.append(w.el('div','',aboutModalTitle,w.el('p','Version 3.9.1')));
  await tick();
  assert.equal(aboutModalTitle.textContent,'About 업스트림 Viewer','outside the menu the About title is only neutralized');
  w.unmount();
});

test('login page: one open-source notice line below the card; the form is unchanged',()=>{
  const footers=login.match(/<footer class="oss-notice" id="oss-notice">([^<]*)<\/footer>/g)||[];
  assert.equal(footers.length,1);
  const text=footers[0].replace(/<[^>]+>/g,'');
  assert.equal(text,'이 뷰어는 오픈소스 OHIF Viewer(MIT 라이선스)를 기반으로 합니다.');
  assert.match(text,/MIT/);assert.match(text,/OHIF/);
  const box=login.indexOf('<div class="box">'),stat=login.indexOf('<div class="stat" id="stat"></div>'),foot=login.indexOf('<footer class="oss-notice"'),script=login.indexOf('<script src="auth.js"></script>');
  assert.ok(box<stat&&stat<foot&&foot<script,'footer sits after the login card and before the scripts');
  assert.match(login.slice(stat,foot),/^<div class="stat" id="stat"><\/div>\s*<\/div>\s*$/,'footer is outside the card');
  const rule=login.match(/\.oss-notice \{([^}]*)\}/);
  assert.ok(rule,'footer rule');
  assert.match(rule[1],/font-size: 12px;/);
  assert.match(rule[1],/position: absolute;/);
  for(const id of ['signin','register','switch','demo','msg','hint','stat'])assert.equal((login.match(new RegExp(`id="${id}"`,'g'))||[]).length,1,id);
  assert.doesNotMatch(footers[0],/<a\b|<script|onclick/i,'static text, no link or handler');
});
