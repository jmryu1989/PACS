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
  append:(...items)=>{children.push(...items);},remove(){},replaceChildren:(...items)=>{children.splice(0,children.length,...items);},setAttribute:(name,value)=>{attributes[name]=String(value);},
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
    setOrientation:key=>{camera=structuredClone(presets[key]);},setBlendMode:value=>{blend=value;},setSlabThickness:value=>{half=value;},
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
 return {viewer,dialog,views,notices,status:()=>find(dialog,e=>e.attributes.role==='status')?.textContent};
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
 return {command,idle,gate,posts,saved,block,stop:()=>{panel.stop();context.window.kinMprMarks=context.window.kinVolumeMipJob=undefined;},
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
