const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const nativeStack=require('./fixtures/viewer-stack-loading-source.cjs');
const source=fs.readFileSync('config/ohif.js','utf8');
const implementation=source.slice(source.indexOf('function kinCineWithinBudget('),source.indexOf('function kinApplyCTPreset('));

// Execute the complete extension with a deterministic service/event scheduler.
// Native renderer and React remount behavior remain covered by live suites;
// this isolates ownership of overlapping permission promises and cine timers.
class Element {
 constructor(){this.listeners=new Map();this.style={};this.children=[];this.attributes={};this.hidden=false;this.offsetHeight=0;}
 addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
 removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
 emit(name,event={}){for(const fn of this.listeners.get(name)||[])fn(event);}
 setAttribute(name,value){this.attributes[name]=value;}
 append(...items){this.children.push(...items);}
 remove(){}
 querySelectorAll(){return [];}
}
function fixture(kind='orthographic',stackFrames=7,cachedInstances=[],stackHandler=true){
 const document=new Element(),window=new Element(),timers=new Map();let nextTimer=0,current,allowed=true,resolveOld,rejectOld,requests=0,nativePlays=0,lastPlaybackRate;
 const frameCache=new Set(),deferred=new Map();
 const defer=(fn,ms)=>{const id=++nextTimer;deferred.set(id,{fn,ms});return id;},cancel=id=>deferred.delete(id);
 document.body=new Element();document.createElement=()=>new Element();document.hidden=false;
 const events={VIEWPORT_NEW_IMAGE_SET:'images',VOLUME_VIEWPORT_NEW_VOLUME:'volume',CAMERA_MODIFIED:'camera',STACK_VIEWPORT_SCROLL:'scroll',STACK_NEW_IMAGE:'loaded'};
 const stack=nativeStack({window:{setTimeout:defer},setTimeout:defer,clearTimeout:cancel,
  cache:{Ay:{isLoaded:id=>frameCache.has(id)}},enums:{Events:events,ViewportStatus:{PRE_RENDER:'rendered'}},
  triggerEvent:{A:(element,event,detail)=>element.emit(event,{detail})}}).stack;
 const makeView=()=>{
  const element=new Element();let camera={focalPoint:[0,0,0],position:[0,0,10],viewPlaneNormal:[0,0,1],viewUp:[0,1,0],parallelScale:10,flipHorizontal:false,flipVertical:false};
  const ids=Array.from({length:stackFrames},(_,i)=>'image/'+i);
  const v={id:'selected-view',type:kind,element,viewportStatus:'rendered',getCamera:()=>structuredClone(camera),setCamera:c=>{camera={...camera,...c};element.emit(events.CAMERA_MODIFIED);},render(){},
   imageIds:ids,currentImageIdIndex:0,targetImageIdIndex:0,perImageIdDefaultProperties:new Map(),shown:ids[0],
   getImageIds:()=>ids,getTargetImageIdIndex(){return this.targetImageIdIndex;},getCurrentImageIdIndex(){return this.currentImageIdIndex;},
   getCurrentImageId(){return ids[this.currentImageIdIndex];},_throwIfDestroyed(){},
   async _loadAndDisplayImage(id){this.shown=id;return id;},
   setIndex(value){this.currentImageIdIndex=value;this.targetImageIdIndex=value;this.shown=ids[value];},...stack};element.viewport=v;return v;
 };
 current=makeView();
 const cineEvents=new Element(),gridEvents=new Element(),state={isCineEnabled:true,cines:{'selected-view':{isPlaying:false}}},toolState={loop:true};
 const subscribe=emitter=>(name,fn)=>{emitter.addEventListener(name,fn);return {unsubscribe:()=>emitter.removeEventListener(name,fn)};};
 const cine={EVENTS:{CINE_STATE_CHANGED:'cine'},getState:()=>state,subscribe:subscribe(cineEvents),playClip(element,options){if(kind==='orthographic')throw Error('MPR must use guarded timer');nativePlays++;lastPlaybackRate=options.framesPerSecond;},
  stopClip(){cineEvents.emit('cine');},setCine:({id,...values})=>{Object.assign(state.cines[id],values);cineEvents.emit('cine');}};
 const grid={EVENTS:{ACTIVE_VIEWPORT_ID_CHANGED:'active',GRID_STATE_CHANGED:'grid'},getActiveViewportId:()=>current.id,getState:()=>({viewports:new Map([[current.id,{}]])}),subscribe:subscribe(gridEvents)};
 window.cornerstone={Enums:{Events:events,ViewportStatus:{RENDERED:'rendered'}},getEnabledElement:element=>element.disabled?undefined:({viewport:element.viewport}),
  cache:{getImage:()=>null,getMaxCacheSize:()=>16*1024*1024,getCacheSize:()=>0,isCacheable:n=>n<=16*1024*1024},metaData:{get:()=>({rows:64,columns:64})},imageLoader:{loadAndCacheImage:async id=>{frameCache.add(id);}},utilities:{
   getVolumeViewportScrollInfo:v=>({sliceRangeInfo:{sliceRange:{min:0,max:32,current:v.getCamera().focalPoint[2]},spacingInNormalDirection:1,camera:v.getCamera()}}),
   // Pinned jumpToSlice chooses current vs pending index from debounceLoading;
   // native scroll always applies that delta to the pending target.
   jumpToSlice:async(element,{imageIndex,debounceLoading=false})=>{const v=element.viewport;v.scroll(imageIndex-(debounceLoading?v.getTargetImageIdIndex():v.getCurrentImageIdIndex()),debounceLoading);},
   scroll:(v,{delta,debounceLoading})=>v.scroll(delta,debounceLoading)}};
 window.cornerstoneTools={utilities:{cine:{getToolState:()=>toolState}}};
 window.kinGetVolumeCineTarget=()=>({key:'same-source-and-selection',contentKey:'same-source',allowed,volume:{volumeId:'volume'}});
 const fetch=()=>++requests===1?new Promise((resolve,reject)=>{resolveOld=resolve;rejectOld=reject;}):Promise.resolve(response());
 const context={performance:{},window,document,fetch,AbortController,setTimeout:defer,clearTimeout:cancel,JSON,Number,Math,Error,
  setInterval:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearInterval:id=>timers.delete(id)};
 const extension=vm.runInNewContext(implementation+';kinCreateCine()',context);
 const handlerId='@ohif/extension-default.sopClassHandlerModule.stack';
 // The native stack handler exposes FrameTime in milliseconds on a display set.
 // Model that service boundary, leaving all DICOM instances untouched.
 const originalCreate=instances=>instances.map(instance=>({instances:[instance],FrameRate:instance.FrameTime,SOPClassHandlerId:handlerId}));
 const handler={getDisplaySetsFromSeries:originalCreate},cached=originalCreate(cachedInstances);
 extension.preRegistration({extensionManager:{getModuleEntry:id=>{assert.equal(id,handlerId);return stackHandler?handler:undefined;}},servicesManager:{services:{
  cineService:cine,viewportGridService:grid,cornerstoneViewportService:{getCornerstoneViewport:()=>current},displaySetService:{getActiveDisplaySets:()=>cached}
 }}});extension.onModeEnter();
 const find=predicate=>{const visit=node=>node instanceof Element&&(predicate(node)?node:node.children.map(visit).find(Boolean));return visit(document.body);};
 const control=label=>find(node=>node.attributes['aria-label']===label),button=text=>find(node=>node.textContent===text);
 function response(){return {ok:true,json:async()=>({kind:'member',institution:'institution',sub:'same-user'})};}
 function play(){document.emit('click',{target:{closest:()=>true}});cine.setCine({id:current.id,isPlaying:true});return cine.playClip(current.element,{framesPerSecond:state.cines[current.id].frameRate??24});}
 // OHIF 3.9.1 initializes both the FPS control and cine service from this hint.
 function openDisplaySet(ds){const frameRate=ds.FrameRate?Math.round(1000/ds.FrameRate):24;cine.setCine({id:current.id,isPlaying:false,frameRate});return frameRate;}
 return {play,old:current,range(first,last){control('Range Start').value=String(first);control('Range End').value=String(last);button('Apply Range').emit('click');},
  openSeries:instance=>openDisplaySet(handler.getDisplaySetsFromSeries([instance])[0]),openCached:()=>openDisplaySet(cached[0]),
  setRate:frameRate=>cine.setCine({id:current.id,frameRate}),rate:()=>state.cines[current.id].frameRate,playbackRate:()=>lastPlaybackRate,
  changeRate(frameRate){cine.setCine({id:current.id,frameRate});cine.stopClip(current.element,{viewportId:current.id});return cine.playClip(current.element,{framesPerSecond:frameRate});},
  handlerRestored:()=>handler.getDisplaySetsFromSeries===originalCreate,reenter:()=>extension.onModeEnter(),
  restart(){cine.stopClip(current.element,{viewportId:current.id});return cine.playClip(current.element,{framesPerSecond:12});},
  mode(value){control('Playback Direction').value=value;control('Playback Direction').emit('change');},loop(value){const input=find(node=>node.type==='checkbox');input.checked=value;input.emit('change');},
  jump(end){button(end?(kind==='stack'?'Last Frame':'Last Plane'):(kind==='stack'?'First Frame':'First Plane')).emit('click');},
  changeScale(value){current.setCamera({parallelScale:value});},message:()=>find(node=>node.attributes.role==='status').textContent,replace(){current=makeView();gridEvents.emit('grid');return current;},
  stopOld(element,disabled=false){element.disabled=disabled;cine.stopClip(element,{viewportId:'selected-view'});},
  release(){resolveOld(response());},reject(){rejectOld(Error('Synthetic old response failed'));},deny(){allowed=false;},
  tick(){for(const entry of [...timers.values()])if(entry.ms!==250)entry.fn();},index:()=>current.getCurrentImageIdIndex(),nativePlays:()=>nativePlays,
  deferred(){for(const [id,entry] of [...deferred])if(entry.ms===40){deferred.delete(id);entry.fn();}},
  rangeValues:()=>[control('Range Start').value,control('Range End').value],playing:()=>state.cines['selected-view'].isPlaying,close:()=>extension.onModeExit()};
}

for(const end of [false,true])test(`stack cine ${end?'Last':'First'} Frame corrects a stale target and the next wheel step starts there`,async()=>{
 const f=fixture('stack');try{
  await f.old.setImageIdIndex(4); // A legacy direct jump leaves its scroll target behind.
  f.range(2,6);f.jump(end);await new Promise(setImmediate);
  const wanted=end?5:1;
  assert.equal(f.old.shown,'image/'+wanted);
  f.old.scroll(end?-1:1,false);
  assert.equal(f.old.shown,'image/'+(wanted+(end?-1:1)));
 }finally{f.close();}
});

test('stack cine range start supersedes a pending wheel target without a deferred rewind',async()=>{
 const f=fixture('stack');try{
  f.range(3,5);f.old.scroll(1); // Current 0, target 1, frame 1 still deferred.
  const playing=f.play();f.release();await playing;
  assert.equal(f.old.shown,'image/2');
  f.deferred();assert.equal(f.old.shown,'image/2');
  f.tick();assert.equal(f.old.shown,'image/3');
 }finally{f.close();}
});

for(const [name,attributes,expected] of [
 ['Cine Rate', {CineRate:12},12],
 ['Recommended Display Frame Rate before Cine Rate and Frame Time', {RecommendedDisplayFrameRate:12,CineRate:24,FrameTime:40},12],
 ['Cine Rate before Frame Time', {CineRate:'12',FrameTime:40},12],
 ['Frame Time fallback', {FrameTime:100},10],
 ['no rate', {},24],
 ['Frame Time Vector alone keeps the existing default', {FrameTimeVector:[0,80,80]},24],
 ['invalid recommended rate falls back to Cine Rate', {RecommendedDisplayFrameRate:'bad',CineRate:12},12],
 ['nonpositive rates fall back to Frame Time', {RecommendedDisplayFrameRate:0,CineRate:-12,FrameTime:50},20],
 ['non-finite rates keep the existing default', {RecommendedDisplayFrameRate:Infinity,CineRate:NaN},24],
 ['a source rate above the playable range opens at its maximum', {CineRate:120,FrameTime:40},90],
 ['a source rate below one frame per second opens at its minimum', {RecommendedDisplayFrameRate:0.3},1],
])test(`multiframe opens and plays at ${expected} FPS: ${name}`,async()=>{
 const f=fixture('stack'),instance=Object.freeze({NumberOfFrames:7,...attributes}),before={...instance};try{
  assert.equal(f.openSeries(instance),expected);assert.equal(f.rate(),expected);
  const pending=f.play();f.release();await pending;assert.equal(f.playbackRate(),expected);
  await f.changeRate(23);assert.equal(f.rate(),23);assert.equal(f.playbackRate(),23);
  assert.deepEqual(instance,before);
 }finally{f.close();}
 assert.equal(f.handlerRestored(),true);
});

test('a viewer without the stack handler loses only the source-rate hint',async()=>{
 const f=fixture('stack',7,[],false);try{
  assert.equal(f.openSeries({NumberOfFrames:7,CineRate:12}),24);
  f.range(2,6);f.jump(true);await new Promise(setImmediate);
  assert.equal(f.old.shown,'image/5');
 }finally{f.close();}
});

test('a replacement series gets its own rate, including the old default when absent',()=>{
 const f=fixture('stack');try{
  assert.equal(f.openSeries({NumberOfFrames:7,CineRate:12}),12);f.setRate(23);
  assert.equal(f.openSeries({NumberOfFrames:7}),24);
  assert.equal(f.openSeries({NumberOfFrames:7,CineRate:15}),15);
  assert.equal(f.openSeries({NumberOfFrames:1,CineRate:12}),24);
 }finally{f.close();}
});

test('cached multiframe rates and mode re-entry use the same source precedence',()=>{
 const instance=Object.freeze({NumberOfFrames:7,RecommendedDisplayFrameRate:12,CineRate:24});
 const f=fixture('stack',7,[instance]);try{
  assert.equal(f.openCached(),12);f.reenter();assert.equal(f.openCached(),12);
  assert.equal(f.openSeries({NumberOfFrames:7,CineRate:15}),15);
 }finally{f.close();}
 assert.equal(f.handlerRestored(),true);
});
for(const outcome of ['release','reject'])test(`late retired MPR ${outcome} leaves replacement playback running`,async()=>{
 const f=fixture();try{
  const old=f.play(),replacement=f.replace();assert.equal(f.playing(),false);await f.play();f.tick();assert.equal(replacement.getCamera().focalPoint[2],1);
  f[outcome]();await old;assert.equal(f.playing(),true);f.tick();assert.equal(replacement.getCamera().focalPoint[2],2);assert.equal(f.old.getCamera().focalPoint[2],0);
 }finally{f.close();}
});
for(const disabled of [false,true])test(`retired native stop (${disabled?'disabled':'enabled'} element) leaves replacement timer and state intact`,async()=>{
 const f=fixture();try{
  const old=f.play(),replacement=f.replace();await f.play();f.release();await old;f.tick();assert.equal(replacement.getCamera().focalPoint[2],1);
  f.stopOld(f.old.element,disabled);assert.equal(f.playing(),true);f.tick();assert.equal(replacement.getCamera().focalPoint[2],2);
 }finally{f.close();}
});
test('an invalidated permission response still stops its own MPR record',async()=>{
 const f=fixture();try{const pending=f.play();f.deny();f.release();await pending;assert.equal(f.playing(),false);f.tick();assert.equal(f.old.getCamera().focalPoint[2],0);}finally{f.close();}
});

test('MPR range clamps to its start and Yoyo reflects without duplicate endpoints',async()=>{
 const f=fixture();try{
  f.range(3,5);f.mode('yoyo');f.loop(false);const pending=f.play();f.release();await pending;
  assert.equal(f.old.getCamera().focalPoint[2],2);
  for(const expected of [3,4,3,2]){f.tick();assert.equal(f.old.getCamera().focalPoint[2],expected);}
  f.tick();assert.equal(f.old.getCamera().focalPoint[2],2);assert.equal(f.playing(),false);
 }finally{f.close();}
});

test('invalid MPR range is rejected without replacing the applied range',()=>{
 const f=fixture();try{
  f.range(3,5);f.range(8,4);assert.match(f.message(),/시작이 끝보다 작아야/);f.jump(true);assert.equal(f.old.getCamera().focalPoint[2],4);
 }finally{f.close();}
});

test('MPR camera grid change resets numeric plane range instead of reinterpreting it',()=>{
 const f=fixture();try{f.range(3,5);assert.deepEqual(f.rangeValues(),['3','5']);f.changeScale(20);assert.deepEqual(f.rangeValues(),['1','33']);}finally{f.close();}
});

test('stack range clamps to its start and uses bounded Yoyo while full range stays native',async()=>{
 const ranged=fixture('stack');try{
  ranged.range(3,5);ranged.mode('yoyo');ranged.loop(false);const pending=ranged.play();ranged.release();await pending;
  assert.equal(ranged.index(),2);assert.equal(ranged.nativePlays(),0);
  for(const expected of [3,4,3,2]){ranged.tick();assert.equal(ranged.index(),expected);}
  ranged.tick();assert.equal(ranged.index(),2);assert.equal(ranged.playing(),false);
  ranged.replace();assert.deepEqual(ranged.rangeValues(),['1','7']);
 }finally{ranged.close();}
 const normal=fixture('stack');try{
  const pending=normal.play();normal.release();await pending;assert.equal(normal.nativePlays(),1);
 }finally{normal.close();}
 const single=fixture('stack',1);try{single.jump(false);single.jump(true);assert.equal(single.index(),0);}finally{single.close();}
});

for(const kind of ['stack','orthographic'])test(`${kind} Yoyo keeps descending direction across native FPS restart`,async()=>{
 const f=fixture(kind);try{
  f.range(3,5);f.mode('yoyo');const pending=f.play();f.release();await pending;
  for(const expected of [3,4,3]){f.tick();assert.equal(kind==='stack'?f.index():f.old.getCamera().focalPoint[2],expected);}
  await f.restart();f.tick();assert.equal(kind==='stack'?f.index():f.old.getCamera().focalPoint[2],2);
  f.tick();f.tick();f.tick(); // 3, 4, 3: descending again.
  f.range(3,6);await f.play();f.tick();assert.equal(kind==='stack'?f.index():f.old.getCamera().focalPoint[2],4);
  f.tick();f.tick(); // 5, 4: descending after the new endpoint.
  f.mode('forward');f.mode('yoyo');await f.play();f.tick();assert.equal(kind==='stack'?f.index():f.old.getCamera().focalPoint[2],5);
  if(kind==='orthographic'){f.tick();f.changeScale(20);await f.play();f.tick();assert.equal(f.old.getCamera().focalPoint[2],5);}
 }finally{f.close();}
});

for(const kind of ['stack','orthographic'])test(`${kind} completed Yoyo cycle can be played again`,async()=>{
 const f=fixture(kind),index=()=>kind==='stack'?f.index():f.old.getCamera().focalPoint[2];try{
  f.range(3,5);f.mode('yoyo');f.loop(false);const pending=f.play();f.release();await pending;
  for(const expected of [3,4,3,2]){f.tick();assert.equal(index(),expected);}
  f.tick();assert.equal(f.playing(),false);assert.equal(index(),2);
  await f.play();f.tick();assert.equal(index(),3);assert.equal(f.playing(),true);
 }finally{f.close();}
});
