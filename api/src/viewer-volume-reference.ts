import { BadRequestException } from '@nestjs/common';
import { canonical } from './viewer-input';
import { createHash } from 'node:crypto';

const invalid = (): never => { throw new BadRequestException('정규 CT 볼륨의 전체 원본과 좌표를 확인할 수 없습니다'); };
const values = (x: any) => Array.isArray(x) ? x.map(Number) : typeof x === 'string' ? x.split('\\').map(Number) : [];
const near = (a: number[], b: number[]) => a.length === b.length && a.every((n, i) => Number.isFinite(n) && Number.isFinite(b[i]) && Math.abs(n-b[i]) < .001);
const dot = (a: number[], b: number[]) => a.reduce((sum,n,i)=>sum+n*b[i],0);
const fields=['StudyInstanceUID','SeriesInstanceUID','SOPInstanceUID','PatientID','SOPClassUID','Modality','NumberOfFrames','SamplesPerPixel','PhotometricInterpretation','FrameOfReferenceUID','Rows','Columns','ImageOrientationPatient','ImagePositionPatient','PixelSpacing','RescaleSlope','RescaleIntercept','BitsAllocated','BitsStored','HighBit','PixelRepresentation','_kinSourceDigest'];
export function compactVolumeTags(tags: any): any {
  const scalar=(v: any)=>v===undefined||typeof v==='number'&&Number.isFinite(v)||typeof v==='string'&&v.length<=256;
  return Object.fromEntries(fields.map(key=>{
    const value=tags?.[key];
    if(Array.isArray(value)?value.length>16||value.some(v=>!scalar(v)):!scalar(value))invalid();
    return [key,value];
  }));
}

/** Ordered, complete original volume identity; no synthetic SOP for a reconstructed plane. */
export function verifyVolumeReference(snapshot: any, tags: any[], patient: string): string {
  const volume = snapshot.volume;
  if (tags.length !== volume.sops.length || tags.length < 2) invalid();
  let origin: number[], step: number[], normal: number[], spacing: number[], identity: string;
  for (let i=0;i<tags.length;i++) {
    const t=tags[i], o=values(t.ImageOrientationPatient), p=values(t.ImagePositionPatient), ps=values(t.PixelSpacing);
    if (t.StudyInstanceUID!==volume.study || t.SeriesInstanceUID!==volume.series || t.SOPInstanceUID!==volume.sops[i] || t.PatientID!==patient ||
        t.SOPClassUID!=='1.2.840.10008.5.1.4.1.1.2' || t.Modality!=='CT' || Number(t.NumberOfFrames??1)!==1 ||
        Number(t.SamplesPerPixel)!==1 || t.PhotometricInterpretation!=='MONOCHROME2' || !t.FrameOfReferenceUID ||
        !Number.isInteger(Number(t.Rows)) || Number(t.Rows)<2 || !Number.isInteger(Number(t.Columns)) || Number(t.Columns)<2 ||
        ps.length!==2 || ps.some(n=>!Number.isFinite(n)||n<=0) || o.length!==6 || p.length!==3 || [...o,...p].some(n=>!Number.isFinite(n)) ||
        !Number.isFinite(Number(t.RescaleSlope)) || Number(t.RescaleSlope)===0 || !Number.isFinite(Number(t.RescaleIntercept)) ||
        !/^[a-f0-9]{32}$/.test(t._kinSourceDigest||'')) invalid();
    const key=canonical([o,ps,Number(t.Rows),Number(t.Columns),t.FrameOfReferenceUID,Number(t.RescaleSlope),Number(t.RescaleIntercept),t.BitsAllocated,t.BitsStored,t.HighBit,t.PixelRepresentation]);
    if (i===0) {
      origin=p;spacing=ps;identity=key;
      const x=o.slice(0,3),y=o.slice(3);normal=[x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0]];
      if (Math.abs(dot(x,x)-1)>1e-4 || Math.abs(dot(y,y)-1)>1e-4 || Math.abs(dot(x,y))>1e-4) invalid();
    } else {
      if (key!==identity) invalid();
      if(i===1){step=p.map((n,j)=>n-origin[j]);const distance=dot(step,normal);
        if(Math.abs(distance)<.001 || !near(step,normal.map(n=>n*distance)))invalid();}
      if(!near(p,origin.map((n,j)=>n+step[j]*i)))invalid();
    }
  }
  const max=Math.min(1000,Math.hypot((Number(tags[0].Columns)-1)*spacing[1],(Number(tags[0].Rows)-1)*spacing[0],Math.hypot(...step)*(tags.length-1)));
  for(const cell of snapshot.cells)if(cell.projection.thickness>max)invalid();
  return createHash('sha256').update(canonical(tags.map(t=>[t.SOPInstanceUID,t._kinSourceDigest]))).digest('hex');
}
