export type StudyAccessRule = { all: true } | {
  patientId: string | null; modalities: string[]; dateFrom: string | null; dateTo: string | null; studyUids: string[];
};
export interface StudyAccessPolicy {
  version: 1; restricted: boolean; startsAt: string | null; endsAt: string | null; rules: StudyAccessRule[];
}
export interface StudyAccessMetadata { patientId: string; modalities: string[]; studyDate: string }
const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,any>,expected:string[])=>Object.keys(v).sort().join(',')===[...expected].sort().join(',');
function invalid():never {throw new Error('검사 접근 조건 형식을 확인하세요');}
export const validAccessUid=(v:unknown):v is string=>typeof v==='string'&&v.length<=64&&/^\d+(?:\.\d+)+$/.test(v);
function date(v:unknown):string|null {
  if(v===null)return null;
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||v<'1900-01-01'||v>'2199-12-31')invalid();
  const time=Date.parse(v+'T00:00:00.000Z');
  if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==v)invalid();return v;
}
function instant(v:unknown):string|null {
  if(v===null)return null;
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))invalid();
  const time=Date.parse(v);if(!Number.isFinite(time)||new Date(time).toISOString()!==v)invalid();date(v.slice(0,10));return v;
}
export function normalizeAccessPolicy(v:unknown):StudyAccessPolicy {
  if(!record(v)||!keys(v,['version','restricted','startsAt','endsAt','rules'])||v.version!==1||typeof v.restricted!=='boolean'||!Array.isArray(v.rules)||v.rules.length>10)invalid();
  const startsAt=instant(v.startsAt),endsAt=instant(v.endsAt);
  if(startsAt&&endsAt&&startsAt>=endsAt)invalid();
  let count=0;
  const rules:StudyAccessRule[]=v.rules.map((r:unknown)=>{
    if(!record(r))invalid();
    if(keys(r,['all'])&&r.all===true)return {all:true};
    if(!keys(r,['patientId','modalities','dateFrom','dateTo','studyUids']))invalid();
    if(r.patientId!==null&&(typeof r.patientId!=='string'||!r.patientId.trim()||r.patientId.length>256||/[\x00-\x1f\x7f]/.test(r.patientId)))invalid();
    if(!Array.isArray(r.modalities)||r.modalities.length>32||r.modalities.some((x:unknown)=>typeof x!=='string'||! /^[A-Z0-9_]{1,16}$/.test(x)))invalid();
    if(!Array.isArray(r.studyUids)||r.studyUids.length>1000||r.studyUids.some((x:unknown)=>!validAccessUid(x)))invalid();
    if(new Set(r.modalities).size!==r.modalities.length||new Set(r.studyUids).size!==r.studyUids.length)invalid();
    count+=r.studyUids.length;if(count>1000)invalid();
    const dateFrom=date(r.dateFrom),dateTo=date(r.dateTo);
    if(dateFrom&&dateTo&&dateFrom>dateTo)invalid();
    if(r.patientId===null&&!r.modalities.length&&!dateFrom&&!dateTo&&!r.studyUids.length)invalid();
    return {patientId:r.patientId===null?null:r.patientId.trim(),modalities:[...r.modalities].sort(),dateFrom,dateTo,studyUids:[...r.studyUids].sort()};
  });
  if(!v.restricted&&(rules.length||startsAt||endsAt))invalid();
  if(rules.length>1&&rules.some(r=>'all' in r))invalid();
  if(new Set(rules.map(r=>JSON.stringify(r))).size!==rules.length)invalid();
  return {version:1,restricted:v.restricted,startsAt,endsAt,rules};
}
export function accessWindowOpen(p:StudyAccessPolicy,now=Date.now()):boolean {
  return Number.isFinite(now)&&(!p.startsAt||now>=Date.parse(p.startsAt))&&(!p.endsAt||now<Date.parse(p.endsAt));
}
export function ruleNeedsMetadata(r:StudyAccessRule):boolean {
  return !('all' in r)&&!!(r.patientId!==null||r.modalities.length||r.dateFrom||r.dateTo);
}
export function ruleMatches(r:StudyAccessRule,uid:string,m?:StudyAccessMetadata):boolean {
  if('all' in r)return true;
  if(r.studyUids.length&&!r.studyUids.includes(uid))return false;
  if(!ruleNeedsMetadata(r))return true;
  if(!m)return false;
  if(r.patientId!==null&&r.patientId!==m.patientId)return false;
  if(r.modalities.length&&!r.modalities.some(v=>m.modalities.includes(v)))return false;
  if(r.dateFrom||r.dateTo){
    let value:string|null;try{value=date(m.studyDate.length===8?m.studyDate.slice(0,4)+'-'+m.studyDate.slice(4,6)+'-'+m.studyDate.slice(6):m.studyDate);}catch(_){return false;}
    if(!value||(r.dateFrom&&value<r.dateFrom)||(r.dateTo&&value>r.dateTo))return false;
  }
  return true;
}
export function accessPolicyMatches(p:StudyAccessPolicy,uid:string,m?:StudyAccessMetadata,now=Date.now()):boolean {
  return !p.restricted||(accessWindowOpen(p,now)&&p.rules.some(r=>ruleMatches(r,uid,m)));
}
