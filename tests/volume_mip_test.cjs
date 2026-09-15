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

// A11-VOI-1: display-only VOI Slab in source world coordinates.
const voiAffine=model.affine(world),voiBinding={volumeId:'volume',affine:voiAffine};
const voiRecord=(z,thickness,normal=[0,0,1])=>model.normalizeVoi({volumeId:'volume',affine:voiAffine,center:[15.75,15.75,z],normal,pivot:[15.75,15.75,40],thickness});
const oblique=model.normalizeVoi({volumeId:'volume',affine:voiAffine,center:[12,17,44],normal:[Math.cos(Math.PI/6),Math.sin(Math.PI/6),0],pivot:[15.75,15.75,40],thickness:12.5});

test('VOI Slab planes are two inward world planes at centre -/+ normal x thickness/2 and invalid records are refused',()=>{
 const [low,high]=model.voiPlanes(oblique);
 low.origin.forEach((n,i)=>assert.ok(Math.abs(n-(oblique.center[i]-6.25*oblique.normal[i]))<1e-12,'low origin '+i+' '+n));
 high.origin.forEach((n,i)=>assert.ok(Math.abs(n-(oblique.center[i]+6.25*oblique.normal[i]))<1e-12,'high origin '+i+' '+n));
 assert.deepEqual(low.normal,[...oblique.normal]);assert.deepEqual(high.normal,oblique.normal.map(n=>-n));
 // The mapper keeps dot(x-origin,normal)>=0 for every plane: together exactly |dot(x-centre,n)|<=thickness/2.
 const kept=d=>{const x=oblique.center.map((c,i)=>c+d*oblique.normal[i]);return [low,high].every(p=>p.origin.reduce((s,o,i)=>s+(x[i]-o)*p.normal[i],0)>=-1e-12);};
 for(const d of [-6.25,-6.249,0,6.249,6.25])assert.equal(kept(d),true,String(d));
 for(const d of [-6.251,6.251])assert.equal(kept(d),false,String(d));
 assert.ok(Object.isFrozen(oblique)&&Object.isFrozen(oblique.center)&&Object.isFrozen(oblique.affine));
 const base={volumeId:'volume',affine:voiAffine,center:[0,0,0],normal:[0,0,1],pivot:[0,0,0],thickness:5};
 for(const bad of [{...base,volumeId:''},{...base,affine:voiAffine.slice(0,9)},{...base,normal:[0,0,2]},{...base,thickness:0},{...base,thickness:-1},{...base,center:[NaN,0,0]},{...base,pivot:[0,0,1e7]},{...base,affine:[...voiAffine.slice(0,11),Infinity]},'slab',null])assert.throws(()=>model.voiPlanes(bad),/VOI Slab/);
 const plane=model.voiPlane(low);assert.equal(plane.isA('vtkPlane'),true);assert.equal(plane.setOrigin([9,9,9]),false);assert.equal(plane.setNormal([1,0,0]),false);
 plane.getOrigin()[0]=99;assert.deepEqual(plane.getOrigin(),low.origin);assert.deepEqual(plane.getNormal(),low.normal);
});
test('a VOI Slab is bound to its volume and index-to-world affine; a foreign volume or affine is refused',()=>{
 assert.deepEqual([...voiAffine],[0,0,0,.5,0,0,0,.5,0,0,0,2.5]);
 assert.deepEqual([...model.affine(([i,j,k])=>[100+2*i+.5*j,-50+.25*i+3*j+k,20+.5*i-.25*j+4*k])],[100,-50,20,2,.25,.5,.5,3,-.25,0,1,4]);
 assert.throws(()=>model.affine(([i,j,k])=>[i+j,i+j,k]),/좌표/);assert.throws(()=>model.affine(()=>[NaN,0,0]),/좌표/);
 const r=voiRecord(40,20);
 assert.equal(model.verifyBinding(r,voiBinding),'');assert.equal(model.verifyBinding(null,voiBinding),'');
 assert.match(model.verifyBinding(r,{...voiBinding,volumeId:'other'}),/현재 CT 볼륨/);
 assert.match(model.verifyBinding(r,{...voiBinding,affine:[...voiAffine.slice(0,11),2.5000001]}),/좌표 기준/);
 assert.match(model.verifyBinding({...r,normal:[0,0,.5]},voiBinding),/VOI Slab/);
});

function voiNative(orientation,record,blend=1){const s=nativeState(orientation,{blend});s.planes=[...s.planes,...model.voiPlanes(record)];return s;}
const voiExpected=(request,record)=>({...expected(request),voiSlab:record,affine:voiAffine});
test('final verification with a VOI Slab accepts only the two slab planes plus the two requested VOI planes',()=>{
 for(const mode of model.modes)for(const orientation of model.orientations)assert.equal(model.verifyState(voiNative(orientation.toLowerCase(),oblique,model.blendMode(mode)),voiExpected({mode,orientation},oblique)),'',mode+' '+orientation);
 const want=voiExpected({mode:'Raysum',orientation:'Coronal'},oblique),good=()=>voiNative('coronal',oblique,3),[low,high]=model.voiPlanes(oblique);
 const broken={
  missing:s=>{s.planes.pop();},none:s=>{s.planes.length=2;},extra:s=>{s.planes.push(high);},
  flipped:s=>{s.planes[2]={origin:low.origin,normal:low.normal.map(n=>-n)};},swapped:s=>{[s.planes[2],s.planes[3]]=[s.planes[3],s.planes[2]];},
  shifted:s=>{s.planes[3]={origin:high.origin.map((n,i)=>n+(i===2?2e-6:0)),normal:high.normal};},
  thickness:s=>{s.planes.splice(2,2,...model.voiPlanes({...oblique,thickness:12.6}));},
  index:s=>{s.planes.splice(2,2,...model.voiPlanes({...oblique,center:oblique.center.map((n,i)=>n/spacing[i])}));},
 };
 for(const [name,change] of Object.entries(broken)){const s=good();change(s);assert.match(model.verifyState(s,want),/VOI Slab 평면을 확인하지 못했습니다/,name);}
 // Off and Original expect no VOI planes; leftover planes are not the requested display.
 assert.match(model.verifyState(good(),{...want,voiSlab:null}),/VOI Slab 평면이 남아/);
 assert.equal(model.verifyState(nativeState('coronal',{blend:3}),{...want,voiSlab:null}),'');
 // The W/L voiRange stays its own check, and the slab planes are still required.
 assert.match(model.verifyState({...good(),voiRange:{lower:300,upper:1800}},want),/밝기/);
 const tilted=good();tilted.planes[1]={...tilted.planes[1],normal:[1,0,0]};assert.match(model.verifyState(tilted,want),/투영 평면/);
 assert.match(model.verifyState({...good(),volumeId:'other'},{...want,volumeId:'other'}),/현재 CT 볼륨/);
 assert.match(model.verifyState(good(),{...want,affine:[...voiAffine.slice(0,11),2.6]}),/좌표 기준/);
});
// The pinned mapper's substitution (vtk OpenGL VolumeMapper, ohif-bundle.js :69021), joined with '\n'.
const clipSource=count=>'vec2 computeRayDistances(vec3 rayDir, vec3 tdims)\n{\n'+['for(int i = 0; i < '+count+'; i++) {','  float rayDirRatio = dot(rayDir, vClipPlaneNormals[i]);','  float equationResult = dot(vertexVCVSOutput, vClipPlaneNormals[i]) + vClipPlaneDistances[i];','  if (rayDirRatio == 0.0)','  {','    if (equationResult < 0.0) dists.x = dists.y;','    continue;','  }','  float result = -1.0 * equationResult / rayDirRatio;','  if (rayDirRatio < 0.0) dists.y = min(dists.y, result);','  else dists.x = max(dists.x, result);','}','//VTK::ClipPlane::Impl'].join('\n')+'\n}';
test('the linked ray-segment clipping loop must match the plane count read back',()=>{
 assert.equal(model.clipShader(clipSource(4),4),true);assert.equal(model.clipShader(clipSource(2),2),true);
 assert.equal(model.clipShader(clipSource(2),4),false);assert.equal(model.clipShader(clipSource(4),2),false);
 assert.equal(model.clipShader(clipSource(4)+clipSource(4),4),false);
 assert.equal(model.clipShader(clipSource(4).replace('else dists.x = max(dists.x, result);','else dists.x = dists.x;'),4),false);
 assert.equal(model.clipShader('',4),false);assert.equal(model.clipShader(undefined,4),false);
});

const tag=r=>r.mode+'/'+r.orientation+'/'+(r.voiSlab?r.voiSlab.center[2]+'+'+r.voiSlab.thickness:'off')+(r.original?'/original':'');
const past=r=>model.normalizeRequest(r).history.map(v=>v?String(v.center[2]):'off');
function voiHarness({applyFails=()=>null}={}){
 const log={applies:[],shows:[],fatal:[],confirms:[]};
 const sequence=model.createSequence({apply:r=>{log.applies.push(tag(r));const error=applyFails(r);if(error)throw error;},confirm:r=>new Promise((resolve,reject)=>log.confirms.push({request:r,resolve,reject})),
  blocked:()=>'',closed:()=>false,show:s=>log.shows.push(s),fatal:e=>log.fatal.push(e.message),describe:tag});
 const successes=()=>log.shows.filter(s=>/최종 표시를 확인했습니다/.test(s.message||'')).map(s=>tag(s.request));
 const last=()=>log.confirms.at(-1),snap=()=>sequence.snapshot(),flush=()=>new Promise(r=>setImmediate(r));
 const change=voiSlab=>sequence.request(model.voiChange(snap().final,snap().applied,voiSlab));
 const display=value=>sequence.request(model.withDisplay(snap().applied,value));
 const started=async()=>{const s=sequence.start(A);log.confirms[0].resolve();await s;};
 return {sequence,log,successes,last,snap,flush,change,display,started};
}
const a30=voiRecord(30,10),b50=voiRecord(50,10),c60=voiRecord(60,10);

test('a VOI change is Final only after its render is confirmed and history takes only confirmed records',async()=>{
 const h=voiHarness();await h.started();
 const pa=h.change(a30);assert.equal(h.log.shows.at(-1).status,'pending');assert.deepEqual(h.successes(),['MIP/Axial/off']);assert.equal(h.snap().final.voiSlab,undefined);
 h.last().resolve();assert.equal(await pa,true);assert.deepEqual(past(h.snap().final),['off']);assert.deepEqual(h.successes(),['MIP/Axial/off','MIP/Axial/30+10']);
 // Two quick edits: the superseded one neither announces nor enters history.
 const pb=h.change(b50),pc=h.change(c60);assert.deepEqual(past(h.snap().applied),['off','30']);
 h.log.confirms[2].resolve();assert.equal(await pb,false);assert.deepEqual(h.successes(),['MIP/Axial/off','MIP/Axial/30+10']);assert.ok(model.sameVoi(h.snap().final.voiSlab,a30));
 h.log.confirms[3].resolve();assert.equal(await pc,true);assert.deepEqual(past(h.snap().final),['off','30']);assert.deepEqual(h.successes().at(-1),'MIP/Axial/60+10');
 // An identical VOI request is not written again; Original is a different display.
 const count=h.log.applies.length;assert.equal(await h.change(c60),false);assert.equal(h.log.applies.length,count);
 h.sequence.request(model.voiOriginal(h.snap().applied,true));assert.equal(h.log.applies.at(-1),'MIP/Axial/60+10/original');
});
test('every input order reaches the latest request and only it is announced',async()=>{
 // VOI then orientation, and orientation then VOI, end in the same display and history.
 const first=voiHarness();await first.started();first.change(a30);first.display({mode:'MIP',orientation:'Coronal'});first.log.confirms[1].resolve();first.last().resolve();await first.flush();
 const second=voiHarness();await second.started();second.display({mode:'MIP',orientation:'Coronal'});second.change(a30);second.log.confirms[1].resolve();second.last().resolve();await second.flush();
 for(const h of [first,second]){assert.equal(tag(h.snap().final),'MIP/Coronal/30+10');assert.deepEqual(past(h.snap().final),['off']);assert.deepEqual(h.successes(),['MIP/Axial/off','MIP/Coronal/30+10']);}
 // VOI, then mode, then Undo while pending: the unconfirmed record is undone to the current Final.
 const h=voiHarness();await h.started();const pa=h.change(a30);h.last().resolve();await pa;
 h.change(b50);h.display({mode:'MinIP',orientation:'Axial'});const undo=h.sequence.request(model.voiUndo(h.snap().final,h.snap().applied));
 assert.equal(h.log.applies.at(-1),'MinIP/Axial/30+10');for(const c of h.log.confirms.slice(2))c.resolve();assert.equal(await undo,true);
 assert.deepEqual(h.successes(),['MIP/Axial/off','MIP/Axial/30+10','MinIP/Axial/30+10']);assert.deepEqual(past(h.snap().final),['off']);
 const off=h.sequence.request(model.voiUndo(h.snap().final,h.snap().applied));h.last().resolve();assert.equal(await off,true);assert.equal(tag(h.snap().final),'MinIP/Axial/off');
 assert.throws(()=>model.voiUndo(h.snap().final,h.snap().applied),/되돌릴 VOI Slab 변경이 없습니다/);
 // Original during a pending VOI change wins, keeps the record and toggles back to it.
 const o=voiHarness();await o.started();const oa=o.change(a30);o.last().resolve();await oa;o.change(b50);
 const shown=o.sequence.request(model.voiOriginal(o.snap().applied,true));o.log.confirms[2].resolve();o.last().resolve();assert.equal(await shown,true);
 assert.equal(tag(o.snap().final),'MIP/Axial/50+10/original');assert.throws(()=>model.voiChange(o.snap().final,o.snap().applied,c60),/Original 보기를 끈 뒤/);
 const back=o.sequence.request(model.voiOriginal(o.snap().applied,false));o.last().resolve();assert.equal(await back,true);assert.equal(tag(o.snap().final),'MIP/Axial/50+10');assert.ok(model.sameVoi(o.snap().final.voiSlab,b50));
 // Reset then Undo returns the reset record.
 const r=voiHarness();await r.started();const ra=r.change(a30);r.last().resolve();await ra;const reset=r.change(null);r.last().resolve();assert.equal(await reset,true);
 assert.deepEqual([tag(r.snap().final),...past(r.snap().final)],['MIP/Axial/off','off','30']);
 const undone=r.sequence.request(model.voiUndo(r.snap().final,r.snap().applied));r.last().resolve();assert.equal(await undone,true);assert.equal(tag(r.snap().final),'MIP/Axial/30+10');assert.deepEqual(past(r.snap().final),['off']);
});
test('a failed VOI plane write or VOI readback keeps the last Final display including its VOI Slab',async()=>{
 const h=voiHarness({applyFails:r=>r.voiSlab?.center[2]===50?Error('INJECTED VOI PLANE WRITE'):null});await h.started();const pa=h.change(a30);h.last().resolve();await pa;
 const pb=h.change(b50);assert.deepEqual(h.log.applies.slice(-2),['MIP/Axial/50+10','MIP/Axial/30+10']);
 assert.match(h.log.shows.at(-1).message,/INJECTED VOI PLANE WRITE.*이전 표시\(MIP\/Axial\/30\+10\)를 유지합니다/);
 h.last().resolve();assert.equal(await pb,true);assert.ok(model.sameVoi(h.snap().final.voiSlab,a30));assert.deepEqual(past(h.snap().final),['off']);
 const pc=h.change(c60);h.last().reject(Error('VOI Slab 평면을 확인하지 못했습니다.'));await h.flush();
 assert.equal(h.log.applies.at(-1),'MIP/Axial/30+10');h.last().resolve();assert.equal(await pc,true);
 assert.ok(model.sameVoi(h.snap().final.voiSlab,a30));assert.deepEqual(h.successes(),['MIP/Axial/off','MIP/Axial/30+10']);assert.deepEqual(h.log.fatal,[]);
});
test('Undo walks back at most 32 confirmed VOI Slab records, Reset is undoable and Original leaves history unchanged',()=>{
 let final={mode:'MIP',orientation:'Axial'};
 assert.throws(()=>model.voiUndo(final,final),/되돌릴 VOI Slab 변경이 없습니다/);
 const records=Array.from({length:40},(_,i)=>voiRecord(10+i,5));
 for(const r of records)final=model.voiChange(final,final,r);
 assert.equal(model.voiHistoryLimit,32);assert.equal(final.history.length,32);assert.ok(model.sameVoi(final.history[0],records[7]));
 let back=final;for(let i=0;i<32;i++)back=model.voiUndo(back,back);
 assert.ok(model.sameVoi(back.voiSlab,records[7]));assert.throws(()=>model.voiUndo(back,back),/되돌릴/);
 const reset=model.voiChange(final,final,null);assert.equal(reset.voiSlab,null);assert.ok(model.sameVoi(model.voiUndo(reset,reset).voiSlab,records[39]));
 const original=model.voiOriginal(final,true);assert.equal(original.original,true);assert.ok(model.sameVoi(original.voiSlab,final.voiSlab));
 assert.equal(model.sameRequest(model.voiOriginal(original,false),final),true);
 assert.throws(()=>model.voiChange(original,original,records[0]),/Original 보기를 끈 뒤/);assert.throws(()=>model.voiUndo(original,original),/Original 보기를 끈 뒤/);
 assert.throws(()=>model.voiOriginal({mode:'MIP',orientation:'Axial'},true),/VOI Slab을 적용한 뒤/);
 assert.equal(model.sameRequest(model.voiChange(final,final,records[39]),final),true);
 // A display change keeps the VOI Slab fixed; requests never carry a W/L voiRange.
 const coronal=model.withDisplay(final,{mode:'MinIP',orientation:'Coronal'});assert.ok(model.sameVoi(coronal.voiSlab,final.voiSlab));
 assert.deepEqual(Object.keys(coronal).sort(),['history','mode','orientation','original','voiSlab']);
 assert.throws(()=>model.normalizeRequest({...final,history:Array(33).fill(null)}),/되돌리기 기록/);
});

/* A11-ORIENT-1 V1: the manual's Orientation Preset bar A/P/L/R/H/F (IF-RND-502U Rev1.2 p.332 §12.1, placed in the MIP Viewer by
   p.342 §13). The expected vectors are the accepted contract table, written out here rather than derived from the model, and the
   screen-right column is the hand-computed viewUp x viewPlaneNormal of that table. */
const DIRECTIONS=[
 ['Anterior',[0,-1,0],[0,0,1],[1,0,0]],
 ['Posterior',[0,1,0],[0,0,1],[-1,0,0]],
 ['Left',[1,0,0],[0,0,1],[0,1,0]],
 ['Right',[-1,0,0],[0,0,1],[0,-1,0]],
 ['Superior',[0,0,1],[0,-1,0],[-1,0,0]],
 ['Inferior',[0,0,-1],[0,1,0],[-1,0,0]]];
// A cross product of axis vectors yields -0 components; the sign of zero is not part of the direction, so it is normalised
// for comparison only. The expected vectors themselves are the accepted table, unchanged.
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]].map(n=>n+0);
test('the six anatomical presets are the accepted direction table, and the three MPR planes are untouched',()=>{
 assert.deepEqual(model.directions,['Anterior','Posterior','Left','Right','Superior','Inferior']);
 // The VOI Slab preset list and the MPR plane list stay exactly the three planes (manual p.337 §12.4).
 assert.deepEqual(model.orientations,['Axial','Coronal','Sagittal']);
 assert.deepEqual(model.views,['Axial','Coronal','Sagittal','Anterior','Posterior','Left','Right','Superior','Inferior']);
 for(const [name,normal,up,right] of DIRECTIONS){
  const got=model.view(native,name);
  assert.deepEqual([got.viewPlaneNormal,got.viewUp],[normal,up],name);
  assert.equal(got.key,null,name+' is written as vectors, not as a native orientation key');
  assert.deepEqual(cross(up,normal),right,name+' screen right');
  assert.ok(Math.abs(Math.hypot(...normal)-1)<1e-12&&Math.abs(Math.hypot(...up)-1)<1e-12,name+' unit');
  assert.equal(normal[0]*up[0]+normal[1]*up[1]+normal[2]*up[2],0,name+' orthogonal');
  assert.deepEqual(model.normalizeRequest({mode:'MIP',orientation:name}).orientation,name);
 }
 // F is the Axial projection turned 180 degrees in plane: same ray axis, up and screen right both negated. It is not Axial.
 const axial=model.preset(native,'Axial'),foot=model.view(native,'Inferior');
 assert.deepEqual(foot.viewPlaneNormal,axial.viewPlaneNormal);
 assert.deepEqual(foot.viewUp,axial.viewUp.map(n=>-n+0));
 assert.deepEqual(cross(foot.viewUp,foot.viewPlaneNormal),cross(axial.viewUp,axial.viewPlaneNormal).map(n=>-n+0));
 // H is the left-right mirror of Axial: same up, reversed ray axis.
 const head=model.view(native,'Superior');
 assert.deepEqual([head.viewPlaneNormal,head.viewUp],[axial.viewPlaneNormal.map(n=>-n+0),axial.viewUp]);
 // A and Coronal, L and Sagittal are the same camera under different saved names.
 assert.deepEqual([model.view(native,'Anterior').viewPlaneNormal,model.view(native,'Anterior').viewUp],[model.preset(native,'Coronal').viewPlaneNormal,model.preset(native,'Coronal').viewUp]);
 assert.deepEqual([model.view(native,'Left').viewPlaneNormal,model.view(native,'Left').viewUp],[model.preset(native,'Sagittal').viewPlaneNormal,model.preset(native,'Sagittal').viewUp]);
 // The three planes still resolve through the pinned native table, so a missing table is still refused.
 for(const name of model.orientations)assert.deepEqual(model.view(native,name),model.preset(native,name));
 assert.throws(()=>model.view(undefined,'Axial'),/방향 기준값/);
 // Direction vectors are frozen copies: a caller cannot edit the table through the value it is handed.
 const copy=model.view(native,'Anterior');copy.viewPlaneNormal[0]=9;
 assert.deepEqual(model.view(native,'Anterior').viewPlaneNormal,[0,-1,0]);
 for(const bad of ['Head','Foot','anterior','ANTERIOR','Oblique','',null,undefined])assert.throws(()=>model.normalizeRequest({mode:'MIP',orientation:bad}),/Projection과 Orientation/,String(bad));
});
test('the pinned kin-mip-2 table is the product VR direction table, so a VR change cannot silently reinterpret saved rows',()=>{
 const vr=require('../worklist-v0/hpacs-lite/volume-rendering.js');
 for(const [name,normal,up] of DIRECTIONS){
  const turned=vr.orient({focalPoint:[3,4,5],position:[3,4,105],viewUp:[0,1,0]},name);
  assert.deepEqual([turned.viewPlaneNormal,turned.viewUp],[normal,up],name+' VR parity');
 }
 assert.deepEqual(vr.directions,model.directions);
});
test('request identity covers the VOI Slab and Original, and the Final label names them',()=>{
 const r={mode:'MIP',orientation:'Axial',voiSlab:a30,original:false,history:[null]};
 assert.equal(model.sameRequest(r,{...r,voiSlab:model.normalizeVoi({...a30})}),true);
 assert.equal(model.sameRequest(r,{...r,voiSlab:voiRecord(30,10.5)}),false);
 assert.equal(model.sameRequest(r,{...r,voiSlab:model.normalizeVoi({...a30,volumeId:'other'})}),false);
 assert.equal(model.sameRequest(r,{...r,original:true}),false);assert.equal(model.sameRequest(r,{...r,voiSlab:null}),false);
 assert.equal(model.sameRequest({mode:'MIP',orientation:'Axial'},{mode:'MIP',orientation:'Axial',voiSlab:null,original:false,history:[]}),true);
 assert.equal(model.describe(r,91.6),'MIP · Axial · 91.6 mm · VOI Slab 10 mm');assert.equal(model.describe({...r,original:true},91.6),'MIP · Axial · 91.6 mm · Original');
 assert.throws(()=>model.normalizeRequest({...r,original:'yes'}),/Original/);
});
