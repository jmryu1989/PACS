import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { KeycloakService, KeycloakUser } from './keycloak.service';
import type { Caller } from './pacs.service';

const uuid = (value:any) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const object = (value:any) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value:any) => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
const fingerprint = (value:any) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = () => new ConflictException('자문 의뢰가 변경되었습니다. 다시 불러온 뒤 확인하세요');

@Injectable()
export class ConsultationService {
  constructor(private prisma:PrismaService, private keycloak:KeycloakService) {}
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
  private async run<T>(fn:(tx:any)=>Promise<T>):Promise<T> {
    try { return await this.prisma.$transaction(async tx=>{
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; return fn(tx);
    },{maxWait:4000,timeout:8000}); }
    catch(e:any) {
      if (e?.code==='P2002') throw conflict();
      if (['P2028','P2034'].includes(e?.code) || e?.code==='P2010' && ['55P03','57014','40P01'].includes(e?.meta?.code)) {
        throw new ServiceUnavailableException('자문 처리 중입니다. 같은 요청으로 다시 시도하세요');
      }
      throw e;
    }
  }
  private async study(tx:any,uid:string,c:Caller,lock=false) {
    if (typeof uid!=='string' || uid.length>64 || !/^\d+(?:\.\d+)+$/.test(uid)) throw new BadRequestException('검사 UID를 확인하세요');
    const rows = lock ? await tx.$queryRaw`SELECT uid,"institutionId" FROM "StudyState" WHERE uid=${uid} FOR UPDATE`
      : await tx.$queryRaw`SELECT uid,"institutionId" FROM "StudyState" WHERE uid=${uid}`;
    if (!rows[0] || rows[0].institutionId!==c.institution) throw new NotFoundException('검사를 찾을 수 없습니다');
    return rows[0];
  }
  private access(row:any,c:Caller) {
    if (!row || row.institutionId!==c.institution || !c.roles.includes('admin') && row.requesterSub!==c.sub && row.recipientSub!==c.sub) {
      throw new NotFoundException('자문 의뢰를 찾을 수 없습니다');
    }
  }
  private result(row:any,c:Caller) {
    const {creationFingerprint,lastFingerprint,lastRequest,...item}=row;
    return {owner:[c.institution,c.sub],item};
  }
  async read(id:string,c:Caller) {
    this.member(c); if (!uuid(id)) throw new NotFoundException('자문 의뢰를 찾을 수 없습니다');
    return this.run(async tx=>{
      const row=await tx.studyConsultation.findUnique({where:{id:id.toLowerCase()}});
      this.access(row,c); await this.study(tx,row.studyUid,c); return this.result(row,c);
    });
  }
  async list(c:Caller,q:any) {
    this.member(c);
    if (!object(q) || Object.keys(q).some(k=>!['direction','cursor'].includes(k)) || !['received','sent'].includes(q.direction)) {
      throw new BadRequestException('자문 목록 구분을 확인하세요');
    }
    let cursor:any=null;
    if (q.cursor !== undefined) {
      try {
        if (typeof q.cursor!=='string' || q.cursor.length>256 || !/^[A-Za-z0-9_-]+$/.test(q.cursor)) throw Error();
        cursor=JSON.parse(Buffer.from(q.cursor,'base64url').toString('utf8'));
        if (!object(cursor) || Object.keys(cursor).sort().join()!=='at,id' || !uuid(cursor.id)
          || typeof cursor.at!=='string' || new Date(cursor.at).toISOString()!==cursor.at) throw Error();
      } catch (_) { throw new BadRequestException('자문 목록 페이지를 확인하세요'); }
    }
    // Join the current source institution as well as the immutable request institution.
    const received=q.direction==='received', before=cursor?.at??'9999-12-31T00:00:00.000Z';
    const beforeId=cursor?.id??'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const rows:any[]=await this.prisma.$queryRaw`SELECT c.* FROM "StudyConsultation" c
      JOIN "StudyState" s ON s.uid=c."studyUid" AND s."institutionId"=c."institutionId"
      WHERE c."institutionId"=${c.institution} AND
        ((${received} AND c."recipientSub"=${c.sub}) OR (NOT ${received} AND c."requesterSub"=${c.sub}))
        AND (c."createdAt",c.id)<((${before}::timestamptz AT TIME ZONE 'UTC'),${beforeId}::uuid)
      ORDER BY c."createdAt" DESC,c.id DESC LIMIT 51`;
    const items=rows.slice(0,50), last=items[items.length-1];
    return {owner:[c.institution,c.sub],direction:q.direction,items:items.map(row=>this.result(row,c).item),
      nextCursor:rows.length>50?Buffer.from(JSON.stringify({at:last.createdAt.toISOString(),id:last.id})).toString('base64url'):null};
  }
  async create(uid:string,c:Caller,b:any) {
    this.member(c);
    if (!object(b) || Object.keys(b).sort().join()!=='expectedOwner,reason,recipientSub,requestId'
      || !uuid(b.requestId) || !uuid(b.recipientSub) || !text(b.reason)) throw new BadRequestException('수신자와 1~2,000자의 의뢰 사유를 입력하세요');
    if (JSON.stringify(b.expectedOwner)!==JSON.stringify([c.institution,c.sub])) throw conflict();
    const id=b.requestId.toLowerCase(), recipientSub=b.recipientSub;
    const mark=fingerprint({uid,institution:c.institution,subject:c.sub,recipientSub,reason:b.reason});
    await this.study(this.prisma,uid,c);
    const previous=await this.prisma.studyConsultation.findUnique({where:{id}});
    if (previous) {
      this.access(previous,c); if (previous.creationFingerprint!==mark) throw conflict();
      return this.result(previous,c);
    }
    const recipient=await this.keycloak.getUser(recipientSub);
    if (!this.eligible(recipient,c) || recipient!.id!==recipientSub) throw new BadRequestException('본인을 제외한 같은 기관의 활성 판독의를 선택하세요');
    return this.run(async tx=>{
      await this.study(tx,uid,c,true);
      const duplicate=await tx.studyConsultation.findUnique({where:{id}});
      if (duplicate) { this.access(duplicate,c); if(duplicate.creationFingerprint!==mark)throw conflict();return this.result(duplicate,c); }
      if (await tx.studyConsultation.findFirst({where:{studyUid:uid,recipientSub,state:{in:['Requested','Accepted']}}})) {
        throw new ConflictException('이 검사·수신자의 진행 중인 자문 의뢰가 있습니다');
      }
      const row=await tx.studyConsultation.create({data:{id,studyUid:uid,institutionId:c.institution,
        requesterSub:c.sub,requesterActor:c.actor,recipientSub,recipientActor:recipient!.email||recipient!.username,
        recipientName:([recipient!.lastName,recipient!.firstName].filter(Boolean).join(' ')||recipient!.username).slice(0,256),
        reason:b.reason,state:'Requested',revision:1,changedBy:c.actor,creationFingerprint:mark,lastFingerprint:mark,lastRequest:id}});
      await tx.auditLog.create({data:{actor:c.actor,action:'study.consultation',target:uid,
        detail:JSON.stringify({id,institution:c.institution,from:null,to:row.state,recipient:row.recipientActor,revision:1})}});
      return this.result(row,c);
    });
  }
  async change(id:string,c:Caller,b:any) {
    this.member(c);
    if (!uuid(id) || !object(b) || Object.keys(b).sort().join()!=='action,expectedOwner,note,requestId,revision'
      || !uuid(b.requestId) || !Number.isInteger(b.revision) || b.revision<1 || b.revision>=2147483647
      || !['accept','complete','cancel'].includes(b.action) || (b.action==='accept'?b.note!=='':!text(b.note))) {
      throw new BadRequestException('자문 처리 요청과 사유·답변을 확인하세요');
    }
    if (JSON.stringify(b.expectedOwner)!==JSON.stringify([c.institution,c.sub])) throw conflict();
    id=id.toLowerCase(); const requestId=b.requestId.toLowerCase();
    const mark=fingerprint({id,institution:c.institution,subject:c.sub,revision:b.revision,action:b.action,note:b.note});
    return this.run(async tx=>{
      const first=await tx.studyConsultation.findUnique({where:{id}});this.access(first,c);
      await this.study(tx,first.studyUid,c,true);
      const row=await tx.studyConsultation.findUnique({where:{id}});this.access(row,c);
      if (row.lastRequest===requestId) { if(row.lastFingerprint!==mark)throw conflict();return this.result(row,c); }
      if (row.revision!==b.revision) throw conflict();
      const recipient=row.recipientSub===c.sub, sender=row.requesterSub===c.sub || c.roles.includes('admin');
      if (b.action==='cancel'?!sender:!recipient) throw new ForbiddenException('이 자문 처리 권한이 없습니다');
      if (!['Requested','Accepted'].includes(row.state) || b.action==='accept' && row.state!=='Requested') throw conflict();
      const state={accept:'Accepted',complete:'Completed',cancel:'Cancelled'}[b.action] as string;
      const updated=await tx.studyConsultation.update({where:{id},data:{state,revision:row.revision+1,
        ...(b.action==='complete'?{reply:b.note}:b.action==='cancel'?{cancelReason:b.note}:{}),
        changedBy:c.actor,lastRequest:requestId,lastFingerprint:mark}});
      await tx.auditLog.create({data:{actor:c.actor,action:'study.consultation',target:row.studyUid,
        detail:JSON.stringify({id,institution:c.institution,from:row.state,to:state,revision:updated.revision})}});
      return this.result(updated,c);
    });
  }
}
