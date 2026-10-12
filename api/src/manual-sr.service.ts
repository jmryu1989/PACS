import { canReadPreliminary } from './preliminary-reader';
import { StudyAccessService } from './study-access.service';
import { Injectable, BadRequestException, ConflictException, ForbiddenException, HttpException, ServiceUnavailableException, GoneException, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { Caller } from './pacs.service';
import { canonical, viewerJson, viewerUid, viewerUuid, verifyViewerReference, isManualMeasurement } from './viewer-input';
import { srDataset, srFile, srMeasurement } from './manual-sr-dicom';
import type { PreparedSr } from './emr-clinical/records';
import { ClinicalServicePort, SrAdoptionFact, clinicalRefusal, clinicalRuntime, recordSrPurposeEnd, requireClinicalRuntime } from './emr-clinical/services';

const denied = (): never => { throw new ForbiddenException('이 측정의 SR을 만들거나 저장할 수 없습니다'); };
const conflict = (): never => { throw new ConflictException('측정 또는 SR 요청이 변경되었습니다. 최신 측정을 확인하세요'); };
const OWN: Readonly<Record<string, () => HttpException>> = Object.freeze({
  NotFound: () => new ForbiddenException('이 측정의 SR을 만들거나 저장할 수 없습니다'),
  ActorPathRefused: () => new ForbiddenException('이 측정의 SR을 만들거나 저장할 수 없습니다'),
  StateTransitionRefused: () => new ConflictException('측정 또는 SR 요청이 변경되었습니다. 최신 측정을 확인하세요'),
  PreparationExpired: () => new GoneException('SR 준비 파일의24시간 보관 기한이 지났습니다. 새 파일을 준비하세요'),
});
const DAY_MS = 86400000;
const iso = (value: any) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const bytesHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function access(study: any, c: Caller) {
  if (c.kind !== 'member' || !c.sub || !c.actor || !c.roles.includes('radiologist') || !c.institution ||
      study?.institutionId !== c.institution || !canReadPreliminary(study, c)) denied();
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

/**
 * EMR-D 2라운드: SR 저장 의도는 작성 판독의 본인이 정확한 DICOM 바이트·SOP에 단말로 서명한 채택이며(records.ts
 * planManualSrAdoption), C 검증을 통과한 서명·채택·접속 사건·기존 의도 행이 한 트랜잭션으로 커밋되어야 Orthanc로 보낸다.
 * 24시간 준비 창은 시도·채택·참조·보전 어느 것도 없는 준비본이고 Orthanc가 갖고 있지 않음을 확인했을 때만 끝나며
 * (planManualSrCleanup), 끝난 준비본은 바이트를 지우지 않고 단위 H의 목적 종료 파기에 넘긴다. Orthanc 대사는 이 서버가
 * 승인한 바이트(같은 SOP·같은 해시)만 채택한다.
 */
@Injectable()
export class ManualSrService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ManualSrService.name);
  private preparing = 0;
  private recoveryTimer: ReturnType<typeof setInterval>;
  private recovering = false;
  constructor(private prisma: PrismaService, private orthanc: OrthancService, private studyAccess:StudyAccessService) {}

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
    if (!row.dicom || !row.dataset || !row.attemptedAt && row.createdAt.getTime() < Date.now() - DAY_MS)
      throw new GoneException('SR 준비 파일의24시간 보관 기한이 지났습니다. 새 파일을 준비하세요');
    return { id: row.id, dataset: row.dataset, stored: !!row.storedAt, storedAt: row.storedAt,
      sha256: row.sha256, expiresAt: row.attemptedAt ? null : new Date(row.createdAt.getTime() + DAY_MS),
      ...(file ? { dicom: Buffer.from(row.dicom).toString('base64') } : {}) };
  }

  /** Orthanc's view of one prepared SOP: absent, these exact bytes, or anything else (never mistaken for absent). */
  private async observeOrthanc(sop: string, dicom: Uint8Array): Promise<'absent' | 'present' | 'unknown'> {
    try { return (await this.orthanc.manualSrLocation(sop, Buffer.from(dicom))) ? 'present' : 'absent'; }
    catch (error) { return error instanceof BadRequestException ? 'present' : 'unknown'; }
  }

  /**
   * The 24-hour preparation window (records.ts planManualSrCleanup): only an unattempted, unadopted, unreferenced, unheld
   * copy that Orthanc confirms it does not hold reaches its purpose end, and that end is handed to unit H's destruction -
   * this service never erases the bytes itself. Without the EMR composition nothing can be decided, so everything is kept.
   * Expired copies are no longer served (receipt() answers 410) and no longer count toward the preparation budget.
   */
  private async expire(uid: string | null) {
    const runtime: ClinicalServicePort | null = clinicalRuntime();
    if (!runtime) return;
    try {
      const cutoff = new Date(Date.now() - DAY_MS);
      // Every copy past its window and not yet stored is decided by the one rule below (an attempted or adopted one is kept
      // there), unattempted copies first so that kept intents never crowd them out.
      const rows = await this.prisma.$queryRaw<any[]>`SELECT id, "studyUid", "authorSub", "createdAt", "attemptedAt", sha256,
        dataset->>'SOPInstanceUID' AS sop, dicom FROM "ManualSr" WHERE (${uid}::text IS NULL OR "studyUid" = ${uid}) AND "storedAt" IS NULL
        AND "createdAt" < ${cutoff} AND dicom IS NOT NULL ORDER BY ("attemptedAt" IS NOT NULL), "createdAt", id LIMIT 32`;
      const ended = await runtime.srPurposeEnds(rows.map(row => row.id));
      const candidates = rows.filter(row => !ended.has(row.id)).slice(0, 16);
      if (!candidates.length) return;
      const facts: PreparedSr[] = [];
      for (const row of candidates) {
        const adoption = await runtime.srAdoption(row.id);
        facts.push({ id: row.id, studyId: row.studyUid, authorId: row.authorSub, createdAt: iso(row.createdAt),
          attemptedAt: row.attemptedAt ? iso(row.attemptedAt) : null, storedAt: null,
          bytesSha256: row.sha256, sopInstanceUid: row.sop,
          adoptedVersion: adoption ? { recordId: row.id, versionId: adoption.versionId, sha256: adoption.sha256 } : null,
          referencedBy: (await runtime.referencesTo(row.id)).map(r => ({ recordId: r.recordId, versionId: r.versionId, sha256: r.sha256 })),
          holdIds: await runtime.holdIds(row.id), orthanc: await this.observeOrthanc(row.sop, row.dicom) });
      }
      const plan = runtime.planSrCleanup(facts, new Date().toISOString());
      if (!plan.clear.length) return;
      await this.transaction(async tx => {
        for (const item of plan.clear) await recordSrPurposeEnd(tx, item.id, item.bytesSha256);
        for (const study of new Set<string>(candidates.filter(row => plan.clear.some(c => c.id === row.id)).map(row => row.studyUid)))
          await tx.auditLog.create({ data: { actor: 'kin.manual-sr', target: study, action: 'manualSr.expire',
            detail: JSON.stringify({ ids: candidates.filter(row => row.studyUid === study && plan.clear.some(c => c.id === row.id)).map(row => row.id) }) } });
      });
    } catch {
      // Expiry is maintenance, not a measurement/revision failure. Keep bodies
      // on any failure and retry on the next background tick.
      this.logger.warn('Manual SR expiry deferred; retained bodies remain counted');
      if (uid) await this.transaction(tx => tx.auditLog.create({ data: { actor: 'kin.manual-sr', target: uid,
        action: 'manualSr.expire-deferred', detail: '{}' } })).catch(() => {});
    }
  }

  /**
   * Orthanc reconciliation (records.ts reconcileManualSr): only an attempted SR whose stored bytes still hash to what this
   * server authorized - and, with an adoption, to what its author signed - is adopted when Orthanc holds exactly those
   * bytes under that SOP. Another instance under the SOP is a conflict and is never reported as stored.
   */
  private async reconcile(row: any, orthancId?: string) {
    if (row.storedAt) return row;
    if (!row.attemptedAt || !row.dicom) return null;
    if (!orthancId) orthancId = await this.orthanc.manualSrLocation(row.dataset.SOPInstanceUID, Buffer.from(row.dicom));
    if (!orthancId) return null;
    const runtime = clinicalRuntime();
    let adoption: SrAdoptionFact | null = null;
    try { adoption = runtime ? await runtime.srAdoption(row.id) : null; } catch { adoption = null; }
    const facts = { id: row.id, studyId: row.studyUid, authorId: row.authorSub, createdAt: iso(row.createdAt), attemptedAt: iso(row.attemptedAt),
      storedAt: null, bytesSha256: row.sha256, sopInstanceUid: row.dataset.SOPInstanceUID,
      adoptedVersion: adoption ? { recordId: row.id, versionId: adoption.versionId, sha256: adoption.sha256 } : null,
      referencedBy: [], holdIds: [], orthanc: 'present' as const };
    // Orthanc matched the stored bytes (its uncompressed MD5); the hash compared here is of those bytes as stored now.
    // Without the EMR composition nothing is adopted: the copy stays attempted and is reconciled once one exists.
    if (!runtime) return null;
    const outcome = runtime.reconcileSr(facts, { status: 'present', sopInstanceUid: row.dataset.SOPInstanceUID, sha256: bytesHash(row.dicom) }).outcome;
    if (outcome !== 'adopt' || (adoption && (adoption.bytesSha256 !== row.sha256 || adoption.sopInstanceUid !== row.dataset.SOPInstanceUID))) {
      this.logger.warn('Manual SR reconciliation refused: stored bytes, SOP or adoption differ');
      return null;
    }
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
    await this.studyAccess.require(c,[uid]);
    const fingerprint = createHash('sha256').update(canonical({ uid, items: command.items })).digest('hex');
    const before = await this.heads(this.prisma, uid, command.items, c);
    const source = await this.sources(uid, before, true);
    await this.expire(uid);
    return this.transaction(async tx => {
      await this.studyAccess.require(c,[uid],tx);
      const [study] = await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`; access(study, c);
      const current = await this.heads(tx, uid, command.items, c);
      if (canonical(current.map(x => x.snapshot)) !== canonical(before.map(x => x.snapshot))) conflict();
      const known = await tx.manualSr.findUnique({ where: { authorSub_requestId: { authorSub: c.sub, requestId: command.requestId } } });
      if (known) { if (known.fingerprint !== fingerprint || known.studyUid !== uid) conflict(); return this.receipt(known, true); }
      const cutoff = new Date(Date.now() - DAY_MS);
      // The preparation budget counts copies still inside their window: an ended copy waiting for unit H's destruction
      // is no longer usable and never blocks a new preparation.
      const [budget] = await tx.$queryRaw<any[]>`SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE "authorSub" = ${c.sub})::int AS mine,
        COALESCE(SUM(octet_length(dicom)),0)::int AS bytes FROM "ManualSr" WHERE "studyUid" = ${uid} AND "attemptedAt" IS NULL AND dicom IS NOT NULL
        AND "createdAt" >= ${cutoff}`;
      if (budget.count >= 64 || budget.mine >= 32) throw new ConflictException('임시 SR 준비 파일 한도입니다. 저장하지 않은 파일은24시간 뒤 만료됩니다');
      const sequence = await tx.manualSr.count({ where: { studyUid: uid, authorSub: c.sub } });
      const id = randomUUID(), at = new Date(), dataset = srDataset(id, uid, c.actor, c.sub, at, source, sequence + 1), bytes = srFile(dataset);
      if (budget.bytes + bytes.length > 16777216) throw new ConflictException('임시 SR 준비 파일 용량 한도입니다.24시간 보관 기한을 확인하세요');
      const row = await tx.manualSr.create({ data: { id, studyUid: uid, authorSub: c.sub, authorActor: c.actor, requestId: command.requestId,
        fingerprint, selection: command.items, dataset, dicom: bytes, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: at } });
      await tx.auditLog.create({ data: { actor: c.actor, target: uid, action: 'manualSr.prepare',
        detail: JSON.stringify({ id, items: command.items, sha256: row.sha256, bytes: bytes.length }) } });
      return this.receipt(row, true);
    });
  }

  /**
   * The store intent is the author's signed adoption of these exact bytes, committed with the intent row and its access
   * event before any upload (runtime.adoptManualSr). No verified signature, no intent and no upload.
   */
  async store(uid: string, id: string, raw: Buffer, c: Caller, request?: unknown) {
    viewerUid(uid); viewerUuid(id);
    const runtime = requireClinicalRuntime();
    const body = viewerJson(raw); if (!body || Object.keys(body).length) throw new BadRequestException('저장할 SR 내용은 서버에서 확인합니다');
    const row = await this.prisma.manualSr.findUnique({ where: { id } });
    if (!row || row.studyUid !== uid || row.authorSub !== c.sub) denied();
    // Reconcile an already-issued write independently of current access, but
    // release no receipt/content until the caller passes today's read gates.
    const recovered = await this.reconcile(row);
    access(await this.prisma.studyState.findUnique({ where: { uid } }), c);
    await this.studyAccess.require(c,[uid]);
    if (recovered) return this.receipt(recovered);
    this.receipt(row);
    const heads = await this.heads(this.prisma, uid, row.selection as any[], c);
    await this.sources(uid, heads, false);
    let intent: any = row;
    if (!row.attemptedAt && !row.storedAt) {
      try {
        await runtime.adoptManualSr(request, { studyId: uid,
          sr: { id, studyId: uid, authorSubject: c.sub, createdAt: iso(row.createdAt), attemptedAt: null, storedAt: null, bytesSha256: row.sha256,
            sopInstanceUid: (row.dataset as any).SOPInstanceUID, adoptedVersion: null, referencedBy: [], holdIds: [], orthanc: 'unknown' },
          project: async tx => {
            await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
            await this.studyAccess.require(c,[uid],tx);
            const [study] = await tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`; access(study, c);
            const current = await this.heads(tx, uid, row.selection as any[], c);
            if (canonical(current.map(x => x.snapshot)) !== canonical(heads.map(x => x.snapshot))) conflict();
            await tx.$queryRaw`SELECT id FROM "ManualSr" WHERE id = ${id}::uuid FOR UPDATE`;
            const locked = await tx.manualSr.findUnique({ where: { id } });
            if (!locked || locked.storedAt || locked.attemptedAt || locked.sha256 !== row.sha256 || bytesHash(locked.dicom) !== row.sha256) conflict();
            this.receipt(locked);
            const [budget] = await tx.$queryRaw`SELECT COUNT(*)::int AS count, COALESCE(SUM(octet_length(dicom)),0)::int AS bytes FROM "ManualSr" WHERE "studyUid" = ${uid} AND "attemptedAt" IS NOT NULL`;
            if (budget.count >= 128 || budget.bytes + row.dicom.length > 16777216) throw new ConflictException('이 검사의 저장 SR 보존 한도에 도달했습니다');
            const attemptedAt = new Date();
            await tx.manualSr.update({ where: { id }, data: { attemptedAt, nextCheckAt: new Date(Date.now() + 30000) } });
            await tx.auditLog.create({ data: { actor: c.actor, target: uid, action: 'manualSr.store-intent', detail: JSON.stringify({ id, sha256: row.sha256, authorizedAt: attemptedAt }) } });
          } });
      } catch (error) { throw clinicalRefusal(error, OWN); }
      // Adopted now or by a concurrent store of the same SR first: either way the committed intent decides below.
      intent = await this.prisma.manualSr.findUnique({ where: { id } });
      if (!intent?.attemptedAt) conflict();
    }
    if (intent.storedAt) return this.receipt(intent);
    // The committed authorization is the upload decision. Network I/O cannot
    // hold the clinical study lock or block unrelated reading/measurement work.
    const orthancId = await this.orthanc.storeManualSr((intent.dataset as any).SOPInstanceUID, Buffer.from(intent.dicom));
    const saved = await this.reconcile(intent, orthancId);
    if (!saved) throw new ServiceUnavailableException('SR 저장 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요');
    access(await this.prisma.studyState.findUnique({ where: { uid } }), c);
    await this.studyAccess.require(c,[uid]);
    return this.receipt(saved);
  }
}
