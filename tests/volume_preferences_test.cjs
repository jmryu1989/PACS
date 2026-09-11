const test=require('node:test'),assert=require('node:assert/strict');
const model=require('../worklist-v0/hpacs-lite/volume-preferences.js');
test('account profile contains settings only and rejects ambiguous bindings',()=>{
  const value=model.defaults();assert.deepEqual(model.normalize(value),value);
  for(const bad of [{...value,patient:'secret'},{...value,sync:{windowing:true,zoom:1}},{...value,mouse:{left:'Zoom',middle:'Zoom',right:'Pan'}},{...value,display:{...value.display,windowing:'false'}}])assert.equal(model.normalize(bad),null);
  const clean=model.normalize(value);clean.display.windowing=false;assert.equal(value.display.windowing,true);
});
test('ruler uses patient-plane millimetres under zoom and mirrored axes',()=>{
  const view={getCanvas:()=>({clientWidth:300,clientHeight:200}),canvasToWorld:([x,y])=>[-x*.7,y*.7,30]};
  const first=model.ruler(view);assert.equal(first.mm,50);assert.ok(Math.abs(first.pixels-50/.7)<1e-10);
  view.canvasToWorld=([x,y])=>[-x*.07,y*.07,30];const rule=model.ruler(view);assert.equal(rule.mm,5);assert.ok(Math.abs(rule.pixels-50/.7)<1e-10);
  view.getCanvas=()=>({clientWidth:0,clientHeight:0});assert.equal(model.ruler(view),null);
});
test('orthographic orientation cube labels only the facing patient face',()=>{
  const view={getCanvas:()=>({clientWidth:300,clientHeight:200}),canvasToWorld:([x,y])=>[x,y,30],worldToCanvas:([x,y])=>[x,-y],getCamera:()=>({focalPoint:[0,0,30],viewPlaneNormal:[0,0,1]})};
  const cube=model.cube(view);assert.equal(cube.edges.length,12);assert.deepEqual(cube.labels,[{text:'H',point:[60,60]}]);
  assert.deepEqual(cube.corners[0],[38,82]);view.getCamera=()=>({focalPoint:[0,0,30],viewPlaneNormal:[0,0,-1]});assert.equal(model.cube(view).labels[0].text,'F');
});
