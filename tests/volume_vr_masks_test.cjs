// TEST-S8-U1a-MODEL (MV-U1a-03, 04, 05, 07): the combined VOI + sculpt mask builder.
// The voxel oracle below is this file's own: crop index ranges, a world dot product for the slab and the accepted sculpt
// region test on its own projection of the voxel. Shader text is never read; the replacement is compared with the accepted
// sculpt producer's output and passed through the renderer's install step with a recording GL.
// S8-SCULPT-PERF B-u (S8-U1a fix9): BU-T01 (pack accepts and refuses exactly what build does, with the same reason and
// message, on a table of 36 requests) and the packed-number contract of pack (each number is the request's double, or the
// documented difference of two, rounded to float32 once; the crossing bit is |dy| > 1e-9 in doubles), computed here from the
// request. INS-1/INS-2 (replacing B-T1/B-T2, whose temporary preflight program is gone): the install step compiles exactly
// the sources the next frame builds, once, in the renderer's own cache, takes a program the renderer already linked from
// those sources in this live context, and leaves nothing behind after a compile or link failure.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const masks=require('../worklist-v0/hpacs-lite/volume-vr-masks.js');
const vr=require('../worklist-v0/hpacs-lite/volume-vr-voi.js');
const sculpt=require('../worklist-v0/hpacs-lite/volume-sculpt.js');

const REPLACEMENT_KEYS=['originalValue','replaceAll','replaceFirst','replacementValue','shaderType'];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const add=(a,b)=>a.map((x,i)=>x+b[i]),sub=(a,b)=>a.map((x,i)=>x-b[i]),mul=(a,s)=>a.map(x=>x*s);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>mul(a,1/Math.hypot(...a));
function rng(seed){let s=seed>>>0;return ()=>{s=s+0x6D2B79F5>>>0;let t=s;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}
// 8x8x8 grids with the anisotropic spacing of G-AX and the oblique IOPs of G-OB1 and G-OB2.
function grid(iop){
  const row=iop.slice(0,3),col=iop.slice(3,6),axes=[mul(row,.5),mul(col,.5),mul(cross(row,col),2.5)],origin=[-3,4,10];
  const world=([i,j,k])=>add(origin,add(mul(axes[0],i),add(mul(axes[1],j),mul(axes[2],k))));
  const extent=[0,7,0,7,0,7];
  return {world,extent,imageData:{getSpatialExtent:()=>extent.slice(),indexToWorld:index=>world(index)}};
}
const GRIDS=[grid([1,0,0,0,1,0]),grid([1,0,0,0,.8,.6]),grid([.8,.6,0,-.36,.48,.8])];
const refusedWith=(fn,key)=>{let error;try{fn();}catch(caught){error=caught;}assert.ok(error,'expected a refusal');assert.equal(error.kinVrReason,key,error.message);return error;};
function deepFreeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const key of Object.keys(value))deepFreeze(value[key]);}return value;}
const plain=value=>JSON.parse(JSON.stringify(value));

function randomOperation(random,kind){
  let region;
  if(kind==='Polygon'){
    const cx=.3+.4*random(),cy=.3+.4*random(),points=[];
    for(let m=0;m<9;m++){const a=2*Math.PI*m/9,r=(m%2?.12:.3)*(0.8+.4*random());points.push([Math.min(1,Math.max(0,cx+r*Math.cos(a))),Math.min(1,Math.max(0,cy+r*Math.sin(a)))]);}
    region=sculpt.makeRegion('Freehand Area',points,.002);
  }else{
    const x=[random(),random()].sort(),y=[random(),random()].sort();
    region=sculpt.makeRegion(kind,[[x[0]*.6,y[0]*.6],[.4+x[1]*.6,.4+y[1]*.6]],.002);
  }
  const projection={base:[random()*.4-.1,random()*.4-.1],axes:[0,1,2].map(()=>[random()*1.4-.7,random()*1.4-.7])};
  return sculpt.makeOperation(region,projection,random()<.5?'Inside':'Outside');
}
function oracle(g,crop,slab,operations,index){
  if(crop&&['i','j','k'].some((axis,a)=>index[a]<crop[axis][0]||index[a]>crop[axis][1]))return false;
  if(slab&&Math.abs(dot(sub(g.world(index),slab.center),slab.normal))>slab.thickness/2)return false;
  const pos=index.map((x,a)=>(x-g.extent[2*a])/(g.extent[2*a+1]-g.extent[2*a]));
  for(const o of operations){
    const q=[0,1].map(m=>o.projection.base[m]+o.projection.axes[0][m]*pos[0]+o.projection.axes[1][m]*pos[1]+o.projection.axes[2][m]*pos[2]);
    const inside=sculpt.contains(o.region,q);if(o.side==='Inside'?inside:!inside)return false;
  }
  return true;
}

test('MV-U1a-03 the combined voxel decision equals the voxel oracle for 50 seeded combinations, in either user order',()=>{
  const random=rng(20261002);let kept=0,hidden=0,withVoi=0,withSculpt=0,withCrop=0;
  for(let c=0;c<50;c++){
    const g=GRIDS[c%3],bound=vr.binding(g.imageData);
    const crop=random()<.5?null:Object.fromEntries(['i','j','k'].map(axis=>{const a=Math.floor(random()*8),b=Math.floor(random()*8);return [axis,[Math.min(a,b),Math.max(a,b)]];}));
    let slab=null;
    if(random()<.75){const center=g.world([random()*7,random()*7,random()*7]),normal=unit([random()-.5,random()-.5,random()-.5]);slab={center,normal,pivot:center,thickness:1+random()*12};}
    const operations=Array.from({length:Math.floor(random()*4)},()=>randomOperation(random,['Rectangle','Ellipse','Polygon'][Math.floor(random()*3)]));
    // The user can apply the VOI before or after the sculpt regions; the applied state and its decision are the same.
    const voiFirst=slab?vr.apply(vr.initial(),bound,{orientation:'Axial',slab}):vr.initial(),sculptFirst=[...operations];
    const voiAfter=slab?vr.apply(vr.initial(),bound,{orientation:'Axial',slab}):vr.initial();
    const request=(s,ops)=>({voi:s.voi?vr.shaderPlane(s.voi,bound):null,sculpt:ops,original:false,crop,extent:g.extent});
    const first=request(voiFirst,operations),second=request(voiAfter,sculptFirst);
    assert.deepEqual(plain(masks.build(first)),plain(masks.build(second)),'combination '+c);
    const used=slab?voiFirst.voi.slab:null;
    for(let i=0;i<8;i++)for(let j=0;j<8;j++)for(let k=0;k<8;k++){
      const index=[i,j,k],actual=masks.visible(first,index);
      assert.equal(actual,oracle(g,crop,used,operations,index),`combination ${c} voxel ${index}`);
      assert.equal(masks.visible(second,index),actual);
      actual?kept++:hidden++;
    }
    withVoi+=!!slab;withSculpt+=!!operations.length;withCrop+=!!crop;
  }
  // The seeded set exercises every tool and both outcomes.
  assert.ok(kept>1000&&hidden>1000,`${kept} kept / ${hidden} hidden`);assert.ok(withVoi>20&&withSculpt>20&&withCrop>15);
});

test('MV-U1a-03 Original View keeps every voxel inside the crop',()=>{
  const g=GRIDS[1],bound=vr.binding(g.imageData),s=vr.reset(vr.initial(),bound,'Sagittal'),thin=vr.apply(s,bound,{orientation:'Sagittal',slab:{...s.voi.slab,thickness:.5}});
  const op=randomOperation(rng(7),'Rectangle'),request={voi:vr.shaderPlane(thin.voi,bound),sculpt:[op],crop:{i:[1,6],j:[0,7],k:[0,7]},extent:g.extent};
  let masked=0;
  for(let i=0;i<8;i++)for(let j=0;j<8;j++)for(let k=0;k<8;k++){
    const index=[i,j,k],inCrop=i>=1&&i<=6;
    assert.equal(masks.visible({...request,original:true},index),inCrop);
    if(inCrop&&!masks.visible({...request,original:false},index))masked++;
  }
  assert.ok(masked>0,'the masks hide something when Original View is off');
});

test('MV-U1a-04 eight sculpt regions and a VOI make exactly one owned replacement; a ninth or an unknown mode makes none',()=>{
  const g=GRIDS[2],bound=vr.binding(g.imageData),random=rng(4),voi=vr.shaderPlane(vr.reset(vr.initial(),bound,'Axial').voi,bound);
  const operations=Array.from({length:8},(_,n)=>randomOperation(random,['Rectangle','Ellipse','Polygon'][n%3]));
  const replacement=masks.build({voi,sculpt:operations});
  assert.deepEqual(Object.keys(replacement).sort(),REPLACEMENT_KEYS,'a shader replacement only: no clipping planes');
  const accepted=sculpt.shaderReplacement([operations[0]]);
  for(const key of ['shaderType','replaceFirst','replaceAll','originalValue'])assert.equal(replacement[key],accepted[key],key);
  assert.equal(typeof replacement.replacementValue,'string');
  const pristine={OpenGL:{ShaderReplacements:[{shaderType:'Fragment',originalValue:'float jitter = 0.01 + 0.99*texture2D(jtexture, gl_FragCoord.xy/32.0).r;',replacementValue:'float jitter = 0.5;',replaceFirst:true,replaceAll:false}]},other:'kept'};
  const properties=masks.properties(pristine,replacement),list=properties.OpenGL.ShaderReplacements;
  assert.equal(list.filter(r=>masks.owned(r.replacementValue)).length,1);assert.deepEqual(list[0],pristine.OpenGL.ShaderReplacements[0]);assert.equal(properties.other,'kept');
  assert.equal(masks.ownedText(properties),replacement.replacementValue);assert.equal(masks.ownedText(pristine),null);
  assert.equal(masks.properties(pristine,null),pristine,'no mask returns the pristine properties themselves');
  assert.equal(masks.build({voi:null,sculpt:[]}),null);assert.equal(masks.build({voi,sculpt:operations,original:true}),null);
  // A sculpt-only request is exactly the accepted sculpt producer's replacement.
  for(let n=1;n<=8;n++)assert.deepEqual(masks.build({voi:null,sculpt:operations.slice(0,n)}),sculpt.shaderReplacement(operations.slice(0,n)));
  // Refusals before anything is produced.
  refusedWith(()=>masks.build({voi,sculpt:[...operations,operations[0]]}),'vr-limit');
  refusedWith(()=>masks.build({voi:{...voi,mode:'CutPlane'},sculpt:operations}),'vr-limit');
  refusedWith(()=>masks.build({voi:{...voi,mode:'MPR'},sculpt:[]}),'vr-limit');
  refusedWith(()=>masks.build({voi,sculpt:[{...operations[0],side:'Both'}]}),'vr-limit');
  refusedWith(()=>masks.build({voi,sculpt:[{...operations[0],region:{kind:'Polygon',points:[[0,0]],bounds:[0,0,0,0]}}]}),'vr-limit');
});

// The renderer as the pinned viewer exposes it to the install step: its program cache (getShaderCache(), the
// 'shaderPrograms' entries and their getters, getShaderProgram keyed by the three sources, readyShaderProgram compiling,
// linking and binding an entry), the GL calls it makes, and the program linked for the shown frame.
const sourceKey=(vertex,fragment,geometry)=>vertex+'\u0000'+fragment+'\u0000'+geometry;
function rendererCache({lost=false,compile=true,link=true}={}){
  const calls=[],handles=new Set(),programs={};
  const gl={isContextLost:()=>lost,isProgram:handle=>handles.has(handle),deleteProgram(handle){calls.push('deleteProgram');handles.delete(handle);},drawArrays(){calls.push('drawArrays');}};
  const entry=({vertex='vertex',fragment,geometry='',compiled=true,linked=true,context=gl,alive=true})=>{
    const state={compiled,linked,handle:compiled?{}:null};if(state.handle&&alive)handles.add(state.handle);
    const shader=text=>({getSource:()=>text,cleanup(){calls.push('deleteShader');}});
    return {state,getCompiled:()=>state.compiled,getLinked:()=>state.linked,getHandle:()=>state.handle,get:name=>({[name]:name==='context'?context:undefined}),
      getVertexShader:()=>shader(vertex),getFragmentShader:()=>shader(fragment),getGeometryShader:()=>shader(geometry),getMd5Hash:()=>sourceKey(vertex,fragment,geometry)};
  };
  const place=value=>{programs[value.getMd5Hash()]=value;return value;};
  const cache={get:name=>({[name]:name==='shaderPrograms'?programs:undefined}),
    getShaderProgram(vertex,fragment,geometry){calls.push('getShaderProgram');return programs[sourceKey(vertex,fragment,geometry)]||place(entry({vertex,fragment,geometry,compiled:false,linked:false}));},
    readyShaderProgram(program){
      calls.push('readyShaderProgram');
      if(!program.getCompiled()){
        calls.push('compileShader');if(!compile)return null;
        program.state.handle={};handles.add(program.state.handle);calls.push('linkProgram');if(!link)return null;
        program.state.compiled=program.state.linked=true;
      }
      calls.push('bind');return program;
    }};
  const windowGL={getContext:()=>gl,getShaderCache:()=>cache};
  return {gl,calls,entry,place,programs,windowGL};
}
function renderer(){
  const source=fs.readFileSync(path.join(__dirname,'..','worklist-v0','hpacs-lite','volume-mask-renderer.js'),'utf8'),context={window:{KinVolumeVrMasks:masks}};
  vm.runInNewContext(source,context);return context.window.KinVolumeMaskRenderer;
}
const shownTarget=(r,live,mapper={})=>({mapper,engine:{offscreenMultiRenderWindow:{getOpenGLRenderWindow:()=>({...r.windowGL,getViewNodeFor:()=>({get:()=>({tris:{getProgram:()=>live}})})})}}});

test('MV-U1a-04 the renderer install takes the one owned block of the properties in place of any earlier one, and refuses two',()=>{
  const preflight=renderer().preflight;
  const g=GRIDS[0],bound=vr.binding(g.imageData),random=rng(11),signature=sculpt.shaderReplacement([]).originalValue;
  const voiOnly=masks.build({voi:vr.shaderPlane(vr.reset(vr.initial(),bound,'Coronal').voi,bound),sculpt:[]});
  const combined=masks.build({voi:vr.shaderPlane(vr.reset(vr.initial(),bound,'Axial').voi,bound),sculpt:[randomOperation(random,'Polygon'),randomOperation(random,'Ellipse')]});
  const head='#version 300 es\nprecision highp float;\n',tail='\n  return vec4(1.0);\n}\n';
  for(const [label,linked,next,expected] of [
    ['first VOI block',head+signature+tail,voiOnly,head+voiOnly.replacementValue+tail],
    ['VOI block replaced by the combined block',head+voiOnly.replacementValue+tail,combined,head+combined.replacementValue+tail],
    ['combined block removed',head+combined.replacementValue+tail,null,head+signature+tail],
    ['fixed masks in place of a generated block',head+combined.replacementValue+tail,masks.REPLACEMENT,head+masks.REPLACEMENT.replacementValue+tail],
    ['fixed masks removed',head+masks.REPLACEMENT.replacementValue+tail,null,head+signature+tail]]){
    const r=rendererCache(),live=r.place(r.entry({fragment:linked}));
    preflight(shownTarget(r,live),masks.properties({},next));
    const built=Object.values(r.programs).filter(entry=>entry!==live).map(entry=>entry.getFragmentShader().getSource());
    assert.deepEqual(built,[expected],label);
  }
  // Two owned blocks are refused by the renderer, so the builder's single block is what keeps VOI and sculpt together.
  const r=rendererCache(),live=r.place(r.entry({fragment:signature}));
  assert.throws(()=>preflight(shownTarget(r,live),{OpenGL:{ShaderReplacements:[{...voiOnly},{...combined}]}}));
  assert.deepEqual(r.calls,[],'nothing is built for a refused pair');
});

test('INS-1 the install compiles the next frame\'s exact sources once in the renderer\'s own cache, or takes the program the renderer already linked from them in this live context',()=>{
  const preflight=renderer().preflight;
  const signature=sculpt.shaderReplacement([]).originalValue,head='#version 300 es\nprecision highp float;\n',tail='\n  return vec4(1.0);\n}\n';
  const shown=head+signature+tail,wanted=head+masks.TEXT+tail,compiles=calls=>calls.filter(name=>name==='compileShader').length;
  // The install never reads or writes the mapper: any access would throw here.
  const mapper=new Proxy({},{get(){throw Error('the install read the mapper');},set(){throw Error('the install wrote the mapper');}});
  function run(setup,options){
    const r=rendererCache(options),live=r.place(r.entry({fragment:shown}));setup(r);
    let error=null,compiled=null;try{compiled=preflight(shownTarget(r,live,mapper),masks.properties({},masks.REPLACEMENT));}catch(caught){error=caught;}
    assert.ok(!r.calls.includes('drawArrays'),'nothing is drawn');
    return {r,error,compiled};
  }
  // Hit: the renderer already compiled and linked these exact sources in this context; nothing is built or bound.
  const hit=run(r=>{r.place(r.entry({fragment:wanted}));});
  assert.equal(hit.error,null);assert.equal(hit.compiled,false);assert.deepEqual(hit.r.calls,[]);
  // Misses: one compile and link through the cache, which then holds a linked entry of exactly the wanted sources, so a
  // second install (and the frame) find it without compiling again.
  for(const [label,setup] of [
    ['nothing cached for these sources',()=>{}],
    ['one fragment character differs',r=>{r.place(r.entry({fragment:wanted+' '}));}],
    ['vertex differs',r=>{r.place(r.entry({vertex:'vertex2',fragment:wanted}));}],
    ['geometry differs',r=>{r.place(r.entry({fragment:wanted,geometry:'g'}));}],
    ['another context',r=>{r.programs.other=r.entry({fragment:wanted,context:{}});}],
    ['not compiled',r=>{r.place(r.entry({fragment:wanted,compiled:false,linked:false}));}],
    ['restored context: the cached handle is gone',r=>{r.place(r.entry({fragment:wanted,alive:false}));}]]){
    const result=run(setup);assert.equal(result.error,null,label);assert.equal(result.compiled,true,label);assert.equal(compiles(result.r.calls),1,label);
    const linked=Object.values(result.r.programs).filter(entry=>entry.getLinked()&&entry.get('context').context===result.r.gl&&result.r.gl.isProgram(entry.getHandle())&&entry.getFragmentShader().getSource()===wanted&&entry.getVertexShader().getSource()==='vertex'&&entry.getGeometryShader().getSource()==='');
    assert.equal(linked.length,1,label);
    const again=result.r.calls.length;assert.equal(preflight(shownTarget(result.r,Object.values(result.r.programs)[0],mapper),masks.properties({},masks.REPLACEMENT)),false,label);
    assert.equal(compiles(result.r.calls.slice(again)),0,label+': the second install compiles nothing');
  }
  // A lost context is refused before anything is built.
  const lost=run(r=>{r.place(r.entry({fragment:wanted}));},{lost:true});
  assert.ok(lost.error);assert.deepEqual(lost.r.calls,[]);
});

test('INS-2 a compile or link failure at install is a refusal that leaves no cache entry, program or shader behind',()=>{
  const preflight=renderer().preflight,signature=sculpt.shaderReplacement([]).originalValue;
  const shown='#version 300 es\n'+signature+'\n  return vec4(1.0);\n}\n';
  for(const [label,options,built] of [['link',{link:false},true],['compile',{compile:false},false]]){
    // The same sources fail twice in a row: the first failure leaves nothing a second install could take as linked.
    const r=rendererCache(options),live=r.place(r.entry({fragment:shown})),keys=Object.keys(r.programs);
    for(let attempt=0;attempt<2;attempt++){
      const before=r.calls.length;
      assert.throws(()=>preflight(shownTarget(r,live),masks.properties({},masks.REPLACEMENT)),label);
      const calls=r.calls.slice(before);
      assert.deepEqual(Object.keys(r.programs),keys,label+': no entry is left for the failed sources');
      assert.ok(calls.includes('compileShader'),label+': each attempt checks again');assert.ok(!calls.includes('bind'),label);
      assert.equal(calls.filter(name=>name==='deleteProgram').length,built?1:0,label);
      assert.equal(calls.filter(name=>name==='deleteShader').length,3,label+': the entry\'s shaders are released');
    }
    assert.equal(r.gl.isProgram(live.getHandle()),true,label+': the shown program is untouched');
  }
});

// BU-T01: 36 requests; every refusal of build is a refusal of pack with the same reason key and message, every acceptance
// an acceptance.
function requestTable(){
  const g=GRIDS[0],bound=vr.binding(g.imageData),random=rng(31),op=randomOperation(random,'Rectangle'),poly=randomOperation(random,'Polygon');
  const slab=vr.shaderPlane(vr.reset(vr.initial(),bound,'Axial').voi,bound),nine=Array.from({length:9},()=>op);
  return [
    ['null',null],['string','x'],['number',3],['original "true"',{sculpt:[],original:'true'}],['original 1',{original:1}],['original null',{original:null}],
    ['original ""',{original:''}],['sculpt null',{sculpt:null}],['sculpt {}',{sculpt:{}}],['sculpt "a"',{sculpt:'a'}],['sculpt false',{sculpt:false}],
    ['sculpt [null]',{sculpt:[null]}],['side Up',{sculpt:[{...op,side:'Up'}]}],['op without region',{sculpt:[{side:'Inside'}]}],
    ['op with an invalid projection',{sculpt:[{...op,projection:{base:[0,0],axes:[[1,0],[2,0],[3,0]]}}]}],['9 operations',{sculpt:nine}],
    ['voi 0',{voi:0}],['voi false',{voi:false}],['voi ""',{voi:''}],['voi mode Plane',{voi:{...slab,mode:'Plane'}}],['voi axes of 2',{voi:{...slab,axes:[0,1]}}],
    ['voi half 0',{voi:{...slab,halfThickness:0}}],['voi base NaN',{voi:{...slab,base:NaN}}],['voi base "1"',{voi:{...slab,base:'1'}}],
    ['empty {}',{}],['sculpt []',{sculpt:[]}],['original true',{original:true}],['original false',{original:false}],['voi null',{voi:null}],['voi undefined',{voi:undefined}],
    ['one op',{sculpt:[op]}],['slab',{voi:slab}],['one op, Original View',{sculpt:[op],original:true}],['8 ops + slab',{sculpt:nine.slice(1),voi:slab}],
    ['polygon + slab',{sculpt:[poly],voi:slab}],['polygon, Original View, slab',{sculpt:[poly,op],voi:slab,original:true}]];
}
test('BU-T01 pack accepts and refuses exactly the requests build does, with the same reason and message, and changes no input',()=>{
  const table=requestTable();assert.ok(table.length>=30);let refused=0;
  for(const [name,value] of table){
    const before=JSON.stringify(value);
    const outcome=fn=>{try{fn();return {accepted:true};}catch(error){return {accepted:false,reason:error.kinVrReason,message:error.message};}};
    const built=outcome(()=>masks.build(value)),packed=outcome(()=>masks.pack(value));
    assert.deepEqual(packed,built,name);assert.equal(JSON.stringify(value),before,name+': input unchanged');
    if(!built.accepted){refused++;assert.equal(built.reason,'vr-limit',name);}
  }
  assert.ok(refused>=20&&refused<table.length,'the table holds refusals and acceptances');
});

test('BU-T01 pack: every number is the request\'s double rounded to float32 once, Original View packs no mask, the crossing bit is |dy| > 1e-9',()=>{
  const f=Math.fround,random=rng(37),g=GRIDS[2],bound=vr.binding(g.imageData);
  const slab=vr.shaderPlane(vr.reset(vr.initial(),bound,'Sagittal').voi,bound);
  // Near-horizontal edges on both sides of the 1e-9 rule, as the R-001 fixture and the dy sweep have them.
  const fixture=sculpt.makeOperation({kind:'Polygon',points:[[0.1,2e-7],[0.9,2.009e-7],[0.9,0.8],[0,0.8],[0,0]],bounds:[0,0.9,0,0.8]},{base:[0,0],axes:[[1,0],[0,1],[0,0]]},'Inside');
  const sweep=dy=>sculpt.makeOperation({kind:'Polygon',points:[[0.1,2e-7],[0.9,2e-7+dy],[0.9,0.8],[0,0.8],[0,0]],bounds:[0,0.9,0,0.8]},{base:[0,0],axes:[[1,0],[0,1],[0,0]]},'Outside');
  // Rising edges whose dy is exactly the double given (from y = 0): 1.00000001e-9 is above 1e-9 in doubles but rounds below
  // it in float32, 1e-9 itself is not above it; the rule is the generator's, in doubles.
  const rise=dy=>sculpt.makeOperation({kind:'Polygon',points:[[0.1,0],[0.9,dy],[0.9,0.8],[0.1,0.8]],bounds:[0.1,0.9,0,0.8]},{base:[0,0],axes:[[1,0],[0,1],[0,0]]},'Inside');
  assert.ok(1.00000001e-9>1e-9&&f(1.00000001e-9)<1e-9,'the probe dy sits where doubles and float32 disagree');
  const ops=[fixture,sweep(9e-10),sweep(1.001e-9),randomOperation(random,'Ellipse'),randomOperation(random,'Rectangle'),randomOperation(random,'Polygon'),rise(1.00000001e-9),rise(1e-9)];
  const d=masks.pack({voi:slab,sculpt:ops});
  assert.equal(d.count,8);assert.deepEqual(Array.from(d.voi),[f(slab.axes[0]),f(slab.axes[1]),f(slab.axes[2]),f(slab.base)]);assert.deepEqual(Array.from(d.voiHalf),[f(slab.halfThickness),1]);
  let slot=0,crossings=0;
  ops.forEach((op,r)=>{
    const b=op.region.bounds,p=op.projection,kind={Polygon:0,Rectangle:1,Ellipse:2}[op.region.kind];
    assert.deepEqual(Array.from(d.proj.subarray(8*r,8*r+8)),[p.base[0],p.base[1],...p.axes.flat()].map(f),'projection '+r);
    assert.deepEqual(Array.from(d.box.subarray(4*r,4*r+4)),b.map(f),'bounds '+r);
    if(kind===2)assert.deepEqual(Array.from(d.ell.subarray(4*r,4*r+4)),[(b[0]+b[1])/2,(b[2]+b[3])/2,(b[1]-b[0])/2,(b[3]-b[2])/2].map(f),'ellipse '+r);
    const points=op.region.points||[];
    assert.deepEqual(Array.from(d.meta.subarray(4*r,4*r+4)),[kind,op.side==='Inside'?1:0,slot,points.length],'meta '+r);
    points.forEach((c,i)=>{
      const a=points[(i+points.length-1)%points.length],s=slot+i,dy=c[1]-a[1],bit=(d.cross[s>>5]>>(s&31))&1;
      assert.deepEqual(Array.from(d.edge.subarray(4*s,4*s+4)),[a[0],a[1],c[0]-a[0],dy].map(f),'edge '+s);
      assert.equal(bit,Math.abs(dy)>1e-9?1:0,'crossing '+s);crossings+=bit;
    });
    slot+=points.length;
  });
  assert.equal(d.edges,slot);assert.ok(crossings>0);
  // The fixture's near-horizontal edge has dy = 9.0e-10 in doubles: no crossing test, and its stored edge keeps that dy.
  assert.equal((d.cross[0]>>1)&1,0);assert.equal(d.edge[4*1+3],f(2.009e-7-2e-7));
  assert.equal((d.cross[(5+1)>>5]>>((5+1)&31))&1,0,'dy 9e-10 runs no crossing test');assert.equal((d.cross[(10+1)>>5]>>((10+1)&31))&1,1,'dy 1.001e-9 runs it');
  const riseSlot=k=>d.meta[4*k+2]+1,bit=s=>(d.cross[s>>5]>>(s&31))&1;
  assert.equal(bit(riseSlot(6)),1,'dy 1.00000001e-9 runs it (doubles), though its float32 is below 1e-9');assert.equal(bit(riseSlot(7)),0,'dy exactly 1e-9 does not');
  const hidden=masks.pack({voi:slab,sculpt:ops,original:true});
  assert.equal(hidden.count,0);assert.deepEqual(Array.from(hidden.voiHalf),[0,0]);assert.deepEqual(Array.from(hidden.voi),[0,0,0,0]);
  const none=masks.pack({});assert.equal(none.count,0);assert.equal(none.edges,0);assert.deepEqual(Array.from(none.voiHalf),[0,0]);
});

test('MV-U1a-05 the builder and the voxel decision leave deeply frozen inputs unchanged',()=>{
  const g=GRIDS[1],bound=vr.binding(g.imageData),random=rng(5);
  const operations=deepFreeze(Array.from({length:3},(_,n)=>plain(randomOperation(random,['Polygon','Rectangle','Ellipse'][n]))));
  const voi=deepFreeze(plain(vr.shaderPlane(vr.reset(vr.initial(),bound,'Coronal').voi,bound)));
  const request=deepFreeze({voi,sculpt:operations,original:false,crop:{i:[0,6],j:[1,7],k:[0,7]},extent:[0,7,0,7,0,7]}),before=plain(request);
  const replacement=masks.build(request);masks.visible(request,deepFreeze([3,4,5]));
  const pristine=deepFreeze({OpenGL:{ShaderReplacements:[]},keep:1}),properties=masks.properties(pristine,replacement);
  assert.deepEqual(plain(request),before);assert.deepEqual(plain(pristine),{OpenGL:{ShaderReplacements:[]},keep:1});
  // The replacement placed in the properties is a fresh, writable object (renderer wrappers may append to it).
  const placed=properties.OpenGL.ShaderReplacements.at(-1);assert.ok(!Object.isFrozen(placed));assert.notEqual(placed,replacement);
});

test('MV-U1a-07 forged numbers and shapes are refused, never coerced into the replacement',()=>{
  const g=GRIDS[0],bound=vr.binding(g.imageData),voi=vr.shaderPlane(vr.reset(vr.initial(),bound,'Axial').voi,bound),op=randomOperation(rng(9),'Rectangle');
  const forged=['1','0;discard',NaN,Infinity,-Infinity,{valueOf:()=>1},[1],null,true,1e7];
  for(const value of forged){
    refusedWith(()=>masks.build({voi:{...voi,base:value},sculpt:[]}),'vr-limit');
    refusedWith(()=>masks.build({voi:{...voi,halfThickness:value},sculpt:[]}),'vr-limit');
    refusedWith(()=>masks.build({voi:{...voi,axes:[value,0,0]},sculpt:[]}),'vr-limit');
    refusedWith(()=>masks.build({voi:null,sculpt:[{...op,projection:{...op.projection,base:[value,0]}}]}),'vr-limit');
    refusedWith(()=>masks.visible({voi:null,sculpt:[],crop:{i:[value,7],j:[0,7],k:[0,7]},extent:g.extent},[1,1,1]),'vr-limit');
  }
  for(const value of ['x',{},[voi],0,'Slab'])refusedWith(()=>masks.build({voi:value,sculpt:[]}),'vr-limit');
  for(const value of ['ops',{length:1},null])refusedWith(()=>masks.build({voi:null,sculpt:value}),'vr-limit');
  refusedWith(()=>masks.build({voi:{...voi,axes:[0,0]},sculpt:[]}),'vr-limit');refusedWith(()=>masks.build({voi,sculpt:[],original:'false'}),'vr-limit');
  refusedWith(()=>masks.build(null),'vr-limit');refusedWith(()=>masks.properties(null,null),'vr-limit');
});
