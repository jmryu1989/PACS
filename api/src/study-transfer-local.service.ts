/*
 * S9-U4b self-institution DICOM import and original download (contract S9-U4p 3, 4.4, 4.6, 4.8, 5.2-5.3, 6).
 *
 * The routes' own rules: who may call (need/inst, the verified issuer and subject as the owner key, StudyAccess), the
 * request shape, readiness, and the original download (fixed manifest, ZIP32 plan, one sending attempt at a time, headers
 * before the first byte, per-object checkpoints, no byte after a lost right or a lost lease). Every import write goes
 * through DicomImportGateService. A refusal never names another institution's study, a patient value or an upstream body.
 */
import { ForbiddenException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { AuthService } from './auth.service';
import { need, inst } from './pacs/access';
import type { Caller } from './pacs/access';
import { rightsAllow } from './member-rights';
import { readDicomPart10 } from './dicom-part10-reader';
import { canonicalManifest, parseCanonicalManifest, planArchive, writeArchive, ORIGINAL_ARCHIVE_LIMITS, ORIGINAL_ARCHIVE_MESSAGES } from './original-archive';
import type { ArchiveObjectResult, ManifestObjectInput, OriginalManifest } from './original-archive';
import { DicomImportGateService, IMPORT_OBJECT_LIMIT, IMPORT_FILE_SLOTS, StoredFormatError, exactKeys, precheckFile, storedTime } from './dicom-import-gate.service';
import type { ImportOwner } from './dicom-import-gate.service';

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UID = /^[0-9]+(\.[0-9]+)*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FILE_INDEX = /^(?:0|[1-9][0-9]?)$/;
const LEASE_MS = 30000;
const RENEW_MS = 10000;
const NO_PROGRESS_MS = 30000;
/**
 * The check before a chunk renews the lease (to DB now + 30 s) when less than this is left of it by the database's own
 * time; otherwise it only confirms it. After any passing check the lease outlives the check by at least this much, so a
 * fence by another request (only ever of an expired lease) cannot fall between the check and the chunk it admits.
 */
const RENEW_BELOW_MS = 20000;
/** Upper bound of one check before a chunk; a check that does not answer in time stops the archive. */
const CHECK_BOUND_MS = 5000;
const DOWNLOAD_ROLES = ['radiologist', 'technician'];
const DOWNLOAD_STATES = ['prepared', 'sending', 'sent', 'incomplete', 'unconfirmed'];
const DOWNLOAD_KEYS = ['schemaVersion', 'targetStudyUid', 'destination', 'preparedAt', 'manifestCanonical', 'attempts'];
const SUPPLY_KEYS = ['attemptId', 'number', 'ownerSubject', 'actor', 'manifestSha256', 'destination', 'state', 'startedAt', 'endedAt',
  'ownerInstance', 'leaseUntil', 'objects', 'archiveSha256', 'responseFinished'];
const OBJECT_KEYS = ['orthancId', 'sopUid', 'bytesRead', 'bytesSupplied', 'sha256', 'md5', 'complete'];
/** Writer stop reasons whose supplied bytes are known exactly: Incomplete (5.2 step 6); any other stop is Unconfirmed. */
const INCOMPLETE_REASONS = ['length-mismatch', 'md5-mismatch', 'source-error', 'sink-closed', 'sink-error', 'aborted'];

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
  /** The global guard's own wording for an ended session (auth.service), answered here as a refusal without a code. */
  sessionEnded: '인증 세션이 없습니다',
  notFound: '검사를 찾을 수 없습니다',
  operationNotFound: '다운로드 작업을 찾을 수 없습니다',
  conflict: '다른 사용자나 다른 종류·다른 검사의 작업에 쓰인 작업 번호입니다. 새 작업으로 다시 시도하세요.',
  changed: '준비한 뒤 검사 원본이 바뀌었습니다. 새로 준비해 다시 내려받으세요. 내려받기는 시작되지 않았습니다.',
  inProgress: '이 작업의 내려받기가 진행 중입니다. 끝난 뒤 다시 시도하세요.',
  alreadySent: '이 작업의 원본은 이미 모두 보냈습니다. 다시 받으려면 새로 준비하세요.',
  storage: '원본 다운로드 기록을 읽거나 저장하지 못했습니다. 내려받기는 시작되지 않았습니다. 잠시 뒤 다시 시도하세요.',
  sent: '서버가 이 검사의 모든 원본을 보냈습니다. 내 컴퓨터에 저장됐는지는 브라우저의 다운로드 목록에서 확인하세요.',
});

const error = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const storeInvalid = () => error(503, 'MANIFEST_STORE_INVALID', ORIGINAL_ARCHIVE_MESSAGES.MANIFEST_STORE_INVALID);
const downloadStorage = () => error(503, 'IMPORT_STORAGE_UNAVAILABLE', TRANSFER_MESSAGES.storage);
const text = (value: unknown, max = 1024): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const count = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;

export interface StoredDownload { download: any; manifest: OriginalManifest; manifestCanonical: string; manifestSha256: string }

/**
 * Contract 5.2: a download row and its persisted JSON exactly as written - the closed download object, the canonical
 * manifest under its SHA-256, and every attempt with its object checkpoints bound to that manifest's objects in order
 * (full hashes only on complete objects, a partial object only last and without a hash, Sent only with the archive hash,
 * responseFinished and every object). Anything else is StoredFormatError: never used, never rebuilt.
 */
export function checkDownloadRow(op: any): StoredDownload {
  const fail = (): never => { throw new StoredFormatError('download ' + (op?.id ?? '?')); };
  if (!op || op.kind !== 'download' || !(typeof op.studyUid === 'string' && op.studyUid.length <= 64 && UID.test(op.studyUid))
      || !DOWNLOAD_STATES.includes(op.status) || !Array.isArray(op.results) || op.results.length !== 0 || typeof op.manifestSha256 !== 'string'
      || !HEX64.test(op.manifestSha256) || op.claimKey !== null || op.claim !== null || !text(op.institutionId, 256) || !text(op.ownerIssuer)
      || !text(op.ownerSubject, 256) || !text(op.actor, 256)) fail();
  const d = op.download;
  if (!exactKeys(d, DOWNLOAD_KEYS) || d.schemaVersion !== 1 || d.targetStudyUid !== op.studyUid || d.destination !== 'browser-download'
      || !storedTime(d.preparedAt) || !Array.isArray(d.attempts)) fail();
  const stored = parseCanonicalManifest(d.manifestCanonical, op.manifestSha256);
  if (!stored.ok || stored.manifest.studyUid !== op.studyUid) fail();
  const manifest = (stored as Extract<typeof stored, { ok: true }>).manifest;
  const seen = new Set<string>();
  d.attempts.forEach((a: any, i: number) => {
    const last = i === d.attempts.length - 1;
    if (!exactKeys(a, SUPPLY_KEYS) || typeof a.attemptId !== 'string' || !UUID_TEXT.test(a.attemptId) || seen.has(a.attemptId) || a.number !== i + 1
        || a.ownerSubject !== op.ownerSubject || !text(a.actor, 256) || a.manifestSha256 !== op.manifestSha256 || a.destination !== 'browser-download'
        || !DOWNLOAD_STATES.includes(a.state) || a.state === 'prepared' || !storedTime(a.startedAt)
        || (a.state === 'sending') !== (a.endedAt === null) || (a.endedAt !== null && !storedTime(a.endedAt))
        || typeof a.ownerInstance !== 'string' || !UUID_TEXT.test(a.ownerInstance) || !storedTime(a.leaseUntil)
        || !Array.isArray(a.objects) || a.objects.length > manifest.objects.length || typeof a.responseFinished !== 'boolean'
        || ((a.state === 'sending' || a.state === 'sent') && !last)) fail();
    seen.add(a.attemptId);
    a.objects.forEach((o: any, j: number) => {
      const m = manifest.objects[j];
      if (!exactKeys(o, OBJECT_KEYS) || o.orthancId !== m.orthancId || o.sopUid !== m.sopUid || !count(o.bytesRead, m.bytes + 1)
          || !count(o.bytesSupplied, Math.min(o.bytesRead, m.bytes)) || typeof o.complete !== 'boolean') fail();
      if (o.complete ? !(typeof o.sha256 === 'string' && HEX64.test(o.sha256) && o.md5 === m.md5 && o.bytesRead === m.bytes && o.bytesSupplied === m.bytes)
        : !(o.sha256 === null && o.md5 === null && j === a.objects.length - 1 && a.state !== 'sending')) fail();
    });
    if (a.state === 'sent' ? !(typeof a.archiveSha256 === 'string' && HEX64.test(a.archiveSha256) && a.responseFinished === true
        && a.objects.length === manifest.objects.length && a.objects.every((o: any) => o.complete))
      : !(a.archiveSha256 === null && a.responseFinished === false)) fail();
  });
  if (op.status !== (d.attempts.length ? d.attempts[d.attempts.length - 1].state : 'prepared')) fail();
  return { download: d, manifest, manifestCanonical: d.manifestCanonical, manifestSha256: op.manifestSha256 };
}

@Injectable()
export class StudyTransferLocalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('StudyTransferLocal');
  private stopping = false;

  constructor(private readonly prisma: PrismaService, private readonly gate: DicomImportGateService,
    private readonly studyAccess: StudyAccessService, private readonly auth: AuthService) {}

  onModuleInit() {
    // Expired download attempts are closed beside the server, never in front of it (the same as the import pass).
    const timer = setTimeout(() => {
      if (!this.stopping) void this.expireDownloads().catch(() => this.logger.warn('download reconciliation stopped; the next start or request retries it'));
    }, 0);
    timer.unref?.();
  }

  onModuleDestroy() { this.stopping = true; }

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
   * byte, before every archive chunk): the credential the guard admitted is still live under the current authentication
   * contract (a cookie session not ended or replaced; a bearer token still valid and its provider session not ended), the
   * durable member rights the guard also reads, and the study still the institution's own and inside StudyAccess. The
   * refusals are the existing ones (403 role/institution/ended session, 404 study). A storage or provider failure is not
   * a refusal: it is thrown as it is and never read as a session end.
   */
  async currentRights(c: Caller, role: 'import' | 'download', studyUid: string | null, req: any | null): Promise<void> {
    if (process.env.AUTH_REQUIRED !== 'false') {
      if (req) await this.liveCredential(req, c);
      const row = await this.prisma.memberRights.findUnique({ where: { sub: c.sub } });
      const allowed = rightsAllow(row);
      this.role(allowed ? row.roles : [], role);
      inst({ ...c, institution: allowed && row.institution === c.institution ? c.institution : null });
    }
    if (studyUid !== null) await this.ownStudy(studyUid, c);
  }

  /**
   * The verified request's own credential, checked again through AuthService (never a new header as identity): the cookie
   * session must still exist under its admitted rights version (logout, idle end or a rights change end it); a bearer
   * token must still verify (signature, expiry) for the same subject and pass the provider-session end marks.
   */
  private async liveCredential(req: any, c: Caller): Promise<void> {
    const ended = () => new ForbiddenException(TRANSFER_MESSAGES.sessionEnded);
    const endedAnswer = (failure: unknown) => failure instanceof HttpException && failure.getStatus() === 401;
    if (req.authMethod === 'session') {
      if (!await this.auth.hasSession(req)) throw ended();
      return;
    }
    const header = String(req.headers?.authorization ?? '');
    if (!header.startsWith('Bearer ')) throw ended();
    const raw = header.slice(7);
    let payload: any;
    try { payload = await this.auth.verifyAccessToken(raw); }
    catch (failure) { if (endedAnswer(failure)) throw ended(); throw failure; }
    if (String(payload?.sub) !== c.sub) throw ended();
    try { await this.auth.bearerRights(payload, raw); }
    catch (failure) { if (endedAnswer(failure)) throw ended(); throw failure; }
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

  // ── the persisted download row (5.2) ──

  /** The stored row checked against its persisted format; a violation is 503 MANIFEST_STORE_INVALID, byte 0. */
  private storedDownload(op: any): StoredDownload {
    try { return checkDownloadRow(op); }
    catch (failure) { if (failure instanceof StoredFormatError) throw storeInvalid(); throw failure; }
  }

  private ownsDownload(op: any, owner: ImportOwner) {
    return op.kind === 'download' && op.ownerIssuer === owner.ownerIssuer && op.ownerSubject === owner.ownerSubject
      && op.institutionId === owner.institutionId;
  }

  private downloadView(op: any, stored: StoredDownload) {
    const attempts = stored.download.attempts;
    return { operationId: op.id, studyUid: op.studyUid, state: op.status, manifestSha256: op.manifestSha256, preparedAt: stored.download.preparedAt,
      objects: stored.manifest.objects.length, bytes: totalBytes(stored.manifest), note: op.status === 'sent' ? TRANSFER_MESSAGES.sent : null,
      attempts: attempts.map((a: any) => ({ attemptId: a.attemptId, number: a.number, state: a.state, startedAt: a.startedAt, endedAt: a.endedAt,
        archiveSha256: a.archiveSha256, responseFinished: a.responseFinished,
        objectsComplete: a.objects.filter((o: any) => o.complete).length, bytesSupplied: a.objects.reduce((n: number, o: any) => n + o.bytesSupplied, 0) })) };
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
    const built = await this.preparedManifest(uid);
    if (built.ok === false) throw error(409, built.code, built.message);
    const plan = planArchive(built.manifest);
    if (plan.ok === false) throw error(409, plan.code, plan.message);
    let answer: { replay: any } | { view: any };
    try {
      answer = await this.gate.write(async tx => {
        const found = await this.gate.lockOperation(tx, operationId);
        // Two POSTs of one id: the second sees the winner's committed row and replays it (contract 5.2 step 1).
        if (found) return { replay: found };
        const now = await this.gate.clock(tx);
        const download = { schemaVersion: 1, targetStudyUid: uid, destination: 'browser-download', preparedAt: now.toISOString(),
          manifestCanonical: built.manifestCanonical, attempts: [] as any[] };
        const row = { id: operationId, ...owner, kind: 'download', studyUid: uid, status: 'prepared', results: [],
          manifestSha256: built.manifestSha256, download, claimKey: null, claim: null };
        await tx.importOperation.create({ data: { ...row, createdAt: now, updatedAt: now } });
        await tx.auditLog.create({ data: { actor: owner.actor, action: 'original.download.prepare', target: uid,
          detail: JSON.stringify({ institutionId: owner.institutionId, operationId, studyUid: uid, manifestSha256: built.manifestSha256,
            objects: built.manifest.objects.length, bytes: totalBytes(built.manifest), ownerIssuer: owner.ownerIssuer,
            ownerSubject: owner.ownerSubject, at: now.toISOString() }) } });
        return { view: this.downloadView(row, this.storedDownload(row)) };
      });
    } catch (failure: any) {
      if (failure instanceof HttpException) throw failure;
      // A storage failure: the row may still have been written by the other request of the same id; replay it if so.
      const winner = await this.prisma.importOperation.findUnique({ where: { id: operationId } }).catch(() => null);
      if (winner) return this.replayPrepared(winner, owner, uid);
      throw downloadStorage();
    }
    return 'replay' in answer ? this.replayPrepared(answer.replay, owner, uid) : answer.view;
  }

  private replayPrepared(op: any, owner: ImportOwner, uid: string) {
    if (!this.ownsDownload(op, owner) || op.studyUid !== uid) throw error(409, 'OPERATION_CONFLICT', TRANSFER_MESSAGES.conflict);
    return this.downloadView(op, this.storedDownload(op));
  }

  /**
   * One complete reading of the study's originals: every instance id (Expand false) with its Study/Series/SOP UIDs and its
   * stored size/MD5. 'failed' when any read fails or answers outside its form; 'tooMany' above the ZIP32 object bound.
   */
  private async readOriginals(uid: string): Promise<{ kind: 'read'; objects: ManifestObjectInput[] } | { kind: 'failed' } | { kind: 'tooMany' }> {
    const ids = await this.gate.studyInstanceIds(uid, ORIGINAL_ARCHIVE_LIMITS.maxDicomObjects + 1);
    if (!ids) return { kind: 'failed' };
    if (ids.length > ORIGINAL_ARCHIVE_LIMITS.maxDicomObjects) return { kind: 'tooMany' };
    const objects: ManifestObjectInput[] = [];
    for (const orthancId of ids) {
      const uids = await this.gate.instanceUids(orthancId);
      if (!uids || uids.studyUid !== uid) return { kind: 'failed' };
      const info = await this.gate.attachmentInfo(orthancId);
      if (!info) return { kind: 'failed' };
      objects.push({ orthancId, seriesUid: uids.seriesUid, sopUid: uids.sopUid, bytes: info.bytes, md5: info.md5 });
    }
    return { kind: 'read', objects };
  }

  /**
   * 5.2 step 2: the originals read twice, completely (enumeration and every object's UIDs, size and MD5), and the manifest
   * made only when both readings are the same set with the same values (order alone may differ). Empty, unreadable,
   * malformed or changed between the two readings is MANIFEST_INCOMPLETE; more objects than ZIP32 allows ARCHIVE_TOO_LARGE.
   */
  private async preparedManifest(uid: string) {
    const incomplete = { ok: false as const, code: 'MANIFEST_INCOMPLETE', message: ORIGINAL_ARCHIVE_MESSAGES.MANIFEST_INCOMPLETE };
    const first = await this.readOriginals(uid);
    if (first.kind === 'tooMany') return { ok: false as const, code: 'ARCHIVE_TOO_LARGE', message: ORIGINAL_ARCHIVE_MESSAGES.ARCHIVE_TOO_LARGE };
    if (first.kind === 'failed' || first.objects.length === 0) return incomplete;
    const second = await this.readOriginals(uid);
    if (second.kind !== 'read' || sameSet(first.objects) !== sameSet(second.objects)) return incomplete;
    const built = canonicalManifest(uid, first.objects);
    return built.ok ? built : incomplete;
  }

  /**
   * 5.2 step 3 at every archive start: the originals now against the stored manifest (same sort, so order alone never
   * matters). A set or a value that differs - an empty set, more objects than ZIP32 allows and a duplicate included - is
   * 409 MANIFEST_CHANGED; originals that cannot be read completely are 409 MANIFEST_INCOMPLETE. Byte 0 either way.
   */
  private async unchangedOriginals(uid: string, stored: StoredDownload) {
    const now = await this.readOriginals(uid);
    if (now.kind === 'failed') throw error(409, 'MANIFEST_INCOMPLETE', ORIGINAL_ARCHIVE_MESSAGES.MANIFEST_INCOMPLETE);
    const built = now.kind === 'read' && now.objects.length ? canonicalManifest(uid, now.objects) : null;
    if (!built || !built.ok || built.manifestCanonical !== stored.manifestCanonical) throw error(409, 'MANIFEST_CHANGED', TRANSFER_MESSAGES.changed);
  }

  // ── GET /api/studies/:uid/original-downloads/:operationId ──

  async downloadStatus(uid: string, operationId: string, c: Caller) {
    const owner = this.owner(c, 'download');
    await this.gate.ready(false);
    const op = OPERATION_ID.test(operationId ?? '') ? await this.prisma.importOperation.findUnique({ where: { id: operationId.toLowerCase() } }) : null;
    if (!op || !this.ownsDownload(op, owner) || op.studyUid !== uid) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
    this.storedDownload(op);
    await this.expireDownloads(op.id);
    const fresh = await this.prisma.importOperation.findUnique({ where: { id: op.id } });
    return this.downloadView(fresh, this.storedDownload(fresh));
  }

  // ── GET /api/studies/:uid/original-downloads/:operationId/archive (5.2 steps 3-7) ──

  async archive(uid: string, operationId: string, req: any, res: any, c: Caller): Promise<void> {
    const owner = this.owner(c, 'download');
    await this.gate.ready(true);
    const op = OPERATION_ID.test(operationId ?? '') ? await this.prisma.importOperation.findUnique({ where: { id: operationId.toLowerCase() } }) : null;
    if (!op || !this.ownsDownload(op, owner) || op.studyUid !== uid) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
    await this.ownStudy(uid, c);
    const stored = this.storedDownload(op);
    const plan = planArchive(stored.manifest);
    if (plan.ok === false) throw error(409, plan.code, plan.message);
    if (op.status === 'sent') throw error(409, 'DOWNLOAD_ALREADY_SENT', TRANSFER_MESSAGES.alreadySent);
    await this.unchangedOriginals(uid, stored);
    await this.currentRights(c, 'download', uid, req);
    const attempt = await this.openAttempt(op.id, owner, stored);
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
    // Between chunks (a slow source or receiver) the lease is kept and the rights are re-read every 10 s; a loss stops it.
    const renew = setInterval(() => {
      void this.holdAttempt(op.id, attempt.attemptId, true)
        .then(kept => {
          if (!kept) { fenced = true; stop.abort(); return; }
          return this.currentRights(c, 'download', uid, req);
        })
        .catch(() => stop.abort());
    }, RENEW_MS);
    renew.unref?.();
    /*
     * 5.2 step 5 / step 6 / 5.3, immediately before every chunk (B-03): the attempt's CAS in the database - this attempt
     * is still the operation's last, still sending, and its lease is live by the database's time read after the row lock -
     * and the rights now (credential, member rights, own study, StudyAccess). No time window, no cached answer: each chunk
     * waits for both, each wait bounded by CHECK_BOUND_MS. A lost or unanswered CAS fences the attempt (Unconfirmed); lost
     * or unconfirmable rights cancel it, so the writer stops on its own signal before the chunk (Incomplete).
     */
    const confirm = async (): Promise<boolean> => {
      if (fenced) return false;
      if (stop.signal.aborted) return true;
      const kept = await bounded(this.holdAttempt(op.id, attempt.attemptId, false)).catch(() => false);
      if (!kept) { fenced = true; stop.abort(); return false; }
      const allowed = await bounded(this.currentRights(c, 'download', uid, req)).then(() => true, () => false);
      if (!allowed) stop.abort();
      return !fenced;
    };
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
        beforeWrite: confirm });
    } finally {
      clearTimeout(idle);
      clearInterval(renew);
      res.removeListener('close', lost);
    }
    await this.closeAttempt(op.id, owner, attempt.attemptId, result).catch(() => undefined);
  }

  /** The download row locked for a change, read after its lock with the database's time, in its persisted format. */
  private async lockDownload(tx: any, operationId: string) {
    const op = await this.gate.lockOperation(tx, operationId);
    const now = await this.gate.clock(tx);
    return { op, now, stored: op ? checkDownloadRow(op) : null };
  }

  /**
   * 5.2 step 5: one sending attempt per operation, its intent row committed before the first byte or nothing is sent. A
   * previous attempt whose sending lease ran out is closed Unconfirmed with its result row in the same transaction.
   */
  private async openAttempt(operationId: string, owner: ImportOwner, expected: StoredDownload) {
    try {
      return await this.gate.write(async tx => {
        const { op, now, stored } = await this.lockDownload(tx, operationId);
        if (!op || !this.ownsDownload(op, owner)) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
        if (stored!.manifestCanonical !== expected.manifestCanonical) throw error(409, 'MANIFEST_CHANGED', TRANSFER_MESSAGES.changed);
        if (op.status === 'sent') throw error(409, 'DOWNLOAD_ALREADY_SENT', TRANSFER_MESSAGES.alreadySent);
        const download = JSON.parse(JSON.stringify(stored!.download));
        const previous = download.attempts.length ? download.attempts[download.attempts.length - 1] : null;
        if (previous?.state === 'sending') {
          if (Date.parse(previous.leaseUntil) > now.getTime()) throw error(409, 'DOWNLOAD_IN_PROGRESS', TRANSFER_MESSAGES.inProgress);
          await this.expireSending(tx, op, previous, now);
        }
        const attempt = { attemptId: randomUUID(), number: download.attempts.length + 1, ownerSubject: owner.ownerSubject, actor: owner.actor,
          manifestSha256: op.manifestSha256, destination: 'browser-download', state: 'sending', startedAt: now.toISOString(), endedAt: null,
          ownerInstance: this.gate.bootId, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(), objects: [] as ArchiveObjectResult[],
          archiveSha256: null as string | null, responseFinished: false };
        download.attempts.push(attempt);
        await tx.importOperation.update({ where: { id: operationId }, data: { download, status: 'sending', updatedAt: now } });
        await tx.auditLog.create({ data: { actor: owner.actor, action: 'original.download.intent', target: op.studyUid,
          detail: JSON.stringify({ institutionId: op.institutionId, operationId, attemptId: attempt.attemptId, number: attempt.number,
            manifestSha256: op.manifestSha256, ownerIssuer: owner.ownerIssuer, ownerSubject: owner.ownerSubject, at: now.toISOString() }) } });
        return attempt;
      });
    } catch (failure) {
      if (failure instanceof HttpException) throw failure;
      if (failure instanceof StoredFormatError) throw storeInvalid();
      throw downloadStorage();
    }
  }

  /**
   * An expired sending attempt (its lease ran out by the database's time) closed in the caller's transaction: Unconfirmed
   * with its end time, its checkpoints exactly as they were (complete objects with full hashes; what was supplied after
   * the last checkpoint is unknown), and its own original.download.result row - written once, by whichever of the GET,
   * the startup pass or the next archive closes it first under the row lock.
   */
  private async expireSending(tx: any, op: any, attempt: any, now: Date) {
    attempt.state = 'unconfirmed';
    attempt.endedAt = now.toISOString();
    await tx.auditLog.create({ data: { actor: attempt.actor, action: 'original.download.result', target: op.studyUid,
      detail: JSON.stringify({ institutionId: op.institutionId, operationId: op.id, attemptId: attempt.attemptId, state: 'unconfirmed',
        manifestSha256: op.manifestSha256, archiveSha256: null, responseFinished: false, reason: 'lease-expired',
        objects: attempt.objects.map((o: ArchiveObjectResult) => ({ sopUid: o.sopUid, sha256: o.sha256, bytesSupplied: o.bytesSupplied, complete: o.complete })),
        at: now.toISOString() }) } });
  }

  /**
   * The attempt's CAS, in one short transaction: the row locked, then the database's time, then this attempt must still
   * be the last one, sending, with a live lease. The lease is renewed (DB now + 30 s) when asked or when less than
   * RENEW_BELOW_MS of it is left; otherwise nothing is written.
   */
  private holdAttempt(operationId: string, attemptId: string, renew: boolean): Promise<boolean> {
    return this.gate.write(async tx => {
      const rows: any[] = await tx.$queryRaw`SELECT status, download->'attempts'->-1->>'attemptId' AS "attemptId",
        download->'attempts'->-1->>'state' AS "state", download->'attempts'->-1->>'leaseUntil' AS "leaseUntil"
        FROM "ImportOperation" WHERE id = ${operationId}::uuid AND kind = 'download' FOR UPDATE`;
      const now = await this.gate.clock(tx);
      const last = rows[0];
      if (!last || last.status !== 'sending' || last.attemptId !== attemptId || last.state !== 'sending') return false;
      const left = Date.parse(last.leaseUntil) - now.getTime();
      if (!(left > 0)) return false;
      if (!renew && left >= RENEW_BELOW_MS) return true;
      const { op, stored } = await this.lockDownload(tx, operationId);
      const download = JSON.parse(JSON.stringify(stored!.download));
      download.attempts[download.attempts.length - 1].leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
      await tx.importOperation.update({ where: { id: op.id }, data: { download, updatedAt: now } });
      return true;
    });
  }

  /** 5.2 step 4: each completed object's result is committed (same CAS) before the next object starts; a loss stops it. */
  private async checkpoint(operationId: string, attemptId: string, done: ArchiveObjectResult): Promise<void> {
    const kept = await this.gate.write(async tx => {
      const { op, now, stored } = await this.lockDownload(tx, operationId);
      const download = JSON.parse(JSON.stringify(stored!.download));
      const mine = download.attempts[download.attempts.length - 1];
      if (!mine || mine.attemptId !== attemptId || mine.state !== 'sending' || Date.parse(mine.leaseUntil) <= now.getTime()) return false;
      mine.objects.push(done);
      mine.leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
      checkDownloadRow({ ...op, download });
      await tx.importOperation.update({ where: { id: op.id }, data: { download, updatedAt: now } });
      return true;
    });
    if (!kept) throw new Error('checkpoint fenced');
  }

  /**
   * 5.2 step 7 / B-04, under the same CAS as every chunk: Sent, responseFinished, the archive hash and the result row only
   * after the writer's own finish and while this attempt still holds a live lease. A lease that ran out by now closes it
   * Unconfirmed with its checkpoints as they were; a stop on its source, a length/MD5 mismatch, the receiver or a
   * cancellation is Incomplete with the writer's exact counters; a lost CAS or any other stop is Unconfirmed. An attempt
   * already closed by someone else (it was fenced) is left as it is: that close wrote its result row.
   */
  private async closeAttempt(operationId: string, owner: ImportOwner, attemptId: string, result: any) {
    await this.gate.write(async tx => {
      const { op, now, stored } = await this.lockDownload(tx, operationId);
      const download = JSON.parse(JSON.stringify(stored!.download));
      const mine = download.attempts[download.attempts.length - 1];
      if (!mine || mine.attemptId !== attemptId || mine.state !== 'sending') return;
      if (Date.parse(mine.leaseUntil) <= now.getTime()) {
        await this.expireSending(tx, op, mine, now);
      } else {
        const state = result?.state === 'finished' ? 'sent' : INCOMPLETE_REASONS.includes(result?.reason) ? 'incomplete' : 'unconfirmed';
        mine.state = state;
        mine.endedAt = now.toISOString();
        if (state !== 'unconfirmed' && Array.isArray(result?.objects)) mine.objects = result.objects;
        mine.archiveSha256 = state === 'sent' ? result.archiveSha256 : null;
        mine.responseFinished = state === 'sent';
        await tx.auditLog.create({ data: { actor: owner.actor, action: 'original.download.result', target: op.studyUid,
          detail: JSON.stringify({ institutionId: op.institutionId, operationId, attemptId, state, manifestSha256: op.manifestSha256,
            archiveSha256: mine.archiveSha256, responseFinished: mine.responseFinished, reason: result?.reason ?? null,
            objects: mine.objects.map((o: ArchiveObjectResult) => ({ sopUid: o.sopUid, sha256: o.sha256, bytesSupplied: o.bytesSupplied, complete: o.complete })),
            at: now.toISOString() }) } });
      }
      checkDownloadRow({ ...op, download, status: mine.state });
      await tx.importOperation.update({ where: { id: op.id }, data: { download, status: mine.state, updatedAt: now } });
    });
  }

  /**
   * Download attempts whose sending lease ran out (the GET of one operation, and the startup pass over all of them in
   * 500-row cursor batches): each closed Unconfirmed with its result row, in one transaction per operation. A row that is
   * not its persisted format, or a transaction that fails, is left as it is (its state stays what was committed).
   */
  async expireDownloads(operationId?: string): Promise<number> {
    let changed = 0, cursor: string | null = null;
    for (;;) {
      const where: any = operationId ? { id: operationId, kind: 'download' } : { kind: 'download', status: 'sending', ...(cursor ? { id: { gt: cursor } } : {}) };
      const page: any[] = await this.prisma.importOperation.findMany({ where, orderBy: { id: 'asc' }, take: 500 });
      for (const row of page) {
        await this.gate.write(async tx => {
          const { op, now, stored } = await this.lockDownload(tx, row.id);
          const download = JSON.parse(JSON.stringify(stored!.download));
          const last = download.attempts[download.attempts.length - 1];
          if (!last || last.state !== 'sending' || Date.parse(last.leaseUntil) > now.getTime()) return;
          await this.expireSending(tx, op, last, now);
          await tx.importOperation.update({ where: { id: op.id }, data: { download, status: 'unconfirmed', updatedAt: now } });
          changed++;
        }).catch(() => undefined);
      }
      if (operationId || page.length < 500 || this.stopping) break;
      cursor = page[page.length - 1].id;
    }
    return changed;
  }
}

/** A check before a chunk that does not answer within CHECK_BOUND_MS rejects; a late answer is ignored by the caller. */
function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('check deadline')), CHECK_BOUND_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** One reading's objects as a comparable text: the same set with the same values, whatever the enumeration order. */
function sameSet(objects: readonly ManifestObjectInput[]) {
  return JSON.stringify([...objects].sort((a, b) => (a.orthancId < b.orthancId ? -1 : a.orthancId > b.orthancId ? 1 : 0))
    .map(o => [o.orthancId, o.seriesUid, o.sopUid, o.bytes, o.md5]));
}

function totalBytes(manifest: OriginalManifest) {
  return manifest.objects.reduce((sum, o) => sum + o.bytes, 0);
}
