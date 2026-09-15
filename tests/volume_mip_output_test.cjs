// TEST-MIP-OUTPUT (A11-OUTPUT-1 P1): the MIP Viewer output model over the real volume-mip.js, volume-mip-job.js and volume-mip-batch.js.
// Expected vectors, depth bounds, captions and bounds are hard-coded here or derived from the stub preset literals and the synthetic
// geometry, never computed by the module under test.
const {test}=require('node:test'),assert=require('node:assert/strict');
globalThis.KinVolumeMip=require('../worklist-v0/hpacs-lite/volume-mip.js');
globalThis.KinVolumeMipJob=require('../worklist-v0/hpacs-lite/volume-mip-job.js');
globalThis.KinVolumeMipBatch=require('../worklist-v0/hpacs-lite/volume-mip-batch.js');
// Mutation runs load a changed copy; the default is always the product model.
const output=require(process.env.KIN_MIP_OUTPUT_MODEL_SOURCE||'../worklist-v0/hpacs-lite/volume-mip-output.js');
const mip=globalThis.KinVolumeMip,batch=globalThis.KinVolumeMipBatch;
// tests/viewer_volume_orientation_dom_test.py TABLE: the pinned MPR_CAMERA_VALUES as literals.
const TABLE=Object.freeze({axial:{viewPlaneNormal:[0,0,-1],viewUp:[0,-1,0]},sagittal:{viewPlaneNormal:[1,0,0],viewUp:[0,0,1]},coronal:{viewPlaneNormal:[0,1,0],viewUp:[0,0,1]}});
const PRESETS=[['Axial','axial'],['Coronal','coronal'],['Sagittal','sagittal']];
const near=(actual,want,tolerance,label)=>{assert.equal(actual.length,want.length,label);actual.forEach((n,i)=>assert.ok(Math.abs(n-want[i])<=tolerance,label+'['+i+'] '+n+' != '+want[i]));};
const same=(a,b)=>a.length===b.length&&a.every((n,i)=>n===b[i]);
// The known-voxel phantom of tests/e2e/test_volume_mip.py (64 x 64 x 33 voxels, 0.5/0.5/2.5 mm, identity axes) and a shifted anisotropic one.
function geometry(dimensions,spacing,origin){
 const toWorld=index=>index.map((n,k)=>origin[k]+n*spacing[k]);
 return {dimensions,spacing,toWorld,corners:mip.corners(dimensions,toWorld),direction:[1,0,0,0,1,0,0,0,1],
  focal:dimensions.map((d,k)=>origin[k]+(d-1)*spacing[k]/2),thickness:Math.min(1000,Math.hypot(...dimensions.map((d,k)=>(d-1)*spacing[k])))};
}
const PHANTOM=geometry([64,64,33],[.5,.5,2.5],[0,0,0]),SHIFTED=geometry([51,47,20],[.7,.65,3],[-120.5,33.25,7]);
const recipe=(over={})=>({schema:1,algorithm:'kin-mip-batch-1',axis:'Horizontal',interval:10,count:2,reverse:false,...over});
const block=(over={})=>({schema:1,algorithm:'kin-mip-1',coordinates:'LPS_mm',frameOfReference:'1.2.9',mode:'Raysum',orientation:'Coronal',
 display:{voiRange:{lower:-160,upper:240},interpolationType:1},voiSlab:{center:[15.75,15.75,40],normal:[0,0,1],pivot:[15.75,15.75,40],thickness:20},...over});
const snapshot=(version,over={})=>({version,studies:['1.2.3'],rows:1,cols:3,active:0,cells:[],volume:{},mip:block(),...(version===13?{mipBatch:recipe({interval:90,count:4})}:{}),...over});

test('C5: the version 12 camera is KinVolumeMipBatch.plan frame 0 on every component, for every preset and both axes',()=>{
 for(const g of [PHANTOM,SHIFTED])for(const [orientation,key] of PRESETS){
  const axes=output.direction('kin-mip-1',orientation,TABLE);
  assert.deepEqual([[...axes.viewPlaneNormal],[...axes.viewUp]],[TABLE[key].viewPlaneNormal,TABLE[key].viewUp],orientation);
  const inputs={normal:axes.viewPlaneNormal,viewUp:axes.viewUp,focalPoint:g.focal,distance:g.thickness,thickness:g.thickness};
  const single=output.plan({version:12,...inputs});assert.equal(single.cameras.length,1);const camera=single.cameras[0];
  // Written out: position f + n0 * D with D = t, parallel scale t/2, the preset direction itself.
  near(camera.position,g.focal.map((x,k)=>x+TABLE[key].viewPlaneNormal[k]*g.thickness),1e-12,orientation+' position');
  near(camera.focalPoint,g.focal,0,orientation+' focal');near(camera.viewPlaneNormal,TABLE[key].viewPlaneNormal,0,orientation+' normal');near(camera.viewUp,TABLE[key].viewUp,0,orientation+' up');
  assert.equal(camera.parallelScale,g.thickness/2);assert.equal(single.distance,g.thickness);
  for(const axis of ['Horizontal','Vertical']){
   const tag=orientation+' '+axis,first=batch.plan({recipe:recipe({axis}),...inputs}).cameras[0];
   for(const field of ['focalPoint','position','viewPlaneNormal','viewUp'])assert.ok(same(camera[field],first[field]),tag+' '+field+' '+camera[field]+' !== '+first[field]);
   assert.ok(camera.parallelScale===first.parallelScale,tag+' parallelScale');assert.ok(camera.index===first.index&&camera.angle===first.angle,tag+' frame index');
   // Version 13 is that plan unchanged, frame by frame.
   const over={axis,count:3,interval:45},via=output.plan({version:13,recipe:recipe(over),...inputs}).cameras,direct=batch.plan({recipe:recipe(over),...inputs}).cameras;
   assert.equal(via.length,3);
   via.forEach((c,i)=>{for(const field of ['focalPoint','position','viewPlaneNormal','viewUp'])assert.ok(same(c[field],direct[i][field]),tag+' frame '+i+' '+field);assert.ok(c.parallelScale===direct[i].parallelScale&&c.angle===direct[i].angle,tag+' frame '+i);});
  }
 }
});

test('C5/MO4: a version 12 plan refuses exactly the inputs the MIP Batch plan refuses, with the output wording',()=>{
 const t=PHANTOM.thickness,base={normal:[0,1,0],viewUp:[0,0,1],focalPoint:PHANTOM.focal,distance:t,thickness:t};
 for(const [change,kind] of [[{distance:t/2},'distance'],[{distance:t/4},'distance'],[{distance:0},'distance'],[{distance:NaN},'distance'],[{distance:Infinity},'distance'],[{distance:String(t)},'distance'],
   [{normal:[0,1.01,0]},'camera'],[{viewUp:[0,1,0]},'camera'],[{viewUp:[0,.001,1]},'camera'],[{focalPoint:[0,0]},'camera'],[{focalPoint:[0,NaN,0]},'camera'],[{thickness:0},'camera'],[{thickness:NaN},'camera']]){
  const label=JSON.stringify(change);
  assert.throws(()=>batch.plan({recipe:recipe(),...base,...change}),undefined,'batch '+label);
  assert.throws(()=>output.plan({version:12,...base,...change}),{message:output.messages[kind]},'version 12 '+label);
  assert.throws(()=>output.plan({version:13,recipe:recipe(),...base,...change}),{message:output.messages[kind]},'version 13 '+label);
 }
 assert.equal(output.plan({version:12,...base,distance:t/2+2e-6}).distance,t/2+2e-6);
 assert.throws(()=>output.plan({version:12,recipe:recipe(),...base}),{message:output.messages.shape});
 assert.throws(()=>output.plan({version:14,...base}),{message:output.messages.shape});
});

test('MO3: version 13 Coronal Horizontal +90 turns about viewUp and Vertical +90 about the screen right (hard-coded vectors)',()=>{
 const t=PHANTOM.thickness,inputs={normal:TABLE.coronal.viewPlaneNormal,viewUp:TABLE.coronal.viewUp,focalPoint:PHANTOM.focal,distance:t,thickness:t};
 const H=output.plan({version:13,recipe:recipe({interval:90,count:2}),...inputs}).cameras[1];
 near(H.viewPlaneNormal,[-1,0,0],1e-12,'H +90 n');near(H.viewUp,[0,0,1],1e-12,'H +90 u');near(H.position,[15.75-t,15.75,40],1e-9,'H +90 position');
 near(H.focalPoint,[15.75,15.75,40],0,'H +90 focal');assert.equal(H.parallelScale,t/2);assert.equal(H.angle,90);
 const V=output.plan({version:13,recipe:recipe({axis:'Vertical',interval:90,count:2}),...inputs}).cameras[1];
 near(V.viewPlaneNormal,[0,0,-1],1e-12,'V +90 n');near(V.viewUp,[0,1,0],1e-12,'V +90 u');near(V.position,[15.75,15.75,40-t],1e-9,'V +90 position');assert.equal(V.angle,90);
 const R=output.plan({version:13,recipe:recipe({interval:90,count:2,reverse:true}),...inputs}).cameras[1];
 near(R.viewPlaneNormal,[1,0,0],1e-12,'H -90 n');assert.equal(R.angle,-90);
});

test('frames on the print volume: f is the voxel-centre box centre, D = t, and blend and sample distance follow the saved display',()=>{
 const g=PHANTOM,t=Math.hypot(31.5,31.5,80),geo={dimensions:g.dimensions,spacing:g.spacing,corners:g.corners};
 const v13=output.frames({saved:output.saved(snapshot(13)),values:TABLE,...geo});
 assert.ok(Math.abs(v13.thickness-t)<=1e-12);assert.equal(v13.distance,v13.thickness);assert.equal(v13.parallelScale,v13.thickness/2);
 assert.equal(v13.blend,3);assert.ok(Math.abs(v13.sampleDistance-3.5/6)<=1e-15);assert.equal(v13.cameras.length,4);
 near(v13.cameras[0].focalPoint,[15.75,15.75,40],1e-12,'focal');near(v13.cameras[0].viewPlaneNormal,[0,1,0],0,'Coronal frame 0');near(v13.cameras[0].position,[15.75,15.75+t,40],1e-9,'frame 0 position');
 const v12=output.frames({saved:output.saved(snapshot(12,{mip:block({mode:'MinIP',orientation:'Sagittal'})})),values:TABLE,...geo});
 assert.equal(v12.blend,2);assert.equal(v12.cameras.length,1);near(v12.cameras[0].viewPlaneNormal,[1,0,0],0,'Sagittal');near(v12.cameras[0].position,[15.75+t,15.75,40],1e-9,'version 12 position');
 assert.throws(()=>output.frames({saved:output.saved(snapshot(12)),values:{},...geo}),{message:/방향 기준값/});
 assert.throws(()=>output.frames({saved:output.saved(snapshot(12)),values:TABLE,...geo,corners:g.corners.slice(1)}),{message:output.messages.camera});
});

test('C1/MO4b: the depth range must cover the voxel-centre box plus its projected half voxel, capped at the whole-volume slab',()=>{
 const g=PHANTOM,t=g.thickness,D=t,ok='',no=output.messages.clip;
 const clip=(range,normal=[0,0,-1],over={})=>output.verifyClip({range,camera:{viewPlaneNormal:normal,focalPoint:g.focal},corners:g.corners,direction:g.direction,spacing:g.spacing,thickness:t,distance:D,...over});
 // Axial: h0 = 40 mm (32 slice gaps x 2.5 / 2), e = 2.5 / 2 = 1.25 mm, so m = 41.250001 mm, below t/2 = 45.78 mm.
 const m=41.25+1e-6;assert.ok(m<t/2);
 for(const [label,range,want] of [
   ['containing the slab',[D-t/2-1,D+t/2+1],ok],['exactly the slab',[D-t/2,D+t/2],ok],['a huge default range',[-1e5,1e5],ok],
   ['tightened to the box plus half voxel',[D-m,D+m],ok],
   ['near cuts the voxel-centre box',[D-39,D+60],no],['far cuts the voxel-centre box',[D-60,D+39],no],
   ['zero-margin corner interval',[D-40-2e-6,D+40+2e-6],no],['near inside the half-voxel band',[D-41,D+60],no],['far inside the half-voxel band',[D-60,D+41.2],no],
   ['near 1e-7 inside the margin',[D-m+1e-7,D+60],no],
   ['missing',undefined,no],['null',null,no],['empty',[],no],['one value',[D-60],no],['three values',[D-60,D+60,1],no],['text',['0','200'],no],
   ['NaN near',[NaN,D+60],no],['Infinity far',[D-60,Infinity],no],['-Infinity near',[-Infinity,D+60],no],
   ['near equals far',[D,D],no],['near beyond far',[D+60,D-60],no]])
  assert.equal(clip(range),want,label);
 assert.ok(D-m>D-t/2,'the tightened range is one that full-slab containment would falsely refuse');
 // Sagittal and Coronal: h0 = 15.75 mm, e = 0.5 / 2 = 0.25 mm.
 for(const normal of [[1,0,0],[0,1,0]]){
  assert.equal(clip([D-16-1e-6,D+16+1e-6],normal),ok,'tightened '+normal);assert.equal(clip([D-15.9,D+60],normal),no,'half-voxel band '+normal);assert.equal(clip([D-15.7,D+60],normal),no,'box '+normal);
 }
 // Along the box diagonal every corner is t/2 from the centre, so m = t/2: only a range holding the whole slab passes.
 const diagonal=[31.5/t,31.5/t,80/t];
 assert.equal(clip([D-t/2,D+t/2],diagonal),ok,'diagonal slab');assert.equal(clip([D-t/2+1e-3,D+t/2],diagonal),no,'diagonal near');assert.equal(clip([D-t/2,D+t/2-1e-3],diagonal),no,'diagonal far');
 // An oblique ray projects every spacing: h0 = (15.75 + 40) / sqrt 2, e = (0.5 + 2.5) / 2 / sqrt 2.
 const tilted=[Math.SQRT1_2,0,Math.SQRT1_2],h=(15.75+40)*Math.SQRT1_2,e=(.5+2.5)/2*Math.SQRT1_2,mt=h+e+1e-6;
 assert.equal(clip([D-mt-1e-9,D+mt+1e-9],tilted),ok,'oblique tightened');assert.equal(clip([D-h-e/2,D+60],tilted),no,'oblique half-voxel band');
 for(const [label,over] of [['short direction',{direction:[1,0,0,0,1,0,0,0]}],['zero spacing',{spacing:[.5,0,2.5]}],['seven corners',{corners:g.corners.slice(1)}],
   ['distance',{distance:NaN}],['thickness',{thickness:0}],['camera',{camera:{viewPlaneNormal:[0,0],focalPoint:g.focal}}]])
  assert.equal(clip([-1e5,1e5],[0,0,-1],over),no,label);
 assert.equal(output.messages.clip,'MIP 출력 투영 깊이 범위를 확인하지 못했습니다.');
});

test('C3/MO6b: the display reads back LINEAR, not inverted and Grayscale; any other or missing field refuses',()=>{
 const good={VOILUTFunction:'LINEAR',invert:false,colormap:{name:'Grayscale',opacity:1},voiRange:{lower:-160,upper:240}};
 assert.equal(output.verifyDisplay(good),'');
 for(const [label,value] of [['SIGMOID',{...good,VOILUTFunction:'SIGMOID'}],['invert true',{...good,invert:true}],['invert missing',(({invert,...rest})=>rest)(good)],['invert undefined',{...good,invert:undefined}],
   ['invert 0',{...good,invert:0}],['VOILUTFunction missing',(({VOILUTFunction,...rest})=>rest)(good)],['lower-case linear',{...good,VOILUTFunction:'linear'}],
   ['colormap missing',(({colormap,...rest})=>rest)(good)],['colormap hsv',{...good,colormap:{name:'hsv'}}],['colormap without name',{...good,colormap:{opacity:1}}],['null',null],['undefined',undefined]])
  assert.equal(output.verifyDisplay(value),output.messages.display,label);
 assert.equal(output.messages.display,'MIP 출력 표시 속성을 확인하지 못했습니다.');
});

test('saved Job and binding refusals: unknown algorithms, version and recipe shape, Frame of Reference, a slab outside the volume',()=>{
 const m=output.messages;
 assert.equal(output.saved(snapshot(12)).recipe,null);assert.deepEqual({...output.saved(snapshot(13)).recipe},recipe({interval:90,count:4}));
 for(const [label,value,message] of [
   ['unknown mip algorithm',snapshot(12,{mip:block({algorithm:'kin-mip-2'})}),m.reproduce],['mip schema 2',snapshot(13,{mip:block({schema:2})}),m.reproduce],
   ['unknown mipBatch algorithm',snapshot(13,{mipBatch:recipe({algorithm:'kin-mip-batch-2'})}),m.reproduce],['mipBatch schema 2',snapshot(13,{mipBatch:recipe({schema:2})}),m.reproduce],
   ['version 12 with mipBatch',{...snapshot(12),mipBatch:recipe()},m.shape],['version 12 with a null mipBatch',{...snapshot(12),mipBatch:null},m.shape],
   ['version 13 without mipBatch',(({mipBatch,...rest})=>rest)(snapshot(13)),m.shape],['version 13 with a null mipBatch',snapshot(13,{mipBatch:null}),m.shape],
   ['version 13 recipe count 1',snapshot(13,{mipBatch:recipe({count:1})}),m.shape],['malformed mip',snapshot(12,{mip:{...block(),history:[]}}),m.shape],
   ['missing mip',(({mip:_,...rest})=>rest)(snapshot(12)),m.shape],['version 4',{...snapshot(12),version:4},m.shape],['version 14',{...snapshot(13),version:14},m.shape],['null',null,m.shape]])
  assert.throws(()=>output.saved(value),{message},label);
 assert.equal(m.reproduce,'MIP 작업의 계산 방식을 이 뷰어가 재현할 수 없어 출력하지 않았습니다.');
 assert.throws(()=>output.direction('kin-mip-2','Axial',TABLE),{message:m.reproduce});
 const g=PHANTOM,affine=mip.affine(g.toWorld),args={saved:output.saved(snapshot(12)),frameOfReference:'1.2.9',volumeId:'kin-batch-print-test',affine,corners:g.corners};
 const request=output.bind(args);
 assert.equal(request.voiSlab.volumeId,'kin-batch-print-test');assert.deepEqual([...request.voiSlab.affine],[...affine]);
 assert.equal(mip.verifyBinding(request.voiSlab,{volumeId:'kin-batch-print-test',affine}),'');assert.deepEqual([...request.voiSlab.center],[15.75,15.75,40]);
 assert.equal(output.bind({...args,saved:output.saved(snapshot(12,{mip:block({voiSlab:null})}))}).voiSlab,null);
 assert.throws(()=>output.bind({...args,frameOfReference:'2.25.1234'}),{message:m.frame});assert.throws(()=>output.bind({...args,frameOfReference:undefined}),{message:m.frame});
 assert.throws(()=>output.bind({...args,saved:output.saved(snapshot(12,{mip:block({voiSlab:{center:[500,500,500],normal:[0,0,1],pivot:[500,500,500],thickness:20}})}))}),{message:m.outside});
 assert.throws(()=>output.bind({...args,affine:[1,2,3]}),{message:m.shape});
 // Version 12 never needs the MIP Batch model; version 13 is refused without it.
 const held=globalThis.KinVolumeMipBatch;delete globalThis.KinVolumeMipBatch;
 try{
  assert.equal(output.saved(snapshot(12)).version,12);
  assert.equal(output.frames({saved:output.saved(snapshot(12)),values:TABLE,dimensions:g.dimensions,spacing:g.spacing,corners:g.corners}).cameras.length,1);
  assert.throws(()=>output.saved(snapshot(13)),{message:m.batchTool});assert.throws(()=>output.timer(13,4),{message:m.batchTool});assert.equal(output.timer(12),120000);
 }finally{globalThis.KinVolumeMipBatch=held;}
});

test('a version 12 frame camera follows the MIP Batch 1e-6 readback rule exactly',()=>{
 const g=PHANTOM,want=output.plan({version:12,normal:[0,0,-1],viewUp:[0,-1,0],focalPoint:g.focal,distance:g.thickness,thickness:g.thickness}).cameras[0];
 const clone=change=>{const c=JSON.parse(JSON.stringify(want));change(c);return c;};
 for(const [label,actual,accepted] of [['exact',clone(()=>{}),true],['within 5e-7',clone(c=>{c.position[0]+=5e-7;c.parallelScale-=5e-7;c.viewUp[1]+=5e-7;}),true],
   ['position 2e-6',clone(c=>{c.position[0]+=2e-6;}),false],['camera at t/4',clone(c=>{c.position=c.focalPoint.map((x,k)=>x+c.viewPlaneNormal[k]*g.thickness/4);}),false],
   ['focal point 2e-6',clone(c=>{c.focalPoint[2]+=2e-6;}),false],['normal 2e-6',clone(c=>{c.viewPlaneNormal[1]+=2e-6;}),false],['viewUp 2e-6',clone(c=>{c.viewUp[0]+=2e-6;}),false],
   ['parallel scale 2e-6',clone(c=>{c.parallelScale+=2e-6;}),false],['missing position',clone(c=>{delete c.position;}),false],['short vector',clone(c=>{c.viewUp=[0,0];}),false],['null',null,false]]){
  assert.equal(output.verifyCamera(actual,want),accepted?'':output.messages.frameCamera,label);
  assert.equal(batch.verifyCamera(actual,want)==='',accepted,label+' agrees with KinVolumeMipBatch.verifyCamera');
 }
});

test('C2: captions name frame, display, axis with signed angle, VOI Slab and raster; the VOI range is never labelled W/L',()=>{
 assert.equal(output.caption({version:13,index:1,count:4,mode:'Raysum',orientation:'Coronal',axis:'Horizontal',angle:90,voiThickness:14}),'Frame 2 / 4 · Raysum · Coronal · Horizontal +90° · VOI Slab 14 mm · 512 × 512');
 assert.equal(output.caption({version:13,index:0,count:3,mode:'MinIP',orientation:'Sagittal',axis:'Vertical',angle:0,voiThickness:null}),'Frame 1 / 3 · MinIP · Sagittal · Vertical 0° · VOI Slab Off · 512 × 512');
 assert.equal(output.caption({version:13,index:2,count:3,mode:'MIP',orientation:'Axial',axis:'Vertical',angle:-90,voiThickness:22.25}),'Frame 3 / 3 · MIP · Axial · Vertical -90° · VOI Slab 22.3 mm · 512 × 512');
 assert.equal(output.caption({version:12,index:0,count:1,mode:'MIP',orientation:'Axial',angle:0,voiThickness:20}),'MIP Viewer · MIP · Axial · VOI Slab 20 mm · 512 × 512');
 assert.throws(()=>output.caption({version:4,index:0,count:1}),{message:output.messages.shape});
 const text=output.displayCaption({lower:-160,upper:240},{VOILUTFunction:'LINEAR',invert:false});
 assert.equal(text,'VOI -160 ~ 240 (LINEAR) · Normal grayscale');assert.doesNotMatch(text,/W\/L|\bW -?\d|\bL -?\d/);
});

test('supports exactly versions 12 and 13; the outer bound is 120 s, plus min(count x 15 s, 300 s) for version 13, with its own timeout message',()=>{
 for(const version of [12,13])assert.equal(output.supports(version),true);
 for(const version of [1,2,3,4,5,6,7,8,9,10,11,14,'12',12.5,null,undefined])assert.equal(output.supports(version),false,String(version));
 assert.equal(output.timer(12),120000);assert.deepEqual([2,20,21,64].map(count=>output.timer(13,count)),[150000,420000,420000,420000]);
 assert.equal(output.timer(13),420000,'before its recipe is read, the bound of the largest recipe');
 for(const bad of [1,65,2.5,'4',NaN,null])assert.throws(()=>output.timer(13,bad),undefined,String(bad));
 for(const version of [4,6,11,14])assert.throws(()=>output.timer(version),{message:output.messages.shape});
 assert.equal(output.messages.timeout,'MIP 출력 준비 시간이 지났습니다. 다시 확인하세요.');assert.equal(output.messages.preRender,'MIP 출력 준비 렌더를 확인하지 못했습니다.');
 assert.deepEqual([output.frameMs,output.preRenderMs,output.size],[15000,5000,512]);assert.ok(Object.isFrozen(output)&&Object.isFrozen(output.messages));
});

test('encoded frames share a 32 MiB budget: exactly 32 MiB passes, one byte more or a non-finite size refuses',()=>{
 const cap=32*1024*1024;assert.equal(output.blobBytes,cap);
 assert.equal(output.bytes(0,cap),cap);assert.equal(output.bytes(cap-10,10),cap);assert.equal(output.bytes(1000,2000),3000);
 for(const [total,size] of [[cap,1],[0,cap+1],[cap-1,2],[0,NaN],[0,-1],[NaN,1],[0,Infinity]])assert.throws(()=>output.bytes(total,size),{message:output.messages.memory},total+'+'+size);
});
