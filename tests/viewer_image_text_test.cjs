const { test } = require('node:test');
const assert = require('node:assert/strict');
const ImageText = require('../worklist-v0/hpacs-lite/viewer-image-text.js');

class Style {
  constructor(){this.values=new Map()}
  getPropertyValue(name){return this.values.get(name)?.value||''}
  getPropertyPriority(name){return this.values.get(name)?.priority||''}
  setProperty(name,value,priority=''){this.values.set(name,{value,priority})}
  removeProperty(name){this.values.delete(name)}
}
class Element extends EventTarget {
  constructor(tag='div'){super();this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.isConnected=true;this.id='';this.className='';this.dataset={};this.attrs=new Map();this.style=new Style();this.hidden=false}
  append(child){child.parentNode=this;child.isConnected=true;this.children.push(child)}
  get parentElement(){return this.parentNode}
  contains(node){return node===this||this.children.some(child=>child.contains(node))}
  closest(selector){let node=this;while(node){if(selector==='[data-cy="viewport-pane"]'&&node.dataset.cy==='viewport-pane')return node;node=node.parentNode}return null}
  remove(){this.isConnected=false;if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(x=>x!==this)}
  setAttribute(name,value){this.attrs.set(name,String(value));if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=String(value)}
  getAttribute(name){return this.attrs.has(name)?this.attrs.get(name):null}
  hasAttribute(name){return this.attrs.has(name)}
  removeAttribute(name){this.attrs.delete(name);if(name.startsWith('data-'))delete this.dataset[name.slice(5).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]}
  click(){this.dispatchEvent(new Event('click',{cancelable:true}))}
  all(){return this.children.flatMap(child=>[child,...child.all()])}
  querySelectorAll(selector){return this.all().filter(node=>selector.includes('.viewport-overlay')&&node.className==='viewport-overlay'||selector.includes('[data-cy^="viewport-overlay-"]')&&String(node.dataset.cy||'').startsWith('viewport-overlay-')||selector.includes('.kin-viewer-identity')&&node.className==='kin-viewer-identity')}
  querySelector(selector){const study=/data-study="([^"]+)"/.exec(selector)?.[1];return this.all().find(node=>node.className==='kin-viewer-identity'&&(!study||node.dataset.study===study))||null}
}
class Document extends EventTarget {
  constructor(){super();this.defaultView={};this.head=new Element('head');this.main=new Element('main');this.main.id='kin-viewer-layout';this.fullscreenElement=null;this.dialog=false}
  createElement(tag){return new Element(tag)}
  getElementById(id){const walk=node=>node.id===id?node:node.children.map(walk).find(Boolean);return walk(this.main)||null}
  querySelector(selector){return selector.includes('dialog')&&this.dialog?{}:null}
}
function setup({two=false}={}) {
  const doc=new Document(),win=new EventTarget();doc.defaultView=win;win.setInterval=setInterval;win.clearInterval=clearInterval;win.BroadcastChannel=class{close(){}};
  let owner='owner-1',busy=false;win.kinViewerWindowOwner=()=>owner;win.kinViewerHistoryWorkspaceState=()=>({busy});win.kinViewerJobWorkspaceState=()=>({busy:false});
  const state={layout:{numRows:1,numCols:two?2:1},activeViewportId:'vp0',viewports:new Map()},viewports=new Map(),sets=new Map(),meta=new Map(),subs=[];
  for(let index=0;index<(two?2:1);index++){
    const study=`1.2.${index+1}`,series=`1.3.${index+1}`,sop=`1.4.${index+1}`,image=`image:${sop}`,pane=new Element(),element=new Element(),overlay=new Element(),orientation=new Element(),identity=new Element();
    pane.setAttribute('data-cy','viewport-pane');overlay.className='viewport-overlay';orientation.className='orientation-marker';orientation.style.setProperty('color','red');identity.className='kin-viewer-identity';identity.dataset.study=study;pane.append(overlay);pane.append(orientation);pane.append(element);element.append(identity);doc.main.append(pane);
    const value={StudyInstanceUID:study,SeriesInstanceUID:series,SOPInstanceUID:sop,PatientID:`PID-${index+1}`};meta.set(image,value);
    const displaySet={displaySetInstanceUID:`ds${index}`,StudyInstanceUID:study,SeriesInstanceUID:series,images:[value]};sets.set(displaySet.displaySetInstanceUID,displaySet);
    const viewport={type:'stack',viewportStatus:'rendered',element,camera:{scale:index+1},imageIds:[image],current:image,getImageIds(){return [...this.imageIds]},getCurrentImageId(){return this.current}};viewports.set(`vp${index}`,viewport);
    state.viewports.set(`vp${index}`,{viewportId:`vp${index}`,x:index,y:0,width:1,height:1,displaySetInstanceUIDs:[`ds${index}`]});
  }
  const services={viewportGridService:{EVENTS:{GRID:'grid'},getState:()=>state,subscribe:(_,fn)=>{subs.push(fn);return{unsubscribe(){}}}},cornerstoneViewportService:{getCornerstoneViewport:id=>viewports.get(id)},displaySetService:{EVENTS:{ADDED:'added'},getDisplaySetByUID:id=>sets.get(id),subscribe:(_,fn)=>{subs.push(fn);return{unsubscribe(){}}}}};
  const api=ImageText.create(services,{doc,root:win,metadata:id=>meta.get(id),rendered:()=> 'rendered',intervalMs:0});assert.equal(api.mount(),true);
  return {doc,win,state,viewports,sets,meta,api,toggle:doc.getElementById('kin-image-text-toggle'),emit:()=>subs.forEach(fn=>fn()),setOwner:value=>owner=value,setBusy:value=>busy=value};
}

test('hide and show affect verified grid text only and restore exact prior styles',()=>{
  const h=setup({two:true}),first=h.viewports.get('vp0'),second=h.viewports.get('vp1'),canvas=new Element('canvas');first.element.append(canvas);
  const panes=[first,second].map(v=>v.element.parentElement),overlays=panes.map(p=>p.querySelectorAll('.viewport-overlay')[0]);overlays[1].style.setProperty('visibility','hidden','important');const camera=first.camera;
  h.toggle.click();assert.equal(globalThis.kinViewerImageTextHidden(),true);assert.equal(h.toggle.textContent,'Show Image Text');
  assert.match(h.doc.head.children[0].textContent,/\.orientation-marker/);assert.equal(panes[0].children.find(item=>item.className==='orientation-marker').style.getPropertyValue('color'),'red');
  assert.match(panes[0].getAttribute('data-kin-image-text-hidden'),/^kit-/);assert.equal(overlays[0].style.getPropertyValue('visibility'),'');assert.equal(canvas.hasAttribute('data-kin-image-text-hidden'),false);assert.equal(first.camera,camera);
  h.toggle.click();assert.equal(globalThis.kinViewerImageTextHidden(),false);assert.equal(overlays[0].style.getPropertyValue('visibility'),'');assert.equal(overlays[1].style.getPropertyValue('visibility'),'hidden');assert.equal(overlays[1].style.getPropertyPriority('visibility'),'important');h.api.stop();
});

test('same-stack frame remains hidden, new overlay is adopted, and source mutation restores all',()=>{
  const h=setup(),v=h.viewports.get('vp0');h.toggle.click();v.current=v.imageIds[0];h.emit();assert.equal(globalThis.kinViewerImageTextHidden(),true);
  const late=new Element();late.className='viewport-overlay';v.element.parentElement.append(late);h.emit();assert.match(v.element.parentElement.getAttribute('data-kin-image-text-hidden'),/^kit-/);
  h.meta.get(v.imageIds[0]).PatientID='OTHER';h.emit();assert.equal(globalThis.kinViewerImageTextHidden(),false);assert.equal(late.style.getPropertyValue('visibility'),'');assert.match(h.doc.getElementById('kin-image-text-status').textContent,/구성이 바뀌어/);h.api.stop();
});

test('owner, fullscreen, busy, mixed viewport and session changes fail closed',()=>{
  const h=setup();h.setBusy(true);h.emit();assert.equal(h.toggle.disabled,true);h.setBusy(false);h.emit();assert.equal(h.toggle.disabled,false);
  h.doc.fullscreenElement=h.viewports.get('vp0').element;h.emit();assert.equal(h.toggle.disabled,true);h.doc.fullscreenElement=null;h.emit();h.toggle.click();h.doc.fullscreenElement=h.viewports.get('vp0').element;h.doc.dispatchEvent(new Event('fullscreenchange'));assert.equal(globalThis.kinViewerImageTextHidden(),false);
  h.doc.fullscreenElement=null;h.emit();h.toggle.click();h.setOwner('owner-2');assert.equal(globalThis.kinViewerImageTextHidden(),true);h.emit();assert.equal(globalThis.kinViewerImageTextHidden(),false);
  h.setOwner('owner-1');h.emit();h.viewports.get('vp0').type='orthographic';h.emit();assert.equal(h.toggle.disabled,true);h.win.dispatchEvent(Object.assign(new Event('storage'),{key:'kin-session-ended'}));assert.equal(h.doc.getElementById('kin-image-text'),null);
});

test('stale detached controls and attribute ownership collisions do not mutate another view',()=>{
  const first=setup(),old=first.toggle;first.api.stop();old.click();assert.equal(globalThis.kinViewerImageTextHidden(),false);
  const second=setup(),pane=second.viewports.get('vp0').element.parentElement;pane.setAttribute('data-kin-image-text-hidden','other');second.toggle.click();assert.equal(globalThis.kinViewerImageTextHidden(),false);assert.equal(pane.getAttribute('data-kin-image-text-hidden'),'other');second.api.stop();
  const duplicate=setup(),set=duplicate.sets.get('ds0');set.images.push(set.images[0]);duplicate.emit();assert.equal(duplicate.toggle.disabled,true);duplicate.api.stop();
});
