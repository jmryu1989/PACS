import { BadRequestException } from '@nestjs/common';
import { viewerUuid } from './viewer-input';

const invalid=():never=>{throw new BadRequestException('수동 MPR 표식의 문구·좌표 또는 원본 범위를 확인할 수 없습니다');};
const keys=(v:any,want:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==want.length||Object.keys(v).some(k=>!want.includes(k)))invalid();};
export function validateVolumeMarks(value:any){
  keys(value,['version','visible','sync','marks']);if(value.version!==1||typeof value.visible!=='boolean'||typeof value.sync!=='boolean'||!Array.isArray(value.marks)||value.marks.length>64)invalid();
  const ids=new Set();
  for(const mark of value.marks){keys(mark,['id','label','point']);viewerUuid(mark.id);if(ids.has(mark.id))invalid();ids.add(mark.id);
    if(typeof mark.label!=='string'||!mark.label.trim()||mark.label.length>160||/[\u0000-\u001f\u007f]/.test(mark.label)||!Array.isArray(mark.point)||mark.point.length!==3||mark.point.some(n=>typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e6))invalid();
  }
}

/** Invert the verified DICOM voxel basis, including descending slice order. */
export function verifyVolumeMarkBounds(value:any,origin:number[],x:number[],y:number[],z:number[],dimensions:number[]){
  validateVolumeMarks(value);
  const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const dot=(a:number[],b:number[])=>a.reduce((sum,n,i)=>sum+n*b[i],0),yz=cross(y,z),zx=cross(z,x),xy=cross(x,y),det=dot(x,yz);
  if(!Number.isFinite(det)||Math.abs(det)<1e-12)invalid();
  for(const mark of value.marks){const delta=mark.point.map((n,i)=>n-origin[i]),index=[yz,zx,xy].map(axis=>dot(delta,axis)/det);
    if(index.some((n,i)=>!Number.isFinite(n)||n<-.5-1e-5||n>dimensions[i]-.5+1e-5))invalid();
  }
}
