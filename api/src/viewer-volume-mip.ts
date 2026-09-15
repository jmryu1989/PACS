import { BadRequestException } from '@nestjs/common';

// Server half of kin-mip-1 (worklist-v0/hpacs-lite/volume-mip-job.js). A saved MIP Viewer display names the
// projection semantics the accepted viewer reproduces (MIP/MinIP/counted-sample Raysum over the whole volume,
// VOI Slab as two inward source-LPS planes). Any other schema, algorithm or coordinate system is refused rather
// than reinterpreted, and a VOI Slab is bound to this original's frame of reference and voxel-centre box.
// Image values never enter; no runtime volume id, affine, undo history or Original flag is accepted.
const invalid=():never=>{throw new BadRequestException('MIP Viewer 작업의 표시 조건 또는 원본 좌표를 확인할 수 없습니다');};
const keys=(v:any,want:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==want.length||Object.keys(v).some(k=>!want.includes(k)))invalid();};
const finite=(n:any)=>typeof n==='number'&&Number.isFinite(n);
// The viewer's VOI Slab coordinate and thickness limit (volume-mip.js VOI_LIMIT).
const LIMIT=1e6;
const vector=(v:any)=>Array.isArray(v)&&v.length===3&&v.every((n:any)=>finite(n)&&Math.abs(n)<=LIMIT);
const dot=(a:number[],b:number[])=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

export function validateVolumeMip(m:any){
  keys(m,['schema','algorithm','coordinates','frameOfReference','mode','orientation','display','voiSlab']);
  if(m.schema!==1||m.algorithm!=='kin-mip-1'||m.coordinates!=='LPS_mm'||!['MIP','MinIP','Raysum'].includes(m.mode)||!['Axial','Coronal','Sagittal'].includes(m.orientation))invalid();
  if(typeof m.frameOfReference!=='string'||m.frameOfReference.length>64||!/^[0-9]+(\.[0-9]+)*$/.test(m.frameOfReference))invalid();
  const d=m.display;keys(d,['voiRange','interpolationType']);keys(d.voiRange,['lower','upper']);
  if(![0,1,2].includes(d.interpolationType)||![d.voiRange.lower,d.voiRange.upper].every((n:any)=>finite(n)&&Math.abs(n)<=1e9)||d.voiRange.upper<=d.voiRange.lower)invalid();
  const s=m.voiSlab;if(s===null)return;
  keys(s,['center','normal','pivot','thickness']);
  if(!vector(s.center)||!vector(s.normal)||!vector(s.pivot)||!finite(s.thickness)||!(s.thickness>0)||s.thickness>LIMIT)invalid();
  // The viewer accepts a normal within 1e-6 of unit length and stores the confirmed record's numbers unchanged.
  if(!(Math.abs(Math.hypot(s.normal[0],s.normal[1],s.normal[2])-1)<=1e-6))invalid();
}

/** The display belongs to this original: same frame of reference, and a VOI Slab that keeps at least one voxel centre. */
export function verifyVolumeMip(m:any,frameOfReference:string,origin:number[],x:number[],y:number[],z:number[],dimensions:number[]){
  validateVolumeMip(m);
  if(m.frameOfReference!==frameOfReference)invalid();
  const s=m.voiSlab;if(s===null)return;
  // Signed distances of the eight voxel-centre corners along the slab normal: a slab wholly beyond either side
  // would project only background, which the viewer refuses to save or restore on the same 1e-6 rule.
  const half=s.thickness/2,distances:number[]=[];
  for(const i of [0,dimensions[0]-1])for(const j of [0,dimensions[1]-1])for(const k of [0,dimensions[2]-1])
    distances.push(dot([0,1,2].map(n=>origin[n]+x[n]*i+y[n]*j+z[n]*k-s.center[n]),s.normal));
  if(!distances.every(Number.isFinite)||Math.min(...distances)>half+1e-6||Math.max(...distances)<-half-1e-6)invalid();
}
