const {test}=require('node:test'),assert=require('node:assert/strict');
const model=require('../worklist-v0/hpacs-lite/volume-crosshair.js');
test('normal, central gap and small lines share exact center and viewport clipping',()=>{
 assert.deepEqual(model.segments([100,80],[2,0],200,160,'normal').map(s=>[s.start,s.end]),[[[0,80],[200,80]]]);
 assert.deepEqual(model.segments([100,80],[0,1],200,160,'gap').map(s=>[s.start,s.end]),[[[100,0],[100,60]],[[100,100],[100,160]]]);
 assert.deepEqual(model.segments([100,80],[1,0],200,160,'small').map(s=>[s.start,s.end]),[[[60,80],[140,80]]]);
 const taper=model.segments([100,80],[1,0],200,160,'tapered');assert.deepEqual(taper.map(s=>s.range),[[-100,0],[0,100]]);
});
test('panned off-screen centers and oblique rays clip without inventing visible handles',()=>{
 assert.deepEqual(model.segments([-100,80],[1,0],200,160,'small'),[]);
 assert.deepEqual(model.segments([-100,80],[1,0],200,160,'normal').map(s=>[s.start,s.end]),[[[0,80],[200,80]]]);
 const lines=model.segments([100,80],[1,1],200,160,'gap');for(const s of lines)for(const p of [s.start,s.end])assert.ok(Math.abs((p[0]-100)-(p[1]-80))<1e-9);
 assert.equal(model.near([100,80],lines,6),false);assert.equal(model.near([140,120],lines,6),true);
 assert.deepEqual(model.segments([-100,-100],[0,1],200,160,'normal'),[]);
});
test('invalid geometry fails closed',()=>{
 assert.throws(()=>model.segments([NaN,0],[1,0],100,100,'normal'));assert.throws(()=>model.segments([0,0],[0,0],100,100,'normal'));assert.throws(()=>model.segments([0,0],[1,0],0,100,'normal'));assert.throws(()=>model.segments([0,0],[1,0],100,100,'unknown'));
 assert.equal(model.near([NaN,0],[],6),false);
});
test('pointer rotation retains small increments and is independent of event count',()=>{
 const center=[100,80],point=a=>[100+150*Math.cos(a),80+150*Math.sin(a)];
 assert.equal(model.rotationDegrees(center,[250,80],[100,230]),-90);
 for(const count of [1,8,100]){let total=0;for(let i=1;i<=count;i++)total+=model.rotationDegrees(center,point((i-1)*Math.PI/12/count),point(i*Math.PI/12/count));assert.ok(Math.abs(total+15)<1e-10);}
 assert.equal(model.rotationDegrees(center,center,[120,80]),0);assert.throws(()=>model.rotationDegrees(center,[NaN,0],[1,1]));
});
