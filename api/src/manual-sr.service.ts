import { Injectable, BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException, GoneException, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { Caller } from './pacs.service';
import { canonical, viewerJson, viewerUid, viewerUuid, verifyViewerReference, isManualMeasurement } from './viewer-input';
import { srDataset, srFile, srMeasurement } from './manual-sr-dicom';

const denied = (): never => { throw new ForbiddenException('이 측정의 SR을 만들거나 저장할 수 없습니다'); };
const conflict = (): never => { throw new ConflictException('측정 또는 SR 요청이 변경되었습니다. 최신 측정을 확인하세요'); };
function access(study: any, c: Caller) {
  if (c.kind !== 'member' || !c.sub || !c.actor || !c.roles.includes('radiologist') || !c.institution ||
      study?.institutionId !== c.institution || (study.rs === 'P' && study.preDoc !== c.actor && study.preReviewer !== c.actor)) denied();
}
function selection(raw: Buffer) {
  const x = viewerJson(raw);
  if (!x || Object.keys(x).sort().join() !== 'items,requestId' || !Array.isArray(x.items) || !x.items.length || x.items.length > 16) throw new BadRequestException('직접 작성한 측정을1~16개 선택하세요');
  viewerUuid(x.requestId); const ids = new Set();
  for (const item of x.items) {
    if (!item || Object.keys(item).sort().join() !== 'id,revision' || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new BadRequestException('측정 revision이 올바르지 않습니다');
    viewerUuid(item.id); if (ids.has(item.id)) throw new BadRequestException('중복 측정입니다'); ids.add(item.id);
  }
  x.items.sort((a: any, b: any) => a.id.localeCompare(b.id)); return x;
}

@Injectable()
export class ManualSrService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ManualSrService.name);
  private preparing = 0;
  private recoveryTimer: ReturnType<typeof setInterval>;
  private recovering = false;
  constructor(private prisma: PrismaService, private orthanc: OrthancService) {}

  onModuleInit() {
    // Reconciliation never initiates an upload. It attributes bytes already
    // accepted by Orthanc, even if the initiating account lost access later.
    this.recoveryTimer = setInterval(() => { void this.recoverPending(); }, 15000);
    this.recoveryTimer.unref();
  }
  onModuleDestroy() { clearInterval(this.recoveryTimer); }

  private async recoverPending() {
    if (this.recovering) return; this.recovering = true;
    try {
      await this.expire(null);
      const rows = await this.prisma.manualSr.findMany({ where: { storedAt: null, attemptedAt: { not: null }, nextCheckAt: { lte: new Date() } },
        orderBy: { nextCheckAt: 'asc' }, take: 4 });
      for (const row of rows) {
        await this.prisma.manualSr.updateMany({ where: { id: row.id, storedAt: null }, data: { nextCheckAt: new Date(Date.now() + 300000) } });
        try { await this.reconcile(row); } catch { /* Keep the committed intent for a bounded later retry. */ }
      }
    } catch { /* Startup/migration or transient DB failures are retried on the next tick. */ }
    finally { this.recovering = false; }
  }

  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return work(tx);
      }, { maxWait: 4000, timeout: 8000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (['P2002', 'P2003', 'P2034'].includes(error.code)) conflict();
        if (['P2028', 'P2010'].includes(error.code)) throw new ServiceUnavailableException('SR 처리 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요');
      }
      throw error;
    }
  }

  private async heads(db: PrismaService | Prisma.TransactionClient, uid: string, items: any[], c: Caller) {
    const result = await db.viewerItem.findMany({ where: { studyUid: uid, id: { in: items.map(x => x.id) } } });
    return items.map(item => {
      const head = result.find(x => x.id === item.id);
      if (!head || head.authorSub !== c.sub) denied();
      if (head.hidden || head.revision !== item.revision || !isManualMeasurement((head.snapshot as any).kind)) conflict();
      return head;
    });
  }

  private async sources(uid: string, heads: any[], calculate: boolean) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    const cache = new Map<string, any>(), output = []; let pixelBytes = 0;
    try {
    for (const head of heads) {
      const item = head.snapshot;
      controller.signal.throwIfAborted();
      if (!cache.has(item.sopUid)) cache.set(item.sopUid, await this.orthanc.viewerReference(item.sopUid, true, controller.signal));
      const tags = cache.get(item.sopUid); verifyViewerReference(uid, item, tags);
      if (!item.sourceDigest || item.sourceDigest !== tags._kinSourceDigest) conflict();
      if (output.length && ['PatientID', 'PatientName', 'PatientBirthDate', 'PatientSex'].some(key => (output[0].tags[key] || '') !== (tags[key] || ''))) conflict();
      let pixels: Buffer;
      if (calculate && item.kind === 'ellipse') {
        pixels = await this.orthanc.manualSrPixels(item.sopUid, controller.signal); pixelBytes += pixels.length;
        if (pixelBytes > 33558528) throw new BadRequestException('한 번에 처리할 ROI 원본 크기를 초과했습니다. 나누어 선택하세요');
      }
      output.push({ head, tags, ...(calculate ? { computed: srMeasurement(item, tags, pixels) } : {}) });
    }
    // A source replacement during the decoded pixel read must not produce a
    // document containing pixels from one version and tags from another.
    if (calculate) for (const [sop, tags] of cache) {
      if ((await this.orthanc.viewerReference(sop, true, controller.signal))._kinSourceDigest !== tags._kinSourceDigest) conflict();
    }
    return output;
    } catch (error) {
      if (controller.signal.aborted) throw new ServiceUnavailableException('SR 원본 확인 시간이 초과되었습니다. 같은 요청으로 다시 시도하세요');
      throw error;
    } finally { clearTimeout(timer); controller.abort(); }
  }

  private receipt(row: any, file = false) {
    if (!row.dicom || !row.dataset || !row.attemptedAt && row.createdAt.getTime() < Date.now() - 86400000)
      throw new GoneException('SR 준비 파일의24시간 보관 기한이 지났습니다. 새 파일을 준비하세요');
    return { id: row.id, dataset: row.dataset, stored: !!row.storedAt, storedAt: row.storedAt,
      sha256: row.sha256, expiresAt: row.attemptedAt ? null : new Date(row.createdAt.getTime() + 86400000),
      ...(file ? { dicom: Buffer.from(row.dicom).toString('base64') } : {}) };
  }

  private async expire(uid: string | null) {
    // Retention is a service policy across authors. Sweep only bounded SR
    // rows; neither a clinical study lock nor another writer's row is needed.
    try { await this.transaction(async tx => {
      const cutoff = new Date(Date.now() - 86400000);
      const rows = await tx.$queryRaw<any[]>`SELECT id, "studyUid" FROM "ManualSr" WHERE (${uid}::text IS NULL OR "studyUid" = ${uid})
        AND "attemptedAt" IS NULL AND "createdAt" < ${cutoff} AND dicom IS NOT NULL
        ORDER BY "createdAt", id LIMIT 8 FOR UPDATE SKIP LOCKED`;
      if (!rows.length) return;
      const ids = rows.map(row => row.id);
      await tx.manualSr.updateMany({ where: { id: { in: ids } }, data: { dataset: Prisma.DbNull, dicom: null } });
      for (const study of new Set<string>(rows.map(row => row.studyUid)))
        await tx.auditLog.create({ data: { actor: 'kin.manual-sr', target: study, action: 'manualSr.expire',
          detail: JSON.stringify({ ids: rows.filter(row => row.studyUid === study).map(row => row.id) }) } });
    }); } catch {
      // Expiry is maintenance, not a measurement/revision failure. Keep bodies
      // on any failure and retry on the next background tick. Physical retained
      // bytes still count toward the prepare budget until actually reclaimed.
      this.logger.warn('Manual SR expiry deferred; retained bodies remain counted');
      if (uid) await this.transaction(tx => tx.auditLog.create({ data: { actor: 'kin.manual-sr', target: uid,
        action: 'manualSr.expire-deferred', detail: '{}' } })).catch(() => {});
    }
  }

  private async reconcile(row: any, orthancId?: string) {
    if (row.storedAt) return row;
    if (!row.attemptedAt || !row.dicom) return null;
    if (!orthancId) orthancId = await this.orthanc.manualSrLocation(row.dataset.SOPInstanceUID, Buffer.from(row.dicom));
    if (!orthancId) return null;
    return this.transaction(async tx => {
      const lockedRows = await tx.$queryRaw<any[]>`SELECT id FROM "ManualSr" WHERE id = ${row.id}::uuid FOR UPDATE`;
      if (!lockedRows.length) conflict();
      const locked = await tx.manualSr.findUnique({ where: { id: row.id } });
      if (locked.storedAt) return locked;
      const saved = await tx.manualSr.update({ where: { id: row.id }, data: { storedAt: new Date(), orthancId, nextCheckAt: null } });
      await tx.auditLog.create({ data: { actor: row.authorActor, target: row.studyUid, action: 'manualSr.store',
        detail: JSON.stringify({ id: row.id, sha256: row.sha256, authorizedAt: row.attemptedAt }) } });
      return saved;
    });
  }

  async prepare(uid: string, raw: Buffer, c: Caller) {
    // Bound decoded image memory across simultaneous requests in this worker.
    if (this.preparing >= 2) throw new ServiceUnavailableException('다른 SR을 확인 중입니다. 잠시 후 같은 요청으로 다시 시도하세요');
    this.preparing++;
    try { return await this.prepareFile(uid, raw, c); } finally { this.preparing--; }
  }

  private async prepareFile(uid: string, raw: Buffer, c: Caller) {
    viewerUid(uid); const command = selection(raw);
    access(await this.prisma.studyState.findUnique({ where: { uid } }), c);
    const fingerprint = createHash('sha256').update(canonical({ uid, items: command.items })).digest('hex');
    const before = await this.heads(this.prisma, uid, command.items, c);
    const source = await this.sources(uid, before, true);
    await this.expire(uid);
    return this.transaction(async tx => {
      const [study] = await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`; access(study, c);
      const current = await this.heads(tx, uid, command.items, c);
      if (canonical(current.map(x => x.snapshot)) !== canonical(before.map(x => x.snapshot))) conflict();
      const known = await tx.manualSr.findUnique({ where: { authorSub_requestId: { authorSub: c.sub, requestId: command.requestId } } });
      if (known) { if (known.fingerprint !== fingerprint || known.studyUid !== uid) conflict(); return this.receipt(known, true); }
      const cutoff = new Date(Date.now() - 86400000);
      const [budget] = await tx.$queryRaw<any[]>`SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE "authorSub" = ${c.sub})::int AS mine,
        COUNT(*) FILTER (WHERE "createdAt" < ${cutoff})::int AS expired,
        COALESCE(SUM(octet_length(dicom)),0)::int AS bytes FROM "ManualSr" WHERE "studyUid" = ${uid} AND "attemptedAt" IS NULL AND dicom IS NOT NULL`;
      if ((budget.count >= 64 || budget.mine >= 32) && budget.expired)
        throw new ServiceUnavailableException('만료 SR 정리가 지연되고 있습니다. 잠시 후 같은 요청으로 다시 시도하세요');
      if (budget.count >= 64 || budget.mine >= 32) throw new ConflictException('임시 SR 준비 파일 한도입니다. 저장하지 않은 파일은24시간 뒤 만료됩니다');
      const sequence = await tx.manualSr.count({ where: { studyUid: uid, authorSub: c.sub } });
      const id = randomUUID(), at = new Date(), dataset = srDataset(id, uid, c.actor, c.sub, at, source, sequence + 1), bytes = srFile(dataset);
      if (budget.bytes + bytes.length > 16777216) {
        if (budget.expired) throw new ServiceUnavailableException('만료 SR 정리가 지연되고 있습니다. 잠시 후 같은 요청으로 다시 시도하세요');
        throw new ConflictException('임시 SR 준비 파일 용량 한도입니다.24시간 보관 기한을 확인하세요');
      }
      const row = await tx.manualSr.create({ data: { id, studyUid: uid, authorSub: c.sub, authorActor: c.actor, requestId: command.requestId,
        fingerprint, selection: command.items, dataset, dicom: bytes, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: at } });
      await tx.auditLog.create({ data: { actor: c.actor, target: uid, action: 'manualSr.prepare',
        detail: JSON.stringify({ id, items: command.items, sha256: row.sha256, bytes: bytes.length }) } });
      return this.receipt(row, true);
    });
  }

  async store(uid: string, id: string, raw: Buffer, c: Caller) {
    viewerUid(uid); viewerUuid(id);
    const body = viewerJson(raw); if (!body || Object.keys(body).length) throw new BadRequestException('저장할 SR 내용은 서버에서 확인합니다');
    const row = await this.prisma.manualSr.findUnique({ where: { id } });
    if (!row || row.studyUid !== uid || row.authorSub !== c.sub) denied();
    // Reconcile an already-issued write independently of current access, but
    // release no receipt/content until the caller passes today's read gates.
    const recovered = await this.reconcile(row);
    access(await this.prisma.studyState.findUnique({ where: { uid } }), c);
    if (recovered) return this.receipt(recovered);
    this.receipt(row);
    const heads = await this.heads(this.prisma, uid, row.selection as any[], c);
    await this.sources(uid, heads, false);
    const intent = await this.transaction(async tx => {
      const [study] = await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`; access(study, c);
      const current = await this.heads(tx, uid, row.selection as any[], c);
      if (canonical(current.map(x => x.snapshot)) !== canonical(heads.map(x => x.snapshot))) conflict();
      await tx.$queryRaw`SELECT id FROM "ManualSr" WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.manualSr.findUnique({ where: { id } });
      if (!locked) conflict();
      if (locked.storedAt || locked.attemptedAt) return locked;
      this.receipt(locked);
      const [budget] = await tx.$queryRaw<any[]>`SELECT COUNT(*)::int AS count, COALESCE(SUM(octet_length(dicom)),0)::int AS bytes FROM "ManualSr" WHERE "studyUid" = ${uid} AND "attemptedAt" IS NOT NULL`;
      if (budget.count >= 128 || budget.bytes + row.dicom.length > 16777216) throw new ConflictException('이 검사의 저장 SR 보존 한도에 도달했습니다');
      const attemptedAt = new Date();
      const issued = await tx.manualSr.update({ where: { id }, data: { attemptedAt, nextCheckAt: new Date(Date.now() + 30000) } });
      await tx.auditLog.create({ data: { actor: c.actor, target: uid, action: 'manualSr.store-intent', detail: JSON.stringify({ id, sha256: row.sha256, authorizedAt: attemptedAt }) } });
      return issued;
    });
    if (intent.storedAt) return this.receipt(intent);
    // The committed authorization is the upload decision. Network I/O cannot
    // hold the clinical study lock or block unrelated reading/measurement work.
    const orthancId = await this.orthanc.storeManualSr((intent.dataset as any).SOPInstanceUID, Buffer.from(intent.dicom));
    const saved = await this.reconcile(intent, orthancId);
    access(await this.prisma.studyState.findUnique({ where: { uid } }), c);
    return this.receipt(saved);
  }
}
