// TEST-MPR-PATH-MODEL: kin-path-1 geometry, transported frame, unfolded HU sampling, cameras and refusals.
// Oracles are independent of the model: a straight path has closed-form centres and a constant
// frame; a planar arc's rotation-minimizing binormal is the plane normal; a helix's rotation-
// minimizing normal turns against its Frenet normal at exactly minus the torsion; trilinear
// sampling reproduces a field linear in patient coordinates, evaluated here by the forward voxel map.
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const model=require(path.join(__dirname,'../worklist-v0/hpacs-lite/volume-path.js'));
const curved=require(path.join(__dirname,'../worklist-v0/hpacs-lite/volume-curved.js'));
const orientation=require(path.join(__dirname,'../worklist-v0/hpacs-lite/volume-orientation.js'));

const close=(actual,expected,delta=1e-9,label='')=>assert.ok(Math.abs(actual-expected)<=delta,label+' '+actual+' != '+expected);
const closeVector=(a,b,delta=1e-9,label='')=>a.forEach((x,i)=>close(x,b[i],delta,label+'['+i+']'));
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const sub=(a,b)=>a.map((x,i)=>x-b[i]),add=(a,b)=>a.map((x,i)=>x+b[i]),scale=(a,s)=>a.map(x=>x*s);
const norm=a=>Math.hypot(...a),unit=a=>scale(a,1/norm(a));
const at=(array,c)=>[array[c*3],array[c*3+1],array[c*3+2]];
const display={voiRange:{lower:-1000,upper:1000},VOILUTFunction:'LINEAR',invert:false};
const spec=(points,{initialNormal,spacing=.5,halfHeight=3,angle=0,column=0,cell=0}={})=>model.build({frameOfReference:'2.25.6',cell,points,
  initialNormal:initialNormal||model.initialNormal(points,spacing,null),angle,column,spacing,halfHeight,display});
// The least-aligned patient axis projected onto the plane perpendicular to t, written out here.
function defaultNormal(t){const w=t.map(Math.abs),axis=w.indexOf(Math.min(...w)),e=[0,0,0];e[axis]=1;return unit(sub(e,scale(t,t[axis])));}
// Uniform Catmull-Rom (endpoints duplicated, 16 per segment) and arc-length resampling from the
// written contract, so the arc fixture does not reuse the model's own resampler.
function polyline(points){
  const n=points.length,out=[],p=i=>points[Math.max(0,Math.min(n-1,i))];
  for(let i=0;i<n-1;i++)for(let j=0;j<16;j++){const t=j/16;out.push([0,1,2].map(k=>.5*(2*p(i)[k]+(-p(i-1)[k]+p(i+1)[k])*t+(2*p(i-1)[k]-5*p(i)[k]+4*p(i+1)[k]-p(i+2)[k])*t*t+(-p(i-1)[k]+3*p(i)[k]-3*p(i+1)[k]+p(i+2)[k])*t*t*t)));}
  out.push(points[n-1].slice());return out;
}
function walk(points,spacing,count){
  const line=polyline(points),out=[];let total=0;const lengths=[0];
  for(let i=1;i<line.length;i++)lengths.push(total+=norm(sub(line[i],line[i-1])));
  for(let c=0;c<count;c++){const s=c*spacing;let i=1;while(i<line.length-1&&lengths[i]<s)i++;const span=lengths[i]-lengths[i-1],f=span?(s-lengths[i-1])/span:0;out.push(add(line[i-1],scale(sub(line[i],line[i-1]),f)));}
  return {length:total,centres:out};
}
function volume({dimensions,spacing,origin,direction,field}){
  const axes=[0,1,2].map(a=>direction.slice(a*3,a*3+3)),[dx,dy,dz]=dimensions;
  const world=index=>origin.map((o,n)=>o+index[0]*axes[0][n]*spacing[0]+index[1]*axes[1][n]*spacing[1]+index[2]*axes[2][n]*spacing[2]);
  const scalars=new Float64Array(dx*dy*dz);
  for(let k=0;k<dz;k++)for(let j=0;j<dy;j++)for(let i=0;i<dx;i++)scalars[i+j*dx+k*dx*dy]=field(world([i,j,k]));
  // Orthonormal direction rows: the index of a patient point is a projection, not a matrix inverse.
  const oracle=p=>{
    const index=axes.map((a,i)=>dot(a,sub(p,origin))/spacing[i]);
    if(index.some((x,i)=>x<-.5-1e-6||x>dimensions[i]-.5+1e-6))return NaN;
    return field(world(index.map((x,i)=>Math.min(Math.max(x,0),dimensions[i]-1))));
  };
  const geometry={origin,direction,spacing,dimensions};
  return {world,oracle,geometry,source:{scalars,dimensions,worldToIndex:curved.affine(geometry)}};
}
const c30=Math.cos(Math.PI/6),s30=Math.sin(Math.PI/6);
// 30 degrees about patient H with a descending slice axis.
const OBLIQUE=[c30,s30,0,-s30,c30,0,0,0,-1];
const linear=p=>3.5+2*p[0]-1.25*p[1]+.75*p[2];
function frameIsOrthonormal(grid,label){
  for(let c=0;c<grid.columns;c++){
    const T=at(grid.tangents,c),N=at(grid.normals,c),B=at(grid.binormals,c);
    for(const v of [T,N,B])close(norm(v),1,1e-9,label+' unit '+c);
    close(dot(T,N),0,1e-9,label+' T.N '+c);closeVector(cross(N,B),T,1e-9,label+' NxB=T '+c);
  }
}

test('straight diagonal path: exact arc length and columns, constant frame, analytic centres and default normal rule',()=>{
  const p0=[5,6,12.5],p1=[35,26,-2.5],u=unit(sub(p1,p0)),L=norm(sub(p1,p0));
  const explicit=unit(cross(u,[0,0,1])),s=spec([p0,p1],{initialNormal:explicit,halfHeight:4}),grid=model.check(s);
  close(grid.length,L,1e-9,'length');assert.equal(grid.columns,Math.floor(L/.5+1e-9)+1);assert.equal(grid.rows,17);assert.equal(grid.half,8);
  for(let c=0;c<grid.columns;c++){
    closeVector(at(grid.centres,c),add(p0,scale(u,c*.5)),1e-9,'centre '+c);
    closeVector(at(grid.tangents,c),u,1e-9,'T');closeVector(at(grid.normals,c),explicit,1e-9,'N');closeVector(at(grid.binormals,c),cross(u,explicit),1e-9,'B');
  }
  frameIsOrthonormal(grid,'straight');
  // Three collinear control points are still one straight line of the same length.
  const mid=add(p0,scale(u,L*.4)),three=model.check(spec([p0,mid,p1],{initialNormal:explicit}));
  close(three.length,L,1e-9,'collinear length');closeVector(at(three.normals,three.columns-1),explicit,1e-9,'collinear N');
  // The default initial normal, tested on its own: the least-aligned patient axis, projected.
  const persisted=model.initialNormal([p0,p1],.5,null);closeVector(persisted,defaultNormal(u),1e-12,'default');
  close(norm(persisted),1,1e-12);close(dot(persisted,u),0,1e-12);
});

test('planar arc in an oblique plane with an in-plane initial normal keeps B on the plane normal at every column',()=>{
  const C=[20,15,40],e1=unit([1,1,0]),e2=unit([-1,1,2]),P=cross(e1,e2),R=12;
  const points=[...Array(11).keys()].map(i=>{const a=i*20*Math.PI/180;return add(C,add(scale(e1,R*Math.cos(a)),scale(e2,R*Math.sin(a))));});
  // Choose the initial normal in the drawing plane explicitly; the generic default need not be.
  const n0=model.initialNormal(points,.5,e1);close(dot(n0,P),0,1e-12,'in-plane initial normal');
  const grid=model.check(spec(points,{initialNormal:n0}));
  const independent=walk(points,.5,grid.columns);
  close(grid.length,independent.length,1e-9,'arc length');assert.equal(grid.columns,Math.floor(independent.length/.5+1e-9)+1);
  for(let c=0;c<grid.columns;c++){
    closeVector(at(grid.centres,c),independent.centres[c],1e-9,'centre '+c);
    close(Math.abs(dot(at(grid.binormals,c),P)),1,1e-9,'B = +-plane normal '+c);close(dot(at(grid.normals,c),P),0,1e-9,'N in plane '+c);
  }
  frameIsOrthonormal(grid,'arc');
  // The default rule on the same arc is only claimed to be a unit vector perpendicular to t0.
  const t0=at(grid.tangents,0),fallback=model.initialNormal(points,.5,null);
  closeVector(fallback,defaultNormal(t0),1e-12,'default');close(dot(fallback,t0),0,1e-12);
});

test('non-coplanar helix: orthonormal frames and the analytic rotation-minimizing twist of minus the torsion',()=>{
  // Radius 10, rise 4 mm per radian, one and a half turns, control points every pi/16.
  const Rh=10,h=4,du=Math.PI/16,points=[];for(let i=0;i*du<=3*Math.PI+1e-9;i++){const u=i*du;points.push([Rh*Math.cos(u),Rh*Math.sin(u),h*u]);}
  const tetra=dot(sub(points[8],points[0]),cross(sub(points[16],points[0]),sub(points[24],points[0])));assert.ok(Math.abs(tetra)>100,'non-coplanar');
  const grid=model.check(spec(points));frameIsOrthonormal(grid,'helix');
  const c=Math.hypot(Rh,h),tau=h/(c*c),theta=[],arc=[];
  for(let k=0;k<grid.columns;k++){
    const p=at(grid.centres,k);let u=Math.atan2(p[1],p[0]);u+=2*Math.PI*Math.round((p[2]/h-u)/(2*Math.PI));
    const NF=[-Math.cos(u),-Math.sin(u),0],BF=[h*Math.sin(u)/c,-h*Math.cos(u)/c,Rh/c],N=at(grid.normals,k);
    theta.push(Math.atan2(dot(N,BF),dot(N,NF)));arc.push(u*c);
  }
  // Skip the two end control spans, where duplicated end points bend the Catmull-Rom tangent.
  // The residual measured at this control spacing is 2.2e-4 rad and falls about tenfold when the
  // spacing halves; 2e-3 rad is a bound 1600 times smaller than the 3.2 rad twist a Frenet or
  // untransported normal would miss.
  const skip=Math.ceil(2*Rh*du/.5),wrap=x=>Math.atan2(Math.sin(x),Math.cos(x));let worst=0,twist=0;
  for(let k=skip;k<grid.columns-skip;k++){worst=Math.max(worst,Math.abs(wrap(theta[k]-theta[skip]+tau*(arc[k]-arc[skip]))));twist=Math.max(twist,tau*(arc[k]-arc[skip]));}
  assert.ok(worst<=2e-3,'rotation-minimizing residual '+worst);assert.ok(twist>3,'twist '+twist);
  // A Frenet normal keeps theta constant along a helix and therefore misses the whole twist.
  assert.ok(Math.abs(wrap(theta[grid.columns-skip-1]-theta[skip]))>1,'differs from Frenet');
});

test('unfolded values on an oblique descending basis equal the linear HU field at angles 0, 90 and 37 degrees',()=>{
  const v=volume({dimensions:[40,36,30],spacing:[.7,.5,2.5],origin:[-3,7,60],direction:OBLIQUE,field:linear});
  const p0=curved.round(v.world([8,10,12])),p1=curved.round(v.world([30,24,18])),u=unit(sub(p1,p0)),N=unit(cross(u,[0,0,1])),B=cross(u,N);
  for(const degrees of [0,90,37]){
    const s=spec([p0,p1],{initialNormal:N,halfHeight:12,angle:degrees}),result=model.run(s,v.source),a=degrees*Math.PI/180,D=add(scale(N,Math.cos(a)),scale(B,Math.sin(a)));
    assert.equal(result.rows,49);assert.equal(result.half,24);assert.equal(result.columns,Math.floor(norm(sub(p1,p0))/.5+1e-9)+1);
    let outside=0;
    for(let r=0;r<result.rows;r++)for(let c=0;c<result.columns;c++){
      const want=v.oracle(add(add(p0,scale(u,c*.5)),scale(D,(24-r)*.5))),got=result.values[r*result.columns+c];
      if(Number.isNaN(want)){assert.ok(Number.isNaN(got),`outside a${degrees} r${r} c${c}`);outside++;}else close(got,want,1e-8,`a${degrees} r${r} c${c}`);
    }
    assert.equal(result.outside,outside);assert.ok(outside>0&&outside<result.values.length,'some samples leave the volume '+degrees);
  }
  // Rows above the path are the +D side: at angle 0, row 16 is 4 mm along +N from the first column.
  const zero=model.run(spec([p0,p1],{initialNormal:N,halfHeight:12}),v.source),plus=v.oracle(add(p0,scale(N,4))),minus=v.oracle(add(p0,scale(N,-4)));
  assert.ok(Number.isFinite(plus)&&Number.isFinite(minus)&&Math.abs(plus-minus)>1,'the fixture distinguishes the two sides');
  close(zero.values[16*zero.columns],plus,1e-8,'row 16 is +N');close(zero.values[32*zero.columns],minus,1e-8,'row 32 is -N');
});

test('path creation, frames and cameras never read scalars: two volumes share every geometric fact',()=>{
  const common={dimensions:[20,20,20],spacing:[1,1,1],origin:[0,0,0],direction:[1,0,0,0,1,0,0,0,1]};
  const a=volume({...common,field:linear}),b=volume({...common,field:p=>1000-p[2]*p[2]});
  const s=spec([[2,3,4],[10,8,6],[15,15,14]],{halfHeight:2});
  const fact=g=>JSON.stringify({...g,centres:Array.from(g.centres),tangents:Array.from(g.tangents),normals:Array.from(g.normals),binormals:Array.from(g.binormals)});
  assert.equal(fact(model.plan(s)),fact(model.plan(structuredClone(s))));
  const cams=[0,1,2].map(i=>({focalPoint:[1,2,3],position:[1,2,103],viewUp:[0,1,0],viewPlaneNormal:[0,0,1],parallelScale:10+i}));
  assert.deepEqual(model.cameras(model.plan(s),3,cams,0),model.cameras(model.plan(s),3,cams,0));
  const ra=model.run(s,a.source),rb=model.run(s,b.source);
  assert.deepEqual([ra.columns,ra.rows,ra.length],[rb.columns,rb.rows,rb.length]);assert.notDeepEqual(Array.from(ra.values),Array.from(rb.values));
  // Structural: the only scalar entry point is reconstruct's single sampler call.
  const text=fs.readFileSync(path.join(__dirname,'../worklist-v0/hpacs-lite/volume-path.js'),'utf8');
  assert.equal((text.match(/sampler\(/g)||[]).length,1);assert.ok(!/scalars|getCompleteScalarDataArray|voxelManager/.test(text));
});

test('an edit re-projects and persists the initial normal; a collapsed projection falls back to the default rule',()=>{
  const first=[[5,5,5],[20,9,7],[30,20,15]],n=model.initialNormal(first,.5,null),saved=spec(first,{initialNormal:n});model.check(saved);
  const moved=[[5,5,5],[12,20,11],[30,20,15]],t0=unit(sub(walk(moved,.5,2).centres[1],moved[0]));
  assert.ok(Math.abs(dot(n,t0))>1e-3,'the edit really changes t0');
  assert.throws(()=>model.check({...structuredClone(saved),points:moved}),/기준 방향/,'a stale normal is refused, not silently re-projected');
  const projected=model.initialNormal(moved,.5,n);closeVector(projected,unit(sub(n,scale(t0,dot(n,t0)))),1e-9,'re-projected');
  const edited=spec(moved,{initialNormal:projected});model.check(edited);assert.deepEqual(model.normalize(edited).frame.initialNormal,projected);
  closeVector(model.initialNormal(moved,.5,t0),defaultNormal(t0),1e-9,'collapsed -> default');
});

test('refusals: shape, limits, reversals, degenerate frames, angle and position',()=>{
  const good=spec([[5,6,12.5],[20,15.75,40],[30,8,67.5]]);assert.deepEqual(model.normalize(good),good);
  const t0=at(model.plan(good).tangents,0),columns=model.plan(good).columns;
  const renormal=s=>{s.frame.initialNormal=model.initialNormal(s.points,s.output.spacing,null);};
  const edits=[
    [s=>s.points[1]=s.points[0].slice(),/너무 가깝/],[s=>s.points=[s.points[0]],/두 개 이상/],[s=>{s.points=[[0,0,0],[.3,0,0]];},/짧습니다/],
    [s=>{s.points=[[0,0,0],[1001,0,0]];},/1000 mm/],[s=>{s.points=[[0,0,0],[20,0,0],[1,0,0]];renormal(s);},/급하게/],
    // A U-turn 0.02 mm wide turns back inside one 0.5 mm sample (a 0.5 mm wide one is a valid tight curve).
    [s=>{s.points=[[0,0,0],[10,0,0],[10,0,.02],[0,0,.02]];renormal(s);},/급하게/],
    [s=>s.frame.initialNormal=t0,/기준 방향/],[s=>s.frame.initialNormal=unit(add(s.frame.initialNormal,scale(t0,2e-3))),/기준 방향/],
    [s=>s.frame.initialNormal=scale(s.frame.initialNormal,1.01),/기준 방향/],[s=>s.frame.initialNormal=[NaN,0,0],/기준 방향/],[s=>s.frame.method='frenet',/기준 방향/],
    [s=>s.unfold.angle=360,/Unfold/],[s=>s.unfold.angle=-1,/Unfold/],[s=>s.unfold.angle=12.345,/Unfold/],
    [s=>s.position.column=columns,/경로 길이를 넘/],[s=>s.position.column=1.5,/경로 위치/],[s=>s.extra=1,/형식/],[s=>s.algorithm='kin-path-2',/계산 방식/],
    [s=>s.interpolation='linear',/계산 방식/],[s=>s.frameOfReference='x',/Frame of Reference/],[s=>s.output.halfHeight=151,/출력 조건/],[s=>s.output.spacing=6,/출력 조건/],
    [s=>s.display.VOILUTFunction='SIGMOID',/LINEAR/],[s=>s.cell=3,/표시 기준/],[s=>s.points=Array.from({length:65},(_,i)=>[i,i%2,0]),/64개/],
    [s=>{s.output.spacing=.05;s.output.halfHeight=150;s.points=[[0,0,0],[200,0,0]];renormal(s);},/한도/],[s=>s.points[2]=[1,NaN,0],/좌표/]];
  // A reversal is already refused while its initial normal is derived, so the edit runs inside the assertion.
  for(const [edit,message] of edits){const s=structuredClone(good);assert.throws(()=>{edit(s);model.check(s);},message,String(edit));assert.equal(model.normalize(s),null,String(edit));}
  // A single drafted point is a valid draft but never a saved path.
  const draft=structuredClone(good);draft.points=[draft.points[0]];assert.equal(model.check(draft,{partial:true}),null);
  // Guards on the frame itself, before any division: coincident centres and a chord against its tangent.
  const n=[0,0,1];
  assert.throws(()=>model.frames(Float64Array.from([0,0,0,0,0,0,1,0,0]),3,.5,n),/급하게/);
  assert.throws(()=>model.frames(Float64Array.from([0,0,0,1,0,0,.9,.2,0]),3,.5,n),/급하게/);
  assert.equal(model.angle(-90),270);assert.equal(model.angle(359.999),0);assert.equal(model.angle(37.004),37);
});

test('Go to Path Point cameras: T for the chosen cell, N and B with viewUp T for the others, one intersection',()=>{
  const points=[];for(let i=0;i<=24;i++){const u=i*Math.PI/16;points.push([20+10*Math.cos(u),15+10*Math.sin(u),10+4*u]);}
  const grid=model.plan(spec(points)),column=50,centre=at(grid.centres,column),T=at(grid.tangents,column),N=at(grid.normals,column),B=at(grid.binormals,column);
  const current=[100,200,300].map((d,i)=>({focalPoint:[1,2,3],position:[1,2,3+d],viewUp:[0,1,0],viewPlaneNormal:[0,0,1],parallelScale:10*(i+1),flipHorizontal:false,flipVertical:false,rotation:0}));
  for(const perpendicular of [0,1,2]){
    const next=model.cameras(grid,column,current,perpendicular),others=[0,1,2].filter(i=>i!==perpendicular);
    closeVector(next[perpendicular].viewPlaneNormal,T);closeVector(next[perpendicular].viewUp,B);
    closeVector(next[others[0]].viewPlaneNormal,N);closeVector(next[others[1]].viewPlaneNormal,B);
    for(const i of others)closeVector(next[i].viewUp,T);
    next.forEach((camera,i)=>{closeVector(camera.focalPoint,centre);close(norm(sub(camera.position,camera.focalPoint)),[100,200,300][i],1e-9);
      assert.equal(camera.parallelScale,10*(i+1));closeVector(scale(sub(camera.position,camera.focalPoint),1/[100,200,300][i]),camera.viewPlaneNormal);});
    // The perpendicular cell's screen right is viewUp x normal = B x T = N.
    closeVector(cross(next[perpendicular].viewUp,next[perpendicular].viewPlaneNormal),N);
    closeVector(orientation.intersection(next),centre,1e-9,'intersection');
  }
  assert.throws(()=>model.cameras(grid,grid.columns,current,0),/경로 길이를 넘/);assert.throws(()=>model.cameras(grid,0,current,3),/3평면/);
});

test('server parity constants and chunked reconstruction',()=>{
  // Shared with the compiled server test (tests/viewer_volume_job_test.cjs).
  const s=spec([[5,6,12.5],[20,15.75,40],[30,8,67.5],[12,25,70]]),grid=model.check(s);
  close(grid.length,89.41385010736313,1e-9);assert.equal(grid.columns,179);assert.equal(grid.rows,13);
  closeVector(s.frame.initialNormal,[-0.15582558294899496,0.94703549761046,-0.28078845055364055],1e-12,'n0');
  closeVector(at(grid.normals,100),[0.1401263211339599,0.9324108380483229,0.33312856859700046],1e-9,'N100');
  closeVector(at(grid.normals,178),[0.5081280875808327,0.5820371816388471,-0.6348531844460997],1e-9,'Nlast');
  const v=volume({dimensions:[64,64,40],spacing:[.7,.5,2.5],origin:[0,0,0],direction:[1,0,0,0,1,0,0,0,1],field:linear});
  const big=spec(s.points,{spacing:.05,halfHeight:10}),it=model.reconstruct(big,v.source);let yields=0,step;while(!(step=it.next()).done)yields++;
  assert.ok(yields>=2);assert.deepEqual(Array.from(step.value.values),Array.from(model.run(big,v.source).values));
  assert.ok(model.run(big,v.source,{spacing:.1}).columns<step.value.columns);
  assert.ok(model.onPlane([1,2,3.005],{focalPoint:[0,0,3],viewPlaneNormal:[0,0,-2]}));assert.ok(!model.onPlane([1,2,3.02],{focalPoint:[0,0,3],viewPlaneNormal:[0,0,1]}));
});
