import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { KeycloakService, KeycloakUser } from './keycloak.service';
import type { Caller } from './pacs.service';
const uuid=(v:any)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const conflict=()=>new ConflictException('배정이 바뀌었습니다. 최신 배정을 확인하고 다시 시도하세요');
@Injectable()
export class ReaderAssignmentService {
  constructor(private prisma:PrismaService,private keycloak:KeycloakService){}
  private member(c:Caller){if(c.kind!=='member'||!c.roles.some(r=>['admin','technician','radiologist'].includes(r))||![c.institution,c.sub,c.actor].every(x=>typeof x==='string'&&x.length>0&&x.length<=256))throw new ForbiddenException('소속 기관 업무 사용자 전용입니다');}
  private manager(c:Caller){return c.roles.some(r=>['admin','technician'].includes(r));}
  private eligible(u:KeycloakUser|null,c:Caller){return !!u&&u.enabled&&!u.serviceAccountClientId&&u.groups.length===1&&u.groups[0]===c.institution&&u.roles.includes('radiologist')&&(u.email||u.username).length<=256;}
  private publicReader(u:KeycloakUser){return {sub:u.id,actor:u.email||u.username,name:([u.lastName,u.firstName].filter(Boolean).join(' ')||u.username).slice(0,256)};}
  async candidates(c:Caller){this.member(c);return {owner:[c.institution,c.sub],canManage:this.manager(c),readers:(await this.keycloak.assignmentReaders(c.institution!)).filter(u=>this.eligible(u,c)&&(this.manager(c)||u.id===c.sub)).map(u=>this.publicReader(u))};}
  private async run<T>(fn:(tx:any)=>Promise<T>):Promise<T>{try{return await this.prisma.$transaction(async tx=>{await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;return fn(tx);},{maxWait:4000,timeout:8000});}catch(e:any){if(['P2028','P2034'].includes(e?.code)||e?.code==='P2010'&&['55P03','57014','40P01'].includes(e?.meta?.code))throw new ServiceUnavailableException('배정 처리 중입니다. 같은 요청으로 다시 시도하세요');throw e;}}
  private async study(tx:any,uid:string,c:Caller,lock=false){
    if(typeof uid!=='string'||uid.length>64||!/^\d+(?:\.\d+)+$/.test(uid))throw new BadRequestException('검사 UID를 확인하세요');
    const rows=lock?await tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid=${uid} FOR UPDATE`:await tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid=${uid}`;
    const s=rows[0];if(!s||s.institutionId!==c.institution)throw new NotFoundException('검사를 찾을 수 없습니다');return s;
  }
  private blocked(s:any){return !['W','H'].includes(s.rs)?'대기·보류 상태의 검사만 배정을 바꿀 수 있습니다.':s.holder&&s.heldAt&&Date.now()-new Date(s.heldAt).getTime()<300000?'판독 중인 검사입니다. 작성자가 점유를 해제한 뒤 다시 확인하세요.':'';}
  private async result(tx:any,s:any,c:Caller){
    const row=await tx.readerAssignment.findUnique({where:{studyUid:s.uid}});if(row&&row.institutionId!==c.institution)throw conflict();
    const history=await tx.auditLog.findMany({where:{target:s.uid,action:'reader.assignment'},orderBy:{at:'desc'},take:20});
    return {owner:[c.institution,c.sub],studyUid:s.uid,revision:row?.revision??0,reader:row?.readerSub?{sub:row.readerSub,actor:row.readerActor,name:row.readerName}:null,canManage:this.manager(c),blocked:this.blocked(s),history:history.map((h:any)=>({at:h.at,actor:h.actor,detail:JSON.parse(h.detail)}))};
  }
  async read(uid:string,c:Caller){this.member(c);return this.run(async tx=>this.result(tx,await this.study(tx,uid,c),c));}
  async write(uid:string,c:Caller,b:any){
    this.member(c);
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join()!=='expectedOwner,readerSub,requestId,revision'||!Number.isInteger(b.revision)||b.revision<0||b.revision>=2147483647||!uuid(b.requestId)||(b.readerSub!==null&&!uuid(b.readerSub)))throw new BadRequestException('배정 요청 형식을 확인하세요');
    if(JSON.stringify(b.expectedOwner)!==JSON.stringify([c.institution,c.sub]))throw conflict();
    await this.study(this.prisma,uid,c);
    const readerSub=b.readerSub?.toLowerCase()??null,requestId=b.requestId.toLowerCase();
    const fingerprint=createHash('sha256').update(JSON.stringify({subject:c.sub,institution:c.institution,uid,readerSub,revision:b.revision})).digest('hex');
    const previous=await this.prisma.readerAssignment.findUnique({where:{studyUid:uid}});
    const replay=previous?.lastRequest===requestId&&previous?.lastFingerprint===fingerprint;
    const user=readerSub&&!replay?await this.keycloak.getUser(readerSub):null;
    if(readerSub&&!replay&&!this.eligible(user,c))throw new BadRequestException('현재 같은 기관의 활성 판독의를 선택하세요');
    return this.run(async tx=>{
      const s=await this.study(tx,uid,c,true),row=await tx.readerAssignment.findUnique({where:{studyUid:uid}});
      if(row&&row.institutionId!==c.institution)throw conflict();
      if(row?.lastRequest===requestId){if(row.lastFingerprint!==fingerprint)throw conflict();return this.result(tx,s,c);}
      if((row?.revision??0)!==b.revision)throw conflict();
      if(!this.manager(c)&&((row?.readerSub&&row.readerSub!==c.sub)||(readerSub&&readerSub!==c.sub)))throw new ForbiddenException('판독의는 미배정 검사를 본인에게 배정하거나 본인 배정만 해제할 수 있습니다');
      const blocked=this.blocked(s);if(blocked)throw new ConflictException(blocked);
      const reader=user?this.publicReader(user):null;
      const data={institutionId:c.institution!,revision:(row?.revision??0)+1,readerSub:reader?.sub??null,readerActor:reader?.actor??null,readerName:reader?.name??null,changedBy:c.actor,lastRequest:requestId,lastFingerprint:fingerprint};
      await tx.readerAssignment.upsert({where:{studyUid:uid},create:{studyUid:uid,...data},update:data});
      await tx.auditLog.create({data:{actor:c.actor,action:'reader.assignment',target:uid,detail:JSON.stringify({institution:c.institution,revision:data.revision,from:row?.readerActor??null,to:data.readerActor})}});
      return this.result(tx,s,c);
    });
  }
}
