'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
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
  return {scope,state,cells,viewports,displaySets,metadata,set active(value){active=value},get setActiveCalls(){return setActiveCalls}};
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
