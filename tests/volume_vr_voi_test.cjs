// TEST-S8-U1a-MODEL (MV-U1a-01, 02, 05, 06, 07, 08, 09): the VR VOI Slab model against independent geometry.
// Expected values are computed here from the synthetic grids (contract accuracy-fixtures G-AX, G-OB1, G-OB2) with this
// file's own vector arithmetic; the model is only called, never re-implemented or read as text.
const test=require('node:test');
const assert=require('node:assert/strict');
const vr=require('../worklist-v0/hpacs-lite/volume-vr-voi.js');
const voi=require('../worklist-v0/hpacs-lite/volume-voi.js');

const T_MODEL=1e-6;
// Contract §13 reason keys (M-09). A model refusal names one of them, never a sentence.
const REASON_KEYS=new Set(['source-irregular','source-unsupported','source-changed','vr-not-reproducible','vr-not-final','vr-unapplied-edit','busy','vr-layout','vr-combination','vr-limit','render-failed','context-lost','access-lost','vr-output-unsupported']);
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const add=(a,b)=>a.map((x,i)=>x+b[i]),sub=(a,b)=>a.map((x,i)=>x-b[i]),mul=(a,s)=>a.map(x=>x*s);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function near(actual,expected,tolerance=T_MODEL,label=''){
  if(Array.isArray(expected)){assert.equal(actual.length,expected.length,label);expected.forEach((v,i)=>near(actual[i],v,tolerance,label+'['+i+']'));return;}
  assert.ok(Math.abs(actual-expected)<=tolerance,`${label}: ${actual} != ${expected}`);
}
// A grid as DICOM would describe it: IOP row/column cosines, PixelSpacing (row, column), slice step along the slice
// normal and the first slice's IPP. Voxel (i,j,k) centre = IPP0 + i*row*colSpacing + j*col*rowSpacing + k*normal*step (F-72).
// The integer index extent is [0, dims-1] per axis. The pinned renderer's ImageData.getSpatialExtent() is that extent
// widened by half a voxel, [l-0.5, u+0.5]: the box the volume texture spans and the VR draws (contract C-02 as corrected by
// S8-U1a-SPEC-B-F01). The model reads it; the expectations below are built from the voxel geometry instead.
function grid({iop,spacing=[.5,.5],step=2.5,origin=[0,0,0],dims=[64,64,33],descending=false}){
  const row=iop.slice(0,3),col=iop.slice(3,6),normal=cross(row,col),slice=descending?mul(normal,-step):mul(normal,step);
  const axes=[mul(row,spacing[1]),mul(col,spacing[0]),slice];
  const world=([i,j,k])=>add(origin,add(mul(axes[0],i),add(mul(axes[1],j),mul(axes[2],k))));
  const index=[0,dims[0]-1,0,dims[1]-1,0,dims[2]-1],spatial=index.map((x,n)=>n%2?x+.5:x-.5);
  return {axes,dims,world,index,imageData:{getSpatialExtent:()=>spatial.slice(),indexToWorld:index=>world(index)}};
}
const GRIDS={
  'G-AX':grid({iop:[1,0,0,0,1,0]}),
  'G-OB1':grid({iop:[1,0,0,0,.8,.6]}),
  'G-OB2':grid({iop:[.8,.6,0,-.36,.48,.8]}),
  // The same axial grid with its first index at the top: IPP decreases as k grows (SB-03).
  'G-AX-desc':grid({iop:[1,0,0,0,1,0],origin:[0,0,80],descending:true}),
  // An oblique grid stacked the other way, so a descending affine is also checked off the world axes.
  'G-OB2-desc':grid({iop:[.8,.6,0,-.36,.48,.8],origin:[3,-2,90],descending:true}),
};
// The rendered outer box: the integer index extent plus half a voxel on each side, through the grid's affine.
function outerCorners(g){const out=[];for(const i of [g.index[0]-.5,g.index[1]+.5])for(const j of [g.index[2]-.5,g.index[3]+.5])for(const k of [g.index[4]-.5,g.index[5]+.5])out.push(g.world([i,j,k]));return out;}
function expectedDefault(g,orientation){
  const n={Axial:[0,0,1],Coronal:[0,1,0],Sagittal:[1,0,0]}[orientation],c=outerCorners(g),center=mul(c.reduce(add,[0,0,0]),1/8),p=c.map(x=>dot(x,n));
  return {center,normal:n,pivot:center,thickness:Math.max(...p)-Math.min(...p)};
}
function rodrigues(v,k,degrees){const r=degrees*Math.PI/180,c=Math.cos(r),s=Math.sin(r);return add(add(mul(v,c),mul(cross(k,v),s)),mul(k,dot(k,v)*(1-c)));}
const WORLD={L:[1,0,0],P:[0,1,0],S:[0,0,1]};
// The shader distance the GPU evaluates at normalized texture position posIS: (world(posIS) - c) . n, with posIS 0..1
// spanning the outer box. Computed here as base + axes . posIS from the outer box's own corner and full edges.
function expectedPlane(g,slab){
  const o=g.world([g.index[0]-.5,g.index[2]-.5,g.index[4]-.5]),edges=g.axes.map((a,n)=>mul(a,g.dims[n]));
  return {base:dot(sub(o,slab.center),slab.normal),axes:edges.map(e=>dot(e,slab.normal)),halfThickness:slab.thickness/2};
}
// The normalized texture coordinate of a voxel centre: the texel centre (i - l + 0.5) / N along each axis.
const texel=(g,index)=>index.map((x,a)=>(x-g.index[2*a]+.5)/g.dims[a]);
const refusedWith=(fn,key)=>{let error;try{fn();}catch(caught){error=caught;}assert.ok(error,'expected a refusal');assert.equal(vr.reasonOf(error),key,error.message);return error;};
function deepFreeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const key of Object.keys(value))deepFreeze(value[key]);}return value;}
const plain=value=>JSON.parse(JSON.stringify(value));

test('MV-U1a-01 shader planes and bounding planes equal the independent affine geometry on every grid',()=>{
  for(const [name,g] of Object.entries(GRIDS)){
    const bound=vr.binding(g.imageData);
    for(const orientation of vr.ORIENTATIONS){
      let s=vr.reset(vr.initial(),bound,orientation),slab=s.voi.slab;
      const cases=[['default',slab]];
      s=vr.rotate(s,bound,'L',30);cases.push(['rotated L 30',s.voi.slab]);
      s=vr.move(s,bound,7.5);cases.push(['moved 7.5',s.voi.slab]);
      // Independent rotation and move of the default slab about its pivot.
      const d=expectedDefault(g,orientation),n1=rodrigues(d.normal,WORLD.L,30),c1=add(d.pivot,rodrigues(sub(d.center,d.pivot),WORLD.L,30));
      const independent={default:d,'rotated L 30':{...d,center:c1,normal:n1},'moved 7.5':{...d,center:add(c1,mul(n1,7.5)),normal:n1}};
      for(const [label,actual] of cases){
        const want=independent[label],tag=`${name} ${orientation} ${label}`;
        near(actual.center,want.center,T_MODEL,tag+' center');near(actual.normal,want.normal,T_MODEL,tag+' normal');near(actual.pivot,want.pivot,T_MODEL,tag+' pivot');near(actual.thickness,want.thickness,T_MODEL,tag+' thickness');
        const record={mode:'Slab',orientation,slab:actual},plane=vr.shaderPlane(record,bound),expected=expectedPlane(g,want);
        assert.equal(plane.mode,'Slab');
        near(plane.base,expected.base,T_MODEL,tag+' base');near(plane.axes,expected.axes,T_MODEL,tag+' axes');near(plane.halfThickness,expected.halfThickness,T_MODEL,tag+' half');
        const [lower,upper]=vr.planes(record);
        near(lower.origin,sub(want.center,mul(want.normal,want.thickness/2)),T_MODEL,tag+' lower origin');near(lower.normal,want.normal,T_MODEL,tag+' lower normal');
        near(upper.origin,add(want.center,mul(want.normal,want.thickness/2)),T_MODEL,tag+' upper origin');near(upper.normal,mul(want.normal,-1),T_MODEL,tag+' upper normal');
        // The plane decides the same tissue as the world dot product at sampled voxel centres, read at their texel centres.
        for(const index of [[0,0,0],[63,63,32],[17,40,9],[50,3,30]]){
          near(plane.base+dot(plane.axes,texel(g,index)),dot(sub(g.world(index),want.center),want.normal),1e-6,tag+' distance '+index);
        }
      }
    }
  }
});

test('MV-U1a-01 defaults on G-AX: the outer box centre, full projected thickness and diagonal (SPEC-B-F01 numbers)',()=>{
  const g=GRIDS['G-AX'],bound=vr.binding(g.imageData);
  const axial=vr.defaults(bound,'Axial'),coronal=vr.defaults(bound,'Coronal'),sagittal=vr.defaults(bound,'Sagittal');
  // Outer box x/y -0.25..31.75 and z -1.25..81.25 mm, written out by hand.
  const c=outerCorners(g);near([0,1,2].map(a=>Math.min(...c.map(p=>p[a]))),[-.25,-.25,-1.25]);near([0,1,2].map(a=>Math.max(...c.map(p=>p[a]))),[31.75,31.75,81.25]);
  near(axial.center,[15.75,15.75,40]);near(axial.thickness,82.5);near(coronal.thickness,32);near(sagittal.thickness,32);
  assert.deepEqual([...axial.pivot],[...axial.center]);
  near(bound.diagonal,94.097024395,1e-6);near(bound.diagonal,Math.hypot(32,32,82.5));
  // Counterexample: the first-to-last voxel-centre box (80, 31.5, 31.5 mm, diagonal 91.566915) is not what the model takes.
  for(const [actual,centres] of [[axial.thickness,80],[coronal.thickness,31.5],[sagittal.thickness,31.5],[bound.diagonal,91.566915]])assert.ok(Math.abs(actual-centres)>.4,`${actual} vs ${centres}`);
});

test('MV-U1a-01 outer corners and projected thickness on axis-aligned, oblique and descending affines (independent)',()=>{
  // Closed form per grid: a box with full edges E_a = N_a * step_a projects onto n with thickness sum |E_a . n|, its centre
  // is the voxel centre of the middle index, and its diagonal is the largest |sum s_a E_a|. Hand numbers pin G-OB1 and
  // G-OB2: N = 64, 64, 33 voxels of 0.5, 0.5, 2.5 mm, so |E| = 32, 32, 82.5 mm.
  const hand={'G-AX':{Axial:82.5,Coronal:32,Sagittal:32},'G-AX-desc':{Axial:82.5,Coronal:32,Sagittal:32},
    'G-OB1':{Axial:32*.6+82.5*.8,Coronal:32*.8+82.5*.6,Sagittal:32},
    'G-OB2':{Axial:32*.8+82.5*.6,Coronal:32*.6+32*.48+82.5*.64,Sagittal:32*.8+32*.36+82.5*.48}};
  hand['G-OB2-desc']=hand['G-OB2'];
  for(const [name,g] of Object.entries(GRIDS)){
    const bound=vr.binding(g.imageData),edges=g.axes.map((a,n)=>mul(a,g.dims[n]));
    const signs=[[1,1,1],[-1,1,1],[1,-1,1],[1,1,-1]],diagonal=Math.max(...signs.map(s=>Math.hypot(...[0,1,2].map(m=>s[0]*edges[0][m]+s[1]*edges[1][m]+s[2]*edges[2][m])))),mid=g.world([31.5,31.5,16]);
    near(bound.diagonal,diagonal,T_MODEL,name+' diagonal');near(bound.diagonal,94.097024395,1e-6,name+' diagonal = |box|');
    for(const orientation of vr.ORIENTATIONS){
      const n={Axial:[0,0,1],Coronal:[0,1,0],Sagittal:[1,0,0]}[orientation],d=vr.defaults(bound,orientation),tag=`${name} ${orientation}`;
      near(d.thickness,edges.reduce((sum,e)=>sum+Math.abs(dot(e,n)),0),T_MODEL,tag+' thickness');near(d.thickness,hand[name][orientation],1e-9,tag+' hand thickness');
      near(d.center,mid,T_MODEL,tag+' centre');near(d.center,expectedDefault(g,orientation).center,T_MODEL,tag+' corner mean');
      // Counterexample: the voxel-centre box (N_a - 1 steps per axis) would be thinner by sum |step_a . n| > 0.
      const centres=g.axes.reduce((sum,a,m)=>sum+Math.abs(dot(mul(a,g.dims[m]-1),n)),0);assert.ok(d.thickness-centres>.4,`${tag}: ${d.thickness} vs ${centres}`);
    }
    // The texel of the first and last voxel centre sits half a texel inside the outer box, and a full crop's faces are
    // the outer faces: posIS 0 and 1 are the outer box, not the first and last voxel centres.
    const plane=vr.shaderPlane({mode:'Slab',orientation:'Axial',slab:{center:mid,normal:[0,0,1],pivot:mid,thickness:1}},bound),outer=outerCorners(g);
    near(plane.base,dot(sub(outer[0],mid),[0,0,1]),T_MODEL,name+' posIS 0 is the outer corner');
    near(plane.base+plane.axes.reduce((s,x)=>s+x,0),dot(sub(outer[7],mid),[0,0,1]),T_MODEL,name+' posIS 1 is the outer corner');
    for(const index of [[0,0,0],[63,63,32]]){
      const at=texel(g,index),wrong=index.map((x,a)=>(x-g.index[2*a])/(g.index[2*a+1]-g.index[2*a]));
      near(plane.base+dot(plane.axes,at),dot(sub(g.world(index),mid),[0,0,1]),T_MODEL,name+' texel '+index);
      // Counterexample: reading posIS as first-to-last voxel centre (0..1 over [l, u]) on this texture misplaces the voxel.
      assert.ok(Math.abs(plane.base+dot(plane.axes,wrong)-dot(sub(g.world(index),mid),[0,0,1]))>.2,name+' centre-span texture reading '+index);
    }
  }
});

test('MV-U1a-02 voxel-centre inclusion at the slab bound matches volume-voi.js contains',()=>{
  const g=GRIDS['G-AX'],bound=vr.binding(g.imageData),D=2.5;
  // The voxel centres one slice above and below the centre (k 17 and 15, z 42.5 and 37.5) are D = 2.5 mm from it.
  const halves=[['inside by 1e-6',D+1e-6,true],['exactly on the bound',D,true],['at the tolerance',D/(1+1e-9),null],['outside by 1e-6',D-1e-6,false]];
  for(const [label,half,expected] of halves){
    for(const normal of [[0,0,1],[0,0,-1]]){
      const slab={center:[15.75,15.75,40],normal,pivot:[15.75,15.75,40],thickness:2*half},record={mode:'Slab',orientation:'Axial',slab};
      for(const k of [17,15]){
        const index=[31,31,k],kept=vr.keeps(record,bound,index),reference=voi.contains(slab,g.world(index));
        assert.equal(kept,reference,`${label} ${normal} k ${k}`);
        if(expected!==null)assert.equal(kept,expected,`${label} ${normal} k ${k}`);
      }
    }
  }
  assert.equal(vr.keeps(null,bound,[0,0,0]),true,'no VOI keeps every voxel');
});

test('MV-U1a-05 model calls leave their inputs unchanged and accept deeply frozen inputs',()=>{
  const g=GRIDS['G-OB2'];
  const imageData=deepFreeze({getSpatialExtent:()=>g.imageData.getSpatialExtent(),indexToWorld:index=>g.world(index)});
  const bound=vr.binding(imageData),start=vr.reset(vr.initial(),bound,'Coronal');
  const slab=deepFreeze(plain(start.voi.slab)),before=plain(slab),stateBefore=plain(start);
  let s=vr.apply(start,bound,{orientation:'Coronal',slab:{...slab,thickness:9}});
  s=vr.move(s,bound,3);s=vr.rotate(s,bound,'P',20);s=vr.setOriginal(s,true,true);s=vr.setOriginal(s,false,true);s=vr.disable(s);s=vr.undo(s);
  vr.shaderPlane(deepFreeze(plain(s.voi)),bound);vr.planes(deepFreeze(plain(s.voi)));vr.keeps(deepFreeze(plain(s.voi)),bound,deepFreeze([1,2,3]));
  vr.apply(deepFreeze(plain(start)),bound,deepFreeze({orientation:'Coronal',slab:plain(slab)}));
  assert.deepEqual(plain(slab),before);assert.deepEqual(plain(start),stateBefore);
  for(const value of [s,s.voi,s.voi.slab,s.history])assert.ok(Object.isFrozen(value),'returned state is frozen');
});

test('MV-U1a-06 out-of-range values, a non-unit normal and a thickness beyond the diagonal are refused',()=>{
  const bound=vr.binding(GRIDS['G-AX'].imageData),s=vr.reset(vr.initial(),bound,'Axial'),slab=s.voi.slab,diagonal=94.097024395;
  near(bound.diagonal,diagonal,1e-6);
  const accepted=vr.apply(s,bound,{orientation:'Axial',slab:{...slab,thickness:bound.diagonal}});
  assert.equal(accepted.voi.slab.thickness,bound.diagonal,'a slab as thick as the diagonal is accepted');
  const bad=[{...slab,thickness:bound.diagonal+1e-6},{...slab,thickness:0},{...slab,thickness:-1},{...slab,center:[1e6+1,0,0]},{...slab,pivot:[0,-1e6-1,0]},
    {...slab,normal:[0,0,2]},{...slab,normal:[0,0,0]},{...slab,center:[Infinity,0,0]},{...slab,center:[NaN,0,0]}];
  for(const value of bad){refusedWith(()=>vr.apply(s,bound,{orientation:'Axial',slab:value}),'vr-limit');}
  const edge=vr.apply(s,bound,{orientation:'Axial',slab:{...slab,center:[15.75,15.75,1e6]}});near(edge.voi.slab.center,[15.75,15.75,1e6],0);
  refusedWith(()=>vr.rotate(s,bound,'S',180.0001),'vr-limit');assert.ok(vr.rotate(s,bound,'S',180).voi);
  refusedWith(()=>vr.move(edge,bound,2),'vr-limit');
  for(const imageData of [{getSpatialExtent:()=>[0,0,0,1,0,1],indexToWorld:p=>p},{getSpatialExtent:()=>[0,1,0,1,0,1],indexToWorld:p=>[p[0]+p[1],p[0]+p[1],p[2]]},
    {getSpatialExtent:()=>[0,1,0,1,0,1],indexToWorld:()=>[NaN,0,0]},{getSpatialExtent:()=>[0,1,0,1,0,NaN],indexToWorld:p=>p},null])refusedWith(()=>vr.binding(imageData),'source-unsupported');
  assert.deepEqual(plain(s),plain(vr.reset(vr.initial(),bound,'Axial')),'refusals leave the state as it was');
});

test('MV-U1a-07 forged values are refused without coercion',()=>{
  const bound=vr.binding(GRIDS['G-AX'].imageData),s=vr.reset(vr.initial(),bound,'Axial'),slab=s.voi.slab;
  const forged=['1','0;discard',NaN,Infinity,{valueOf:()=>1},[1],null,undefined,true];
  for(const value of forged){
    refusedWith(()=>vr.apply(s,bound,{orientation:'Axial',slab:{...slab,thickness:value}}),'vr-limit');
    refusedWith(()=>vr.apply(s,bound,{orientation:'Axial',slab:{...slab,center:[value,0,0]}}),'vr-limit');
    refusedWith(()=>vr.move(s,bound,value),'vr-limit');
    refusedWith(()=>vr.rotate(s,bound,'S',value),'vr-limit');
  }
  for(const value of [[0,0],[0,0,1,0],'0,0,1'])refusedWith(()=>vr.apply(s,bound,{orientation:'Axial',slab:{...slab,normal:value}}),'vr-limit');
  refusedWith(()=>vr.apply(s,bound,{orientation:'Camera',slab}),'vr-limit');
  refusedWith(()=>vr.rotate(s,bound,'user-axis',10),'vr-limit');
  refusedWith(()=>vr.shaderPlane({mode:'Slab',orientation:'Axial',slab:{...slab,thickness:'1'}},bound),'vr-limit');
});

test('MV-U1a-08 transitions: defaults, move, rotate, pivot, reset, disable, undo, Original View and the history bound',()=>{
  for(const [name,g] of Object.entries(GRIDS)){
    const bound=vr.binding(g.imageData);
    for(const orientation of vr.ORIENTATIONS){
      const d=expectedDefault(g,orientation),s=vr.reset(vr.initial(),bound,orientation);
      near(s.voi.slab.center,d.center,T_MODEL,name+' default center');near(s.voi.slab.thickness,d.thickness,T_MODEL,name+' default thickness');assert.equal(s.voi.orientation,orientation);
    }
  }
  const bound=vr.binding(GRIDS['G-AX'].imageData),a=vr.reset(vr.initial(),bound,'Coronal'),slab=a.voi.slab;
  assert.equal(vr.initial().voi,null);assert.equal(a.history.length,1);assert.equal(a.history[0],null);
  // Move: only the centre follows the normal.
  const moved=vr.move(a,bound,2.5);near(moved.voi.slab.center,add(slab.center,[0,2.5,0]));near(moved.voi.slab.normal,slab.normal,0);near(moved.voi.slab.pivot,slab.pivot,0);assert.equal(moved.voi.slab.thickness,slab.thickness);
  // Rotate +90 then -90 about the pivot returns to the slab.
  const pivoted=vr.apply(a,bound,{orientation:'Coronal',slab:{...slab,pivot:[1,2,3]}});
  near(pivoted.voi.slab.center,slab.center,0);near(pivoted.voi.slab.normal,slab.normal,0);assert.equal(pivoted.voi.slab.thickness,slab.thickness);near(pivoted.voi.slab.pivot,[1,2,3],0);
  const turned=vr.rotate(vr.rotate(pivoted,bound,'S',90),bound,'S',-90);
  near(turned.voi.slab.center,pivoted.voi.slab.center);near(turned.voi.slab.normal,pivoted.voi.slab.normal);near(turned.voi.slab.pivot,[1,2,3],0);
  const quarter=vr.rotate(pivoted,bound,'S',90);near(quarter.voi.slab.normal,rodrigues(slab.normal,WORLD.S,90));near(quarter.voi.slab.center,add([1,2,3],rodrigues(sub(slab.center,[1,2,3]),WORLD.S,90)));
  // Reset VOI applies the chosen preset's default and leaves VOI on; Disable turns it off; Undo walks back.
  const reset=vr.reset(moved,bound,'Axial');assert.equal(reset.voi.orientation,'Axial');near(reset.voi.slab.thickness,82.5);
  const off=vr.disable(reset);assert.equal(off.voi,null);assert.equal(off.history.length,reset.history.length+1);
  const back=vr.undo(off);assert.ok(vr.same(back.voi,reset.voi));const back2=vr.undo(back);assert.ok(vr.same(back2.voi,moved.voi));
  assert.equal(vr.apply(reset,bound,{orientation:'Axial',slab:reset.voi.slab}),reset,'the same VOI again is not a change');
  // Original View: the masks stay; every edit is refused until it is off.
  const original=vr.setOriginal(reset,true,false);assert.equal(original.original,true);assert.ok(vr.same(original.voi,reset.voi));assert.equal(original.history,reset.history);
  for(const edit of [s=>vr.apply(s,bound,{orientation:'Axial',slab:reset.voi.slab}),s=>vr.move(s,bound,1),s=>vr.rotate(s,bound,'L',5),s=>vr.reset(s,bound,'Axial'),s=>vr.disable(s),s=>vr.undo(s)])refusedWith(()=>edit(original),'vr-not-final');
  assert.equal(vr.setOriginal(original,false,false).original,false);
  refusedWith(()=>vr.setOriginal(vr.initial(),true,false),'vr-limit');assert.equal(vr.setOriginal(vr.initial(),true,true).original,true,'a sculpt alone allows Original View');
  // Nothing applied: move, rotate, disable and undo have nothing to act on.
  for(const edit of [s=>vr.move(s,bound,1),s=>vr.rotate(s,bound,'L',5),s=>vr.disable(s),s=>vr.undo(s)])refusedWith(()=>edit(vr.initial()),'vr-limit');
  // Forty alternating moves: the state is the last one and the history keeps the newest 32.
  let s=a;const seen=[a.voi];for(let i=0;i<40;i++){s=vr.move(s,bound,i%2?-1.25:2.5);seen.push(s.voi);}
  assert.equal(s.history.length,vr.HISTORY);assert.equal(vr.HISTORY,32);assert.ok(vr.same(s.voi,seen[40]));
  for(let i=0;i<32;i++){s=vr.undo(s);assert.ok(vr.same(s.voi,seen[39-i]),'undo '+(i+1));}
  refusedWith(()=>vr.undo(s),'vr-limit');
});

test('MV-U1a-09 every model refusal names a contract reason key',()=>{
  const bound=vr.binding(GRIDS['G-AX'].imageData),s=vr.reset(vr.initial(),bound,'Axial'),errors=[];
  const attempt=fn=>{try{fn();}catch(error){errors.push(error);}};
  attempt(()=>vr.apply(s,bound,{orientation:'Axial',slab:{...s.voi.slab,thickness:1e9}}));attempt(()=>vr.binding({}));attempt(()=>vr.undo(vr.initial()));
  attempt(()=>vr.move(vr.setOriginal(s,true,false),bound,1));attempt(()=>vr.defaults(bound,'Oblique'));attempt(()=>vr.state({voi:'x'}));attempt(()=>vr.keeps(s.voi,bound,['1',0,0]));
  assert.equal(errors.length,7);
  for(const error of errors){const key=vr.reasonOf(error);assert.ok(REASON_KEYS.has(key),'reason key '+key);assert.match(key,/^[a-z]+(-[a-z]+)*$/);}
  assert.deepEqual([...new Set(errors.map(vr.reasonOf))].sort(),['source-unsupported','vr-limit','vr-not-final']);
});
