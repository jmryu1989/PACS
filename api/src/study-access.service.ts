import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { KeycloakService } from './keycloak.service';
import type { Caller } from './pacs.service';
import { StudyAccessPolicy, StudyAccessMetadata, normalizeAccessPolicy, accessPolicyMatches, accessWindowOpen, ruleNeedsMetadata, validAccessUid } from './study-access-policy';

export interface AccessSnapshot { revision:number; policy:StudyAccessPolicy; windowOpen:boolean; needsInstitutionReview:boolean; management?:{reason:string;updatedBy:string|null;updatedAt:Date|null} }
const unrestricted=():StudyAccessPolicy=>({version:1,restricted:false,startsAt:null,endsAt:null,rules:[]});
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const conflict=()=>new ConflictException({code:'STUDY_ACCESS_CHANGED',message:'검사 접근 조건이 변경되었습니다. 다시 불러온 뒤 확인하세요'});

@Injectable()
export class StudyAccessService {
  constructor(private prisma:PrismaService,private orthanc:OrthancService,private keycloak:KeycloakService) {}
  private prepared=new WeakMap<Caller,{all:boolean;metadata:Map<string,StudyAccessMetadata|null>}>();
  private owner(c:Caller) {
    if(c.kind!=='member'||![c.institution,c.sub,c.actor].every(v=>typeof v==='string'&&v.length>0&&v.length<=256))
      throw new ForbiddenException('소속 기관 회원 전용입니다');
    return [c.institution!,c.sub];
  }
  private lockKey(institution:string,subject:string) {return 'study-access:'+JSON.stringify([institution,subject]);}
  async snapshot(c:Caller,tx?:any):Promise<AccessSnapshot> {
    if(tx===this.prisma)tx=undefined;
    const [institution,subject]=this.owner(c);
    try {
      // Shared transaction lock also covers an absent policy row. A concurrent
      // first restriction cannot slip between a write's scope check and commit.
      if(tx)await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtextextended(${this.lockKey(institution,subject)},0))`;
      // Stay on the caller connection. ReadCommitted writes see the committed
      // row after locking; the response interceptor rejects policy changes
      // spanning a RepeatableRead request before releasing its response.
      const rows:any[]=await (tx||this.prisma).$queryRaw`SELECT institution,revision,policy,reason,"updatedBy","updatedAt" FROM "StudyAccessPolicy" WHERE subject=${subject} ORDER BY (institution=${institution}) DESC,institution LIMIT 1`;
      if(!rows.length)return {revision:0,policy:unrestricted(),windowOpen:true,needsInstitutionReview:false};
      // A managed principal changing institutions needs an explicit new-scope
      // decision. Even clearing the old institution policy must not silently
      // grant access at a new institution. Do not copy old conditions or PHI.
      if(rows[0].institution!==institution)return {revision:0,policy:{...unrestricted(),restricted:true},windowOpen:true,needsInstitutionReview:true};
      if(rows.length!==1||!Number.isInteger(rows[0].revision)||rows[0].revision<1)throw Error();
      const policy=normalizeAccessPolicy(rows[0].policy);
      return {revision:rows[0].revision,policy,windowOpen:accessWindowOpen(policy),needsInstitutionReview:false,
        management:{reason:rows[0].reason??'',updatedBy:rows[0].updatedBy??null,updatedAt:rows[0].updatedAt??null}};
    } catch(e) {
      throw new ServiceUnavailableException('검사 접근 조건을 확인하지 못했습니다. 잠시 후 다시 시도하세요');
    }
  }
  async unchanged(c:Caller,previous:AccessSnapshot) {
    const current=await this.snapshot(c);
    if(digest(current)!==digest(previous))throw conflict();
    return current;
  }
  metadata(row:any):StudyAccessMetadata {
    const text=(key:string)=>typeof row?.[key]?.Value?.[0]==='string'?row[key].Value[0]:'';
    const values=row?.['00080061']?.Value;
    return {patientId:text('00100020'),studyDate:text('00080020'),modalities:Array.isArray(values)&&values.every(x=>typeof x==='string')?values.map(x=>x.trim().toUpperCase()):[]};
  }
  needsMetadata(s:AccessSnapshot) {return s.policy.restricted&&s.policy.rules.some(ruleNeedsMetadata);}
  matches(s:AccessSnapshot,uid:string,row?:any) {return !s.policy.restricted||validAccessUid(uid)&&accessPolicyMatches(s.policy,uid,row?this.metadata(row):undefined);}
  async prepare(c:Caller,uids?:string[],policy?:AccessSnapshot) {
    const scope=policy??await this.snapshot(c);
    if(!scope.policy.restricted||!accessWindowOpen(scope.policy)||!this.needsMetadata(scope))return;
    let cache=this.prepared.get(c);if(!cache){cache={all:false,metadata:new Map()};this.prepared.set(c,cache);}
    if(cache.all)return;
    const requested=uids?[...new Set(uids)].filter(uid=>validAccessUid(uid)&&!cache!.metadata.has(uid)):null;
    if(requested&&!requested.length)return;
    try {
      // No transaction is accepted here. Callers prepare source tags before
      // acquiring clinical locks; require(...,tx) only evaluates these tags.
      const rows=requested?.length===1?[await this.orthanc.studyAccessMetadata(requested[0])]:await this.orthanc.studyIdentities(true);
      for(const row of rows){const uid=OrthancService.tag(row,'0020000D');if(validAccessUid(uid))cache.metadata.set(uid,this.metadata(row));}
      if(requested?.length!==1)cache.all=true;
      for(const uid of requested??[])if(!cache.metadata.has(uid))cache.metadata.set(uid,null);
    } catch(e) {throw new ServiceUnavailableException('검사 원본의 접근 조건을 확인하지 못했습니다');}
    await this.unchanged(c,scope);
  }
  async allowed(c:Caller,uids:string[],tx?:any):Promise<Set<string>> {
    if(tx===this.prisma)tx=undefined;
    const unique=[...new Set(uids)];
    const policy=await this.snapshot(c,tx);
    if(!policy.policy.restricted)return new Set(unique);
    if(!accessWindowOpen(policy.policy))return new Set();
    const result=new Set(unique.filter(uid=>this.matches(policy,uid)));
    const remaining=unique.filter(uid=>validAccessUid(uid)&&!result.has(uid));
    if(remaining.length&&this.needsMetadata(policy)) {
      if(!tx)await this.prepare(c,remaining,policy);
      const cache=this.prepared.get(c);
      if(!cache||remaining.some(uid=>!cache.all&&!cache.metadata.has(uid)))throw conflict();
      for(const uid of remaining)if(accessPolicyMatches(policy.policy,uid,cache.metadata.get(uid)??undefined))result.add(uid);
    }
    // Read scopes can spend time at Orthanc; check revision and expiry again.
    const latest=tx?policy:await this.unchanged(c,policy);
    if(!accessWindowOpen(latest.policy))return new Set();
    return result;
  }
  async require(c:Caller,uids:string[],tx?:any) {
    const allowed=await this.allowed(c,uids,tx);
    if(uids.some(uid=>!allowed.has(uid)))throw new NotFoundException('검사를 찾을 수 없습니다');
  }
  async status(c:Caller) {
    const s=await this.snapshot(c);
    return {owner:this.owner(c),revision:s.revision,restricted:s.policy.restricted,
      startsAt:s.policy.startsAt,endsAt:s.policy.endsAt,windowOpen:accessWindowOpen(s.policy),
      denied:s.policy.restricted&&(!accessWindowOpen(s.policy)||!s.policy.rules.length),needsInstitutionReview:s.needsInstitutionReview};
  }
  private async target(c:Caller,subject:string) {
    this.owner(c);
    if(!c.roles.includes('admin'))throw new ForbiddenException('접근 조건 관리는 admin 권한이 필요합니다');
    if(!uuid(subject))throw new BadRequestException('사용자를 확인하세요');
    const user=await this.keycloak.getUser(subject);
    if(!user||user.id!==subject||!user.enabled||user.serviceAccountClientId||user.groups.length!==1||user.groups[0]!==c.institution||!user.roles.some(r=>['admin','radiologist','technician'].includes(r)))
      throw new NotFoundException('같은 기관의 활성 사용자를 찾을 수 없습니다');
    return user;
  }
  async read(subject:string,c:Caller) {
    await this.target(c,subject);
    const effective=await this.snapshot({...c,sub:subject});
    return {owner:this.owner(c),subject,revision:effective.revision,policy:effective.policy,needsInstitutionReview:effective.needsInstitutionReview,
      ...(effective.management??{reason:'',updatedBy:null,updatedAt:null})};
  }
  async write(subject:string,c:Caller,b:any) {
    await this.target(c,subject);
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join()!=='expectedOwner,policy,reason,requestId,revision'||!uuid(b.requestId)||!Number.isInteger(b.revision)||b.revision<0||b.revision>=2147483646||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>2000||/[\x00-\x1f\x7f]/.test(b.reason))
      throw new BadRequestException('접근 조건·기준 버전·변경 사유를 확인하세요');
    if(JSON.stringify(b.expectedOwner)!==JSON.stringify(this.owner(c)))throw conflict();
    let policy:StudyAccessPolicy;try{policy=normalizeAccessPolicy(b.policy);}catch(e){throw new BadRequestException('검사 접근 조건 형식을 확인하세요');}
    const request=b.requestId.toLowerCase(),mark=digest({institution:c.institution,subject,actor:c.sub,revision:b.revision,policy,reason:b.reason});
    return this.prisma.$transaction(async tx=>{
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${this.lockKey(c.institution!,subject)},0))`;
      const duplicate:any[]=await tx.$queryRaw`SELECT revision,fingerprint FROM "StudyAccessRevision" WHERE institution=${c.institution} AND subject=${subject} AND "requestId"=${request}::uuid`;
      if(duplicate.length){if(duplicate[0].fingerprint!==mark)throw new ConflictException({code:'STUDY_ACCESS_REQUEST_REUSED',message:'다른 변경에 사용된 요청 ID입니다. 현재 설정을 확인하세요'});return {owner:this.owner(c),subject,revision:duplicate[0].revision,replayed:true};}
      const rows:any[]=await tx.$queryRaw`SELECT revision FROM "StudyAccessPolicy" WHERE institution=${c.institution} AND subject=${subject} FOR UPDATE`;
      if((rows[0]?.revision??0)!==b.revision)throw conflict();
      const revision=b.revision+1,raw=JSON.stringify(policy);
      await tx.$executeRaw`INSERT INTO "StudyAccessPolicy" (institution,subject,revision,policy,reason,"updatedBy","updatedAt") VALUES (${c.institution},${subject},${revision},${raw}::jsonb,${b.reason},${c.actor},CURRENT_TIMESTAMP AT TIME ZONE 'UTC') ON CONFLICT (institution,subject) DO UPDATE SET revision=EXCLUDED.revision,policy=EXCLUDED.policy,reason=EXCLUDED.reason,"updatedBy"=EXCLUDED."updatedBy","updatedAt"=EXCLUDED."updatedAt"`;
      await tx.$executeRaw`INSERT INTO "StudyAccessRevision" (institution,subject,revision,policy,reason,"authorSub",author,"requestId",fingerprint,at) VALUES (${c.institution},${subject},${revision},${raw}::jsonb,${b.reason},${c.sub},${c.actor},${request}::uuid,${mark},CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`;
      await tx.auditLog.create({data:{actor:c.actor,action:'study.access',target:subject,detail:JSON.stringify({institution:c.institution,subject,revision,restricted:policy.restricted,reason:b.reason,requestId:request})}});
      return {owner:this.owner(c),subject,revision,replayed:false};
    },{maxWait:4000,timeout:8000}).catch(e=>{
      if(['P2024','P2028','P2034'].includes(e?.code)||e?.code==='P2010'&&['55P03','57014','40P01'].includes(e?.meta?.code))throw new ServiceUnavailableException('접근 조건 저장이 지연되었습니다. 같은 요청으로 다시 시도하세요');
      throw e;
    });
  }
}
