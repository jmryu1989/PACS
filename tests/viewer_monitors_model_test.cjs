/* Monitors in Hanging Protocol: the rule's monitors (validation, cells dealt per monitor) and the split of one viewer
 * window over the displays it covers (regions, target, bands, rectangles, rows and their copies). Pure: no browser. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const model=require('../worklist-v0/hpacs-lite/hanging-protocol-model.js');
const plan=require('../worklist-v0/hpacs-lite/viewer-features-monitors.js');

const monitor=(images,extra={})=>({images,worklist:'none',thumbs:'top',toolbar:'top',...extra});
const rule=(cells,monitors,rows=2,cols=2)=>({layout:{rows,cols,cells},monitors:{count:monitors.length,list:monitors}});
const screens=[{left:0,top:0,width:1920,height:1040},{left:1920,top:0,width:1920,height:1040},{left:3840,top:0,width:1080,height:1880}];

test('monitors: one Show at most, and some image monitor keeps a toolbar',()=>{
  assert.deepEqual(model.monitorsRule({count:1,list:[monitor('auto')]}),{count:1,list:[monitor('auto')]});
  assert.equal(model.monitorsRule({count:2,list:[monitor('none',{worklist:'show'}),monitor('2x2',{worklist:'show'})]}),null);
  assert.equal(model.monitorsRule({count:2,list:[monitor('none',{toolbar:'top'}),monitor('2x2',{toolbar:'none'})]}),null);
  assert.equal(model.monitorsRule({count:2,list:[monitor('auto')]}),null,'count is the list length');
  assert.equal(model.monitorsRule({count:5,list:Array(5).fill(monitor('auto'))}),null);
  assert.equal(model.monitorsRule({count:1,list:[{...monitor('auto'),extra:1}]}),null);
});

test('a rule without monitors keeps loading, and monitors survive normalize (import, export, duplicate)',()=>{
  const base={version:1,activeRuleId:null,rules:[{id:'11111111-1111-4111-8111-111111111111',name:'CT',enabled:true,
    match:{modality:null,retrieveAE:null,bodyPart:null,description:null},
    selectors:[{alias:'Current1',role:'current',historical:false,modality:null,retrieveAE:null,bodyPart:null,description:null,laterality:null,order:'ascending',occurrence:1}],
    layout:{rows:1,cols:2,cells:['Current1',null]}}]};
  assert.ok(model.normalize(base));
  assert.equal('monitors' in model.normalize(base).rules[0],false,'no default monitors are put into an old rule');
  const withMonitors=structuredClone(base);withMonitors.rules[0].monitors={count:2,list:[monitor('1x1'),monitor('2x2',{thumbs:'left'})]};
  assert.deepEqual(model.normalize(JSON.parse(JSON.stringify(model.normalize(withMonitors)))).rules[0].monitors,withMonitors.rules[0].monitors);
});

test('cells are dealt in monitor order, row by row inside each monitor; a rule cell left over is hidden',()=>{
  const r=rule(['a','b','c','d'],[monitor('2x1'),monitor('2x1')]);
  assert.deepEqual(model.monitorCells(r),{plan:[{monitor:0,rows:2,cols:1,cells:[0,1]},{monitor:1,rows:2,cols:1,cells:[2,3]}],hidden:0});
  const small=rule(['a','b','c','d'],[monitor('1x1'),monitor('none'),monitor('1x2')]);
  assert.deepEqual(model.monitorCells(small),{plan:[{monitor:0,rows:1,cols:1,cells:[0]},{monitor:2,rows:1,cols:2,cells:[1,2]}],hidden:1});
  const auto=rule(['a',null],[monitor('auto'),monitor('2x2')],1,2);
  assert.deepEqual(model.monitorCells(auto).plan,[{monitor:0,rows:1,cols:2,cells:[0,1]},{monitor:1,rows:2,cols:2,cells:[null,null,null,null]}]);
});

test('target: the first image monitor, and the next one only when the two displays touch side by side',()=>{
  const two={list:[monitor('none',{worklist:'show'}),monitor('2x2')]};
  assert.deepEqual(plan.target(two,screens),{monitors:[1],rect:screens[1],skipped:[]});
  const pair={list:[monitor('1x2'),monitor('1x2')]};
  assert.deepEqual(plan.target(pair,screens).rect,{left:0,top:0,width:3840,height:1040});
  const apart={list:[monitor('1x1'),monitor('none',{worklist:'show'}),monitor('1x1')]};
  assert.deepEqual(plan.target(apart,screens),{monitors:[0],rect:screens[0],skipped:[{monitor:2,reason:'one-window'}]},'never covers the worklist monitor between');
  const missing={list:[monitor('1x1'),monitor('1x1')]};
  assert.deepEqual(plan.target(missing,[screens[0]]),{monitors:[0],rect:screens[0],skipped:[{monitor:1,reason:'no-display'}]});
  const stacked=[{left:0,top:0,width:1920,height:1040},{left:0,top:1080,width:1920,height:1040}];
  assert.deepEqual(plan.target(pair,stacked).monitors,[0],'a display above another is not side by side');
});

test('regions: the parts of the window on each display, in client px, from where the window actually is',()=>{
  // A window across the first two displays: 8px frame each side, 30px title bar.
  const win={screenX:-8,screenY:0,outerWidth:3856,outerHeight:1040,innerWidth:3840,innerHeight:1002};
  assert.deepEqual(plan.regions(screens,win,1,{left:0,right:3840}),[{monitor:0,left:0,right:1920},{monitor:1,left:1920,right:3840}]);
  // Barely over the edge: no region on the second display.
  const edge={screenX:1700,screenY:0,outerWidth:416,outerHeight:600,innerWidth:400,innerHeight:562};
  assert.deepEqual(plan.regions(screens,edge,1,{left:0,right:400}).map(r=>r.monitor),[0]);
  assert.deepEqual(plan.regions(screens,{...win,outerWidth:3900},null,{left:0,right:3840}),[],'an unknown zoom with an odd frame is not guessed');
});

test('split: two 2x1 monitors keep rule cell order per monitor, not the screen order',()=>{
  const r=rule(['a','b','c','d'],[monitor('2x1',{thumbs:'left'}),monitor('2x1',{thumbs:'right',toolbar:'top'})]);
  const regions=[{monitor:0,left:0,right:1000},{monitor:1,left:1000,right:2000}],column={left:0,right:2000,top:0,bottom:1000};
  const s=plan.split(model,r,regions,column,{left:0,top:0,width:2000,height:1000});
  // Screen order is top to bottom, then left to right: a (monitor 1 top), c (monitor 2 top), b, d.
  assert.deepEqual(s.cells,[0,2,1,3]);
  assert.equal(s.rects.length,4);assert.ok(plan.validRects(s.rects));
  // Monitor 1: toolbar 36px on top, strip 156px on the left inside it.
  assert.deepEqual(s.rects[0],{x:0.078,y:0.036,width:0.422,height:0.482});
  assert.deepEqual(s.rects[1],{x:0.5,y:0.036,width:0.422,height:0.482});
  assert.equal(s.rows.toolbar.original.monitor,0);assert.equal(s.rows.toolbar.copy.monitor,1);
  assert.deepEqual([s.rows.thumbs.original.side,s.rows.thumbs.copy.side],['left','right']);
  assert.ok(s.numRows*s.numCols>=s.rects.length);
  assert.deepEqual(s.applied,[0,1]);assert.deepEqual(s.hidden,[]);
});

test('split: a monitor without a toolbar gives the original to the next; no toolbar anywhere keeps it on top',()=>{
  const regions=[{monitor:0,left:0,right:1000},{monitor:1,left:1000,right:2000}],column={left:0,right:2000,top:0,bottom:1000},grid={left:0,top:0,width:2000,height:1000};
  const r=rule(['a','b'],[monitor('1x1',{toolbar:'none',thumbs:'none'}),monitor('1x1',{toolbar:'bottom',thumbs:'none'})],1,2);
  const s=plan.split(model,r,regions,column,grid);
  assert.equal(s.rows.toolbar.original.monitor,1,'the real toolbar (with Viewer Settings) stands on the monitor that shows one');
  assert.equal(s.rows.toolbar.copy,null);assert.equal(s.rows.thumbs.original,null);
  assert.deepEqual(s.rects[0],{x:0,y:0,width:0.5,height:1},'monitor 1 has no rows: its cell fills it');
  assert.deepEqual(s.rects[1],{x:0.5,y:0,width:0.5,height:0.964});
  // Only monitor 1 is covered, and it has no toolbar: the toolbar stays on its top edge (Viewer Settings within reach).
  const kept=plan.split(model,r,regions.slice(0,1),column,grid);
  assert.equal(kept.toolbarKept,true);assert.equal(kept.rows.toolbar.original.side,'top');assert.deepEqual(kept.applied,[0]);
  assert.deepEqual(kept.hidden,[1],'the rule cell of the monitor not covered is not shown');
});

test('split: nothing when the covered displays show no images; Images None leaves its display empty',()=>{
  const column={left:0,right:2000,top:0,bottom:1000},grid={left:0,top:0,width:2000,height:1000};
  const r=rule(['a','b'],[monitor('none',{worklist:'show'}),monitor('1x2')],1,2);
  assert.equal(plan.split(model,r,[{monitor:0,left:0,right:1000}],column,grid),null);
  const s=plan.split(model,r,[{monitor:0,left:0,right:1000},{monitor:1,left:1000,right:2000}],column,grid);
  assert.ok(s.rects.every(rect=>rect.x>=0.5),'no cell on the worklist monitor');
  assert.deepEqual(s.applied,[1]);
});

test('place: a band keeps its monitor edge in percentages and its thickness in px',()=>{
  const regions=[{monitor:0,left:0,right:1000},{monitor:1,left:1000,right:2000}],column={left:0,right:2000,top:0,bottom:1000},grid={left:0,top:0,width:2000,height:1000};
  const s=plan.split(model,rule(['a','b'],[monitor('1x1',{thumbs:'bottom'}),monitor('1x1',{toolbar:'right',thumbs:'left'})],1,2),regions,column,grid);
  assert.deepEqual(plan.place(s.rows.toolbar.original),{left:'calc(0% + 0px)',right:'calc(50% + 0px)',width:'auto',height:'36px',top:'0px',bottom:'auto'});
  assert.deepEqual(plan.place(s.rows.toolbar.copy),{top:'0px',bottom:'0px',width:'108px',height:'auto',left:'auto',right:'calc(0% + 0px)'});
  assert.deepEqual(plan.place(s.rows.thumbs.copy),{top:'0px',bottom:'0px',width:'156px',height:'auto',left:'calc(50% + 0px)',right:'auto'});
  assert.deepEqual(plan.place(s.rows.thumbs.original),{left:'calc(0% + 0px)',right:'calc(50% + 0px)',width:'auto',height:'66px',top:'auto',bottom:'0px'});
});

test('monitorOf: the display holding the centre of a window',()=>{
  assert.equal(plan.monitorOf(screens,{left:2000,top:10,width:800,height:600}),1);
  assert.equal(plan.monitorOf(screens,{left:-5000,top:10,width:800,height:600}),-1);
  assert.equal(plan.monitorOf(screens,null),-1);
});

test('validRects: inside the screen and not overlapping',()=>{
  assert.ok(plan.validRects([{x:0,y:0,width:.5,height:1},{x:.5,y:0,width:.5,height:1}]));
  assert.equal(plan.validRects([{x:0,y:0,width:.6,height:1},{x:.5,y:0,width:.5,height:1}]),false);
  assert.equal(plan.validRects([{x:.6,y:0,width:.5,height:1}]),false);
  assert.equal(plan.validRects([]),false);
});
