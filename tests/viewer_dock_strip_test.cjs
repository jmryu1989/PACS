'use strict';
// S5-UI6 dock row: panel tabs and failures stay in the 42px row; placement, auto-hide
// and reset sit behind one Dock Settings disclosure. A minimal DOM mounts the real
// module; layout, native Enter/Space activation and pixels are the hosted e2e's job.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const hpacs=path.join(__dirname,'../worklist-v0/hpacs-lite');
const source=fs.readFileSync(path.join(hpacs,'viewer-workspace-dock.js'),'utf8');

class Node{
  constructor(doc,tag){this.ownerDocument=doc;this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.attributes=new Map();this.listeners=[];this.hidden=false;this.disabled=false;this.text='';this.style={};}
  get id(){return this.attributes.get('id')||'';}
  set id(v){this.attributes.set('id',String(v));}
  setAttribute(k,v){this.attributes.set(k,String(v));}
  getAttribute(k){return this.attributes.has(k)?this.attributes.get(k):null;}
  hasAttribute(k){return this.attributes.has(k);}
  get textContent(){return this.text+this.children.map(c=>c.textContent).join('');}
  set textContent(v){for(const c of this.children)c.parentNode=null;this.children=[];this.text=String(v);}
  get nextSibling(){const p=this.parentNode;return p?p.children[p.children.indexOf(this)+1]||null:null;}
  get isConnected(){let n=this;while(n.parentNode)n=n.parentNode;return n===this.ownerDocument.documentElement;}
  append(...nodes){for(const n of nodes)this.insertBefore(n,null);}
  insertBefore(n,ref){n.parentNode?.children.splice(n.parentNode.children.indexOf(n),1);const at=ref?this.children.indexOf(ref):this.children.length;assert.ok(at>=0,'reference must be a child');this.children.splice(at,0,n);n.parentNode=this;return n;}
  after(n){this.parentNode.insertBefore(n,this.nextSibling);}
  remove(){if(this.parentNode){this.parentNode.children.splice(this.parentNode.children.indexOf(this),1);this.parentNode=null;}}
  contains(n){for(;n;n=n.parentNode)if(n===this)return true;return false;}
  all(){return this.children.flatMap(c=>[c,...c.all()]);}
  querySelector(sel){return this.all().find(n=>matches(n,sel))||null;}
  querySelectorAll(sel){return this.all().filter(n=>matches(n,sel));}
  addEventListener(type,fn,capture=false){this.listeners.push({type,fn,capture:!!capture});}
  removeEventListener(type,fn,capture=false){this.listeners=this.listeners.filter(l=>!(l.type===type&&l.fn===fn&&l.capture===!!capture));}
  focus(){this.ownerDocument.activeElement=this;}
  click(){if(!this.disabled)this.onclick?.({target:this});}
  getBoundingClientRect(){return {width:0,height:0};}
  get classList(){const set=this._classes||(this._classes=new Set());return {add:(...c)=>c.forEach(x=>set.add(x)),remove:(...c)=>c.forEach(x=>set.delete(x)),contains:c=>set.has(c),toggle:(c,on)=>{on=on===undefined?!set.has(c):!!on;on?set.add(c):set.delete(c);return on;}};}
}
class Select extends Node{get value(){return this._value??this.children[0]?.value;}set value(v){if(this.children.some(o=>o.value===v))this._value=v;}}
// Simple selectors used below and by the module: tag, #id, [attr="v"], and "a b" descendant pairs.
function matchOne(n,sel){
  const m=sel.match(/^([a-z]*)(?:#([\w-]+))?(?:\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\])?(:not\(:disabled\))?$/);if(!m)return false;
  return (!m[1]||n.tagName===m[1].toUpperCase())&&(!m[2]||n.id===m[2])&&(!m[3]||(m[4]===undefined?n.hasAttribute(m[3]):n.getAttribute(m[3])===m[4]))&&(!m[5]||!n.disabled);
}
function matches(n,sel){
  return sel.split(',').some(one=>{const parts=one.trim().split(/\s+/);if(!matchOne(n,parts.at(-1)))return false;let p=n.parentNode;for(let i=parts.length-2;i>=0;i--){while(p&&!matchOne(p,parts[i]))p=p.parentNode;if(!p)return false;p=p.parentNode;}return true;});
}
function dispatch(target,event){
  const pathTo=[];for(let n=target;n;n=n.parentNode)pathTo.push(n);
  let stopped=false;Object.assign(event,{target,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){stopped=true;}});
  for(const n of [...pathTo].reverse().slice(0,-1))for(const l of n.listeners.filter(l=>l.type===event.type&&l.capture))l.fn(event);
  for(const n of pathTo){if(stopped)break;for(const l of n.listeners.filter(l=>l.type===event.type&&(!l.capture||n===target)))l.fn(event);}
  return event;
}

function mount({owner='["inst","sub"]',stored,getThrows=false,setThrows=false}={}){
  const doc={};const make=tag=>tag==='select'?new Select(doc,tag):new Node(doc,tag);
  const html=make('html'),head=make('head'),body=make('body');html.append(head,body);
  Object.assign(doc,{documentElement:html,head,body,activeElement:body,hidden:false,createElement:make,getElementById:id=>html.all().find(n=>n.id===id)||null,
    querySelector:sel=>html.querySelector(sel),hasFocus:()=>true,addEventListener(){},removeEventListener(){}});
  const root=make('div');root.id='root';body.append(root);
  const panelHost=make('div');body.append(panelHost);
  for(const id of ['kin-viewer-history','kin-viewer-layout']){const p=make('details');p.id=id;p.open=false;panelHost.append(p);}
  const store=new Map(),writes=[];if(stored!==undefined)store.set('kin-viewer-dock:v1:'+owner,stored);
  const localStorage={getItem(k){if(getThrows)throw Error('synthetic read denial');return store.has(k)?store.get(k):null;},setItem(k,v){if(setThrows)throw Error('synthetic write denial');writes.push([k,v]);store.set(k,v);}};
  const events=[];
  const w={document:doc,localStorage,frameElement:null,requestAnimationFrame(){},setTimeout(){return 1;},clearTimeout(){},addEventListener(){},removeEventListener(){},
    dispatchEvent:e=>events.push(e),CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail;}},Event:class{constructor(type){this.type=type;}}};
  const context={window:w};vm.createContext(context);vm.runInContext(source,context);
  const dock=w.KinViewerWorkspaceDock(w,{owner:()=>owner,allowed:()=>true});
  const $=id=>doc.getElementById(id);
  return {w,doc,dock,$,store,writes,events,nav:dock.querySelector('nav'),style:head.children.at(-1).textContent};
}

test('row keeps the two panel tabs first with unchanged ids, aria-controls and names',()=>{
  const x=mount();const tabs=x.nav.children.filter(n=>n.tagName==='BUTTON');
  assert.deepEqual(tabs.map(b=>[b.textContent,b.getAttribute('aria-controls'),b.getAttribute('aria-expanded')]),[['Measurements','kin-viewer-history','false'],['Comparison','kin-viewer-layout','false']]);
  // reading-workspace.js focuses the first enabled dock button for the Tools shortcut.
  assert.equal(x.dock.querySelector('#kin-workspace-dock nav button:not(:disabled)'),tabs[0]);
  assert.deepEqual(['kin-workspace-dock','kin-dock-placement','kin-dock-autohide','kin-dock-reset','kin-dock-preference-status'].map(id=>!!x.$(id)),[true,true,true,true,true]);
  assert.equal(x.$('kin-dock-preference-status').getAttribute('role'),'status');assert.equal(x.$('kin-dock-preference-status').parentNode,x.nav);
});

test('Dock Settings is a collapsed disclosure at the row end holding position, auto-hide, reset and the storage note',()=>{
  const x=mount(),toggle=x.$('kin-dock-settings-toggle'),group=x.$('kin-dock-settings-panel');
  assert.equal(x.nav.children.at(-1).id,'kin-dock-settings');assert.equal(toggle.tagName,'BUTTON');assert.equal(toggle.type,'button');
  assert.equal(toggle.getAttribute('aria-controls'),group.id);assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.equal(group.hidden,true);
  // Accessible name excludes the aria-hidden caret.
  assert.equal(toggle.text,'Dock Settings');assert.deepEqual(toggle.children.map(c=>c.getAttribute('aria-hidden')),['true']);
  assert.equal(group.getAttribute('role'),'group');assert.equal(group.getAttribute('aria-label'),'Dock Settings');
  for(const id of ['kin-dock-placement','kin-dock-autohide','kin-dock-reset','kin-dock-settings-note'])assert.ok(group.contains(x.$(id)),id);
  assert.equal(x.nav.children.some(n=>n.tagName==='LABEL'||n.id==='kin-dock-reset'),false);
  assert.equal(x.$('kin-dock-settings-note').textContent,'이 브라우저·이 계정에 저장됩니다.');
  assert.equal(mount({owner:null}).$('kin-dock-settings-note').textContent,'이 창에만 적용됩니다.');
  assert.match(x.$('kin-dock-autohide').parentNode.title,/패널을 접습니다/);
});

test('toggle opens and closes; Escape inside closes it, returns focus and stops the key there',()=>{
  const x=mount(),toggle=x.$('kin-dock-settings-toggle'),group=x.$('kin-dock-settings-panel');
  toggle.click();assert.equal(group.hidden,false);assert.equal(toggle.getAttribute('aria-expanded'),'true');
  toggle.click();assert.equal(group.hidden,true);assert.equal(toggle.getAttribute('aria-expanded'),'false');
  toggle.click();const select=x.$('kin-dock-placement');select.focus();let outer=0;x.doc.documentElement.addEventListener('keydown',()=>outer++);
  const esc=dispatch(select,{type:'keydown',key:'Escape'});
  assert.equal(group.hidden,true);assert.equal(x.doc.activeElement,toggle);assert.equal(esc.defaultPrevented,true);assert.equal(outer,0);
  // A closed disclosure leaves Escape alone for the viewer.
  const again=dispatch(toggle,{type:'keydown',key:'Escape'});assert.equal(again.defaultPrevented,false);assert.equal(outer,1);
  const other=dispatch(toggle,{type:'keydown',key:'Enter'});assert.equal(other.defaultPrevented,false);
});

test('closed row height and open panel height are unchanged; the disclosure is in-flow, not an overlay',()=>{
  const x=mount();
  assert.match(x.style,/body\.kin-docked \{ --kin-dock-height: 42px; \}/);assert.match(x.style,/body\.kin-docked\.kin-dock-open \{ --kin-dock-height: min\(280px, 45vh\); \}/);
  assert.match(x.style,/#kin-workspace-dock nav \{ display: flex; gap: 8px; align-items: center; height: 42px;/);
  const rules=x.style.split('\n').filter(l=>l.includes('kin-dock-settings'));assert.ok(rules.length>=4);
  for(const rule of rules)assert.doesNotMatch(rule,/position|height|z-index|transform/,rule);
  assert.match(x.style,/#kin-dock-settings-panel\[hidden\] \{ display: none; \}/);
  x.$('kin-dock-settings-toggle').click();assert.equal(x.doc.body.classList.contains('kin-dock-open'),false);
});

test('routine status is silent, the saved value and key are unchanged, and failures still show in the row',()=>{
  const x=mount(),status=x.$('kin-dock-preference-status');
  // The collapsed disclosure's note is in the DOM but hidden; only rendered row text counts.
  const shown=n=>n.hidden?'':n.text+n.children.map(shown).join('');
  assert.equal(status.textContent,'');assert.equal(shown(x.nav).includes('이 브라우저'),false);assert.equal(shown(x.nav).includes('도구 영역'),false);
  x.$('kin-dock-settings-toggle').click();assert.equal(shown(x.nav).includes('이 브라우저·이 계정에 저장됩니다.'),true);x.$('kin-dock-settings-toggle').click();
  x.$('kin-dock-placement').value='top';x.$('kin-dock-placement').onchange();
  assert.deepEqual(x.writes,[['kin-viewer-dock:v1:["inst","sub"]','{"version":2,"placement":"top","panel":-1,"autoHide":false}']]);assert.equal(status.textContent,'');
  assert.equal(x.doc.body.classList.contains('kin-dock-top'),true);
  const restored=mount({stored:'{"version":2,"placement":"top","panel":1,"autoHide":true}'});
  assert.equal(restored.$('kin-dock-preference-status').textContent,'');assert.equal(restored.$('kin-dock-autohide').checked,true);assert.equal(restored.$('kin-viewer-layout').hidden,false);
  assert.equal(mount({stored:'{bad'}).$('kin-dock-preference-status').textContent,'저장값 오류 · 기본 도구 영역');
  assert.equal(mount({stored:'{"version":1,"placement":"outside","panel":99}'}).$('kin-dock-preference-status').textContent,'저장값 오류 · 기본 도구 영역');
  assert.equal(mount({getThrows:true}).$('kin-dock-preference-status').textContent,'저장소 사용 불가 · 이 창');
  const denied=mount({setThrows:true});denied.$('kin-dock-reset').onclick();assert.equal(denied.$('kin-dock-preference-status').textContent,'저장하지 못해 이 창에만 적용합니다.');
  const unsaved=mount({owner:null});assert.equal(unsaved.$('kin-dock-preference-status').textContent,'도구 영역 · 이 창');
});

test('session end disables every row control including Dock Settings',()=>{
  const x=mount();x.dock.end();
  assert.equal(x.dock.querySelector('#kin-workspace-dock nav button:not(:disabled)'),null);
  for(const id of ['kin-dock-settings-toggle','kin-dock-placement','kin-dock-autohide','kin-dock-reset'])assert.equal(x.$(id).disabled,true,id);
});

test('viewer-tech-note puts return outcomes before Dock Settings and describes Return to Report (static)',()=>{
  const note=fs.readFileSync(path.join(hpacs,'viewer-tech-note.js'),'utf8');
  assert.match(note,/nav\.insertBefore\(returnStatus,nav\.querySelector\('#kin-dock-settings'\)\)/);
  assert.match(note,/returnButton=toolButtons\.get\('Digit4'\)[^\n]*returnButton\.setAttribute\('aria-describedby',returnHint\.id\)/);
  assert.match(note,/describeReturn=text=>\{returnHint\.textContent=text;returnButton\.title=text;\}/);
  assert.equal((note.match(/describeReturn\(/g)||[]).length,3);
});
