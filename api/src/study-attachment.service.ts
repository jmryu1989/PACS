/*
 * FC-076 Attach Document: attach (one file per request), the study's attached documents, and withdraw.
 *
 * Attach: the caller's role (technician or radiologist; admin passes as with need()), the study's own institution (a study
 * received for tele-reading is 403), StudyAccess, a destroyed study and a Study UID two patients answer are refused as on
 * every other study write. The row is written `pending` with the SOP and series UIDs before Orthanc is asked to make the
 * object - Orthanc and the database are not one transaction - so a lost answer or a failed database step is recovered by
 * looking the SOP UID up (here, on the next list read, and every 15 s in the background). The object is read back
 * (same Orthanc study, StudyInstanceUID, patient, planned UIDs, SOP class, content) before the row becomes `stored`; only
 * then are the audit row `study.attachment.add` and the access record written, in one transaction.
 *
 * Withdraw keeps the Orthanc object and the row: the row becomes `withdrawn` (who, when, why) and every serving path
 * leaves it out (study-attachment.ts hiddenAttachments). Nothing is deleted from Orthanc.
 */
import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger,
  NotFoundException, OnModuleDestroy, OnModuleInit, PayloadTooLargeException, ServiceUnavailableException,
  UnsupportedMediaTypeException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { StudyAccessService } from './study-access.service';
import { EMR_RECORD_PORT, EmrRecordPort, EmrRecordTransaction } from './emr-runtime/record-port';
import { RequestContextUnavailable } from './emr-runtime/request-context';
import type { RequestWorkContext } from './emr-runtime/request-context';
import type { RecordMutation } from './emr-runtime/store';
import { studyPatientLink } from './emr-clinical/routes';
import { refuseDestroyed } from './pacs/values';
import { inst } from './pacs/access';
import type { Caller } from './pacs/access';
import { ATTACHMENT_MESSAGES as M, WITHDRAW_REASON_MAX, createDicomRequest, declaredFormat, decodeFileName, imageSize,
  kindOf, newDicomUid, pngPixels, readbackDifference, sniffAttachment } from './study-attachment';
import type { AttachmentExpectation, AttachmentPlan } from './study-attachment';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STUDY_UID = /^\d+(?:\.\d+)+$/;
/** A pending row older than this with no object in Orthanc was never written. */
const NOT_WRITTEN_AFTER_MS = 120000;
const known = <T>(value: T) => ({ status: 'known' as const, value });

export const ATTACH_SURFACE = 'POST studies/:uid/attachments';
export const WITHDRAW_SURFACE = 'POST studies/:uid/attachments/:id/withdraw';

/** The attaching request's facts, kept on the row so the access record is the same whoever completes the write. */
interface StoredFacts {
  actor: { issuer: string; subject: string; id: string };
  roles: string[];
  institution: string;
  ingress: unknown;
  requestId: string;
  expect: AttachmentExpectation;
}

@Injectable()
export class StudyAttachmentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StudyAttachmentService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private recovering = false;

  constructor(private readonly prisma: PrismaService, private readonly orthanc: OrthancService,
    private readonly studyAccess: StudyAccessService, @Inject(EMR_RECORD_PORT) private readonly records: EmrRecordPort) {}

  onModuleInit() {
    // Recovery never starts a write: it only attributes or closes what an earlier request began.
    this.timer = setInterval(() => { void this.recoverPending(); }, 15000);
    this.timer.unref?.();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  // ── who may call ──

  private member(c: Caller) {
    if (c.kind !== 'member' || !c.sub) throw new ForbiddenException('회원 전용입니다');
    return inst(c);
  }

  /**
   * The study as the caller may write it: absent, foreign or outside StudyAccess is one 404; a study received for
   * tele-reading is 403; a destroyed study is refused; a Study UID two patients answer is refused by its own code.
   */
  private async ownStudy(uid: string, c: Caller, identity: boolean) {
    if (typeof uid !== 'string' || uid.length > 64 || !STUDY_UID.test(uid)) throw new NotFoundException(M.notFound);
    const me = this.member(c);
    const study = await this.prisma.studyState.findUnique({ where: { uid } });
    const visible = !!study && study.institutionId != null && (study.institutionId === me || study.teleInstitutionId === me);
    if (!visible) throw new NotFoundException(M.notFound);
    await this.studyAccess.prepare(c, [uid]);
    try { await this.studyAccess.require(c, [uid]); } catch { throw new NotFoundException(M.notFound); }
    if (study.institutionId !== me) throw new ForbiddenException(M.received);
    refuseDestroyed(study);
    if (identity) {
      await this.studyAccess.prepareSourceIdentity(c, [uid]);
      this.studyAccess.assertUnsplitSource(c, uid);
    }
    return study;
  }

  /** The same scope, again, inside the write's transaction with the study row held. */
  private async ownStudyLocked(tx: EmrRecordTransaction, uid: string, c: Caller) {
    const rows: any[] = await tx.$queryRaw`SELECT "institutionId", rs FROM "StudyState" WHERE uid = ${uid} FOR SHARE`;
    if (!rows.length || rows[0].institutionId !== c.institution) throw new NotFoundException(M.notFound);
    refuseDestroyed(rows[0]);
    await this.studyAccess.require(c, [uid], tx);
  }

  // ── POST /api/studies/:uid/attachments ──

  async add(uid: string, req: any, c: Caller, request: RequestWorkContext) {
    if (req.attachmentError === 413) throw new PayloadTooLargeException(M.tooLarge);
    if (req.attachmentError === 415) throw new UnsupportedMediaTypeException(M.type);
    if (req.attachmentError) throw new BadRequestException('요청 본문을 읽지 못했습니다');
    this.member(c);
    if (!['technician', 'radiologist', 'admin'].some(role => c.roles?.includes(role))) throw new ForbiddenException(M.role);
    const requestId = String(req.headers?.['x-kin-request-id'] ?? '');
    if (!UUID.test(requestId)) throw new BadRequestException(M.request);
    const fileName = decodeFileName(req.headers?.['x-kin-file-name']);
    if (!fileName) throw new BadRequestException(M.name);
    const bytes: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const format = sniffAttachment(bytes);
    if (!format || declaredFormat(req.headers?.['content-type']) !== format) throw new UnsupportedMediaTypeException(M.type);
    // A PNG is decoded here so the stored pixels can be checked byte for byte (and again by a later recovery);
    // a JPEG is checked by its size (Orthanc's JPEG decoder is the only one whose output it stores).
    const decoded = format === 'png' ? pngPixels(bytes) : null;
    const size = format === 'pdf' ? null : format === 'png' ? (decoded && { columns: decoded.columns, rows: decoded.rows }) : imageSize(bytes, format);
    if (format !== 'pdf' && !size) throw new UnsupportedMediaTypeException(M.imageUnreadable);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    // The same request sent again (its answer was lost) answers the row it already wrote.
    const sent = await this.prisma.studyAttachment.findUnique({ where: { createdBySub_requestId: { createdBySub: c.sub, requestId } } });
    if (sent) return this.replay(sent, uid, sha256, c);

    await this.ownStudy(uid, c, true);
    const source = await this.orthanc.attachmentStudy(uid);
    if (!source) throw new ServiceUnavailableException(M.source);
    const kind = kindOf(format);
    const plan: AttachmentPlan = { kind, format, sopInstanceUid: newDicomUid(), seriesInstanceUid: newDicomUid() };
    const facts = request.facts;
    const stored: StoredFacts = { actor: { ...facts.actor } as any, roles: [...facts.roles], institution: facts.institution,
      ingress: facts.ingress, requestId: facts.requestId,
      expect: { uid, parent: source.id, patientId: source.patientId, patientName: source.patientName,
        sopInstanceUid: plan.sopInstanceUid, seriesInstanceUid: plan.seriesInstanceUid, kind, size,
        pixels: decoded ? { samples: decoded.samples, sha256: createHash('sha256').update(decoded.pixels).digest('hex') } : null,
        ...(kind === 'pdf' ? { sha256 } : {}) } };

    let row: any;
    try {
      row = await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        // The account's rights now (session, member rights), not those the request started with, before any write.
        await request.requireCurrent(tx);
        await this.ownStudyLocked(tx, uid, c);
        return tx.studyAttachment.create({ data: { id: randomUUID(), uid, requestId, createdBySub: c.sub,
          sopInstanceUid: plan.sopInstanceUid, seriesInstanceUid: plan.seriesInstanceUid, kind, fileName, bytes: bytes.length,
          sha256, state: 'pending', access: stored as any, createdBy: c.actor || c.sub } });
      }, { maxWait: 4000, timeout: 8000 });
    } catch (error: any) {
      if (error instanceof HttpException || error instanceof RequestContextUnavailable) throw error;
      // Two sends of one request id: the second sees the first's row.
      if (error?.code === 'P2002') {
        const winner = await this.prisma.studyAttachment.findUnique({ where: { createdBySub_requestId: { createdBySub: c.sub, requestId } } });
        if (winner) return this.replay(winner, uid, sha256, c);
      }
      throw new ServiceUnavailableException('문서를 붙이지 못했습니다. 잠시 뒤 다시 시도하세요');
    }

    // The row is committed: from here a failure leaves it pending for recovery, never an Orthanc object nobody knows.
    let orthancId: string | null = null, refused = false;
    try {
      const answer = await this.orthanc.createAttachment(createDicomRequest(source.id, plan, bytes));
      if ('id' in answer) orthancId = answer.id; else refused = true;
    } catch { /* the answer was lost: look the planned SOP UID up below */ }
    return this.view(await this.settle(row, orthancId, true, refused));
  }

  /** A repeated request id: the same study and file only; its row is reconciled and answered as it is now. */
  private async replay(row: any, uid: string, sha256: string, c: Caller) {
    if (row.uid !== uid || row.sha256 !== sha256) throw new ConflictException(M.requestReused);
    await this.ownStudy(uid, c, false);
    return this.view(await this.settle(row, row.orthancId, true));
  }

  /**
   * A pending row to its end: the object located (by the create answer, else by its SOP UID) and noted as seen, read
   * back and checked against the row's own expectation (no uploaded bytes needed, so a later recovery checks the same),
   * then stored with its audit row and access record; failed when Orthanc holds nothing after the wait, or holds
   * something other than what was planned (that object, as Orthanc holds it, stays out of every serving path). A row
   * still unknown stays pending; `answer` makes that a 503 for the request that is waiting on it.
   */
  private async settle(row: any, orthancId: string | null, answer: boolean, refused = false): Promise<any> {
    if (row.state !== 'pending') return row;
    const expect = (row.access as StoredFacts).expect;
    try {
      const id = orthancId ?? await this.orthanc.attachmentLocation(row.sopInstanceUid);
      if (!id) {
        // Orthanc refused the write and holds nothing: not stored. A lost answer may still be written: wait it out.
        if (refused || Date.now() - new Date(row.createdAt).getTime() >= NOT_WRITTEN_AFTER_MS)
          return await this.close(row, null, '문서가 저장되지 않았습니다', null);
        throw new Error('unconfirmed');
      }
      // Seen in the archive: from now the counts and the gate know its Orthanc ID even while it is still pending.
      await this.prisma.studyAttachment.updateMany({ where: { id: row.id, state: 'pending' }, data: { orthancId: id, objectAt: row.objectAt ?? new Date() } });
      const observed = await this.orthanc.attachmentReadback(id, row.kind === 'pdf',
        expect.pixels && expect.size ? expect.size.rows * expect.size.columns * expect.pixels.samples : null);
      const difference = readbackDifference(expect, observed);
      return difference ? await this.close(row, id, difference, observed.tags) : await this.store(row, id);
    } catch (error) {
      this.logger.warn(`Attachment ${row.id} is still unconfirmed (${(error as any)?.name ?? 'error'})`);
      if (answer) throw new ServiceUnavailableException(M.unconfirmed);
      return row;
    }
  }

  /** Stored: the row, its audit row and its access record together. */
  private async store(row: any, orthancId: string) {
    const facts = row.access as StoredFacts;
    const work = this.records.begin();
    try {
      return await work.transactionWithRecords(async (tx, record) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        const locked: any[] = await tx.$queryRaw`SELECT state FROM "StudyAttachment" WHERE id = ${row.id}::uuid FOR UPDATE`;
        if (!locked.length) throw new NotFoundException(M.attachmentNotFound);
        if (locked[0].state !== 'pending') return tx.studyAttachment.findUnique({ where: { id: row.id } });
        const now = new Date();
        const saved = await tx.studyAttachment.update({ where: { id: row.id }, data: { state: 'stored', orthancId, storedAt: now } });
        await this.ledger(tx, record, row, facts, ATTACH_SURFACE, 'write', now, async () => {
          const audit = await tx.auditLog.create({ data: { actor: row.createdBy, action: 'study.attachment.add', target: row.uid,
            detail: JSON.stringify({ sop: row.sopInstanceUid, kind: row.kind, bytes: row.bytes, institution: facts.institution }) } });
          return { kind: 'StudyAttachment', id: row.id, version: String(audit.id) };
        });
        return saved;
      }, { maxWait: 4000, timeout: 8000 });
    } finally { work.end(); }
  }

  /**
   * Failed: nothing stored, or something other than planned - kept out of every serving path under the study and series
   * Orthanc actually holds it in, never deleted. The state change and its audit row are one transaction and happen once:
   * a failed audit leaves the row pending for the next recovery.
   */
  private async close(row: any, orthancId: string | null, reason: string, tags: Record<string, unknown> | null) {
    const observedStudy = typeof tags?.StudyInstanceUID === 'string' ? tags.StudyInstanceUID.replace(/[\0 ]+$/, '') : null;
    const observedSeries = typeof tags?.SeriesInstanceUID === 'string' ? tags.SeriesInstanceUID.replace(/[\0 ]+$/, '') : null;
    await this.prisma.$transaction(async tx => {
      const changed = await tx.studyAttachment.updateMany({ where: { id: row.id, state: 'pending' }, data: { state: 'failed', orthancId,
        failReason: reason, objectStudyUid: observedStudy && observedStudy !== row.uid ? observedStudy : null,
        objectSeriesUid: observedSeries && observedSeries !== row.seriesInstanceUid ? observedSeries : null } });
      if (changed.count && orthancId) await tx.auditLog.create({ data: { actor: 'kin.study-attachment', action: 'study.attachment.mismatch',
        target: row.uid, detail: JSON.stringify({ sop: row.sopInstanceUid, kind: row.kind, orthancId, institution: (row.access as StoredFacts).institution }) } });
    }, { maxWait: 4000, timeout: 8000 });
    return this.prisma.studyAttachment.findUnique({ where: { id: row.id } });
  }

  private async ledger(tx: EmrRecordTransaction, record: RecordMutation, row: any, facts: StoredFacts | null,
    surface: string, action: 'write' | 'cancel', at: Date, effect: () => Promise<any>, now?: RequestWorkContext) {
    const f = now?.facts;
    await record({ formatVersion: 1, surface, eventId: randomUUID(),
      userId: known(f ? f.actor : facts!.actor), rolesAtTime: known(f ? [...f.roles] : facts!.roles),
      actingInstitution: known(f ? f.institution : facts!.institution), managingInstitution: known(f ? f.institution : facts!.institution),
      occurredAt: at.toISOString(), trustedProxyIp: (f ? f.ingress : facts!.ingress) as any, cause: 'user-view', executor: 'member',
      context: { basis: 'worklist', studyId: row.uid, relatedStudyId: null, reason: null },
      targets: [{ kind: row.kind === 'pdf' ? 'pdf' : 'image',
        patientLinkSnapshot: known(studyPatientLink(f ? f.institution : facts!.institution, (row.access as StoredFacts).expect.patientId)),
        studyId: known(row.uid), recordId: known(row.sopInstanceUid), versionId: known(row.sha256) }],
      action, result: 'succeeded', requestId: f ? f.requestId : facts!.requestId,
      auditLinkId: 'audit:' + randomUUID(), relatedEventId: null } as any, effect);
  }

  /** Background: pending rows whose request is long gone (bounded per tick). */
  private async recoverPending() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const rows = await this.prisma.studyAttachment.findMany({ where: { state: 'pending', createdAt: { lt: new Date(Date.now() - 30000) } },
        orderBy: { createdAt: 'asc' }, take: 8 });
      for (const row of rows) await this.settle(row, row.orthancId, false);
    } catch { /* retried on the next tick */ }
    finally { this.recovering = false; }
  }

  // ── GET /api/studies/:uid/attachments ──

  async list(uid: string, c: Caller) {
    if (typeof uid !== 'string' || uid.length > 64 || !STUDY_UID.test(uid)) throw new NotFoundException(M.notFound);
    const me = this.member(c);
    if (!['technician', 'radiologist', 'admin'].some(role => c.roles?.includes(role))) throw new ForbiddenException(M.role);
    const study = await this.prisma.studyState.findUnique({ where: { uid } });
    if (!study || study.institutionId == null || (study.institutionId !== me && study.teleInstitutionId !== me)) throw new NotFoundException(M.notFound);
    await this.studyAccess.prepare(c, [uid]);
    try { await this.studyAccess.require(c, [uid]); } catch { throw new NotFoundException(M.notFound); }
    let rows = await this.prisma.studyAttachment.findMany({ where: { uid }, orderBy: { createdAt: 'desc' } });
    const pending = rows.filter(r => r.state === 'pending' && Date.now() - r.createdAt.getTime() > 30000).slice(0, 4);
    if (pending.length) {
      for (const row of pending) await this.settle(row, row.orthancId, false);
      rows = await this.prisma.studyAttachment.findMany({ where: { uid }, orderBy: { createdAt: 'desc' } });
    }
    const own = study.institutionId === me;
    return { uid, attachments: rows.map(row => this.view(row)),
      canAttach: own && ['technician', 'radiologist', 'admin'].some(role => c.roles.includes(role)),
      canWithdraw: own && ['technician', 'admin'].some(role => c.roles.includes(role)) };
  }

  // ── POST /api/studies/:uid/attachments/:id/withdraw ──

  async withdraw(uid: string, id: string, body: unknown, c: Caller, request: RequestWorkContext) {
    this.member(c);
    if (!['technician', 'admin'].some(role => c.roles?.includes(role))) throw new ForbiddenException(M.withdrawRole);
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as any).reason : undefined;
    const reason = typeof raw === 'string' ? raw.trim() : '';
    if (!reason || reason.length > WITHDRAW_REASON_MAX || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(reason))
      throw new BadRequestException(M.reason);
    if (!UUID.test(String(id ?? ''))) throw new NotFoundException(M.attachmentNotFound);
    await this.ownStudy(uid, c, false);
    const row = await this.prisma.studyAttachment.findUnique({ where: { id } });
    if (!row || row.uid !== uid) throw new NotFoundException(M.attachmentNotFound);
    if (row.state === 'withdrawn') return this.view(row);
    if (row.state !== 'stored') throw new ConflictException(M.notStored);
    const saved = await request.work.transactionWithRecords(async (tx, record) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await request.requireCurrent(tx);
      await this.ownStudyLocked(tx, uid, c);
      const locked: any[] = await tx.$queryRaw`SELECT state FROM "StudyAttachment" WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked.length) throw new NotFoundException(M.attachmentNotFound);
      if (locked[0].state === 'withdrawn') return tx.studyAttachment.findUnique({ where: { id } });
      if (locked[0].state !== 'stored') throw new ConflictException(M.notStored);
      const now = new Date();
      const updated = await tx.studyAttachment.update({ where: { id }, data: { state: 'withdrawn', withdrawnAt: now,
        withdrawnBy: c.actor || c.sub, withdrawReason: reason } });
      await this.ledger(tx, record, row, null, WITHDRAW_SURFACE, 'cancel', now, async () => {
        const audit = await tx.auditLog.create({ data: { actor: c.actor || c.sub, action: 'study.attachment.withdraw', target: uid,
          detail: JSON.stringify({ sop: row.sopInstanceUid, kind: row.kind, institution: c.institution }) } });
        return { kind: 'StudyAttachment', id, version: String(audit.id) };
      }, request);
      return updated;
    }, { maxWait: 4000, timeout: 8000 });
    return this.view(saved);
  }

  /** What a member sees of one attachment; no UID, Orthanc ID, digest or request facts. */
  view(row: any) {
    return { id: row.id, kind: row.kind, fileName: row.fileName, bytes: row.bytes, state: row.state,
      createdBy: row.createdBy, createdAt: row.createdAt, failReason: row.state === 'failed' ? row.failReason : null,
      withdrawnAt: row.withdrawnAt ?? null, withdrawnBy: row.withdrawnBy ?? null, withdrawReason: row.withdrawReason ?? null };
  }
}
