// S8-SCULPT-PERF B-u (S8-U1a fix9): the VR mask session without a GPU. BU-T01 (session part), BU-T04, BU-T05, BU-T06a,
// BU-T06b and BU-T08 of the implementation order, plus the generation, retry and redraw rules they rest on.
// The renderer is this file's own: a GL that keeps each program's uniforms in int32/float32 storage and applies a uniform
// write only to the bound program, a shader cache keyed by the three final sources that compiles and links an entry on
// first use, and a frame that builds the mapper's program from its view-specific properties the way the pinned renderer
// applies a fragment replacement, then answers every waiting frame callback. Assertions read only the session's public
// results (status, gen, error, restore, state()), the GL calls made, and the uniforms of the program the frame drew.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const masks=require('../worklist-v0/hpacs-lite/volume-vr-masks.js');
const sculpt=require('../worklist-v0/hpacs-lite/volume-sculpt.js');

const SOURCE=fs.readFileSync(path.join(__dirname,'..','worklist-v0','hpacs-lite','volume-mask-renderer.js'),'utf8');
// One module instance per test: its page-wide generation counter is shared by the sessions of that test only.
function renderer(){const context={window:{KinVolumeVrMasks:masks}};vm.runInNewContext(SOURCE,context);return context.window.KinVolumeMaskRenderer;}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const UNIFORM=/uniform (ivec4|vec4|vec2) (\w+)(?:\[(\d+)\])?;/g;
const WRITES=new Set(['useProgram','uniform4i','uniform4iv','uniform4fv','uniform2fv','getUniform','getUniformLocation','deleteProgram']);

function world(){
  const calls=[],errors=[],programs=new Set(),canvas=new EventTarget(),cacheMap={};
  const inject={compile:0,link:0,frameErrors:0,writeErrors:0,stale:0,dropReplacements:false,variant:'plain'};
  let lost=false,current=null,frames=[],drawn=null;
  const gl={NO_ERROR:0,INVALID_VALUE:0x501,INVALID_OPERATION:0x502,CURRENT_PROGRAM:0x8b8d,canvas,
    isContextLost:()=>lost,isProgram:handle=>!lost&&programs.has(handle),
    getParameter:name=>name===gl.CURRENT_PROGRAM?current:null,
    useProgram(handle){calls.push('useProgram');if(!lost)current=handle;},
    getError(){calls.push('getError');return errors.length?errors.shift():gl.NO_ERROR;},
    getUniformLocation(handle,full){
      calls.push('getUniformLocation');if(lost||!programs.has(handle))return null;
      const match=/^(\w+)(?:\[(\d+)\])?$/.exec(full),uniform=match&&handle.uniforms[match[1]],index=match?.[2]===undefined?0:Number(match[2]);
      return uniform&&index<uniform.size?{handle,uniform,index}:null;
    },
    getUniform(handle,location){calls.push('getUniform');if(lost||location?.handle!==handle)return null;const {uniform,index}=location;return uniform.data.slice(index*uniform.comps,(index+1)*uniform.comps);},
    deleteProgram(handle){calls.push('deleteProgram');programs.delete(handle);}};
  for(const name of ['uniform4i','uniform4iv','uniform4fv','uniform2fv'])gl[name]=(location,...values)=>{
    calls.push(name);if(lost)return;
    if(!location||location.handle!==current){errors.push(gl.INVALID_OPERATION);return;}
    // One injected failure per write: the projection array, which every write sends once per program.
    if(inject.writeErrors&&location.uniform===location.handle.uniforms.kinProj){inject.writeErrors--;errors.push(gl.INVALID_VALUE);return;}
    const data=Array.from(values.length===1&&ArrayBuffer.isView(values[0])?values[0]:values),{uniform,index}=location;
    if(data.length%uniform.comps){errors.push(gl.INVALID_VALUE);return;}
    uniform.data.set(data.slice(0,(uniform.size-index)*uniform.comps),index*uniform.comps);
  };
  function link(fragment){
    const handle={uniforms:{}};
    for(const [,type,name,size] of fragment.matchAll(UNIFORM)){const comps=type==='vec2'?2:4,count=size?Number(size):1;handle.uniforms[name]={comps,size:count,data:type==='ivec4'?new Int32Array(comps*count):new Float32Array(comps*count)};}
    programs.add(handle);return handle;
  }
  function entry(vertex,fragment,geometry){
    const key=vertex+'\u0000'+fragment+'\u0000'+geometry,shader=text=>({getSource:()=>text,cleanup(){calls.push('deleteShader');}});
    const e={compiled:false,linked:false,handle:null,getCompiled:()=>e.compiled,getLinked:()=>e.linked,getHandle:()=>e.handle,getMd5Hash:()=>key,
      get:name=>({[name]:name==='context'?gl:undefined}),getVertexShader:()=>shader(vertex),getFragmentShader:()=>shader(fragment),getGeometryShader:()=>shader(geometry)};
    return e;
  }
  const cache={get:name=>({[name]:name==='shaderPrograms'?cacheMap:undefined}),
    getShaderProgram(vertex,fragment,geometry){const key=vertex+'\u0000'+fragment+'\u0000'+geometry;return cacheMap[key]||(cacheMap[key]=entry(vertex,fragment,geometry));},
    readyShaderProgram(program){
      if(lost)return null;
      if(!program.compiled){
        calls.push('compileShader','compileShader');if(inject.compile){inject.compile--;return null;}
        program.handle=link(program.getFragmentShader().getSource());calls.push('linkProgram');if(inject.link){inject.link--;return null;}
        program.compiled=program.linked=true;
      }
      current=program.handle;return program;
    }};
  const mapper={props:{},writes:0,getViewSpecificProperties(){return this.props;},setViewSpecificProperties(value){this.props=value;this.writes++;}};
  // One frame of the pinned renderer for this mapper: its template variant with the fragment replacements of the mapper's
  // properties applied, built through the cache (compiled there when new).
  function draw(){
    let fragment='#version 300 es\n// variant '+inject.variant+'\n'+masks.SIGNATURE+'\n  return tValue;\n}\n';
    if(!inject.dropReplacements)for(const r of mapper.props?.OpenGL?.ShaderReplacements||[])if(r.shaderType==='Fragment')fragment=fragment.replace(r.originalValue,()=>r.replacementValue);
    const program=cache.getShaderProgram('vertex',fragment,'');
    if(!cache.readyShaderProgram(program))throw Error('the renderer could not build its program');
    drawn=program;
    // Another writer left an older generation in the drawn program after the session wrote it.
    if(inject.stale&&drawn.handle.uniforms.kinHead){inject.stale--;drawn.handle.uniforms.kinHead.data[0]=1;}
  }
  const windowGL={getContext:()=>gl,getShaderCache:()=>cache,getViewNodeFor:value=>value===mapper?{get:()=>({tris:{getProgram:()=>drawn}})}:null};
  const target={engine:{offscreenMultiRenderWindow:{getOpenGLRenderWindow:()=>windowGL}},mapper,frame:done=>{frames.push(done);}};
  // Animation frames until no callback waits: each draws once and answers every waiting callback.
  async function run(limit=20){
    let count=0;
    while(frames.length&&count<limit){
      count++;const waiting=frames;frames=[];let error=null;
      if(inject.frameErrors){inject.frameErrors--;error=Error('injected render failure');}
      else if(!lost){try{draw();}catch(caught){error=caught;}}
      for(const done of waiting)done({error});
      await settle();
    }
    return count;
  }
  draw();
  const uniform=name=>Array.from(drawn.handle.uniforms[name]?.data||[]);
  return {gl,calls,mapper,target,inject,run,cacheMap,uniform,drawn:()=>drawn,
    lose(){lost=true;current=null;canvas.dispatchEvent(new Event('webglcontextlost'));}};
}
const count=(calls,name)=>calls.filter(call=>call===name).length;
// The drawn program holds exactly the packed request, under a complete write (kinHead.x > 0).
function shows(w,request){
  const d=masks.pack(request),head=w.uniform('kinHead');
  if(!w.drawn().getFragmentShader().getSource().includes(masks.TEXT)||!(head[0]>0)||head[1]!==d.count)return false;
  return [['kinMeta',d.meta],['kinProj',d.proj],['kinBox',d.box],['kinEll',d.ell],['kinEdge',d.edge],['kinCross',d.cross],['kinVoi',d.voi],['kinVoiHalf',d.voiHalf]]
    .every(([name,want])=>{const got=w.uniform(name);return got.length===want.length&&got.every((value,index)=>value===want[index]);});
}

// Requests: a slab and up to three regions on an identity projection.
const IDENTITY={base:[0,0],axes:[[1,0],[0,1],[0,0]]};
const region=(mode,points)=>sculpt.makeRegion(mode,points,.002);
const R1=sculpt.makeOperation(region('Rectangle',[[.1,.1],[.4,.5]]),IDENTITY,'Inside');
const R2=sculpt.makeOperation(region('Ellipse',[[.5,.2],[.9,.6]]),IDENTITY,'Outside');
const R3=sculpt.makeOperation(region('Freehand Area',[[.2,.6],[.5,.65],[.45,.9],[.25,.85]]),IDENTITY,'Inside');
const SLAB=Object.freeze({mode:'Slab',base:-.25,axes:[0,1,0],halfThickness:.2});
const A={voi:SLAB,sculpt:[R1]},B={voi:SLAB,sculpt:[R1,R2]},C={voi:{...SLAB,base:-.3},sculpt:[R1,R2,R3]},D={voi:null,sculpt:[R1,R2,R3]};
async function committed(w,s,request){const pending=s.apply(request);await w.run();const result=await pending;assert.equal(result.status,'ok',JSON.stringify(result));return result;}

test('BU-T04 the first request installs one program; later edits, Undo, Original View and Clear compile and link nothing; a new display variant compiles once',async()=>{
  const w=world(),s=renderer().session({target:w.target});
  const built=()=>[count(w.calls,'compileShader'),count(w.calls,'linkProgram')],start=built();
  const first=s.apply(A);
  assert.deepEqual(built(),[start[0]+2,start[1]+1],'the install compiles and links the fixed program once, before the frame');
  assert.equal(w.mapper.writes,1,'the mapper gets the fixed replacement once');
  await w.run();assert.equal((await first).status,'ok');assert.ok(shows(w,A));
  assert.deepEqual(built(),[start[0]+2,start[1]+1],'the frame found the installed program');
  for(const request of [B,C,D,B,{voi:SLAB,sculpt:[R1,R2],original:true},{voi:SLAB},{}]){
    const before=built();await committed(w,s,request);
    assert.deepEqual(built(),before,JSON.stringify(request));assert.ok(shows(w,request));assert.equal(w.mapper.writes,1);
  }
  // A display change makes the renderer build another variant: compiled once in that frame, then written and checked.
  await committed(w,s,C);
  w.inject.variant='shaded';let before=built();
  const redraw=s.render();assert.equal(await w.run(),2,'the new variant draws nothing once, then the rewrite is drawn');
  assert.equal((await redraw).status,'ok');assert.deepEqual(built(),[before[0]+2,before[1]+1]);assert.ok(shows(w,C));
  before=built();await committed(w,s,D);assert.deepEqual(built(),before);assert.ok(shows(w,D));
  // Back to the first variant: cached, and it already holds the latest data (every fixed program is written).
  w.inject.variant='plain';before=built();const back=s.render();assert.equal(await w.run(),1);
  assert.equal((await back).status,'ok');assert.deepEqual(built(),before);assert.ok(shows(w,D));
});

test('BU-T05 a frame error or a uniform write failure fails the request, keeps the committed request shown, and the session stays usable',async()=>{
  const w=world(),s=renderer().session({target:w.target});
  const a=await committed(w,s,A);
  for(const [label,inject,error] of [['frame error',{frameErrors:1},/injected render failure/],['uniform write failure',{writeErrors:1},/GL 1281/]]){
    const before=[count(w.calls,'compileShader'),w.mapper.writes];
    Object.assign(w.inject,inject);const pending=s.apply(B);await w.run();const result=await pending;
    assert.equal(result.status,'failed',label);assert.match(result.error.message,error,label);
    assert.equal(result.restore.status,'ok',label+': the committed request is drawn again');
    assert.equal(s.state().committed.gen,a.gen,label);assert.equal(s.state().committed.request,A,label);assert.equal(s.state().pending,null,label);
    assert.ok(shows(w,A),label);assert.equal(w.uniform('kinHead')[0],result.restore.gen,label);
    assert.deepEqual([count(w.calls,'compileShader'),w.mapper.writes],before,label+': nothing compiled or reinstalled');
  }
  const c=await committed(w,s,C);assert.ok(shows(w,C));assert.equal(s.state().committed.gen,c.gen);
  // A failure before anything was committed draws no masks again.
  const w2=world(),s2=renderer().session({target:w2.target});w2.inject.frameErrors=1;
  const pending=s2.apply(B);await w2.run();const result=await pending;
  assert.equal(result.status,'failed');assert.equal(result.restore.status,'ok');assert.equal(s2.state().committed,null);assert.ok(shows(w2,{}));
});

test('BU-T05 when the committed request cannot be drawn again either, the result says so and an interrupted write draws nothing',async()=>{
  const w=world(),s=renderer().session({target:w.target});await committed(w,s,A);
  w.inject.frameErrors=2;let pending=s.apply(B);await w.run();let result=await pending;
  assert.equal(result.status,'failed');assert.equal(result.restore.status,'failed');assert.equal(s.state().committed.request,A);
  w.inject.writeErrors=2;pending=s.apply(B);await w.run();result=await pending;
  assert.equal(result.status,'failed');assert.equal(result.restore.status,'failed');
  assert.equal(w.uniform('kinHead')[0],0,'kinHead is cleared before the arrays, so the program draws nothing');
  // The drawn program without the fixed masks fails without a rewrite and cannot show the committed request either.
  const w2=world(),s2=renderer().session({target:w2.target});await committed(w2,s2,A);
  w2.inject.dropReplacements=true;pending=s2.apply(B);assert.equal(await w2.run(),2,'one frame for the request, one for the restore: no rewrite');
  result=await pending;assert.match(result.error.message,/without the fixed masks/);assert.equal(result.restore.status,'failed');
});

test('a stale program gets one rewrite and one more frame; a second stale frame fails the request and the committed request is shown',async()=>{
  const w=world(),s=renderer().session({target:w.target});const a=await committed(w,s,A);
  w.inject.stale=1;let pending=s.apply(B);assert.equal(await w.run(),2);let result=await pending;assert.equal(result.status,'ok');assert.ok(shows(w,B));
  w.inject.stale=2;pending=s.apply(C);await w.run();result=await pending;
  assert.equal(result.status,'failed');assert.match(result.error.message,/generation 1/);assert.equal(result.restore.status,'ok');assert.ok(shows(w,B));
  assert.equal(s.state().committed.request,B);assert.ok(s.state().committed.gen>a.gen);
});

test('BU-T06a a superseded request never commits; closing ends the pending request and keeps the committed one',async()=>{
  const w=world(),s=renderer().session({target:w.target});const a=await committed(w,s,A);
  const b=s.apply(B),c=s.apply(C);await w.run();
  assert.equal((await b).status,'superseded');const cResult=await c;assert.equal(cResult.status,'ok');
  assert.equal(s.state().committed.request,C);assert.ok(shows(w,C));assert.ok(cResult.gen>a.gen);
  // A redraw while a request is in flight leaves the check to that request's own frame.
  const d=s.apply(D),redraw=s.render();await w.run();assert.equal((await redraw).status,'pending');assert.equal((await d).status,'ok');
  const e=s.apply(B);assert.deepEqual(s.state().pending.request,B);s.close();
  assert.equal((await e).status,'cancelled-session');
  assert.equal(s.state().status,'closed');assert.equal(s.state().committed.request,D);assert.equal(s.state().pending,null);
  assert.throws(()=>s.apply(A),error=>error.kinVrReason==='render-failed');
  await w.run();assert.equal(s.state().committed.request,D,'a frame after the close changes nothing');
});

test('BU-T06a a context loss ends the pending request as cancelled-context, keeps the committed request and uses nothing of the lost context again',async()=>{
  for(const how of ['context event','owner report']){
    const w=world(),told=[];const s=renderer().session({target:w.target,onLost:()=>told.push(how)});
    const a=await committed(w,s,A);const pending=s.apply(B);assert.equal(s.state().pending.gen,a.gen+1);
    const mark=w.calls.length;
    if(how==='context event')w.lose();else{s.lost();w.lose();}
    assert.equal((await pending).status,'cancelled-context',how);
    assert.deepEqual(told,how==='context event'?[how]:[],how+': onLost runs for the context event only');
    const state=s.state();assert.equal(state.status,'lost',how);assert.equal(state.pending,null,how);
    assert.equal(state.committed.request,A,how);assert.equal(state.committed.gen,a.gen,how+': the pending request never replaces it');
    assert.throws(()=>s.apply(C),error=>error.kinVrReason==='context-lost',how);
    assert.equal((await s.render()).status,'cancelled-context',how);
    await w.run();
    assert.deepEqual(w.calls.slice(mark).filter(name=>WRITES.has(name)),[],how+': no program, location or uniform of the lost context is used again');
  }
});

test('BU-T06b given a new context the session installs the fixed program there and applies the committed request again, never the pending one',async()=>{
  const w1=world(),s=renderer().session({target:w1.target});const a=await committed(w1,s,A);
  const pending=s.apply(B);w1.lose();assert.equal((await pending).status,'cancelled-context');
  const mark=w1.calls.length,w2=world(),start=[count(w2.calls,'compileShader'),count(w2.calls,'linkProgram')];
  const again=s.reacquire(w2.target);
  assert.deepEqual([count(w2.calls,'compileShader'),count(w2.calls,'linkProgram')],[start[0]+2,start[1]+1],'installed once in the new context');
  assert.equal(w2.mapper.writes,1);await w2.run();const result=await again;
  assert.equal(result.status,'ok');assert.ok(result.gen>a.gen+1);assert.ok(shows(w2,A));assert.ok(!shows(w2,B));
  const state=s.state();assert.equal(state.status,'open');assert.equal(state.committed.request,A);assert.equal(state.committed.gen,result.gen);
  assert.deepEqual(w1.calls.slice(mark).filter(name=>WRITES.has(name)),[],'the lost context is not used');
  const before=count(w2.calls,'compileShader');await committed(w2,s,C);assert.equal(count(w2.calls,'compileShader'),before);assert.ok(shows(w2,C));
  // Nothing committed: the new context only gets the session; nothing is installed or written.
  const w3=world(),w4=world(),fresh=renderer().session({target:w3.target});
  assert.equal((await fresh.reacquire(w4.target)).status,'ok');assert.equal(w4.mapper.writes,0);
});

test('BU-T08 a compile or link failure at install refuses before anything is written or a generation is taken; the display stays usable',async()=>{
  for(const kind of ['compile','link']){
    const api=renderer(),other=world(),witness=api.session({target:other.target});const g=(await committed(other,witness,A)).gen;
    const w=world(),s=api.session({target:w.target}),props=w.mapper.props,shown=w.drawn();w.inject[kind]=1;
    const mark=w.calls.length;
    assert.throws(()=>s.apply(B),error=>error.kinVrReason==='render-failed'&&/GPU/.test(error.message),kind);
    assert.equal(w.mapper.props,props,kind+': the mapper keeps its properties');assert.equal(w.mapper.writes,0,kind);
    assert.ok(!w.calls.slice(mark).some(name=>/^uniform/.test(name)),kind+': nothing written');
    assert.deepEqual(JSON.parse(JSON.stringify(s.state())),{status:'open',installed:false,committed:null,pending:null},kind);
    assert.ok(Object.values(w.cacheMap).every(entry=>!entry.getFragmentShader().getSource().includes(masks.TEXT)),kind+': no entry of the failed program stays');
    if(kind==='link')assert.ok(w.calls.slice(mark).includes('deleteProgram'),'the failed program is deleted');
    // The display without the new masks still draws, and a later request installs.
    const redraw=s.render();await w.run();assert.equal((await redraw).status,'ok');assert.equal(w.drawn(),shown,kind);
    const next=await committed(other,witness,B);assert.equal(next.gen,g+1,kind+': the refusal took no generation');
    await committed(w,s,B);assert.ok(shows(w,B),kind);
  }
});

test('BU-T01 a refused request installs, writes and takes nothing, and leaves the session as it was',async()=>{
  const op=R1,refused=[null,'x',{original:'true'},{original:1},{sculpt:null},{sculpt:{}},{sculpt:[null]},{sculpt:[{...op,side:'Up'}]},
    {sculpt:Array.from({length:9},()=>op)},{voi:0},{voi:false},{voi:''},{voi:{...SLAB,mode:'Plane'}},{voi:{...SLAB,halfThickness:0}},{voi:{...SLAB,base:NaN}}];
  const fresh=world(),unused=renderer().session({target:fresh.target}),start=fresh.calls.length;
  for(const value of refused)assert.throws(()=>unused.apply(value),error=>error.kinVrReason==='vr-limit',JSON.stringify(value));
  assert.equal(fresh.mapper.writes,0);assert.deepEqual(fresh.calls.slice(start),[],'nothing installed or written on a fresh session');
  const w=world(),s=renderer().session({target:w.target});const a=await committed(w,s,A);
  const snapshot=()=>JSON.stringify({state:s.state(),writes:w.mapper.writes,calls:w.calls.length,head:w.uniform('kinHead'),edge:w.uniform('kinEdge').slice(0,16)});
  const before=snapshot();
  for(const value of refused){assert.throws(()=>s.apply(value),error=>error.kinVrReason==='vr-limit');assert.equal(snapshot(),before,JSON.stringify(value));}
  const next=await committed(w,s,B);assert.equal(next.gen,a.gen+1,'the refusals took no generation');
});
