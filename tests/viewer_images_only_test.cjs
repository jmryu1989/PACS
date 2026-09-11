const { test } = require('node:test');
const assert = require('node:assert/strict');
const ImagesOnly = require('../worklist-v0/hpacs-lite/viewer-images-only.js');

class Element extends EventTarget {
  constructor(tag='div') { super(); this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={};this.attributes={};this.isConnected=true;this.parentNode=null;this.id=''; }
  append(child) { child.parentNode=this;child.isConnected=true;this.children.push(child); }
  remove() { this.isConnected=false;if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(x=>x!==this); }
  setAttribute(name,value) { this.attributes[name]=String(value); }
  querySelectorAll(selector) { return selector==='.kin-viewer-identity'?this.children.filter(x=>x.className==='kin-viewer-identity'):[]; }
  click() { this.dispatchEvent(new Event('click',{cancelable:true})); }
}
class Document extends EventTarget {
  constructor() { super();this.main=new Element('main');this.main.id='kin-viewer-layout';this.fullscreenElement=null;this.exits=[];this.dialog=false; }
  createElement(tag) { return new Element(tag); }
  getElementById(id) { const walk=node=>node.id===id?node:node.children.map(walk).find(Boolean);return walk(this.main)||null; }
  querySelector(selector) { return selector.includes('dialog')&&this.dialog?{}:null; }
  exitFullscreen() { this.exits.push(this.fullscreenElement);this.fullscreenElement=null;this.dispatchEvent(new Event('fullscreenchange'));return Promise.resolve(); }
}
function setup({multiframe=false}={}) {
  const doc=new Document(),win=new EventTarget();win.setInterval=setInterval;win.clearInterval=clearInterval;win.setTimeout=setTimeout;win.clearTimeout=clearTimeout;win.BroadcastChannel=class{close(){}};
  win.kinViewerWindowOwner=()=> '["hospital","reader"]';win.kinViewerHistoryWorkspaceState=()=>({busy:false,dirty:false});win.kinViewerJobWorkspaceState=()=>({busy:false,dirty:false});
  const study='1.2',series='1.3',sops=multiframe?['1.4','1.4']:['1.4','1.5'],ids=sops.map((sop,i)=>'image:'+sop+':'+i),meta=new Map(ids.map((id,i)=>[id,{StudyInstanceUID:study,SeriesInstanceUID:series,SOPInstanceUID:sops[i],PatientID:'PID'}]));
  const element=new Element(),identity=new Element();identity.className='kin-viewer-identity';identity.dataset.study=study;element.append(identity);doc.main.append(element);
  const source=[...new Set(sops)].map(SOPInstanceUID=>({StudyInstanceUID:study,SeriesInstanceUID:series,SOPInstanceUID,PatientID:'PID'}));
  const displaySet={displaySetInstanceUID:'ds',StudyInstanceUID:study,SeriesInstanceUID:series,images:source};
  const viewport={type:'stack',viewportStatus:'rendered',element,imageIds:[...ids],current:ids[0],getImageIds(){return [...this.imageIds]},getCurrentImageId(){return this.current}};
  const cell={viewportId:'vp',x:0,y:0,width:1,height:1,displaySetInstanceUIDs:['ds']},state={activeViewportId:'vp',layout:{numRows:1,numCols:1},viewports:new Map([['vp',cell]])},subs=[];
  const services={viewportGridService:{EVENTS:{GRID:'grid'},getState:()=>state,subscribe:(_,fn)=>{subs.push(fn);return{unsubscribe(){}}}},cornerstoneViewportService:{getCornerstoneViewport:()=>viewport},displaySetService:{EVENTS:{ADDED:'added'},getDisplaySetByUID:()=>displaySet,subscribe:(_,fn)=>{subs.push(fn);return{unsubscribe(){}}}}};
  const controller=ImagesOnly.create(services,{doc,root:win,metadata:id=>meta.get(id),intervalMs:0,rendered:()=> 'rendered'});controller.mount();
  const enter=doc.getElementById('kin-images-only-enter');
  return {doc,win,services,state,cell,viewport,displaySet,meta,controller,enter,emit:()=>subs.forEach(fn=>fn())};
}

test('valid stack enters synchronously and multiframe SOP identity is accepted', async()=>{
  const h=setup({multiframe:true});let inside=false;
  h.viewport.element.requestFullscreen=()=>{inside=true;h.doc.fullscreenElement=h.viewport.element;h.doc.dispatchEvent(new Event('fullscreenchange'));return Promise.resolve()};
  h.enter.click();assert.equal(inside,true);assert.equal(h.doc.fullscreenElement,h.viewport.element);
  assert.equal(h.doc.getElementById('kin-images-only-exit').parentNode,h.viewport.element);
  await Promise.resolve();h.doc.getElementById('kin-images-only-exit').click();await Promise.resolve();assert.equal(h.doc.fullscreenElement,null);h.controller.stop();
});

test('frame navigation stays live but source image or layout replacement exits only the owned target', async()=>{
  const h=setup();h.viewport.element.requestFullscreen=()=>{h.doc.fullscreenElement=h.viewport.element;h.doc.dispatchEvent(new Event('fullscreenchange'));return Promise.resolve()};
  h.enter.click();await Promise.resolve();h.viewport.current=h.viewport.imageIds[1];h.viewport.viewportStatus='loading';h.viewport.element.children[0].remove();h.emit();assert.equal(h.doc.fullscreenElement,h.viewport.element);
  h.viewport.imageIds.push('image:1.6:2');h.emit();await Promise.resolve();assert.equal(h.doc.fullscreenElement,null);assert.equal(h.doc.exits.length,1);
  h.controller.stop();
});

test('in-place patient identity mutation exits while an unrelated fullscreen blocks entry', async()=>{
  const h=setup();h.viewport.element.requestFullscreen=()=>{h.doc.fullscreenElement=h.viewport.element;h.doc.dispatchEvent(new Event('fullscreenchange'));return Promise.resolve()};
  h.enter.click();await Promise.resolve();h.meta.get(h.viewport.imageIds[1]).PatientID='OTHER';h.emit();await Promise.resolve();assert.equal(h.doc.fullscreenElement,null);
  const blocked=setup();blocked.doc.fullscreenElement=new Element();blocked.viewport.element.requestFullscreen=()=>{throw Error('must not run')};blocked.emit();assert.equal(blocked.enter.disabled,true);blocked.controller.stop();h.controller.stop();
});

test('busy, invalid identity, unsupported fullscreen and owner end fail closed', async()=>{
  const busy=setup();busy.win.kinViewerJobWorkspaceState=()=>({busy:true});busy.emit();assert.equal(busy.enter.disabled,true);busy.controller.stop();
  const wrong=setup();wrong.meta.get(wrong.viewport.imageIds[0]).PatientID='OTHER';wrong.emit();assert.equal(wrong.enter.disabled,true);wrong.controller.stop();
  const unsupported=setup();unsupported.emit();assert.equal(unsupported.enter.disabled,true);unsupported.controller.stop();
  const ended=setup();ended.viewport.element.requestFullscreen=()=>{ended.doc.fullscreenElement=ended.viewport.element;ended.doc.dispatchEvent(new Event('fullscreenchange'));return Promise.resolve()};ended.enter.click();await Promise.resolve();
  const unrelated=new Element();ended.doc.fullscreenElement=unrelated;ended.doc.dispatchEvent(new Event('fullscreenchange'));assert.equal(ended.doc.exits.length,0,'an unrelated fullscreen target is never exited');
  ended.win.dispatchEvent(Object.assign(new Event('storage'),{key:'kin-session-ended'}));assert.equal(ended.doc.getElementById('kin-images-only'),null);
});

test('rejected and late fullscreen requests remove only owned UI', async()=>{
  const rejected=setup();rejected.viewport.element.requestFullscreen=()=>Promise.reject(Error('denied'));rejected.enter.click();await Promise.resolve();await Promise.resolve();
  assert.equal(rejected.doc.getElementById('kin-images-only-exit'),null);assert.match(rejected.doc.getElementById('kin-images-only-status').textContent,/허용하지 않았습니다/);rejected.controller.stop();
  const late=setup();let resolve;late.viewport.element.requestFullscreen=()=>new Promise(done=>resolve=()=>{late.doc.fullscreenElement=late.viewport.element;done()});late.enter.click();late.controller.stop();resolve();await Promise.resolve();await Promise.resolve();assert.equal(late.doc.fullscreenElement,null);assert.equal(late.doc.exits.length,1);
});

test('rejected fullscreen exit keeps a visible owned retry until exit succeeds', async()=>{
  const h=setup();h.viewport.element.requestFullscreen=()=>{h.doc.fullscreenElement=h.viewport.element;h.doc.dispatchEvent(new Event('fullscreenchange'));return Promise.resolve()};
  h.enter.click();await Promise.resolve();h.doc.exitFullscreen=()=>Promise.reject(Error('blocked'));
  h.doc.getElementById('kin-images-only-exit').click();await Promise.resolve();await Promise.resolve();
  assert.equal(h.doc.fullscreenElement,h.viewport.element);assert.match(h.doc.getElementById('kin-images-only-exit').textContent,/Retry/);
  assert.match(h.doc.getElementById('kin-images-only-exit').textContent,/종료 요청/);
  h.doc.exitFullscreen=Document.prototype.exitFullscreen.bind(h.doc);h.doc.getElementById('kin-images-only-exit').click();await Promise.resolve();
  assert.equal(h.doc.fullscreenElement,null);assert.equal(h.doc.getElementById('kin-images-only-exit'),null);h.controller.stop();
});
