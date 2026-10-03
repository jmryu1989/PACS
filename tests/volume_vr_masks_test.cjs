// TEST-S8-U1a-MODEL (MV-U1a-03, 04, 05, 07): the combined VOI + sculpt mask builder.
// The voxel oracle below is this file's own: crop index ranges, a world dot product for the slab and the accepted sculpt
// region test on its own projection of the voxel. Shader text is never read; the replacement is compared with the accepted
// sculpt producer's output and passed through the renderer preflight with a recording GL.
// B-T1/B-T2 (test-plan MAX-I, S8-U1a-SPEC-C-F04): when the preflight may take the renderer's own linked program instead of
// building a second copy, and that every other case still runs the full compile and link check, changes no cache entry and
// keeps a failure a refusal.
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

test('MV-U1a-04 the renderer preflight takes the combined block as its one owned block and replaces an earlier one',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','worklist-v0','hpacs-lite','volume-mask-renderer.js'),'utf8'),context={window:{}};
  vm.runInNewContext(source,context);const preflight=context.window.KinVolumeMaskRenderer.preflight;
  const g=GRIDS[0],bound=vr.binding(g.imageData),random=rng(11),signature=sculpt.shaderReplacement([]).originalValue;
  const voiOnly=masks.build({voi:vr.shaderPlane(vr.reset(vr.initial(),bound,'Coronal').voi,bound),sculpt:[]});
  const combined=masks.build({voi:vr.shaderPlane(vr.reset(vr.initial(),bound,'Axial').voi,bound),sculpt:[randomOperation(random,'Polygon'),randomOperation(random,'Ellipse')]});
  const head='#version 300 es\nprecision highp float;\n',tail='\n  return vec4(1.0);\n}\n';
  for(const [label,linked,next,expected] of [
    ['first VOI block',head+signature+tail,voiOnly,head+voiOnly.replacementValue+tail],
    ['VOI block replaced by the combined block',head+voiOnly.replacementValue+tail,combined,head+combined.replacementValue+tail],
    ['combined block removed',head+combined.replacementValue+tail,null,head+signature+tail]]){
    const compiled=[];
    const gl={VERTEX_SHADER:1,FRAGMENT_SHADER:2,COMPILE_STATUS:3,LINK_STATUS:4,createShader:type=>({type}),shaderSource:(shader,text)=>{shader.text=text;},compileShader:shader=>compiled.push(shader),getShaderParameter:()=>true,createProgram:()=>({}),attachShader(){},linkProgram(){},getProgramParameter:()=>true,deleteProgram(){},deleteShader(){}};
    const program={getCompiled:()=>true,getLinked:()=>true,getVertexShader:()=>({getSource:()=>'vertex'}),getFragmentShader:()=>({getSource:()=>linked})};
    const op={mapper:{},engine:{offscreenMultiRenderWindow:{getOpenGLRenderWindow:()=>({getContext:()=>gl,getViewNodeFor:()=>({get:()=>({tris:{getProgram:()=>program}})})})}}};
    preflight(op,masks.properties({},next));
    assert.equal(compiled.find(shader=>shader.type===2).text,expected,label);
  }
  // Two owned blocks are refused by the renderer, so the builder's single block is what keeps VOI and sculpt together.
  const doubled={OpenGL:{ShaderReplacements:[{...voiOnly},{...combined}]}};
  const gl={VERTEX_SHADER:1,FRAGMENT_SHADER:2,createShader:()=>({}),shaderSource(){},compileShader(){},getShaderParameter:()=>true,createProgram:()=>({}),attachShader(){},linkProgram(){},getProgramParameter:()=>true,deleteProgram(){},deleteShader(){}};
  const program={getCompiled:()=>true,getLinked:()=>true,getVertexShader:()=>({getSource:()=>'v'}),getFragmentShader:()=>({getSource:()=>signature})};
  assert.throws(()=>preflight({mapper:{},engine:{offscreenMultiRenderWindow:{getOpenGLRenderWindow:()=>({getContext:()=>gl,getViewNodeFor:()=>({get:()=>({tris:{getProgram:()=>program}})})})}}},doubled));
});

// The renderer as the pinned viewer exposes it to the preflight: a GL that records every call, the renderer's program cache
// (getShaderCache(), its 'shaderPrograms' entries and their getters) and the program linked for the shown frame.
function rendererCache({lost=false,compile=true,link=true}={}){
  const calls=[],handles=new Set();
  const gl={VERTEX_SHADER:1,FRAGMENT_SHADER:2,COMPILE_STATUS:3,LINK_STATUS:4,isContextLost:()=>lost,isProgram:handle=>handles.has(handle)};
  const answers={createShader:type=>lost?null:{type},createProgram:()=>lost?null:{},getShaderParameter:()=>compile,getProgramParameter:()=>link};
  for(const name of ['createShader','shaderSource','compileShader','getShaderParameter','createProgram','attachShader','linkProgram','getProgramParameter','deleteProgram','deleteShader','useProgram','drawArrays'])
    gl[name]=(...args)=>{calls.push(name);return answers[name]?.(...args);};
  const entry=({vertex='vertex',fragment,geometry='',compiled=true,linked=true,context=gl,alive=true})=>{
    const handle={};if(alive)handles.add(handle);
    return {getCompiled:()=>compiled,getLinked:()=>linked,getHandle:()=>handle,get:name=>({[name]:name==='context'?context:undefined}),
      getVertexShader:()=>({getSource:()=>vertex}),getFragmentShader:()=>({getSource:()=>fragment}),getGeometryShader:()=>({getSource:()=>geometry})};
  };
  const programs={};
  const windowGL={getContext:()=>gl,getShaderCache:()=>({get:name=>({[name]:name==='shaderPrograms'?programs:undefined})})};
  return {gl,calls,entry,programs,windowGL};
}

test('B-T1 the preflight takes only the renderer\'s own linked program of exactly these sources in this live context; any other case runs the full check',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','worklist-v0','hpacs-lite','volume-mask-renderer.js'),'utf8'),context={window:{}};
  vm.runInNewContext(source,context);
  const g=GRIDS[0],bound=vr.binding(g.imageData),random=rng(13),signature=sculpt.shaderReplacement([]).originalValue;
  const next=masks.build({voi:vr.shaderPlane(vr.reset(vr.initial(),bound,'Coronal').voi,bound),sculpt:[randomOperation(random,'Polygon'),randomOperation(random,'Rectangle')]});
  const head='#version 300 es\nprecision highp float;\n',tail='\n  return vec4(1.0);\n}\n',shown=head+signature+tail,wanted=head+next.replacementValue+tail;
  const building=['createShader','compileShader','createProgram','linkProgram','deleteProgram','deleteShader'];
  // The preflight never reads the mapper: any read of it would throw here.
  const mapper=new Proxy({},{get(){throw Error('the preflight read the mapper');},set(){throw Error('the preflight wrote the mapper');}});
  function run(setup,options){
    const r=rendererCache(options),live=r.entry({fragment:shown});r.programs.live=live;setup(r);
    const keys=Object.keys(r.programs),entries=keys.map(key=>r.programs[key]);
    const op={mapper,engine:{offscreenMultiRenderWindow:{getOpenGLRenderWindow:()=>({...r.windowGL,getViewNodeFor:()=>({get:()=>({tris:{getProgram:()=>live}})})})}}};
    let error=null;try{context.window.KinVolumeMaskRenderer.preflight(op,masks.properties({},next));}catch(caught){error=caught;}
    // Nothing is inserted, replaced or released in the renderer's cache, and no program is bound, whatever happened.
    assert.deepEqual(Object.keys(r.programs),keys);assert.ok(keys.every((key,n)=>r.programs[key]===entries[n]));
    assert.ok(!r.calls.includes('useProgram')&&!r.calls.includes('drawArrays'));
    return {error,calls:r.calls};
  }
  const full=calls=>{for(const name of ['createShader','compileShader','createProgram','linkProgram'])assert.ok(calls.includes(name),name);
    assert.equal(calls.filter(name=>name==='deleteProgram').length,1,'the checked candidate is deleted');assert.equal(calls.filter(name=>name==='deleteShader').length,2);};
  // Hit: the renderer already compiled and linked these exact sources in this context.
  const hit=run(r=>{r.programs.wanted=r.entry({fragment:wanted});});
  assert.equal(hit.error,null);assert.deepEqual(hit.calls.filter(name=>building.includes(name)),[],'no second copy is built');
  // Misses, each with the full check and its normal acceptance.
  for(const [label,setup] of [
    ['nothing cached for these sources',()=>{}],
    ['one fragment character differs',r=>{r.programs.near=r.entry({fragment:wanted+' '});}],
    ['vertex differs',r=>{r.programs.near=r.entry({vertex:'vertex2',fragment:wanted});}],
    ['geometry differs',r=>{r.programs.near=r.entry({fragment:wanted,geometry:'g'});}],
    ['another context',r=>{r.programs.other=r.entry({fragment:wanted,context:{}});}],
    ['not compiled',r=>{r.programs.half=r.entry({fragment:wanted,compiled:false});}],
    ['not linked',r=>{r.programs.half=r.entry({fragment:wanted,linked:false});}],
    ['restored context: the cached handle is gone',r=>{r.programs.stale=r.entry({fragment:wanted,alive:false});}]]){
    const result=run(setup);assert.equal(result.error,null,label);full(result.calls);
  }
  // A lost context never counts as a hit and the full check refuses.
  const lost=run(r=>{r.programs.wanted=r.entry({fragment:wanted});},{lost:true});
  assert.ok(lost.error);assert.ok(!lost.calls.includes('linkProgram'));
});

test('B-T2 a compile or link failure stays a refusal: the candidate is deleted and the renderer cache keeps no entry for it',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','worklist-v0','hpacs-lite','volume-mask-renderer.js'),'utf8'),context={window:{}};
  vm.runInNewContext(source,context);
  const g=GRIDS[1],bound=vr.binding(g.imageData),random=rng(17),signature=sculpt.shaderReplacement([]).originalValue;
  const next=masks.build({voi:vr.shaderPlane(vr.reset(vr.initial(),bound,'Axial').voi,bound),sculpt:[randomOperation(random,'Ellipse')]});
  const shown='#version 300 es\n'+signature+'\n  return vec4(1.0);\n}\n';
  for(const [label,options,built] of [['link',{link:false},true],['compile',{compile:false},false]]){
    // The same sources fail twice in a row: the first failure leaves nothing a second preflight could take as linked.
    const r=rendererCache(options),live=r.entry({fragment:shown});r.programs.live=live;const keys=Object.keys(r.programs);
    const op={mapper:{},engine:{offscreenMultiRenderWindow:{getOpenGLRenderWindow:()=>({...r.windowGL,getViewNodeFor:()=>({get:()=>({tris:{getProgram:()=>live}})})})}}};
    for(let attempt=0;attempt<2;attempt++){
      const before=r.calls.length;
      assert.throws(()=>context.window.KinVolumeMaskRenderer.preflight(op,masks.properties({},next)),label);
      const calls=r.calls.slice(before);
      assert.deepEqual(Object.keys(r.programs),keys,label);assert.ok(!calls.includes('useProgram'),label);
      assert.equal(calls.filter(name=>name==='deleteProgram').length,built?1:0,label);
      assert.equal(calls.filter(name=>name==='deleteShader').length,calls.filter(name=>name==='createShader').length,label+': every created shader is deleted');
      assert.ok(calls.includes('compileShader'),label+': the second attempt checks again');
    }
  }
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
