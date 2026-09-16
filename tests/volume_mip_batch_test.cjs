// TEST-MIP-BATCH (A11-BATCH-1 P3): the MIP Viewer Batch model over the real volume-mip.js request rules. Expected cameras are
// hard-coded vectors (RC-4), never values computed by the module under test.
const {test}=require('node:test'),assert=require('node:assert/strict');
globalThis.KinVolumeMip=require('../worklist-v0/hpacs-lite/volume-mip.js');
// Mutation runs load a changed copy; the default is always the product model.
const batch=require(process.env.KIN_MIP_BATCH_MODEL_SOURCE||'../worklist-v0/hpacs-lite/volume-mip-batch.js');
const mip=globalThis.KinVolumeMip;
const near=(actual,want,tolerance,label)=>{assert.equal(actual.length,want.length,label);actual.forEach((n,i)=>assert.ok(Math.abs(n-want[i])<=tolerance,label+'['+i+'] '+n+' != '+want[i]));};
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const recipe=(over={})=>({schema:1,algorithm:'kin-mip-batch-1',axis:'Horizontal',interval:90,count:4,reverse:false,...over});
// The design review's coronal example: n0 along +P and viewUp along +S, at a camera distance of 120 mm from the box centre.
const CORONAL=Object.freeze({normal:[0,1,0],viewUp:[0,0,1],focalPoint:[15.75,15.75,40],distance:120,thickness:91.6});
const planOf=over=>batch.plan({...CORONAL,recipe:recipe(over)});

test('frame 0 is the Final direction bit for bit, and every frame carries its focal point, position and parallel scale',()=>{
 for(const over of [{},{axis:'Vertical'},{reverse:true},{axis:'Vertical',reverse:true,interval:45,count:3}]){
  const plan=planOf(over),first=plan.cameras[0];
  assert.ok(Object.is(first.angle,0),'frame 0 has no signed zero angle');
  assert.ok(first.viewPlaneNormal.every((n,i)=>Object.is(n,CORONAL.normal[i])),JSON.stringify(over));assert.ok(first.viewUp.every((n,i)=>Object.is(n,CORONAL.viewUp[i])));
  assert.equal(plan.size,512);assert.equal(plan.parallelScale,45.8);assert.equal(plan.distance,120);
  plan.cameras.forEach((camera,i)=>{
   assert.equal(camera.index,i);assert.deepEqual([...camera.focalPoint],CORONAL.focalPoint);assert.equal(camera.parallelScale,45.8);
   near(camera.position,CORONAL.focalPoint.map((x,k)=>x+camera.viewPlaneNormal[k]*120),1e-12,'position '+i);
   assert.ok(Math.abs(Math.hypot(...camera.position.map((x,k)=>x-camera.focalPoint[k]))-120)<=1e-9,'distance '+i);
   assert.ok(Math.abs(Math.hypot(...camera.viewPlaneNormal)-1)<=1e-12&&Math.abs(Math.hypot(...camera.viewUp)-1)<=1e-12,'unit '+i);
   assert.ok(Math.abs(camera.viewPlaneNormal.reduce((s,n,k)=>s+n*camera.viewUp[k],0))<=1e-12,'orthogonal '+i);
  });
 }
});

test('Horizontal turns about viewUp and Vertical about the screen right u0 x n0, right-handed, Reverse negating (hard-coded vectors)',()=>{
 const H=planOf({interval:90,count:4}),HR=planOf({interval:90,count:3,reverse:true});
 assert.deepEqual(H.cameras.map(c=>c.angle),[0,90,180,270]);assert.deepEqual(HR.cameras.map(c=>c.angle),[0,-90,-180]);
 near(H.cameras[1].viewPlaneNormal,[-1,0,0],1e-12,'H +90 n');near(H.cameras[2].viewPlaneNormal,[0,-1,0],1e-12,'H +180 n');near(H.cameras[3].viewPlaneNormal,[1,0,0],1e-12,'H +270 n');
 near(HR.cameras[1].viewPlaneNormal,[1,0,0],1e-12,'H -90 n');near(HR.cameras[2].viewPlaneNormal,[0,-1,0],1e-12,'H -180 n');
 for(const camera of [...H.cameras,...HR.cameras])assert.ok(camera.viewUp.every((n,i)=>Object.is(n,CORONAL.viewUp[i])),'Horizontal keeps viewUp bit for bit');
 assert.deepEqual([...H.axis],[0,0,1]);
 const V=planOf({axis:'Vertical',interval:90,count:3}),VR=planOf({axis:'Vertical',interval:90,count:3,reverse:true});
 near(V.cameras[1].viewPlaneNormal,[0,0,-1],1e-12,'V +90 n');near(V.cameras[1].viewUp,[0,1,0],1e-12,'V +90 u');
 near(V.cameras[2].viewPlaneNormal,[0,-1,0],1e-12,'V +180 n');near(V.cameras[2].viewUp,[0,0,-1],1e-12,'V +180 u');
 near(VR.cameras[1].viewPlaneNormal,[0,0,1],1e-12,'V -90 n');near(VR.cameras[1].viewUp,[0,-1,0],1e-12,'V -90 u');
 near([...V.axis],[-1,0,0],1e-12,'Vertical axis');
 for(const camera of [...V.cameras,...VR.cameras])near(cross(camera.viewUp,camera.viewPlaneNormal),[-1,0,0],1e-12,'Vertical keeps the screen right');
 // The pinned axial preset (n0 -S, viewUp -P). Horizontal +90 about viewUp: (0,-1,0) x (0,0,-1) = (1,0,0), the ray onto +L. Vertical
 // +90 about the screen right u0 x n0 = (1,0,0): (1,0,0) x (0,0,-1) = (0,1,0) for the normal and (1,0,0) x (0,-1,0) = (0,0,-1) for viewUp.
 const axial=over=>batch.plan({recipe:recipe({count:2,...over}),normal:[0,0,-1],viewUp:[0,-1,0],focalPoint:[0,0,0],distance:100,thickness:10});
 near(axial({}).cameras[1].viewPlaneNormal,[1,0,0],1e-12,'axial H +90');near([...axial({axis:'Vertical'}).axis],[1,0,0],1e-12,'axial screen right');
 near(axial({axis:'Vertical'}).cameras[1].viewPlaneNormal,[0,1,0],1e-12,'axial V +90 n');near(axial({axis:'Vertical'}).cameras[1].viewUp,[0,0,-1],1e-12,'axial V +90 u');
 near(batch.rotate([1,0,0],[0,0,1],90),[0,1,0],1e-12,'rotate is right-handed');
 // A long series stays unit and orthogonal.
 for(const camera of [...planOf({interval:5.625,count:64}).cameras,...planOf({axis:'Vertical',interval:5.625,count:64,reverse:true}).cameras]){
  assert.ok(Math.abs(Math.hypot(...camera.viewPlaneNormal)-1)<=1e-12&&Math.abs(Math.hypot(...camera.viewUp)-1)<=1e-12);
  assert.ok(Math.abs(camera.viewPlaneNormal.reduce((s,n,k)=>s+n*camera.viewUp[k],0))<=1e-12);
 }
});

test('the camera must stand outside the whole-volume slab, and a frame is accepted only for its complete analytic camera',()=>{
 const t=CORONAL.thickness,plan=over=>batch.plan({...CORONAL,recipe:recipe(),...over});
 for(const distance of [t/2,t/4,0,-120,NaN,Infinity,'120'])assert.throws(()=>plan({distance}),{message:batch.messages.distance},String(distance));
 assert.equal(plan({distance:t/2+2e-6}).distance,t/2+2e-6);
 for(const bad of [{normal:[0,1.01,0]},{viewUp:[0,1,0]},{viewUp:[0,.001,1]},{focalPoint:[0,0]},{focalPoint:[0,NaN,0]},{thickness:0},{thickness:NaN}])
  assert.throws(()=>plan(bad),{message:batch.messages.camera},JSON.stringify(bad));
 const want=planOf({}).cameras[1],clone=()=>JSON.parse(JSON.stringify(want));
 assert.equal(batch.verifyCamera(clone(),want),'');
 const within=clone();within.position[0]+=5e-7;within.parallelScale-=5e-7;within.viewUp[1]+=5e-7;assert.equal(batch.verifyCamera(within,want),'');
 for(const [label,change] of [['position 2e-6',c=>{c.position[0]+=2e-6;}],['camera at thickness/4',c=>{c.position=c.focalPoint.map((x,k)=>x+c.viewPlaneNormal[k]*t/4);}],
   ['focal point',c=>{c.focalPoint[2]+=2e-6;}],['normal',c=>{c.viewPlaneNormal[1]+=2e-6;}],['viewUp',c=>{c.viewUp[0]+=2e-6;}],['parallel scale',c=>{c.parallelScale+=2e-6;}],
   ['missing position',c=>{delete c.position;}],['short vector',c=>{c.viewUp=[0,0];}]]){
  const c=clone();change(c);assert.equal(batch.verifyCamera(c,want),batch.messages.frameCamera,label);
 }
 assert.equal(batch.verifyCamera(null,want),batch.messages.frameCamera);
});

test('recipe limits: interval 1..180, count 2..64, span at most 360 (1e-9), exact keys; refusals are never clamped',()=>{
 for(const over of [{interval:1,count:64},{interval:180,count:2},{interval:10,count:37},{interval:90,count:5},{interval:180,count:3},{interval:12.5,count:5},
   {interval:(360+5e-10)/36,count:37},{axis:'Vertical',reverse:true}]){
  assert.deepEqual(batch.validate(recipe(over)),recipe(over),JSON.stringify(over));
  const made=batch.recipe({axis:recipe(over).axis,interval:recipe(over).interval,count:recipe(over).count,reverse:recipe(over).reverse});
  assert.deepEqual(Object.keys(made),['schema','algorithm','axis','interval','count','reverse']);assert.ok(Object.isFrozen(made));assert.deepEqual(made,recipe(over));
 }
 for(const over of [{interval:.999},{interval:180.0001,count:2},{interval:0},{interval:-90},{interval:NaN},{interval:Infinity},{interval:'90'},{count:1},{count:65},{count:2.5},{count:'4'},
   {interval:19,count:20},{interval:10,count:38},{interval:(360+5e-9)/36,count:37}]){
  assert.throws(()=>batch.validate(recipe(over)),{message:batch.messages.shape},JSON.stringify(over));
  assert.throws(()=>batch.recipe(recipe(over)),{message:batch.messages.limits},JSON.stringify(over));
 }
 for(const [label,value,message] of [['extra key',{...recipe(),frames:[]},batch.messages.shape],['missing reverse',(({reverse,...rest})=>rest)(recipe()),batch.messages.shape],
   ['axis Oblique',recipe({axis:'Oblique'}),batch.messages.shape],['reverse text',recipe({reverse:'false'}),batch.messages.shape],
   ['schema 2',recipe({schema:2}),batch.messages.reproduce],['algorithm kin-mip-batch-2',recipe({algorithm:'kin-mip-batch-2'}),batch.messages.reproduce],
   ['null',null,batch.messages.reproduce],['array',[recipe()],batch.messages.reproduce]])
  assert.throws(()=>batch.validate(value),{message},label);
 assert.throws(()=>batch.recipe({...recipe(),axis:'Oblique'}),{message:batch.messages.axis});assert.throws(()=>batch.recipe({...recipe(),reverse:undefined}),{message:batch.messages.limits});
 assert.equal(batch.problem(recipe()),'');assert.equal(batch.problem(recipe({algorithm:'x'})),'reproduce');assert.equal(batch.problem(recipe({count:1})),'shape');
 // The largest series fits the 64 MiB raw frame budget exactly; the defaults are the documented product choices.
 assert.equal(64*512*512*4,batch.rawBytes);assert.equal(batch.plan({...CORONAL,recipe:recipe({interval:1,count:64})}).cameras.length,64);
 assert.deepEqual({...batch.defaults},{axis:'Horizontal',interval:10,count:36,reverse:false});assert.equal(batch.blobBytes,32*1024*1024);
});

test('restore regeneration budget is min(count x 15 s, 300 s) and each frame waits min(15 s, remaining)',()=>{
 assert.deepEqual([2,20,21,64].map(count=>batch.budget(count)),[30000,300000,300000,300000]);
 for(const bad of [1,65,2.5,'4',NaN])assert.throws(()=>batch.budget(bad),{message:batch.messages.limits},String(bad));
 assert.equal(batch.frameTimeout(Infinity),15000);assert.equal(batch.frameTimeout(60000),15000);assert.equal(batch.frameTimeout(4000),4000);
 assert.equal(batch.frameTimeout(-5),0);assert.equal(batch.frameTimeout(NaN),0);
});

test('Make gate precedence: generating, restoring, saving, busy, then the confirmed Final display, then Original',()=>{
 const final={mode:'MIP',orientation:'Axial'},snapshot={applied:final,final,state:'final'};
 const gate=over=>batch.makeGate({snapshot,same:mip.sameRequest,...over});
 assert.equal(gate({}),'');assert.equal(batch.makeGate({snapshot}),'','KinVolumeMip.sameRequest is the default comparator');
 assert.equal(gate({generating:true,restoring:true,saving:true,busy:true,snapshot:null}),batch.messages.generating);
 assert.equal(gate({restoring:true,saving:true,busy:true,snapshot:null}),batch.messages.restoring);
 assert.equal(gate({saving:true,busy:true,snapshot:null}),batch.messages.saving);
 assert.equal(gate({saving:true}),batch.messages.saving,'a confirmed Final display is still refused while its save runs');
 assert.equal(gate({busy:true}),batch.messages.busy);
 assert.equal(gate({snapshot:{...snapshot,state:'pending'}}),batch.messages.rendering);assert.equal(gate({snapshot:null}),batch.messages.rendering);
 assert.equal(gate({snapshot:{applied:{mode:'MinIP',orientation:'Axial'},final,state:'final'}}),batch.messages.rendering,'a newer applied request is not Final');
 assert.equal(gate({same:()=>{throw Error('comparator');}}),batch.messages.rendering);
 const affine=mip.affine(i=>[i[0]*.5,i[1]*.5,i[2]*2.5]),slab=mip.normalizeVoi({volumeId:'volume-1',affine,center:[1,2,3],normal:[0,0,1],pivot:[1,2,3],thickness:4});
 const original={mode:'MIP',orientation:'Axial',voiSlab:slab,original:true,history:[]};
 assert.equal(gate({snapshot:{applied:original,final:original,state:'final'}}),batch.messages.original);
 assert.equal(gate({snapshot:{applied:{...original,original:false},final:{...original,original:false},state:'final'}}),'');
});

test('preview ownership: one generation at a time, atomic swap, failure keeps the previous preview, any other display clears it',()=>{
 const revoked=[],store=batch.createPreview({revoke:url=>revoked.push(url)});
 const block={schema:1,algorithm:'kin-mip-1',coordinates:'LPS_mm',frameOfReference:'2.25.6',mode:'Raysum',orientation:'Coronal',display:{voiRange:{lower:-1,upper:1},interpolationType:0},voiSlab:null};
 const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort((a,b)=>a.length-b.length||(a<b?-1:a>b?1:0)).map(k=>[k,reorder(v[k])])):v;
 const A=batch.key(block),B=batch.key({...block,mode:'MIP'});
 assert.equal(batch.key(reorder(JSON.parse(JSON.stringify(block)))),A,'the key of a block read back in jsonb key order');assert.notEqual(A,B);
 assert.throws(()=>batch.key(null));assert.throws(()=>batch.key([block]));
 const output=(key,urls)=>({key,recipe:recipe(),frames:urls.map(url=>({url}))});
 assert.equal(store.current({state:'final',key:A}),null);assert.equal(store.begin(''),null);
 let ticket=store.begin(A);assert.ok(ticket);assert.equal(store.begin(A),null,'one generation at a time');assert.equal(store.generating(),true);
 const first=output(A,['a1','a2']);assert.equal(store.succeed(ticket,first),true);assert.equal(store.generating(),false);assert.deepEqual(revoked,[]);
 assert.equal(store.current({state:'final',key:A}),first);
 // While a generation runs the previous preview is owned but unavailable; a failure or cancel leaves it exactly as it was.
 ticket=store.begin(A);assert.equal(store.current({state:'final',key:A}),null);assert.equal(store.peek(),first);
 assert.equal(store.fail(ticket),true);assert.equal(store.current({state:'final',key:A}),first);assert.deepEqual(revoked,[]);
 // Success swaps in one step and only then revokes the frames it replaced.
 ticket=store.begin(A);const second=output(A,['b1','b2','b3']);assert.equal(store.succeed(ticket,second),true);assert.equal(store.current({state:'final',key:A}),second);assert.deepEqual(revoked,['a1','a2']);
 // A late ticket or a series made for another display is dropped, never shown.
 assert.equal(store.succeed(ticket,output(A,['late'])),false);assert.deepEqual(revoked.at(-1),'late');assert.equal(store.current({state:'final',key:A}),second);
 ticket=store.begin(A);assert.equal(store.succeed(ticket,output(B,['foreign'])),false);assert.deepEqual(revoked.at(-1),'foreign');assert.equal(store.peek(),second);
 assert.equal(store.fail(ticket),true);assert.equal(store.fail(ticket),false);
 // A pending display or another block clears the preview and revokes its frames.
 assert.equal(store.current({state:'pending',key:A}),null);assert.equal(store.peek(),null);assert.deepEqual(revoked.slice(-3),['b1','b2','b3']);
 ticket=store.begin(A);store.succeed(ticket,output(A,['c1']));assert.equal(store.current({state:'final',key:B}),null);assert.equal(store.peek(),null);assert.deepEqual(revoked.at(-1),'c1');
 // A clear during a generation (close, source or account loss) retires it: its success cannot bring frames back.
 ticket=store.begin(A);store.succeed(ticket,output(A,['d1']));ticket=store.begin(A);assert.equal(store.clear(),true);assert.deepEqual(revoked.at(-1),'d1');assert.equal(store.generating(),false);
 assert.equal(store.succeed(ticket,output(A,['e1'])),false);assert.equal(store.peek(),null);assert.deepEqual(revoked.at(-1),'e1');assert.equal(store.fail(ticket),false);assert.equal(store.clear(),false);
});

test('the preview caption names frame, display, axis with signed angle and the VOI Slab',()=>{
 assert.equal(batch.caption({index:1,count:4,mode:'Raysum',orientation:'Coronal',axis:'Horizontal',angle:90,voiThickness:14}),'2 / 4 · Raysum · Coronal · Horizontal +90° · VOI Slab 14 mm · Preview');
 assert.equal(batch.caption({index:0,count:3,mode:'MinIP',orientation:'Sagittal',axis:'Vertical',angle:0,voiThickness:null}),'1 / 3 · MinIP · Sagittal · Vertical 0° · VOI Slab Off · Preview');
 assert.equal(batch.caption({index:2,count:3,mode:'MIP',orientation:'Axial',axis:'Vertical',angle:-90,voiThickness:22.25}),'3 / 3 · MIP · Axial · Vertical -90° · VOI Slab 22.3 mm · Preview');
});

/* A11-ORIENT-1 V4: the same planner under the manual's anatomical presets. The frame-0 vectors and the +90 degree results are the
   accepted contract table, hand-computed from the right-handed Rodrigues rule, never values read back from this module. */
const ORIENT_ROWS=[
 ['Anterior',[0,-1,0],[0,0,1],[1,0,0],[0,0,1],[0,0,-1],[0,-1,0]],
 ['Posterior',[0,1,0],[0,0,1],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]],
 ['Left',[1,0,0],[0,0,1],[0,1,0],[0,0,1],[0,0,-1],[1,0,0]],
 ['Right',[-1,0,0],[0,0,1],[0,-1,0],[0,0,1],[0,0,-1],[-1,0,0]],
 ['Superior',[0,0,1],[0,-1,0],[-1,0,0],[0,-1,0],[0,1,0],[0,0,1]],
 ['Inferior',[0,0,-1],[0,1,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,-1]]];
test('A11-ORIENT-1: every anatomical preset turns about its own viewUp and screen right (hard-coded vectors)',()=>{
 const focalPoint=[15.75,15.75,40],distance=120,thickness=91.6;
 for(const [name,n0,u0,hNormal,hUp,vNormal,vUp] of ORIENT_ROWS){
  const horizontal=batch.plan({recipe:recipe({axis:'Horizontal',interval:90,count:2}),normal:n0,viewUp:u0,focalPoint,distance,thickness});
  near(horizontal.cameras[0].viewPlaneNormal,n0,0,name+' frame 0 normal');near(horizontal.cameras[0].viewUp,u0,0,name+' frame 0 up');
  near(horizontal.cameras[1].viewPlaneNormal,hNormal,1e-12,name+' Horizontal +90 normal');
  near(horizontal.cameras[1].viewUp,hUp,1e-12,name+' Horizontal +90 up');
  // Horizontal keeps its own axis, the Final viewUp, bit for bit.
  assert.deepEqual([...horizontal.cameras[1].viewUp],[...u0],name+' Horizontal keeps viewUp');
  const vertical=batch.plan({recipe:recipe({axis:'Vertical',interval:90,count:2}),normal:n0,viewUp:u0,focalPoint,distance,thickness});
  near(vertical.cameras[1].viewPlaneNormal,vNormal,1e-12,name+' Vertical +90 normal');
  near(vertical.cameras[1].viewUp,vUp,1e-12,name+' Vertical +90 up');
  // The rotation axis is the screen right of the Final camera, and every frame keeps the focal point and the parallel scale.
  near([...vertical.axis],cross(u0,n0).map(x=>x+0),1e-12,name+' Vertical axis is screen right');
  for(const camera of [...horizontal.cameras,...vertical.cameras]){
   near([...camera.focalPoint],focalPoint,0,name+' focal');assert.equal(camera.parallelScale,thickness/2);
   near([...camera.position],focalPoint.map((x,k)=>x+camera.viewPlaneNormal[k]*distance),1e-9,name+' position');
  }
 }
 // Reverse negates the same turn, and a preset frame 0 is the preset itself.
 const reversed=batch.plan({recipe:recipe({axis:'Horizontal',interval:90,count:2,reverse:true}),normal:[0,0,1],viewUp:[0,-1,0],focalPoint,distance,thickness});
 near(reversed.cameras[1].viewPlaneNormal,[1,0,0],1e-12,'Superior Horizontal -90 normal');
});
