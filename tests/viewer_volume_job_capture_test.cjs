// TEST-VOLUME-JOB: browser-side snapshot capture over the real viewer-volume-job.js.
// The v7 layout (Hanging Protocol 1x1/1x2/2x2 plus the existing 1x3/3x1) is chosen here,
// so the grid, the vacancy cells, the per-cell orientation and the version selection are
// proved without a browser. apply() needs a live renderer and stays with the native suite.
// The v8 mixed layout adds ordinary frame cells. What this module owns is asserted here:
// the per-cell kind discriminator, the mixture rule, the Hanging-Protocol-only grid set,
// the one shared pixel budget and the refusal when the frame-cell helper is absent. The
// CONTENT of a frame cell belongs to viewer-jobs.js (it needs a DOM) and is proved by the
// version 2 and version 8 native suites, so it is injected here as a stub on purpose.
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
const STACK_SET='ds-stack',STACK_SERIES='1.2.8',STACK_SOP='1.2.9';
const frameCell=()=>({study:STUDY,series:STACK_SERIES,sop:STACK_SOP,frame:1,viewport:{width:256,height:256},
  camera:{focalPoint:[0,0,0],position:[0,0,1],viewUp:[0,1,0],viewPlaneNormal:[0,0,1],parallelScale:100,
    rotation:0,flipHorizontal:false,flipVertical:false},
  properties:{voiRange:{lower:-1000,upper:1000},VOILUTFunction:'LINEAR',invert:false,interpolationType:1}});
// The helper viewer-jobs.js lends to this module. `size` lets a case drive the shared budget.
const frameHelper=(size={width:256,height:256})=>({cell:(g,measure)=>{measure(size);return frameCell();},
  resolve:()=>STACK_SET,apply:async()=>{}});
// cells: 'axial'|'sagittal'|'coronal' is a plane the layout named, 'frame' an ordinary stack
// cell, null a vacancy, and {normal} a plane whose request carries no orientation at all.
// `rects` places the cells in explicit fractional rectangles instead of the uniform grid,
// which is what a merged screen is; without it every cell fills its own grid position.
function world(rows,cols,cells,{active=0,batch=null,marks=null,dirtyMarks=false,stack=frameHelper(),rects=null,curved,path,mip}={}){
  // The curved tool's own capture rules are proved in viewer_volume_curved_dom_test.py; here it
  // is the capability shape this module consumes: capture() on a target, dirty() without one.
  // The 3D path tool (viewer_volume_path_dom_test.py) is consumed through the same shape, and so is
  // the MIP Viewer Job capability (its block rules are proved in volume_mip_job_test.cjs).
  context.window.kinMprCurved=curved;context.window.kinMprPath=path;context.window.kinVolumeMipJob=mip;
  const viewports=new Map(),lookup=new Map();
  cells.forEach((spec,index)=>{
    const id='vp-'+index,frame=spec==='frame',named=typeof spec==='string'&&!frame?spec:null;
    const normal=named?AXIS_NORMAL[named]||[0,0,1]:spec&&spec.normal;
    const box=rects?{x:rects[index][0],y:rects[index][1],width:rects[index][2],height:rects[index][3]}
      :{x:(index%cols)/cols,y:Math.floor(index/cols)/rows,width:1/cols,height:1/rows};
    viewports.set(id,{viewportId:id,...box,
      displaySetInstanceUIDs:spec?[frame?STACK_SET:SET]:[],
      viewportOptions:named?{id,viewportId:id,orientation:named}:{id,viewportId:id}});
    lookup.set(id,spec&&!frame?viewport(index,normal):{type:'stack'});
  });
  context.window.kinVolumeBatchState=batch?{capture:()=>batch}:undefined;
  // The real tool binds to a three-plane target: capture() throws without one, while
  // dirty() answers from its own records and is the only signal a mixed layout can use.
  context.window.kinMprMarks=marks||dirtyMarks
    ?{capture:()=>{if(cells.some(c=>c==='frame'))throw Error('표식 입력을 마친 뒤 저장하세요.');return marks;},dirty:()=>dirtyMarks}
    :undefined;
  return context.window.kinCreateVolumeJob({
    grid:{getState:()=>({layout:{numRows:rows,numCols:cols,layoutType:'grid'},viewports,activeViewportId:'vp-'+active})},
    cs:{getCornerstoneViewport:id=>lookup.get(id)},
    ds:{getActiveDisplaySets:()=>[{StudyInstanceUID:STUDY,SeriesInstanceUID:SERIES,displaySetInstanceUID:SET,
      images:SOPS.map(sop=>({SOPInstanceUID:sop,SOPClassUID:'1.2.840.10008.5.1.4.1.1.2'}))}]},
    studies:[STUDY],stack});
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

test('a finished curve on the three-plane layout saves as version 10 beside the exact version 4 cells',()=>{
 const curve={schema:1,algorithm:'kin-cpr-1',kind:'curved',points:[[0,0,0],[1,0,0]]};
 const tool=(value,dirty=false,calls=[])=>({capture:readOnly=>{calls.push(readOnly);return value;},dirty:()=>dirty});
 for(const [rows,cols] of [[1,3],[3,1]]){
  const calls=[],value=world(rows,cols,PLANES,{curved:tool(curve,false,calls)}).capture(true);
  assert.equal(value.version,10);assert.deepEqual(value.curved,curve);assert.deepEqual(calls,[true]);
  assert.deepEqual(Object.keys(value).sort(),['active','cells','cols','curved','rows','studies','version','volume']);
  const plain=world(rows,cols,PLANES).capture();delete value.curved;value.version=4;assert.deepEqual(value,plain);
 }
 // No curve, or no tool at all, leaves the established version untouched.
 assert.equal(world(1,3,PLANES,{curved:tool(null)}).capture().version,4);
 assert.equal(world(1,3,PLANES,{curved:undefined}).capture().version,4);
 // A capture refusal (drawing, preview, failed) is the save refusal; nothing is written.
 assert.throws(()=>world(1,3,PLANES,{curved:{capture:()=>{throw Error('곡면 MPR 최종 결과 계산이 끝난 뒤 저장하세요.');},dirty:()=>true}}).capture(),/최종 결과/);
});

test('a curve is refused beside a batch or marks and outside the three-plane layout',()=>{
 const curve={schema:1,kind:'freehand'},tool={capture:()=>curve,dirty:()=>false},dirty={capture:()=>{throw Error('no target');},dirty:()=>true};
 const batch={cell:{},offset:0,interval:1,count:2,reverse:false};
 const marks={version:1,visible:true,sync:true,marks:[{point:[0,0,0]}]};
 assert.throws(()=>world(1,3,PLANES,{curved:tool,batch}).capture(),/단면 묶음·3D 표식과 함께/);
 assert.throws(()=>world(3,1,PLANES,{curved:tool,marks}).capture(),/단면 묶음·3D 표식과 함께/);
 // A v7 plane layout can see a target, so its curve is refused by name.
 assert.throws(()=>world(2,2,['axial','sagittal','coronal',null],{curved:tool}).capture(),/곡면 MPR은 3평면/);
 // Mixed and merged screens have no target: only unsaved curve work blocks them.
 assert.throws(()=>world(2,2,['axial','frame','coronal',null],{curved:dirty}).capture(),/곡면 MPR은 3평면/);
 assert.throws(()=>world(2,2,['axial','coronal',null],{rects:ROW_TOP,curved:dirty}).capture(),/곡면 MPR은 3평면/);
 assert.equal(world(2,2,['axial','frame','coronal',null],{curved:{capture:()=>{throw Error('must not be asked');},dirty:()=>false}}).capture().version,8);
});

test('a final 3D path on the three-plane layout saves as version 11 beside the exact version 4 cells',()=>{
 const route={schema:1,algorithm:'kin-path-1',points:[[0,0,0],[1,0,1]],position:{column:0}};
 const tool=(value,dirty=false,calls=[])=>({capture:readOnly=>{calls.push(readOnly);return value;},dirty:()=>dirty});
 for(const [rows,cols] of [[1,3],[3,1]]){
  const calls=[],value=world(rows,cols,PLANES,{path:tool(route,false,calls)}).capture(true);
  assert.equal(value.version,11);assert.deepEqual(value.path,route);assert.deepEqual(calls,[true]);
  assert.deepEqual(Object.keys(value).sort(),['active','cells','cols','path','rows','studies','version','volume']);
  const plain=world(rows,cols,PLANES).capture();delete value.path;value.version=4;assert.deepEqual(value,plain);
 }
 // No path, or no tool at all, leaves every established version untouched.
 assert.equal(world(1,3,PLANES,{path:tool(null)}).capture().version,4);
 assert.equal(world(1,3,PLANES,{path:undefined}).capture().version,4);
 const curve={schema:1,kind:'curved'};
 assert.equal(world(1,3,PLANES,{path:tool(null),curved:tool(curve)}).capture().version,10);
 // A capture refusal (adding points, preview, failed, navigating) is the save refusal.
 assert.throws(()=>world(1,3,PLANES,{path:{capture:()=>{throw Error('3D Path 펼친 표시의 최종 결과 계산이 끝난 뒤 저장하세요.');},dirty:()=>true}}).capture(),/최종 결과/);
});

test('a 3D path is refused beside a curve, a batch or marks and outside the three-plane layout',()=>{
 const route={schema:1,algorithm:'kin-path-1'},tool={capture:()=>route,dirty:()=>false},dirty={capture:()=>{throw Error('no target');},dirty:()=>true};
 const batch={cell:{},offset:0,interval:1,count:2,reverse:false};
 const marks={version:1,visible:true,sync:true,marks:[{point:[0,0,0]}]};
 assert.throws(()=>world(1,3,PLANES,{path:tool,curved:{capture:()=>({schema:1,kind:'curved'}),dirty:()=>false}}).capture(),/곡면 MPR과 3D Path는 한 작업에 하나만/);
 assert.throws(()=>world(1,3,PLANES,{path:tool,batch}).capture(),/3D Path는 단면 묶음·3D 표식과 함께/);
 assert.throws(()=>world(3,1,PLANES,{path:tool,marks}).capture(),/3D Path는 단면 묶음·3D 표식과 함께/);
 // A quiet marks tool (no marks, default settings) is not a conflict.
 assert.equal(world(1,3,PLANES,{path:tool,marks:{version:1,visible:true,sync:true,marks:[]}}).capture().version,11);
 assert.throws(()=>world(2,2,['axial','sagittal','coronal',null],{path:tool}).capture(),/3D Path는 3평면/);
 assert.throws(()=>world(2,2,['axial','frame','coronal',null],{path:dirty}).capture(),/3D Path는 3평면/);
 assert.throws(()=>world(2,2,['axial','coronal',null],{rects:ROW_TOP,path:dirty}).capture(),/3D Path는 3평면/);
 assert.equal(world(2,2,['axial','frame','coronal',null],{path:{capture:()=>{throw Error('must not be asked');},dirty:()=>false}}).capture().version,8);
});

test('a mixed plane and frame layout saves as version 8 and names every cell kind',()=>{
 const value=world(2,2,['axial','frame','coronal',null],{active:1}).capture();
 assert.equal(value.version,8);assert.equal(value.active,1);assert.equal(value.cells[3],null);
 assert.deepEqual(value.cells.map(c=>c&&c.kind),['plane','stack','plane',null]);
 assert.deepEqual(Object.keys(value.cells[0]).sort(),
   ['camera','kind','orientation','projection','properties','series','study','viewport']);
 assert.deepEqual(Object.keys(value.cells[1]).sort(),
   ['camera','frame','kind','properties','series','sop','study','viewport']);
 // The plane cells still share the one volume reference; the frame cell keeps its own
 // real series and SOP, and no plane cell gains a fabricated one.
 assert.deepEqual(value.volume,{study:STUDY,series:SERIES,sops:SOPS});
 assert.equal(value.cells[1].series,STACK_SERIES);assert.equal(value.cells[1].sop,STACK_SOP);
 assert.equal(value.cells.filter(c=>c&&c.kind==='plane').every(c=>!('sop' in c)),true);
 for(const [rows,cols,cells] of [[1,2,['frame','axial']],[2,2,['frame','sagittal',null,'frame']]]){
  const other=world(rows,cols,cells).capture();
  assert.equal(other.version,8);
  assert.deepEqual(other.cells.map(c=>c&&c.kind),cells.map(c=>c===null?null:c==='frame'?'stack':'plane'));
 }
 // The established shapes gain nothing: a plane-only or three-plane layout has no kind key.
 assert.equal('kind' in world(2,2,['axial','sagittal','coronal',null]).capture().cells[0],false);
 assert.equal('kind' in world(1,3,PLANES).capture().cells[0],false);
});

test('mixing is refused outside the Hanging Protocol grids and when nothing is actually mixed',()=>{
 // 1x3/3x1 belong to the three-plane job; a rule that places both kinds cannot produce them.
 for(const [rows,cols,cells] of [[1,3,['axial','frame','coronal']],[3,1,['frame','axial','sagittal']],
   [2,1,['axial','frame']],[1,4,['axial','frame','coronal',null]]])
  assert.throws(()=>world(rows,cols,cells).capture(),/MPR 작업을 저장하세요/);
 // A grid holding only frame cells has no plane to reconstruct and is not this shape.
 assert.throws(()=>world(2,2,['frame','frame',null,null]).capture(),/MPR 작업을 저장하세요/);
 assert.throws(()=>world(1,1,['frame']).capture(),/MPR 작업을 저장하세요/);
});

test('a mixed layout shares one pixel budget and refuses marks and batch by name',()=>{
 // The frame cell spends from the same allowance as the planes: two 8192x2048 cells fit,
 // a third does not, and the message is the one the plane path already uses.
 const big={width:8192,height:2048};
 assert.equal(world(1,2,['axial','frame'],{stack:frameHelper(big)}).capture().version,8);
 assert.throws(()=>world(2,2,['frame','frame','axial',null],{stack:frameHelper(big)}).capture(),/화면 크기를 줄인/);
 assert.throws(()=>world(1,2,['axial','frame'],{stack:frameHelper({width:8193,height:1})}).capture(),/화면 크기를 줄인/);
 const batch={cell:{},offset:0,interval:1,count:2,reverse:false};
 const marks={version:1,visible:true,sync:true,marks:[{point:[0,0,0]}]};
 assert.throws(()=>world(2,2,['axial','frame','coronal',null],{batch}).capture(),/단면 묶음/);
 // A mixed screen is not a three-plane target, so the tool is asked whether mark work
 // would be lost — not to capture a state it cannot see from here.
 assert.throws(()=>world(2,2,['axial','frame','coronal',null],{marks,dirtyMarks:true}).capture(),/3D 표식/);
 assert.equal(world(2,2,['axial','frame','coronal',null],{marks}).capture().version,8,
   'marks already saved on their own three-plane Job are not lost by a mixed save');
});

// The rectangles viewer-cell-merge.js dispatches. A merged screen is saved as version 9:
// the base grid it was merged on, those exact rectangles, and the cells standing in them.
const MAXIMIZE=[[0,0,1,1]];
const COLUMN_LEFT=[[0,0,.5,1],[.5,0,.5,.5],[.5,.5,.5,.5]];
const COLUMN_RIGHT=[[0,0,.5,.5],[.5,0,.5,1],[0,.5,.5,.5]];
const ROW_TOP=[[0,0,1,.5],[0,.5,.5,.5],[.5,.5,.5,.5]];
const ROW_BOTTOM=[[0,0,.5,.5],[.5,0,.5,.5],[0,.5,1,.5]];

test('a merged screen saves as version 9 with its rectangles and its base grid',()=>{
 const value=world(2,2,['axial'],{rects:MAXIMIZE}).capture();
 assert.equal(value.version,9);assert.equal(value.rows,2);assert.equal(value.cols,2);
 assert.deepEqual(value.rects,[{x:0,y:0,width:1,height:1}]);
 assert.equal(value.cells.length,1,'the cells the merge absorbed are not saved as anything');
 assert.deepEqual(Object.keys(value.cells[0]).sort(),
   ['camera','kind','orientation','projection','properties','series','study','viewport']);
 assert.equal(value.cells[0].kind,'plane');
 assert.deepEqual(value.volume,{study:STUDY,series:SERIES,sops:SOPS});
 assert.equal(JSON.stringify(value).includes('sop"'),false,'no reconstructed SOP is written into a cell');
 // Maximize is reachable from every base grid the merge module allows.
 for(const [rows,cols] of [[1,2],[2,1],[2,2],[1,3],[3,1]]){
  const other=world(rows,cols,['sagittal'],{rects:MAXIMIZE}).capture();
  assert.equal(other.version,9);assert.deepEqual([other.rows,other.cols],[rows,cols]);
 }
});

test('each 2x2 row and column shape is saved, with a vacancy and with either cell kind',()=>{
 for(const shape of [COLUMN_LEFT,COLUMN_RIGHT,ROW_TOP,ROW_BOTTOM]){
  const planes=world(2,2,['axial','coronal',null],{rects:shape,active:1}).capture();
  assert.equal(planes.version,9);assert.equal(planes.active,1);
  assert.deepEqual(planes.rects,shape.map(([x,y,width,height])=>({x,y,width,height})));
  assert.equal(planes.cells.length,3);assert.equal(planes.cells[2],null,'an empty survivor keeps its rectangle');
  // A merged screen of ordinary frame cells alone references no volume at all.
  const frames=world(2,2,['frame','frame',null],{rects:shape}).capture();
  assert.equal(frames.version,9);assert.equal(frames.volume,null);
  assert.deepEqual(frames.cells.map(c=>c&&c.kind),['stack','stack',null]);
  // Both kinds side by side need no Hanging Protocol grid rule: every cell names its kind.
  const both=world(2,2,['axial','frame',null],{rects:shape}).capture();
  assert.equal(both.version,9);assert.deepEqual(both.cells.map(c=>c&&c.kind),['plane','stack',null]);
 }
});

test('a rectangle set the merge module cannot produce is refused, not saved as something else',()=>{
 for(const [label,rows,cols,cells,rects] of [
   ['a freeform rectangle',2,2,['axial'],[[0,0,.75,.75]]],
   ['an overlapping pair',2,2,['axial','coronal'],[[0,0,1,1],[0,0,.5,.5]]],
   ['a gap left by a shrunken cell',2,2,['axial','coronal',null],[[0,0,.4,1],[.5,0,.5,.5],[.5,.5,.5,.5]]],
   ['a rectangle outside the grid',2,2,['axial'],[[0,0,1.5,1]]],
   ['a column shape on a base that is not 2x2',1,3,['axial','coronal',null],COLUMN_LEFT],
   ['a base grid the merge module never uses',3,3,['axial'],MAXIMIZE]])
  assert.throws(()=>world(rows,cols,cells,{rects}).capture(),/지원하지 않는 칸 배치/,label);
 // Position order is derived here by sorting the live viewports, never taken on trust, so a
 // screen handed over out of order still captures in native order. A snapshot arriving at the
 // server out of order is a different thing and is refused there (viewer_volume_job_test.cjs).
 assert.deepEqual(world(2,2,['axial','coronal',null],
   {rects:[COLUMN_LEFT[1],COLUMN_LEFT[0],COLUMN_LEFT[2]]}).capture().rects,
   COLUMN_LEFT.map(([x,y,width,height])=>({x,y,width,height})));
 // One cell filling a 1x1 grid is that established layout, not a merged screen, and stays
 // version 7. The server refuses 1x1 as a merge base for exactly the same reason.
 assert.equal(world(1,1,['axial'],{rects:MAXIMIZE}).capture().version,7);
 // A merged screen with nothing on it is refused on its own merit.
 assert.throws(()=>world(2,2,[null,null,null],{rects:ROW_TOP}).capture(),/MPR 작업을 저장하세요/);
});

test('a merged screen shares one pixel budget and refuses marks and batch by name',()=>{
 const batch={cell:{},offset:0,interval:1,count:2,reverse:false};
 const marks={version:1,visible:true,sync:true,marks:[{point:[0,0,0]}]};
 assert.throws(()=>world(2,2,['axial','coronal',null],{rects:ROW_TOP,batch}).capture(),/단면 묶음/);
 // A merged screen is not a three-plane target either, so the tool is asked whether mark
 // work would be lost rather than to capture a state it cannot see from here.
 assert.throws(()=>world(2,2,['axial','coronal',null],{rects:ROW_TOP,marks,dirtyMarks:true}).capture(),/3D 표식/);
 assert.equal(world(2,2,['axial','coronal',null],{rects:ROW_TOP,marks}).capture().version,9,
   'marks already saved on their own three-plane Job are not lost by a merged save');
 const big={width:8192,height:2048};
 assert.throws(()=>world(2,2,['frame','frame',null],{rects:ROW_TOP,stack:frameHelper({width:8193,height:1})}).capture(),
   /화면 크기를 줄인/);
 assert.equal(world(2,2,['frame','frame',null],{rects:ROW_TOP,stack:frameHelper(big)}).capture().version,9);
 // Without the frame-cell helper a merged screen holding one refuses instead of dropping it.
 for(const stack of [null,{resolve:()=>STACK_SET,apply:async()=>{}}])
  assert.throws(()=>world(2,2,['axial','frame',null],{rects:ROW_TOP,stack}).capture(),/저장 도구를 불러오지 못했습니다/);
});

test('the established uniform shapes are untouched by the merged shape',()=>{
 assert.equal(world(1,3,PLANES).capture().version,4);
 assert.equal(world(2,2,['axial','sagittal','coronal',null]).capture().version,7);
 assert.equal(world(2,2,['axial','frame','coronal',null]).capture().version,8);
 // No uniform snapshot gains a rects key, and no merged snapshot loses one.
 for(const value of [world(1,3,PLANES).capture(),world(2,2,['axial','sagittal','coronal',null]).capture(),
   world(2,2,['axial','frame','coronal',null]).capture()])
  assert.equal('rects' in value,false);
 assert.equal('rects' in world(2,2,['axial'],{rects:MAXIMIZE}).capture(),true);
});

test('without the frame-cell helper a mixed screen refuses instead of dropping the cell',()=>{
 for(const stack of [null,{resolve:()=>STACK_SET,apply:async()=>{}},{cell:()=>frameCell()}])
  assert.throws(()=>world(2,2,['axial','frame','coronal',null],{stack}).capture(),/저장 도구를 불러오지 못했습니다/);
 // A plane-only layout on the same grid is unaffected by the missing helper.
 assert.equal(world(2,2,['axial','sagittal','coronal',null],{stack:null}).capture().version,7);
});

// Version 12 (A11-VOI-2 P2): the MIP Viewer Job capability supplies its confirmed block, a dirty answer and the viewport it
// was opened on; apply() awaits its restore last, on the restored active plane, inside the same deadline.
const mipBlock=(over={})=>({schema:1,algorithm:'kin-mip-1',coordinates:'LPS_mm',frameOfReference:'1.2.9',mode:'Raysum',orientation:'Coronal',
  display:{voiRange:{lower:-1000,upper:1000},interpolationType:1},voiSlab:{center:[1,2,3],normal:[0,0,1],pivot:[1,2,3],thickness:4},...over});
const mipTool=(value,{dirty=false,viewport='vp-0',calls=[]}={})=>({capture:readOnly=>{calls.push(readOnly);return value;},dirty:()=>dirty,viewport:()=>viewport});

test('a confirmed MIP Viewer display on the three-plane layout saves as version 12 beside the exact version 4 cells',()=>{
 for(const [rows,cols] of [[1,3],[3,1]]){
  const calls=[],block=mipBlock(),value=world(rows,cols,PLANES,{mip:mipTool(block,{calls})}).capture(true);
  assert.equal(value.version,12);assert.deepEqual(value.mip,block);assert.deepEqual(calls,[true]);
  assert.deepEqual(Object.keys(value).sort(),['active','cells','cols','mip','rows','studies','version','volume']);
  const plain=world(rows,cols,PLANES).capture();delete value.mip;value.version=4;assert.deepEqual(value,plain);
 }
 // A closed viewer or no capability at all leaves every established version untouched; a VOI-off display is still version 12.
 assert.equal(world(1,3,PLANES,{mip:mipTool(null)}).capture().version,4);
 assert.equal(world(1,3,PLANES,{mip:undefined}).capture().version,4);
 assert.equal(world(1,3,PLANES,{mip:mipTool(mipBlock({voiSlab:null}))}).capture().version,12);
 // The capability's own refusal (Rendering, Original, geometry) is the save refusal.
 assert.throws(()=>world(1,3,PLANES,{mip:{capture:()=>{throw Error('최종 표시를 확인한 뒤 MIP 작업을 저장하세요.');},dirty:()=>true,viewport:()=>'vp-0'}}).capture(),/최종 표시를 확인한 뒤/);
});

test('a MIP display is refused beside a curve, path, batch or marks, off the active plane, with another W/L and off the three-plane layout',()=>{
 const tool=over=>mipTool(mipBlock(),over),dirty={capture:()=>{throw Error('no target');},dirty:()=>true,viewport:()=>null};
 const batch={cell:{},offset:0,interval:1,count:2,reverse:false},marks={version:1,visible:true,sync:true,marks:[{point:[0,0,0]}]};
 assert.throws(()=>world(1,3,PLANES,{mip:tool(),curved:{capture:()=>({schema:1,kind:'curved'}),dirty:()=>false}}).capture(),/MIP 작업은 곡면 MPR·3D Path와 함께/);
 assert.throws(()=>world(1,3,PLANES,{mip:tool(),path:{capture:()=>({schema:1,algorithm:'kin-path-1'}),dirty:()=>false}}).capture(),/MIP 작업은 곡면 MPR·3D Path와 함께/);
 assert.throws(()=>world(1,3,PLANES,{mip:tool(),batch}).capture(),/MIP 작업은 단면 묶음·3D 표식과 함께/);
 assert.throws(()=>world(3,1,PLANES,{mip:tool(),marks}).capture(),/MIP 작업은 단면 묶음·3D 표식과 함께/);
 assert.equal(world(1,3,PLANES,{mip:tool(),marks:{version:1,visible:true,sync:true,marks:[]}}).capture().version,12,'a quiet marks tool is not a conflict');
 assert.throws(()=>world(1,3,PLANES,{mip:tool({viewport:'vp-1'})}).capture(),/활성 평면이 아니어서/);
 assert.equal(world(1,3,PLANES,{active:1,mip:tool({viewport:'vp-1'})}).capture().active,1);
 for(const display of [{voiRange:{lower:-1000+1e-9,upper:1000},interpolationType:1},{voiRange:{lower:-1000,upper:999},interpolationType:1},{voiRange:{lower:-1000,upper:1000},interpolationType:0}])
  assert.throws(()=>world(1,3,PLANES,{mip:mipTool(mipBlock({display}))}).capture(),/밝기 범위·보간이 활성 MPR 평면과 달라/,JSON.stringify(display));
 assert.throws(()=>world(2,2,['axial','sagittal','coronal',null],{mip:tool()}).capture(),/MIP 작업은 3평면 1×3·3×1 MPR 배치에서/);
 assert.throws(()=>world(2,2,['axial','frame','coronal',null],{mip:dirty}).capture(),/MIP 작업은 3평면 1×3·3×1 MPR 배치에서/);
 assert.throws(()=>world(2,2,['axial','coronal',null],{rects:ROW_TOP,mip:dirty}).capture(),/MIP 작업은 3평면 1×3·3×1 MPR 배치에서/);
 assert.equal(world(2,2,['axial','frame','coronal',null],{mip:{capture:()=>{throw Error('must not be asked');},dirty:()=>false}}).capture().version,8);
});

// apply() over a fake native grid: setLayout builds the requested viewports, each plane echoes the camera, properties,
// blend and slab it is given, and the order of layout, active plane and tool calls is logged.
function restoreWorld(tools={}){
 const log=[],viewports=new Map(),lookup=new Map();let active=null;
 context.requestAnimationFrame=callback=>setTimeout(callback,0);context.devicePixelRatio=1;
 Object.assign(context.window,{kinVolumeBatchState:undefined,cornerstoneTools:undefined,kinMprMarks:tools.marks,kinMprCurved:tools.curved,kinMprPath:tools.path,kinVolumeMipJob:tools.mip});
 const plane=id=>{let camera={},blend=0,half=.05,properties={};
  return {id,type:'orthographic',getVolumeId:()=>'volume-1',getCanvas:()=>({width:256,height:256,clientWidth:256,clientHeight:256}),
   getCamera:()=>structuredClone(camera),setCamera:next=>{camera={...camera,...structuredClone(next)};},getProperties:()=>properties,setProperties:next=>{properties={...properties,...next};},
   setBlendMode:mode=>{blend=mode;},getSlabThickness:()=>half,setSlabThickness:value=>{half=value;},resetSlabThickness:()=>{half=.05;},render:()=>{},
   getActors:()=>[{actor:{getMapper:()=>({getBlendMode:()=>blend}),getProperty:()=>({getScalarOpacity:()=>opacity})}}]};};
 const grid={getState:()=>({layout:{numRows:1,numCols:3,layoutType:'grid'},viewports,activeViewportId:active}),
  setLayout:async({numRows,numCols,activeViewportId,findOrCreateViewport})=>{
   log.push('setLayout');viewports.clear();lookup.clear();active=activeViewportId;
   for(let i=0;i<numRows*numCols;i++){const spec=findOrCreateViewport(i),id=spec.viewportOptions.viewportId;
    viewports.set(id,{viewportId:id,x:(i%numCols)/numCols,y:Math.floor(i/numCols)/numRows,width:1/numCols,height:1/numRows,displaySetInstanceUIDs:spec.displaySetInstanceUIDs,viewportOptions:spec.viewportOptions,isReady:true});
    lookup.set(id,plane(id));}},
  setActiveViewportId:id=>{log.push('active:'+[...viewports.keys()].indexOf(id));active=id;}};
 const jobs=context.window.kinCreateVolumeJob({grid,cs:{getCornerstoneViewport:id=>lookup.get(id)},
  ds:{getActiveDisplaySets:()=>[{StudyInstanceUID:STUDY,SeriesInstanceUID:SERIES,displaySetInstanceUID:SET,images:SOPS.map(sop=>({SOPInstanceUID:sop,SOPClassUID:'1.2.840.10008.5.1.4.1.1.2'}))}]},
  studies:[STUDY],stack:frameHelper()});
 return {jobs,log,grid,cameras:()=>[...viewports.keys()].map(id=>lookup.get(id).getCamera())};
}
const mipRestorer=(outcome,world)=>({calls:[],cleared:0,
 restore(value,current,deadline,viewportId){world().log.push('mip');this.calls.push({value,current,deadline,viewportId,active:world().grid.getState().activeViewportId,cameras:world().cameras()});return outcome();},
 clearForJob(){this.cleared++;world().log.push('clear');}});

test('closing the MIP Viewer a restore opened passes without advancing serial; other outside input is swallowed or advances it',()=>{
 // CA1: the Jobs panel's input decision over the real viewer-jobs.js. The rollback runs only while serial === ticket, so the
 // cancel must reach the dialog (not swallowed) and must leave the restore ticket current (not advance serial).
 const jobsContext=vm.createContext({window:{}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../worklist-v0/hpacs-lite/viewer-jobs.js'),'utf8'),jobsContext);
 const decide=jobsContext.window.kinViewerJobs.interaction;
 assert.equal(decide({inPanel:false,applying:true,cancelsRestore:true}),'pass','a restore cancel is neither swallowed nor a serial change');
 assert.equal(decide({inPanel:false,applying:true,cancelsRestore:false}),'swallow','any other input during a restore');
 assert.equal(decide({inPanel:false,applying:false,cancelsRestore:false}),'advance');
 assert.equal(decide({inPanel:false,applying:false,cancelsRestore:true}),'advance','no exemption outside a restore');
 assert.equal(decide({inPanel:true,applying:true,cancelsRestore:false}),'pass');assert.equal(decide({inPanel:true,applying:false,cancelsRestore:false}),'pass');
});

test('resolve(v12) refuses a missing MIP tool or an algorithm it cannot reproduce before any layout change',async()=>{
 const saved=world(1,3,PLANES,{mip:mipTool(mipBlock())}).capture();assert.equal(saved.version,12);
 let order=restoreWorld({});
 assert.throws(()=>order.jobs.resolve(saved),/MIP Viewer 도구를 불러오지 못했습니다/);
 await assert.rejects(order.jobs.apply(structuredClone(saved),()=>true),/MIP Viewer 도구를 불러오지 못했습니다/);assert.deepEqual(order.log,[]);
 const tool={restore:async()=>{throw Error('must not restore');},clearForJob(){}};
 for(const [label,change] of [['schema 2',s=>{s.mip.schema=2;}],['algorithm kin-mip-2',s=>{s.mip.algorithm='kin-mip-2';}],['coordinates RAS_mm',s=>{s.mip.coordinates='RAS_mm';}],['missing mip',s=>{delete s.mip;}]]){
  const s=structuredClone(saved);change(s);order=restoreWorld({mip:tool});
  assert.throws(()=>order.jobs.resolve(s),/계산 방식을 이 뷰어가 재현할 수 없어/,label);
  await assert.rejects(order.jobs.apply(s,()=>true),/계산 방식을 이 뷰어가 재현할 수 없어/,label);assert.deepEqual(order.log,[],label);
 }
 order=restoreWorld({mip:tool});assert.equal(order.jobs.resolve(saved),SET);
});

test('apply(v12) awaits the MIP restore after cells and cameras and propagates its failure; every other version closes the MIP',async()=>{
 const block=mipBlock(),saved=world(1,3,PLANES,{active:2,mip:mipTool(block,{viewport:'vp-2'})}).capture();assert.equal(saved.version,12);
 let order;const ok=mipRestorer(()=>Promise.resolve(),()=>order);order=restoreWorld({mip:ok});
 const started=Date.now();await order.jobs.apply(structuredClone(saved),()=>true);
 assert.deepEqual(order.log,['setLayout','active:2','mip']);assert.equal(ok.calls.length,1);assert.equal(ok.cleared,0);
 const call=ok.calls[0];assert.deepEqual(call.value,block);assert.equal(call.viewportId,call.active,'the MIP reopens on the restored active plane');
 assert.equal(typeof call.current,'function');assert.ok(call.deadline>=started+60000&&call.deadline<=Date.now()+60000,'the Job restore deadline');
 call.cameras.forEach((camera,i)=>{for(const key of ['focalPoint','position','viewUp','viewPlaneNormal','parallelScale'])assert.deepEqual(camera[key],saved.cells[i].camera[key],key);});
 const failing=mipRestorer(()=>Promise.reject(Error('INJECTED MIP RESTORE FAILURE')),()=>order);order=restoreWorld({mip:failing});
 await assert.rejects(order.jobs.apply(structuredClone(saved),()=>true),/INJECTED MIP RESTORE FAILURE/);assert.equal(failing.calls.length,1);
 const v4=world(1,3,PLANES).capture(),closing=mipRestorer(()=>Promise.reject(Error('must not restore')),()=>order);order=restoreWorld({mip:closing});
 await order.jobs.apply(structuredClone(v4),()=>true);assert.equal(closing.calls.length,0);assert.equal(closing.cleared,1);
 const route={schema:1,algorithm:'kin-path-1'},v11=world(1,3,PLANES,{path:{capture:()=>route,dirty:()=>false}}).capture(),paths=[];
 const closing11=mipRestorer(()=>Promise.reject(Error('must not restore')),()=>order);
 order=restoreWorld({mip:closing11,path:{restore:async value=>{paths.push(value);order.log.push('path');},clearForJob(){}}});
 await order.jobs.apply(structuredClone(v11),()=>true);assert.deepEqual(paths,[route]);assert.equal(closing11.cleared,1);assert.deepEqual(order.log.slice(-2),['path','clear']);
});

// B1 (A11-VOI-2 review-01): a failed first display reaches the MIP Viewer only through the sequence's fatal callback, so
// restore() must throw that same reason into the Job rollback (the Jobs status the native N3 reads), not a generic fallback.
// The real viewer-volume-mip.js runs in its own browser-like realm beside the real volume-mip.js, volume-voi.js and
// volume-mip-job.js; only the DOM, the account fetch and the native viewport are stand-ins. A fault-free restore reaching
// Final proves the stand-ins drive the real restore path, so each fault below is the only difference.
function mipViewerWorld({planeWrite=null,gpu=true}={}){
 const node=tag=>{const children=[],on=new Map(),attributes={};const e={tagName:tag,children,attributes,style:{},dataset:{},className:'',textContent:'',value:'',checked:false,disabled:false,open:false,
  append:(...items)=>{children.push(...items);},remove(){e.removed=true;},replaceChildren:(...items)=>{children.splice(0,children.length,...items);},setAttribute:(name,value)=>{attributes[name]=String(value);},
  addEventListener:(name,listener)=>{if(!on.has(name))on.set(name,new Set());on.get(name).add(listener);},removeEventListener:(name,listener)=>{on.get(name)?.delete(listener);},
  emit:name=>{for(const listener of [...(on.get(name)||[])])listener({type:name,target:e});},contains:item=>item===e||children.some(c=>c.contains?.(item)),showModal(){e.open=true;},close(){e.open=false;}};return e;};
 const find=(root,match)=>match(root)?root:root.children.map(c=>find(c,match)).find(Boolean)||null;
 const presets={axial:{viewPlaneNormal:[0,0,-1],viewUp:[0,-1,0]},sagittal:{viewPlaneNormal:[1,0,0],viewUp:[0,0,1]},coronal:{viewPlaneNormal:[0,-1,0],viewUp:[0,0,1]}};
 const volume={volumeId:'volume-1',dimensions:[64,64,33],spacing:[.5,.5,2.5],imageIds:['image:1'],imageData:{getSpatialExtent:()=>[0,63,0,63,0,32],indexToWorld:i=>[i[0]*.5,i[1]*.5,i[2]*2.5]}};
 const views=new Map(),shader='for(int i = 0; i < 4; i++) {\n  float rayDirRatio = dot(rayDir, vClipPlaneNormals[i]);\n  if (rayDirRatio < 0.0) dists.y = min(dists.y, result);\n  else dists.x = max(dists.x, result);\n}';
 const engine={views,enableElement({viewportId,element}){
   // The MIP viewport: its two slab planes follow the camera and half thickness about the volume centre; VOI planes append.
   let camera=null,blend=0,half=0,properties={};const extra=[],centre=[15.75,15.75,40];
   const slab=sign=>({getOrigin:()=>centre.map((x,i)=>x-sign*camera.viewPlaneNormal[i]*half),getNormal:()=>camera.viewPlaneNormal.map(n=>sign*n)});
   const mapper={getBlendMode:()=>blend,getSampleDistance:()=>(.5+.5+2.5)/6,getClippingPlanes:()=>[...(camera?[slab(1),slab(-1)]:[]),...extra],
    addClippingPlane:plane=>{planeWrite?.();extra.push(plane);return true;},removeClippingPlane:plane=>{const i=extra.indexOf(plane);if(i<0)return false;extra.splice(i,1);return true;}};
   const actor={getMapper:()=>mapper,getProperty:()=>({getInterpolationType:()=>properties.interpolationType})};
   views.set(viewportId,{mapper,suppressEvents:true,getVolumeId:()=>volume.volumeId,setVolumes:async()=>{},getActors:()=>[{actor}],
    // The pinned viewport takes either a native orientation key (the three MPR planes) or an OrientationVectors pair, which is
    // how the manual's anatomical presets are written (A11-ORIENT-1 MF5). Anything else is refused, as the runtime would.
    setOrientation:(orientation,immediate)=>{const axes=typeof orientation==='string'?presets[orientation]:orientation;
     if(!axes||!Array.isArray(axes.viewPlaneNormal)||!Array.isArray(axes.viewUp))throw Error('Invalid orientation');
     camera={viewPlaneNormal:[...axes.viewPlaneNormal],viewUp:[...axes.viewUp]};},setBlendMode:value=>{blend=value;},setSlabThickness:value=>{half=value;},
    setProperties:value=>{properties={...properties,...value};},getProperties:()=>properties,getCamera:()=>structuredClone(camera),
    render:()=>{setTimeout(()=>element.emit('IMAGE_RENDERED'),0);}});
  },getViewport:id=>views.get(id),disableElement:id=>{views.delete(id);}};
 // Without this linked program the viewer cannot confirm its clip shader, exactly as when the GPU check fails natively.
 if(gpu)engine.offscreenMultiRenderWindow={getOpenGLRenderWindow:()=>({getViewNodeFor:mapper=>[...views.values()].some(v=>v.mapper===mapper)?
  {get:name=>name==='tris'?{tris:{getProgram:()=>({getCompiled:()=>true,getLinked:()=>true,getFragmentShader:()=>({getSource:()=>shader})})}}:null}:null})};
 const source={id:'vp-0',getVolumeId:()=>volume.volumeId,getRenderingEngine:()=>engine,getActors:()=>[{actor:{getMapper:()=>({})}}],
  getProperties:()=>({voiRange:{lower:-1100,upper:1100},interpolationType:0})};
 const target={group:'group-1',selection:'selection-1',views:[source,{id:'vp-1'},{id:'vp-2'}],source:{viewportId:'vp-0',uid:'1.2.3',series:'1.2.4',study:{id:'SYNTHETIC'}}};
 const document={createElement:node,body:node('body'),head:node('head'),querySelectorAll:()=>[]};
 const sandbox={document,structuredClone,crypto,AbortController,setTimeout,clearTimeout,clearInterval,
  setInterval:(callback,ms)=>{const timer=setInterval(callback,ms);timer.unref();return timer;},ResizeObserver:class{observe(){}disconnect(){}},
  fetch:async url=>({ok:true,json:async()=>url==='/api/me'?{kind:'member',institution:'I1',sub:'u1'}:[]}),
  cornerstone:{cache:{getVolume:id=>id===volume.volumeId?volume:null},metaData:{get:(type,id)=>type==='instance'&&id==='image:1'?{FrameOfReferenceUID:'2.25.6'}:null},
   Enums:{Events:{IMAGE_RENDERED:'IMAGE_RENDERED'},ViewportType:{ORTHOGRAPHIC:'orthographic'}},CONSTANTS:{MPR_CAMERA_VALUES:presets}}};
 sandbox.window=sandbox;const realm=vm.createContext(sandbox);
 for(const file of ['volume-mip.js','volume-voi.js','volume-mip-job.js','viewer-volume-mip.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../worklist-v0/hpacs-lite',file),'utf8'),realm,{filename:file});
 const notices=[],viewer=realm.kinCreateVolumeMip({target:()=>target,permitted:()=>true,alive:()=>true,owner:()=>['I1','u1'],notice:message=>notices.push(message)});
 const dialog=document.body.children[0];
 return {viewer,dialog,views,notices,window:sandbox,find:match=>find(dialog,match),status:()=>find(dialog,e=>e.attributes.role==='status')?.textContent};
}

test('a MIP Job restore throws the failed first display reason itself: a plane write fault or an unconfirmed GPU clip shader closes the viewer with that reason',async()=>{
 const value={schema:1,algorithm:'kin-mip-1',coordinates:'LPS_mm',frameOfReference:'2.25.6',mode:'MIP',orientation:'Axial',
  display:{voiRange:{lower:-1100,upper:1100},interpolationType:0},voiSlab:{center:[8.125,15.75,40],normal:[1,0,0],pivot:[15.75,15.75,40],thickness:22.25}};
 const restore=world=>world.viewer.job.restore(structuredClone(value),{current:()=>true,deadline:Date.now()+20000,viewportId:'vp-0'});
 let world=mipViewerWorld();
 try{
  await restore(world);
  assert.equal(world.dialog.open,true);assert.equal(world.dialog.dataset.kinMipState,'final');assert.match(world.status(),/^저장한 MIP 작업을 복원했습니다/);assert.deepEqual(world.notices,[]);
 }finally{world.viewer.dispose();}
 for(const [label,options,reason] of [
   ['clipping-plane write fault',{planeWrite:()=>{throw Error('INJECTED MIP JOB PLANE WRITE');}},'INJECTED MIP JOB PLANE WRITE'],
   ['GPU clip shader not confirmed',{gpu:false},'투영 셰이더를 GPU에서 확인하지 못했습니다.']]){
  world=mipViewerWorld(options);
  try{
   const error=await restore(world).then(()=>null,e=>e);
   assert.ok(error,label+' must refuse the restore');
   assert.equal(error.message,reason,label+': the Job rollback receives the sequence failure itself');
   assert.equal(world.dialog.open,false,label);assert.equal(world.views.size,0,label+': the MIP viewport is disabled');
   assert.deepEqual(world.notices,['MIP Viewer를 닫았습니다. '+reason],label);
  }finally{world.viewer.dispose();}
 }
});

// N1-N3 (A11-VOI-2 native-fix-01): Save MIP Job is pressed inside the MIP Viewer's own modal dialog. In the standalone viewer
// window the MPR tools behind an open dialog refuse a target that is not read-only (viewer-tech-note.js orientation allowed:
// no dialog[open]; viewer-volume-orientation.js:47), and the marks tool asks for exactly that target (viewer-volume-marks.js
// capture). The real viewer-jobs.js drives the real viewer-volume-job.js here; the marks tool stands in for that refusal, the
// MIP tool returns a confirmed block, and fetch answers the account, the Job list and the POST with its committed receipt.
async function mipSaveWorld(){
 const real=context.window.kinCreateVolumeJob;let parts=null;
 context.window.kinCreateVolumeJob=args=>{parts=args;return real(args);};
 try{world(1,3,PLANES);}finally{context.window.kinCreateVolumeJob=real;}
 const block=mipBlock(),gate={dialog:false,marks:[],readOnly:[]},posts=[],saved=[];
 const marks={dirty:()=>false,saved(){},capture(readOnly=false){
  gate.readOnly.push(readOnly);if(readOnly!==true&&gate.dialog)throw Error('다른 작업을 마친 뒤 MPR 방향을 조절하세요.');
  return {version:1,visible:true,sync:true,marks:gate.marks};}};
 const mip={capture:()=>block,dirty:()=>false,viewport:()=>'vp-0',saved:(value,volume)=>{saved.push(JSON.parse(JSON.stringify({value,volume})));}};
 context.window.kinMprMarks=marks;context.window.kinVolumeMipJob=mip;
 const element=tag=>{const children=[];return {tagName:tag,children,style:{},dataset:{},textContent:'',value:'',checked:false,disabled:false,isConnected:true,
  append:(...items)=>{children.push(...items);},prepend:(...items)=>{children.unshift(...items);},insertBefore:item=>{children.push(item);},
  replaceChildren:(...items)=>{children.splice(0,children.length,...items);},setAttribute(){},remove(){},querySelector:selector=>children.find(c=>c.tagName===selector)||null};};
 const layout=element('details');layout.append(element('summary'));
 const jobs='/api/studies/'+STUDY+'/viewer-jobs';
 const fetch=async(url,options={})=>{
  let body=null;
  if(url==='/api/me')body={kind:'member',institution:'I1',sub:'u1',roles:['radiologist']};
  else if(url===jobs&&options.method==='POST'){const sent=JSON.parse(options.body);posts.push(sent);body={id:sent.id,snapshotVersion:sent.snapshot.version};}
  else if(url.startsWith(jobs+'?'))body={jobs:[]};
  return {status:body?200:404,ok:!!body,json:async()=>body};};
 const sandbox={document:{createElement:element,head:element('head'),querySelector:selector=>selector==='#kin-viewer-layout'?layout:null,addEventListener(){},removeEventListener(){}},
  location:{search:'?StudyInstanceUIDs='+STUDY,origin:'https://kin.test'},fetch,crypto,AbortController,URL,URLSearchParams,setTimeout,clearTimeout,clearInterval,
  setInterval:(callback,ms)=>{const timer=setInterval(callback,ms);timer.unref();return timer;},addEventListener(){},removeEventListener(){},
  kinCreateVolumeJob:real,kinMprMarks:marks,kinVolumeMipJob:mip};
 sandbox.window=sandbox.top=sandbox;const realm=vm.createContext(sandbox);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../worklist-v0/hpacs-lite/viewer-jobs.js'),'utf8'),realm,{filename:'viewer-jobs.js'});
 const panel=sandbox.kinViewerJobs({viewportGridService:parts.grid,cornerstoneViewportService:parts.cs,displaySetService:parts.ds},{scope:()=>({})});
 panel.mount();const command=sandbox.kinViewerJobCommand,idle=async()=>{for(let n=0;n<200&&command.busy();n++)await new Promise(r=>setTimeout(r,0));};
 for(let n=0;n<200&&!command.owner();n++)await new Promise(r=>setTimeout(r,0));await idle();
 const find=(root,match)=>match(root)?root:root.children.map(c=>find(c,match)).find(Boolean)||null;
 return {command,idle,gate,posts,saved,block,job:()=>real(parts),stop:()=>{panel.stop();context.window.kinMprMarks=context.window.kinVolumeMipJob=undefined;},
  status:()=>find(layout,e=>e.id==='kin-viewer-jobs-status').textContent,button:label=>find(layout,e=>e.tagName==='button'&&e.textContent===label)};
}

test('Save MIP Job reads the MPR behind its own open dialog read-only; the named refusal still applies and Save New Job still refuses behind a dialog',async()=>{
 const w=await mipSaveWorld();
 try{
  assert.equal(w.command.owner(),JSON.stringify(['I1','u1']));
  // N2: 3D marks beside the MIP display are refused by name before any request, not by the dialog the save was pressed in.
  // The panel's opening list read the screen while no dialog was open; only the saves below are counted.
  w.gate.dialog=true;w.gate.marks=[{id:'synthetic-mark'}];w.gate.readOnly.length=0;
  let outcome=await w.command.save({title:'MIP gates',description:''});
  assert.equal(outcome.state,'not-saved');assert.equal(outcome.sent,false);assert.match(outcome.message,/^MIP 작업은 단면 묶음·3D 표식과 함께 저장할 수 없습니다/);
  assert.deepEqual(w.posts,[]);assert.ok(w.gate.readOnly.length&&w.gate.readOnly.every(r=>r===true),JSON.stringify(w.gate.readOnly));
  // N1/N3: without marks the same dialog sends exactly one version 12 body and is Saved only by its committed receipt.
  w.gate.marks=[];w.gate.readOnly.length=0;
  outcome=await w.command.save({title:'MIP oblique Raysum',description:''});
  assert.equal(outcome.state,'saved',outcome.message);assert.equal(outcome.sent,true);assert.match(outcome.message,/^MIP 작업을 저장했습니다/);
  assert.equal(w.posts.length,1);assert.equal(w.posts[0].title,'MIP oblique Raysum');assert.equal(w.posts[0].snapshot.version,12);assert.deepEqual(w.posts[0].snapshot.mip,w.block);
  assert.ok(w.gate.readOnly.length&&w.gate.readOnly.every(r=>r===true),JSON.stringify(w.gate.readOnly));assert.equal(w.saved.length,1);assert.deepEqual(w.saved[0].value,w.block);
  // The panel's own Save New Job is not pressed inside that dialog: its capture stays a permitted one and is refused behind it.
  w.gate.readOnly.length=0;w.button('Save New Job').onclick();await w.idle();
  assert.match(w.status(),/^다른 작업을 마친 뒤 MPR 방향을 조절하세요\./);assert.equal(w.posts.length,1);assert.ok(w.gate.readOnly.includes(false));
 }finally{w.stop();}
});

// Native N1 at test_volume_mip_job.py:129 (native-fix-02): with the restored MIP Viewer still open, the e2e read its Job with the
// permitted capture and met the same refusal. The read-only capture is the very body Save MIP Job sent; the permitted one stays refused.
test('behind the open MIP Viewer a read-only Job capture is the version 12 body Save MIP Job sent, and a permitted capture is refused',async()=>{
 const w=await mipSaveWorld();
 try{
  w.gate.dialog=true;
  const outcome=await w.command.save({title:'MIP oblique Raysum',description:''});assert.equal(outcome.state,'saved',outcome.message);assert.equal(w.posts.length,1);
  w.gate.readOnly.length=0;assert.deepEqual(JSON.parse(JSON.stringify(w.job().capture(true))),w.posts[0].snapshot);assert.deepEqual(w.gate.readOnly,[true]);
  w.gate.readOnly.length=0;assert.throws(()=>w.job().capture(),{message:'다른 작업을 마친 뒤 MPR 방향을 조절하세요.'});assert.deepEqual(w.gate.readOnly,[false]);
 }finally{w.stop();}
});

// Native N2 at test_volume_mip_job.py:241 (native-fix-02): a session ended while Save MIP Job waits disposes the MIP Viewer, which
// closes its dialog and removes it from the page, so a later read of its summary by selector finds no node. The summary element the
// reader saw, and the viewer's status, never show a save afterwards, even when the held request then reports a committed one.
test('a MIP Viewer disposed while Save MIP Job waits is closed and removed, and never shows Saved when that request ends',async()=>{
 const value={schema:1,algorithm:'kin-mip-1',coordinates:'LPS_mm',frameOfReference:'2.25.6',mode:'MIP',orientation:'Axial',
  display:{voiRange:{lower:-1100,upper:1100},interpolationType:0},voiSlab:{center:[8.125,15.75,40],normal:[1,0,0],pivot:[15.75,15.75,40],thickness:22.25}};
 const world=mipViewerWorld(),calls=[];let release=null;
 world.window.kinViewerJobCommand={owner:()=>JSON.stringify(['I1','u1']),writable:()=>true,busy:()=>false,pending:()=>null,
  save:fields=>{calls.push(fields);return new Promise(resolve=>{release=resolve;});},retry:()=>Promise.reject(Error('must not retry'))};
 try{
  await world.viewer.job.restore(structuredClone(value),{current:()=>true,deadline:Date.now()+20000,viewportId:'vp-0'});
  const summary=world.find(e=>e.className==='kin-mip-voi-state');assert.match(summary.textContent,/ · Saved$/);
  world.find(e=>e.attributes['aria-label']==='MIP Job Title').value='MIP held session';world.find(e=>e.tagName==='button'&&e.textContent==='Save MIP Job').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{title:'MIP held session',description:''}]);assert.match(summary.textContent,/ · Saving$/);
  world.viewer.dispose();
  assert.equal(world.dialog.open,false);assert.equal(world.dialog.removed,true);
  release({state:'saved',sent:true,message:'MIP 작업을 저장했습니다. 판독문과 원본 영상은 그대로입니다.'});
  for(let n=0;n<5;n++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.doesNotMatch(summary.textContent,/Saved/);assert.doesNotMatch(world.status(),/저장했습니다/);
 }finally{world.viewer.dispose();}
});

// A11-BATCH-1 P2: version 13 is the exact version 12 snapshot plus the recipe of the MIP Batch preview shown with that display.
const batchRecipe=(over={})=>({schema:1,algorithm:'kin-mip-batch-1',axis:'Horizontal',interval:90,count:4,reverse:false,...over});
const batchMipTool=(value,recipe,{calls=[],viewport='vp-0'}={})=>({capture:readOnly=>{calls.push(['capture',readOnly]);return value;},batch:readOnly=>{calls.push(['batch',readOnly]);return recipe;},dirty:()=>false,viewport:()=>viewport});
const nearly=(actual,want,tolerance,label)=>{assert.equal(actual.length,want.length,label);actual.forEach((n,i)=>assert.ok(Math.abs(n-want[i])<=tolerance,label+'['+i+'] '+n+' != '+want[i]));};
const until=async(predicate,label='condition')=>{for(let n=0;n<2000&&!predicate();n++)await new Promise(resolve=>setTimeout(resolve,0));assert.ok(predicate(),label);};

test('a MIP Batch preview saves as version 13 = the exact version 12 snapshot plus mipBatch; without one it stays version 12',()=>{
 for(const [rows,cols] of [[1,3],[3,1]]){
  const calls=[],block=mipBlock(),recipe=batchRecipe(),value=world(rows,cols,PLANES,{mip:batchMipTool(block,recipe,{calls})}).capture(true);
  assert.equal(value.version,13);assert.deepEqual(value.mipBatch,recipe);assert.deepEqual(value.mip,block);
  assert.deepEqual(calls,[['capture',true],['batch',true]],'the block and then its recipe, in one capture');
  assert.deepEqual(Object.keys(value).sort(),['active','cells','cols','mip','mipBatch','rows','studies','version','volume']);
  const v12=world(rows,cols,PLANES,{mip:batchMipTool(block,null)}).capture();assert.equal(v12.version,12);assert.equal('mipBatch' in v12,false);
  delete value.mipBatch;value.version=12;assert.deepEqual(value,v12);
 }
 assert.equal(world(1,3,PLANES,{mip:mipTool(mipBlock())}).capture().version,12,'a tool without the batch capability');
 const calls=[];assert.equal(world(1,3,PLANES,{mip:batchMipTool(null,batchRecipe(),{calls})}).capture().version,4);assert.deepEqual(calls,[['capture',false]],'no display, no recipe asked');
 // A MIP Batch being made refuses with its own reason; the version 12 exclusivity names the other tools as before.
 assert.throws(()=>world(1,3,PLANES,{mip:{...batchMipTool(mipBlock(),null),batch:()=>{throw Error('MIP Batch 생성을 마친 뒤 MIP 작업을 저장하세요.');}}}).capture(),/^Error: MIP Batch 생성을 마친 뒤/);
 const tool=over=>batchMipTool(mipBlock(),batchRecipe(),over),marks={version:1,visible:true,sync:true,marks:[{point:[0,0,0]}]};
 assert.throws(()=>world(1,3,PLANES,{mip:tool(),path:{capture:()=>({schema:1,algorithm:'kin-path-1'}),dirty:()=>false}}).capture(),/MIP 작업은 곡면 MPR·3D Path와 함께/);
 assert.throws(()=>world(1,3,PLANES,{mip:tool(),curved:{capture:()=>({schema:1,kind:'curved'}),dirty:()=>false}}).capture(),/MIP 작업은 곡면 MPR·3D Path와 함께/);
 assert.throws(()=>world(1,3,PLANES,{mip:tool(),batch:{cell:{},offset:0,interval:1,count:2,reverse:false}}).capture(),/MIP 작업은 단면 묶음·3D 표식과 함께/);
 assert.throws(()=>world(3,1,PLANES,{mip:tool(),marks}).capture(),/MIP 작업은 단면 묶음·3D 표식과 함께/);
 assert.throws(()=>world(1,3,PLANES,{mip:tool({viewport:'vp-1'})}).capture(),/활성 평면이 아니어서/);
 assert.throws(()=>world(1,3,PLANES,{mip:batchMipTool(mipBlock({display:{voiRange:{lower:-1000,upper:999},interpolationType:1}}),batchRecipe())}).capture(),/밝기 범위·보간이 활성 MPR 평면과 달라/);
 assert.throws(()=>world(2,2,['axial','sagittal','coronal',null],{mip:tool()}).capture(),/MIP 작업은 3평면 1×3·3×1 MPR 배치에서/);
});

test('resolve(v13) checks both algorithm ids without the lazily loaded MIP Batch model; apply hands the recipe and the Job deadline to the MIP restore',async()=>{
 const block=mipBlock(),recipe=batchRecipe(),saved=world(1,3,PLANES,{active:1,mip:batchMipTool(block,recipe,{viewport:'vp-1'})}).capture();assert.equal(saved.version,13);
 const refusing={restore:async()=>{throw Error('must not restore');},clearForJob(){}};
 // RC-3: a fresh page has no window.KinVolumeMipBatch until the MIP restore loads it, so resolve must not ask for it.
 let order=restoreWorld({mip:refusing});assert.equal(context.window.KinVolumeMipBatch,undefined);assert.equal(order.jobs.resolve(saved),SET);
 order=restoreWorld({});assert.throws(()=>order.jobs.resolve(saved),/MIP Viewer 도구를 불러오지 못했습니다/);
 for(const [label,change,pattern] of [['batch schema 2',s=>{s.mipBatch.schema=2;},/MIP Batch 작업의 계산 방식을/],['batch algorithm kin-mip-batch-2',s=>{s.mipBatch.algorithm='kin-mip-batch-2';},/MIP Batch 작업의 계산 방식을/],
   ['missing mipBatch',s=>{delete s.mipBatch;},/MIP Batch 작업의 계산 방식을/],['mip algorithm kin-mip-2',s=>{s.mip.algorithm='kin-mip-2';},/이 MIP 작업의 계산 방식을/]]){
  const s=structuredClone(saved);change(s);order=restoreWorld({mip:refusing});
  assert.throws(()=>order.jobs.resolve(s),pattern,label);await assert.rejects(order.jobs.apply(s,()=>true),pattern,label);assert.deepEqual(order.log,[],label);
 }
 const restorer={calls:[],cleared:0,restore(value,current,deadline,viewportId,batch){order.log.push('mip');this.calls.push({value,current,deadline,viewportId,batch,active:order.grid.getState().activeViewportId});return Promise.resolve();},clearForJob(){this.cleared++;order.log.push('clear');}};
 order=restoreWorld({mip:restorer});const started=Date.now();await order.jobs.apply(structuredClone(saved),()=>true);
 assert.deepEqual(order.log,['setLayout','active:1','mip']);assert.equal(restorer.cleared,0);
 const call=restorer.calls[0];assert.deepEqual(call.value,block);assert.deepEqual(call.batch,recipe);assert.equal(call.viewportId,call.active);assert.equal(typeof call.current,'function');
 assert.ok(call.deadline>=started+60000&&call.deadline<=Date.now()+60000,'the unchanged 60 s Job deadline, not a batch budget');
 // A version 12 Job hands over no recipe, and every other version closes the MIP Viewer and its preview.
 // Both snapshots are captured before restoreWorld installs the restorer: world() replaces the MIP tool with the one it is given.
 const v12=world(1,3,PLANES,{mip:mipTool(block)}).capture(),v4=world(1,3,PLANES).capture();assert.deepEqual([v12.version,v4.version],[12,4]);
 restorer.calls.length=0;order=restoreWorld({mip:restorer});await order.jobs.apply(structuredClone(v12),()=>true);
 assert.equal(restorer.calls.length,1);assert.equal(restorer.calls[0].batch,null);
 restorer.calls.length=0;order=restoreWorld({mip:restorer});await order.jobs.apply(structuredClone(v4),()=>true);
 assert.equal(restorer.calls.length,0);assert.equal(restorer.cleared,1);
 const failing={restore:()=>Promise.reject(Error('INJECTED MIP BATCH RESTORE FAILURE')),clearForJob(){}};order=restoreWorld({mip:failing});
 await assert.rejects(order.jobs.apply(structuredClone(saved),()=>true),/INJECTED MIP BATCH RESTORE FAILURE/);
});

// The real viewer-volume-mip.js and volume-mip-batch.js in the browser-like realm of mipViewerWorld above. This native stand-in also
// serves the private MIP Batch viewport: its slab planes follow a camera only the way the pinned Viewport does (a slab write, or a
// setCamera that moves the focal point along the normal or changes viewUp), frames render asynchronously, a canvas encodes to a blob,
// the linked clip program has one loop per clipping plane, and every batch camera, render, timer and object URL is logged.
function batchViewerWorld({distance=120,faults={},command=null}={}){
 const events=[],created=[],revoked=[],timerMs=new WeakMap();let hold=null,held=null,viewer=null,dialog=null;
 const node=tag=>{const children=[],on=new Map(),attributes={};const e={tagName:tag,children,attributes,style:{},dataset:{},className:'',textContent:'',value:'',checked:false,disabled:false,open:false,
  append:(...items)=>{children.push(...items);},remove(){e.removed=true;},replaceChildren:(...items)=>{children.splice(0,children.length,...items);},
  setAttribute:(name,value)=>{attributes[name]=String(value);},removeAttribute:name=>{delete attributes[name];if(name==='src')e.src='';},
  addEventListener:(name,listener)=>{if(!on.has(name))on.set(name,new Set());on.get(name).add(listener);},removeEventListener:(name,listener)=>{on.get(name)?.delete(listener);},
  emit:name=>{for(const listener of [...(on.get(name)||[])])listener({type:name,target:e});},contains:item=>item===e||children.some(c=>c.contains?.(item)),showModal(){e.open=true;},close(){e.open=false;}};return e;};
 const find=(root,match)=>match(root)?root:root.children.map(c=>find(c,match)).find(Boolean)||null;
 const text=className=>dialog?find(dialog,e=>e.className===className)?.textContent:undefined;
 const status=()=>dialog?find(dialog,e=>e.attributes.role==='status')?.textContent:undefined;
 const presets={axial:{viewPlaneNormal:[0,0,-1],viewUp:[0,-1,0]},sagittal:{viewPlaneNormal:[1,0,0],viewUp:[0,0,1]},coronal:{viewPlaneNormal:[0,-1,0],viewUp:[0,0,1]}};
 const centre=[15.75,15.75,40],dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
 const volume={volumeId:'volume-1',dimensions:[64,64,33],spacing:[.5,.5,2.5],imageIds:['image:1'],imageData:{getSpatialExtent:()=>[0,63,0,63,0,32],indexToWorld:i=>[i[0]*.5,i[1]*.5,i[2]*2.5]}};
 const views=new Map(),loop=n=>'for(int i = 0; i < '+n+'; i++) {\n  float rayDirRatio = dot(rayDir, vClipPlaneNormals[i]);\n  if (rayDirRatio < 0.0) dists.y = min(dists.y, result);\n  else dists.x = max(dists.x, result);\n}';
 const engine={views,enableElement({viewportId,element}){
   const batch=viewportId.startsWith('kin-mipbatch-');let camera=null,blend=0,half=0,properties={},slab=null,specific=null;const extra=[];
   const derive=()=>{slab={focal:[...camera.focalPoint],normal:[...camera.viewPlaneNormal],half};};
   const plane=sign=>({getOrigin:()=>slab.focal.map((x,i)=>x-sign*slab.normal[i]*slab.half),getNormal:()=>slab.normal.map(n=>sign*n)});
   const mapper={getBlendMode:()=>blend,getSampleDistance:()=>(.5+.5+2.5)/6,getClippingPlanes:()=>[...(slab?[plane(1),plane(-1)]:[]),...extra],
    addClippingPlane:p=>{(batch?faults.batchPlane:faults.plane)?.();extra.push(p);return true;},removeClippingPlane:p=>{const i=extra.indexOf(p);if(i<0)return false;extra.splice(i,1);return true;},
    setViewSpecificProperties:value=>{specific=value;},getViewSpecificProperties:()=>specific};
   const actor={getMapper:()=>mapper,getProperty:()=>({getInterpolationType:()=>properties.interpolationType})};
   views.set(viewportId,{id:viewportId,batch,mapper,suppressEvents:true,getVolumeId:()=>volume.volumeId,setVolumes:async()=>{},getActors:()=>[{actor}],
    // Either a native orientation key or the OrientationVectors pair the anatomical presets write (A11-ORIENT-1 MF5).
    setOrientation:(orientation,immediate)=>{const axes=typeof orientation==='string'?presets[orientation]:orientation;
     if(!axes||!Array.isArray(axes.viewPlaneNormal)||!Array.isArray(axes.viewUp))throw Error('Invalid orientation');
     camera={viewPlaneNormal:[...axes.viewPlaneNormal],viewUp:[...axes.viewUp],focalPoint:[...centre],position:centre.map((x,i)=>x+axes.viewPlaneNormal[i]*distance),parallelScale:60};},
    setCamera:next=>{
     const before=camera;camera={...(camera||{}),...structuredClone(next)};if(batch)events.push({type:'setCamera',camera:structuredClone(next)});
     if(slab&&before&&(dot(camera.focalPoint.map((x,i)=>x-before.focalPoint[i]),camera.viewPlaneNormal)!==0||camera.viewUp.some((x,i)=>x!==before.viewUp[i])))derive();},
    setBlendMode:value=>{blend=value;},setSlabThickness:value=>{half=value;if(camera)derive();},
    setProperties:value=>{properties={...properties,...value};},getProperties:()=>properties,getCamera:()=>structuredClone(camera),
    getCanvas:()=>({width:faults.size??512,height:512,toBlob:(callback,type)=>setTimeout(()=>callback(faults.blob?null:{size:1024,type}),0)}),
    render:()=>{
     events.push({type:batch?'render:batch':'render:dialog',planes:batch?mapper.getClippingPlanes().map(p=>({origin:p.getOrigin(),normal:p.getNormal()})):null,status:status(),summary:text('kin-mip-voi-state'),
      cancels:batch&&viewer?viewer.job.cancels({type:'keydown',key:'Escape',target:dialog}):null});
     if(batch&&hold?.(events)){held=element;return;}
     setTimeout(()=>element.emit('IMAGE_RENDERED'),0);}});
  },getViewport:id=>views.get(id),disableElement:id=>{views.delete(id);events.push({type:'disable',id});}};
 engine.offscreenMultiRenderWindow={getOpenGLRenderWindow:()=>({getViewNodeFor:mapper=>{const view=[...views.values()].find(v=>v.mapper===mapper);if(!view)return null;
  return {get:name=>name==='tris'?{tris:{getProgram:()=>({getCompiled:()=>true,getLinked:()=>!(view.batch&&faults.batchGpu),getFragmentShader:()=>({getSource:()=>loop(mapper.getClippingPlanes().length)})})}}:null};}})};
 const source={id:'vp-0',getVolumeId:()=>volume.volumeId,getRenderingEngine:()=>engine,getActors:()=>[{actor:{getMapper:()=>({})}}],getProperties:()=>({voiRange:{lower:-1100,upper:1100},interpolationType:0})};
 const target={group:'group-1',selection:'selection-1',views:[source,{id:'vp-1'},{id:'vp-2'}],source:{viewportId:'vp-0',uid:'1.2.3',series:'1.2.4',study:{id:'SYNTHETIC'}}};
 const document={createElement:node,body:node('body'),head:node('head'),querySelectorAll:()=>[]};
 const sandbox={document,structuredClone,crypto,AbortController,clearInterval,devicePixelRatio:1,
  setTimeout:(callback,ms,...args)=>{const handle=setTimeout(callback,ms,...args);timerMs.set(handle,ms);events.push({type:'timer',ms,handle});return handle;},
  clearTimeout:handle=>{if(handle&&timerMs.has(handle))events.push({type:'clear',ms:timerMs.get(handle),handle});clearTimeout(handle);},
  setInterval:(callback,ms)=>{const timer=setInterval(callback,ms);timer.unref();return timer;},ResizeObserver:class{observe(){}disconnect(){}},
  URL:{createObjectURL:()=>{const url='blob:frame-'+(created.length+1);created.push(url);return url;},revokeObjectURL:url=>{revoked.push(url);}},
  fetch:async url=>({ok:true,json:async()=>url==='/api/me'?{kind:'member',institution:'I1',sub:'u1'}:[]}),kinViewerJobCommand:command||undefined,
  cornerstone:{cache:{getVolume:id=>id===volume.volumeId?volume:null},metaData:{get:(type,id)=>type==='instance'&&id==='image:1'?{FrameOfReferenceUID:'2.25.6'}:null},
   Enums:{Events:{IMAGE_RENDERED:'IMAGE_RENDERED'},ViewportType:{ORTHOGRAPHIC:'orthographic'}},CONSTANTS:{MPR_CAMERA_VALUES:presets}}};
 sandbox.window=sandbox;const realm=vm.createContext(sandbox);
 for(const file of ['volume-mip.js','volume-voi.js','volume-mip-job.js','volume-mip-batch.js','viewer-volume-mip.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../worklist-v0/hpacs-lite',file),'utf8'),realm,{filename:file});
 const notices=[];viewer=realm.kinCreateVolumeMip({target:()=>target,permitted:()=>true,alive:()=>true,owner:()=>['I1','u1'],notice:message=>notices.push(message)});
 dialog=document.body.children[0];
 return {viewer,dialog,views,notices,events,created,revoked,faults,window:sandbox,find:match=>find(dialog,match),status,summary:()=>text('kin-mip-voi-state'),frame:()=>text('kin-mip-batch-frame'),
  button:label=>find(dialog,e=>e.tagName==='button'&&e.textContent===label),field:label=>find(dialog,e=>e.attributes['aria-label']===label),
  setHold:predicate=>{hold=predicate;},held:()=>held,release:()=>{const element=held;held=null;hold=null;setTimeout(()=>element?.emit('IMAGE_RENDERED'),0);}};
}
const batchValue=Object.freeze({schema:1,algorithm:'kin-mip-1',coordinates:'LPS_mm',frameOfReference:'2.25.6',mode:'MIP',orientation:'Axial',
 display:{voiRange:{lower:-1100,upper:1100},interpolationType:0},voiSlab:{center:[8.125,15.75,40],normal:[1,0,0],pivot:[15.75,15.75,40],thickness:22.25}});

test('a MIP Batch Job restore regenerates every frame after Final under its own explicit budget; success and Saved come only after the last frame',async()=>{
 const w=batchViewerWorld(),recipe=batchRecipe();
 try{
  const started=Date.now();await w.viewer.job.restore(structuredClone(batchValue),{current:()=>true,deadline:started+20000,viewportId:'vp-0',batch:structuredClone(recipe)});
  assert.equal(w.dialog.open,true);assert.equal(w.dialog.dataset.kinMipState,'final');assert.deepEqual(w.notices,[]);
  assert.equal(w.status(),'MIP Batch 작업을 복원했습니다. 회전 투영 미리보기는 표시 전용이며 원본 영상과 W/L은 바뀌지 않았습니다.');
  // Every frame camera is the hard-coded axial Horizontal series about the box centre at the Final camera distance (MB3, MB4, MB11).
  const centre=[15.75,15.75,40],thickness=Math.hypot(63*.5,63*.5,32*2.5),normals=[[0,0,-1],[1,0,0],[0,0,1],[-1,0,0]];
  const cameras=w.events.filter(e=>e.type==='setCamera').map(e=>e.camera);assert.equal(cameras.length,4);
  cameras.forEach((camera,i)=>{nearly(camera.viewPlaneNormal,normals[i],1e-12,'normal '+i);assert.deepEqual(camera.viewUp,[0,-1,0]);assert.deepEqual(camera.focalPoint,centre);
   nearly(camera.position,centre.map((x,k)=>x+normals[i][k]*120),1e-9,'position '+i);assert.equal(camera.parallelScale,thickness/2);});
  // Per frame the VOI Slab planes are the saved source-LPS planes (MB1) and the whole-volume slab faces that frame (MB2).
  const renders=w.events.filter(e=>e.type==='render:batch');assert.equal(renders.length,4);
  renders.forEach((render,i)=>{
   // Plane vectors are created in the viewer's realm; a JSON round trip compares their values rather than their prototypes.
   assert.equal(render.planes.length,4);nearly(render.planes[2].origin,[-3,15.75,40],1e-12,'VOI low '+i);assert.deepEqual(JSON.parse(JSON.stringify(render.planes[2].normal)),[1,0,0]);
   nearly(render.planes[3].origin,[19.25,15.75,40],1e-12,'VOI high '+i);assert.deepEqual(JSON.parse(JSON.stringify(render.planes[3].normal)),[-1,0,0]);
   assert.ok(Math.abs(Math.abs(dotOf(render.planes[0].normal,normals[i]))-1)<=1e-12,'slab normal of frame '+i);
   // Progress while regenerating, the Close/Escape exemption still live (MB13) and no Saved while any frame is pending (MB8).
   assert.equal(render.status,'MIP Batch 복원 중 '+(i+1)+' / 4 · Close MIP Viewer나 Escape로 취소');assert.equal(render.cancels,true,'cancel exemption at frame '+i);assert.doesNotMatch(render.summary,/ · Saved$/);
  });
  // BLK-2: the Final phase timer on the Job deadline is retired, and one explicit 4 x 15 s budget is armed after Final and before frame 1.
  const index=predicate=>w.events.findIndex(predicate),budget=w.events.filter(e=>e.type==='timer'&&e.ms===60000);assert.equal(budget.length,1);
  const armed=w.events.indexOf(budget[0]),firstDialog=index(e=>e.type==='render:dialog'),firstBatch=index(e=>e.type==='render:batch');
  assert.ok(firstDialog>=0&&firstDialog<armed&&armed<firstBatch,'armed after the Final render and before the first frame');
  const phase=w.events.find(e=>e.type==='timer'&&e.ms>15000&&e.ms<=20000);assert.ok(phase,'the Final phase timer on the Job deadline');
  assert.ok(w.events.slice(0,armed).some(e=>e.type==='clear'&&e.handle===phase.handle),'the Final phase timer is cleared before the batch budget is armed');
  assert.ok(w.events.slice(armed).filter(e=>e.type==='timer'&&e.ms===15000).length>=4,'each frame waits at most 15 s of the budget');
  // After the last frame: Saved is the restored pair, the capability returns the recipe and the private viewport is gone.
  assert.match(w.summary(),/^VOI Slab · On · 22\.3 mm · Saved$/);assert.deepEqual(JSON.parse(JSON.stringify(w.viewer.job.batch())),recipe);
  assert.equal(w.frame(),'1 / 4 · MIP · Axial · Horizontal 0° · VOI Slab 22.3 mm · Preview');
  assert.equal(w.created.length,4);assert.deepEqual(w.revoked,[]);assert.deepEqual([...w.views.keys()].filter(id=>id.startsWith('kin-mipbatch-')),[]);
  assert.equal(w.viewer.job.cancels({type:'keydown',key:'Escape',target:w.dialog}),false,'no restore is left to cancel');
  w.button('Next Frame').onclick();assert.equal(w.frame(),'2 / 4 · MIP · Axial · Horizontal +90° · VOI Slab 22.3 mm · Preview');
  // A display request ends the preview before its native writes (MB6): nothing to capture, every frame URL revoked.
  let revokedAtNativeWrite=null;
  w.faults.plane=()=>{if(revokedAtNativeWrite===null)revokedAtNativeWrite=[...w.revoked];};
  const projection=w.field('MIP Projection');projection.value='MinIP';projection.onchange();
  assert.deepEqual(revokedAtNativeWrite?.sort(),[...w.created].sort(),'the old preview is cleared before the first native VOI plane write');
  w.faults.plane=null;
  assert.equal(w.viewer.job.batch(),null);assert.deepEqual([...w.revoked].sort(),[...w.created].sort());
 }finally{w.viewer.dispose();}
});
const dotOf=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

test('a MIP Batch frame failure after Final rolls the restore back with its own reason; nothing is announced, Saved or leaked',async()=>{
 for(const [label,options,reason] of [
   ['batch clipping-plane write fault',{faults:{batchPlane:()=>{throw Error('INJECTED MIP BATCH PLANE WRITE');}}},'INJECTED MIP BATCH PLANE WRITE'],
   ['batch clip shader not linked',{faults:{batchGpu:true}},'투영 셰이더를 GPU에서 확인하지 못했습니다.'],
   ['PNG encoding returns no blob',{faults:{blob:true}},'MIP Batch 영상을 만들지 못했습니다.'],
   ['canvas is not 512 px',{faults:{size:511}},'MIP Batch 영상 크기를 확인하지 못했습니다.'],
   ['camera inside the whole-volume slab',{distance:10},'MIP 투영 카메라가 CT 볼륨 투영 범위 안에 있어 MIP Batch를 만들지 않았습니다.']]){
  const w=batchViewerWorld(options);
  try{
   const error=await w.viewer.job.restore(structuredClone(batchValue),{current:()=>true,deadline:Date.now()+20000,viewportId:'vp-0',batch:batchRecipe()}).then(()=>null,e=>e);
   assert.ok(error,label);assert.equal(error.message,reason,label);
   assert.ok(w.events.some(e=>e.type==='render:dialog'),label+': the Final display was reached first');
   assert.equal(w.dialog.open,false,label);assert.equal(w.views.size,0,label+': both viewports are disabled');
   assert.doesNotMatch(w.status(),/복원했습니다/,label);assert.deepEqual(w.revoked,w.created,label+': no frame URL outlives the failure');
  }finally{w.viewer.dispose();}
 }
 // An unknown recipe is refused before the viewer opens.
 const w=batchViewerWorld();
 try{
  await assert.rejects(w.viewer.job.restore(structuredClone(batchValue),{current:()=>true,deadline:Date.now()+20000,viewportId:'vp-0',batch:batchRecipe({algorithm:'kin-mip-batch-2'})}),{message:'MIP Batch 작업의 계산 방식을 이 뷰어가 재현할 수 없어 복원하지 않았습니다.'});
  assert.equal(w.dialog.open,false);assert.equal(w.events.filter(e=>e.type.startsWith('render')).length,0);
 }finally{w.viewer.dispose();}
});

test('Make MIP Batch: gates, the recipe of the generated preview, atomic cancel and failure, and Save refused while generating',async()=>{
 const posts=[];let release=null;
 const command={owner:()=>JSON.stringify(['I1','u1']),writable:()=>true,busy:()=>false,pending:()=>null,
  save:fields=>{posts.push(fields);return new Promise(resolve=>{release=resolve;});},retry:()=>Promise.reject(Error('must not retry'))};
 const w=batchViewerWorld({command}),renders=()=>w.events.filter(e=>e.type==='render:batch').length;
 try{
  await w.viewer.open();assert.equal(w.dialog.dataset.kinMipState,'final');
  const make=()=>w.button('Make MIP Batch').onclick(),set=(label,value)=>{w.field(label).value=String(value);};
  assert.deepEqual([w.field('MIP Batch Type').value,w.field('MIP Batch Interval (deg)').value,w.field('MIP Batch Number').value,w.field('MIP Batch Reverse').checked],['Horizontal','10','36',false]);
  // A span beyond 360 degrees is refused before any native call.
  set('MIP Batch Interval (deg)',90);set('MIP Batch Number',6);await make();
  assert.equal(w.status(),'MIP Batch Interval은 1~180도, Number는 2~64장, 전체 회전 범위((Number-1)×Interval)는 360도 이내로 입력하세요.');assert.equal(renders(),0);
  set('MIP Batch Number',3);await make();
  assert.equal(w.status(),'MIP Batch 미리보기 3장을 만들었습니다. 표시 전용 임시 미리보기이며 Save MIP Job으로 조건을 저장할 수 있습니다.');
  const first=[...w.created];assert.equal(first.length,3);assert.match(w.find(e=>e.className==='kin-mip-job-note').textContent,/MIP Batch 조건/);
  // The saved recipe is the generated preview's, never the editors changed afterwards (MB5).
  set('MIP Batch Number',2);w.field('MIP Batch Type').value='Vertical';assert.deepEqual(JSON.parse(JSON.stringify(w.viewer.job.batch())),batchRecipe({count:3}));
  // A second generation held on its second frame: the previous preview is owned but unavailable, and display change, Save, another
  // Make and Play are refused; Cancel keeps the previous preview exactly (MB9).
  set('MIP Batch Number',4);const holdAt=renders()+2;w.setHold(events=>events.filter(e=>e.type==='render:batch').length===holdAt);
  const running=make();await until(()=>w.held(),'second frame held');
  assert.equal(w.status(),'MIP Batch 생성 중 2 / 4');
  assert.throws(()=>w.viewer.job.batch(),{message:'MIP Batch 생성을 마친 뒤 MIP 작업을 저장하세요.'});
  w.field('MIP Job Title').value='held batch';await w.button('Save MIP Job').onclick();
  assert.equal(w.status(),'MIP Batch 생성을 마친 뒤 MIP 작업을 저장하세요.');assert.deepEqual(posts,[]);
  await make();assert.equal(w.status(),'MIP Batch 생성이 끝난 뒤 다시 누르세요.');
  assert.equal(w.button('Play MIP Batch').disabled,true);assert.equal(w.button('Clear MIP Batch').disabled,true);assert.equal(w.button('Cancel MIP Batch').disabled,false);
  const projection=w.field('MIP Projection');projection.value='MinIP';projection.onchange();
  assert.equal(w.status(),'MIP Batch 생성이 끝난 뒤 Projection·Orientation·VOI Slab을 바꾸세요.');assert.equal(projection.value,'MIP');
  w.button('Cancel MIP Batch').onclick();await running;w.setHold(null);
  assert.equal(w.status(),'MIP Batch 생성을 취소했습니다. 이전 MIP Batch 미리보기를 유지합니다.');
  assert.deepEqual(w.revoked,[]);assert.deepEqual(JSON.parse(JSON.stringify(w.viewer.job.batch())),batchRecipe({count:3}));
  assert.deepEqual([...w.views.keys()].filter(id=>id.startsWith('kin-mipbatch-')),[]);assert.equal(w.dialog.dataset.kinMipState,'final');
  // A frame failure keeps the previous preview as well.
  w.faults.batchGpu=true;await make();w.faults.batchGpu=false;
  assert.equal(w.status(),'투영 셰이더를 GPU에서 확인하지 못했습니다. 이전 MIP Batch 미리보기를 유지합니다.');assert.deepEqual(w.revoked,[]);assert.equal(w.dialog.dataset.kinMipState,'final');
  // Make is refused while a save of this display is in flight (MB6b).
  w.field('MIP Job Title').value='batch save';const saving=w.button('Save MIP Job').onclick();assert.equal(posts.length,1);
  await make();assert.equal(w.status(),'MIP 작업 저장이 끝난 뒤 MIP Batch를 만드세요.');
  release({state:'not-saved',sent:false,message:'INJECTED NOT SAVED'});await saving;
  // A complete series replaces the previous one and only then revokes it; Clear revokes the rest.
  set('MIP Batch Number',2);w.field('MIP Batch Type').value='Horizontal';await make();
  assert.deepEqual([...w.revoked].sort(),[...first].sort());assert.deepEqual(JSON.parse(JSON.stringify(w.viewer.job.batch())),batchRecipe({count:2}));
  w.button('Clear MIP Batch').onclick();assert.equal(w.viewer.job.batch(),null);assert.equal(w.revoked.length,w.created.length);assert.equal(w.status(),'MIP Batch 미리보기를 비웠습니다.');
 }finally{w.viewer.dispose();}
});

// The real viewer-jobs.js over the real viewer-volume-job.js, as mipSaveWorld above, with a MIP tool that shows a MIP Batch preview, a
// list that returns the saved rows, and a POST whose receipt can be lost after the server committed it.
async function batchSaveWorld(){
 const real=context.window.kinCreateVolumeJob;let parts=null;
 context.window.kinCreateVolumeJob=args=>{parts=args;return real(args);};
 try{world(1,3,PLANES);}finally{context.window.kinCreateVolumeJob=real;}
 const block=mipBlock(),posts=[],saved=[],rows=[],network={lose:false};let recipe=batchRecipe();
 const mip={capture:()=>block,batch:()=>recipe,dirty:()=>false,viewport:()=>'vp-0',saved:(value,volume,batch)=>{saved.push(JSON.parse(JSON.stringify({value,volume,batch})));}};
 context.window.kinMprMarks=undefined;context.window.kinVolumeMipJob=mip;
 const element=tag=>{const children=[];return {tagName:tag,children,style:{},dataset:{},textContent:'',value:'',checked:false,disabled:false,isConnected:true,
  append:(...items)=>{children.push(...items);},prepend:(...items)=>{children.unshift(...items);},insertBefore:item=>{children.push(item);},
  replaceChildren:(...items)=>{children.splice(0,children.length,...items);},setAttribute(){},remove(){},querySelector:selector=>children.find(c=>c.tagName===selector)||null};};
 const layout=element('details');layout.append(element('summary'));
 const jobs='/api/studies/'+STUDY+'/viewer-jobs';
 const fetch=async(url,options={})=>{
  let body=null;
  if(url==='/api/me')body={kind:'member',institution:'I1',sub:'u1',roles:['radiologist']};
  else if(url===jobs&&options.method==='POST'){
   const sent=JSON.parse(options.body);posts.push(sent);
   if(!rows.some(row=>row.id===sent.id))rows.push({id:sent.id,title:sent.title,description:'',snapshotVersion:sent.snapshot.version,hidden:false,authorActor:'dr.synthetic',authorSub:'u1',createdAt:0,revision:1});
   if(network.lose){network.lose=false;const error=new Error('receipt lost after commit');error.name='AbortError';throw error;}
   body={id:sent.id,snapshotVersion:sent.snapshot.version};
  }else if(url.startsWith(jobs+'?'))body={jobs:rows.map(row=>({...row}))};
  return {status:body?200:404,ok:!!body,json:async()=>body};};
 const sandbox={document:{createElement:element,head:element('head'),querySelector:selector=>selector==='#kin-viewer-layout'?layout:null,addEventListener(){},removeEventListener(){}},
  location:{search:'?StudyInstanceUIDs='+STUDY,origin:'https://kin.test'},fetch,crypto,AbortController,URL,URLSearchParams,setTimeout,clearTimeout,clearInterval,
  setInterval:(callback,ms)=>{const timer=setInterval(callback,ms);timer.unref();return timer;},addEventListener(){},removeEventListener(){},
  kinCreateVolumeJob:real,kinVolumeMipJob:mip,KinVolumeMipJob:require('../worklist-v0/hpacs-lite/volume-mip-job.js')};
 sandbox.window=sandbox.top=sandbox;const realm=vm.createContext(sandbox);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../worklist-v0/hpacs-lite/viewer-jobs.js'),'utf8'),realm,{filename:'viewer-jobs.js'});
 const panel=sandbox.kinViewerJobs({viewportGridService:parts.grid,cornerstoneViewportService:parts.cs,displaySetService:parts.ds},{scope:()=>({})});
 panel.mount();const command=sandbox.kinViewerJobCommand,idle=async()=>{for(let n=0;n<200&&command.busy();n++)await new Promise(r=>setTimeout(r,0));};
 for(let n=0;n<200&&!command.owner();n++)await new Promise(r=>setTimeout(r,0));await idle();
 const find=(root,match)=>match(root)?root:root.children.map(c=>find(c,match)).find(Boolean)||null;
 return {command,idle,posts,saved,block,network,setRecipe:value=>{recipe=value;},stop:()=>{panel.stop();context.window.kinVolumeMipJob=undefined;},
  status:()=>find(layout,e=>e.id==='kin-viewer-jobs-status').textContent,text:value=>find(layout,e=>e.tagName==='p'&&e.textContent===value),
  button:label=>find(layout,e=>e.tagName==='button'&&e.textContent===label)};
}

test('Save MIP Job beside a MIP Batch preview sends one version 13 body; Saved and Retry keep the pair, and the saved row offers Print Saved Images',async()=>{
 const w=await batchSaveWorld();
 try{
  let outcome=await w.command.save({title:'MIP batch',description:''});
  assert.equal(outcome.state,'saved',outcome.message);assert.equal(w.posts.length,1);
  const sent=w.posts[0].snapshot;assert.equal(sent.version,13);assert.deepEqual(sent.mipBatch,batchRecipe());assert.deepEqual(sent.mip,w.block);
  assert.deepEqual(w.saved,[{value:w.block,volume:sent.volume,batch:batchRecipe()}],'the committed receipt names the sent pair');
  // A11-OUTPUT-1: the list labels the version 13 row as a reconstructed output and offers Print Saved Images; Print Current View still
  // refuses the version 13 screen by name.
  assert.ok(w.text('MIP Batch · 회전 투영 재구성 출력 · 표시 조건 작업'));assert.ok(w.button('Print Saved Images'));assert.ok(w.button('Restore Job'));
  await w.button('Print Current View').onclick();assert.match(w.status(),/^MIP Batch 작업은 아직 출력할 수 없습니다/);
  // An unknown receipt keeps the body; Retry MIP Save resends it only while the same pair is shown (MB10).
  w.network.lose=true;w.setRecipe(batchRecipe({count:3}));outcome=await w.command.save({title:'MIP batch lost',description:''});
  // pending() parses the kept body in the Jobs panel's realm; a JSON round trip compares its values rather than its prototypes.
  assert.equal(outcome.state,'unconfirmed',outcome.message);assert.deepEqual(JSON.parse(JSON.stringify(w.command.pending().mipBatch)),batchRecipe({count:3}));
  w.setRecipe(null);outcome=await w.command.retry();
  assert.equal(outcome.state,'not-saved');assert.match(outcome.message,/재시도할 MIP 저장 요청이 현재 표시와 같지 않습니다/);assert.equal(w.posts.length,2,'the same block without its preview resends nothing');
  w.setRecipe(batchRecipe({count:3}));outcome=await w.command.retry();
  assert.equal(outcome.state,'saved',outcome.message);assert.equal(w.posts.length,3);assert.equal(w.posts[2].id,w.posts[1].id,'the identical body');
  // A version 12 body kept without any mipBatch key retries while no preview is shown (MB12).
  w.network.lose=true;w.setRecipe(null);outcome=await w.command.save({title:'MIP plain lost',description:''});assert.equal(outcome.state,'unconfirmed',outcome.message);
  assert.equal(w.command.pending().version,12);assert.equal(w.command.pending().mipBatch,undefined);
  outcome=await w.command.retry();assert.equal(outcome.state,'saved',outcome.message);assert.equal(w.posts.at(-1).snapshot.version,12);assert.equal(w.saved.at(-1).batch,null);
 }finally{w.stop();}
});

// A11-OUTPUT-1 P2: Print Saved Images over the real viewer-jobs.js. Every script the panel requests is answered by the test: `answer`
// defines what that file would define, or fails its load, so readiness is observed exactly as the panel decides it.
const PRINT_FILES={
 'viewer-job-print.js':s=>{s.kinViewerJobPrint=()=>({open:(...args)=>s.printOpened.push(args),openCurrent(){},close(){},destroy(){}});},
 'viewer-editor-link.js':s=>{s.kinViewerEditorLink=()=>({});},
 'viewer-volume-job-print.js':s=>{s.kinRenderVolumeJobPrint=async()=>({});},
 'volume-mip.js':s=>{s.KinVolumeMip=Object.freeze({...require('../worklist-v0/hpacs-lite/volume-mip.js')});},
 'volume-mip-job.js':s=>{s.KinVolumeMipJob=require('../worklist-v0/hpacs-lite/volume-mip-job.js');},
 'volume-mip-batch.js':s=>{s.KinVolumeMipBatch=require('../worklist-v0/hpacs-lite/volume-mip-batch.js');},
 'volume-mip-output.js':s=>{s.KinVolumeMipOutput=require('../worklist-v0/hpacs-lite/volume-mip-output.js');},
 'viewer-volume-mip-print.js':s=>{s.kinRenderVolumeMipPrint=async()=>({});}};
const PRINT_BASE=['viewer-job-print.js','viewer-editor-link.js'],PRINT_MIP=['viewer-volume-job-print.js','volume-mip.js','volume-mip-job.js','volume-mip-output.js','viewer-volume-mip-print.js'];
const LOAD_FAILED='출력 화면을 불러오지 못했습니다. 다시 누르세요.';
async function printWorld({versions,present={},answer=(file,s)=>PRINT_FILES[file](s),capture=null,transport=null}){
 const real=context.window.kinCreateVolumeJob;let parts=null;
 context.window.kinCreateVolumeJob=args=>{parts=args;return real(args);};
 try{world(1,3,PLANES);}finally{context.window.kinCreateVolumeJob=real;}
 const requested=[];let sandbox=null;
 const element=tag=>{const children=[];return {tagName:tag,children,style:{},dataset:{},textContent:'',value:'',checked:false,disabled:false,isConnected:true,
  append:(...items)=>{children.push(...items);},prepend:(...items)=>{children.unshift(...items);},insertBefore:item=>{children.push(item);},
  replaceChildren:(...items)=>{children.splice(0,children.length,...items);},setAttribute(){},remove(){},querySelector:selector=>children.find(c=>c.tagName===selector)||null};};
 const layout=element('details');layout.append(element('summary'));
 const head=element('head');
 head.append=(...scripts)=>{for(const script of scripts){const file=script.src.split('/').pop();requested.push(file);
  setTimeout(()=>{let failed;try{failed=answer(file,sandbox)==='error';}catch(_){failed=true;}(failed?script.onerror:script.onload)?.();},0);}};
 const rows=versions.map((version,i)=>({id:'00000000-0000-4000-8000-'+String(i).padStart(12,'0'),title:'Job v'+version,description:'',snapshotVersion:version,hidden:false,authorActor:'dr.synthetic',authorSub:'u1',createdAt:0,revision:1}));
 const jobs='/api/studies/'+STUDY+'/viewer-jobs';
 const base=async url=>{let body=null;if(url==='/api/me')body={kind:'member',institution:'I1',sub:'u1',roles:['radiologist']};else if(url.startsWith(jobs+'?'))body={jobs:rows.map(row=>({...row}))};return {status:body?200:404,ok:!!body,json:async()=>body};};
 // A test may stand between the panel and these answers, as the network does.
 const fetch=transport?(url,init={})=>transport(url,init,base):base;
 sandbox={document:{createElement:element,head,querySelector:selector=>selector==='#kin-viewer-layout'?layout:null,addEventListener(){},removeEventListener(){}},
  location:{search:'?StudyInstanceUIDs='+STUDY,origin:'https://kin.test'},fetch,crypto,AbortController,URL,URLSearchParams,setTimeout,clearTimeout,clearInterval,
  setInterval:(callback,ms)=>{const timer=setInterval(callback,ms);timer.unref();return timer;},addEventListener(){},removeEventListener(){},
  kinCreateVolumeJob:capture?()=>({capture,apply(){},resolve(){}}):real,printOpened:[],...present};
 sandbox.window=sandbox.top=sandbox;const realm=vm.createContext(sandbox);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../worklist-v0/hpacs-lite/viewer-jobs.js'),'utf8'),realm,{filename:'viewer-jobs.js'});
 const panel=sandbox.kinViewerJobs({viewportGridService:parts.grid,cornerstoneViewportService:parts.cs,displaySetService:parts.ds},{scope:()=>({})});
 panel.mount();
 const find=(root,match)=>match(root)?root:root.children.map(c=>find(c,match)).find(Boolean)||null;
 const item=version=>find(layout,e=>e.tagName==='div'&&e.children.some(c=>c.tagName==='strong'&&c.textContent==='Job v'+version));
 const own=(host,label)=>host.children.find(c=>c.tagName==='button'&&c.textContent===label)||null;
 await until(()=>versions.every(version=>item(version)),'the listed Jobs');
 const settle=async()=>{for(let n=0;n<20;n++)await new Promise(resolve=>setTimeout(resolve,0));};
 return {sandbox,requested,item,own,settle,
  status:()=>find(layout,e=>e.id==='kin-viewer-jobs-status').textContent,
  labels:version=>item(version).children.filter(c=>c.tagName==='p').map(c=>c.textContent),
  button:label=>find(layout,e=>e.tagName==='button'&&e.textContent===label),
  print:async version=>{requested.length=0;await own(item(version),'Print Saved Images').onclick();await settle();},
  stop:()=>panel.stop()};
}

// A11-OUTPUT transport fix (hosted diagnostic run 35022850312): Chromium failed a request bound to an HTTP/2 connection whose GOAWAY
// arrived before the request's stream existed, with ERR_FAILED and no resend of its own, so fetch() rejected it with a TypeError before
// any response. The real viewer-jobs.js api() sends such a read once more; a write, an abort and an HTTP answer are never sent again.
test('api() sends a read rejected before any response once more, a declared read-only POST too, and never a write, an abort or an HTTP answer',async()=>{
 const sends=[],rejected=()=>Promise.reject(new TypeError('Failed to fetch')),ok=value=>({status:200,ok:true,json:async()=>value});
 let rule=()=>undefined,factory=null;
 const transport=(url,init,base)=>{sends.push({url,init});const answer=rule(url,init,sends.filter(s=>s.url===url).length);return answer===undefined?base(url):answer;};
 const count=url=>sends.filter(s=>s.url===url).length;
 // The panel's first account read is rejected once. Without the resend the panel stops on the browser's raw error and lists no Job.
 rule=(url,init,n)=>url==='/api/me'&&n===1?rejected():undefined;
 const w=await printWorld({versions:[12],transport,
  answer:(file,s)=>file==='viewer-job-print.js'?void(s.kinViewerJobPrint=args=>{factory=args;return {open(){},openCurrent(){},close(){},destroy(){}};}):PRINT_FILES[file](s)});
 try{
  const account=sends.filter(s=>s.url==='/api/me');
  assert.ok(account.length>=2,'the rejected account read was sent once more');assert.equal(account[1].init.signal,account[0].init.signal,'on the same request signal');
  assert.ok(!w.status().includes('Failed to fetch'),w.status());
  rule=()=>undefined;await w.print(12);assert.ok(factory,'the print dialog received the panel api');const api=factory.api;
  // A POST its caller declares read-only (the source lookup) is sent once more, and the declaration never reaches fetch.
  rule=(url,init,n)=>url==='/api/dicom/lookup'?(n===1?rejected():ok({id:'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee'})):undefined;
  assert.deepEqual(await api('/dicom/lookup',{method:'POST',idempotent:true,body:'{}'}),{id:'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee'});
  assert.equal(count('/api/dicom/lookup'),2);assert.ok(sends.filter(s=>s.url==='/api/dicom/lookup').every(s=>!('idempotent' in s.init)&&s.init.method==='POST'));
  // A write is never sent again.
  const write='/api/studies/'+STUDY+'/viewer-jobs/00000000-0000-4000-8000-000000000000/revisions';
  rule=url=>url===write?rejected():undefined;
  await assert.rejects(api(write.slice(4),{method:'POST',body:'{}'}),{name:'TypeError',message:'Failed to fetch'});assert.equal(count(write),1);
  // A read rejected on both sends is sent exactly twice and keeps the browser's own error in this panel.
  const job='/api/studies/'+STUDY+'/viewer-jobs/00000000-0000-4000-8000-000000000000';
  rule=url=>url===job?rejected():undefined;
  await assert.rejects(api(job.slice(4)),{name:'TypeError',message:'Failed to fetch'});assert.equal(count(job),2);
  // An abort is never sent again: one while the read was pending, and a rejection that arrives after its caller aborted.
  const held='/api/studies/'+STUDY+'/report-preview',controller=new AbortController();
  rule=(url,init)=>url===held?new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true})):undefined;
  const pending=api(held.slice(4),{signal:controller.signal});setTimeout(()=>controller.abort(),5);
  await assert.rejects(pending,{name:'AbortError'});assert.equal(count(held),1);
  const late='/api/studies/'+STUDY+'/viewer-jobs/preview',gone=new AbortController();
  rule=url=>url===late?(gone.abort(),rejected()):undefined;
  await assert.rejects(api(late.slice(4),{method:'POST',idempotent:true,body:'{}',signal:gone.signal}),{name:'TypeError'});assert.equal(count(late),1);
  // An HTTP answer is final.
  const study='/api/studies/'+STUDY;
  rule=url=>url===study?{status:503,ok:false,json:async()=>({})}:undefined;
  await assert.rejects(api(study.slice(4)),{message:'서버 연결을 확인한 뒤 다시 시도하세요.'});assert.equal(count(study),1);
 }finally{w.stop();}
});

test('P2 (a): Print Saved Images is offered for versions 1-6 and 12-15 only, and the MIP rows are labelled as reconstructed outputs',async()=>{
 // A11-ORIENT-1: versions 14/15 are the anatomical-preset MIP pair and print through the same engine, so version 16 is now the
 // unknown-version sentinel that must stay without Print.
 const all=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],w=await printWorld({versions:all});
 try{
  for(const version of [1,2,3,4,5,6,12,13,14,15])assert.ok(w.own(w.item(version),'Print Saved Images'),'version '+version);
  for(const version of [7,8,9,10,11,16])assert.equal(w.own(w.item(version),'Print Saved Images'),null,'version '+version);
  for(const version of all)assert.ok(w.own(w.item(version),'Restore Job'),'version '+version+' restores');
  assert.ok(w.labels(12).includes('MIP Viewer · 저장 조건 재구성 출력 · 표시 전용 투영 작업'));assert.ok(w.labels(13).includes('MIP Batch · 회전 투영 재구성 출력 · 표시 조건 작업'));
  assert.ok(w.labels(14).includes('MIP Viewer · 저장 조건 재구성 출력 · 표시 전용 투영 작업'));assert.ok(w.labels(15).includes('MIP Batch · 회전 투영 재구성 출력 · 표시 조건 작업'));
  assert.ok(![...w.labels(12),...w.labels(13),...w.labels(14),...w.labels(15)].some(text=>text.includes('출력 미지원')));
  // The versions still without output keep their labels.
  assert.ok(w.labels(7).includes('MPR Plane Layout · 출력 미지원 · 재구성 표시 작업'));assert.ok(w.labels(8).includes('MPR Mixed Layout · 출력 미지원 · 재구성 표시 작업'));
  assert.ok(w.labels(9).includes('Merged Cell Layout · 출력 미지원'));assert.ok(w.labels(10).includes('Curved MPR · 출력 미지원 · 곡선을 따라 펼친 재구성 표시 작업'));
  assert.ok(w.labels(11).includes('3D Path · 출력 미지원 · 경로 평면과 경로를 따라 펼친 재구성 표시 작업'));
 }finally{w.stop();}
});

test('P2 (b): each printable version requests exactly its print assets before the printer opens that row',async()=>{
 for(const [version,files] of [[1,PRINT_BASE],[2,PRINT_BASE],[3,PRINT_BASE],[4,[...PRINT_BASE,'viewer-volume-job-print.js']],[5,[...PRINT_BASE,'viewer-volume-job-print.js']],
   [6,[...PRINT_BASE,'viewer-volume-job-print.js']],[12,[...PRINT_BASE,...PRINT_MIP]],[13,[...PRINT_BASE,...PRINT_MIP,'volume-mip-batch.js']],
   // A11-ORIENT-1: the anatomical-preset pair prints through the same modules, so 14 asks for the version 12 set and 15 the version 13 set.
   [14,[...PRINT_BASE,...PRINT_MIP]],[15,[...PRINT_BASE,...PRINT_MIP,'volume-mip-batch.js']]]){
  const w=await printWorld({versions:[version]});
  try{
   await w.print(version);
   assert.deepEqual(w.requested,files,'version '+version);assert.deepEqual(w.sandbox.printOpened.map(args=>args.slice(0,1).concat(args[2])),[[STUDY,version]],'version '+version);
   assert.notEqual(w.status(),LOAD_FAILED);
   // Every asset is ready now, so printing the same row again requests nothing.
   await w.print(version);assert.deepEqual(w.requested,[],'version '+version+' again');assert.equal(w.sandbox.printOpened.length,2);
  }finally{w.stop();}
 }
});

test('P2 (c) B1: present MIP models are frozen objects, ready by their members; they are never requested or replaced',async()=>{
 const present={KinVolumeMip:Object.freeze({...require('../worklist-v0/hpacs-lite/volume-mip.js')}),KinVolumeMipJob:require('../worklist-v0/hpacs-lite/volume-mip-job.js'),
  KinVolumeMipBatch:require('../worklist-v0/hpacs-lite/volume-mip-batch.js')};
 for(const [name,value] of Object.entries(present)){assert.equal(typeof value,'object',name);assert.ok(Object.isFrozen(value),name);}
 const w=await printWorld({versions:[12,13],present});
 try{
  await w.print(13);
  assert.deepEqual(w.requested,[...PRINT_BASE,'viewer-volume-job-print.js','volume-mip-output.js','viewer-volume-mip-print.js']);
  for(const [name,value] of Object.entries(present))assert.equal(w.sandbox[name],value,name+' is the same object');
  await w.print(12);assert.deepEqual(w.requested,[],'every version 12 asset is present');
  assert.deepEqual(w.sandbox.printOpened.map(args=>args[2]),[13,12]);
 }finally{w.stop();}
 // A present model that lacks a member is not ready: it is requested and the loaded, complete model replaces it.
 const partial=Object.freeze({validate(){},intersects(){}}),v=await printWorld({versions:[12],present:{...present,KinVolumeMipJob:partial}});
 try{
  await v.print(12);assert.ok(v.requested.includes('volume-mip-job.js'));assert.ok(!v.requested.includes('volume-mip.js'));
  assert.notEqual(v.sandbox.KinVolumeMipJob,partial);assert.equal(v.sandbox.KinVolumeMip,present.KinVolumeMip);assert.deepEqual(v.sandbox.printOpened.map(args=>args[2]),[12]);
 }finally{v.stop();}
});

test('P2 (d): a loaded script whose global fails its predicate, or an aborted load, fails print only; the retry requests only that file',async()=>{
 for(const [file,broken] of [['volume-mip-output.js',s=>{s.KinVolumeMipOutput=Object.freeze({plan(){},verifyClip(){},verifyDisplay(){},caption(){},supports(){}});}],['viewer-volume-mip-print.js',()=>'error']]){
  let failing=true;
  const w=await printWorld({versions:[12,13],answer:(name,s)=>name===file&&failing?broken(s):PRINT_FILES[name](s)});
  try{
   await w.print(13);
   assert.equal(w.status(),LOAD_FAILED,file);assert.deepEqual(w.sandbox.printOpened,[],file);
   // Saving and restoring stay available after a print-only failure.
   assert.equal(w.own(w.item(13),'Restore Job').disabled,false,file);assert.equal(w.button('Save New Job').disabled,false,file);
   await w.print(12);assert.deepEqual(w.requested,[file],file+' is the only asset requested again');assert.equal(w.status(),LOAD_FAILED);assert.deepEqual(w.sandbox.printOpened,[]);
   failing=false;await w.print(12);assert.deepEqual(w.requested,[file],file+' retry');assert.deepEqual(w.sandbox.printOpened.map(args=>args[2]),[12]);
   await w.print(13);assert.deepEqual(w.requested,[],file+': version 13 needs nothing more');assert.deepEqual(w.sandbox.printOpened.map(args=>args[2]),[12,13]);
  }finally{w.stop();}
 }
});

test('P2 (e): Print Current View still refuses versions 7 to 15 by name before any asset request',async()=>{
 const shown={version:7},w=await printWorld({versions:[1],capture:()=>({...shown})});
 try{
  for(const [version,message] of [[7,'MPR 평면 배치 작업은 아직 출력할 수 없습니다. 저장과 복원만 지원합니다.'],[8,'MPR 평면과 일반 영상이 섞인 배치 작업은 아직 출력할 수 없습니다. 저장과 복원만 지원합니다.'],
    [9,'칸을 병합한 배치 작업은 아직 출력할 수 없습니다. 저장과 복원만 지원합니다.'],[10,'Curved MPR 작업은 아직 출력할 수 없습니다. 저장과 복원만 지원합니다.'],
    [11,'3D Path 작업은 아직 출력할 수 없습니다. 저장과 복원만 지원합니다.'],[12,/^MIP Viewer 작업은 아직 출력할 수 없습니다/],[13,/^MIP Batch 작업은 아직 출력할 수 없습니다/],
    // A11-ORIENT-1: the anatomical-preset pair has no current-view page either; only the saved row prints.
    [14,/^MIP Viewer 작업은 아직 출력할 수 없습니다/],[15,/^MIP Batch 작업은 아직 출력할 수 없습니다/]]){
   shown.version=version;w.requested.length=0;await w.button('Print Current View').onclick();await w.settle();
   if(typeof message==='string')assert.equal(w.status(),message);else assert.match(w.status(),message);
   assert.deepEqual(w.requested,[],'version '+version);assert.deepEqual(w.sandbox.printOpened,[],'version '+version);
  }
 }finally{w.stop();}
});

/* A11-ORIENT-1 V7: the manual's Orientation Preset bar at the bottom of the MIP Viewer (p.332 12.1, p.342 13), the p.328 Type
   name for the rotation kind, and the read-only Thickness readout. Expected cameras are the accepted contract table. */
test('A11-ORIENT-1: the Orientation Preset bar requests the same display the Orientation list does, and Type/Thickness are named',async()=>{
 const w=batchViewerWorld();
 try{
  await w.viewer.open();assert.equal(w.dialog.dataset.kinMipState,'final');
  const bar=w.find(e=>e.attributes['aria-label']==='MIP Orientation Preset');
  assert.ok(bar,'the preset bar exists');assert.equal(bar.tagName,'fieldset');
  assert.deepEqual(bar.children.map(b=>b.textContent),['A','P','L','R','H','F']);
  assert.deepEqual(bar.children.map(b=>b.attributes['aria-label']),
   ['MIP View From Anterior','MIP View From Posterior','MIP View From Left','MIP View From Right','MIP View From Head (Superior)','MIP View From Foot (Inferior)']);
  // MF7: every title names where the camera stands, which patient direction is up and which is on screen right, so the 180 degree
  // in-plane difference between F and the Axial image is visible to the user.
  assert.equal(bar.children[4].title,'H · 머리 위에서 · 앞쪽이 위 · 환자 오른쪽이 화면 오른쪽');
  assert.equal(bar.children[5].title,'F · 발쪽에서 · 뒤쪽이 위 · 환자 오른쪽이 화면 오른쪽');
  assert.equal(bar.children[0].title,'A · 앞쪽에서 · 위쪽이 위 · 환자 왼쪽이 화면 오른쪽');
  // The viewer opens on Axial, so no anatomical preset is pressed and the Orientation list holds all nine names.
  assert.deepEqual(bar.children.map(b=>b.attributes['aria-pressed']),['false','false','false','false','false','false']);
  assert.deepEqual(w.field('MIP Orientation').children.map(o=>o.value),['Axial','Coronal','Sagittal','Anterior','Posterior','Left','Right','Superior','Inferior']);
  // The p.328 field names: Type is the rotation kind, Thickness is a read-only output, never an input.
  assert.equal(w.field('MIP Batch Type').tagName,'select');
  assert.deepEqual(w.field('MIP Batch Type').children.map(o=>o.value),['Horizontal','Vertical']);
  const readout=w.field('MIP Batch Thickness Readout');
  assert.equal(readout.tagName,'output','the Thickness readout is not an input');
  assert.equal(readout.value,'','it carries no editable value');
  assert.equal(readout.textContent,'CT 전체 91.6 mm');
  // A click on H requests the Superior display through the same sequence as the list: pending first, then its own Final.
  bar.children[4].onclick();
  await until(()=>w.dialog.dataset.kinMipState==='final'&&w.field('MIP Orientation').value==='Superior','the Superior display is confirmed');
  assert.deepEqual(bar.children.map(b=>b.attributes['aria-pressed']),['false','false','false','false','true','false']);
  const camera=w.views.get([...w.views.keys()].find(id=>id.startsWith('kin-mip-')&&!id.startsWith('kin-mipbatch-'))).getCamera();
  assert.deepEqual([camera.viewPlaneNormal,camera.viewUp],[[0,0,1],[0,-1,0]],'the Superior camera of the accepted table');
  assert.match(w.find(e=>e.className==='kin-mip-label').textContent,/^MIP · Superior/);
  // The saved block of that display is kin-mip-2, and the list and the bar agree on the shown value.
  const block=w.viewer.job.capture();
  assert.equal(block.algorithm,'kin-mip-2');assert.equal(block.orientation,'Superior');
  // Choosing a plane from the list again clears every pressed preset and writes the accepted kin-mip-1 block.
  const list=w.field('MIP Orientation');list.value='Coronal';list.onchange();
  await until(()=>w.dialog.dataset.kinMipState==='final'&&w.field('MIP Orientation').value==='Coronal','the Coronal display is confirmed');
  assert.deepEqual(bar.children.map(b=>b.attributes['aria-pressed']),['false','false','false','false','false','false']);
  assert.equal(w.viewer.job.capture().algorithm,'kin-mip-1');
  // The bar is disabled exactly while the Orientation list is, and the readout follows the VOI Slab of the shown display.
  assert.equal(bar.disabled,false);
  w.viewer.job.clearForJob();
  assert.equal(bar.disabled,true);
 }finally{w.viewer.dispose();}
});
test('A11-ORIENT-1: an anatomical preset display saves as version 14, and with a MIP Batch preview as version 15',async()=>{
 const model=require('../worklist-v0/hpacs-lite/volume-mip-job.js');
 const w=await batchSaveWorld();
 try{
  // The capture rule in viewer-volume-job.js and KinVolumeMipJob.versionFor are the same binding.
  const recipe={schema:1,algorithm:'kin-mip-batch-1',axis:'Horizontal',interval:90,count:4,reverse:false};
  for(const [algorithm,batch,version] of [['kin-mip-1',null,12],['kin-mip-1',recipe,13],['kin-mip-2',null,14],['kin-mip-2',recipe,15]])
   assert.equal(model.versionFor({...w.block,algorithm},batch),version,algorithm+(batch?' with a recipe':''));
 }finally{w.stop();}
});
