import { BadRequestException } from '@nestjs/common';

// Server half of kin-path-1 (worklist-v0/hpacs-lite/volume-path.js). The server recomputes what
// bounds and identifies a path - its centre line, arc-length grid, position, transported frame and
// every frame refusal - so a saved path the viewer would refuse is refused here too, and one it
// accepts is accepted with the same numbers. Image values never enter.
const invalid=():never=>{throw new BadRequestException('3D Path의 경로·출력 조건 또는 원본 좌표를 확인할 수 없습니다');};
const keys=(v:any,want:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==want.length||Object.keys(v).some(k=>!want.includes(k)))invalid();};
const finite=(n:any)=>typeof n==='number'&&Number.isFinite(n);
const vector=(v:any)=>Array.isArray(v)&&v.length===3&&v.every((n:any)=>finite(n)&&Math.abs(n)<=1e6);
const dot=(a:number[],b:number[])=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a:number[],b:number[])=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=(v:number[])=>Math.hypot(v[0],v[1],v[2]);
const distance=(a:number[],b:number[])=>norm(sub(a,b));
export const PATH_LIMITS=Object.freeze({points:64,columns:4096,rows:4096,samples:1048576,arc:1000,halfHeight:150});
// The same refusal thresholds as the viewer model; see volume-path.js for why each exists.
const DEGENERATE=1e-3,REVERSAL=-.5,REFLECTION=1,UNIT=1e-6;

/** Arc length, grid and transported frame by the viewer rule; throws 400 on any refusal. */
export function pathPlan(path:any){
  const points:number[][]=path.points,n=points.length,line:number[][]=[],spacing=path.output.spacing;
  const at=(i:number)=>points[Math.max(0,Math.min(n-1,i))];
  for(let i=0;i<n-1;i++){const p0=at(i-1),p1=at(i),p2=at(i+1),p3=at(i+2);
    for(let j=0;j<16;j++){const t=j/16,t2=t*t,t3=t2*t;line.push([0,1,2].map(k=>.5*(2*p1[k]+(-p0[k]+p2[k])*t+(2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*t2+(-p0[k]+3*p1[k]-3*p2[k]+p3[k])*t3)));}}
  line.push(points[n-1]);
  const cumulative=[0];for(let i=1;i<line.length;i++)cumulative.push(cumulative[i-1]+distance(line[i],line[i-1]));
  const length=cumulative[cumulative.length-1];
  if(!(length>=spacing)||length>PATH_LIMITS.arc)invalid();
  const columns=Math.floor(length/spacing+1e-9)+1,rows=2*Math.floor(path.output.halfHeight/spacing+1e-9)+1;
  if(columns>PATH_LIMITS.columns||rows>PATH_LIMITS.rows||columns*rows>PATH_LIMITS.samples)invalid();
  const centres:number[][]=[];let segment=0;
  for(let c=0;c<columns;c++){
    const s=c*spacing;
    while(segment<line.length-2&&cumulative[segment+1]<s)segment++;
    const span=cumulative[segment+1]-cumulative[segment],f=span>0?Math.min(1,Math.max(0,(s-cumulative[segment])/span)):0;
    centres.push([0,1,2].map(k=>line[segment][k]+(line[segment+1][k]-line[segment][k])*f));
  }
  const tangents=centres.map((_,c)=>{const d=sub(centres[Math.min(columns-1,c+1)],centres[Math.max(0,c-1)]),l=norm(d);if(!(l>=DEGENERATE*spacing))invalid();return d.map(x=>x/l);});
  const normal=path.frame.initialNormal,t0=tangents[0];
  if(Math.abs(norm(normal)-1)>UNIT||Math.abs(dot(normal,t0))>UNIT)invalid();
  let r=sub(normal,t0.map(x=>x*dot(normal,t0)));const rn=norm(r);r=r.map(x=>x/rn);
  const normals=[r];
  for(let c=0;c+1<columns;c++){
    const t=tangents[c],t1=tangents[c+1],v1=sub(centres[c+1],centres[c]),l=norm(v1);
    if(!(l>=DEGENERATE*spacing)||!(dot(v1,t)>0&&dot(v1,t1)>0&&dot(t,t1)>=REVERSAL))invalid();
    const c1=l*l,rL=sub(r,v1.map(x=>x*2*dot(v1,r)/c1)),tL=sub(t,v1.map(x=>x*2*dot(v1,t)/c1)),v2=sub(t1,tL),c2=dot(v2,v2);
    if(!(c2>=REFLECTION))invalid();
    const next=sub(rL,v2.map(x=>x*2*dot(v2,rL)/c2));
    if(!next.every(Number.isFinite)||Math.abs(norm(next)-1)>UNIT||Math.abs(dot(next,t1))>UNIT)invalid();
    const p=sub(next,t1.map(x=>x*dot(next,t1))),pn=norm(p);r=p.map(x=>x/pn);
    if(Math.abs(norm(cross(t1,r))-1)>UNIT)invalid();
    normals.push(r);
  }
  return {length,columns,rows,centres,tangents,normals};
}
export function validateVolumePath(p:any){
  keys(p,['schema','algorithm','frameOfReference','coordinates','cell','points','interpolation','frame','unfold','position','output','display']);
  if(p.schema!==1||p.algorithm!=='kin-path-1'||p.coordinates!=='LPS_mm'||p.interpolation!=='catmull-rom-uniform-16'||![0,1,2].includes(p.cell))invalid();
  if(typeof p.frameOfReference!=='string'||p.frameOfReference.length>64||!/^[0-9]+(\.[0-9]+)*$/.test(p.frameOfReference))invalid();
  keys(p.frame,['method','initialNormal']);
  if(p.frame.method!=='double-reflection-rmf'||!vector(p.frame.initialNormal))invalid();
  keys(p.unfold,['angle']);
  const a=p.unfold.angle;
  if(!finite(a)||a<0||a>=360||Math.round(a*100)/100!==a)invalid();
  keys(p.position,['column']);
  if(!Number.isInteger(p.position.column)||p.position.column<0)invalid();
  const o=p.output;keys(o,['spacing','halfHeight','sampling','edge','outside','axis']);
  if(o.sampling!=='trilinear'||o.edge!=='half-voxel-clamp'||o.outside!=='nan'||o.axis!=='arc-length'||!finite(o.spacing)||o.spacing<.05||o.spacing>5||!finite(o.halfHeight)||o.halfHeight<1||o.halfHeight>PATH_LIMITS.halfHeight)invalid();
  const d=p.display;keys(d,['voiRange','VOILUTFunction','invert']);keys(d.voiRange,['lower','upper']);
  if(d.VOILUTFunction!=='LINEAR'||typeof d.invert!=='boolean'||![d.voiRange.lower,d.voiRange.upper].every(n=>finite(n)&&Math.abs(n)<=1e9)||d.voiRange.upper<=d.voiRange.lower)invalid();
  if(!Array.isArray(p.points)||p.points.length<2||p.points.length>PATH_LIMITS.points)invalid();
  p.points.forEach((point:any,i:number)=>{if(!vector(point)||i&&distance(point,p.points[i-1])<.01)invalid();});
  if(p.position.column>=pathPlan(p).columns)invalid();
}
/** The path belongs to this original: same frame of reference, finest voxel spacing, every control point inside the basis. */
export function verifyVolumePath(p:any,frameOfReference:string,origin:number[],x:number[],y:number[],z:number[],dimensions:number[]){
  validateVolumePath(p);
  if(p.frameOfReference!==frameOfReference)invalid();
  const finest=Math.min(Math.hypot(...x),Math.hypot(...y),Math.hypot(...z));
  if(!Number.isFinite(finest)||Math.abs(p.output.spacing-finest)>1e-6)invalid();
  const yz=cross(y,z),zx=cross(z,x),xy=cross(x,y),det=dot(x,yz);
  if(!Number.isFinite(det)||Math.abs(det)<1e-12)invalid();
  for(const point of p.points){
    const delta=sub(point,origin),index=[yz,zx,xy].map(axis=>dot(delta,axis)/det);
    if(index.some((n,i)=>!Number.isFinite(n)||n<-.5-1e-5||n>dimensions[i]-.5+1e-5))invalid();
  }
}
