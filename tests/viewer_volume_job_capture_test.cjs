// TEST-VOLUME-JOB: browser-side snapshot capture over the real viewer-volume-job.js.
// The v7 layout (Hanging Protocol 1x1/1x2/2x2 plus the existing 1x3/3x1) is chosen here,
// so the grid, the vacancy cells, the per-cell orientation and the version selection are
// proved without a browser. apply() needs a live renderer and stays with the native suite.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const context=vm.createContext({window:{},JSON,Math,Number,Array,Set,Object,Error,String,Boolean,Promise,Date,setTimeout,crypto});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../worklist-v0/hpacs-lite/viewer-volume-job.js'),'utf8'),context);

const STUDY='1.2.3',SERIES='1.2.4',SET='ds-volume',SOPS=['1.2.5','1.2.6','1.2.7'];
const instance=sop=>({StudyInstanceUID:STUDY,SeriesInstanceUID:SERIES,SOPInstanceUID:sop,PatientID:'SYNTHETIC',
  SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2'});
const imageIds=SOPS.map(sop=>'image:'+sop);
const volume={loadStatus:{loaded:true},imageIds,framesLoaded:imageIds.length};
context.cornerstone={cache:{getVolume:id=>id==='volume-1'?volume:null},
  metaData:{get:(type,id)=>type==='instance'&&imageIds.includes(id)?instance(SOPS[imageIds.indexOf(id)]):null}};
const opacity={getSize:()=>1,getClamping:()=>true,getNodeValue:(n,node)=>{node[0]=0;node[1]=1;}};
const AXIS_NORMAL={axial:[0,0,1],sagittal:[1,0,0],coronal:[0,1,0]};
const camera=(seed,normal)=>({focalPoint:[seed,0,0],position:[seed,0,100],viewUp:[0,1,0],viewPlaneNormal:normal,
  parallelScale:100+seed,flipHorizontal:false,flipVertical:false,rotation:0});
function viewport(seed,normal){
  return {type:'orthographic',getVolumeId:()=>'volume-1',getCamera:()=>camera(seed,normal),getSlabThickness:()=>1,
    getCanvas:()=>({width:256,height:256}),
    getProperties:()=>({voiRange:{lower:-1000,upper:1000},VOILUTFunction:'LINEAR',invert:false,interpolationType:1}),
    getActors:()=>[{actor:{getMapper:()=>({getBlendMode:()=>1}),getProperty:()=>({getScalarOpacity:()=>opacity})}}]};
}
// cells: 'axial'|'sagittal'|'coronal' is a plane the layout named, null a vacancy, and
// {normal} a plane whose request carries no orientation at all.
function world(rows,cols,cells,{active=0,batch=null,marks=null}={}){
  const viewports=new Map(),lookup=new Map();
  cells.forEach((spec,index)=>{
    const id='vp-'+index,named=typeof spec==='string'?spec:null;
    const normal=named?AXIS_NORMAL[named]||[0,0,1]:spec&&spec.normal;
    viewports.set(id,{viewportId:id,x:(index%cols)/cols,y:Math.floor(index/cols)/rows,width:1/cols,height:1/rows,
      displaySetInstanceUIDs:spec?[SET]:[],
      viewportOptions:named?{id,viewportId:id,orientation:named}:{id,viewportId:id}});
    lookup.set(id,spec?viewport(index,normal):{type:'stack'});
  });
  context.window.kinVolumeBatchState=batch?{capture:()=>batch}:undefined;
  context.window.kinMprMarks=marks?{capture:()=>marks}:undefined;
  return context.window.kinCreateVolumeJob({
    grid:{getState:()=>({layout:{numRows:rows,numCols:cols,layoutType:'grid'},viewports,activeViewportId:'vp-'+active})},
    cs:{getCornerstoneViewport:id=>lookup.get(id)},
    ds:{getActiveDisplaySets:()=>[{StudyInstanceUID:STUDY,SeriesInstanceUID:SERIES,displaySetInstanceUID:SET,
      images:SOPS.map(sop=>({SOPInstanceUID:sop,SOPClassUID:'1.2.840.10008.5.1.4.1.1.2'}))}]},
    studies:[STUDY]});
}
const PLANES=['axial','sagittal','coronal'];

test('the existing three-plane job keeps version 4 and carries no layout key of its own',()=>{
 for(const [rows,cols] of [[1,3],[3,1]]){
  const value=world(rows,cols,PLANES).capture();
  assert.equal(value.version,4);assert.equal(value.rows,rows);assert.equal(value.cols,cols);
  assert.equal(value.cells.length,3);
  for(const cell of value.cells)assert.deepEqual(Object.keys(cell).sort(),
    ['camera','projection','properties','series','study','viewport']);
 }
});

test('a Hanging Protocol plane layout saves as version 7 with vacancies and explicit orientation',()=>{
 const value=world(2,2,['axial','sagittal','coronal',null],{active:1}).capture();
 assert.equal(value.version,7);assert.equal(value.rows,2);assert.equal(value.cols,2);assert.equal(value.active,1);
 assert.equal(value.cells.length,4);assert.equal(value.cells[3],null);
 assert.deepEqual(value.cells.slice(0,3).map(c=>c.orientation),PLANES);
 assert.deepEqual(Object.keys(value.cells[0]).sort(),
   ['camera','orientation','projection','properties','series','study','viewport']);
 assert.deepEqual(value.volume,{study:STUDY,series:SERIES,sops:SOPS});
 assert.equal(JSON.stringify(value).includes('sop"'),false,'no reconstructed SOP is written into a cell');
 for(const [rows,cols,cells] of [[1,1,['axial']],[1,2,['coronal',null]],[2,2,[null,'sagittal',null,'axial']],
   [1,3,['axial',null,'coronal']],[3,1,[null,'axial','sagittal']]]){
  const other=world(rows,cols,cells).capture();
  assert.equal(other.version,7);
  assert.deepEqual(other.cells.map(c=>c&&c.orientation),cells);
 }
});

test('a vacancy may be the active cell and keeps the cell index it occupies',()=>{
 const value=world(2,2,['axial','sagittal','coronal',null],{active:3}).capture();
 assert.equal(value.active,3);assert.equal(value.cells[3],null);
 assert.equal(value.cells.length,value.rows*value.cols);
});

test('an unsupported grid, an empty screen and an unreadable plane orientation are refused',()=>{
 for(const [rows,cols,cells] of [[2,1,['axial',null]],[1,4,PLANES.concat(null)],[3,3,PLANES.concat(Array(6).fill(null))]])
  assert.throws(()=>world(rows,cols,cells).capture(),/MPR 작업을 저장하세요/);
 assert.throws(()=>world(2,2,[null,null,null,null]).capture(),/MPR 작업을 저장하세요/);
 // An unnamed request is only readable while the camera still sits exactly on one axis.
 assert.equal(world(2,2,[{normal:[0,1,0]},'sagittal','axial',null]).capture().cells[0].orientation,'coronal');
 assert.throws(()=>world(2,2,[{normal:[0.6,0.8,0]},'sagittal','axial',null]).capture(),/평면 방향/);
});

test('marks and batch are refused on the new layout instead of being dropped',()=>{
 const batch={cell:{},offset:0,interval:1,count:2,reverse:false};
 const marks={version:1,visible:true,sync:true,marks:[{point:[0,0,0]}]};
 assert.throws(()=>world(2,2,['axial','sagittal','coronal',null],{batch}).capture(),/단면 묶음/);
 assert.throws(()=>world(2,2,['axial','sagittal','coronal',null],{marks}).capture(),/3D 표식/);
 // The same states keep their established versions on the three-plane layout.
 assert.equal(world(1,3,PLANES,{batch}).capture().version,5);
 assert.equal(world(1,3,PLANES,{marks}).capture().version,6);
 const quiet={version:1,visible:true,sync:true,marks:[]};
 assert.equal(world(1,3,PLANES,{marks:quiet}).capture().version,4);
 assert.equal(world(2,2,['axial','sagittal','coronal',null],{marks:quiet}).capture().version,7);
});
