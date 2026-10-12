import { StudyAccessService } from './study-access.service';
import { Injectable, BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { KeycloakService, KeycloakUser } from './keycloak.service';
import type { Caller } from './pacs.service';
import type { ClinicalWritePlan } from './emr-clinical/records';
import type { SurfaceKey } from './emr-clinical/contract';
import { ClinicalWriteResult, ProjectionRefused, clinicalHttpError, clinicalRefusal, clinicalText, outcomeCode, projectedCaller, readClinicalRows,
  registerClinicalProjection, requireClinicalRuntime } from './emr-clinical/services';

const uuid = (value:any) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const object = (value:any) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value:any) => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
const fingerprint = (value:any) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = () => new ConflictException('자문 의뢰가 변경되었습니다. 다시 불러온 뒤 확인하세요');
const missing = () => new NotFoundException('자문 의뢰를 찾을 수 없습니다');
const forbidden = () => new ForbiddenException('이 자문 처리 권한이 없습니다');
const activeExists = () => new ConflictException('이 검사·수신자의 진행 중인 자문 의뢰가 있습니다');
const busy = () => new ServiceUnavailableException('자문 처리 중입니다. 같은 요청으로 다시 시도하세요');

/**
 * EMR-D 2라운드: 의뢰·수락·완료(답변)·취소는 emr_clinical의 추가 전용 판이다. 판독의 본인의 의뢰 사유·답변·취소 사유는
 * 작성자 단말 서명이 있어야 커밋되고, 수락은 서명 없는 상태 변경, 관리자의 취소 사유는 서명 없는 업무 기재다. 수신자는
 * 여는 판에 고정된 사람이며 투영 행(StudyConsultation)으로 바뀌지 않는다. 기존 행은 커밋 트랜잭션 안의 project()만 바꾸고
 * 덮어쓰기 전 원문(reason·reply·cancelReason)은 판에 남는다. 본문을 싣는 한 건 읽기는 열람 사건이 원장에 내구 기록된
 * 뒤에만 응답한다.
 */
/** The service's own wording for each refusal of the clinical commit (D codes and its own projection codes). */
const OWN: Readonly<Record<string, () => HttpException>> = Object.freeze({
  StaleRevision: conflict, StateTransitionRefused: conflict, ProjectionConflict: conflict, UnitExists: conflict, OwnerChanged: conflict,
  RequestIdReused: conflict, CONSULTATION_ACTIVE_EXISTS: activeExists, NotFound: missing, ProjectionNotFound: missing,
  ActorPathRefused: forbidden, ProjectionForbidden: forbidden,
});
/** What the commit transaction needs besides the plan; kept with the original for recovery (no secret, no token). */
type ConsultationProjection = { caller: Caller; mark: string; recipient: { sub: string; actor: string; name: string } | null; action: string | null };

@Injectable()
export class ConsultationService {
  constructor(private prisma:PrismaService, private keycloak:KeycloakService, private studyAccess:StudyAccessService) {
    registerClinicalProjection('consultation', (tx, plan, projection) => this.project(tx, plan, projection as ConsultationProjection));
  }
  private member(c:Caller) {
    if (c.kind !== 'member' || !c.roles.some(r=>['admin','radiologist'].includes(r))
      || ![c.institution,c.sub,c.actor].every(v=>typeof v==='string' && v.length>0 && v.length<=256)) {
      throw new ForbiddenException('소속 기관 판독의·관리자 전용입니다');
    }
  }
  private eligible(u:KeycloakUser|null,c:Caller) {
    return !!u && u.enabled && !u.serviceAccountClientId && u.id !== c.sub && u.groups.length===1
      && u.groups[0]===c.institution && u.roles.includes('radiologist') && (u.email||u.username).length>0 && (u.email||u.username).length<=256;
  }
  async candidates(c:Caller) {
    this.member(c);
    return {owner:[c.institution,c.sub],readers:(await this.keycloak.assignmentReaders(c.institution!))
      .filter(u=>this.eligible(u,c)).map(u=>({sub:u.id,actor:u.email||u.username,
        name:([u.lastName,u.firstName].filter(Boolean).join(' ')||u.username).slice(0,256)}))};
  }
  private async run<T>(c:Caller,fn:(tx:any)=>Promise<T>,read=false):Promise<T> {
    try { return await this.prisma.$transaction(async tx=>{
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; await this.studyAccess.snapshot(c,tx); return fn(tx);
    },read?{isolationLevel:'RepeatableRead',maxWait:4000,timeout:8000}:{maxWait:4000,timeout:8000}); }
    catch(e:any) {
      if (e?.code==='P2002') throw conflict();
      if (['P2028','P2034'].includes(e?.code) || e?.code==='P2010' && ['55P03','57014','40P01'].includes(e?.meta?.code)) throw busy();
      throw clinicalRefusal(e, OWN);
    }
  }
  private async study(tx:any,uid:string,c:Caller,lock=false) {
    if (typeof uid!=='string' || uid.length>64 || !/^\d+(?:\.\d+)+$/.test(uid)) throw new BadRequestException('검사 UID를 확인하세요');
    const rows = lock ? await tx.$queryRaw`SELECT uid,"institutionId" FROM "StudyState" WHERE uid=${uid} FOR UPDATE`
      : await tx.$queryRaw`SELECT uid,"institutionId" FROM "StudyState" WHERE uid=${uid}`;
    if (!rows[0] || rows[0].institutionId!==c.institution) throw new NotFoundException('검사를 찾을 수 없습니다');
    await this.studyAccess.require(c,[uid],tx===this.prisma?undefined:tx); return rows[0];
  }
  private access(row:any,c:Caller) {
    if (!row || row.institutionId!==c.institution || !c.roles.includes('admin') && row.requesterSub!==c.sub && row.recipientSub!==c.sub) {
      throw missing();
    }
  }
  private result(row:any,c:Caller) {
    const {creationFingerprint,lastFingerprint,lastRequest,...item}=row;
    return {owner:[c.institution,c.sub],item};
  }

  /**
   * The legacy row of one committed consultation version, inside the clinical commit transaction (registered projector).
   * Visibility, the one-active rule and the row's revision/state are checked again under the row locks; the legacy row
   * must be exactly the fold before this version, otherwise the whole commit rolls back.
   */
  private async project(tx:any, plan:Readonly<ClinicalWritePlan>, p:ConsultationProjection) {
    const c:Caller=projectedCaller(p.caller), v=plan.version, at=new Date(v.at), studyId=clinicalText(v.studyId);
    await this.studyAccess.snapshot(c,tx);
    if (plan.surface==='consultation.create') {
      // The recipient's display facts were read for this original before admission; a stored row without them is not this original's.
      if (!p.recipient) throw new ProjectionRefused('ProjectionConflict');
      await this.study(tx,studyId,c,true);
      if (await tx.studyConsultation.findFirst({where:{studyUid:v.studyId,recipientSub:p.recipient.sub,state:{in:['Requested','Accepted']}}}))
        throw new ProjectionRefused('CONSULTATION_ACTIVE_EXISTS');
      const row=await tx.studyConsultation.create({data:{id:v.recordId,studyUid:v.studyId,institutionId:c.institution,
        requesterSub:c.sub,requesterActor:c.actor,recipientSub:p.recipient.sub,recipientActor:p.recipient.actor,recipientName:p.recipient.name,
        reason:v.text,state:'Requested',revision:1,changedBy:c.actor,creationFingerprint:p.mark,lastFingerprint:p.mark,lastRequest:plan.requestId,
        createdAt:at,updatedAt:at}});
      await tx.auditLog.create({data:{actor:c.actor,action:'study.consultation',target:v.studyId,
        detail:JSON.stringify({id:v.recordId,institution:c.institution,from:null,to:row.state,recipient:row.recipientActor,revision:1})}});
      return;
    }
    const first=await tx.studyConsultation.findUnique({where:{id:v.recordId}});this.access(first,c);
    await this.study(tx,clinicalText(first.studyUid),c,true);
    const row=await tx.studyConsultation.findUnique({where:{id:v.recordId}});this.access(row,c);
    if (row.revision!==v.sequence-1 || row.state!==v.state.from) throw conflict();
    const state=v.state.to;
    const updated=await tx.studyConsultation.update({where:{id:v.recordId},data:{state,revision:row.revision+1,
      ...(p.action==='complete'?{reply:v.text}:p.action==='cancel'?{cancelReason:v.text}:{}),
      changedBy:c.actor,lastRequest:plan.requestId,lastFingerprint:p.mark,updatedAt:at}});
    await tx.auditLog.create({data:{actor:c.actor,action:'study.consultation',target:row.studyUid,
      detail:JSON.stringify({id:v.recordId,institution:c.institution,from:row.state,to:state,revision:updated.revision})}});
  }

  private async write(request:unknown,c:Caller,surface:SurfaceKey,studyId:string,recordId:string,b:any,projection:ConsultationProjection,recipientSubject:string|null) {
    const runtime=requireClinicalRuntime();
    let result:ClinicalWriteResult;
    try {
      result=await runtime.write(request,{surface,studyId,recordId,body:b,recipientSubject,caller:{subject:c.sub,institutionId:c.institution},projection});
    } catch(e) { throw clinicalRefusal(e,OWN); }
    const code=outcomeCode(result.outcome);
    if (code!==null) throw clinicalHttpError(code,OWN);
    const row=await this.prisma.studyConsultation.findUnique({where:{id:recordId}});
    if (!row) throw busy();
    this.access(row,c); return this.result(row,c);
  }

  /** 한 건 읽기. 사유·답변은 이 의뢰의 판들에 대한 열람 사건이 원장에 내구 기록된 뒤에만 나간다. */
  async read(id:string,c:Caller,request?:unknown) {
    this.member(c); const runtime=requireClinicalRuntime(); await this.studyAccess.prepare(c);
    if (!uuid(id)) throw missing();
    return this.run(c,async tx=>{
      const row=await tx.studyConsultation.findUnique({where:{id:id.toLowerCase()}});
      this.access(row,c); await this.study(tx,row.studyUid,c);
      const rows=await readClinicalRows(tx,row.id);
      return runtime.read(request,{record:'consultation',recordId:row.id,studyId:row.studyUid,scope:'history',rows,
        caller:{subject:c.sub,institutionId:c.institution},send:async(_bodies,unit)=>{
          if (unit.revision!==row.revision || unit.state!==row.state) throw conflict();
          return this.result(row,c);
        }});
    },true);
  }
  async list(c:Caller,q:any) {
    this.member(c);
    if (!object(q) || Object.keys(q).some(k=>!['direction','cursor'].includes(k)) || !['received','sent'].includes(q.direction)) {
      throw new BadRequestException('자문 목록 구분을 확인하세요');
    }
    const accessPolicy=await this.studyAccess.snapshot(c);
    const scope=accessPolicy.policy.restricted?[...await this.studyAccess.allowed(c,(await this.prisma.studyState.findMany({where:{institutionId:c.institution},select:{uid:true}})).map(s=>s.uid))]:[];
    let cursor:any=null;
    if (q.cursor !== undefined) {
      try {
        if (typeof q.cursor!=='string' || q.cursor.length>256 || !/^[A-Za-z0-9_-]+$/.test(q.cursor)) throw Error();
        cursor=JSON.parse(Buffer.from(q.cursor,'base64url').toString('utf8'));
        if (!object(cursor) || Object.keys(cursor).sort().join()!=='at,id,r' || cursor.r!==accessPolicy.revision || !uuid(cursor.id)
          || typeof cursor.at!=='string' || new Date(cursor.at).toISOString()!==cursor.at) throw Error();
      } catch (_) { throw new BadRequestException('자문 목록 페이지를 확인하세요'); }
    }
    // Join the current source institution as well as the immutable request institution.
    const received=q.direction==='received', before=cursor?.at??'9999-12-31T00:00:00.000Z';
    const beforeId=cursor?.id??'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const rows:any[]=await this.prisma.$queryRaw`SELECT c.* FROM "StudyConsultation" c
      JOIN "StudyState" s ON s.uid=c."studyUid" AND s."institutionId"=c."institutionId"
      WHERE c."institutionId"=${c.institution} AND (NOT ${accessPolicy.policy.restricted} OR c."studyUid"=ANY(${scope}::text[])) AND
        ((${received} AND c."recipientSub"=${c.sub}) OR (NOT ${received} AND c."requesterSub"=${c.sub}))
        AND (c."createdAt",c.id)<((${before}::timestamptz AT TIME ZONE 'UTC'),${beforeId}::uuid)
      ORDER BY c."createdAt" DESC,c.id DESC LIMIT 51`;
    const items=rows.slice(0,50), last=items[items.length-1];
    return {owner:[c.institution,c.sub],direction:q.direction,items:items.map(row=>this.result(row,c).item),
      nextCursor:rows.length>50?Buffer.from(JSON.stringify({at:last.createdAt.toISOString(),id:last.id,r:accessPolicy.revision})).toString('base64url'):null};
  }
  async create(uid:string,c:Caller,b:any,request?:unknown) {
    this.member(c); requireClinicalRuntime();
    if (!object(b) || Object.keys(b).sort().join()!=='expectedOwner,reason,recipientSub,requestId'
      || !uuid(b.requestId) || !uuid(b.recipientSub) || !text(b.reason)) throw new BadRequestException('수신자와 1~2,000자의 의뢰 사유를 입력하세요');
    if (JSON.stringify(b.expectedOwner)!==JSON.stringify([c.institution,c.sub])) throw conflict();
    const id=b.requestId.toLowerCase(), recipientSub=b.recipientSub;
    const mark=fingerprint({uid,institution:c.institution,subject:c.sub,recipientSub,reason:b.reason});
    await this.study(this.prisma,uid,c);
    // A stored request ID is answered from its register (replay or refusal) without asking the identity provider again.
    let recipient:ConsultationProjection['recipient']=null;
    if (!await this.prisma.studyConsultation.findUnique({where:{id}})) {
      const user=await this.keycloak.getUser(recipientSub);
      if (!this.eligible(user,c) || user!.id!==recipientSub) throw new BadRequestException('본인을 제외한 같은 기관의 활성 판독의를 선택하세요');
      recipient={sub:recipientSub,actor:user!.email||user!.username,name:([user!.lastName,user!.firstName].filter(Boolean).join(' ')||user!.username).slice(0,256)};
    }
    return this.write(request,c,'consultation.create',uid,id,b,{caller:this.callerFacts(c),mark,recipient,action:null},recipientSub);
  }
  async change(id:string,c:Caller,b:any,request?:unknown) {
    this.member(c); requireClinicalRuntime(); await this.studyAccess.prepare(c);
    if (!uuid(id) || !object(b) || Object.keys(b).sort().join()!=='action,expectedOwner,note,requestId,revision'
      || !uuid(b.requestId) || !Number.isInteger(b.revision) || b.revision<1 || b.revision>=2147483647
      || !['accept','complete','cancel'].includes(b.action) || (b.action==='accept'?b.note!=='':!text(b.note))) {
      throw new BadRequestException('자문 처리 요청과 사유·답변을 확인하세요');
    }
    if (JSON.stringify(b.expectedOwner)!==JSON.stringify([c.institution,c.sub])) throw conflict();
    id=id.toLowerCase();
    const mark=fingerprint({id,institution:c.institution,subject:c.sub,revision:b.revision,action:b.action,note:b.note});
    const row=await this.run(c,async tx=>{
      const first=await tx.studyConsultation.findUnique({where:{id}});this.access(first,c);
      await this.study(tx,first.studyUid,c); return first;
    },true);
    return this.write(request,c,('consultation.'+b.action) as SurfaceKey,row.studyUid,id,b,{caller:this.callerFacts(c),mark,recipient:null,action:b.action},null);
  }
  private callerFacts(c:Caller):Caller { return {kind:c.kind,institution:c.institution,sub:c.sub,actor:c.actor,roles:[...c.roles]}; }
}
