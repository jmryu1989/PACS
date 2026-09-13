// TEST-MPR-CURVED-MODEL: kin-cpr-1 geometry, HU sampling, limits and refusals.
// Oracle: trilinear interpolation reproduces any multilinear field exactly, so every expected value
// below is the field evaluated at the continuous index that built the world point (forward map
// only). Nearest sampling, a flipped row direction or a strict edge rule each change these values.
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const model=require(path.join(__dirname,'../worklist-v0/hpacs-lite/volume-curved.js'));

const close=(actual,expected,delta=1e-9,label='')=>assert.ok(Math.abs(actual-expected)<=delta,label+' '+actual+' != '+expected);
const field=([i,j,k])=>3+2*i-5*j+7*k+.25*i*j-.5*j*k+.125*i*k+.01*i*j*k;
function volume({dimensions,spacing,origin,direction,value=field}){
  const [dx,dy,dz]=dimensions,scalars=new Float32Array(dx*dy*dz);
  for(let k=0;k<dz;k++)for(let j=0;j<dy;j++)for(let i=0;i<dx;i++)scalars[i+j*dx+k*dx*dy]=value([i,j,k]);
  const geometry={origin,direction,spacing,dimensions};
  const world=index=>origin.map((o,n)=>o+index[0]*direction[n]*spacing[0]+index[1]*direction[3+n]*spacing[1]+index[2]*direction[6+n]*spacing[2]);
  return {geometry,world,source:{scalars,dimensions,worldToIndex:model.affine(geometry)}};
}
const IDENTITY=[1,0,0,0,1,0,0,0,1];
const c30=Math.cos(Math.PI/6),s30=Math.sin(Math.PI/6);
// 30 degree rotation about patient H plus a descending slice axis.
const OBLIQUE=[c30,s30,0,-s30,c30,0,0,0,-1];
const display={voiRange:{lower:-1000,upper:1000},VOILUTFunction:'LINEAR',invert:false};
const spec=(points,{kind='curved',plane,spacing=.5,halfHeight=3}={})=>model.build({kind,frameOfReference:'2.25.6',cell:2,
  plane:plane||{origin:[16,15.75,40],normal:[0,1,0],viewUp:[0,0,1]},points,spacing,halfHeight,display});
let seed=12345;const random=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;

test('affine inverts anisotropic, oblique and descending bases exactly',()=>{
 for(const [direction,origin] of [[IDENTITY,[10,-20,5]],[OBLIQUE,[-3,7,120]]]){
  const {geometry,world}=volume({dimensions:[6,5,4],spacing:[.7,.5,2.5],origin,direction});
  const toIndex=model.affine(geometry);
  for(let n=0;n<50;n++){const index=[random()*6-.5,random()*5-.5,random()*4-.5],back=toIndex(world(index));index.forEach((v,i)=>close(back[i],v,1e-9,'index'));}
 }
 assert.throws(()=>model.affine({origin:[0,0,0],direction:[1,0,0,1,0,0,0,0,1],spacing:[1,1,1]}),/좌표/);
});

test('trilinear sampling reproduces a multilinear HU field; half-voxel clamp and outside NaN',()=>{
 const {world,source}=volume({dimensions:[6,5,4],spacing:[.7,.5,2.5],origin:[-3,7,120],direction:OBLIQUE});
 const sample=model.sampler(source);
 for(let n=0;n<200;n++){const index=[random()*5,random()*4,random()*3];close(sample(world(index)),field(index),1e-3,'inside');}
 // The mid point between voxel centres is the neighbour average, not either neighbour.
 close(sample(world([1.5,2,1])),(field([1,2,1])+field([2,2,1]))/2,1e-3,'midpoint');
 // Within half a voxel outside the edge centres the value is the clamped edge value.
 close(sample(world([-.4,1,1])),field([0,1,1]),1e-3,'low edge');close(sample(world([5.45,4.3,3.2])),field([5,4,3]),1e-3,'high edge');
 for(const index of [[-.6,1,1],[1,4.6,1],[1,1,3.51],[1,-.51,1]])assert.ok(Number.isNaN(sample(world(index))),'outside '+index);
 assert.throws(()=>model.sampler({...source,scalars:source.scalars.subarray(1)}),/길이/);
 const broken=Float32Array.from(source.scalars);broken[0]=NaN;assert.throws(()=>model.sampler({...source,scalars:broken})(world([0,0,0])),/화소 값/);
});

test('straight curve: arc-length columns from the first point, row 0 on +normal, exact HU and outside count',()=>{
 const {world,source,geometry}=volume({dimensions:[64,64,33],spacing:[.7,.5,2.5],origin:[0,0,0],direction:IDENTITY});
 const P0=[5,15.75,12.5],P1=[30,15.75,67.5],s=spec([P0,P1],{halfHeight:20});
 const result=model.run(s,source),L=Math.hypot(25,55);
 close(result.length,L,1e-9,'length');assert.equal(result.columns,Math.floor(L/.5+1e-9)+1);assert.equal(result.rows,81);assert.equal(result.half,40);
 let outside=0;
 for(let r=0;r<result.rows;r++)for(let c=0;c<result.columns;c++){
  const offset=(40-r)*.5,p=[P0[0]+25*c*.5/L,P0[1]+offset,P0[2]+55*c*.5/L],index=[p[0]/.7,p[1]/.5,p[2]/2.5];
  const got=result.values[r*result.columns+c];
  if(index[1]>63.5||index[1]<-.5){assert.ok(Number.isNaN(got));outside++;continue;}
  const clamped=index.map((v,i)=>Math.min(Math.max(v,0),[63,63,32][i]));close(got,field(clamped),2e-2,`r${r} c${c}`);
 }
 // The 20 mm sweep leaves the 31.75 mm deep volume on the +y side: those samples are outside.
 assert.equal(result.outside,outside);assert.ok(outside>0&&outside%result.columns===0);
 // Rows above the curve row are the +normal side: +y lowers this field along j at column 0.
 assert.ok(result.values[30*result.columns]<result.values[40*result.columns]);
 close(result.values[30*result.columns],field([5/.7,(15.75+5)/.5,12.5/2.5]),2e-2,'row 30 is +5 mm');
 assert.ok(model.inside(P0,geometry));assert.ok(!model.inside([-1,0,0],geometry));
});

test('sweep beyond the volume becomes NaN rows and a one-voxel high-contrast structure stays exact',()=>{
 const spot=([i,j,k])=>i===5&&j===5&&k===5?1000:0;
 const {world,source}=volume({dimensions:[12,12,12],spacing:[1,1,1],origin:[0,0,0],direction:IDENTITY,value:spot});
 const centre=world([5,5,5]),s=spec([[0,5,5],[11,5,5]],{plane:{origin:centre,normal:[0,1,0],viewUp:[0,0,1]},spacing:1,halfHeight:8});
 const result=model.run(s,source);
 assert.equal(result.columns,12);assert.equal(result.rows,17);
 assert.equal(result.values[8*12+5],1000);assert.equal(result.values[8*12+4],0);
 // Offsets +7,+8 (rows 0,1) reach j=12,13 and offsets -6..-8 reach j=-1..-3: all outside.
 for(const r of [0,1,14,15,16])for(let c=0;c<12;c++)assert.ok(Number.isNaN(result.values[r*12+c]),'row '+r);
 assert.equal(result.outside,5*12);
 // Half a voxel away the same structure is the exact neighbour average.
 const shifted=model.run(spec([[0,5.5,5],[11,5.5,5]],{plane:{origin:[0,5.5,5],normal:[0,1,0],viewUp:[0,0,1]},spacing:1,halfHeight:1}),source);
 assert.equal(shifted.values[1*12+5],500);
 // Integer HU scalars are returned as stored: no slope or intercept is applied here.
 const hu=volume({dimensions:[4,4,4],spacing:[1,1,1],origin:[0,0,0],direction:IDENTITY,value:()=>-1024});
 assert.ok(model.run(spec([[0,1,1],[3,1,1]],{plane:{origin:[0,1,1],normal:[0,1,0],viewUp:[0,0,1]},spacing:1,halfHeight:1}),{...hu.source,scalars:Int16Array.from(hu.source.scalars)}).values.every(v=>v===-1024));
});

test('Catmull-Rom passes every control point, freehand is linear, and plan counts follow arc length',()=>{
 const points=[[5,15.75,12.5],[20,15.75,40],[30,15.75,67.5]],line=model.polyline(points,'curved');
 assert.equal(line.length,33);assert.deepEqual(line[0],points[0]);assert.deepEqual(line[16],points[1]);assert.deepEqual(line[32],points[2]);
 assert.ok(line.every(p=>Math.abs(p[1]-15.75)<1e-12),'on plane');
 assert.deepEqual(model.polyline(points,'freehand'),points);
 // Parity constants shared with the compiled server test (tests/viewer_volume_job_test.cjs).
 const curved=model.plan(spec(points)),free=model.plan({...spec(points),kind:'freehand',interpolation:'linear'});
 close(curved.length,60.60865760815429,1e-9);assert.equal(curved.columns,122);assert.equal(curved.rows,13);
 close(free.length,60.58665999215323,1e-9);assert.equal(free.columns,122);assert.equal(free.rows,13);
 // Column 0 is the first point and every column is one spacing further along the polyline.
 assert.deepEqual(Array.from(curved.curve.slice(0,3)),points[0]);
 for(let c=1;c<free.columns;c++){const a=free.curve.slice((c-1)*3,c*3),b=free.curve.slice(c*3,(c+1)*3),d=Math.hypot(b[0]-a[0],b[1]-a[1],b[2]-a[2]);if(Math.abs(c*.5-Math.hypot(15,27.5))>.5)close(d,.5,1e-9,'step '+c);}
});

test('freehand simplification is deterministic and bounded by 0.2 mm',()=>{
 const stroke=[];for(let n=0;n<=200;n++)stroke.push([n*.1,15.75,40+(n%2?.05:-.05)]);
 const straight=model.simplify(stroke);assert.equal(straight.length,2);assert.deepEqual(straight,[[0,15.75,39.95],[20,15.75,39.95]]);
 const corner=[...Array(101).keys()].map(n=>[n*.1,15.75,40]).concat([...Array(100).keys()].map(n=>[10,15.75,40+(n+1)*.1]));
 assert.deepEqual(model.simplify(corner),[[0,15.75,40],[10,15.75,40],[10,15.75,50]]);
 assert.deepEqual(model.simplify(corner),model.simplify(corner.map(p=>p.slice())));
 assert.deepEqual(model.simplify([[1,1,1],[1.004,1,1],[2,1,1]]),[[1,1,1],[2,1,1]]);
 assert.deepEqual(model.round([1.00049,-0.0004,2.0005]),[1,0,2.001]);
});

test('normalize and check refuse unsupported or unsafe curves without partial acceptance',()=>{
 const good=spec([[5,15.75,12.5],[20,15.75,40],[30,15.75,67.5]]);assert.deepEqual(model.normalize(good),good);
 const edits=[
  [s=>s.points[1][1]=15.77,/평면 위/],[s=>s.points[1]=s.points[0].slice(),/너무 가깝/],[s=>s.algorithm='kin-cpr-2',/알고리즘/],
  [s=>s.schema=2,/알고리즘/],[s=>s.interpolation='linear',/보간/],[s=>s.kind='spline',/보간/],[s=>s.display.VOILUTFunction='SIGMOID',/LINEAR/],
  [s=>s.output.spacing=6,/출력 조건/],[s=>s.output.halfHeight=151,/출력 조건/],[s=>s.output.edge='nearest',/출력 조건/],[s=>s.extra=1,/형식/],
  [s=>s.frameOfReference='x',/Frame of Reference/],[s=>s.plane.normal=[0,.5,0],/그리기 평면/],[s=>s.cell=3,/보간/],
  [s=>s.points=Array.from({length:65},(_,i)=>[i,15.75,40]),/64개/],[s=>s.points=[s.points[0]],/두 개 이상/],
  [s=>{s.kind='freehand';s.interpolation='linear';s.points=Array.from({length:129},(_,i)=>[i*.5,15.75,40]);},/128개/],
  [s=>s.points=[[0,15.75,0],[0,15.75,1001]],/1000 mm/],[s=>s.points=[[0,15.75,0],[0,15.75,.3]],/짧습니다/],
  [s=>{s.output.spacing=.05;s.output.halfHeight=150;s.points=[[0,15.75,0],[0,15.75,200]];},/한도/]];
 for(const [edit,message] of edits){const s=structuredClone(good);edit(s);assert.throws(()=>model.check(s),message);assert.equal(model.normalize(s),null);}
 // A single drafted point is a valid draft but never a saved curve.
 const draft=structuredClone(good);draft.points=[draft.points[0]];assert.equal(model.check(draft,{partial:true}),null);
});

test('chunked reconstruction yields between rows and equals the one-shot result; raster maps LINEAR VOI',()=>{
 const {source}=volume({dimensions:[64,64,33],spacing:[.7,.5,2.5],origin:[0,0,0],direction:IDENTITY});
 const s=spec([[5,15.75,12.5],[20,15.75,40],[30,15.75,67.5]],{spacing:.05,halfHeight:20});
 const it=model.reconstruct(s,source);let yields=0,step;while(!(step=it.next()).done)yields++;
 assert.ok(yields>=2);assert.deepEqual(Array.from(step.value.values),Array.from(model.run(s,source).values));
 const preview=model.run(s,source,{spacing:.1});assert.ok(preview.columns<step.value.columns);
 const rgba=model.raster({values:Float64Array.from([-1000,0,1000,NaN])},display);
 assert.deepEqual(Array.from(rgba),[0,0,0,255,128,128,128,255,255,255,255,255,0,0,110,255]);
 assert.deepEqual(Array.from(model.raster({values:Float64Array.from([-1000])},{...display,invert:true})),[255,255,255,255]);
 const state=model.planeState({focalPoint:[1,15.8,2],viewPlaneNormal:[0,-2,0]},{origin:[0,15.75,0],normal:[0,1,0]});
 close(state.offset,.05,1e-12);assert.equal(state.aligned,true);
});
