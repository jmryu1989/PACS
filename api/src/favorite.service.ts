import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import type { Caller } from './pacs.service';

type Folder = { id: string; name: string; uids: string[] };
const uuid = (v: any) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const uid = (v: any) => typeof v === 'string' && v.length <= 64 && /^\d+(?:\.\d+)+$/.test(v);
const conflict = () => new ConflictException('즐겨찾기가 바뀌었습니다. 최신 목록을 읽고 다시 시도하세요');

@Injectable()
export class FavoriteService {
  constructor(private prisma: PrismaService) {}
  private owner(c: Caller) {
    if (c.kind !== 'member' || !c.roles.some(r => ['admin','radiologist','technician'].includes(r))
        || ![c.institution,c.sub].every(x => typeof x === 'string' && x.length > 0 && x.length <= 256))
      throw new ForbiddenException('소속 기관이 있는 회원 전용입니다');
    return { institution:c.institution!, subject:c.sub };
  }
  private async visible(tx: any, uids: string[], institution: string, lock = false): Promise<Set<string>> {
    if (!uids.length) return new Set();
    const rows = await tx.$queryRaw(Prisma.sql`SELECT uid FROM "StudyState" WHERE uid IN (${Prisma.join([...new Set(uids)].sort())})
      AND ("institutionId"=${institution} OR "teleInstitutionId"=${institution}) ORDER BY uid ${lock ? Prisma.sql`FOR SHARE` : Prisma.empty}`);
    return new Set(rows.map((x: any) => x.uid));
  }
  private async result(tx: any, owner: any, row: any) {
    const folders: Folder[] = row ? JSON.parse(row.value) : [];
    const visible = await this.visible(tx, folders.flatMap(f => f.uids), owner.institution);
    return { owner:[owner.institution,owner.subject], revision:row?.revision ?? 0,
      folders:folders.map(f => ({ id:f.id, name:f.name, uids:f.uids.filter(x => visible.has(x)), unavailable:f.uids.filter(x => !visible.has(x)).length })) };
  }
  private async run<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    try { return await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; return fn(tx);
    }, { maxWait:4000, timeout:8000 }); }
    catch (e: any) {
      if (e?.code === 'P2028' || e?.code === 'P2010' && ['55P03','57014','40P01'].includes(e?.meta?.code))
        throw new ServiceUnavailableException('즐겨찾기 처리 중입니다. 같은 요청으로 다시 시도하세요');
      throw e;
    }
  }
  async read(c: Caller) {
    const owner = this.owner(c);
    return this.run(async tx => {
      const rows = await tx.$queryRaw`SELECT * FROM "FavoriteWorkspace" WHERE institution=${owner.institution} AND subject=${owner.subject} FOR SHARE`;
      return this.result(tx,owner,rows[0]);
    });
  }
  async write(c: Caller, body: any) {
    const owner = this.owner(c), action = body?.action;
    const extras = ['create','rename'].includes(action) ? ['name'] : ['add','remove'].includes(action) ? ['uid'] : [];
    const fields = ['expectedOwner','revision','requestId','folderId','action',...extras].sort();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== fields.join()
        || !['create','rename','delete','add','remove'].includes(action) || !uuid(body.requestId) || !uuid(body.folderId)
        || !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647
        || extras.includes('uid') && !uid(body.uid)
        || extras.includes('name') && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120 || /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(body.name)))
      throw new BadRequestException('즐겨찾기 요청 형식을 확인하세요');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify([owner.institution,owner.subject])) throw conflict();
    const command = { action,folderId:body.folderId.toLowerCase(),revision:body.revision,
      ...(extras.includes('name') ? { name:body.name.trim() } : {}), ...(extras.includes('uid') ? { uid:body.uid } : {}) };
    const requestId = body.requestId.toLowerCase(), fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    return this.run(async tx => {
      await tx.$executeRaw`INSERT INTO "FavoriteWorkspace" (institution,subject,revision,value,"updatedAt") VALUES (${owner.institution},${owner.subject},0,'[]',NOW()) ON CONFLICT DO NOTHING`;
      const rows = await tx.$queryRaw`SELECT * FROM "FavoriteWorkspace" WHERE institution=${owner.institution} AND subject=${owner.subject} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw conflict();
      if (row.lastRequest === requestId) {
        if (row.lastFingerprint !== fingerprint) throw conflict();
        return this.result(tx,owner,row);
      }
      if (row.revision !== body.revision) throw conflict();
      const folders: Folder[] = JSON.parse(row.value), folder = folders.find(f => f.id === command.folderId);
      if (action === 'create') {
        if (folder || folders.length >= 50) throw new BadRequestException('폴더 중복 또는 최대50개 제한을 확인하세요');
        folders.push({ id:command.folderId,name:command.name,uids:[] });
      } else {
        if (!folder) throw new NotFoundException('폴더를 찾을 수 없습니다');
        if (action === 'rename') folder.name = command.name;
        if (action === 'delete') folders.splice(folders.indexOf(folder),1);
        if (action === 'add') {
          if (!(await this.visible(tx,[command.uid],owner.institution,true)).has(command.uid)) throw new NotFoundException('검사를 찾을 수 없습니다');
          if (!folder.uids.includes(command.uid)) {
            if (folders.reduce((n,f) => n+f.uids.length,0) >= 500) throw new BadRequestException('즐겨찾기 링크는 최대500개입니다');
            folder.uids.push(command.uid);
          }
        }
        if (action === 'remove') folder.uids = folder.uids.filter(x => x !== command.uid);
      }
      const saved = await tx.favoriteWorkspace.update({ where:{institution_subject:owner}, data:{revision:row.revision+1,value:JSON.stringify(folders),lastRequest:requestId,lastFingerprint:fingerprint} });
      await tx.auditLog.create({ data:{actor:c.actor,action:'favorite.'+action,target:command.folderId,
        detail:JSON.stringify({revision:saved.revision,...(command.uid ? {uid:command.uid} : {})})} });
      return this.result(tx,owner,saved);
    });
  }
}
