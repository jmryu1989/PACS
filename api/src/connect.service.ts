import { Injectable, BadRequestException, ForbiddenException, NotFoundException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { Caller } from './pacs.service';

const bad = () => { throw new BadRequestException({ code: 'CONNECT_INPUT_INVALID' }); };
const missing = () => { throw new NotFoundException('항목을 찾을 수 없습니다'); };
const deny = (code: string) => { throw new ForbiddenException({ code }); };
const conflict = (code: string) => { throw new ConflictException({ code }); };
function member(c: Caller, role?: string) {
  if (c.kind !== 'member' || !c.sub || !c.actor || !c.institution) deny('CONNECT_MEMBER_REQUIRED');
  if (role && !c.roles.includes(role) && !c.roles.includes('admin')) deny('CONNECT_ROLE_REQUIRED');
}
function uid(value: string) { if (typeof value !== 'string' || value.length > 64 || !/^[0-9]+(?:\.[0-9]+)+$/.test(value)) bad(); }
function uuid(value: any): string { if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) bad(); return value.toLowerCase(); }
function fields(body: any, allowed: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) bad();
}
function text(value: any): string { if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) bad(); return value.trim(); }
function date(value: any): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) bad();
  const d = new Date(value), expected = value.length === 20 ? value.replace('Z', '.000Z') : value;
  if (!Number.isFinite(d.getTime()) || d.toISOString() !== expected) bad(); return d;
}
function period(start: any, end: any) {
  const from = date(start), to = end == null ? null : date(end);
  if (to && to <= from) bad(); return { from, to };
}
function page(query: any, outgoing = false) {
  fields(query, outgoing ? ['dir', 'limit', 'cursor'] : ['limit', 'cursor']);
  if (outgoing && query.dir !== undefined && query.dir !== 'out') bad();
  if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9][0-9]?$|^100$/.test(query.limit))) bad();
  return { take: query.limit === undefined ? 50 : Number(query.limit), cursor: query.cursor === undefined ? undefined : uuid(query.cursor) };
}
function paged(rows: any[], take: number) { return { items: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1].id : null }; }

@Injectable()
export class ConnectService {
  constructor(private prisma: PrismaService, private orthanc: OrthancService) {}

  private async transaction<T>(c: Caller, work: (tx: Prisma.TransactionClient) => Promise<T>, write = true): Promise<T> {
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        // Evidence changes and opens for one sender share a lock, so a revoked
        // basis/agreement cannot be read just before a concurrent request commits.
        if (write) await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'connect:' + c.institution}, 0))`;
        return work(tx);
      }, { isolationLevel: write ? Prisma.TransactionIsolationLevel.ReadCommitted : Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 4000, timeout: 8000 });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === 'P2002') conflict('TRANSFER_EXISTS');
        if (['P2003', 'P2034'].includes(e.code)) conflict('CONNECT_CHANGED');
        if (e.code === 'P2028' || (e.code === 'P2010' && ['55P03', '57014'].includes(String(e.meta?.code))))
          throw new ServiceUnavailableException({ code: 'CONNECT_BUSY' });
      }
      throw e;
    }
  }
  private async owner(tx: Prisma.TransactionClient, studyUid: string, c: Caller, lock = true) {
    const rows = lock ? await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid=${studyUid} FOR UPDATE`
      : [await tx.studyState.findUnique({ where: { uid: studyUid } })];
    const s = rows[0]; if (!s || s.institutionId !== c.institution) missing(); return s;
  }
  private async destination(tx: Prisma.TransactionClient, to: any, c: Caller) {
    if (typeof to !== 'string' || to.length > 100 || to === c.institution || !await tx.institution.findUnique({ where: { id: to } })) bad();
  }
  private audit(tx: Prisma.TransactionClient, c: Caller, action: string, target: string, detail: any, at = new Date()) {
    return tx.auditLog.create({ data: { actor: c.actor, action, target, detail: JSON.stringify(detail), at } });
  }
  private async revokeLinked(tx: Prisma.TransactionClient, c: Caller, selector: Prisma.Sql, reason: string, at: Date) {
    // Set-based cascade keeps the revocation and one audit per request atomic,
    // without materializing an unbounded list of requests in the application.
    await tx.$executeRaw`WITH prior AS (
      SELECT t.id,t.status FROM "Transfer" t WHERE t."fromInstitutionId"=${c.institution}
        AND t.status IN ('OPEN','ACCEPTED') AND ${selector} FOR UPDATE
    ), changed AS (
      UPDATE "Transfer" t SET status='REVOKED',"decidedBy"=${c.actor},"decidedAt"=${at},"decisionReason"=${reason}
      FROM prior p WHERE t.id=p.id RETURNING t.id,t."studyUid",t."basisId",t."agreementId",p.status AS before
    ) INSERT INTO "AuditLog" (actor,action,target,detail,at)
      SELECT ${c.actor},'transfer.revoke',"studyUid",
        json_build_object('transferId',id,'basisId',"basisId",'agreementId',"agreementId",'before',before,'after','REVOKED')::text,${at} FROM changed`;
  }

  async listBasis(studyUid: string, query: any, c: Caller) {
    member(c, 'admin'); uid(studyUid); const p = page(query);
    return this.transaction(c, async tx => {
      await this.owner(tx, studyUid, c, false);
      return paged(await tx.transferBasis.findMany({ where: { studyUid, institutionId: c.institution, id: p.cursor ? { gt: p.cursor } : undefined }, orderBy: { id: 'asc' }, take: p.take + 1 }), p.take);
    }, false);
  }
  async recordBasis(studyUid: string, body: any, c: Caller) {
    member(c, 'admin'); uid(studyUid); fields(body, ['kind', 'reference', 'obtainedAt', 'expiresAt']);
    if (!['PATIENT_CONSENT', 'LEGAL_BASIS'].includes(body.kind)) bad();
    const reference = text(body.reference), p = period(body.obtainedAt, body.expiresAt); if (p.from.getTime() > Date.now()) bad();
    return this.transaction(c, async tx => {
      await this.owner(tx, studyUid, c); const at = new Date();
      const row = await tx.transferBasis.create({ data: { id: randomUUID(), studyUid, institutionId: c.institution, kind: body.kind, reference, obtainedAt: p.from, expiresAt: p.to, recordedBy: c.actor, recordedAt: at } });
      await this.audit(tx, c, 'basis.record', studyUid, { basisId: row.id, kind: row.kind }, at); return row;
    });
  }
  async revokeBasis(studyUid: string, id: string, body: any, c: Caller) {
    member(c, 'admin'); uid(studyUid); id = uuid(id); fields(body, ['reason']); const reason = text(body.reason);
    return this.transaction(c, async tx => {
      await this.owner(tx, studyUid, c);
      const before = await tx.transferBasis.findUnique({ where: { id } });
      if (!before || before.studyUid !== studyUid || before.institutionId !== c.institution) missing();
      if (before.revokedAt) conflict('BASIS_ALREADY_REVOKED'); const at = new Date();
      const row = await tx.transferBasis.update({ where: { id }, data: { revokedAt: at, revokedBy: c.actor, revokeReason: reason } });
      await this.revokeLinked(tx, c, Prisma.sql`t."basisId"=${id}::uuid`, reason, at);
      await this.audit(tx, c, 'basis.revoke', studyUid, { basisId: id, before: 'active', after: 'revoked' }, at); return row;
    });
  }
  async listAgreements(query: any, c: Caller) {
    member(c, 'admin'); const p = page(query);
    return paged(await this.prisma.processingAgreement.findMany({ where: { fromInstitutionId: c.institution, id: p.cursor ? { gt: p.cursor } : undefined }, orderBy: { id: 'asc' }, take: p.take + 1 }), p.take);
  }
  async recordAgreement(body: any, c: Caller) {
    member(c, 'admin'); fields(body, ['to', 'kind', 'reference', 'validFrom', 'validTo']); if (body.kind !== 'CONTRACT') bad();
    const reference = text(body.reference), p = period(body.validFrom, body.validTo);
    return this.transaction(c, async tx => {
      await this.destination(tx, body.to, c); const at = new Date();
      const row = await tx.processingAgreement.create({ data: { id: randomUUID(), fromInstitutionId: c.institution, toInstitutionId: body.to, kind: body.kind, reference, validFrom: p.from, validTo: p.to, recordedBy: c.actor, recordedAt: at } });
      await this.audit(tx, c, 'agreement.record', row.id, { agreementId: row.id, from: c.institution, to: body.to }, at); return row;
    });
  }
  async terminateAgreement(id: string, body: any, c: Caller) {
    member(c, 'admin'); id = uuid(id); fields(body, ['status', 'reason']); if (body.status !== 'terminated') bad(); const reason = text(body.reason);
    return this.transaction(c, async tx => {
      const before = await tx.processingAgreement.findUnique({ where: { id } }); if (!before || before.fromInstitutionId !== c.institution) missing();
      if (before.status !== 'active') conflict('AGREEMENT_ALREADY_TERMINATED'); const at = new Date();
      const row = await tx.processingAgreement.update({ where: { id }, data: { status: 'terminated', terminatedAt: at, terminatedBy: c.actor, terminationReason: reason } });
      await this.revokeLinked(tx, c, Prisma.sql`t."agreementId"=${id}::uuid`, reason, at);
      await this.audit(tx, c, 'agreement.terminate', id, { agreementId: id, before: 'active', after: 'terminated' }, at); return row;
    });
  }
  async openTransfer(studyUid: string, body: any, c: Caller) {
    member(c, 'technician'); uid(studyUid); fields(body, ['to', 'basisId']);
    // Avoid an Orthanc query for foreign or nonexistent studies; recheck under the
    // parent lock after the bounded source read, before granting even an OPEN row.
    const first = await this.prisma.studyState.findUnique({ where: { uid: studyUid } });
    if (!first || first.institutionId !== c.institution) missing();
    const original = await this.orthanc.connectStudyIdentity(studyUid);
    return this.transaction(c, async tx => {
      const study = await this.owner(tx, studyUid, c); if (study.rs === 'P') deny('PRELIM_IN_PROGRESS');
      await this.destination(tx, body.to, c);
      if (body.basisId == null || body.basisId === '') deny('BASIS_MISSING'); const basisId = uuid(body.basisId), at = new Date();
      const basis = await tx.transferBasis.findUnique({ where: { id: basisId } });
      if (!basis || basis.studyUid !== studyUid || basis.institutionId !== c.institution) deny('BASIS_MISSING');
      if (basis.revokedAt) deny('BASIS_REVOKED');
      if (basis.obtainedAt > at) deny('BASIS_NOT_YET_VALID');
      if (basis.expiresAt && basis.expiresAt <= at) deny('BASIS_EXPIRED');
      const agreement = await tx.processingAgreement.findFirst({ where: { fromInstitutionId: c.institution, toInstitutionId: body.to, status: 'active', validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gt: at } }] }, orderBy: [{ validFrom: 'desc' }, { id: 'asc' }] });
      if (!agreement) {
        const exists = await tx.processingAgreement.findFirst({ where: { fromInstitutionId: c.institution, toInstitutionId: body.to }, select: { id: true } });
        deny(exists ? 'AGREEMENT_INACTIVE' : 'AGREEMENT_MISSING');
      }
      const previous = await tx.transfer.findFirst({ where: { studyUid, toInstitutionId: body.to, status: { in: ['OPEN', 'ACCEPTED'] } } });
      if (previous) {
        if (previous.status !== 'OPEN' || previous.expiresAt > at) conflict('TRANSFER_EXISTS');
        await tx.transfer.update({ where: { id: previous.id }, data: { status: 'EXPIRED', decidedAt: at, decidedBy: c.actor, decisionReason: 'OPEN_EXPIRED' } });
        await this.audit(tx, c, 'transfer.expire', studyUid, { transferId: previous.id, before: 'OPEN', after: 'EXPIRED' }, at);
      }
      const row = await tx.transfer.create({ data: { id: randomUUID(), studyUid, fromInstitutionId: c.institution, toInstitutionId: body.to, basisId, agreementId: agreement.id, status: 'OPEN', sourcePatientKey: c.institution + '|' + original.patientId, requestedBy: c.actor, requestedAt: at, expiresAt: new Date(at.getTime() + 30 * 86400000) } });
      await this.audit(tx, c, 'transfer.open', studyUid, { transferId: row.id, basisId, agreementId: agreement.id, before: null, after: 'OPEN' }, at); return row;
    });
  }
  async listOutgoing(query: any, c: Caller) {
    member(c); const p = page(query, true), now = new Date();
    const rows = await this.prisma.transfer.findMany({ where: { fromInstitutionId: c.institution, id: p.cursor ? { gt: p.cursor } : undefined }, orderBy: { id: 'asc' }, take: p.take + 1 });
    return paged(rows.map(row => ({ ...row, status: row.status === 'OPEN' && row.expiresAt <= now ? 'EXPIRED' : row.status })), p.take);
  }
  async revokeTransfer(id: string, body: any, c: Caller) {
    member(c, 'technician'); id = uuid(id); fields(body, ['reason']); const reason = text(body.reason);
    return this.transaction(c, async tx => {
      const before = await tx.transfer.findUnique({ where: { id } }); if (!before || before.fromInstitutionId !== c.institution) missing();
      if (!['OPEN', 'ACCEPTED'].includes(before.status)) conflict('TRANSFER_NOT_OPEN'); const at = new Date();
      const row = await tx.transfer.update({ where: { id }, data: { status: 'REVOKED', decidedAt: at, decidedBy: c.actor, decisionReason: reason } });
      await this.audit(tx, c, 'transfer.revoke', row.studyUid, { transferId: id, basisId: row.basisId, agreementId: row.agreementId, before: before.status, after: 'REVOKED' }, at); return row;
    });
  }
}
