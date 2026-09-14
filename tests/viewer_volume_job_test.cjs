// TEST-VOLUME-JOB: compiled server parser and full-volume reference validation.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {jobCommand}=require('/app/dist/viewer-job-input.js');
const {verifyVolumeReference,compactVolumeTags}=require('/app/dist/viewer-volume-reference.js');
const volume={study:'2.25.1',series:'2.25.2',sops:['2.25.3','2.25.4','2.25.5']};
const cell={study:volume.study,series:volume.series,viewport:{width:256,height:256},projection:{blend:3,thickness:2},camera:{focalPoint:[0,0,1],position:[0,0,101],viewUp:[0,1,0],viewPlaneNormal:[0,0,1],parallelScale:128,rotation:0,flipHorizontal:false,flipVertical:false},properties:{voiRange:{lower:-1000,upper:1000},VOILUTFunction:'LINEAR',invert:false,interpolationType:0}};
const snapshot={version:4,studies:[volume.study],volume,rows:1,cols:3,active:0,cells:[cell,cell,cell]};
const command=s=>jobCommand(Buffer.from(JSON.stringify({id:'00000000-0000-4000-8000-000000000001',title:'MPR',description:'',snapshot:s})),true);
const tags=volume.sops.map((sop,i)=>({StudyInstanceUID:volume.study,SeriesInstanceUID:volume.series,SOPInstanceUID:sop,PatientID:'SYNTHETIC',SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2',FrameOfReferenceUID:'2.25.6',Rows:32,Columns:32,ImageOrientationPatient:'1\\0\\0\\0\\1\\0',ImagePositionPatient:'0\\0\\'+i,PixelSpacing:'1\\1',RescaleSlope:1,RescaleIntercept:-1000,BitsAllocated:16,BitsStored:16,HighBit:15,PixelRepresentation:0,_kinSourceDigest:String(i).repeat(32)}));
const rejected=fn=>assert.throws(fn,e=>e.getStatus?.()===400);
test('MPR snapshot never accepts fabricated frame references or server digest',()=>{
 assert.equal(command(snapshot).snapshot.version,4);
 for(const change of [s=>s.cells[0].sop=volume.sops[0],s=>s.volume.sourceDigest='forged',s=>s.volume.sops.pop(),s=>s.cells[0].projection.thickness=Infinity,s=>s.cells[0].camera.viewUp=[0,0,1],s=>s.cells[0].study='2.25.99',s=>s.cells[1]=null]){
  const s=structuredClone(snapshot);change(s);
  // Two frames remain syntactically valid; completeness is enforced against Orthanc.
  if(s.volume.sops.length===2)assert.equal(command(s).snapshot.volume.sops.length,2);else rejected(()=>command(s));
 }
 rejected(()=>command(null));
});
test('whole-volume digest detects an interior original change',()=>{
 const first=verifyVolumeReference(snapshot,tags,'SYNTHETIC'),modified=structuredClone(tags);modified[1]._kinSourceDigest='a'.repeat(32);
 assert.match(first,/^[a-f0-9]{64}$/);assert.notEqual(verifyVolumeReference(snapshot,modified,'SYNTHETIC'),first);
});
test('missing, irregular, foreign, duplicate and tilted original geometry is rejected',()=>{
 for(const change of [t=>t.pop(),t=>t[1].ImagePositionPatient='0\\0\\1.1',t=>t[1].PatientID='OTHER',t=>t[1].SOPInstanceUID=t[0].SOPInstanceUID,t=>t[1].ImagePositionPatient='1\\0\\1',t=>t[1].RescaleSlope=2,t=>t[1].NumberOfFrames=0]){
  const t=structuredClone(tags);change(t);rejected(()=>verifyVolumeReference(snapshot,t,'SYNTHETIC'));
 }
});
test('volume tag retention is bounded and discards unused DICOM fields',()=>{
 const compact=compactVolumeTags({...tags[0],PatientName:'x'.repeat(100000)});
 assert.equal(compact.PatientName,undefined);assert.equal(compact.SOPInstanceUID,tags[0].SOPInstanceUID);
 rejected(()=>compactVolumeTags({...tags[0],PatientID:'x'.repeat(257)}));
 rejected(()=>compactVolumeTags({...tags[0],ImagePositionPatient:Array(17).fill(0)}));
});
test('physical slab bound and ordered volume identity are checked',()=>{
 const s=structuredClone(snapshot);s.cells[0].projection.thickness=100;rejected(()=>verifyVolumeReference(s,tags,'SYNTHETIC'));
 const reversed=structuredClone(snapshot);reversed.volume.sops.reverse();assert.match(verifyVolumeReference(reversed,[...tags].reverse(),'SYNTHETIC'),/^[a-f0-9]{64}$/);
 const wrong=[tags[1],tags[0],tags[2]];rejected(()=>verifyVolumeReference(snapshot,wrong,'SYNTHETIC'));
});
// Version 7 is the Hanging Protocol plane layout: the same one CT volume on 1x1/1x2/2x2 as
// well as 1x3/3x1, null vacancies, and an explicit orientation on every real cell.
const plane=o=>({...structuredClone(cell),orientation:o});
const layout={version:7,studies:[volume.study],volume,rows:2,cols:2,active:3,
 cells:[plane('axial'),plane('sagittal'),plane('coronal'),null]};
test('the plane layout saves vacancies and an explicit orientation on the accepted grids',()=>{
 assert.equal(command(layout).snapshot.version,7);
 for(const [rows,cols,cells] of [[1,1,[plane('axial')]],[1,2,[plane('coronal'),null]],
   [1,3,[plane('axial'),null,plane('coronal')]],[3,1,[null,plane('axial'),plane('sagittal')]],
   [2,2,[null,null,null,plane('axial')]]]){
  const s={...structuredClone(layout),rows,cols,active:cells.length-1,cells};
  assert.equal(command(s).snapshot.cells.length,rows*cols);
 }
 // A vacancy may hold the active index; the cell list still covers the whole grid.
 const vacant=structuredClone(layout);assert.equal(command(vacant).snapshot.cells[3],null);
 assert.match(verifyVolumeReference(layout,tags,'SYNTHETIC'),/^[a-f0-9]{64}$/);
 const thick=structuredClone(layout);thick.cells[0].projection.thickness=100;
 rejected(()=>verifyVolumeReference(thick,tags,'SYNTHETIC'));
});
test('the plane layout refuses an unlisted grid, a nameless plane and an emptied screen',()=>{
 for(const change of [s=>{s.rows=2;s.cols=1;s.cells=[plane('axial'),null];s.active=0;},
   s=>{s.rows=3;s.cols=3;s.cells=[plane('axial'),...Array(8).fill(null)];s.active=0;},
   s=>delete s.cells[0].orientation,s=>s.cells[0].orientation='oblique',s=>s.cells[0].orientation=null,
   s=>s.cells=[null,null,null,null],s=>s.active=4,s=>s.cells[0].sop=volume.sops[0],
   s=>s.cells.pop(),s=>s.batch={cell:plane('axial'),offset:0,interval:1,count:2,reverse:false},
   s=>s.marks={version:1,visible:true,sync:true,marks:[]},s=>delete s.volume]){
  const s=structuredClone(layout);change(s);rejected(()=>command(s));
 }
});
// Version 8 is the mixed Hanging Protocol layout: plane cells of that same one volume beside
// ordinary frame cells, on the Hanging Protocol grids only. Every non-null cell names its own
// kind, so the server never infers a cell shape from the snapshot version alone.
const frame={study:volume.study,series:'2.25.7',sop:'2.25.8',frame:1,viewport:{width:256,height:256},camera:{focalPoint:[0,0,1],position:[0,0,101],viewUp:[0,1,0],viewPlaneNormal:[0,0,1],parallelScale:128,rotation:0,flipHorizontal:false,flipVertical:false},properties:{voiRange:{lower:-1000,upper:1000},VOILUTFunction:'LINEAR',invert:false,interpolationType:0}};
const planeOf=o=>({kind:'plane',...structuredClone(cell),orientation:o});
const frameOf=()=>({kind:'stack',...structuredClone(frame)});
const mixed={version:8,studies:[volume.study],volume,rows:2,cols:2,active:1,
 cells:[planeOf('axial'),frameOf(),planeOf('coronal'),null]};
const stackOnly={version:2,studies:[volume.study],rows:1,cols:2,active:0,cells:[structuredClone(frame),null]};
test('the mixed layout keeps both cell shapes with an explicit kind and one volume',()=>{
 assert.equal(command(mixed).snapshot.version,8);
 for(const [rows,cols,active,cells] of [[1,2,0,[frameOf(),planeOf('axial')]],
   [2,2,3,[planeOf('sagittal'),null,frameOf(),null]],[2,2,0,[frameOf(),frameOf(),planeOf('axial'),null]]]){
  const s={...structuredClone(mixed),rows,cols,active,cells};
  assert.equal(command(s).snapshot.cells.length,rows*cols);
 }
 // The frame cell carries no slab, so the physical bound only judges the real planes and
 // cannot dereference a projection that a frame cell never had.
 assert.match(verifyVolumeReference(mixed,tags,'SYNTHETIC'),/^[a-f0-9]{64}$/);
 const thick=structuredClone(mixed);thick.cells[0].projection.thickness=100;
 rejected(()=>verifyVolumeReference(thick,tags,'SYNTHETIC'));
});
test('the mixed layout refuses an unnamed kind, a layout that is not mixed and a foreign grid',()=>{
 // An unnamed kind on a layout that is otherwise properly mixed must be refused on its own
 // merit: the mixture rule is already satisfied by the other cells and cannot catch it.
 for(const change of [s=>delete s.cells[0].kind,s=>s.cells[1].kind='frame',s=>s.cells[0].kind='stack',
   s=>{s.cells[3]={kind:'frame',...structuredClone(frame)};},s=>{s.cells[3]={...structuredClone(frame)};},
   s=>s.cells[1]=planeOf('sagittal'),s=>{s.cells=[frameOf(),frameOf(),frameOf(),null];},
   s=>{s.rows=1;s.cols=3;s.cells=[planeOf('axial'),frameOf(),planeOf('coronal')];},
   s=>{s.rows=2;s.cols=1;s.cells=[planeOf('axial'),frameOf()];s.active=0;},
   s=>{s.rows=3;s.cols=3;s.cells=[planeOf('axial'),frameOf(),...Array(7).fill(null)];},
   s=>s.cells[0].sop=volume.sops[0],s=>delete s.cells[0].orientation,s=>s.cells[1].orientation='axial',
   s=>s.cells[1].frame=2,s=>delete s.cells[1].sop,s=>s.cells[0].series='2.25.99',
   s=>s.cells[1].study='2.25.99',s=>delete s.volume,s=>s.active=4,s=>s.cells.pop(),
   s=>s.batch={cell:planeOf('axial'),offset:0,interval:1,count:2,reverse:false},
   s=>s.marks={version:1,visible:true,sync:true,marks:[]}]){
  const s=structuredClone(mixed);change(s);rejected(()=>command(s));
 }
});
test('the established shapes refuse a cell kind and the mixed shape stays out of them',()=>{
 assert.equal(command(stackOnly).snapshot.version,2);
 // No version but 8 admits a kind key, in either direction.
 for(const [base,change] of [[stackOnly,s=>s.cells[0].kind='stack'],[stackOnly,s=>s.cells[0].kind='plane'],
   [layout,s=>s.cells[0].kind='plane'],[snapshot,s=>s.cells[0].kind='plane']]){
  const s=structuredClone(base);change(s);rejected(()=>command(s));
 }
 // A version 2 layout carries no volume, so its cells can never claim the mixed shape.
 const forged=structuredClone(stackOnly);forged.version=8;rejected(()=>command(forged));
});
test('the three-plane versions keep their exact shape beside the new layout',()=>{
 for(const version of [4,5,6]){
  const s=structuredClone(snapshot);s.version=version;
  if(version>=5)s.batch={cell:structuredClone(cell),offset:-1,interval:1,count:3,reverse:false};
  if(version===6)s.marks={version:1,visible:true,sync:true,marks:[]};
  assert.equal(command(s).snapshot.version,version);
  // No orientation key, no vacancy and no other grid enters versions 4-6.
  for(const change of [x=>x.cells[0].orientation='axial',x=>x.cells[2]=null,
    x=>{x.rows=2;x.cols=2;x.cells.push(structuredClone(cell));}]){
   const bad=structuredClone(s);change(bad);rejected(()=>command(bad));
  }
 }
});
// Version 9 is the merged cell layout: the base grid stays, the cells sit in the fractional
// rectangles viewer-cell-merge.js dispatches, and geometry is carried by `rects` so that an
// empty survivor of a row or column merge still occupies one. A merged layout of ordinary
// frame cells alone carries no volume at all.
const rect=(x,y,width,height)=>({x,y,width,height});
const MAXIMIZE=[rect(0,0,1,1)];
const COLUMN_LEFT=[rect(0,0,.5,1),rect(.5,0,.5,.5),rect(.5,.5,.5,.5)];
const COLUMN_RIGHT=[rect(0,0,.5,.5),rect(.5,0,.5,1),rect(0,.5,.5,.5)];
const ROW_TOP=[rect(0,0,1,.5),rect(0,.5,.5,.5),rect(.5,.5,.5,.5)];
const ROW_BOTTOM=[rect(0,0,.5,.5),rect(.5,0,.5,.5),rect(0,.5,1,.5)];
const mergedJob=(rows,cols,rects,cells,hasVolume=true)=>({version:9,studies:[volume.study],
 volume:hasVolume?structuredClone(volume):null,rows,cols,rects:structuredClone(rects),active:0,cells});
const maximized=mergedJob(2,2,MAXIMIZE,[planeOf('axial')]);
// The label names which geometry was refused, so a case that starts passing says which one.
const refused=(label,fn)=>assert.throws(fn,e=>e.getStatus?.()===400,label);
test('the merged layout saves the rectangles the viewer actually dispatches',()=>{
 assert.equal(command(maximized).snapshot.version,9);
 // The parser builds null-prototype objects, so the rectangles are compared by value.
 assert.equal(JSON.stringify(command(maximized).snapshot.rects),JSON.stringify(MAXIMIZE));
 // Maximize is reachable from every base grid the merge module allows.
 for(const [rows,cols] of [[1,2],[2,1],[2,2],[1,3],[3,1]])
  assert.equal(command(mergedJob(rows,cols,MAXIMIZE,[planeOf('sagittal')])).snapshot.rows,rows);
 // The four 2x2 row and column shapes, with a vacancy where the merge left an empty cell.
 for(const shape of [COLUMN_LEFT,COLUMN_RIGHT,ROW_TOP,ROW_BOTTOM]){
  assert.equal(command(mergedJob(2,2,shape,[planeOf('axial'),planeOf('coronal'),null])).snapshot.cells.length,3);
  assert.equal(command(mergedJob(2,2,shape,[frameOf(),frameOf(),null],false)).snapshot.volume,null);
  assert.equal(command(mergedJob(2,2,shape,[planeOf('axial'),frameOf(),null])).snapshot.cells[1].kind,'stack');
 }
 // A merged layout carrying a plane is bound to the same one volume and the same slab rule.
 assert.match(verifyVolumeReference(maximized,tags,'SYNTHETIC'),/^[a-f0-9]{64}$/);
 const thick=structuredClone(maximized);thick.cells[0].projection.thickness=100;
 rejected(()=>verifyVolumeReference(thick,tags,'SYNTHETIC'));
 // A frame cell has no slab, so the physical bound never dereferences a projection it lacks.
 assert.match(verifyVolumeReference(mergedJob(2,2,ROW_TOP,[planeOf('axial'),frameOf(),null]),
  tags,'SYNTHETIC'),/^[a-f0-9]{64}$/);
});
test('the merged layout refuses every geometry the viewer cannot produce',()=>{
 for(const [label,rows,cols,rects,cells] of [
   ['overlapping rectangles',2,2,[rect(0,0,1,1),rect(0,0,.5,.5),rect(.5,.5,.5,.5)],[planeOf('axial'),planeOf('coronal'),null]],
   ['a gap left by a shrunken cell',2,2,[rect(0,0,.4,1),rect(.5,0,.5,.5),rect(.5,.5,.5,.5)],[planeOf('axial'),planeOf('coronal'),null]],
   ['a rectangle outside the grid',2,2,[rect(0,0,1.5,1)],[planeOf('axial')]],
   ['a negative origin',2,2,[rect(-0.5,0,1,1)],[planeOf('axial')]],
   ['a freeform rectangle',2,2,[rect(0,0,.75,.75)],[planeOf('axial')]],
   ['a nested rectangle',2,2,[rect(0,0,1,1),rect(.25,.25,.5,.5)],[planeOf('axial'),planeOf('coronal')]],
   ['a row shape on a base that is not 2x2',1,3,COLUMN_LEFT,[planeOf('axial'),planeOf('coronal'),null]],
   ['a base grid the merge module never uses',3,3,MAXIMIZE,[planeOf('axial')]],
   ['a 1x1 base the merge module never uses',1,1,MAXIMIZE,[planeOf('axial')]],
   ['a shape in the wrong position order',2,2,[COLUMN_LEFT[1],COLUMN_LEFT[0],COLUMN_LEFT[2]],[planeOf('axial'),planeOf('coronal'),null]],
   ['more cells than rectangles',2,2,MAXIMIZE,[planeOf('axial'),planeOf('coronal')]],
   ['fewer cells than rectangles',2,2,COLUMN_LEFT,[planeOf('axial'),planeOf('coronal')]],
   ['an entirely empty merged screen',2,2,COLUMN_LEFT,[null,null,null]]]){
  refused(label,()=>command(mergedJob(rows,cols,rects,cells)));
 }
 for(const [label,change] of [['no rects at all',s=>delete s.rects],['rects that are not a list',s=>s.rects={}],
   ['a rectangle with a foreign key',s=>s.rects[0]={...s.rects[0],z:0}],
   ['a rectangle missing a side',s=>delete s.rects[0].width],
   ['geometry moved onto the cell',s=>s.cells[0].rect=rect(0,0,1,1)],
   ['an active index past the cell list',s=>s.active=1],
   ['a negative active index',s=>s.active=-1],
   ['a cell with no kind',s=>delete s.cells[0].kind],
   ['a cell kind the server does not know',s=>s.cells[0].kind='volume'],
   ['a plane cell with no volume to stand on',s=>s.volume=null],
   ['a frame cell claiming the plane shape',s=>s.cells[0]=frameOf()],
   ['a plane cell of another series',s=>s.cells[0].series='2.25.99'],
   ['a batch recipe',s=>s.batch={cell:planeOf('axial'),offset:0,interval:1,count:2,reverse:false}],
   ['3D marks',s=>s.marks={version:1,visible:true,sync:true,marks:[]}]]){
  const s=structuredClone(maximized);change(s);refused(label,()=>command(s));
 }
 // A volume carried by a merged layout that holds no plane at all is refused in the other
 // direction too, so the reference and the cell shapes can never disagree.
 rejected(()=>command(mergedJob(2,2,MAXIMIZE,[frameOf()],true)));
});
test('the merged layout stays out of the established versions and they stay out of it',()=>{
 // No version but 9 admits rects, in either direction.
 for(const base of [stackOnly,layout,mixed,snapshot]){
  const s=structuredClone(base);s.rects=structuredClone(MAXIMIZE);rejected(()=>command(s));
 }
 // A version 9 shape cannot be relabelled as an established one, and an established
 // snapshot cannot be relabelled as version 9.
 for(const version of [2,4,7,8]){const s=structuredClone(maximized);s.version=version;rejected(()=>command(s));}
 for(const base of [stackOnly,layout,mixed]){const s=structuredClone(base);s.version=9;rejected(()=>command(s));}
 // The established shapes still parse exactly as before beside it.
 assert.equal(command(stackOnly).snapshot.version,2);
 assert.equal(command(layout).snapshot.version,7);
 assert.equal(command(mixed).snapshot.version,8);
 assert.equal(command(snapshot).snapshot.version,4);
});
test('batch recipe is independent of current planes and bounds count, raster and source range',()=>{
 const s=structuredClone(snapshot);s.version=5;s.batch={cell:structuredClone(cell),offset:-1,interval:1,count:3,reverse:false};
 assert.equal(command(s).snapshot.version,5);assert.match(verifyVolumeReference(s,tags,'SYNTHETIC'),/^[a-f0-9]{64}$/);
 for(const change of [b=>b.count=2.5,b=>b.count=65,b=>b.interval=0,b=>b.reverse=1,b=>b.cell.series='2.25.99',b=>b.cell.sop=volume.sops[0],b=>b.cell.viewport.width=8193,b=>b.extra=1]){
  const bad=structuredClone(s);change(bad.batch);rejected(()=>command(bad));
 }
 const outside=structuredClone(s);outside.batch.offset=-1.01;rejected(()=>verifyVolumeReference(outside,tags,'SYNTHETIC'));
 const reverse=structuredClone(s);reverse.batch.reverse=true;reverse.batch.offset=1;reverse.volume.sops.reverse();assert.match(verifyVolumeReference(reverse,[...tags].reverse(),'SYNTHETIC'),/^[a-f0-9]{64}$/);
 const changed=structuredClone(tags);changed[1]._kinSourceDigest='f'.repeat(32);assert.notEqual(verifyVolumeReference(s,tags,'SYNTHETIC'),verifyVolumeReference(s,changed,'SYNTHETIC'));
});
// Version 10 is the exact version 4 three-plane snapshot plus one manual curved MPR (kin-cpr-1).
const curvedModel=require('/app/dist/viewer-volume-curved.js');
const curve={schema:1,algorithm:'kin-cpr-1',kind:'curved',frameOfReference:'2.25.6',coordinates:'LPS_mm',cell:0,
 plane:{origin:[16,16,1],normal:[0,0,1],viewUp:[0,1,0]},points:[[2,16,1],[16,20,1],[30,16,1]],interpolation:'catmull-rom-uniform-16',
 output:{spacing:1,halfHeight:1,sampling:'trilinear',edge:'half-voxel-clamp',outside:'nan',axis:'arc-length'},
 display:{voiRange:{lower:-1000,upper:1000},VOILUTFunction:'LINEAR',invert:false}};
const curvedJob={...structuredClone(snapshot),version:10,curved:curve};
test('a curved MPR job is accepted only with a valid kin-cpr-1 curve on the three-plane snapshot',()=>{
 assert.equal(command(curvedJob).snapshot.version,10);assert.match(verifyVolumeReference(curvedJob,tags,'SYNTHETIC'),/^[a-f0-9]{64}$/);
 const freehand=structuredClone(curvedJob);freehand.curved.kind='freehand';freehand.curved.interpolation='linear';assert.equal(command(freehand).snapshot.version,10);
 for(const [label,change] of [
   ['unknown algorithm',s=>s.curved.algorithm='kin-cpr-2'],['unknown schema',s=>s.curved.schema=2],['kind/interpolation mismatch',s=>s.curved.interpolation='linear'],
   ['off-plane point',s=>s.curved.points[1][2]=1.02],['duplicate point',s=>s.curved.points[1]=s.curved.points[0].slice()],['one point',s=>s.curved.points=[s.curved.points[0]]],
   ['65 control points',s=>s.curved.points=Array.from({length:65},(_,i)=>[i*.4,16,1])],['non-unit normal',s=>s.curved.plane.normal=[0,0,2]],
   ['SIGMOID display',s=>s.curved.display.VOILUTFunction='SIGMOID'],['nearest edge',s=>s.curved.output.edge='nearest'],['extra key',s=>s.curved.slab={mode:'MPR'}],
   ['half height 151',s=>s.curved.output.halfHeight=151],['arc over 1000 mm',s=>s.curved.points=[[0,16,1],[1001,16,1]]],['arc shorter than spacing',s=>s.curved.points=[[2,16,1],[2.5,16,1]]],
   ['sample limit',s=>{s.curved.output.spacing=.05;s.curved.output.halfHeight=150;s.curved.points=[[0,16,1],[200,16,1]];}],
   ['missing curve',s=>delete s.curved],['curve with marks',s=>s.marks={version:1,visible:true,sync:true,marks:[]}],['curve with batch',s=>s.batch=null],
   ['vacancy',s=>s.cells[1]=null],['2x2 layout',s=>{s.rows=2;s.cols=2;s.cells.push(structuredClone(cell));}],['forged digest',s=>s.volume.sourceDigest='f'.repeat(64)]]){
  const s=structuredClone(curvedJob);change(s);assert.throws(()=>command(s),e=>e.getStatus?.()===400,label);
 }
 // A curve key is never admitted by another version, and a version 10 job never parses without it.
 for(const version of [4,5,6,7]){const s=structuredClone(curvedJob);s.version=version;rejected(()=>command(s));}
 // The printed preview command refuses a curved job outright.
 const {previewCommand}=require('/app/dist/viewer-job-input.js');rejected(()=>previewCommand(Buffer.from(JSON.stringify({snapshot:curvedJob}))));
});
test('a curved MPR job must match the original frame of reference, finest spacing and voxel bounds',()=>{
 for(const [label,change] of [
   ['foreign frame of reference',s=>s.curved.frameOfReference='2.25.7'],['coarser spacing',s=>s.curved.output.spacing=1.5],['finer spacing than voxels',s=>s.curved.output.spacing=.5],
   ['point outside volume',s=>s.curved.points[2]=[32,16,1]],['origin outside volume',s=>{s.curved.plane.origin=[16,16,2.6];s.curved.points=s.curved.points.map(p=>[p[0],p[1],2.6]);}]]){
  const s=structuredClone(curvedJob);change(s);
  assert.equal(command(s).snapshot.version,10,label+' is syntactically valid');
  assert.throws(()=>verifyVolumeReference(s,tags,'SYNTHETIC'),e=>e.getStatus?.()===400,label);
 }
 // Half a voxel beyond the edge centre is still inside, exactly as the viewer samples it.
 const edge=structuredClone(curvedJob);edge.curved.points[2]=[31.5,16,1];assert.match(verifyVolumeReference(edge,tags,'SYNTHETIC'),/^[a-f0-9]{64}$/);
 // Descending originals keep the same patient-coordinate curve valid.
 const reversed=structuredClone(curvedJob);reversed.volume.sops.reverse();assert.match(verifyVolumeReference(reversed,[...tags].reverse(),'SYNTHETIC'),/^[a-f0-9]{64}$/);
});
// Version 11 is the exact version 4 three-plane snapshot plus one manual 3D path (kin-path-1).
const pathModel=require('/app/dist/viewer-volume-path.js');
const unitVector=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
// A saved normal is only valid perpendicular to the start tangent, which this test derives itself
// from the written Catmull-Rom and arc-length rule (not from the server plan under test).
function pathOf(points,{column=3,spacing=1}={}){
 const p={schema:1,algorithm:'kin-path-1',frameOfReference:'2.25.6',coordinates:'LPS_mm',cell:1,points,interpolation:'catmull-rom-uniform-16',
  frame:{method:'double-reflection-rmf',initialNormal:[0,0,1]},unfold:{angle:37.5},position:{column},
  output:{spacing,halfHeight:2,sampling:'trilinear',edge:'half-voxel-clamp',outside:'nan',axis:'arc-length'},
  display:{voiRange:{lower:-1000,upper:1000},VOILUTFunction:'LINEAR',invert:false}};
 // The tangent is read without the frame check (column 0 of the resampled centres).
 const line=[];const n=points.length,at=i=>points[Math.max(0,Math.min(n-1,i))];
 for(let i=0;i<n-1;i++){const p0=at(i-1),p1=at(i),p2=at(i+1),p3=at(i+2);for(let j=0;j<16;j++){const t=j/16;line.push([0,1,2].map(k=>.5*(2*p1[k]+(-p0[k]+p2[k])*t+(2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*t*t+(-p0[k]+3*p1[k]-3*p2[k]+p3[k])*t*t*t)));}}
 let s=0,i=1;while(i<line.length-1&&s+Math.hypot(...line[i].map((x,k)=>x-line[i-1][k]))<spacing){s+=Math.hypot(...line[i].map((x,k)=>x-line[i-1][k]));i++;}
 const a=line[i-1],b=line[i],f=(spacing-s)/Math.hypot(...b.map((x,k)=>x-a[k])),c1=a.map((x,k)=>x+(b[k]-x)*f),t0=unitVector(c1.map((x,k)=>x-points[0][k]));
 p.frame.initialNormal=unitVector([0,0,1].map((x,k)=>x-t0[2]*t0[k]));return p;
}
const route=pathOf([[2,4,0],[16,20,1],[30,16,2],[20,6,1.5]]);
const pathJob={...structuredClone(snapshot),version:11,path:route};
test('a 3D path job is accepted only with a valid kin-path-1 path on the exact three-plane snapshot',()=>{
 assert.equal(command(pathJob).snapshot.version,11);assert.match(verifyVolumeReference(pathJob,tags,'SYNTHETIC'),/^[a-f0-9]{64}$/);
 const plan=pathModel.pathPlan(route);assert.ok(plan.columns>10);
 for(const [label,change] of [
   ['unknown algorithm',s=>s.path.algorithm='kin-path-2'],['unknown schema',s=>s.path.schema=2],['interpolation',s=>s.path.interpolation='linear'],['frame method',s=>s.path.frame.method='frenet'],
   ['extra key',s=>s.path.kind='curved'],['missing frame',s=>delete s.path.frame],['extra frame key',s=>s.path.frame.twist=0],
   ['non-unit normal',s=>s.path.frame.initialNormal=s.path.frame.initialNormal.map(x=>x*1.01)],['normal along the start tangent',s=>s.path.frame.initialNormal=plan.tangents[0]],
   ['normal 1e-3 off perpendicular',s=>s.path.frame.initialNormal=unitVector(s.path.frame.initialNormal.map((x,k)=>x+2e-3*plan.tangents[0][k]))],
   ['angle 360',s=>s.path.unfold.angle=360],['angle below 0',s=>s.path.unfold.angle=-.5],['angle finer than 0.01',s=>s.path.unfold.angle=12.345],
   ['column past the path',s=>s.path.position.column=plan.columns],['fractional column',s=>s.path.position.column=1.5],['negative column',s=>s.path.position.column=-1],
   ['duplicate point',s=>s.path.points[1]=s.path.points[0].slice()],['one point',s=>s.path.points=[s.path.points[0]]],['65 points',s=>s.path.points=Array.from({length:65},(_,i)=>[i*.4,i%2,1])],
   ['arc over 1000 mm',s=>s.path.points=[[0,0,1],[1001,0,1]]],['arc shorter than spacing',s=>s.path.points=[[2,4,1],[2.5,4,1]]],
   ['reversal',s=>{s.path.points=[[2,4,1],[28,4,1],[3,4,1]];s.path.frame.initialNormal=[0,0,1];}],
   ['SIGMOID display',s=>s.path.display.VOILUTFunction='SIGMOID'],['half height 151',s=>s.path.output.halfHeight=151],['nearest edge',s=>s.path.output.edge='nearest'],
   ['sample limit',s=>{s.path.output.spacing=.05;s.path.output.halfHeight=150;s.path.points=[[0,0,1],[200,0,1]];s.path.frame.initialNormal=[0,0,1];s.path.position.column=0;}],
   ['bad frame of reference',s=>s.path.frameOfReference='x'],['cell 3',s=>s.path.cell=3],
   ['missing path',s=>delete s.path],['path with marks',s=>s.marks={version:1,visible:true,sync:true,marks:[]}],['path with batch',s=>s.batch=null],['path with a curve',s=>s.curved=structuredClone(curve)],
   ['vacancy',s=>s.cells[1]=null],['2x2 layout',s=>{s.rows=2;s.cols=2;s.cells.push(structuredClone(cell));}],['orientation key',s=>s.cells[0].orientation='axial'],['forged digest',s=>s.volume.sourceDigest='f'.repeat(64)]]){
  const s=structuredClone(pathJob);change(s);assert.throws(()=>command(s),e=>e.getStatus?.()===400,label);
 }
 // No other version admits a path key, and a curved job with a path beside its curve is refused.
 for(const version of [4,5,6,7,8,9,10]){const s=structuredClone(pathJob);s.version=version;rejected(()=>command(s));}
 const both=structuredClone(curvedJob);both.path=structuredClone(route);rejected(()=>command(both));
 const {previewCommand}=require('/app/dist/viewer-job-input.js');rejected(()=>previewCommand(Buffer.from(JSON.stringify({snapshot:pathJob}))));
 // The established shapes still parse exactly as before beside it.
 assert.equal(command(snapshot).snapshot.version,4);assert.equal(command(curvedJob).snapshot.version,10);
});
test('a 3D path job must match the original frame of reference, finest spacing and voxel bounds',()=>{
 for(const [label,change] of [
   // Each forged path keeps a normal perpendicular to its own start tangent, so only the binding fails.
   ['foreign frame of reference',s=>s.path.frameOfReference='2.25.7'],['coarser spacing',s=>s.path=pathOf(s.path.points,{spacing:1.5,column:0})],['finer spacing than voxels',s=>s.path=pathOf(s.path.points,{spacing:.5})],
   ['point outside volume',s=>s.path=pathOf([...s.path.points.slice(0,3),[20,6,2.6]])],['point outside in x',s=>s.path=pathOf([s.path.points[0],s.path.points[1],[31.6,16,2],s.path.points[3]])]]){
  const s=structuredClone(pathJob);change(s);
  assert.equal(command(s).snapshot.version,11,label+' is syntactically valid');
  assert.throws(()=>verifyVolumeReference(s,tags,'SYNTHETIC'),e=>e.getStatus?.()===400,label);
 }
 const edge=structuredClone(pathJob);edge.path.points[2]=[31.5,16,2.5];edge.path=pathOf(edge.path.points);assert.match(verifyVolumeReference(edge,tags,'SYNTHETIC'),/^[a-f0-9]{64}$/);
 const reversed=structuredClone(pathJob);reversed.volume.sops.reverse();assert.match(verifyVolumeReference(reversed,[...tags].reverse(),'SYNTHETIC'),/^[a-f0-9]{64}$/);
});
test('server 3D path plan and transported frame equal the viewer model parity constants',()=>{
 const spec={...structuredClone(route),points:[[5,6,12.5],[20,15.75,40],[30,8,67.5],[12,25,70]],frame:{method:'double-reflection-rmf',initialNormal:[-0.15582558294899496,0.94703549761046,-0.28078845055364055]},
  position:{column:0},output:{...route.output,spacing:.5,halfHeight:3}};
 const plan=pathModel.pathPlan(spec);
 assert.ok(Math.abs(plan.length-89.41385010736313)<=1e-9);assert.equal(plan.columns,179);assert.equal(plan.rows,13);
 for(const [column,want] of [[100,[0.1401263211339599,0.9324108380483229,0.33312856859700046]],[178,[0.5081280875808327,0.5820371816388471,-0.6348531844460997]]])
  want.forEach((x,k)=>assert.ok(Math.abs(plan.normals[column][k]-x)<=1e-9,'N'+column));
});
test('server arc length and output grid equal the viewer model parity constants',()=>{
 const spec={...structuredClone(curve),plane:{origin:[16,15.75,40],normal:[0,1,0],viewUp:[0,0,1]},points:[[5,15.75,12.5],[20,15.75,40],[30,15.75,67.5]],output:{...curve.output,spacing:.5,halfHeight:3}};
 const curved=curvedModel.curvedPlan(spec),free=curvedModel.curvedPlan({...spec,kind:'freehand',interpolation:'linear'});
 assert.ok(Math.abs(curved.length-60.60865760815429)<=1e-9);assert.equal(curved.columns,122);assert.equal(curved.rows,13);
 assert.ok(Math.abs(free.length-60.58665999215323)<=1e-9);assert.equal(free.columns,122);assert.equal(free.rows,13);
});
