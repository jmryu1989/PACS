const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
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
function fixture(kind='orthographic',stackFrames=7){
 const document=new Element(),window=new Element(),timers=new Map();let nextTimer=0,current,allowed=true,resolveOld,rejectOld,requests=0,nativePlays=0;
 document.body=new Element();document.createElement=()=>new Element();document.hidden=false;
 const events={VIEWPORT_NEW_IMAGE_SET:'images',VOLUME_VIEWPORT_NEW_VOLUME:'volume',CAMERA_MODIFIED:'camera'};
 const makeView=()=>{
  const element=new Element();let camera={focalPoint:[0,0,0],position:[0,0,10],viewPlaneNormal:[0,0,1],viewUp:[0,1,0],parallelScale:10,flipHorizontal:false,flipVertical:false};
  let index=0;const ids=Array.from({length:stackFrames},(_,i)=>'image/'+i);
  const v={id:'selected-view',type:kind,element,viewportStatus:'rendered',getCamera:()=>structuredClone(camera),setCamera:c=>{camera={...camera,...c};element.emit(events.CAMERA_MODIFIED);},render(){},
   getImageIds:()=>ids,getTargetImageIdIndex:()=>index,getCurrentImageIdIndex:()=>index,setIndex:value=>{index=value;}};element.viewport=v;return v;
 };
 current=makeView();
 const cineEvents=new Element(),gridEvents=new Element(),state={isCineEnabled:true,cines:{'selected-view':{isPlaying:false}}},toolState={loop:true};
 const subscribe=emitter=>(name,fn)=>{emitter.addEventListener(name,fn);return {unsubscribe:()=>emitter.removeEventListener(name,fn)};};
 const cine={EVENTS:{CINE_STATE_CHANGED:'cine'},getState:()=>state,subscribe:subscribe(cineEvents),playClip(){if(kind==='orthographic')throw Error('MPR must use guarded timer');nativePlays++;},
  stopClip(){cineEvents.emit('cine');},setCine:({id,...values})=>{Object.assign(state.cines[id],values);cineEvents.emit('cine');}};
 const grid={EVENTS:{ACTIVE_VIEWPORT_ID_CHANGED:'active',GRID_STATE_CHANGED:'grid'},getActiveViewportId:()=>current.id,getState:()=>({viewports:new Map([[current.id,{}]])}),subscribe:subscribe(gridEvents)};
 window.cornerstone={Enums:{Events:events,ViewportStatus:{RENDERED:'rendered'}},getEnabledElement:element=>element.disabled?undefined:({viewport:element.viewport}),
  metaData:{get:()=>({rows:64,columns:64})},imageLoader:{loadAndCacheImage:async()=>{}},utilities:{
   getVolumeViewportScrollInfo:v=>({sliceRangeInfo:{sliceRange:{min:0,max:32,current:v.getCamera().focalPoint[2]},spacingInNormalDirection:1,camera:v.getCamera()}}),
   jumpToSlice:async(element,{imageIndex})=>element.viewport.setIndex(imageIndex),scroll:(v,{delta})=>v.setIndex(v.getTargetImageIdIndex()+delta)}};
 window.cornerstoneTools={utilities:{cine:{getToolState:()=>toolState}}};
 window.kinGetVolumeCineTarget=()=>({key:'same-source-and-selection',contentKey:'same-source',allowed,volume:{volumeId:'volume'}});
 const fetch=()=>++requests===1?new Promise((resolve,reject)=>{resolveOld=resolve;rejectOld=reject;}):Promise.resolve(response());
 const context={window,document,fetch,AbortController,setTimeout,clearTimeout,JSON,Number,Math,Error,
  setInterval:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearInterval:id=>timers.delete(id)};
 const extension=vm.runInNewContext(implementation+';kinCreateCine()',context);
 extension.preRegistration({servicesManager:{services:{cineService:cine,viewportGridService:grid,cornerstoneViewportService:{getCornerstoneViewport:()=>current}}}});extension.onModeEnter();
 const find=predicate=>{const visit=node=>node instanceof Element&&(predicate(node)?node:node.children.map(visit).find(Boolean));return visit(document.body);};
 const control=label=>find(node=>node.attributes['aria-label']===label),button=text=>find(node=>node.textContent===text);
 function response(){return {ok:true,json:async()=>({kind:'member',institution:'institution',sub:'same-user'})};}
 function play(){document.emit('click',{target:{closest:()=>true}});cine.setCine({id:current.id,isPlaying:true});return cine.playClip(current.element,{framesPerSecond:24});}
 return {play,old:current,range(first,last){control('Range Start').value=String(first);control('Range End').value=String(last);button('Apply Range').emit('click');},
  restart(){cine.stopClip(current.element,{viewportId:current.id});return cine.playClip(current.element,{framesPerSecond:12});},
  mode(value){control('Playback Direction').value=value;control('Playback Direction').emit('change');},loop(value){const input=find(node=>node.type==='checkbox');input.checked=value;input.emit('change');},
  jump(end){button(end?(kind==='stack'?'Last Frame':'Last Plane'):(kind==='stack'?'First Frame':'First Plane')).emit('click');},
  changeScale(value){current.setCamera({parallelScale:value});},message:()=>find(node=>node.attributes.role==='status').textContent,replace(){current=makeView();gridEvents.emit('grid');return current;},
  stopOld(element,disabled=false){element.disabled=disabled;cine.stopClip(element,{viewportId:'selected-view'});},
  release(){resolveOld(response());},reject(){rejectOld(Error('Synthetic old response failed'));},deny(){allowed=false;},
  tick(){for(const entry of [...timers.values()])if(entry.ms!==250)entry.fn();},index:()=>current.getCurrentImageIdIndex(),nativePlays:()=>nativePlays,
  rangeValues:()=>[control('Range Start').value,control('Range End').value],playing:()=>state.cines['selected-view'].isPlaying,close:()=>extension.onModeExit()};
}
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
