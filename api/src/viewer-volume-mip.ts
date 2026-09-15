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

/* A11-ORIENT-1: the six anatomical presets of the manual's Orientation Preset bar are a second algorithm, kin-mip-2, carried by
   the new snapshot versions 14 and 15 (worklist-v0/hpacs-lite/volume-mip-job.js). The projection semantics are identical; only
   the direction enum differs. Each version names exactly one algorithm and each algorithm exactly one enum, so kin-mip-2 inside
   a version 12/13 body and kin-mip-1 inside a version 14/15 body are both refused here, and versions 12/13 keep accepting
   exactly what they accepted before. */
const MIP_ALGORITHMS:Record<string,string[]>={'kin-mip-1':['Axial','Coronal','Sagittal'],'kin-mip-2':['Anterior','Posterior','Left','Right','Superior','Inferior']};
const MIP_VERSIONS:Record<number,string>={12:'kin-mip-1',13:'kin-mip-1',14:'kin-mip-2',15:'kin-mip-2'};
export const mipAlgorithm=(version:number)=>Object.prototype.hasOwnProperty.call(MIP_VERSIONS,version)?MIP_VERSIONS[version]:invalid();

function validateBlock(m:any,algorithm:string){
  const orientations=Object.prototype.hasOwnProperty.call(MIP_ALGORITHMS,algorithm)?MIP_ALGORITHMS[algorithm]:invalid();
  keys(m,['schema','algorithm','coordinates','frameOfReference','mode','orientation','display','voiSlab']);
  if(m.schema!==1||m.algorithm!==algorithm||m.coordinates!=='LPS_mm'||!['MIP','MinIP','Raysum'].includes(m.mode)||!orientations.includes(m.orientation))invalid();
  if(typeof m.frameOfReference!=='string'||m.frameOfReference.length>64||!/^[0-9]+(\.[0-9]+)*$/.test(m.frameOfReference))invalid();
  const d=m.display;keys(d,['voiRange','interpolationType']);keys(d.voiRange,['lower','upper']);
  if(![0,1,2].includes(d.interpolationType)||![d.voiRange.lower,d.voiRange.upper].every((n:any)=>finite(n)&&Math.abs(n)<=1e9)||d.voiRange.upper<=d.voiRange.lower)invalid();
  const s=m.voiSlab;if(s===null)return;
  keys(s,['center','normal','pivot','thickness']);
  if(!vector(s.center)||!vector(s.normal)||!vector(s.pivot)||!finite(s.thickness)||!(s.thickness>0)||s.thickness>LIMIT)invalid();
  // The viewer accepts a normal within 1e-6 of unit length and stores the confirmed record's numbers unchanged.
  if(!(Math.abs(Math.hypot(s.normal[0],s.normal[1],s.normal[2])-1)<=1e-6))invalid();
}

/** The accepted version 12/13 display: exactly kin-mip-1, byte for byte what it accepted before. */
export function validateVolumeMip(m:any){validateBlock(m,'kin-mip-1');}
/** The version 14/15 display: exactly kin-mip-2, the same rules with the six anatomical directions. */
export function validateVolumeMipDirection(m:any){validateBlock(m,'kin-mip-2');}

// Server half of kin-mip-batch-1 (worklist-v0/hpacs-lite/volume-mip-batch.js): the rotation series conditions a MIP Viewer Batch
// preview was generated with, saved beside its kin-mip-1 display. Frames are never stored, and the raster size, camera distance
// and parallel scale follow from the algorithm and the display, so exactly these keys exist. Another schema or algorithm is refused.
export function validateVolumeMipBatch(b:any){
  keys(b,['schema','algorithm','axis','interval','count','reverse']);
  if(b.schema!==1||b.algorithm!=='kin-mip-batch-1'||!['Horizontal','Vertical'].includes(b.axis)||typeof b.reverse!=='boolean')invalid();
  if(!finite(b.interval)||b.interval<1||b.interval>180||!Number.isInteger(b.count)||b.count<2||b.count>64||(b.count-1)*b.interval>360+1e-9)invalid();
}

/** The display belongs to this original: same frame of reference, and a VOI Slab that keeps at least one voxel centre.
 *  `algorithm` is the one the snapshot version names (mipAlgorithm), so a stored row is re-verified under its own binding. */
export function verifyVolumeMip(m:any,algorithm:string,frameOfReference:string,origin:number[],x:number[],y:number[],z:number[],dimensions:number[]){
  validateBlock(m,algorithm);
  if(m.frameOfReference!==frameOfReference)invalid();
  const s=m.voiSlab;if(s===null)return;
  // Signed distances of the eight voxel-centre corners along the slab normal: a slab wholly beyond either side
  // would project only background, which the viewer refuses to save or restore on the same 1e-6 rule.
  const half=s.thickness/2,distances:number[]=[];
  for(const i of [0,dimensions[0]-1])for(const j of [0,dimensions[1]-1])for(const k of [0,dimensions[2]-1])
    distances.push(dot([0,1,2].map(n=>origin[n]+x[n]*i+y[n]*j+z[n]*k-s.center[n]),s.normal));
  if(!distances.every(Number.isFinite)||Math.min(...distances)>half+1e-6||Math.max(...distances)<-half-1e-6)invalid();
}
