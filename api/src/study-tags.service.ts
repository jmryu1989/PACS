import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import type { Caller } from './pacs.service';
type Tag = { id:string; name:string; uids:string[] };
const uuid=(v:any)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const uid=(v:any)=>typeof v==='string'&&v.length<=64&&/^\d+(?:\.\d+)+$/.test(v);
const conflict=()=>new ConflictException('태그 목록이 바뀌었습니다. 최신 목록을 읽고 다시 시도하세요');
@Injectable()
export class StudyTagsService {
  constructor(private prisma:PrismaService) {}
  private member(c:Caller){
    if(c.kind!=='member'||!c.roles.some(r=>['admin','radiologist','technician'].includes(r))||![c.institution,c.sub].every(x=>typeof x==='string'&&x.length>0&&x.length<=256))throw new ForbiddenException('소속 기관이 있는 회원 전용입니다');
  }
  private async run<T>(fn:(tx:any)=>Promise<T>):Promise<T>{
    try{return await this.prisma.$transaction(async tx=>{await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;return fn(tx);},{maxWait:4000,timeout:8000});}
    catch(e:any){if(['P2028','P2034'].includes(e?.code)||e?.code==='P2010'&&['55P03','57014','40P01'].includes(e?.meta?.code))throw new ServiceUnavailableException('태그 처리 중입니다. 같은 요청으로 다시 시도하세요');throw e;}
  }
  private async visible(tx:any,uids:string[],c:Caller,lock=false):Promise<Set<string>>{
    if(!uids.length)return new Set();
    const rows=await tx.$queryRaw(Prisma.sql`SELECT uid FROM "StudyState" WHERE uid IN (${Prisma.join([...new Set(uids)].sort())})
      AND ("institutionId"=${c.institution} OR "teleInstitutionId"=${c.institution})
      AND (rs<>'P' OR "preDoc"=${c.actor} OR "preReviewer"=${c.actor}) ORDER BY uid ${lock?Prisma.sql`FOR SHARE`:Prisma.empty}`);
    return new Set(rows.map((x:any)=>x.uid));
  }
  private async result(tx:any,c:Caller){
    const rows=await tx.studyTagCatalog.findMany({where:{institution:c.institution,ownerSub:{in:[c.sub,'']}}});
    const catalogs=['personal','institution'].map(scope=>{const row=rows.find((r:any)=>r.ownerSub===(scope==='personal'?c.sub:''));return {scope,revision:row?.revision??0,tags:(row?JSON.parse(row.value):[]) as Tag[]};});
    const seen=await this.visible(tx,catalogs.flatMap(x=>x.tags.flatMap(t=>t.uids)),c);
    return {owner:[c.institution,c.sub],canManageInstitution:c.roles.includes('admin'),catalogs:catalogs.map(x=>({...x,tags:x.tags.map(t=>({id:t.id,name:t.name,uids:t.uids.filter(x=>seen.has(x)),unavailable:t.uids.filter(x=>!seen.has(x)).length}))}))};
  }
  async read(c:Caller){this.member(c);return this.run(tx=>this.result(tx,c));}
  async write(c:Caller,b:any){
    this.member(c);const action=b?.action,extras=['create','rename'].includes(action)?['name']:['add','remove'].includes(action)?['uid']:[];
    const fields=['expectedOwner','scope','revision','requestId','tagId','action',...extras].sort();
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join()!==fields.join()||!['personal','institution'].includes(b.scope)||!['create','rename','delete','add','remove'].includes(action)||!uuid(b.requestId)||!uuid(b.tagId)||!Number.isInteger(b.revision)||b.revision<0||b.revision>=2147483647
      ||extras.includes('uid')&&!uid(b.uid)||extras.includes('name')&&(typeof b.name!=='string'||!b.name.trim()||b.name.length>120||/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(b.name)))throw new BadRequestException('태그 요청 형식을 확인하세요');
    if(JSON.stringify(b.expectedOwner)!==JSON.stringify([c.institution,c.sub]))throw conflict();
    if(b.scope==='institution'&&['create','rename','delete'].includes(action)&&!c.roles.includes('admin'))throw new ForbiddenException('기관 태그의 생성·이름 변경·삭제는 관리자 전용입니다');
    const owner={institution:c.institution!,ownerSub:b.scope==='personal'?c.sub:''};
    const command={subject:c.sub,scope:b.scope,action,tagId:b.tagId.toLowerCase(),revision:b.revision,...(extras.includes('name')?{name:b.name.trim()}:{}),...(extras.includes('uid')?{uid:b.uid}:{})};
    const requestId=b.requestId.toLowerCase(),fingerprint=createHash('sha256').update(JSON.stringify(command)).digest('hex');
    return this.run(async tx=>{
      await tx.$executeRaw`INSERT INTO "StudyTagCatalog" (institution,"ownerSub",revision,value,"updatedAt") VALUES (${owner.institution},${owner.ownerSub},0,'[]',NOW()) ON CONFLICT DO NOTHING`;
      const rows=await tx.$queryRaw`SELECT * FROM "StudyTagCatalog" WHERE institution=${owner.institution} AND "ownerSub"=${owner.ownerSub} FOR UPDATE`;
      const row=rows[0];if(!row)throw conflict();
      if(row.lastRequest===requestId){if(row.lastFingerprint!==fingerprint)throw conflict();return this.result(tx,c);}
      if(row.revision!==b.revision)throw conflict();
      const tags:Tag[]=JSON.parse(row.value),tag=tags.find(t=>t.id===command.tagId);
      if(action==='create'){
        if(tag||tags.length>=50||tags.some(t=>t.name===command.name))throw new BadRequestException('태그 중복 또는 최대50개 제한을 확인하세요');
        tags.push({id:command.tagId,name:command.name,uids:[]});
      }else{
        if(!tag)throw new NotFoundException('태그를 찾을 수 없습니다');
        if(action==='rename'){if(tags.some(t=>t.id!==tag.id&&t.name===command.name))throw new BadRequestException('같은 이름의 태그가 있습니다');tag.name=command.name;}
        if(action==='delete')tags.splice(tags.indexOf(tag),1);
        if(action==='add'){
          if(!(await this.visible(tx,[command.uid],c,true)).has(command.uid))throw new NotFoundException('검사를 찾을 수 없습니다');
          if(!tag.uids.includes(command.uid)){if(tags.reduce((n,t)=>n+t.uids.length,0)>=5000)throw new BadRequestException('이 태그 범위의 검사 연결은 최대5000개입니다');tag.uids.push(command.uid);}
        }
        if(action==='remove'){
          if(b.scope==='institution'&&!(await this.visible(tx,[command.uid],c,true)).has(command.uid))throw new NotFoundException('검사를 찾을 수 없습니다');
          tag.uids=tag.uids.filter(x=>x!==command.uid);
        }
      }
      await tx.studyTagCatalog.update({where:{institution_ownerSub:owner},data:{revision:row.revision+1,value:JSON.stringify(tags),lastRequest:requestId,lastFingerprint:fingerprint}});
      await tx.auditLog.create({data:{actor:c.actor,action:'study.tag.'+action,target:command.tagId,detail:JSON.stringify({scope:b.scope,revision:row.revision+1,...(command.uid?{uid:command.uid}:{})})}});
      return this.result(tx,c);
    });
  }
}
