const {test}=require('node:test'),assert=require('node:assert/strict');
// Mutation runs load a changed copy; the default is always the product model.
const model=require(process.env.KIN_MIP_MODEL_SOURCE||'../worklist-v0/hpacs-lite/volume-mip.js');
// The pinned native MPR_CAMERA_VALUES (ohif-bundle.js :20497).
const native={axial:{viewPlaneNormal:[0,0,-1],viewUp:[0,-1,0]},sagittal:{viewPlaneNormal:[1,0,0],viewUp:[0,0,1]},coronal:{viewPlaneNormal:[0,-1,0],viewUp:[0,0,1]}};
const dims=[64,64,33],spacing=[.5,.5,2.5];

test('each projection name maps to the MPR slab blend mode and Raysum is the mean, never additive',()=>{
 assert.deepEqual(model.modes,['MIP','MinIP','Raysum']);
 assert.deepEqual(model.modes.map(model.blendMode),[1,2,3]);
 for(const bad of ['Average','Sum','MPR',undefined])assert.throws(()=>model.blendMode(bad));
 assert.throws(()=>model.normalizeRequest({mode:'MIP',orientation:'Oblique'}));
});
test('orientation presets are the native MPR plane values, sign included',()=>{
 assert.deepEqual(model.orientations,['Axial','Coronal','Sagittal']);
 assert.deepEqual(model.preset(native,'Axial'),{key:'axial',viewPlaneNormal:[0,0,-1],viewUp:[0,-1,0]});
 assert.deepEqual(model.preset(native,'Coronal'),{key:'coronal',viewPlaneNormal:[0,-1,0],viewUp:[0,0,1]});
 assert.deepEqual(model.preset(native,'Sagittal'),{key:'sagittal',viewPlaneNormal:[1,0,0],viewUp:[0,0,1]});
 assert.throws(()=>model.preset(undefined,'Axial'),/방향 기준값/);
 assert.throws(()=>model.preset({...native,coronal:undefined},'Coronal'),/방향 기준값/);
 assert.throws(()=>model.preset({...native,axial:{viewPlaneNormal:[0,0,-1],viewUp:[0,0,1]}},'Axial'),/방향 기준값/);
});
test('whole-volume thickness is the Projection panel maximum and sampling is the pinned mapper interval',()=>{
 const total=model.projectionThickness(dims,spacing);
 assert.equal(total,Math.min(1000,Math.hypot(63*.5,63*.5,32*2.5)));assert.ok(Math.abs(total-91.6)<.05);
 assert.equal(model.projectionThickness([256,256,256],[5,5,5]),1000);
 assert.equal(model.sampleDistance(spacing),(0.5+0.5+2.5)/6);
 for(const [d,s] of [[[1,64,33],spacing],[dims,[.5,0,2.5]],[[64,64],spacing]])assert.throws(()=>model.projectionThickness(d,s));
});

const world=([i,j,k])=>[i*.5,j*.5,k*2.5];
const corners=model.corners(dims,world),center=[15.75,15.75,40];
function nativeState(orientation,{blend=1,total=model.projectionThickness(dims,spacing),middle=center,sample=model.sampleDistance(spacing)}={}){
 const p=native[orientation];return {actors:1,volumeId:'volume',blend,viewPlaneNormal:p.viewPlaneNormal,viewUp:p.viewUp,
  planes:[{origin:middle.map((n,i)=>n+p.viewPlaneNormal[i]*total/2),normal:p.viewPlaneNormal},{origin:middle.map((n,i)=>n-p.viewPlaneNormal[i]*total/2),normal:p.viewPlaneNormal.map(n=>-n)}],
  sampleDistance:sample,interpolationType:0,voiRange:{lower:300,upper:1830}};
}
const expected=(request)=>{const p=model.preset(native,request.orientation);return {volumeId:'volume',blend:model.blendMode(request.mode),viewPlaneNormal:p.viewPlaneNormal,viewUp:p.viewUp,thickness:model.projectionThickness(dims,spacing),corners,sampleDistance:model.sampleDistance(spacing),interpolationType:0,voiRange:{lower:300,upper:1830}};};

test('final state verification accepts only the requested plane, blend, whole-volume slab and final sampling',()=>{
 for(const mode of model.modes)for(const orientation of model.orientations){
  const key=orientation.toLowerCase();assert.equal(model.verifyState(nativeState(key,{blend:model.blendMode(mode)}),expected({mode,orientation})),'',mode+' '+orientation);
 }
 const want=expected({mode:'Raysum',orientation:'Sagittal'});
 assert.match(model.verifyState(nativeState('sagittal',{blend:2}),want),/투영 방식/);
 assert.match(model.verifyState(nativeState('sagittal',{blend:4}),want),/투영 방식/);
 assert.match(model.verifyState(nativeState('coronal',{blend:3}),want),/투영 방향/);
 assert.match(model.verifyState(nativeState('sagittal',{blend:3,total:20}),want),/두께/);
 assert.match(model.verifyState(nativeState('sagittal',{blend:3,sample:model.sampleDistance(spacing)*3}),want),/표본 간격/);
 assert.match(model.verifyState(nativeState('sagittal',{blend:3,middle:[60,15.75,40]}),want),/투영 범위/);
 const tilted=nativeState('sagittal',{blend:3});tilted.planes[1].normal=[0,1,0];assert.match(model.verifyState(tilted,want),/투영 평면/);
 assert.match(model.verifyState({...nativeState('sagittal',{blend:3}),actors:2},want),/원본 볼륨/);
 assert.match(model.verifyState({...nativeState('sagittal',{blend:3}),interpolationType:1},want),/보간/);
 assert.match(model.verifyState({...nativeState('sagittal',{blend:3}),voiRange:{lower:0,upper:1830}},want),/밝기/);
 // A capped slab that cannot contain the whole volume is refused rather than shown as whole-volume.
 const huge=[256,256,256],cap={...expected({mode:'MIP',orientation:'Axial'}),thickness:1000,corners:model.corners(huge,([i,j,k])=>[i*5,j*5,k*5])};
 const big=nativeState('axial',{total:1000,middle:[637.5,637.5,637.5]});assert.match(model.verifyState(big,cap),/투영 범위/);
});
test('the Raysum shader check requires the counted-sample average patch',()=>{
 assert.equal(model.averageShader('vec4 sum = vec4(0.); float kinAverageSamples = 0.0;\nsum += tValue; kinAverageSamples += 1.0;\nsum /= vec4(max(kinAverageSamples, 1.0), max(kinAverageSamples, 1.0), max(kinAverageSamples, 1.0), 1.0);'),true);
 assert.equal(model.averageShader('vec4 sum = vec4(0.);\nsum += tValue;\nsum /= vec4(stepsTraveled, stepsTraveled, stepsTraveled, 1.0);'),false);
 assert.equal(model.averageShader(undefined),false);
});

function harness({blocked=()=>'',applyFails=()=>null}={}){
 const log={applies:[],shows:[],fatal:[],confirms:[]};let closed=false;
 const sequence=model.createSequence({
  apply:request=>{log.applies.push(request.mode+'/'+request.orientation);const error=applyFails(request);if(error)throw error;},
  confirm:request=>new Promise((resolve,reject)=>log.confirms.push({request,resolve,reject})),
  blocked,closed:()=>closed,show:state=>log.shows.push(state),fatal:error=>log.fatal.push(error.message),describe:r=>r.mode+' · '+r.orientation});
 const flush=()=>new Promise(r=>setImmediate(r));
 const successes=()=>log.shows.filter(s=>/최종 표시를 확인했습니다/.test(s.message||'')).map(s=>s.request.mode+'/'+s.request.orientation);
 return {sequence,log,flush,successes,close:()=>{closed=true;}};
}
const A={mode:'MIP',orientation:'Axial'},B={mode:'MinIP',orientation:'Coronal'},C={mode:'Raysum',orientation:'Sagittal'};

test('the first display is final only after its render is confirmed, and announced once',async()=>{
 const h=harness();const started=h.sequence.start(A);
 assert.deepEqual(h.log.applies,['MIP/Axial']);assert.equal(h.log.shows.at(-1).status,'pending');assert.deepEqual(h.successes(),[]);
 h.log.confirms[0].resolve();assert.equal(await started,true);
 assert.equal(h.log.shows.at(-1).status,'final');assert.deepEqual(h.successes(),['MIP/Axial']);assert.deepEqual(h.sequence.snapshot().final,A);
});
test('latest selection wins and a superseded confirmation never announces success',async()=>{
 const h=harness();const first=h.sequence.start(A);h.log.confirms[0].resolve();await first;
 const b=h.sequence.request(B),c=h.sequence.request(C);
 assert.deepEqual(h.log.applies,['MIP/Axial','MinIP/Coronal','Raysum/Sagittal']);
 h.log.confirms[1].resolve();assert.equal(await b,false);assert.deepEqual(h.successes(),['MIP/Axial']);assert.equal(h.log.shows.at(-1).status,'pending');
 h.log.confirms[2].resolve();assert.equal(await c,true);assert.deepEqual(h.successes(),['MIP/Axial','Raysum/Sagittal']);assert.deepEqual(h.sequence.snapshot().final,C);
});
test('reselecting the confirmed display while another is pending rewrites it; reselecting the pending one does not',async()=>{
 const h=harness();const first=h.sequence.start(A);h.log.confirms[0].resolve();await first;
 h.sequence.request(B);h.sequence.request(B);assert.deepEqual(h.log.applies,['MIP/Axial','MinIP/Coronal']);
 const back=h.sequence.request(A);assert.deepEqual(h.log.applies,['MIP/Axial','MinIP/Coronal','MIP/Axial']);
 h.log.confirms[1].resolve();h.log.confirms[2].resolve();assert.equal(await back,true);assert.deepEqual(h.successes(),['MIP/Axial','MIP/Axial']);
});
test('a setter failure keeps the last confirmed display with a visible notice',async()=>{
 const h=harness({applyFails:r=>r.mode==='MinIP'?Error('INJECTED SETTER'):null});const first=h.sequence.start(A);h.log.confirms[0].resolve();await first;
 const failed=h.sequence.request(B);
 assert.deepEqual(h.log.applies,['MIP/Axial','MinIP/Coronal','MIP/Axial']);
 const notice=h.log.shows.at(-1);assert.equal(notice.status,'pending');assert.deepEqual(notice.request,A);assert.match(notice.message,/INJECTED SETTER.*이전 표시\(MIP · Axial\)를 유지합니다/);
 h.log.confirms[1].resolve();assert.equal(await failed,true);
 assert.equal(h.log.shows.at(-1).status,'final');assert.match(h.log.shows.at(-1).message,/INJECTED SETTER/);assert.deepEqual(h.successes(),['MIP/Axial']);assert.deepEqual(h.log.fatal,[]);
});
test('a render failure rolls back to the confirmed display; a failed rollback closes instead',async()=>{
 const h=harness();const first=h.sequence.start(A);h.log.confirms[0].resolve();await first;
 const c=h.sequence.request(C);h.log.confirms[1].reject(Error('INJECTED RENDER'));await h.flush();
 assert.deepEqual(h.log.applies.at(-1),'MIP/Axial');assert.match(h.log.shows.at(-1).message,/INJECTED RENDER/);assert.deepEqual(h.sequence.snapshot().applied,A);
 h.log.confirms[2].resolve();assert.equal(await c,true);assert.deepEqual(h.successes(),['MIP/Axial']);
 const b=h.sequence.request(B);h.log.confirms[3].reject(Error('RENDER AGAIN'));await h.flush();h.log.confirms[4].reject(Error('ROLLBACK RENDER'));assert.equal(await b,false);
 assert.deepEqual(h.log.fatal,['ROLLBACK RENDER']);const count=h.log.applies.length;assert.equal(await h.sequence.request(C),false);assert.equal(h.log.applies.length,count);
});
test('a first display that cannot be applied or confirmed closes instead of showing a partial view',async()=>{
 const h=harness({applyFails:()=>Error('NO NATIVE')});assert.equal(await h.sequence.start(A),false);assert.deepEqual(h.log.fatal,['NO NATIVE']);
 const g=harness();const started=g.sequence.start(A);g.log.confirms[0].reject(Error('NO FRAME'));assert.equal(await started,false);assert.deepEqual(g.log.fatal,['NO FRAME']);assert.deepEqual(g.successes(),[]);
});
test('busy gates refuse a change without touching the native display and restore the controls',async()=>{
 let reason='';const h=harness({blocked:()=>reason});const first=h.sequence.start(A);h.log.confirms[0].resolve();await first;
 reason='다른 창을 닫은 뒤';assert.equal(await h.sequence.request(C),false);
 assert.deepEqual(h.log.applies,['MIP/Axial']);assert.deepEqual(h.log.shows.at(-1),{status:'final',request:A,message:'다른 창을 닫은 뒤'});
 reason='';const c=h.sequence.request(C);h.log.confirms[1].resolve();assert.equal(await c,true);
});
test('a gate that throws is a refusal, not an applied change',async()=>{
 const h=harness({blocked:()=>{throw Error('state unavailable');}});const first=h.sequence.start(A);h.log.confirms[0].resolve();await first;
 assert.equal(await h.sequence.request(B),false);assert.deepEqual(h.log.applies,['MIP/Axial']);assert.match(h.log.shows.at(-1).message,/작업 상태/);
});
test('close and dispose discard pending renders and later input',async()=>{
 const h=harness();const first=h.sequence.start(A);h.log.confirms[0].resolve();await first;
 const b=h.sequence.request(B);h.close();h.log.confirms[1].resolve();assert.equal(await b,false);assert.deepEqual(h.successes(),['MIP/Axial']);assert.equal(await h.sequence.request(C),false);
 const g=harness();const pending=g.sequence.start(A);g.sequence.dispose();g.log.confirms[0].resolve();assert.equal(await pending,false);assert.deepEqual(g.log.shows.filter(s=>s.status==='final'),[]);
 assert.equal(await g.sequence.start(A),false);
});
test('a stale rollback confirmation cannot overwrite a newer selection',async()=>{
 const h=harness({applyFails:r=>r.mode==='MinIP'?Error('INJECTED SETTER'):null});const first=h.sequence.start(A);h.log.confirms[0].resolve();await first;
 h.sequence.request(B);const c=h.sequence.request(C);h.log.confirms[1].resolve();await h.flush();
 assert.equal(h.log.shows.at(-1).status,'pending');assert.deepEqual(h.log.shows.at(-1).request,C);
 h.log.confirms[2].resolve();assert.equal(await c,true);assert.deepEqual(h.sequence.snapshot().final,C);
});
test('owner identity is exact and bounded',()=>{
 assert.deepEqual(model.normalizeOwner(['hospital','reader']),['hospital','reader']);
 for(const bad of [null,['hospital'],['hospital',''],['hospital','a '],['hospital',7]])assert.throws(()=>model.normalizeOwner(bad));
});
test('description names the mode, plane and whole-volume thickness',()=>{
 assert.equal(model.describe(C,model.projectionThickness(dims,spacing)),'Raysum · Sagittal · 91.6 mm');
});
