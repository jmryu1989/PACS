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
