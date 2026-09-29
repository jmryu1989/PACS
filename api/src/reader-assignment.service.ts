import { StudyAccessService } from './study-access.service';
import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { KeycloakService, KeycloakUser } from './keycloak.service';
import type { Caller } from './pacs.service';
const uuid=(v:any)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const conflict=()=>new ConflictException('배정이 바뀌었습니다. 최신 배정을 확인하고 다시 시도하세요');
const ACTION='reader.assignment';
// S7-U3a (D-S7-09 a): a row belongs to one institution of one study, the owner's or the tele receiver's.
const key=(studyUid:string,institutionId:string)=>({studyUid_institutionId:{studyUid,institutionId}});

/**
 * S7-U3a (REQ-S7-U3a-CLOSE -> RISK-S7-U3a-ORPHAN-AFTER-CLOSE): runs in the transaction of a write that is about to take
 * the tele channel away (a cancel or a new teleTo, a study delete), before that write. `admits` is the owner and the tele
 * institution the study keeps after it. The StudyState row lock comes first here and the caller's write keeps it to
 * commit; every assignment read and write takes that row too (shared or for update), so none falls between the channel
 * change and this close. The channel that ends is read under the lock, not from the caller's earlier unlocked read.
 *
 * Each close moves the institution whose channel ends to a new revision, whether its row is open, already closed by an
 * earlier channel, or absent (a closed row at revision 1 is then created): a request prepared while one channel was open
 * can only conflict once another opens (S7-U3a-R-001-F02). A still-open row of any other institution the study no longer
 * admits closes the same way; other closed rows and the owner's row are left alone. A row is closed, never deleted: the
 * reader is cleared, the close gets its own request id (no earlier request replays into a reopened channel), and one audit
 * entry per row records it for the institution that lost it.
 */
export async function closeReaderAssignments(tx:any,uid:string,admits:{institutionId:string|null;teleInstitutionId:string|null},actor:string,reason:'tele-closed'|'study-deleted'){
  const [study]=await tx.$queryRaw`SELECT "institutionId", "teleInstitutionId" FROM "StudyState" WHERE uid = ${uid} FOR NO KEY UPDATE`;
  const kept=[study?.institutionId,admits.institutionId,admits.teleInstitutionId].filter((x):x is string=>typeof x==='string');
  const rows=new Map<string,any>((await tx.readerAssignment.findMany({where:{studyUid:uid,closedAt:null,institutionId:{notIn:kept}}})).map((row:any)=>[row.institutionId,row]));
  const ended=study?.teleInstitutionId;
  if(typeof ended==='string'&&!kept.includes(ended)&&!rows.has(ended))rows.set(ended,await tx.readerAssignment.findUnique({where:key(uid,ended)}));
  for(const [institutionId,row] of rows){
    const revision=(row?.revision??0)+1;
    const data={revision,readerSub:null,readerActor:null,readerName:null,changedBy:actor,lastRequest:randomUUID(),
      lastFingerprint:createHash('sha256').update(JSON.stringify({closed:reason,institution:institutionId,uid,revision})).digest('hex'),
      closedRevision:revision,closedAt:new Date()};
    if(row)await tx.readerAssignment.update({where:key(uid,institutionId),data});
    else await tx.readerAssignment.create({data:{studyUid:uid,institutionId,...data}});
    await tx.auditLog.create({data:{actor,action:ACTION,target:uid,detail:JSON.stringify({institution:institutionId,revision,from:row?.readerActor??null,to:null,closed:reason})}});
  }
  return rows.size;
}

@Injectable()
export class ReaderAssignmentService {
  constructor(private prisma:PrismaService,private keycloak:KeycloakService, private studyAccess:StudyAccessService){}
  private member(c:Caller){if(c.kind!=='member'||!c.roles.some(r=>['admin','technician','radiologist'].includes(r))||![c.institution,c.sub,c.actor].every(x=>typeof x==='string'&&x.length>0&&x.length<=256))throw new ForbiddenException('소속 기관 업무 사용자 전용입니다');}
  private manager(c:Caller){return c.roles.some(r=>['admin','technician'].includes(r));}
  private eligible(u:KeycloakUser|null,c:Caller){return !!u&&u.enabled&&!u.serviceAccountClientId&&u.groups.length===1&&u.groups[0]===c.institution&&u.roles.includes('radiologist')&&(u.email||u.username).length<=256;}
  private publicReader(u:KeycloakUser){return {sub:u.id,actor:u.email||u.username,name:([u.lastName,u.firstName].filter(Boolean).join(' ')||u.username).slice(0,256)};}
  async candidates(c:Caller){this.member(c);return {owner:[c.institution,c.sub],canManage:this.manager(c),readers:(await this.keycloak.assignmentReaders(c.institution!)).filter(u=>this.eligible(u,c)&&(this.manager(c)||u.id===c.sub)).map(u=>this.publicReader(u))};}
  private async run<T>(c:Caller,fn:(tx:any)=>Promise<T>):Promise<T>{try{return await this.prisma.$transaction(async tx=>{await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; await this.studyAccess.snapshot(c,tx);return fn(tx);},{maxWait:4000,timeout:8000});}catch(e:any){if(['P2028','P2034'].includes(e?.code)||e?.code==='P2010'&&['55P03','57014','40P01'].includes(e?.meta?.code))throw new ServiceUnavailableException('배정 처리 중입니다. 같은 요청으로 다시 시도하세요');throw e;}}
  private async study(tx:any,uid:string,c:Caller,lock:'share'|'update'|null=null){
    if(typeof uid!=='string'||uid.length>64||!/^\d+(?:\.\d+)+$/.test(uid))throw new BadRequestException('검사 UID를 확인하세요');
    // A read holds the row shared until its transaction ends (S7-U3a-R-001-F01): a channel close, which locks this row
    // first, waits for a read in progress, and a read that waited for a close sees the channel closed. Without it the
    // institution check below and the assignment rows could fall on either side of a close. Unlocked only for write()'s
    // early check outside any transaction.
    const rows=lock==='update'?await tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid=${uid} FOR UPDATE`
      :lock==='share'?await tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid=${uid} FOR SHARE`:await tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid=${uid}`;
    // The owner, and the tele institution while its channel is open (the visible() boundary); anyone else gets the
    // body an unknown UID gets, as gate() answers.
    const s=rows[0];if(!s||s.institutionId!==c.institution&&s.teleInstitutionId!==c.institution)throw new NotFoundException('검사를 찾을 수 없습니다');await this.studyAccess.require(c,[uid],tx);return s;
  }
  private blocked(s:any){return !['W','H'].includes(s.rs)?'대기·보류 상태의 검사만 배정을 바꿀 수 있습니다.':s.holder&&s.heldAt&&Date.now()-new Date(s.heldAt).getTime()<300000?'판독 중인 검사입니다. 작성자가 점유를 해제한 뒤 다시 확인하세요.':'';}
  private async result(tx:any,s:any,c:Caller){
    const row=await tx.readerAssignment.findUnique({where:key(s.uid,c.institution!)});
    // This institution's entries only, and none from a channel that closed (revision up to closedRevision). The CASE
    // reads detail as JSON for this action's rows alone; the limit applies after both conditions.
    const history:any[]=await tx.$queryRaw`SELECT at, actor, detail FROM "AuditLog"
      WHERE target = ${s.uid} AND action = ${ACTION}
        AND CASE WHEN action = ${ACTION} THEN (detail::jsonb ->> 'institution') = ${c.institution}
                 AND (detail::jsonb ->> 'revision')::int > ${row?.closedRevision??0} ELSE FALSE END
      ORDER BY at DESC, id DESC LIMIT 20`;
    return {owner:[c.institution,c.sub],studyUid:s.uid,revision:row?.revision??0,reader:row?.readerSub?{sub:row.readerSub,actor:row.readerActor,name:row.readerName}:null,canManage:this.manager(c),blocked:this.blocked(s),history:history.map((h:any)=>({at:h.at,actor:h.actor,detail:JSON.parse(h.detail)}))};
  }
  async read(uid:string,c:Caller){this.member(c);await this.studyAccess.prepare(c,[uid]);return this.run(c,async tx=>this.result(tx,await this.study(tx,uid,c,'share'),c));}
  async write(uid:string,c:Caller,b:any){
    this.member(c);
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join()!=='expectedOwner,readerSub,requestId,revision'||!Number.isInteger(b.revision)||b.revision<0||b.revision>=2147483647||!uuid(b.requestId)||(b.readerSub!==null&&!uuid(b.readerSub)))throw new BadRequestException('배정 요청 형식을 확인하세요');
    if(JSON.stringify(b.expectedOwner)!==JSON.stringify([c.institution,c.sub]))throw conflict();
    await this.study(this.prisma,uid,c);
    const readerSub=b.readerSub?.toLowerCase()??null,requestId=b.requestId.toLowerCase();
    const fingerprint=createHash('sha256').update(JSON.stringify({subject:c.sub,institution:c.institution,uid,readerSub,revision:b.revision})).digest('hex');
    const previous=await this.prisma.readerAssignment.findUnique({where:key(uid,c.institution!)});
    const replay=previous?.lastRequest===requestId&&previous?.lastFingerprint===fingerprint;
    const user=readerSub&&!replay?await this.keycloak.getUser(readerSub):null;
    if(readerSub&&!replay&&!this.eligible(user,c))throw new BadRequestException('현재 같은 기관의 활성 판독의를 선택하세요');
    return this.run(c,async tx=>{
      const s=await this.study(tx,uid,c,'update'),row=await tx.readerAssignment.findUnique({where:key(uid,c.institution!)});
      if(row?.lastRequest===requestId){if(row.lastFingerprint!==fingerprint)throw conflict();return this.result(tx,s,c);}
      if((row?.revision??0)!==b.revision)throw conflict();
      if(!this.manager(c)&&((row?.readerSub&&row.readerSub!==c.sub)||(readerSub&&readerSub!==c.sub)))throw new ForbiddenException('판독의는 미배정 검사를 본인에게 배정하거나 본인 배정만 해제할 수 있습니다');
      const blocked=this.blocked(s);if(blocked)throw new ConflictException(blocked);
      const reader=user?this.publicReader(user):null;
      // The first write after a reopened channel opens a closed row again; closedRevision stays as its history floor.
      const data={institutionId:c.institution!,revision:(row?.revision??0)+1,readerSub:reader?.sub??null,readerActor:reader?.actor??null,readerName:reader?.name??null,changedBy:c.actor,lastRequest:requestId,lastFingerprint:fingerprint,closedAt:null};
      await tx.readerAssignment.upsert({where:key(uid,c.institution!),create:{studyUid:uid,...data},update:data});
      await tx.auditLog.create({data:{actor:c.actor,action:ACTION,target:uid,detail:JSON.stringify({institution:c.institution,revision:data.revision,from:row?.readerActor??null,to:data.readerActor})}});
      return this.result(tx,s,c);
    });
  }
}
