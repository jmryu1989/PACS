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
