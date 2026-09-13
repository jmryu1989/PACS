(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumeCurved=api;})(globalThis,()=>{
  // kin-cpr-1: a stretched curved planar reconstruction. The curve lies on one fixed drawing
  // plane; column k sits at arc length k*spacing along the curve and row r at (m-r)*spacing
  // along +plane.normal, so row 0 is the +normal side and row m is the curve itself. Values are
  // the cached original HU scalars sampled trilinearly; no rescale is applied here and the
  // display window is applied only when the result is rastered.
  const ALGORITHM='kin-cpr-1',SUBDIVISIONS=16,PLANE_TOLERANCE=.01,MIN_GAP=.01,SIMPLIFY=.2,EDGE=1e-6;
  const LIMITS=Object.freeze({curved:64,freehand:128,columns:4096,rows:4096,samples:1048576,arc:1000,halfHeight:150,voxels:67108864,chunk:65536});
  const INTERPOLATION=Object.freeze({curved:'catmull-rom-uniform-16',freehand:'linear'});
  const OUTSIDE=[0,0,110];
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const vector=v=>Array.isArray(v)&&v.length===3&&v.every(n=>finite(n)&&Math.abs(n)<=1e6);
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
  const exact=(v,keys)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys;
  const fail=message=>{throw Error(message);};
  // Stored coordinates are rounded to 1 um so the saved Job is deterministic and bounded.
  const round=p=>p.map(n=>Math.round(n*1000)/1000+0);
  function unit(v){const n=Math.hypot(...v);if(!vector(v)||!(n>1e-9))fail('평면 방향을 확인할 수 없습니다.');return v.map(x=>x/n);}

  function build({kind,frameOfReference,cell,plane,points,spacing,halfHeight,display}){
    return {schema:1,algorithm:ALGORITHM,kind,frameOfReference,coordinates:'LPS_mm',cell,
      plane:{origin:plane.origin.slice(),normal:plane.normal.slice(),viewUp:plane.viewUp.slice()},
      points:points.map(p=>p.slice()),interpolation:INTERPOLATION[kind],
      output:{spacing,halfHeight,sampling:'trilinear',edge:'half-voxel-clamp',outside:'nan',axis:'arc-length'},
      display:{voiRange:{lower:display.voiRange.lower,upper:display.voiRange.upper},VOILUTFunction:display.VOILUTFunction,invert:display.invert}};
  }
  // Throws the reason in Korean; normalize() is the null-returning form of the same rules.
  function check(v,{partial=false}={}){
    if(!exact(v,'algorithm,cell,coordinates,display,frameOfReference,interpolation,kind,output,plane,points,schema'))fail('곡면 MPR 형식을 확인할 수 없습니다.');
    if(v.schema!==1||v.algorithm!==ALGORITHM||v.coordinates!=='LPS_mm')fail('지원하지 않는 곡면 MPR 알고리즘 버전입니다.');
    if(!['curved','freehand'].includes(v.kind)||v.interpolation!==INTERPOLATION[v.kind]||![0,1,2].includes(v.cell))fail('곡선 종류와 보간 방식을 확인할 수 없습니다.');
    if(typeof v.frameOfReference!=='string'||v.frameOfReference.length>64||!/^[0-9]+(\.[0-9]+)*$/.test(v.frameOfReference))fail('원본 좌표계(Frame of Reference)를 확인할 수 없습니다.');
    const p=v.plane;
    if(!exact(p,'normal,origin,viewUp')||![p.origin,p.normal,p.viewUp].every(vector)||Math.abs(dot(p.normal,p.normal)-1)>1e-6||Math.abs(dot(p.viewUp,p.viewUp)-1)>1e-6||Math.abs(dot(p.normal,p.viewUp))>1e-6)fail('그리기 평면을 확인할 수 없습니다.');
    const o=v.output;
    if(!exact(o,'axis,edge,halfHeight,outside,sampling,spacing')||o.sampling!=='trilinear'||o.edge!=='half-voxel-clamp'||o.outside!=='nan'||o.axis!=='arc-length'||!finite(o.spacing)||o.spacing<.05||o.spacing>5||!finite(o.halfHeight)||o.halfHeight<1||o.halfHeight>LIMITS.halfHeight)fail('곡면 MPR 출력 조건을 확인할 수 없습니다. Half Height는 1~150 mm입니다.');
    const d=v.display;
    if(!exact(d,'VOILUTFunction,invert,voiRange')||d.VOILUTFunction!=='LINEAR'||typeof d.invert!=='boolean'||!exact(d.voiRange,'lower,upper')||![d.voiRange.lower,d.voiRange.upper].every(n=>finite(n)&&Math.abs(n)<=1e9)||d.voiRange.upper<=d.voiRange.lower)fail('곡면 MPR은 LINEAR 창 설정 표시만 지원합니다.');
    if(!Array.isArray(v.points)||v.points.length>LIMITS[v.kind])fail(v.kind==='curved'?'Curved 제어점은 64개까지 지정할 수 있습니다.':'Freehand 곡선 점은 128개까지 저장할 수 있습니다. 더 짧거나 단순하게 그리세요.');
    if(!partial&&v.points.length<2)fail('곡선 점을 두 개 이상 지정하세요.');
    for(let i=0;i<v.points.length;i++){
      if(!vector(v.points[i]))fail('곡선 점 좌표를 확인할 수 없습니다.');
      if(Math.abs(dot(sub(v.points[i],p.origin),p.normal))>PLANE_TOLERANCE)fail('곡선 점은 그리기 평면 위(0.01 mm 이내)에 있어야 합니다.');
      if(i&&distance(v.points[i],v.points[i-1])<MIN_GAP)fail('이웃한 곡선 점이 너무 가깝습니다.');
    }
    return v.points.length>=2?plan(v):null;
  }
  function normalize(v){try{check(v);return build({...v,spacing:v.output.spacing,halfHeight:v.output.halfHeight});}catch(_){return null;}}

  // curved: uniform Catmull-Rom through every control point, end points duplicated, 16 samples
  // per segment plus the last point. freehand: the stored (already simplified) points, linear.
  function polyline(points,kind){
    if(kind==='freehand')return points.map(p=>p.slice());
    const n=points.length,out=[],at=i=>points[Math.max(0,Math.min(n-1,i))];
    for(let i=0;i<n-1;i++){
      const p0=at(i-1),p1=at(i),p2=at(i+1),p3=at(i+2);
      for(let j=0;j<SUBDIVISIONS;j++){
        const t=j/SUBDIVISIONS,t2=t*t,t3=t2*t;
        out.push([0,1,2].map(k=>.5*(2*p1[k]+(-p0[k]+p2[k])*t+(2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*t2+(-p0[k]+3*p1[k]-3*p2[k]+p3[k])*t3)));
      }
    }
    out.push(points[n-1].slice());return out;
  }
  function plan(spec,spacing=spec.output.spacing){
    const line=polyline(spec.points,spec.kind),cumulative=[0];
    for(let i=1;i<line.length;i++)cumulative.push(cumulative[i-1]+distance(line[i],line[i-1]));
    const length=cumulative[cumulative.length-1];
    if(!(length>=spacing))fail('곡선 길이가 출력 간격보다 짧습니다. 점 사이를 더 벌리세요.');
    if(length>LIMITS.arc)fail('곡선 길이는 1000 mm 이하여야 합니다.');
    const columns=Math.floor(length/spacing+1e-9)+1,half=Math.floor(spec.output.halfHeight/spacing+1e-9),rows=2*half+1;
    if(columns>LIMITS.columns||rows>LIMITS.rows||columns*rows>LIMITS.samples)fail('곡면 결과 크기가 한도(가로·세로 4096, 전체 1,048,576 표본)를 넘습니다. 곡선을 줄이거나 Half Height를 낮추세요. 자동으로 해상도를 낮추지 않습니다.');
    const curve=new Float64Array(columns*3);let segment=0;
    for(let c=0;c<columns;c++){
      const s=c*spacing;
      while(segment<line.length-2&&cumulative[segment+1]<s)segment++;
      const span=cumulative[segment+1]-cumulative[segment],f=span>0?Math.min(1,Math.max(0,(s-cumulative[segment])/span)):0;
      for(let k=0;k<3;k++)curve[c*3+k]=line[segment][k]+(line[segment+1][k]-line[segment][k])*f;
    }
    return {columns,rows,half,length,spacing,curve,normal:spec.plane.normal.slice()};
  }
  function segmentDistance(p,a,b){
    const ab=sub(b,a),length=dot(ab,ab);if(length===0)return distance(p,a);
    const t=Math.min(1,Math.max(0,dot(sub(p,a),ab)/length));return distance(p,[a[0]+ab[0]*t,a[1]+ab[1]*t,a[2]+ab[2]*t]);
  }
  // Ramer-Douglas-Peucker at 0.2 mm on the rounded stroke; the first maximum wins a tie, so the
  // same stroke always stores the same points.
  function simplify(raw){
    const points=[];
    for(const p of raw){if(!vector(p))fail('곡선 점 좌표를 확인할 수 없습니다.');const q=round(p);if(!points.length||distance(q,points[points.length-1])>=MIN_GAP)points.push(q);}
    if(points.length<3)return points;
    const keep=new Uint8Array(points.length),stack=[[0,points.length-1]];keep[0]=keep[points.length-1]=1;
    while(stack.length){
      const [a,b]=stack.pop();let best=-1,index=-1;
      for(let i=a+1;i<b;i++){const d=segmentDistance(points[i],points[a],points[b]);if(d>best){best=d;index=i;}}
      if(best>SIMPLIFY){keep[index]=1;stack.push([a,index],[index,b]);}
    }
    return points.filter((_,i)=>keep[i]);
  }
  // world = origin + i*axis0*spacing0 + j*axis1*spacing1 + k*axis2*spacing2, inverted exactly
  // (oblique and descending bases included).
  function affine({origin,direction,spacing}){
    if(!vector(origin)||!Array.isArray(direction)||direction.length!==9||!direction.every(finite)||!Array.isArray(spacing)||spacing.length!==3||!spacing.every(n=>finite(n)&&n>0))fail('원본 볼륨 좌표를 확인할 수 없습니다.');
    const axes=[0,1,2].map(a=>[0,1,2].map(k=>direction[a*3+k]*spacing[a]));
    const c12=cross(axes[1],axes[2]),c20=cross(axes[2],axes[0]),c01=cross(axes[0],axes[1]),det=dot(axes[0],c12);
    if(!finite(det)||Math.abs(det)<1e-12)fail('원본 볼륨 좌표를 확인할 수 없습니다.');
    return p=>{const d=sub(p,origin);return [dot(d,c12)/det,dot(d,c20)/det,dot(d,c01)/det];};
  }
  function inside(point,geometry){
    if(!vector(point))return false;
    const index=affine(geometry)(point);
    return index.every((n,i)=>finite(n)&&n>=-.5-EDGE&&n<=geometry.dimensions[i]-.5+EDGE);
  }
  function sampler({scalars,dimensions,worldToIndex}){
    if(!Array.isArray(dimensions)||dimensions.length!==3||!dimensions.every(n=>Number.isInteger(n)&&n>=2))fail('원본 볼륨 크기를 확인할 수 없습니다.');
    const [dx,dy,dz]=dimensions,plane=dx*dy;
    if(dx*dy*dz>LIMITS.voxels)fail('원본 볼륨이 곡면 MPR 계산 한도를 넘습니다.');
    if(!scalars||typeof scalars.length!=='number'||scalars.length!==dx*dy*dz)fail('원본 화소 배열 길이가 볼륨 크기와 달라 곡면 MPR을 계산하지 않았습니다.');
    // Inside [-0.5, d-0.5] a coordinate is clamped to the edge voxel centres; beyond it is outside.
    const axis=(c,d)=>{if(!(c>=-.5-EDGE&&c<=d-.5+EDGE))return null;const x=Math.min(Math.max(c,0),d-1);let i=Math.floor(x);if(i>d-2)i=d-2;return [i,x-i];};
    return point=>{
      const [ci,cj,ck]=worldToIndex(point),a=axis(ci,dx),b=axis(cj,dy),c=axis(ck,dz);
      if(!a||!b||!c)return NaN;
      const [i,fi]=a,[j,fj]=b,[k,fk]=c,base=i+j*dx+k*plane;
      const v000=scalars[base],v100=scalars[base+1],v010=scalars[base+dx],v110=scalars[base+dx+1];
      const v001=scalars[base+plane],v101=scalars[base+plane+1],v011=scalars[base+plane+dx],v111=scalars[base+plane+dx+1];
      const value=((v000*(1-fi)+v100*fi)*(1-fj)+(v010*(1-fi)+v110*fi)*fj)*(1-fk)+((v001*(1-fi)+v101*fi)*(1-fj)+(v011*(1-fi)+v111*fi)*fj)*fk;
      if(!Number.isFinite(value))fail('원본 화소 값을 확인할 수 없어 곡면 MPR을 계산하지 않았습니다.');
      return value;
    };
  }
  // Yields between row chunks so the caller can drop a superseded request; returns the result.
  function* reconstruct(spec,source,{spacing}={}){
    const grid=plan(spec,spacing||spec.output.spacing),sample=sampler(source),n=grid.normal;
    const values=new Float64Array(grid.columns*grid.rows),rowsPerChunk=Math.max(1,Math.floor(LIMITS.chunk/grid.columns));
    let outside=0;
    for(let r=0;r<grid.rows;r++){
      const offset=(grid.half-r)*grid.spacing;
      for(let c=0;c<grid.columns;c++){
        const b=c*3,value=sample([grid.curve[b]+n[0]*offset,grid.curve[b+1]+n[1]*offset,grid.curve[b+2]+n[2]*offset]);
        if(Number.isNaN(value))outside++;values[r*grid.columns+c]=value;
      }
      if((r+1)%rowsPerChunk===0&&r+1<grid.rows)yield r+1;
    }
    return {columns:grid.columns,rows:grid.rows,half:grid.half,length:grid.length,spacing:grid.spacing,values,outside};
  }
  function run(spec,source,options){const it=reconstruct(spec,source,options);for(;;){const step=it.next();if(step.done)return step.value;}}
  function raster(result,display){
    const {lower,upper}=display.voiRange,out=new Uint8ClampedArray(result.values.length*4);
    for(let i=0;i<result.values.length;i++){
      const v=result.values[i],o=i*4;out[o+3]=255;
      if(Number.isNaN(v)){out[o]=OUTSIDE[0];out[o+1]=OUTSIDE[1];out[o+2]=OUTSIDE[2];continue;}
      let g=Math.round(255*Math.min(1,Math.max(0,(v-lower)/(upper-lower))));if(display.invert)g=255-g;
      out[o]=out[o+1]=out[o+2]=g;
    }
    return out;
  }
  function planeState(camera,plane){
    const normal=unit(camera.viewPlaneNormal);
    return {offset:dot(sub(camera.focalPoint,plane.origin),plane.normal),aligned:Math.abs(dot(normal,plane.normal))>=1-1e-6};
  }
  return {ALGORITHM,LIMITS,INTERPOLATION,OUTSIDE,round,unit,build,check,normalize,polyline,plan,simplify,affine,inside,sampler,reconstruct,run,raster,planeState};
});
