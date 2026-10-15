/*
 * S9-U4b self-institution DICOM import and original download (contract S9-U4p 3, 4.4, 4.6, 4.8, 5.2-5.3, 6).
 *
 * The routes' own rules: who may call (need/inst, the verified issuer and subject as the owner key, StudyAccess), the
 * request shape, readiness, and the original download (fixed manifest, ZIP32 plan, one sending attempt at a time, headers
 * before the first byte, per-object checkpoints, no byte after a lost right). Every import write goes through
 * DicomImportGateService. A refusal never names another institution's study, a patient value or an upstream body.
 */
import { ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { need, inst } from './pacs/access';
import type { Caller } from './pacs/access';
import { rightsAllow } from './member-rights';
import { readDicomPart10 } from './dicom-part10-reader';
import { canonicalManifest, parseCanonicalManifest, planArchive, writeArchive, ORIGINAL_ARCHIVE_LIMITS, ORIGINAL_ARCHIVE_MESSAGES } from './original-archive';
import type { ArchiveObjectResult, OriginalManifest } from './original-archive';
import { DicomImportGateService, IMPORT_OBJECT_LIMIT, IMPORT_FILE_SLOTS, downloadStatus, precheckFile } from './dicom-import-gate.service';
import type { ImportOwner } from './dicom-import-gate.service';

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UID = /^[0-9]+(\.[0-9]+)*$/;
const FILE_INDEX = /^(?:0|[1-9][0-9]?)$/;
const LEASE_MS = 30000;
const RENEW_MS = 10000;
const NO_PROGRESS_MS = 30000;
const DOWNLOAD_ROLES = ['radiologist', 'technician'];

export const TRANSFER_MESSAGES = Object.freeze({
  restricted: '검사 범위가 제한된 계정은 새 검사를 반입할 수 없습니다. 제한 없는 계정으로 반입한 뒤 열람 범위를 확인하세요.',
  subject: '검증된 사용자 식별값이 없어 반입·다운로드 작업을 열 수 없습니다.',
  issuer: '인증 발급자 설정이 없어 반입·다운로드 작업을 열 수 없습니다. 관리자에게 알려 주세요.',
  request: '작업 번호(UUID), 파일 번호(0~99)와 검사 식별값 형식을 확인하세요.',
  tooLarge: '한 파일은 24 MiB(25,165,824 bytes)까지 반입할 수 있습니다. 이 파일은 저장되지 않았습니다.',
  contentType: 'DICOM 파일 한 개를 application/dicom으로, 압축 없이 보내야 합니다.',
  downloadRole: '원본 다운로드는 radiologist 또는 technician 권한이 필요합니다',
  recoveryRole: '반입 결과 확인은 admin 권한이 필요합니다',
  member: '소속 기관 회원 전용입니다',
  notFound: '검사를 찾을 수 없습니다',
  operationNotFound: '다운로드 작업을 찾을 수 없습니다',
  conflict: '다른 사용자나 다른 종류·다른 검사의 작업에 쓰인 작업 번호입니다. 새 작업으로 다시 시도하세요.',
  changed: '준비한 뒤 검사 원본이 바뀌었습니다. 새로 준비해 다시 내려받으세요. 내려받기는 시작되지 않았습니다.',
  inProgress: '이 작업의 내려받기가 진행 중입니다. 끝난 뒤 다시 시도하세요.',
  alreadySent: '이 작업의 원본은 이미 모두 보냈습니다. 다시 받으려면 새로 준비하세요.',
  storage: '원본 다운로드 기록을 저장하지 못했습니다. 내려받기는 시작되지 않았습니다. 잠시 뒤 다시 시도하세요.',
  sent: '서버가 이 검사의 모든 원본을 보냈습니다. 내 컴퓨터에 저장됐는지는 브라우저의 다운로드 목록에서 확인하세요.',
});

const error = (status: number, code: string, message: string) => new HttpException({ code, message }, status);

@Injectable()
export class StudyTransferLocalService {
  constructor(private readonly prisma: PrismaService, private readonly gate: DicomImportGateService,
    private readonly studyAccess: StudyAccessService) {}

  // ── who may call: member, role, institution, then the owner key (contract 3, 4.4) ──

  private owner(c: Caller, role: 'import' | 'download' | 'recovery'): ImportOwner {
    if (c.kind !== 'member') throw new ForbiddenException(TRANSFER_MESSAGES.member);
    this.role(c.roles, role);
    const institutionId = inst(c);
    if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 256) throw error(403, 'IMPORT_SUBJECT_MISSING', TRANSFER_MESSAGES.subject);
    const issuer = process.env.KC_ISSUER;
    if (!issuer) throw error(503, 'IMPORT_ISSUER_UNCONFIGURED', TRANSFER_MESSAGES.issuer);
    const actor = typeof c.actor === 'string' && c.actor ? c.actor.slice(0, 256) : c.sub;
    return { institutionId, ownerIssuer: issuer, ownerSubject: c.sub, actor };
  }

  private role(roles: string[], role: 'import' | 'download' | 'recovery') {
    if (role === 'import') need(roles, 'technician', 'DICOM 반입');
    else if (role === 'download') { if (!roles?.includes('admin') && !DOWNLOAD_ROLES.some(r => roles?.includes(r))) throw new ForbiddenException(TRANSFER_MESSAGES.downloadRole); }
    else if (!roles?.includes('admin')) throw new ForbiddenException(TRANSFER_MESSAGES.recoveryRole);
  }

  /**
   * The rights now, not those of the request start (contract 3: before the first Orthanc write, before the first archive
   * byte, while bytes flow): the durable member rights the guard also reads, the session still open, the study still the
   * institution's own and inside StudyAccess. The refusals are the existing ones (403 role/institution, 404 study).
   */
  async currentRights(c: Caller, role: 'import' | 'download', studyUid: string | null, session: string | null): Promise<void> {
    if (process.env.AUTH_REQUIRED !== 'false') {
      const row = await this.prisma.memberRights.findUnique({ where: { sub: c.sub } });
      const allowed = rightsAllow(row);
      this.role(allowed ? row.roles : [], role);
      inst({ ...c, institution: allowed && row.institution === c.institution ? c.institution : null });
      if (session && !await this.prisma.authSession.findUnique({ where: { sid: session } })) throw new ForbiddenException(TRANSFER_MESSAGES.member);
    }
    if (studyUid !== null) await this.ownStudy(studyUid, c);
  }

  /** The institution's own study inside the caller's StudyAccess; absent, foreign, tele-received and restricted are one 404. */
  private async ownStudy(uid: string, c: Caller) {
    const state = await this.prisma.studyState.findUnique({ where: { uid } });
    if (!state || state.institutionId !== c.institution) throw new NotFoundException(TRANSFER_MESSAGES.notFound);
    await this.studyAccess.require(c, [uid]);
    return state;
  }

  // ── POST /api/dicom-import ──

  async importFile(req: any, c: Caller): Promise<{ status: number; body: any }> {
    const owner = this.owner(c, 'import');
    await this.gate.ready(true);
    const operationId = String(req.headers['x-kin-operation-id'] ?? '');
    const indexText = String(req.headers['x-kin-file-index'] ?? '');
    const expected = req.headers['x-kin-expect-study'];
    if (!OPERATION_ID.test(operationId) || !FILE_INDEX.test(indexText) || Number(indexText) >= IMPORT_FILE_SLOTS
        || (expected !== undefined && (typeof expected !== 'string' || expected.length > 64 || !UID.test(expected))))
      throw error(400, 'IMPORT_REQUEST_INVALID', TRANSFER_MESSAGES.request);
    const parsed = req.dicomImportError;
    if (parsed) throw error(parsed.status, parsed.code, parsed.status === 413 ? TRANSFER_MESSAGES.tooLarge
      : parsed.status === 415 ? TRANSFER_MESSAGES.contentType : TRANSFER_MESSAGES.request);
    if (!Buffer.isBuffer(req.body)) throw error(400, 'IMPORT_REQUEST_INVALID', TRANSFER_MESSAGES.request);
    const bytes: Buffer = req.body;
    if (bytes.length > IMPORT_OBJECT_LIMIT) throw error(413, 'DICOM_IMPORT_TOO_LARGE', TRANSFER_MESSAGES.tooLarge);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const institutions = await this.gate.institutions();
    const precheck = precheckFile(readDicomPart10(bytes), typeof expected === 'string' ? expected : null, owner.institutionId, institutions);
    if (precheck.ok) {
      // Request-level StudyAccess (contract 3): an existing own study must be inside the caller's scope (404); a
      // restricted account cannot open a new study (403). A foreign or unassigned study is the file's own 409 below.
      const state = await this.prisma.studyState.findUnique({ where: { uid: precheck.studyUid } });
      if (state && state.institutionId === owner.institutionId) await this.studyAccess.require(c, [precheck.studyUid]);
      else if (!state && (await this.studyAccess.snapshot(c)).policy.restricted)
        throw error(403, 'STUDY_ACCESS_RESTRICTED_IMPORT', TRANSFER_MESSAGES.restricted);
    }
    const answer = await this.gate.importFile({ owner, operationId: operationId.toLowerCase(), index: Number(indexText),
      expectedStudyUid: typeof expected === 'string' ? expected : null, bytes, sha256, precheck,
      recheck: async () => {
        await this.currentRights(c, 'import', null, null);
        if (precheck.ok) await this.importStudyScope(precheck.studyUid, c);
      } });
    if (answer.refusal) throw answer.refusal;
    return { status: answer.status, body: { operationId: operationId.toLowerCase(), ...this.gate.publicFile(answer.entry), message: answer.message } };
  }

  /** Before the first Orthanc write: an own StudyState must still be inside StudyAccess; a foreign one is a 404 now. */
  private async importStudyScope(uid: string, c: Caller) {
    const state = await this.prisma.studyState.findUnique({ where: { uid } });
    if (!state || state.institutionId !== c.institution) throw new NotFoundException(TRANSFER_MESSAGES.notFound);
    await this.studyAccess.require(c, [uid]);
  }

  // ── GET /api/dicom-import/:operationId ──

  async importStatus(operationId: string, c: Caller) {
    const owner = this.owner(c, 'import');
    await this.gate.ready(false);
    if (!OPERATION_ID.test(operationId ?? '')) throw new NotFoundException('반입 작업을 찾을 수 없습니다');
    return this.gate.importStatus(owner, operationId.toLowerCase(), await this.gate.orthancAnswering());
  }

  // ── POST /api/admin/dicom-import/:operationId/files/:index/recovery ──

  async recover(operationId: string, indexText: string, body: unknown, c: Caller) {
    const admin = this.owner(c, 'recovery');
    await this.gate.ready(true);
    if (!OPERATION_ID.test(operationId ?? '') || !FILE_INDEX.test(indexText ?? '') || Number(indexText) >= IMPORT_FILE_SLOTS)
      throw new NotFoundException('반입 작업을 찾을 수 없습니다');
    return this.gate.recover(admin, operationId.toLowerCase(), Number(indexText), body);
  }

  // ── POST /api/studies/:uid/original-downloads (contract 5.2 steps 1-2) ──

  async prepareDownload(uid: string, body: unknown, c: Caller) {
    const owner = this.owner(c, 'download');
    await this.gate.ready(true);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'operationId'
        || typeof (body as any).operationId !== 'string' || !OPERATION_ID.test((body as any).operationId))
      throw error(400, 'IMPORT_REQUEST_INVALID', TRANSFER_MESSAGES.request);
    const operationId = (body as any).operationId.toLowerCase();
    await this.ownStudy(uid, c);
    const existing = await this.prisma.importOperation.findUnique({ where: { id: operationId } });
    if (existing) return this.replayPrepared(existing, owner, uid);
    const built = await this.currentManifest(uid);
    if (built.ok === false) throw error(409, built.code, built.message);
    const plan = planArchive(built.manifest);
    if (plan.ok === false) throw error(409, plan.code, plan.message);
    try {
      return await this.gate.write(async (tx, now) => {
        const download = { schemaVersion: 1, targetStudyUid: uid, destination: 'browser-download', preparedAt: now.toISOString(),
          manifestCanonical: built.manifestCanonical, attempts: [] as any[] };
        await tx.importOperation.create({ data: { id: operationId, ...owner, kind: 'download', studyUid: uid, status: 'prepared', results: [],
          manifestSha256: built.manifestSha256, download, createdAt: now, updatedAt: now } });
        await tx.auditLog.create({ data: { actor: owner.actor, action: 'original.download.prepare', target: uid,
          detail: JSON.stringify({ institutionId: owner.institutionId, operationId, studyUid: uid, manifestSha256: built.manifestSha256,
            objects: built.manifest.objects.length, bytes: totalBytes(built.manifest), ownerIssuer: owner.ownerIssuer,
            ownerSubject: owner.ownerSubject, at: now.toISOString() }) } });
        return this.downloadView({ id: operationId, studyUid: uid, status: 'prepared', manifestSha256: built.manifestSha256, download }, built.manifest);
      });
    } catch (failure: any) {
      // Two POSTs of one id: the winner's row is replayed to the loser (contract 5.2 step 1).
      const winner = await this.prisma.importOperation.findUnique({ where: { id: operationId } }).catch(() => null);
      if (winner) return this.replayPrepared(winner, owner, uid);
      if (failure instanceof HttpException) throw failure;
      throw error(503, 'IMPORT_STORAGE_UNAVAILABLE', TRANSFER_MESSAGES.storage);
    }
  }

  private replayPrepared(op: any, owner: ImportOwner, uid: string) {
    if (!this.ownsDownload(op, owner) || op.studyUid !== uid) throw error(409, 'OPERATION_CONFLICT', TRANSFER_MESSAGES.conflict);
    return this.downloadView(op, this.storedManifest(op).manifest);
  }

  private ownsDownload(op: any, owner: ImportOwner) {
    return op.kind === 'download' && op.ownerIssuer === owner.ownerIssuer && op.ownerSubject === owner.ownerSubject
      && op.institutionId === owner.institutionId;
  }

  /** B-02: the stored manifest is re-validated (hash, schema, exact canonical text, target) before any use. */
  private storedManifest(op: any) {
    const stored = parseCanonicalManifest(op.download?.manifestCanonical, op.manifestSha256);
    if (!stored.ok || op.download?.schemaVersion !== 1 || op.download?.targetStudyUid !== op.studyUid || stored.manifest.studyUid !== op.studyUid)
      throw error(503, 'MANIFEST_STORE_INVALID', ORIGINAL_ARCHIVE_MESSAGES.MANIFEST_STORE_INVALID);
    return stored;
  }

  private downloadView(op: any, manifest: OriginalManifest) {
    const attempts = Array.isArray(op.download?.attempts) ? op.download.attempts : [];
    return { operationId: op.id, studyUid: op.studyUid, state: op.status, manifestSha256: op.manifestSha256, preparedAt: op.download?.preparedAt ?? null,
      objects: manifest.objects.length, bytes: totalBytes(manifest), note: op.status === 'sent' ? TRANSFER_MESSAGES.sent : null,
      attempts: attempts.map((a: any) => ({ attemptId: a.attemptId, number: a.number, state: a.state, startedAt: a.startedAt, endedAt: a.endedAt,
        archiveSha256: a.archiveSha256, responseFinished: a.responseFinished,
        objectsComplete: a.objects.filter((o: any) => o.complete).length, bytesSupplied: a.objects.reduce((n: number, o: any) => n + o.bytesSupplied, 0) })) };
  }

  /**
   * The study's originals now (5.2 step 2): every instance, its UIDs and stored size/MD5, enumerated twice and equal both
   * times. Empty, duplicate, missing or unreadable is MANIFEST_INCOMPLETE; more objects than ZIP32 allows is ARCHIVE_TOO_LARGE.
   */
  private async currentManifest(uid: string): Promise<{ ok: true; manifest: OriginalManifest; manifestCanonical: string; manifestSha256: string }
    | { ok: false; code: string; message: string }> {
    const incomplete = { ok: false as const, code: 'MANIFEST_INCOMPLETE', message: ORIGINAL_ARCHIVE_MESSAGES.MANIFEST_INCOMPLETE };
    const first = await this.gate.studyInstanceIds(uid, ORIGINAL_ARCHIVE_LIMITS.maxDicomObjects + 1);
    if (!first || first.length === 0) return incomplete;
    if (first.length > ORIGINAL_ARCHIVE_LIMITS.maxDicomObjects)
      return { ok: false, code: 'ARCHIVE_TOO_LARGE', message: ORIGINAL_ARCHIVE_MESSAGES.ARCHIVE_TOO_LARGE };
    const objects = [];
    for (const orthancId of first) {
      const uids = await this.gate.instanceUids(orthancId);
      const info = uids && uids.studyUid === uid ? await this.gate.attachmentInfo(orthancId) : null;
      if (!uids || !info) return incomplete;
      objects.push({ orthancId, seriesUid: uids.seriesUid, sopUid: uids.sopUid, bytes: info.bytes, md5: info.md5 });
    }
    const second = await this.gate.studyInstanceIds(uid, ORIGINAL_ARCHIVE_LIMITS.maxDicomObjects + 1);
    if (!second || JSON.stringify([...second].sort()) !== JSON.stringify([...first].sort())) return incomplete;
    const built = canonicalManifest(uid, objects);
    return built.ok ? built : incomplete;
  }

  // ── GET /api/studies/:uid/original-downloads/:operationId ──

  async downloadStatus(uid: string, operationId: string, c: Caller) {
    const owner = this.owner(c, 'download');
    await this.gate.ready(false);
    const op = OPERATION_ID.test(operationId ?? '') ? await this.prisma.importOperation.findUnique({ where: { id: operationId.toLowerCase() } }) : null;
    if (!op || !this.ownsDownload(op, owner) || op.studyUid !== uid) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
    await this.gate.expireDownloads(op.id);
    const fresh = await this.prisma.importOperation.findUnique({ where: { id: op.id } });
    return this.downloadView(fresh, this.storedManifest(fresh).manifest);
  }

  // ── GET /api/studies/:uid/original-downloads/:operationId/archive (5.2 steps 3-7) ──

  async archive(uid: string, operationId: string, req: any, res: any, c: Caller): Promise<void> {
    const owner = this.owner(c, 'download');
    await this.gate.ready(true);
    const op = OPERATION_ID.test(operationId ?? '') ? await this.prisma.importOperation.findUnique({ where: { id: operationId.toLowerCase() } }) : null;
    if (!op || !this.ownsDownload(op, owner) || op.studyUid !== uid) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
    await this.ownStudy(uid, c);
    const stored = this.storedManifest(op);
    const plan = planArchive(stored.manifest);
    if (plan.ok === false) throw error(409, plan.code, plan.message);
    if (op.status === 'sent') throw error(409, 'DOWNLOAD_ALREADY_SENT', TRANSFER_MESSAGES.alreadySent);
    const current = await this.currentManifest(uid);
    if (current.ok === false) throw error(409, current.code === 'ARCHIVE_TOO_LARGE' ? 'MANIFEST_CHANGED' : current.code,
      current.code === 'ARCHIVE_TOO_LARGE' ? TRANSFER_MESSAGES.changed : current.message);
    if (current.manifestCanonical !== stored.manifestCanonical) throw error(409, 'MANIFEST_CHANGED', TRANSFER_MESSAGES.changed);
    const session = req?.authMethod === 'session' && typeof req.sid === 'string' ? req.sid : null;
    await this.currentRights(c, 'download', uid, session);
    const attempt = await this.openAttempt(op.id, owner, stored.manifestSha256);
    // Everything is decided: headers, then bytes. From here no error becomes an HTTP status (5.2 step 6).
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="KIN-originals-${op.id.slice(0, 8)}.zip"`);
    res.setHeader('Content-Length', String(plan.plan.totalSize));
    res.setHeader('Cache-Control', 'no-store');
    const stop = new AbortController();
    let fenced = false, lastWritten = 0;
    const lost = () => { if (!res.writableFinished) stop.abort(); };
    res.once('close', lost);
    let idle = setTimeout(() => stop.abort(), NO_PROGRESS_MS);
    const renew = setInterval(() => {
      void this.renewAttempt(op.id, attempt.attemptId)
        .then(kept => { if (!kept) { fenced = true; stop.abort(); } return this.currentRights(c, 'download', uid, session); })
        .catch(() => stop.abort());
    }, RENEW_MS);
    renew.unref?.();
    let result;
    try {
      result = await writeArchive({ plan: plan.plan, sink: res, signal: stop.signal,
        source: (object, _index, adopt) => this.gate.openOriginal(object.orthancId, stop.signal, adopt),
        onObjectDone: done => this.checkpoint(op.id, attempt.attemptId, done),
        onProgress: progress => {
          // Only bytes that actually moved restart the 30 s no-progress timer (B-03); an empty report does not.
          if (progress.archiveBytesWritten > lastWritten) {
            lastWritten = progress.archiveBytesWritten;
            clearTimeout(idle);
            idle = setTimeout(() => stop.abort(), NO_PROGRESS_MS);
          }
        },
        beforeWrite: () => !fenced && !stop.signal.aborted });
    } finally {
      clearTimeout(idle);
      clearInterval(renew);
      res.removeListener('close', lost);
    }
    await this.closeAttempt(op.id, owner, attempt.attemptId, stored.manifestSha256, result).catch(() => undefined);
  }

  /** 5.2 step 5: one sending attempt per operation; its intent row commits before the first byte or nothing is sent. */
  private async openAttempt(operationId: string, owner: ImportOwner, manifestSha256: string) {
    try {
      return await this.gate.write(async (tx, now) => {
        const found: any[] = await tx.$queryRaw`SELECT * FROM "ImportOperation" WHERE id = ${operationId}::uuid FOR UPDATE`;
        const op = found[0];
        if (!op || !this.ownsDownload(op, owner)) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
        if (op.status === 'sent') throw error(409, 'DOWNLOAD_ALREADY_SENT', TRANSFER_MESSAGES.alreadySent);
        const download = JSON.parse(JSON.stringify(op.download));
        for (const previous of download.attempts) if (previous.state === 'sending') {
          if (Date.parse(previous.leaseUntil) > now.getTime()) throw error(409, 'DOWNLOAD_IN_PROGRESS', TRANSFER_MESSAGES.inProgress);
          previous.state = 'unconfirmed'; previous.endedAt = now.toISOString();
        }
        const attempt = { attemptId: randomUUID(), number: download.attempts.length + 1, ownerSubject: owner.ownerSubject, actor: owner.actor,
          manifestSha256, destination: 'browser-download', state: 'sending', startedAt: now.toISOString(), endedAt: null,
          ownerInstance: this.gate.bootId, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(), objects: [] as ArchiveObjectResult[],
          archiveSha256: null as string | null, responseFinished: false };
        download.attempts.push(attempt);
        await tx.importOperation.update({ where: { id: operationId }, data: { download, status: 'sending', updatedAt: now } });
        await tx.auditLog.create({ data: { actor: owner.actor, action: 'original.download.intent', target: op.studyUid,
          detail: JSON.stringify({ institutionId: op.institutionId, operationId, attemptId: attempt.attemptId, number: attempt.number,
            manifestSha256, ownerIssuer: owner.ownerIssuer, ownerSubject: owner.ownerSubject, at: now.toISOString() }) } });
        return attempt;
      });
    } catch (failure) {
      if (failure instanceof HttpException) throw failure;
      throw error(503, 'IMPORT_STORAGE_UNAVAILABLE', TRANSFER_MESSAGES.storage);
    }
  }

  /** The attempt's lease, renewed while its worker still owns it (attempt id and state sending). */
  private renewAttempt(operationId: string, attemptId: string): Promise<boolean> {
    return this.gate.write(async (tx, now) => {
      const found: any[] = await tx.$queryRaw`SELECT * FROM "ImportOperation" WHERE id = ${operationId}::uuid FOR UPDATE`;
      const download = JSON.parse(JSON.stringify(found[0].download));
      const mine = download.attempts.find((a: any) => a.attemptId === attemptId);
      if (!mine || mine.state !== 'sending' || Date.parse(mine.leaseUntil) <= now.getTime()) return false;
      mine.leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
      await tx.importOperation.update({ where: { id: operationId }, data: { download, updatedAt: now } });
      return true;
    });
  }

  /** 5.2 step 4: each completed object's result is committed before the next object starts; a lost CAS stops the archive. */
  private async checkpoint(operationId: string, attemptId: string, done: ArchiveObjectResult): Promise<void> {
    const kept = await this.gate.write(async (tx, now) => {
      const found: any[] = await tx.$queryRaw`SELECT * FROM "ImportOperation" WHERE id = ${operationId}::uuid FOR UPDATE`;
      const download = JSON.parse(JSON.stringify(found[0].download));
      const mine = download.attempts.find((a: any) => a.attemptId === attemptId);
      if (!mine || mine.state !== 'sending' || Date.parse(mine.leaseUntil) <= now.getTime()) return false;
      mine.objects.push(done);
      await tx.importOperation.update({ where: { id: operationId }, data: { download, updatedAt: now } });
      return true;
    });
    if (!kept) throw new Error('checkpoint fenced');
  }

  /**
   * 5.2 step 7 / B-04: Sent, responseFinished, the archive hash and the result row only after the writer's own finish; a
   * stream that stopped on its source, a length/MD5 mismatch, the receiver or a cancellation is Incomplete; a lost
   * checkpoint, a fence or anything else is Unconfirmed. Earlier checkpoints and attempts are never erased.
   */
  private async closeAttempt(operationId: string, owner: ImportOwner, attemptId: string, manifestSha256: string, result: any) {
    const incomplete = ['length-mismatch', 'md5-mismatch', 'source-error', 'sink-closed', 'sink-error', 'aborted'];
    const state = result?.state === 'finished' ? 'sent' : incomplete.includes(result?.reason) ? 'incomplete' : 'unconfirmed';
    await this.gate.write(async (tx, now) => {
      const found: any[] = await tx.$queryRaw`SELECT * FROM "ImportOperation" WHERE id = ${operationId}::uuid FOR UPDATE`;
      const op = found[0];
      const download = JSON.parse(JSON.stringify(op.download));
      const mine = download.attempts.find((a: any) => a.attemptId === attemptId);
      if (!mine || mine.state !== 'sending') return;
      mine.state = state;
      mine.endedAt = now.toISOString();
      mine.objects = Array.isArray(result?.objects) ? result.objects : mine.objects;
      mine.archiveSha256 = state === 'sent' ? result.archiveSha256 : null;
      mine.responseFinished = state === 'sent';
      await tx.importOperation.update({ where: { id: operationId }, data: { download, status: downloadStatus(download), updatedAt: now } });
      await tx.auditLog.create({ data: { actor: owner.actor, action: 'original.download.result', target: op.studyUid,
        detail: JSON.stringify({ institutionId: op.institutionId, operationId, attemptId, state, manifestSha256,
          archiveSha256: mine.archiveSha256, responseFinished: mine.responseFinished, reason: result?.reason ?? null,
          objects: mine.objects.map((o: ArchiveObjectResult) => ({ sopUid: o.sopUid, sha256: o.sha256, bytesSupplied: o.bytesSupplied, complete: o.complete })),
          at: now.toISOString() }) } });
    });
  }
}

function totalBytes(manifest: OriginalManifest) {
  return manifest.objects.reduce((sum, o) => sum + o.bytes, 0);
}
