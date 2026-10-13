import { businessResponse } from './emr-clinical/response';
import { StudyAccessService } from './study-access.service';
import { Injectable, BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { KeycloakService, KeycloakUser } from './keycloak.service';
import type { Caller } from './pacs.service';
import type { ClinicalWritePlan } from './emr-clinical/records';
import type { SurfaceKey } from './emr-clinical/contract';
import { ClinicalServed, ClinicalWriteResult, ProjectionRefused, clinicalEchoRefusal, clinicalHttpError, clinicalRefusal, clinicalText, outcomeCode,
  projectedCaller, readClinicalRows, readClinicalUnits, registerClinicalProjection, requireClinicalRuntime } from './emr-clinical/services';

const uuid = (value:any) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const iso = (value:any) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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
 * 덮어쓰기 전 원문(reason·reply·cancelReason)은 판에 남는다. 사유·답변을 싣는 모든 응답(한 건 읽기, 목록, 쓰기의 응답)은
 * 그 판들의 열람 사건이 원장에 내구 기록된 뒤에만 서명 판의 글로 응답한다.
 */
/** The service's own wording for each refusal of the clinical commit (D codes and its own projection codes). */
const OWN: Readonly<Record<string, () => HttpException>> = Object.freeze({
  StaleRevision: conflict, StateTransitionRefused: conflict, ProjectionConflict: conflict, UnitExists: conflict, OwnerChanged: conflict,
  RequestIdReused: conflict, CONSULTATION_ACTIVE_EXISTS: activeExists, NotFound: missing, ProjectionNotFound: missing,
  ActorPathRefused: forbidden, ProjectionForbidden: forbidden, ProjectionMismatch: conflict,
});
/** What the commit transaction needs besides the plan; kept with the original for recovery (no secret, no token). */
type ConsultationProjection = { caller: Caller; mark: string; recipient: { sub: string; actor: string; name: string } | null; action: string | null };

@Injectable()
export class ConsultationService {
  constructor(private prisma:PrismaService, private keycloak:KeycloakService, private studyAccess:StudyAccessService) {
    registerClinicalProjection('consultation', (tx, plan, projection, caller) => this.project(tx, plan, projection as ConsultationProjection, caller), { db: prisma, access: studyAccess });
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
  async candidates(c:Caller,request?:unknown) {
    this.member(c);
    return businessResponse(request,'GET consultation-candidates',{type:'candidates',owner:[c.institution,c.sub],readers:(await this.keycloak.assignmentReaders(c.institution!))
      .filter(u=>this.eligible(u,c)).map(u=>({sub:u.id,actor:u.email||u.username,
        name:([u.lastName,u.firstName].filter(Boolean).join(' ')||u.username).slice(0,256)}))});
  }
  /** `echo`: the answer of a committed write - a ledger that cannot make its provision durable leaves the result pending. */
  private async run<T>(c:Caller,fn:(tx:any)=>Promise<T>,read=false,echo=false):Promise<T> {
    try { return await this.prisma.$transaction(async tx=>{
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; await this.studyAccess.snapshot(c,tx); return fn(tx);
    },read?{isolationLevel:'RepeatableRead',maxWait:4000,timeout:8000}:{maxWait:4000,timeout:8000}); }
    catch(e:any) {
      if (e?.code==='P2002') throw conflict();
      if (['P2028','P2034'].includes(e?.code) || e?.code==='P2010' && ['55P03','57014','40P01'].includes(e?.meta?.code)) throw busy();
      throw echo ? clinicalEchoRefusal(e, OWN) : clinicalRefusal(e, OWN);
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
  /**
   * One consultation as answered: operational fields from the row; its reason, reply and cancel reason are the signed
   * versions' text, served after their provision is durable (DR2-02/03). A row whose meaning (requester, recipient, state,
   * revision, times, texts) differs from its versions is refused without text; a row without a D unit (written before
   * unit D) is answered without text (null).
   */
  private item(row:any,served:ClinicalServed|null) {
    const {creationFingerprint,lastFingerprint,lastRequest,...item}=row;
    if (!served) return {...item,reason:null,reply:null,cancelReason:null};
    const {unit,bodies}=served, first=bodies[0], last=bodies[bodies.length-1];
    const reply=unit.state==='Completed'?last.text:null, cancelReason=unit.state==='Cancelled'?last.text:null;
    if (first.sequence!==1 || last.sequence!==unit.revision || unit.revision!==row.revision || unit.state!==row.state ||
        first.author.subject!==row.requesterSub || first.text!==row.reason || (row.reply??null)!==reply || (row.cancelReason??null)!==cancelReason ||
        iso(row.createdAt)!==first.at || iso(row.updatedAt)!==last.at) throw conflict();
    return {...item,reason:first.text,reply,cancelReason};
  }
  private provision(row:any,rows:readonly object[]) {
    return {record:'consultation' as const,recordId:row.id,studyId:row.studyUid,scope:'texts' as const,rows,
      parties:{author:row.requesterSub,recipient:row.recipientSub}};
  }
  /**
   * The answer of one write is the consultation as that request left it (DR3-01 for every write answer): its own version's
   * state, revision, time and text (the reply or cancel reason it wrote), the reason of the opening version, and the
   * person whose request it was (kept with its original) - the same at every resend, after any later step. Its fixed facts
   * (requester, recipient, reason, creation) must be the row's, or nothing is answered.
   */
  private answered(row:any,served:ClinicalServed,receipt:{versionId:string;revision:number;state:string},kept:unknown) {
    const {creationFingerprint,lastFingerprint,lastRequest,...item}=row;
    const first=served.bodies.find(b=>b.sequence===1), own=served.bodies.find(b=>b.sequence===receipt.revision);
    const changedBy=(kept as ConsultationProjection|null)?.caller?.actor;
    if (!first || !own || own.versionId!==receipt.versionId || own.state.to!==receipt.state || first.author.subject!==row.requesterSub ||
        first.text!==row.reason || iso(row.createdAt)!==first.at || typeof changedBy!=='string') throw conflict();
    return {...item,reason:first.text,reply:receipt.state==='Completed'?own.text:null,cancelReason:receipt.state==='Cancelled'?own.text:null,
      state:receipt.state,revision:receipt.revision,changedBy,updatedAt:own.at};
  }

  /**
   * The legacy row of one committed consultation version, inside the clinical commit transaction (registered projector).
   * Visibility, the one-active rule and the row's revision/state are checked again under the row locks; the legacy row
   * must be exactly the fold before this version, otherwise the whole commit rolls back.
   */
  private async project(tx:any, plan:Readonly<ClinicalWritePlan>, p:ConsultationProjection,trusted?:Caller) {
    const c:Caller=projectedCaller(p.caller, trusted), v=plan.version, at=new Date(v.at), studyId=clinicalText(v.studyId);
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

  private async write(request:unknown,c:Caller,surface:SurfaceKey,studyId:string,recordId:string,b:any,projection:ConsultationProjection,recipientSubject:string|null,admission?:()=>Promise<ConsultationProjection>) {
    const runtime=requireClinicalRuntime();
    let result:ClinicalWriteResult;
    try {
      result=await runtime.write(request,{surface,studyId,recordId,body:b,recipientSubject,caller:{subject:c.sub,institutionId:c.institution},projection,admission});
    } catch(e) { throw clinicalRefusal(e,OWN); }
    const code=outcomeCode(result.outcome);
    if (code!==null) throw clinicalHttpError(code,OWN);
    // The answer carries the record's text: it is handed back through the same durable provision as a read (DR2-03), as
    // this request's own result (its versions: the opening one and its own).
    const receipt=(result.outcome as {receipt:{versionId:string;revision:number;state:string}}).receipt;
    const route=surface==='consultation.create'?'POST studies/:uid/consultations':'POST consultations/:id';
    await this.studyAccess.prepare(c);
    return this.run(c,async tx=>{
      const row=await tx.studyConsultation.findUnique({where:{id:recordId}});
      if (!row) throw busy();
      this.access(row,c);
      return runtime.respond(request,{view:'consultations',route:route as any,ids:[recordId],receipt:receipt as any},
        {db:this.prisma,tx,caller:c,access:this.studyAccess});
    },true,true);
  }

  /** 한 건 읽기. 사유·답변은 이 의뢰의 판들에 대한 열람 사건이 원장에 내구 기록된 뒤에만, 서명 판의 글로 나간다. */
  async read(id:string,c:Caller,request?:unknown) {
    this.member(c); const runtime=requireClinicalRuntime(); await this.studyAccess.prepare(c);
    if (!uuid(id)) throw missing();
    return this.run(c,async tx=>{
      const row=await tx.studyConsultation.findUnique({where:{id:id.toLowerCase()}});
      this.access(row,c); await this.study(tx,row.studyUid,c);
      return runtime.respond(request,{view:'consultations',route:'GET consultations/:id',ids:[row.id]},
        {db:this.prisma,tx,caller:c,access:this.studyAccess});
    },true);
  }
  /** 목록. 행과 판은 한 RepeatableRead 스냅샷에서 읽고, 사유·답변은 그 판들의 열람 사건이 내구 기록된 뒤에만 나간다(DR2-03). */
  async list(c:Caller,q:any,request?:unknown) {
    this.member(c); const runtime=requireClinicalRuntime();
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
    return this.run(c,async tx=>{
      const rows:any[]=await tx.$queryRaw`SELECT c.* FROM "StudyConsultation" c
        JOIN "StudyState" s ON s.uid=c."studyUid" AND s."institutionId"=c."institutionId"
        WHERE c."institutionId"=${c.institution} AND (NOT ${accessPolicy.policy.restricted} OR c."studyUid"=ANY(${scope}::text[])) AND
          ((${received} AND c."recipientSub"=${c.sub}) OR (NOT ${received} AND c."requesterSub"=${c.sub}))
          AND (c."createdAt",c.id)<((${before}::timestamptz AT TIME ZONE 'UTC'),${beforeId}::uuid)
        ORDER BY c."createdAt" DESC,c.id DESC LIMIT 51`;
      const items=rows.slice(0,50), last=items[items.length-1];
      return runtime.respond(request,{view:'consultations',route:'GET consultations',ids:items.map(row=>row.id),direction:q.direction,
        nextCursor:rows.length>50?Buffer.from(JSON.stringify({at:last.createdAt.toISOString(),id:last.id,r:accessPolicy.revision})).toString('base64url'):null},
        {db:this.prisma,tx,caller:c,access:this.studyAccess});
    },true);
  }
  async create(uid:string,c:Caller,b:any,request?:unknown) {
    this.member(c); requireClinicalRuntime();
    if (!object(b) || Object.keys(b).sort().join()!=='expectedOwner,reason,recipientSub,requestId'
      || !uuid(b.requestId) || !uuid(b.recipientSub) || !text(b.reason)) throw new BadRequestException('수신자와 1~2,000자의 의뢰 사유를 입력하세요');
    if (JSON.stringify(b.expectedOwner)!==JSON.stringify([c.institution,c.sub])) throw conflict();
    const id=b.requestId.toLowerCase(), recipientSub=b.recipientSub;
    const mark=fingerprint({uid,institution:c.institution,subject:c.sub,recipientSub,reason:b.reason});
    await this.study(this.prisma,uid,c);
    const projection:ConsultationProjection={caller:this.callerFacts(c),mark,recipient:null,action:null};
    return this.write(request,c,'consultation.create',uid,id,b,projection,recipientSub,async()=>{
      const user=await this.keycloak.getUser(recipientSub);
      if (!this.eligible(user,c) || user!.id!==recipientSub) throw new BadRequestException('본인을 제외한 같은 기관의 활성 판독의를 선택하세요');
      return {...projection,recipient:{sub:recipientSub,actor:user!.email||user!.username,
        name:([user!.lastName,user!.firstName].filter(Boolean).join(' ')||user!.username).slice(0,256)}};
    });
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
