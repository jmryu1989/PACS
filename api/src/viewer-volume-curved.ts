import { BadRequestException } from '@nestjs/common';

// Server half of kin-cpr-1 (worklist-v0/hpacs-lite/volume-curved.js). Only what bounds and
// identifies a curve is recomputed here: its shape, its arc length and output grid, its frame
// of reference and its position inside the verified original voxel basis.
const invalid=():never=>{throw new BadRequestException('곡면 MPR의 곡선·출력 조건 또는 원본 좌표를 확인할 수 없습니다');};
const keys=(v:any,want:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==want.length||Object.keys(v).some(k=>!want.includes(k)))invalid();};
const finite=(n:any)=>typeof n==='number'&&Number.isFinite(n);
const vector=(v:any)=>Array.isArray(v)&&v.length===3&&v.every((n:any)=>finite(n)&&Math.abs(n)<=1e6);
const dot=(a:number[],b:number[])=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a:number[],b:number[])=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const distance=(a:number[],b:number[])=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
export const CURVED_LIMITS=Object.freeze({curved:64,freehand:128,columns:4096,rows:4096,samples:1048576,arc:1000,halfHeight:150});
const INTERPOLATION:Record<string,string>={curved:'catmull-rom-uniform-16',freehand:'linear'};

/** Arc length and output grid by the client rule: Catmull-Rom 16 per segment or linear. */
export function curvedPlan(curve:any){
  const points:number[][]=curve.points,n=points.length,line:number[][]=[];
  if(curve.kind==='freehand')line.push(...points);
  else{
    const at=(i:number)=>points[Math.max(0,Math.min(n-1,i))];
    for(let i=0;i<n-1;i++){const p0=at(i-1),p1=at(i),p2=at(i+1),p3=at(i+2);
      for(let j=0;j<16;j++){const t=j/16,t2=t*t,t3=t2*t;line.push([0,1,2].map(k=>.5*(2*p1[k]+(-p0[k]+p2[k])*t+(2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*t2+(-p0[k]+3*p1[k]-3*p2[k]+p3[k])*t3)));}}
    line.push(points[n-1]);
  }
  let length=0;for(let i=1;i<line.length;i++)length+=distance(line[i],line[i-1]);
  const spacing=curve.output.spacing,columns=Math.floor(length/spacing+1e-9)+1,rows=2*Math.floor(curve.output.halfHeight/spacing+1e-9)+1;
  return {length,columns,rows};
}
export function validateVolumeCurved(c:any){
  keys(c,['schema','algorithm','kind','frameOfReference','coordinates','cell','plane','points','interpolation','output','display']);
  if(c.schema!==1||c.algorithm!=='kin-cpr-1'||c.coordinates!=='LPS_mm'||!['curved','freehand'].includes(c.kind)||c.interpolation!==INTERPOLATION[c.kind]||![0,1,2].includes(c.cell))invalid();
  if(typeof c.frameOfReference!=='string'||c.frameOfReference.length>64||!/^[0-9]+(\.[0-9]+)*$/.test(c.frameOfReference))invalid();
  const p=c.plane;keys(p,['origin','normal','viewUp']);
  if(![p.origin,p.normal,p.viewUp].every(vector)||Math.abs(dot(p.normal,p.normal)-1)>1e-6||Math.abs(dot(p.viewUp,p.viewUp)-1)>1e-6||Math.abs(dot(p.normal,p.viewUp))>1e-6)invalid();
  const o=c.output;keys(o,['spacing','halfHeight','sampling','edge','outside','axis']);
  if(o.sampling!=='trilinear'||o.edge!=='half-voxel-clamp'||o.outside!=='nan'||o.axis!=='arc-length'||!finite(o.spacing)||o.spacing<.05||o.spacing>5||!finite(o.halfHeight)||o.halfHeight<1||o.halfHeight>CURVED_LIMITS.halfHeight)invalid();
  const d=c.display;keys(d,['voiRange','VOILUTFunction','invert']);keys(d.voiRange,['lower','upper']);
  if(d.VOILUTFunction!=='LINEAR'||typeof d.invert!=='boolean'||![d.voiRange.lower,d.voiRange.upper].every(n=>finite(n)&&Math.abs(n)<=1e9)||d.voiRange.upper<=d.voiRange.lower)invalid();
  if(!Array.isArray(c.points)||c.points.length<2||c.points.length>(CURVED_LIMITS as any)[c.kind])invalid();
  c.points.forEach((point:any,i:number)=>{
    if(!vector(point)||Math.abs(dot(sub(point,p.origin),p.normal))>.01||i&&distance(point,c.points[i-1])<.01)invalid();
  });
  const grid=curvedPlan(c);
  if(!(grid.length>=o.spacing)||grid.length>CURVED_LIMITS.arc||grid.columns>CURVED_LIMITS.columns||grid.rows>CURVED_LIMITS.rows||grid.columns*grid.rows>CURVED_LIMITS.samples)invalid();
}
/** The curve belongs to this original: same frame of reference, finest voxel spacing, inside the basis. */
export function verifyVolumeCurved(c:any,frameOfReference:string,origin:number[],x:number[],y:number[],z:number[],dimensions:number[]){
  validateVolumeCurved(c);
  if(c.frameOfReference!==frameOfReference)invalid();
  const finest=Math.min(Math.hypot(...x),Math.hypot(...y),Math.hypot(...z));
  if(!Number.isFinite(finest)||Math.abs(c.output.spacing-finest)>1e-6)invalid();
  const yz=cross(y,z),zx=cross(z,x),xy=cross(x,y),det=dot(x,yz);
  if(!Number.isFinite(det)||Math.abs(det)<1e-12)invalid();
  for(const point of [c.plane.origin,...c.points]){
    const delta=sub(point,origin),index=[yz,zx,xy].map(axis=>dot(delta,axis)/det);
    if(index.some((n,i)=>!Number.isFinite(n)||n<-.5-1e-5||n>dimensions[i]-.5+1e-5))invalid();
  }
}
