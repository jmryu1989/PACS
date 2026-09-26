'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const sourcePath=path.join(__dirname,'../worklist-v0/hpacs-lite/viewer-display-scope.js');
let source=fs.readFileSync(sourcePath,'utf8');
const mutation=process.env.KIN_DISPLAY_SCOPE_MUTATION;
if(mutation==='outside-target')source=source.replace('targets=wanted.map(id=>source(views.get(id)))','targets=[...views.keys()].map(id=>source(views.get(id)))');
if(mutation==='restore-changed-source')source=source.replace("if(!now||key(now)!==saved.source)return false;","if(!now)return false;");
if(mutation==='skip-rollback')source=source.replace('for(const [item,state] of saved.slice(0,attempted.length).reverse())','for(const [item,state] of [])');
if(mutation==='stale-toggle')source=source.replace("if(ended||expected!==baseline||signature()!==expected||expectedView&&currentView!==expectedView)","if(ended)");
const scopeModule={exports:{}};new Function('module','exports',source)(scopeModule,scopeModule.exports);const Scope=scopeModule.exports;
const CT='1.2.840.10008.5.1.4.1.1.2';

function fixture(count=3){
  let active='A',setActiveCalls=0;const metadata=new Map(),displaySets=new Map(),viewports=new Map(),cells=new Map();
  for(let index=0;index<count;index++){
    const id=String.fromCharCode(65+index),study=`1.2.${index+1}`,series=`1.3.${index+1}`,sop=`1.4.${index+1}`,imageId=`wadors:${sop}`;
    const ds={displaySetInstanceUID:`ds-${id}`,Modality:'CT',SOPClassUID:CT,StudyInstanceUID:study,SeriesInstanceUID:series};displaySets.set(ds.displaySetInstanceUID,ds);
    metadata.set(imageId,{SOPClassUID:CT,StudyInstanceUID:study,SeriesInstanceUID:series,SOPInstanceUID:sop});
    const viewport={id,type:'stack',imageIds:[imageId],current:imageId,camera:{parallelScale:10,flipHorizontal:false,flipVertical:false},properties:{colormap:{name:'HotIron'},invert:false,interpolationType:0,voiRange:{lower:0,upper:100}},voiUpdatedWithSetProperties:true,presentation:{rotation:0},renders:0,
      getImageIds(){return [...this.imageIds]},getCurrentImageId(){return this.current},getCamera(){return structuredClone(this.camera)},setCamera(value){Object.assign(this.camera,value)},getProperties(){return {...structuredClone(this.properties),isComputedVOI:!this.voiUpdatedWithSetProperties}},setProperties(value){const clean=structuredClone(value);delete clean.isComputedVOI;Object.assign(this.properties,clean);if(Object.hasOwn(clean,'voiRange'))this.voiUpdatedWithSetProperties=true},setVOI(value,options={}){this.properties.voiRange=structuredClone(value);if(options.forceRecreateLUTFunction)this.properties.colormap={name:'Grayscale'};if(!this.voiUpdatedWithSetProperties)this.voiUpdatedWithSetProperties=!!options.voiUpdatedWithSetProperties},resetProperties(){this.voiUpdatedWithSetProperties=false;this.properties={colormap:{name:'Grayscale'},invert:false,interpolationType:1,voiRange:{lower:0,upper:100}}},resetCamera(){this.camera={parallelScale:10,flipHorizontal:false,flipVertical:false}},getViewPresentation(){return structuredClone(this.presentation)},setViewPresentation(value){this.presentation=structuredClone(value)},render(){this.renders++}};
    viewports.set(id,viewport);cells.set(id,{viewportId:id,x:index,y:0,width:1/count,height:1,displaySetInstanceUIDs:[ds.displaySetInstanceUID]});
  }
  const state={layout:{layoutType:'grid',numRows:1,numCols:count},get activeViewportId(){return active},viewports:cells};
  const services={viewportGridService:{EVENTS:{ACTIVE:'active',GRID:'grid'},getState:()=>state,getActiveViewportId:()=>active,setActiveViewportId(){setActiveCalls++}},cornerstoneViewportService:{getCornerstoneViewport:id=>viewports.get(id)},displaySetService:{getDisplaySetByUID:id=>displaySets.get(id)}};
  const scope=Scope.create(services,{metadata:id=>metadata.get(id),toLowHighRange:(width,center)=>({lower:center-width/2,upper:center+width/2-1})});
  return {scope,services,state,cells,viewports,displaySets,metadata,set active(value){active=value},get setActiveCalls(){return setActiveCalls}};
}

test('Active is default and public one-shot APIs preserve frame, source and active id',()=>{
  const x=fixture(2),a=x.viewports.get('A'),b=x.viewports.get('B'),frame=a.current,images=a.getImageIds();
  assert.deepEqual(x.scope.selection(),{mode:'active',ids:['A']});assert.equal(x.scope.apply('rotate',90).ok,true);assert.equal(a.presentation.rotation,90);
  assert.equal(x.scope.apply('flipH').ok,true);assert.equal(a.camera.flipHorizontal,true);assert.equal(x.scope.apply('flipV').ok,true);assert.equal(a.camera.flipVertical,true);
  assert.equal(x.scope.apply('invert').ok,true);assert.equal(a.properties.invert,true);assert.equal(x.scope.apply('window',{width:400,center:40}).ok,true);assert.deepEqual(a.properties.voiRange,{lower:-160,upper:239});
  a.camera.parallelScale=4;assert.equal(x.scope.apply('fit').ok,true);assert.equal(a.camera.parallelScale,10);a.properties.invert=true;assert.equal(x.scope.apply('reset').ok,true);assert.equal(a.properties.invert,false);
  assert.equal(b.renders,0);assert.equal(x.setActiveCalls,0);assert.equal(a.current,frame);assert.deepEqual(a.getImageIds(),images);
});

test('Set, All and Invert Selection are distinct from image invert and reject a mixed range atomically',()=>{
  const x=fixture(3);assert.equal(x.scope.setSelection(['A','B']),true);assert.deepEqual(x.scope.invertSelection(),['C']);
  assert.equal(x.scope.apply('invert').ok,true);assert.equal(x.viewports.get('C').properties.invert,true);assert.equal(x.viewports.get('A').properties.invert,false);
  x.cells.get('C').displaySetInstanceUIDs=[];x.scope.refresh();x.scope.setMode('all');const before=[...x.viewports.values()].map(v=>v.camera.flipHorizontal);
  const rejected=x.scope.apply('flipH');assert.equal(rejected.ok,false);assert.match(rejected.message,/범위 전체/);assert.deepEqual([...x.viewports.values()].map(v=>v.camera.flipHorizontal),before);
});

test('checking a cell extends the visible Active selection and stale controls cannot alter a replacement source',()=>{
  const x=fixture(3),oldView=x.cells.get('B');assert.deepEqual(x.scope.selection(),{mode:'active',ids:['A']});const token=x.scope.sourceToken();
  assert.equal(x.scope.toggleCell('B',true,token,oldView),true);assert.deepEqual(x.scope.selection(),{mode:'set',ids:['A','B']});
  const staleToken=x.scope.sourceToken();x.displaySets.get('ds-B').StudyInstanceUID='9.8.7';
  assert.equal(x.scope.toggleCell('B',false,staleToken,oldView),false);assert.deepEqual(x.scope.selection(),{mode:'active',ids:['A']});
});

test('target exclusion, source replacement and intermediate failure cannot leak writes',()=>{
  const x=fixture(3),a=x.viewports.get('A'),b=x.viewports.get('B'),c=x.viewports.get('C');x.scope.setSelection(['A','B']);
  const native=b.setCamera;let throwOnce=true;b.setCamera=function(value){if(throwOnce){throwOnce=false;throw Error('synthetic middle failure')}return native.call(this,value)};const failed=x.scope.apply('flipH');assert.equal(failed.ok,false);assert.equal(failed.partial,false);assert.equal(a.camera.flipHorizontal,false);assert.equal(c.camera.flipHorizontal,false);
  b.setCamera=native;x.scope.setSelection(['A']);assert.equal(x.scope.apply('invert').ok,true);assert.equal(a.properties.invert,true);assert.equal(b.properties.invert,false);assert.equal(c.properties.invert,false);
  x.scope.setSelection(['A','B']);const setA=a.setCamera;a.setCamera=function(value){setA.call(this,value);x.cells.get('B').displaySetInstanceUIDs=[]};
  const changed=x.scope.apply('flipH');assert.equal(changed.ok,false);assert.equal(changed.partial,true);assert.equal(a.camera.flipHorizontal,false);assert.equal(b.camera.flipHorizontal,false);assert.deepEqual(x.scope.selection(),{mode:'active',ids:['A']});
});

test('rollback resolves the current grid source and never writes through a stale target',()=>{
  const x=fixture(2),oldA=x.viewports.get('A'),replacement=x.viewports.get('B');x.scope.setSelection(['A']);
  const native=oldA.setCamera;let oldWrites=0;oldA.setCamera=function(value){oldWrites++;native.call(this,value);x.cells.get('A').displaySetInstanceUIDs=['ds-B'];x.viewports.set('A',replacement)};
  const result=x.scope.apply('flipH');assert.equal(result.ok,false);assert.equal(result.partial,true);assert.equal(oldWrites,1);
  assert.equal(oldA.camera.flipHorizontal,true);assert.equal(replacement.camera.flipHorizontal,false);assert.equal(replacement.renders,0);assert.deepEqual(x.scope.selection(),{mode:'active',ids:['A']});
});

test('snapshot and source inspection exceptions stop before any viewport mutation',()=>{
  for(const breakBefore of [x=>x.viewports.get('A').getCamera=()=>{throw Error('camera unavailable')},x=>x.viewports.get('A').getImageIds=()=>{throw Error('source unavailable')}]){
    const x=fixture(2),a=x.viewports.get('A'),b=x.viewports.get('B');breakBefore(x);const result=x.scope.apply('flipH');assert.equal(result.ok,false);assert.match(result.message,/적용 전에 중단했습니다/);assert.equal(a.camera.flipHorizontal,false);assert.equal(b.camera.flipHorizontal,false);assert.equal(a.renders,0);assert.equal(b.renders,0);
  }
});

test('invalid W/L, unsupported sources and missing rollback APIs fail before mutation',()=>{
  for(const value of [{width:0,center:40},{width:'',center:40},{width:400,center:''},{width:400,center:NaN}]){const x=fixture(1),before=structuredClone(x.viewports.get('A').properties);assert.equal(x.scope.apply('window',value).ok,false);assert.deepEqual(x.viewports.get('A').properties,before);}
  assert.equal(fixture(1).scope.apply('rotate',45).ok,false);
  for(const breakSource of [x=>x.displaySets.get('ds-A').Modality='MR',x=>x.viewports.get('A').type='orthographic',x=>x.metadata.get('wadors:1.4.1').SeriesInstanceUID='9.9',x=>delete x.viewports.get('A').setCamera]){
    const x=fixture(1);breakSource(x);assert.equal(x.scope.apply('flipH').ok,false);assert.equal(x.viewports.get('A').camera.flipHorizontal,false);
  }
});

test('native WW boundary accepts 1 exactly and rejects fractional width without mutation',()=>{
  const exact=fixture(1),viewport=exact.viewports.get('A');assert.equal(exact.scope.apply('window',{width:1,center:40}).ok,true);assert.deepEqual(viewport.properties.voiRange,{lower:39.5,upper:39.5});
  const fractional=fixture(1),before=structuredClone(fractional.viewports.get('A').properties),rejected=fractional.scope.apply('window',{width:.5,center:40});assert.equal(rejected.ok,false);assert.match(rejected.message,/WW>=1/);assert.deepEqual(fractional.viewports.get('A').properties,before);assert.equal(fractional.viewports.get('A').renders,0);
});

test('ordinary-operation rollback preserves undefined colormap and exact public properties',()=>{
  const x=fixture(2),a=x.viewports.get('A'),b=x.viewports.get('B');delete a.properties.colormap;x.scope.setSelection(['A','B']);const before=structuredClone(a.getProperties()),native=b.setProperties;let once=true;
  b.setProperties=function(value){if(once){once=false;throw Error('synthetic property failure')}return native.call(this,value)};
  const failed=x.scope.apply('invert');assert.equal(failed.ok,false);assert.equal(failed.partial,false);assert.deepEqual(a.getProperties(),before);assert.equal(Object.hasOwn(a.getProperties(),'colormap'),false);
});

test('Reset rejects a public-property snapshot that cannot be restored exactly',()=>{
  const x=fixture(1),viewport=x.viewports.get('A');delete viewport.properties.colormap;const before=structuredClone(viewport.getProperties()),result=x.scope.apply('reset');assert.equal(result.ok,false);assert.match(result.message,/정확히 복구/);assert.deepEqual(viewport.getProperties(),before);assert.equal(viewport.renders,0);
});

test('Reset rolls back exact public camera and properties when its snapshot is restorable',()=>{
  const x=fixture(2),a=x.viewports.get('A'),b=x.viewports.get('B');a.camera.parallelScale=4;a.properties.invert=true;x.scope.setSelection(['A','B']);const before={camera:a.getCamera(),properties:a.getProperties()},native=b.resetProperties;let once=true;
  b.resetProperties=function(){if(once){once=false;throw Error('synthetic reset failure')}return native.call(this)};
  const failed=x.scope.apply('reset');assert.equal(failed.ok,false);assert.equal(failed.partial,false);assert.deepEqual(a.getCamera(),before.camera);assert.deepEqual(a.getProperties(),before.properties);
});

test('window failure restores computed VOI and custom colormap, while undefined colormap is an explicit partial recovery',()=>{
  for(const hasCustomColormap of [true,false]){
    const x=fixture(2),a=x.viewports.get('A'),b=x.viewports.get('B');a.voiUpdatedWithSetProperties=false;if(!hasCustomColormap)delete a.properties.colormap;x.scope.setSelection(['A','B']);const before=a.getProperties(),frame=a.current,images=a.getImageIds(),native=b.setProperties;let once=true;
    b.setProperties=function(value){if(once&&value.voiRange){once=false;throw Error('synthetic W/L failure')}return native.call(this,value)};
    const failed=x.scope.apply('window',{width:400,center:40});assert.equal(failed.ok,false);assert.equal(failed.partial,!hasCustomColormap);assert.deepEqual(a.properties.voiRange,before.voiRange);assert.equal(a.getProperties().isComputedVOI,true);assert.equal(a.current,frame);assert.deepEqual(a.getImageIds(),images);
    if(hasCustomColormap)assert.deepEqual(a.getProperties(),before);else {assert.deepEqual(a.properties.colormap,{name:'Grayscale'});assert.match(failed.message,/일부 표시/);}
  }
});

test('a source getter failure during failure reporting returns partial guidance instead of escaping apply',()=>{
  const x=fixture(2),b=x.viewports.get('B');x.scope.setSelection(['A','B']);const native=b.setProperties;b.setProperties=function(value){if(value.voiRange){b.getImageIds=()=>{throw Error('late source failure')};throw Error('synthetic W/L failure')}return native.call(this,value)};
  const failed=x.scope.apply('window',{width:400,center:40});assert.equal(failed.ok,false);assert.equal(failed.partial,true);assert.match(failed.message,/일부 표시/);b.setProperties=native;
});

test('transitional volume image lookup cannot escape observation and operations still fail closed',()=>{
  const x=fixture(1),viewport=x.viewports.get('A');assert.deepEqual(x.scope.selection(),{mode:'active',ids:['A']});viewport.type='orthographic';viewport.getImageIds=()=>{throw Error('volume has no stack image ids')};
  assert.doesNotThrow(()=>x.scope.refresh());const rejected=x.scope.apply('invert');assert.equal(rejected.ok,false);assert.match(rejected.message,/적용 전에 중단|일반 CT 스택/);assert.equal(viewport.properties.invert,false);assert.equal(viewport.renders,0);
});

// S5-UI7 panel markup. A minimal DOM: enough of innerHTML/querySelector/dataset for the panel, so the markup, the
// target count, the preset buttons and their click are exercised in node without a browser dependency.
class Text{constructor(data){this.data=String(data);this.parent=null}get textContent(){return this.data}}
class El{
  constructor(tag){this.tagName=tag.toUpperCase();this.attrs=new Map();this.children=[];this.parent=null;this.style={cssText:''};this.checked=false;this.value='';this.onclick=null;this.onchange=null;this.listeners={};
    this.dataset=new Proxy({},{get:(_,key)=>typeof key==='string'?this.getAttribute('data-'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())):undefined});}
  getAttribute(name){return this.attrs.has(name)?this.attrs.get(name):null}setAttribute(name,value){this.attrs.set(name,String(value))}hasAttribute(name){return this.attrs.has(name)}removeAttribute(name){this.attrs.delete(name)}
  get id(){return this.getAttribute('id')||''}set id(value){this.setAttribute('id',value)}get title(){return this.getAttribute('title')||''}set title(value){this.setAttribute('title',value)}
  get type(){return this.getAttribute('type')||''}set type(value){this.setAttribute('type',value)}get disabled(){return this.hasAttribute('disabled')}set disabled(value){value?this.setAttribute('disabled',''):this.removeAttribute('disabled')}
  get textContent(){return this.children.map(child=>child.textContent).join('')}set textContent(value){this.replaceChildren(String(value))}
  get isConnected(){let node=this;while(node.parent)node=node.parent;return node===fakeDocument.body}
  append(...nodes){for(let node of nodes){if(!(node instanceof El||node instanceof Text))node=new Text(node);node.parent?.children.splice(node.parent.children.indexOf(node),1);node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const child of this.children)child.parent=null;this.children=[];this.append(...nodes)}
  remove(){if(this.parent){this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}}
  contains(node){for(;node;node=node.parent)if(node===this)return true;return false}
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn)}dispatch(type){(this.listeners[type]||[]).forEach(fn=>fn({type,target:this}))}
  click(){if(!this.disabled&&this.onclick)this.onclick({type:'click',target:this})}
  set innerHTML(html){
    this.replaceChildren();const stack=[this];
    for(const [token,close,tag,attrs] of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>|[^<]+/g)){
      if(!tag){stack.at(-1).append(token);continue;}
      if(close){stack.pop();continue;}
      const element=new El(tag);for(const [,name,value] of attrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g))element.setAttribute(name,value??'');
      stack.at(-1).append(element);if(!['input','br'].includes(tag.toLowerCase()))stack.push(element);
    }
  }
  descendants(){const out=[];for(const child of this.children)if(child instanceof El)out.push(child,...child.descendants());return out}
  matches(selector){
    const tag=selector.match(/^[a-zA-Z]+/)?.[0];if(tag&&this.tagName!==tag.toUpperCase())return false;
    for(const [,name,value] of selector.matchAll(/\[([^\]=]+)(?:=["']?([^"'\]]*)["']?)?\]/g))if(!this.hasAttribute(name)||value!==undefined&&this.getAttribute(name)!==value)return false;
    const id=selector.match(/#([\w-]+)/)?.[1];return !id||this.id===id;
  }
  querySelectorAll(selector){
    // Descendant combinator only: '[data-scope-cells] input' is each part matched inside the previous part's matches.
    let scope=[this];for(const part of selector.trim().split(/\s+(?![^\[]*\])/))scope=[...new Set(scope.flatMap(element=>element.descendants().filter(item=>item.matches(part))))];return scope;
  }querySelector(selector){return this.querySelectorAll(selector)[0]||null}
}
const fakeDocument={createElement:tag=>new El(tag),body:new El('body')};
const ohifSource=fs.readFileSync(path.join(__dirname,'../config/ohif.js'),'utf8');

function mounted(count=3,{modality='CT',control=true}={}){
  globalThis.document=fakeDocument;const x=fixture(count),host=new El('main');fakeDocument.body.replaceChildren(host);
  const table=[{window:'400',level:'40'},{window:'1500',level:'-600'},{window:'150',level:'90'},{window:'2500',level:'480'},{window:'80',level:'40'}],called=[],notices=[];
  x.displaySets.get('ds-A').Modality=modality;
  Object.assign(x.services,{customizationService:{get:key=>key==='cornerstone.windowLevelPresets'?{presets:{CT:table}}:undefined},uiNotificationService:{show:value=>notices.push(value)}});
  // The arguments are built inside the vm realm; a JSON copy gives them this realm's prototypes for deepStrictEqual.
  const commands={runCommand:(...args)=>called.push(JSON.parse(JSON.stringify(args)))},context={window:{},document:{},localStorage:{}};vm.runInNewContext(ohifSource,context);
  const extension=context.window.config.extensions.find(item=>item.id==='kin.ct-presets');let definition={commandFn(){}};commands.getCommand=()=>definition;commands.registerCommand=(_,__,value)=>{definition=value};
  if(control)extension.onModeEnter({servicesManager:{services:x.services},commandsManager:commands});
  const scope=Scope.create(x.services,{host,metadata:id=>x.metadata.get(id),toLowHighRange:(width,center)=>({lower:center-width/2,upper:center+width/2-1}),presets:control?context.window.kinCTPresets:null});
  assert.equal(scope.mount(),true);const panel=host.querySelector('#kin-display-scope');
  // Object.assign keeps the fixture's `active` setter, which a spread would flatten into a plain value.
  return Object.assign(x,{scope,panel,table,called,notices,extension,context,commands,control:context.window.kinCTPresets,buttons:()=>panel.querySelectorAll('[data-preset-buttons] button'),count:()=>panel.querySelector('[data-scope-count]').textContent,status:()=>panel.querySelector('[role=status]').textContent});
}

test('S5-UI7 panel names the current target count and says only the display changes',t=>{
  const x=mounted(3);t.after(()=>x.scope.stop());
  assert.equal(x.count(),'대상 1개 영상');
  x.panel.querySelector('[data-scope-mode=all]').click();assert.equal(x.count(),'대상 3개 영상');
  assert.equal(x.scope.setSelection(['A','B']),true);assert.equal(x.count(),'대상 2개 영상');
  x.panel.querySelector('[data-scope-invert]').click();assert.equal(x.count(),'대상 1개 영상');assert.deepEqual(x.scope.selection().ids,['C']);
  const boxes=x.panel.querySelectorAll('[data-scope-cells] input');boxes[0].checked=true;boxes[0].onchange();assert.equal(x.count(),'대상 2개 영상');
  x.panel.querySelector('[data-scope-mode=active]').click();assert.equal(x.count(),'대상 1개 영상');
  const note=x.panel.querySelector('[data-scope-note]'),transforms=x.panel.querySelector('[data-action=rotate-left]').parent;
  assert.equal(note.textContent,'선택한 영상의 표시만 바꿉니다. 원본·표식·판독은 바뀌지 않습니다.');
  assert.ok(x.panel.children.indexOf(note)>=0&&x.panel.children.indexOf(note)<x.panel.children.indexOf(transforms),'the note sits above the transform buttons');
  const reset=x.panel.querySelector('[data-action=reset]');assert.equal(reset.textContent,'Reset Display');
  assert.equal(reset.title,'표시(밝기·회전·확대)만 원래대로 — 배치는 Layout, 도구 영역은 Dock Settings에서');
  assert.equal(x.panel.querySelectorAll('[role=status]').length,1,'one status region, as the e2e locators expect');
  for(const element of [note,x.panel.querySelector('[data-scope-count]'),...x.buttons()])assert.match(element.style.cssText||element.getAttribute('style'),/font-size:12px/);
});

test('S5-UI7 preset buttons show the table values and apply only through kinApplyCTPreset to the active CT',t=>{
  const x=mounted(3);t.after(()=>x.scope.stop());const buttons=x.buttons();
  assert.deepEqual(buttons.map(button=>button.textContent),['Soft tissue 400/40','Lung 1500/-600','Liver 150/90','Bone 2500/480','Brain 80/40']);
  buttons.forEach((button,index)=>{assert.equal(button.title,`키 ${index+1} · WW ${Number(x.table[index].window)} / WC ${Number(x.table[index].level)} (프리셋 표에서 읽음)`);assert.equal(button.disabled,false);assert.equal(button.type,'button');assert.equal(button.hasAttribute('data-action'),false);});
  assert.equal(x.panel.querySelector('[data-preset-reason]').textContent,'');
  // The value shown comes from the table at render time, not from a copy in the panel.
  x.table[1]={window:'1600',level:'-550'};x.scope.refresh();assert.equal(x.buttons()[1].textContent,'Lung 1600/-550');assert.match(x.buttons()[1].title,/WW 1600 \/ WC -550/);
  // Scope All does not widen a preset: the existing path writes the active viewport only.
  x.panel.querySelector('[data-scope-mode=all]').click();const cameras=[...x.viewports.values()].map(v=>structuredClone(v.properties));
  x.buttons()[3].click();assert.deepEqual(x.called,[['setViewportWindowLevel',{viewportId:'A',window:2500,level:480},'CORNERSTONE']]);
  assert.match(x.status(),/Bone 프리셋을 활성 CT 영상에 적용했습니다/);assert.deepEqual([...x.viewports.values()].map(v=>v.properties),cameras,'the panel itself writes no viewport');
  x.buttons()[1].click();assert.deepEqual(x.called[1],['setViewportWindowLevel',{viewportId:'A',window:1600,level:-550},'CORNERSTONE']);
  // Key 1 (the mode hotkey runs the guarded setWindowLevel with the preset name) and the Soft tissue button make the same call.
  x.called.length=0;x.buttons()[0].click();const button=[...x.called];x.called.length=0;
  x.commands.getCommand().commandFn({description:'Soft tissue'});assert.deepEqual(x.called,button);
  assert.deepEqual(button,[['setViewportWindowLevel',{viewportId:'A',window:400,level:40},'CORNERSTONE']]);
});

test('S5-UI7 non-CT, specialized and unreadable presets disable the buttons with a reason and never write',t=>{
  for(const [label,change] of [['MR',x=>x.displaySets.get('ds-A').Modality='MR'],['US',x=>x.displaySets.get('ds-A').Modality='US'],['volume',x=>x.viewports.get('A').type='orthographic'],['mixed',x=>x.cells.get('A').displaySetInstanceUIDs=['ds-A','ds-B']],['empty',x=>x.cells.get('A').displaySetInstanceUIDs=[]],['enhanced CT',x=>x.displaySets.get('ds-A').SOPClassUID='1.2.840.10008.5.1.4.1.1.2.1']]){
    const x=mounted(2);try{
      change(x);x.scope.refresh();
      assert.ok(x.buttons().length===5&&x.buttons().every(button=>button.disabled),label);assert.match(x.panel.querySelector('[data-preset-reason]').textContent,/CT 원본 프레임에서만/,label);
      x.buttons()[0].click();assert.equal(x.called.length,0,label);
      const direct=x.scope.applyPreset(0);assert.equal(direct.ok,false,label);assert.equal(x.called.length,0,label);assert.equal(x.notices.length,1,label);assert.match(direct.message,/CT 원본 프레임에서만/,label);
    }finally{x.scope.stop();}
  }
  // Selecting a CT cell re-enables them on the next grid refresh.
  const y=mounted(2,{modality:'MR'});t.after(()=>y.scope.stop());assert.ok(y.buttons().every(button=>button.disabled));y.active='B';y.scope.refresh();assert.ok(y.buttons().every(button=>!button.disabled));
  y.buttons()[4].click();assert.deepEqual(y.called,[['setViewportWindowLevel',{viewportId:'B',window:80,level:40},'CORNERSTONE']]);
  // An unreadable table entry disables only that button and says so.
  y.table[2]={window:'0',level:'90'};y.scope.refresh();assert.equal(y.buttons()[2].disabled,true);assert.equal(y.buttons()[2].textContent,'Liver');assert.match(y.buttons()[2].title,/키 3 · 프리셋 값을 확인할 수 없습니다/);assert.equal(y.buttons()[3].disabled,false);
});

test('S5-UI7 without the preset extension the panel shows no preset buttons, and mode exit withdraws them',t=>{
  const x=mounted(1,{control:false});t.after(()=>x.scope.stop());assert.equal(x.buttons().length,0);assert.match(x.panel.querySelector('[data-preset-reason]').textContent,/확인할 수 없습니다/);assert.equal(x.scope.applyPreset(0).ok,false);
  const y=mounted(1);assert.ok(y.context.window.kinCTPresets);y.extension.onModeExit();assert.equal(y.context.window.kinCTPresets,undefined);
  y.scope.stop();
  // Without options.presets the panel reads the page global at render time: present -> five buttons, withdrawn -> none.
  const host=new El('main');fakeDocument.body.replaceChildren(host);const w=Scope.create(y.services,{host,metadata:id=>y.metadata.get(id)});t.after(()=>{w.stop();delete globalThis.kinCTPresets;});
  globalThis.kinCTPresets=y.control;assert.equal(w.mount(),true);assert.equal(host.querySelectorAll('[data-preset-buttons] button').length,5);
  delete globalThis.kinCTPresets;w.refresh();assert.equal(host.querySelectorAll('[data-preset-buttons] button').length,0);assert.equal(w.applyPreset(0).ok,false);
});