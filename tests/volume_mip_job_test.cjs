// TEST-MIP-JOB (A11-VOI-2 P3): the MIP Viewer Job model over the real volume-mip.js request rules and volume-voi.js slabs.
const {test}=require('node:test'),assert=require('node:assert/strict');
globalThis.KinVolumeMip=require('../worklist-v0/hpacs-lite/volume-mip.js');
// Mutation runs load a changed copy; the default is always the product model.
const job=require(process.env.KIN_MIP_JOB_MODEL_SOURCE||'../worklist-v0/hpacs-lite/volume-mip-job.js');
const voi=require('../worklist-v0/hpacs-lite/volume-voi.js');
const mip=globalThis.KinVolumeMip;

// The known-voxel MIP study geometry (tests/e2e/test_volume_mip.py): world = (column*.5, row*.5, slice*2.5) mm.
const dims=[64,64,33],world=i=>[i[0]*.5,i[1]*.5,i[2]*2.5],affine=mip.affine(world),corners=mip.corners(dims,world);
const imageData={getSpatialExtent:()=>[0,63,0,63,0,32],indexToWorld:world};
const FOR='2.25.6',display={voiRange:{lower:-1100,upper:1100},interpolationType:0};
const record=slab=>mip.normalizeVoi({volumeId:'volume-1',affine,center:slab.center,normal:slab.normal,pivot:slab.pivot,thickness:slab.thickness});
// The native oblique case: Sagittal preset about a pivot away from the centre, rotated S30 then P25, then moved 6 mm.
const oblique=(()=>{let s=voi.defaults(imageData,'Sagittal');s={...s,center:[18,15.75,40],pivot:[15.75,15.75,40],thickness:14};s=voi.rotate(s,'S',30);s=voi.rotate(s,'P',25);return record(voi.move(s,6));})();
const perpendicular=record({center:[8.125,15.75,40],normal:[1,0,0],pivot:[15.75,15.75,40],thickness:22.25});
const KEYS=['algorithm','coordinates','display','frameOfReference','mode','orientation','schema','voiSlab'];
const numbers=v=>Array.isArray(v)?v.flatMap(numbers):v&&typeof v==='object'?Object.values(v).flatMap(numbers):typeof v==='number'?[v]:[];
const keysDeep=v=>Array.isArray(v)?v.flatMap(keysDeep):v&&typeof v==='object'?Object.entries(v).flatMap(([k,x])=>[k,...keysDeep(x)]):[];
const bitSame=(a,b)=>{const x=numbers(a),y=numbers(b);return x.length===y.length&&x.every((n,i)=>Object.is(n,y[i]));};

// A real request sequence whose renders confirm only when released, so pending, superseded and Final states are the
// model's own snapshots rather than hand-written ones.
function sequence(){
 const held=[];
 const seq=mip.createSequence({apply:()=>{},confirm:()=>new Promise((resolve,reject)=>held.push({resolve,reject})),blocked:()=>'',closed:()=>false,show:()=>{},fatal:error=>{throw error;},describe:r=>r.mode+' · '+r.orientation});
 return {seq,release:async()=>{const next=held.shift();next.resolve();await new Promise(r=>setImmediate(r));}};
}
async function confirmedSnapshot(requests){
 const {seq,release}=sequence();let done=seq.start(requests[0]);await release();assert.equal(await done,true);
 for(const next of requests.slice(1)){const request=typeof next==='function'?next(seq.snapshot()):next;done=seq.request(request);await release();assert.equal(await done,true);}
 return seq.snapshot();
}
const withVoi=(slab,display={mode:'Raysum',orientation:'Coronal'})=>snapshot=>({...mip.withDisplay(mip.voiChange(snapshot.final,snapshot.applied,slab),display)});

/* A11-ORIENT-1 V3: the manual's anatomical Orientation Presets are a second algorithm, kin-mip-2, carried by the new versions
   14/15. Each version names exactly one algorithm and each algorithm exactly one enum, so one display has exactly one encoding
   and every accepted version 12/13 byte, message and refusal stays as it was. */
const ORIENT_RECIPE={schema:1,algorithm:'kin-mip-batch-1',axis:'Horizontal',interval:90,count:4,reverse:false};
const blockOf=async orientation=>job.block(await confirmedSnapshot([{mode:'MIP',orientation}]),{frameOfReference:FOR,display});
test('an anatomical preset saves as kin-mip-2 in versions 14/15 while a plane display stays kin-mip-1 in 12/13',async()=>{
 const plane=await blockOf('Axial'),direction=await blockOf('Posterior');
 assert.equal(plane.algorithm,'kin-mip-1');assert.equal(direction.algorithm,'kin-mip-2');
 assert.equal(direction.orientation,'Posterior');
 // The kin-mip-2 body is the kin-mip-1 body with one enum swapped: the same exact key set, no thickness and no camera.
 assert.deepEqual(Object.keys(direction).sort(),KEYS);
 assert.deepEqual([job.versionFor(plane,null),job.versionFor(plane,ORIENT_RECIPE)],[12,13]);
 assert.deepEqual([job.versionFor(direction,null),job.versionFor(direction,ORIENT_RECIPE)],[14,15]);
 for(const name of ['Anterior','Posterior','Left','Right','Superior','Inferior'])assert.equal(job.algorithmFor(name),'kin-mip-2',name);
 for(const name of ['Axial','Coronal','Sagittal'])assert.equal(job.algorithmFor(name),'kin-mip-1',name);
 assert.deepEqual([job.algorithmOf(12),job.algorithmOf(13),job.algorithmOf(14),job.algorithmOf(15),job.algorithmOf(16)],['kin-mip-1','kin-mip-1','kin-mip-2','kin-mip-2',null]);
 for(const bad of [{algorithm:'kin-mip-3'},{},null,undefined])assert.equal(job.versionFor(bad,null),null,JSON.stringify(bad));
});
test('each version accepts exactly its own algorithm and enum, and the kin-mip-1 entry points keep their meaning',async()=>{
 const plane=await blockOf('Coronal'),direction=await blockOf('Superior');
 for(const [version,value] of [[12,plane],[13,plane],[14,direction],[15,direction]])assert.equal(job.validateFor(version,value).orientation,value.orientation,'v'+version);
 assert.deepEqual([job.supportedFor(12,plane),job.supportedFor(14,direction),job.supportedFor(12,direction),job.supportedFor(14,plane),job.supportedFor(16,plane)],[true,true,false,false,false]);
 // A known algorithm carried by the wrong version is a malformed pair; an unknown algorithm, schema or coordinate system is not
 // a computation this viewer can reproduce.
 for(const [version,value] of [[12,direction],[13,direction],[14,plane],[15,plane]])assert.throws(()=>job.validateFor(version,value),{message:job.messages.shape},'v'+version);
 for(const version of [12,14]){
  for(const algorithm of ['kin-mip-3','kin-mip-batch-1',''])assert.throws(()=>job.validateFor(version,{...plane,algorithm}),{message:job.messages.reproduce},algorithm);
  assert.throws(()=>job.validateFor(version,{...plane,schema:2}),{message:job.messages.reproduce});
  assert.throws(()=>job.validateFor(version,{...plane,coordinates:'RAS_mm'}),{message:job.messages.reproduce});
 }
 for(const version of [11,16,17,'14',14.5,null,undefined])assert.throws(()=>job.validateFor(version,plane),{message:job.messages.shape},String(version));
 assert.throws(()=>job.validateFor(12,{...plane,orientation:'Anterior'}),{message:job.messages.shape});
 assert.throws(()=>job.validateFor(14,{...direction,orientation:'Axial'}),{message:job.messages.shape});
 // Unchanged: validate()/supported() are kin-mip-1 only, which is what the accepted version 12/13 callers rely on.
 assert.equal(job.supported(plane),true);assert.equal(job.supported(direction),false);
 assert.equal(job.validate(plane).orientation,'Coronal');
 assert.throws(()=>job.validate(direction),{message:job.messages.reproduce});
 // restoreRequest is bound to the version and still defaults to the accepted kin-mip-1 behaviour.
 const binding={frameOfReference:FOR,volumeId:'volume-1',affine};
 assert.equal(job.restoreRequest(plane,binding).orientation,'Coronal');
 assert.equal(job.restoreRequest(direction,binding,14).orientation,'Superior');
 assert.throws(()=>job.restoreRequest(direction,binding),{message:job.messages.reproduce});
 assert.throws(()=>job.restoreRequest(plane,binding,14),{message:job.messages.shape});
});
test('a kept MIP save request pairs with the version its own block names',async()=>{
 const plane=await blockOf('Sagittal'),direction=await blockOf('Right');
 const pendingOf=(version,mip,mipBatch)=>mipBatch===undefined?{version,mip}:{version,mip,mipBatch};
 assert.equal(job.retryable(pendingOf(12,plane),plane,null),true);
 assert.equal(job.retryable(pendingOf(14,direction),direction,null),true);
 assert.equal(job.retryable(pendingOf(13,plane,ORIENT_RECIPE),plane,ORIENT_RECIPE),true);
 assert.equal(job.retryable(pendingOf(15,direction,ORIENT_RECIPE),direction,ORIENT_RECIPE),true);
 // A body kept under the other pair, or under the batch member of its own pair, is not this display's request.
 assert.equal(job.retryable(pendingOf(12,direction),direction,null),false);
 assert.equal(job.retryable(pendingOf(14,plane),plane,null),false);
 assert.equal(job.retryable(pendingOf(14,direction),direction,ORIENT_RECIPE),false);
 assert.equal(job.retryable(pendingOf(15,direction,ORIENT_RECIPE),direction,null),false);
 assert.equal(job.retryable(pendingOf(14,direction),plane,null),false);
});

test('a Job block is the confirmed Final request with exact keys, no runtime state and bit-exact numbers',async()=>{
 const snapshot=await confirmedSnapshot([{mode:'MIP',orientation:'Axial'},withVoi(oblique)]);
 assert.equal(snapshot.state,'final');assert.ok(snapshot.final.voiSlab);
 const block=job.block(snapshot,{frameOfReference:FOR,display});
 assert.deepEqual(Object.keys(block).sort(),KEYS);
 assert.deepEqual([block.schema,block.algorithm,block.coordinates,block.frameOfReference,block.mode,block.orientation],[1,'kin-mip-1','LPS_mm',FOR,'Raysum','Coronal']);
 assert.deepEqual(Object.keys(block.voiSlab).sort(),['center','normal','pivot','thickness']);assert.deepEqual(block.display,display);
 for(const forbidden of ['volumeId','affine','history','original','applied','pending','state','pixels'])assert.equal(keysDeep(block).includes(forbidden),false,forbidden);
 // Copied, never rounded or renormalized: toFixed rounding would move this oblique normal.
 assert.ok(oblique.normal.some(n=>Number(n.toFixed(6))!==n),'precondition: rounding changes the oblique normal');
 for(const key of ['center','normal','pivot'])assert.ok(block.voiSlab[key].every((n,i)=>Object.is(n,snapshot.final.voiSlab[key][i])),key);
 assert.ok(Object.is(block.voiSlab.thickness,snapshot.final.voiSlab.thickness));
 // The saved form is JSON text; every double survives that round trip.
 const text=JSON.stringify(block),back=JSON.parse(text);assert.ok(bitSame(back,block));assert.deepStrictEqual(back,JSON.parse(JSON.stringify(back)));
 // A VOI-off display saves voiSlab null.
 const off=job.block(await confirmedSnapshot([{mode:'MinIP',orientation:'Sagittal'}]),{frameOfReference:FOR,display});
 assert.equal(off.voiSlab,null);assert.equal(off.mode,'MinIP');
});

test('a normal whose length is not exactly one keeps its saved digits through block and restore (no renormalization)',async()=>{
 // CA2: n/hypot(n) is bit-idempotent for most unit normals, so only a normal that division moves can tell a renormalizing
 // copy apart. This fixed normal is within the 1e-6 unit rule and its renormalization differs.
 const normal=[-0.02112120159637765,0.4180385340884213,-0.9081837252782768],length=Math.hypot(...normal);
 assert.notEqual(length,1,'precondition: hypot is not exactly 1');assert.ok(Math.abs(length-1)<=1e-6);
 assert.ok(normal.some(n=>n/length!==n),'precondition: renormalization changes a component');
 const slab=Object.freeze({volumeId:'volume-1',affine,center:Object.freeze([16,15.75,40]),normal:Object.freeze(normal),pivot:Object.freeze([15.75,15.75,40]),thickness:10});
 const snapshot=await confirmedSnapshot([{mode:'MIP',orientation:'Axial',voiSlab:slab,original:false,history:[]}]);
 const block=job.block(snapshot,{frameOfReference:FOR,display});
 assert.ok(block.voiSlab.normal.every((n,i)=>Object.is(n,normal[i])),'block keeps the confirmed normal');
 const request=job.restoreRequest(JSON.parse(JSON.stringify(block)),{frameOfReference:FOR,volumeId:'volume-9',affine});
 assert.ok(request.voiSlab.normal.every((n,i)=>Object.is(n,normal[i])),'restore keeps the saved normal');
 assert.ok(job.same(job.block(await confirmedSnapshot([request]),{frameOfReference:FOR,display}),block),'the restored display is the saved block again');
});

test('a pending, superseded, first-render or Original display is refused and never saved in its place',async()=>{
 const refuse=(snapshot,pattern)=>assert.throws(()=>job.block(snapshot,{frameOfReference:FOR,display}),pattern);
 refuse(null,/최종 표시를 확인한 뒤/);refuse({applied:null,final:null,state:'pending'},/최종 표시를 확인한 뒤/);
 const {seq,release}=sequence();const first=seq.start({mode:'MIP',orientation:'Axial'});
 refuse(seq.snapshot(),/최종 표시를 확인한 뒤/);await release();assert.equal(await first,true);
 const final=job.block(seq.snapshot(),{frameOfReference:FOR,display});assert.equal(final.voiSlab,null);
 // A newer VOI request is applied but not confirmed: the pending request is never the saved one.
 const pending=seq.request(mip.voiChange(seq.snapshot().final,seq.snapshot().applied,perpendicular));
 assert.equal(seq.snapshot().state,'pending');assert.ok(seq.snapshot().applied.voiSlab);refuse(seq.snapshot(),/최종 표시를 확인한 뒤/);
 refuse({...seq.snapshot(),state:'final'},/최종 표시를 확인한 뒤/);
 await release();assert.equal(await pending,true);
 const confirmed=job.block(seq.snapshot(),{frameOfReference:FOR,display});assert.ok(confirmed.voiSlab);
 assert.ok(confirmed.voiSlab.center.every((n,i)=>Object.is(n,perpendicular.center[i])));
 // Original view shows another display than the saved one would restore.
 const original=seq.request(mip.voiOriginal(seq.snapshot().applied,true));await release();assert.equal(await original,true);
 refuse(seq.snapshot(),/Original 보기를 끈 뒤 저장하세요/);
 for(const [label,context] of [['foreign frame text',{frameOfReference:'x',display}],['inverted window',{frameOfReference:FOR,display:{voiRange:{lower:1,upper:0},interpolationType:0}}],['interpolation 3',{frameOfReference:FOR,display:{...display,interpolationType:3}}]])
  assert.throws(()=>job.block(snapshotFinal(confirmed),context),/원본 좌표나 값을 확인할 수 없어/,label);
});
const snapshotFinal=block=>{const request={mode:block.mode,orientation:block.orientation,voiSlab:block.voiSlab&&record(block.voiSlab),original:false,history:[]};return {applied:request,final:request,state:'final'};};

test('the VOI Slab must keep a voxel centre: intersection edges at plus and minus 1e-6 mm',()=>{
 // Voxel-centre S range is 0..80 mm; a 6 mm axial slab touches the box when its centre is 3 mm beyond either end.
 const axial=center=>({center:[15.75,15.75,center],normal:[0,0,1],pivot:[15.75,15.75,40],thickness:6});
 assert.equal(job.intersects(axial(83),corners),true,'touching the high corner at exactly half thickness');
 assert.equal(job.intersects(axial(83+.5e-6),corners),true,'within the 1e-6 edge');
 assert.equal(job.intersects(axial(83+2e-6),corners),false,'beyond the + side');
 assert.equal(job.intersects(axial(-3),corners),true,'touching the low corner');
 assert.equal(job.intersects(axial(-3-2e-6),corners),false,'beyond the - side');
 assert.equal(job.intersects(oblique,corners),true);assert.equal(job.intersects(null,corners),true,'no VOI Slab restricts nothing');
 for(const bad of [null,corners.slice(1),[...corners.slice(1),[NaN,0,0]]])assert.equal(job.intersects(axial(40),bad),false);
});

test('restoreRequest binds the saved numbers with empty history and Original off, and refuses what it cannot reproduce',async()=>{
 const block=JSON.parse(JSON.stringify(job.block(await confirmedSnapshot([{mode:'MIP',orientation:'Axial'},withVoi(oblique)]),{frameOfReference:FOR,display})));
 const binding={frameOfReference:FOR,volumeId:'volume-2',affine};
 const request=job.restoreRequest(block,binding);
 assert.deepEqual(Object.keys(request),['mode','orientation','voiSlab','original','history']);
 assert.equal(request.original,false);assert.deepEqual(request.history,[]);assert.equal(request.history.length,0);
 assert.equal(request.voiSlab.volumeId,'volume-2');assert.deepEqual([...request.voiSlab.affine],[...affine]);
 for(const key of ['center','normal','pivot'])assert.ok(request.voiSlab[key].every((n,i)=>Object.is(n,block.voiSlab[key][i])),key);
 // The viewer accepts it as its own request, and Undo right after the restore has nothing to return to.
 assert.ok(mip.sameRequest(request,mip.normalizeRequest(request)));assert.throws(()=>mip.voiUndo(request,request),/되돌릴 VOI Slab 변경이 없습니다/);
 const off=job.restoreRequest({...block,voiSlab:null},{frameOfReference:FOR});assert.equal(off.voiSlab,null);assert.deepEqual(off.history,[]);
 const reproduce=/계산 방식을 이 뷰어가 재현할 수 없어/,shape=/형식을 확인할 수 없어/,frame=/Frame of Reference/;
 for(const [label,change,pattern] of [
   ['schema 2',b=>{b.schema=2;},reproduce],['algorithm kin-mip-2',b=>{b.algorithm='kin-mip-2';},reproduce],['coordinates RAS_mm',b=>{b.coordinates='RAS_mm';},reproduce],
   ['volumeId key',b=>{b.volumeId='volume-1';},shape],['affine key',b=>{b.affine=[...affine];},shape],['history key',b=>{b.history=[];},shape],['original key',b=>{b.original=false;},shape],
   ['extra slab key',b=>{b.voiSlab.volumeId='volume-1';},shape],['extra display key',b=>{b.display.VOILUTFunction='LINEAR';},shape],
   ['normal length 1+2e-6',b=>{b.voiSlab.normal=b.voiSlab.normal.map(n=>n*(1+2e-6));},shape],['thickness 0',b=>{b.voiSlab.thickness=0;},shape],['coordinate 1e6+1',b=>{b.voiSlab.center[0]=1e6+1;},shape],
   ['mode Sum',b=>{b.mode='Sum';},shape],['orientation axial',b=>{b.orientation='axial';},shape],['frame text',b=>{b.frameOfReference='not-a-uid';},shape]]){
  const changed=structuredClone(block);change(changed);assert.throws(()=>job.restoreRequest(changed,binding),pattern,label);
 }
 assert.equal(job.supported({...block,algorithm:'kin-mip-2'}),false);assert.equal(job.supported(block),true);
 assert.throws(()=>job.restoreRequest(block,{...binding,frameOfReference:'2.25.7'}),frame);assert.throws(()=>job.restoreRequest(block,null),frame);
 assert.throws(()=>job.restoreRequest(block,{frameOfReference:FOR}),shape,'a VOI Slab needs the runtime binding');
});

test('a block read back in jsonb key order is the same block and shows Saved again after restore',async()=>{
 const block=job.block(await confirmedSnapshot([{mode:'MIP',orientation:'Axial'},withVoi(oblique)]),{frameOfReference:FOR,display});
 // jsonb orders object keys by length, then bytes; GET returns that order, never the order the viewer sent.
 const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort((a,b)=>a.length-b.length||(a<b?-1:a>b?1:0)).map(k=>[k,reorder(v[k])])):v;
 const stored=reorder(JSON.parse(JSON.stringify(block)));
 assert.notEqual(JSON.stringify(stored),JSON.stringify(block),'precondition: the key order differs');
 assert.equal(job.same(stored,block),true);assert.equal(job.same({...stored,mode:'MinIP'},block),false);
 const state=job.createSaveState(),op={};state.open(op);assert.equal(state.restored(op,stored),true);
 const restored=await confirmedSnapshot([job.restoreRequest(stored,{frameOfReference:FOR,volumeId:'volume-3',affine})]);
 const again=job.block(restored,{frameOfReference:FOR,display});
 assert.equal(state.label(op,again),'Saved');assert.equal(state.dirty(op,restored.final),false);
});

test('the restored editor preset is the axis nearest the saved normal',()=>{
 assert.equal(job.presetFor([0,0,1]),'Axial');assert.equal(job.presetFor([0,-1,0]),'Coronal');assert.equal(job.presetFor([1,0,0]),'Sagittal');
 assert.equal(job.presetFor(oblique.normal),'Sagittal');assert.equal(job.presetFor([.6,.8,0]),'Coronal');assert.equal(job.presetFor(null),'Axial');
});

test('the save gate refuses in order: account, busy, display, geometry, earlier request, title',async()=>{
 const snapshot=await confirmedSnapshot([{mode:'MIP',orientation:'Axial'},withVoi(perpendicular)]);
 const block=job.block(snapshot,{frameOfReference:FOR,display});
 const base={writable:true,busy:false,snapshot,frameOfReference:FOR,display,corners,pending:null,title:'MIP synthetic',retry:false};
 const gate=change=>job.saveGate({...base,...change}).message;
 assert.equal(gate({}),'');assert.ok(job.same(job.saveGate(base).block,block));
 const outside={...snapshot,final:{...snapshot.final,voiSlab:record({...perpendicular,center:[-100,15.75,40]})}};outside.applied=outside.final;
 const rendering={...snapshot,state:'pending'},other={version:12,mip:{...block,mode:'MinIP'}};
 assert.equal(gate({writable:false,busy:true,snapshot:rendering,pending:other,title:''}),job.messages.writable);
 assert.equal(gate({busy:true,snapshot:rendering,pending:other,title:''}),job.messages.busy);
 assert.equal(gate({snapshot:rendering,pending:other,title:''}),job.messages.rendering);
 assert.equal(gate({snapshot:outside,pending:other,title:''}),job.messages.outside);
 assert.equal(gate({pending:{version:12,mip:JSON.parse(JSON.stringify(block))},title:''}),job.messages.useRetry);
 assert.equal(gate({pending:other,title:''}),job.messages.useRequest);assert.equal(gate({pending:{version:undefined}}),job.messages.useRequest);
 assert.equal(gate({title:''}),job.messages.title);assert.equal(gate({title:'   '}),job.messages.title);
 // Retry resends only the identical kept body; its title is the kept one.
 assert.equal(gate({retry:true}),job.messages.retryOther);assert.equal(gate({retry:true,pending:other}),job.messages.retryOther);
 assert.equal(gate({retry:true,pending:{version:12,mip:JSON.parse(JSON.stringify(block))},title:''}),'');
});

test('Saved only after a committed receipt for the same block in the same operation; 4xx Not Saved, unknown Unconfirmed',()=>{
 const state=job.createSaveState(),op={},A={mode:'MIP',voiSlab:{center:[1,2,3]}},B={mode:'MIP',voiSlab:{center:[1,2,4]}},C={mode:'MinIP',voiSlab:null};
 state.open(op);assert.equal(state.label(op,A),'Not Saved');
 let ticket=state.begin(op,A);assert.equal(state.label(op,A),'Saving');assert.equal(state.begin(op,A),null,'one save at a time');assert.equal(state.saving(op),true);
 // Dispatch alone is not a save.
 state.end(ticket);assert.equal(state.label(op,A),'Not Saved');
 ticket=state.begin(op,A);assert.equal(state.committed(op,A),true);state.end(ticket);
 assert.equal(state.label(op,A),'Saved');assert.equal(state.label(op,B),'Not Saved','a changed display');assert.equal(state.label(op,structuredClone(A)),'Saved','a value-equal display');
 // A rejected (4xx) or mismatched receipt leaves the new block Not Saved.
 ticket=state.begin(op,B);assert.equal(state.rejected(ticket),true);state.end(ticket);assert.equal(state.label(op,B),'Not Saved');
 // An unknown receipt (abort, timeout, 5xx) keeps the body: Unconfirmed while that block is shown, then a retry commits once.
 ticket=state.begin(op,B);assert.equal(state.unknown(ticket),true);state.end(ticket);
 assert.equal(state.label(op,B),'Save Unconfirmed · Retry MIP Save');assert.equal(state.label(op,C),'Not Saved');assert.equal(state.label(op,A),'Saved');
 ticket=state.begin(op,B);state.committed(op,B);state.end(ticket);assert.equal(state.label(op,B),'Saved');assert.equal(state.label(op,A),'Not Saved','one saved block per operation');
 ticket=state.begin(op,C);state.unknown(ticket);state.end(ticket);ticket=state.begin(op,C);state.rejected(ticket);state.end(ticket);assert.equal(state.label(op,C),'Not Saved','a later 4xx clears Unconfirmed');
 // Close and reopen start Not Saved; a late receipt or ticket from the closed operation changes nothing.
 const late=state.begin(op,A),reopened={};state.open(reopened);
 assert.equal(state.label(reopened,B),'Not Saved');assert.equal(state.label(op,B),'Not Saved');
 assert.equal(state.committed(op,A),false);assert.equal(state.unknown(late),false);assert.equal(state.rejected(late),false);state.end(late);
 assert.equal(state.label(reopened,A),'Not Saved');assert.equal(state.saving(reopened),false);
 assert.equal(state.restored(reopened,A),true);assert.equal(state.label(reopened,A),'Saved');assert.equal(state.restored(op,B),false);
});

test('dirty is an open MIP with typed Job text or a confirmed VOI Slab that is not the saved one',async()=>{
 const state=job.createSaveState(),op={};
 const voiFinal=(await confirmedSnapshot([{mode:'MIP',orientation:'Axial'},withVoi(oblique)])).final;
 const plain=(await confirmedSnapshot([{mode:'Raysum',orientation:'Sagittal'}])).final;
 assert.equal(state.dirty(op,voiFinal),false,'a closed viewer loses nothing');
 state.open(op);
 assert.equal(state.dirty(op,plain),false,'mode and orientation alone are two selections');assert.equal(state.dirty(op,null),false);
 assert.equal(state.dirty(op,voiFinal),true,'an unsaved VOI Slab');
 assert.equal(state.dirty(op,plain,{title:'x'}),true);assert.equal(state.dirty(op,plain,{description:'x'}),true);
 const saved=job.block({applied:voiFinal,final:voiFinal,state:'final'},{frameOfReference:FOR,display});
 state.committed(op,JSON.parse(JSON.stringify(saved)));assert.equal(state.dirty(op,voiFinal),false,'the saved VOI Slab');
 assert.equal(state.dirty(op,mip.withDisplay(voiFinal,{mode:'MinIP'})),true,'the same slab under another projection is another block');
 state.open(null);assert.equal(state.dirty(op,voiFinal,{title:'x'}),false);
});

// A11-BATCH-1 P4: a MIP Batch preview makes the saved identity of a display the pair of its block and the preview recipe.
const RECIPE=Object.freeze({schema:1,algorithm:'kin-mip-batch-1',axis:'Horizontal',interval:90,count:4,reverse:false});
const reorderJson=v=>Array.isArray(v)?v.map(reorderJson):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort((a,b)=>a.length-b.length||(a<b?-1:a>b?1:0)).map(k=>[k,reorderJson(v[k])])):v;

test('the saved state keys the pair of block and MIP Batch recipe, also when read back in jsonb key order',async()=>{
 const block=job.block(await confirmedSnapshot([{mode:'MIP',orientation:'Axial'},withVoi(oblique)]),{frameOfReference:FOR,display});
 const withBatch=job.pair(block,RECIPE),without=job.pair(block,null);
 assert.deepEqual(Object.keys(withBatch),['mip','mipBatch']);assert.equal(job.pair(block).mipBatch,null);assert.equal(job.pair(block,undefined).mipBatch,null);assert.equal(job.pair(null,RECIPE),null);
 const state=job.createSaveState(),op={};state.open(op);
 let ticket=state.begin(op,withBatch);state.committed(op,JSON.parse(JSON.stringify(withBatch)));state.end(ticket);
 assert.equal(state.label(op,withBatch),'Saved');assert.equal(state.label(op,reorderJson(JSON.parse(JSON.stringify(withBatch)))),'Saved');
 assert.equal(state.label(op,without),'Not Saved','the same block without its preview is another display');
 assert.equal(state.label(op,job.pair(block,{...RECIPE,count:3})),'Not Saved','another recipe');assert.equal(state.label(op,block),'Not Saved','a bare block is not the pair');
 ticket=state.begin(op,without);state.committed(op,without);state.end(ticket);assert.equal(state.label(op,without),'Saved');assert.equal(state.label(op,withBatch),'Not Saved');
 assert.equal(state.restored(op,withBatch),true);assert.equal(state.label(op,withBatch),'Saved');
 ticket=state.begin(op,without);state.unknown(ticket);state.end(ticket);
 assert.equal(state.label(op,without),'Save Unconfirmed · Retry MIP Save');assert.equal(state.label(op,withBatch),'Saved');
});

test('retry needs the same pair and version; a version 12 body without a mipBatch key equals no preview (RC-2 ?? null)',async()=>{
 const snapshot=await confirmedSnapshot([{mode:'MIP',orientation:'Axial'},withVoi(perpendicular)]);
 const block=job.block(snapshot,{frameOfReference:FOR,display}),copy=JSON.parse(JSON.stringify(block));
 // The Jobs panel's pending() reads mipBatch from the kept body; a version 12 body has none.
 assert.equal(job.retryable({version:12,mip:copy,mipBatch:undefined},block,null),true);assert.equal(job.retryable({version:12,mip:copy},block,undefined),true);
 assert.equal(job.retryable({version:12,mip:copy,mipBatch:undefined},block,RECIPE),false,'a preview shown beside a version 12 body');
 assert.equal(job.retryable({version:13,mip:copy,mipBatch:{...RECIPE}},block,RECIPE),true);
 assert.equal(job.retryable({version:13,mip:copy,mipBatch:reorderJson({...RECIPE})},block,RECIPE),true);
 assert.equal(job.retryable({version:13,mip:copy,mipBatch:{...RECIPE,reverse:true}},block,RECIPE),false,'another recipe');
 assert.equal(job.retryable({version:13,mip:copy,mipBatch:{...RECIPE}},block,null),false,'the preview was cleared');
 assert.equal(job.retryable({version:12,mip:copy,mipBatch:{...RECIPE}},block,RECIPE),false,'version 12 never carries a recipe');
 assert.equal(job.retryable({version:13,mip:{...copy,mode:'MinIP'},mipBatch:{...RECIPE}},block,RECIPE),false,'another block');
 assert.equal(job.retryable(null,block,null),false);assert.equal(job.retryable({version:12,mip:copy},null,null),false);
 const base={writable:true,busy:false,snapshot,frameOfReference:FOR,display,corners,pending:null,title:'MIP batch',retry:false,batch:null};
 const gate=change=>job.saveGate({...base,...change});
 assert.equal(gate({retry:true,title:'',pending:{version:12,mip:copy,mipBatch:undefined}}).message,'','a version 12 retry without a preview');
 assert.equal(gate({retry:true,title:'',pending:{version:12,mip:copy,mipBatch:undefined},batch:RECIPE}).message,job.messages.retryOther);
 assert.equal(gate({retry:true,title:'',pending:{version:13,mip:copy,mipBatch:{...RECIPE}},batch:RECIPE}).message,'');
 assert.equal(gate({retry:true,title:'',pending:{version:13,mip:copy,mipBatch:{...RECIPE}}}).message,job.messages.retryOther,'the same block without its recipe');
 assert.equal(gate({pending:{version:13,mip:copy,mipBatch:{...RECIPE}},batch:RECIPE,title:''}).message,job.messages.useRetry);
 assert.equal(gate({pending:{version:13,mip:copy,mipBatch:{...RECIPE}},title:''}).message,job.messages.useRequest);
 const accepted=gate({batch:RECIPE});assert.equal(accepted.message,'');assert.deepEqual(accepted.batch,RECIPE);assert.ok(job.same(accepted.block,block));assert.equal(gate({}).batch,null);
 // A MIP Batch being made refuses the save right after the account and busy reasons.
 assert.equal(gate({generating:true,writable:false}).message,job.messages.writable);assert.equal(gate({generating:true,busy:true}).message,job.messages.busy);
 assert.equal(gate({generating:true,snapshot:{...snapshot,state:'pending'},title:''}).message,job.messages.generating);assert.equal(gate({generating:true}).block,null);
});

test('dirty reads the block of a saved pair, and a MIP Batch preview alone never makes the viewer dirty',async()=>{
 const voiFinal=(await confirmedSnapshot([{mode:'MIP',orientation:'Axial'},withVoi(oblique)])).final,plain=(await confirmedSnapshot([{mode:'Raysum',orientation:'Sagittal'}])).final;
 const voiBlock=job.block({applied:voiFinal,final:voiFinal,state:'final'},{frameOfReference:FOR,display}),plainBlock=job.block({applied:plain,final:plain,state:'final'},{frameOfReference:FOR,display});
 const state=job.createSaveState(),op={};state.open(op);
 assert.equal(state.dirty(op,voiFinal),true);assert.equal(state.dirty(op,plain),false);
 state.committed(op,JSON.parse(JSON.stringify(job.pair(voiBlock,RECIPE))));assert.equal(state.dirty(op,voiFinal),false,'the saved pair holds this VOI Slab');
 state.committed(op,job.pair(voiBlock,null));assert.equal(state.dirty(op,voiFinal),false);
 state.committed(op,job.pair(plainBlock,RECIPE));assert.equal(state.dirty(op,voiFinal),true,'an unsaved VOI Slab stays dirty beside a saved preview');assert.equal(state.dirty(op,plain),false);
});
