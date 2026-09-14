(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.KinVolumePath=api;})(globalThis,root=>{
  // kin-path-1: a manual 3D path and its unfolded (stretched) reconstruction. The person places
  // every control point on one of the three native planes; the centre line, arc-length columns,
  // transported frame and camera triple below are pure functions of those points, the persisted
  // initial normal and the output spacing. No function except reconstruct/run sees image values.
  const ALGORITHM='kin-path-1',INTERPOLATION='catmull-rom-uniform-16',METHOD='double-reflection-rmf',MIN_GAP=.01,ON_PLANE=.01;
  // Frame refusal thresholds. A regular transport step has |v2|^2 close to 4; it only drops
  // below 1 when a chord or tangent turns by 120 degrees or more, where double reflection is not
  // a rotation-minimizing approximation any more. Refusing there keeps the last valid path.
  const DEGENERATE=1e-3,REVERSAL=-.5,REFLECTION=1,UNIT=1e-6;
  // The curved model owns polyline, affine, inside, sampler and raster; it may load after this file.
  const base=()=>{const m=typeof module==='object'&&module.exports&&typeof require==='function'?require('./volume-curved.js'):root.KinVolumeCurved;if(!m)throw Error('곡면 MPR 기본 도구를 불러오지 못했습니다. 영상 창을 새로고침하세요.');return m;};
  const LIMITS=Object.freeze({points:64,columns:4096,rows:4096,samples:1048576,arc:1000,halfHeight:150,chunk:65536});
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const vector=v=>Array.isArray(v)&&v.length===3&&v.every(n=>finite(n)&&Math.abs(n)<=1e6);
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm=v=>Math.hypot(v[0],v[1],v[2]);
  const distance=(a,b)=>norm(sub(a,b));
  const exact=(v,keys)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys;
  const fail=message=>{throw Error(message);};
  const round=p=>p.map(n=>Math.round(n*1000)/1000+0);
  const at=(array,c)=>[array[c*3],array[c*3+1],array[c*3+2]];
  const FRAME_ERROR='경로가 너무 급하게 꺾이거나 되돌아가 경로 방향을 계산할 수 없습니다. 제어점을 조정하세요.';
  // Degrees are stored in [0,360) at 0.01 resolution so the Job value is exact and canonical.
  function angle(degrees){if(!finite(degrees))fail('Unfold Angle은 숫자로 입력하세요.');const a=Math.round((((degrees%360)+360)%360)*100)/100;return a>=360?0:a+0;}

  function build({frameOfReference,cell,points,initialNormal,angle:degrees,column,spacing,halfHeight,display}){
    return {schema:1,algorithm:ALGORITHM,frameOfReference,coordinates:'LPS_mm',cell,
      points:points.map(p=>p.slice()),interpolation:INTERPOLATION,
      frame:{method:METHOD,initialNormal:initialNormal.slice()},unfold:{angle:degrees},position:{column},
      output:{spacing,halfHeight,sampling:'trilinear',edge:'half-voxel-clamp',outside:'nan',axis:'arc-length'},
      display:{voiRange:{lower:display.voiRange.lower,upper:display.voiRange.upper},VOILUTFunction:display.VOILUTFunction,invert:display.invert}};
  }

  // Arc-length resampling of the uniform Catmull-Rom centre line, byte-identical to kin-cpr-1.
  function resample(points,spacing){
    const line=base().polyline(points,'curved'),cumulative=[0];
    for(let i=1;i<line.length;i++)cumulative.push(cumulative[i-1]+distance(line[i],line[i-1]));
    const length=cumulative[cumulative.length-1];
    if(!(length>=spacing))fail('경로 길이가 출력 간격보다 짧습니다. 점 사이를 더 벌리세요.');
    if(length>LIMITS.arc)fail('경로 길이는 1000 mm 이하여야 합니다.');
    const columns=Math.floor(length/spacing+1e-9)+1;
    if(columns>LIMITS.columns)fail('펼친 결과 크기가 한도를 넘습니다. 경로를 줄이세요. 자동으로 해상도를 낮추지 않습니다.');
    const centres=new Float64Array(columns*3);let segment=0;
    for(let c=0;c<columns;c++){
      const s=c*spacing;
      while(segment<line.length-2&&cumulative[segment+1]<s)segment++;
      const span=cumulative[segment+1]-cumulative[segment],f=span>0?Math.min(1,Math.max(0,(s-cumulative[segment])/span)):0;
      for(let k=0;k<3;k++)centres[c*3+k]=line[segment][k]+(line[segment+1][k]-line[segment][k])*f;
    }
    return {length,columns,centres};
  }
  // Central differences of neighbouring resampled centres, one-sided at the two ends. A difference
  // that is (nearly) zero has no direction; it is refused, never replaced by a carried tangent.
  function tangents(centres,columns,spacing){
    const out=new Float64Array(columns*3);
    for(let c=0;c<columns;c++){
      const d=sub(at(centres,Math.min(columns-1,c+1)),at(centres,Math.max(0,c-1))),n=norm(d);
      if(!(n>=DEGENERATE*spacing))fail(FRAME_ERROR);
      for(let k=0;k<3;k++)out[c*3+k]=d[k]/n;
    }
    return out;
  }
  // The persisted initial normal is kept as given when it is already perpendicular to t0; on an
  // edit it is projected again, and only a projection that collapses falls back to the default
  // rule (the patient axis least aligned with t0, first in L/R, A/P, H/F order on a tie).
  function initialNormal(points,spacing,previous){
    const {columns,centres}=resample(points,spacing),t0=at(tangents(centres,columns,spacing),0);
    if(vector(previous)){const p=sub(previous,t0.map(x=>x*dot(previous,t0))),n=norm(p);if(n>=DEGENERATE)return p.map(x=>x/n);}
    const weights=t0.map(Math.abs),axis=weights.indexOf(Math.min(...weights)),e=[0,0,0];e[axis]=1;
    const p=sub(e,t0.map(x=>x*t0[axis])),n=norm(p);if(!(n>=DEGENERATE))fail(FRAME_ERROR);
    return p.map(x=>x/n);
  }
  // Double-reflection rotation-minimizing frame (Wang et al. 2008) over the resampled centres.
  // Every denominator, reversal and result is checked before it is used; any failure refuses the
  // whole path so a caller keeps its last valid state.
  function frames(centres,columns,spacing,normal){
    const T=tangents(centres,columns,spacing),N=new Float64Array(columns*3),B=new Float64Array(columns*3);
    const t0=at(T,0);
    if(!vector(normal)||Math.abs(norm(normal)-1)>UNIT||Math.abs(dot(normal,t0))>UNIT)fail('경로 기준 방향을 확인할 수 없습니다.');
    let r=sub(normal,t0.map(x=>x*dot(normal,t0)));const rn=norm(r);r=r.map(x=>x/rn);
    const store=(c,t,n)=>{const b=cross(t,n);if(!b.every(Number.isFinite)||Math.abs(norm(b)-1)>UNIT)fail(FRAME_ERROR);for(let k=0;k<3;k++){N[c*3+k]=n[k];B[c*3+k]=b[k];}};
    store(0,t0,r);
    for(let c=0;c+1<columns;c++){
      const t=at(T,c),t1=at(T,c+1),v1=sub(at(centres,c+1),at(centres,c)),length=norm(v1);
      if(!(length>=DEGENERATE*spacing))fail(FRAME_ERROR);
      if(!(dot(v1,t)>0&&dot(v1,t1)>0&&dot(t,t1)>=REVERSAL))fail(FRAME_ERROR);
      const c1=length*length,rL=sub(r,v1.map(x=>x*2*dot(v1,r)/c1)),tL=sub(t,v1.map(x=>x*2*dot(v1,t)/c1));
      const v2=sub(t1,tL),c2=dot(v2,v2);
      if(!(c2>=REFLECTION))fail(FRAME_ERROR);
      const next=sub(rL,v2.map(x=>x*2*dot(v2,rL)/c2));
      if(!next.every(Number.isFinite)||Math.abs(norm(next)-1)>UNIT||Math.abs(dot(next,t1))>UNIT)fail(FRAME_ERROR);
      // Reflections preserve length; this only removes accumulated rounding over many steps.
      const p=sub(next,t1.map(x=>x*dot(next,t1))),pn=norm(p);r=p.map(x=>x/pn);
      store(c+1,t1,r);
    }
    return {tangents:T,normals:N,binormals:B};
  }
  function plan(spec,spacing=spec.output.spacing){
    const {length,columns,centres}=resample(spec.points,spacing),half=Math.floor(spec.output.halfHeight/spacing+1e-9),rows=2*half+1;
    if(rows>LIMITS.rows||columns*rows>LIMITS.samples)fail('펼친 결과 크기가 한도(가로·세로 4096, 전체 1,048,576 표본)를 넘습니다. 경로를 줄이거나 Half Height를 낮추세요. 자동으로 해상도를 낮추지 않습니다.');
    return {columns,rows,half,length,spacing,centres,...frames(centres,columns,spacing,spec.frame.initialNormal)};
  }
  // Throws the reason in Korean; normalize() is the null-returning form of the same rules.
  function check(v,{partial=false}={}){
    if(!exact(v,'algorithm,cell,coordinates,display,frame,frameOfReference,interpolation,output,points,position,schema,unfold'))fail('3D Path 형식을 확인할 수 없습니다.');
    if(v.schema!==1||v.algorithm!==ALGORITHM||v.coordinates!=='LPS_mm'||v.interpolation!==INTERPOLATION)fail('지원하지 않는 3D Path 계산 방식입니다.');
    if(![0,1,2].includes(v.cell))fail('3D Path 표시 기준 평면을 확인할 수 없습니다.');
    if(typeof v.frameOfReference!=='string'||v.frameOfReference.length>64||!/^[0-9]+(\.[0-9]+)*$/.test(v.frameOfReference))fail('원본 좌표계(Frame of Reference)를 확인할 수 없습니다.');
    const f=v.frame;
    if(!exact(f,'initialNormal,method')||f.method!==METHOD||!vector(f.initialNormal)||Math.abs(norm(f.initialNormal)-1)>UNIT)fail('경로 기준 방향을 확인할 수 없습니다.');
    if(!exact(v.unfold,'angle')||!finite(v.unfold.angle)||v.unfold.angle<0||v.unfold.angle>=360||angle(v.unfold.angle)!==v.unfold.angle)fail('Unfold Angle은 0 이상 360 미만(0.01° 단위)이어야 합니다.');
    if(!exact(v.position,'column')||!Number.isInteger(v.position.column)||v.position.column<0)fail('경로 위치를 확인할 수 없습니다.');
    const o=v.output;
    if(!exact(o,'axis,edge,halfHeight,outside,sampling,spacing')||o.sampling!=='trilinear'||o.edge!=='half-voxel-clamp'||o.outside!=='nan'||o.axis!=='arc-length'||!finite(o.spacing)||o.spacing<.05||o.spacing>5||!finite(o.halfHeight)||o.halfHeight<1||o.halfHeight>LIMITS.halfHeight)fail('펼친 표시 출력 조건을 확인할 수 없습니다. Half Height는 1~150 mm입니다.');
    const d=v.display;
    if(!exact(d,'VOILUTFunction,invert,voiRange')||d.VOILUTFunction!=='LINEAR'||typeof d.invert!=='boolean'||!exact(d.voiRange,'lower,upper')||![d.voiRange.lower,d.voiRange.upper].every(n=>finite(n)&&Math.abs(n)<=1e9)||d.voiRange.upper<=d.voiRange.lower)fail('3D Path 펼친 표시는 LINEAR 창 설정만 지원합니다.');
    if(!Array.isArray(v.points)||v.points.length>LIMITS.points)fail('3D Path 제어점은 64개까지 지정할 수 있습니다.');
    if(!partial&&v.points.length<2)fail('경로 점을 두 개 이상 지정하세요.');
    for(let i=0;i<v.points.length;i++){
      if(!vector(v.points[i]))fail('경로 점 좌표를 확인할 수 없습니다.');
      if(i&&distance(v.points[i],v.points[i-1])<MIN_GAP)fail('이웃한 경로 점이 너무 가깝습니다.');
    }
    if(v.points.length<2){if(v.position.column!==0)fail('경로 위치를 확인할 수 없습니다.');return null;}
    const grid=plan(v);
    if(v.position.column>=grid.columns)fail('경로 위치가 경로 길이를 넘습니다.');
    return grid;
  }
  function normalize(v){try{check(v);return build({...v,initialNormal:v.frame.initialNormal,angle:v.unfold.angle,column:v.position.column,spacing:v.output.spacing,halfHeight:v.output.halfHeight});}catch(_){return null;}}

  // Row r of column c samples centre[c] + (half - r) * spacing * D[c], D = cos(a) N + sin(a) B, so
  // row 0 is the +D side and row `half` is the path itself. Yields between row chunks.
  function* reconstruct(spec,source,{spacing}={}){
    const grid=plan(spec,spacing||spec.output.spacing),sample=base().sampler(source),a=spec.unfold.angle*Math.PI/180,ca=Math.cos(a),sa=Math.sin(a);
    const {columns,rows,half,centres,normals:N,binormals:B}=grid,D=new Float64Array(columns*3);
    for(let i=0;i<columns*3;i++)D[i]=ca*N[i]+sa*B[i];
    const values=new Float64Array(columns*rows),rowsPerChunk=Math.max(1,Math.floor(LIMITS.chunk/columns));let outside=0;
    for(let r=0;r<rows;r++){
      const offset=(half-r)*grid.spacing;
      for(let c=0;c<columns;c++){
        const b=c*3,value=sample([centres[b]+D[b]*offset,centres[b+1]+D[b+1]*offset,centres[b+2]+D[b+2]*offset]);
        if(Number.isNaN(value))outside++;values[r*columns+c]=value;
      }
      if((r+1)%rowsPerChunk===0&&r+1<rows)yield r+1;
    }
    return {columns,rows,half,length:grid.length,spacing:grid.spacing,values,outside};
  }
  function run(spec,source,options){const it=reconstruct(spec,source,options);for(;;){const step=it.next();if(step.done)return step.value;}}

  // Go to Path Point: the chosen cell looks along T (viewUp B, right N); the other two cells, in
  // position order, show the planes with normals N and B that contain T (viewUp T). All three
  // focal points are the path point; each keeps its own camera distance and zoom.
  function cameras(grid,column,current,perpendicular){
    if(!Number.isInteger(column)||column<0||column>=grid.columns)fail('경로 위치가 경로 길이를 넘습니다.');
    if(!Array.isArray(current)||current.length!==3||![0,1,2].includes(perpendicular))fail('3평면 화면을 확인할 수 없습니다.');
    const centre=at(grid.centres,column),T=at(grid.tangents,column),N=at(grid.normals,column),B=at(grid.binormals,column);
    const parallel=[[N,T],[B,T]];let next=0;
    return current.map((camera,i)=>{
      if(!camera||!vector(camera.focalPoint)||!vector(camera.position))fail('3평면 화면을 확인할 수 없습니다.');
      const [normal,viewUp]=i===perpendicular?[T,B]:parallel[next++],length=distance(camera.position,camera.focalPoint);
      if(!(length>1e-4))fail('3평면 화면을 확인할 수 없습니다.');
      return {...camera,focalPoint:centre.slice(),position:centre.map((x,k)=>x+normal[k]*length),viewUp:viewUp.slice(),viewPlaneNormal:normal.slice()};
    });
  }
  // Signed distance of a point from a plane camera; a point is editable only on the plane it lies on.
  function offset(point,camera){const n=camera.viewPlaneNormal,l=norm(n);return dot(sub(point,camera.focalPoint),n)/l;}
  const onPlane=(point,camera)=>Math.abs(offset(point,camera))<=ON_PLANE;
  return {ALGORITHM,INTERPOLATION,METHOD,LIMITS,MIN_GAP,ON_PLANE,round,angle,build,resample,tangents,initialNormal,frames,plan,check,normalize,reconstruct,run,cameras,offset,onPlane};
});
