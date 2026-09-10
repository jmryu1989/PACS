const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('config/ohif.js','utf8');
const implementation=source.slice(source.indexOf('function kinCreateCine()'),source.indexOf('function kinApplyCTPreset('));

// Execute the complete extension with a deterministic service/event scheduler.
// Native renderer and React remount behavior remain covered by live suites;
// this isolates ownership of overlapping permission promises and cine timers.
class Element {
 constructor(){this.listeners=new Map();this.style={};this.children=[];this.hidden=false;this.offsetHeight=0;}
 addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
 removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
 emit(name,event={}){for(const fn of this.listeners.get(name)||[])fn(event);}
 setAttribute(){}
 append(...items){this.children.push(...items);}
 remove(){}
 querySelectorAll(){return [];}
}
function fixture(){
 const document=new Element(),window=new Element(),timers=new Map();let nextTimer=0,current,allowed=true,resolveOld,rejectOld,requests=0;
 document.body=new Element();document.createElement=()=>new Element();document.hidden=false;
 const events={VIEWPORT_NEW_IMAGE_SET:'images',VOLUME_VIEWPORT_NEW_VOLUME:'volume',CAMERA_MODIFIED:'camera'};
 const makeView=()=>{
  const element=new Element();let camera={focalPoint:[0,0,0],position:[0,0,10],viewPlaneNormal:[0,0,1],viewUp:[0,1,0],parallelScale:10,flipHorizontal:false,flipVertical:false};
  const v={id:'mpr-axial',type:'orthographic',element,getCamera:()=>structuredClone(camera),setCamera:c=>{camera={...camera,...c};element.emit(events.CAMERA_MODIFIED);},render(){}};element.viewport=v;return v;
 };
 current=makeView();
 const cineEvents=new Element(),gridEvents=new Element(),state={isCineEnabled:true,cines:{'mpr-axial':{isPlaying:false}}};
 const subscribe=emitter=>(name,fn)=>{emitter.addEventListener(name,fn);return {unsubscribe:()=>emitter.removeEventListener(name,fn)};};
 const cine={EVENTS:{CINE_STATE_CHANGED:'cine'},getState:()=>state,subscribe:subscribe(cineEvents),playClip(){throw Error('MPR must use guarded timer');},
  stopClip(){cineEvents.emit('cine');},setCine:({id,...values})=>{Object.assign(state.cines[id],values);cineEvents.emit('cine');}};
 const grid={EVENTS:{ACTIVE_VIEWPORT_ID_CHANGED:'active',GRID_STATE_CHANGED:'grid'},getActiveViewportId:()=>current.id,getState:()=>({viewports:new Map([[current.id,{}]])}),subscribe:subscribe(gridEvents)};
 window.cornerstone={Enums:{Events:events},getEnabledElement:element=>element.disabled?undefined:({viewport:element.viewport}),utilities:{getVolumeViewportScrollInfo:v=>({sliceRangeInfo:{sliceRange:{min:0,max:32,current:v.getCamera().focalPoint[2]},spacingInNormalDirection:1,camera:v.getCamera()}})}};
 window.kinGetVolumeCineTarget=()=>({key:'same-source-and-selection',contentKey:'same-source',allowed,volume:{volumeId:'volume'}});
 const fetch=()=>++requests===1?new Promise((resolve,reject)=>{resolveOld=resolve;rejectOld=reject;}):Promise.resolve(response());
 const context={window,document,fetch,AbortController,setTimeout,clearTimeout,JSON,Number,Math,Error,
  setInterval:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearInterval:id=>timers.delete(id)};
 const extension=vm.runInNewContext(implementation+';kinCreateCine()',context);
 extension.preRegistration({servicesManager:{services:{cineService:cine,viewportGridService:grid,cornerstoneViewportService:{getCornerstoneViewport:()=>current}}}});extension.onModeEnter();
 function response(){return {ok:true,json:async()=>({kind:'member',institution:'institution',sub:'same-user'})};}
 function play(){document.emit('click',{target:{closest:()=>true}});cine.setCine({id:current.id,isPlaying:true});return cine.playClip(current.element,{framesPerSecond:24});}
 return {play,old:current,replace(){current=makeView();gridEvents.emit('grid');return current;},
  stopOld(element,disabled=false){element.disabled=disabled;cine.stopClip(element,{viewportId:'mpr-axial'});},
  release(){resolveOld(response());},reject(){rejectOld(Error('Synthetic old response failed'));},deny(){allowed=false;},
  tick(){for(const entry of [...timers.values()])if(entry.ms!==250)entry.fn();},playing:()=>state.cines['mpr-axial'].isPlaying,close:()=>extension.onModeExit()};
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
