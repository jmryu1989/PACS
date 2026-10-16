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
import { DicomImportGateService, IMPORT_OBJECT_LIMIT, IMPORT_FILE_SLOTS, IMPORT_STORAGE_MESSAGE, StoredFormatError, exactKeys, precheckFile, storedTime } from './dicom-import-gate.service';
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
 * When a chunk's approval also renews the lease (to DB now + 30 s): with less than this left of it by the database's
 * time. Only a choice of when to renew; no safety argument rests on it (the approval holds the row lock through the
 * chunk's supply, see approve).
 */
const RENEW_BELOW_MS = 20000;
/**
 * Upper bound of each of an approval's two stages (the credential outside the lock; the locked transaction with the
 * supply up to its commit's answer), each as a whole on one monotonic deadline set before it starts - so both together
 * stay within 10 s: a stage that does not answer in time stops the archive, and a late answer supplies nothing.
 */
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
const IMPORT_NOT_FOUND = '반입 작업을 찾을 수 없습니다';
const importStorage = () => error(503, 'IMPORT_STORAGE_UNAVAILABLE', IMPORT_STORAGE_MESSAGE);
/** The routes' own 5xx answers, which pass through a storage mapping as they are (contract 4.8). */
const OWN_5XX = new Set(['IMPORT_NOT_READY', 'IMPORT_STORAGE_UNAVAILABLE', 'IMPORT_ISSUER_UNCONFIGURED', 'ORTHANC_UNAVAILABLE', 'MANIFEST_STORE_INVALID']);
/**
 * File results decided from the uploaded bytes or the study's ownership alone, before any reservation of a study the
 * caller owned: their UIDs are the caller's own file's, so a status GET shows them without a study check. Every other
 * result (anything with an attempt, a claim comparison, a pending holder) belongs to an own study and needs it now.
 */
const BEFORE_STUDY_CODES = new Set(['DICOM_NOT_PART10', 'DICOM_FILE_META_MISSING', 'DICOM_TRANSFER_SYNTAX_UNSUPPORTED', 'DICOM_MALFORMED',
  'PATIENT_ID_UNREADABLE', 'PATIENT_ID_MISSING', 'MODALITY_NOT_IMPORTABLE', 'STUDY_UID_MISMATCH', 'PATIENT_ISSUER_CONFLICT',
  'STUDY_OWNERSHIP_CONFLICT', 'STUDY_OWNERSHIP_UNDETERMINED', 'ORTHANC_UNAVAILABLE']);
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
      await this.memberRightsNow(this.prisma, c, role);
    }
    if (studyUid !== null) await this.ownStudy(studyUid, c);
  }

  /** The durable member rights the guard reads, read again on `db` (a transaction's own client when called in one). */
  private async memberRightsNow(db: any, c: Caller, role: 'import' | 'download' | 'recovery') {
    const row = await db.memberRights.findUnique({ where: { sub: c.sub } });
    const allowed = rightsAllow(row);
    this.role(allowed ? row.roles : [], role);
    inst({ ...c, institution: allowed && row.institution === c.institution ? c.institution : null });
  }

  /**
   * A study's own institution and the caller's StudyAccess, read in the caller's transaction under its locks: the
   * StudyState row held (FOR SHARE) so no move commits meanwhile, and StudyAccess through its shared policy lock on the
   * same transaction (its metadata, if a restricted policy needs any, prepared before the lock). Absent, foreign,
   * unassigned, tele-received and outside StudyAccess are one NotFoundException.
   */
  private async ownStudyLocked(tx: any, uid: string, c: Caller) {
    const rows: any[] = await tx.$queryRaw`SELECT "institutionId" FROM "StudyState" WHERE uid = ${uid} FOR SHARE`;
    if (!rows.length || rows[0].institutionId !== c.institution) throw new NotFoundException(TRANSFER_MESSAGES.notFound);
    await this.studyAccess.require(c, [uid], tx);
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
    // Every read before the intent maps a storage failure to 503 IMPORT_STORAGE_UNAVAILABLE (4.8); refusals keep their own.
    const institutions = await this.storageRead(() => this.gate.institutions(), importStorage);
    const precheck = precheckFile(readDicomPart10(bytes), typeof expected === 'string' ? expected : null, owner.institutionId, institutions);
    if (precheck.ok) await this.storageRead(async () => {
      // Request-level StudyAccess (contract 3): an existing own study must be inside the caller's scope (404); a
      // restricted account cannot open a new study (403). A foreign or unassigned study is the file's own 409 below.
      const state = await this.prisma.studyState.findUnique({ where: { uid: precheck.studyUid } });
      if (state && state.institutionId === owner.institutionId) await this.studyAccess.require(c, [precheck.studyUid]);
      else if (!state && (await this.studyAccess.snapshot(c)).policy.restricted)
        throw error(403, 'STUDY_ACCESS_RESTRICTED_IMPORT', TRANSFER_MESSAGES.restricted);
    }, importStorage);
    const answer = await this.gate.importFile({ owner, operationId: operationId.toLowerCase(), index: Number(indexText),
      expectedStudyUid: typeof expected === 'string' ? expected : null, bytes, sha256, precheck,
      recheck: async () => {
        // The request's own credential too: a logout, an ended provider session or an expired token before the dispatch
        // is a refusal here (403, IMPORT_PERMISSION_REVOKED, no POST /instances), never a write under a session that ended.
        await this.currentRights(c, 'import', null, req);
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
    if (!OPERATION_ID.test(operationId ?? '')) throw new NotFoundException(IMPORT_NOT_FOUND);
    const id = operationId.toLowerCase();
    const op = await this.gate.ownImport(owner, id);
    if (!op) throw new NotFoundException(IMPORT_NOT_FOUND);
    await this.importVisible(op, c);
    return this.gate.importStatus(owner, id, await this.gate.orthancAnswering());
  }

  /**
   * The status policy of contract 3 / 4.4, before any answer or reconciliation: the owner key alone is not enough. Every
   * study a file result depends on must now be the caller's institution's own (a study moved to another institution, a
   * tele-received one or a disposed one is not) and inside the caller's StudyAccess. If any is not, the whole operation
   * is the same 404 as an absent one, so no UID, hash or result of a study the caller cannot see leaves the server
   * (BEFORE_STUDY_CODES results carry only the caller's own file's values). Restored rights show the same result again.
   */
  private async importVisible(op: any, c: Caller) {
    const uids = [...new Set<string>((op.results as any[])
      .filter(e => e.studyUid && (e.attempts.length > 0 || !BEFORE_STUDY_CODES.has(e.code))).map(e => e.studyUid))];
    if (!uids.length) return;
    await this.storageRead(async () => {
      for (const uid of uids) {
        const state = await this.prisma.studyState.findUnique({ where: { uid } });
        if (!state || state.institutionId !== c.institution) throw new NotFoundException(IMPORT_NOT_FOUND);
      }
      const allowed = await this.studyAccess.allowed(c, uids);
      if (uids.some(uid => !allowed.has(uid))) throw new NotFoundException(IMPORT_NOT_FOUND);
    }, importStorage);
  }

  /**
   * A read before any intent or byte: a refusal (4xx) or one of the routes' own coded 5xx answers passes as it is; any other
   * failure - the database, the identity provider, StudyAccess unable to read its policy - becomes the route's storage
   * answer (503 IMPORT_STORAGE_UNAVAILABLE), never an uncoded 500 and never an upstream text.
   */
  private async storageRead<T>(work: () => Promise<T>, failure: () => HttpException): Promise<T> {
    try { return await work(); }
    catch (e) {
      if (e instanceof HttpException && (e.getStatus() < 500 || OWN_5XX.has((e.getResponse() as any)?.code))) throw e;
      throw failure();
    }
  }

  // ── POST /api/admin/dicom-import/:operationId/files/:index/recovery ──

  async recover(operationId: string, indexText: string, body: unknown, c: Caller) {
    const admin = this.owner(c, 'recovery');
    await this.gate.ready(true);
    if (!OPERATION_ID.test(operationId ?? '') || !FILE_INDEX.test(indexText ?? '') || Number(indexText) >= IMPORT_FILE_SLOTS)
      throw new NotFoundException(IMPORT_NOT_FOUND);
    const inReach: (studyUid: string) => Promise<void> = studyUid => this.recoveryScope(null, studyUid, c);
    const inReachLocked: (tx: any, studyUid: string) => Promise<void> = (tx, studyUid) => this.recoveryScope(tx, studyUid, c);
    return this.gate.recover(admin, operationId.toLowerCase(), Number(indexText), body, inReach, inReachLocked);
  }

  /**
   * Contract 3 / 4.4 for the admin recovery (U4BB2-02): the operation's institution and the admin role are not enough.
   * The target index's study must now be the admin's own institution's (its current StudyState; held FOR SHARE inside a
   * recovery transaction) and inside the admin's current StudyAccess; inside a transaction the admin's member rights are
   * read again too. Out of reach - absent, unassigned, moved, tele-received only, restricted - is the same 404 as an
   * absent operation or index; a store that cannot answer is 503 IMPORT_STORAGE_UNAVAILABLE, never a 404.
   */
  private async recoveryScope(tx: any | null, uid: string, c: Caller) {
    try {
      await this.storageRead(async () => {
        if (!tx) { await this.ownStudy(uid, c); return; }
        if (process.env.AUTH_REQUIRED !== 'false') await this.memberRightsNow(tx, c, 'recovery');
        await this.ownStudyLocked(tx, uid, c);
      }, importStorage);
    } catch (failure) {
      if (failure instanceof NotFoundException) throw new NotFoundException(IMPORT_NOT_FOUND);
      throw failure;
    }
  }

  // ── the persisted download row (5.2) ──

  /** The stored row checked against its persisted format; a violation is 503 MANIFEST_STORE_INVALID, byte 0. */
  private storedDownload(op: any): StoredDownload {
    try { return checkDownloadRow(op); }
    catch (failure) { if (failure instanceof StoredFormatError) throw storeInvalid(); throw failure; }
  }

  /**
   * An existing download operation's study now: its own StudyState and StudyAccess. A study the caller can no longer see
   * answers exactly as an absent operation does, so the answer never tells that the operation exists.
   */
  private async downloadStudyNow(uid: string, c: Caller) {
    try { await this.storageRead(() => this.ownStudy(uid, c), downloadStorage); }
    catch (failure) { if (failure instanceof NotFoundException) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound); throw failure; }
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
    await this.storageRead(() => this.ownStudy(uid, c), downloadStorage);
    const existing = await this.storageRead(() => this.prisma.importOperation.findUnique({ where: { id: operationId } }), downloadStorage);
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
    const op = OPERATION_ID.test(operationId ?? '') ? await this.storageRead(() => this.prisma.importOperation.findUnique({ where: { id: operationId.toLowerCase() } }), downloadStorage) : null;
    if (!op || !this.ownsDownload(op, owner) || op.studyUid !== uid) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
    // The study now (contract 3): still the institution's own and inside StudyAccess, else the same 404 as no operation.
    await this.downloadStudyNow(uid, c);
    this.storedDownload(op);
    await this.expireDownloads(op.id);
    const fresh = await this.storageRead(() => this.prisma.importOperation.findUnique({ where: { id: op.id } }), downloadStorage);
    return this.downloadView(fresh, this.storedDownload(fresh));
  }

  // ── GET /api/studies/:uid/original-downloads/:operationId/archive (5.2 steps 3-7) ──

  async archive(uid: string, operationId: string, req: any, res: any, c: Caller): Promise<void> {
    const owner = this.owner(c, 'download');
    await this.gate.ready(true);
    const op = OPERATION_ID.test(operationId ?? '') ? await this.storageRead(() => this.prisma.importOperation.findUnique({ where: { id: operationId.toLowerCase() } }), downloadStorage) : null;
    if (!op || !this.ownsDownload(op, owner) || op.studyUid !== uid) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
    await this.downloadStudyNow(uid, c);
    const stored = this.storedDownload(op);
    const plan = planArchive(stored.manifest);
    if (plan.ok === false) throw error(409, plan.code, plan.message);
    if (op.status === 'sent') throw error(409, 'DOWNLOAD_ALREADY_SENT', TRANSFER_MESSAGES.alreadySent);
    await this.unchangedOriginals(uid, stored);
    await this.storageRead(() => this.currentRights(c, 'download', uid, req), downloadStorage);
    const attempt = await this.openAttempt(op.id, owner, stored);
    // Everything is decided: headers, then bytes. From here no error becomes an HTTP status (5.2 step 6).
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="KIN-originals-${op.id.slice(0, 8)}.zip"`);
    res.setHeader('Content-Length', String(plan.plan.totalSize));
    res.setHeader('Cache-Control', 'no-store');
    const stop = new AbortController();
    const target: SupplyTarget = { operationId: op.id, attemptId: attempt.attemptId, number: attempt.number, uid, c, req, stop: null };
    let lastWritten = 0;
    const lost = () => { if (!res.writableFinished) stop.abort(); };
    res.once('close', lost);
    let idle = setTimeout(() => stop.abort(), NO_PROGRESS_MS);
    // Between chunks (a slow source or receiver) the same approval without a chunk every 10 s: it keeps the lease and
    // stops the archive on a lost right or a lost lease.
    const renew = setInterval(() => {
      void this.approve(target, null).then(verdict => { if (verdict) stop.abort(); });
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
        supplyGate: supply => this.approve(target, supply) });
    } finally {
      clearTimeout(idle);
      clearInterval(renew);
      res.removeListener('close', lost);
    }
    await this.closeAttempt(op.id, owner, attempt.attemptId, result, target).catch(() => undefined);
  }

  /**
   * 5.2 steps 5-6 / 5.3, contract 3 (U4BB2-01): the approval of one archive chunk, and that chunk's supply under it.
   *   1. Outside any lock, within CHECK_BOUND_MS: the request's own credential (AuthService), and the StudyAccess
   *      metadata a restricted policy needs.
   *   2. One short transaction, within CHECK_BOUND_MS as a whole up to its commit's answer, in the order every writer of
   *      the row uses: the operation's advisory lock, then its row; the member rights, the study's own institution (its
   *      StudyState held) and StudyAccess read in it; then the database's time and this attempt's place - still the last
   *      attempt (its id and number), sending, its lease live.
   *   3. While that row lock is still held, with no await after the last database answer: the stage's deadline and the
   *      attempt's stop reason are read, and `supply` runs once - the chunk's accounting and its sink.write.
   *   4. The transaction ends; the writer waits for the receiver's drain outside it. Source reads, Orthanc and the drain
   *      never hold the lock.
   * A fence (an expiry by GET or startup, a retry's new attempt) needs the same row lock: it commits either before step 2
   * reads the row - then nothing is supplied - or after the chunk was handed to the response. The order is the one in
   * which the server submits bytes to the response; bytes already submitted are not called back. Every chunk is approved
   * afresh: no time window, no answer kept from an earlier chunk.
   * Time (U4BB3-01): each stage runs on one monotonic deadline fixed before its work starts - stage 1 at start + 5 s,
   * stage 2 at its own start + 5 s (never past start + 10 s) - shared by everything it waits for; no read, renewal or
   * answer starts a new budget. Every completion (an answer, a refusal, a failure, a renewal without a chunk, the commit's
   * answer) is judged against it first, whether or not its timer could run: now >= deadline is expired. An expired stage
   * stops the attempt for good - stage 1 as a rights stop, stage 2 as an unknown approval - and its late answer is never
   * taken as one: no supply, no renewal, no next stage.
   * Verdicts: undefined - supplied (or, without a chunk, kept and renewed); 'fenced' - the attempt is no longer this
   * one's, its lease is gone, or the approval itself failed or ran past its bound (Unconfirmed; it wins over a lost
   * right); 'aborted' - the rights alone are refused or could not be confirmed in time (Incomplete). Either is the
   * attempt's permanent stop reason, read by every approval in flight; a later success never clears it.
   */
  private async approve(t: SupplyTarget, supply: (() => boolean) | null): Promise<StopReason | undefined> {
    if (t.stop) return t.stop;
    const start = performance.now();
    const credential = new ApprovalStage(t, start + CHECK_BOUND_MS, 'aborted');
    const prepared = await bounded(credential, () => this.rightsBeforeLock(t.c, t.uid, t.req)).then(() => true, () => false);
    // Where stage 1's answer is consumed: past this check only stage 2's own deadline counts.
    const first = credential.stopped();
    if (first) return first;
    if (!prepared) return stopAttempt(t, 'aborted');
    const locked = new ApprovalStage(t, Math.min(performance.now() + CHECK_BOUND_MS, start + 2 * CHECK_BOUND_MS), 'fenced');
    let verdict: StopReason | undefined;
    let unknown = false;
    try {
      verdict = await bounded(locked, () => this.supplyUnderLock(t, supply, locked));
    } catch (failure) {
      unknown = !(failure instanceof ApprovalStopped);
    }
    // The commit's answer - success, refusal or failure - counts only within stage 2's deadline.
    const second = locked.stopped();
    if (second) return second;
    if (unknown) return stopAttempt(t, 'fenced');
    return verdict ? stopAttempt(t, verdict) : undefined;
  }

  /** Approval step 1: the credential the guard admitted, still live; the StudyAccess metadata prepared before any lock. */
  private async rightsBeforeLock(c: Caller, uid: string, req: any) {
    if (process.env.AUTH_REQUIRED !== 'false' && req) await this.liveCredential(req, c);
    await this.studyAccess.prepare(c, [uid]);
  }

  /**
   * Approval steps 2-3 (see approve), on stage 2's deadline from the wait for a connection on. Back from each of its own
   * waits, before the next step or branch, the stage is checked: expired (or the attempt stopped by another approval)
   * throws, so the transaction - and any renewal in it - rolls back and nothing is supplied.
   */
  private supplyUnderLock(t: SupplyTarget, supply: (() => boolean) | null, stage: ApprovalStage): Promise<StopReason | undefined> {
    const live = () => { if (stage.stopped()) throw new ApprovalStopped(); };
    return this.gate.write(async tx => {
      live();
      await this.gate.lockOperationKey(tx, t.operationId);
      live();
      const rows: any[] = await tx.$queryRaw`SELECT status, download->'attempts'->-1->>'attemptId' AS "attemptId",
        download->'attempts'->-1->>'number' AS "number", download->'attempts'->-1->>'state' AS "state",
        download->'attempts'->-1->>'leaseUntil' AS "leaseUntil"
        FROM "ImportOperation" WHERE id = ${t.operationId}::uuid AND kind = 'download' FOR UPDATE`;
      live();
      let refused = false;
      try {
        if (process.env.AUTH_REQUIRED !== 'false') {
          await this.memberRightsNow(tx, t.c, 'download');
          live();
        }
        await this.ownStudyLocked(tx, t.uid, t.c);
      } catch (failure) {
        // A refusal (403/404, StudyAccess unable to confirm a changed scope) is the rights' answer; anything else leaves
        // this approval's database answer unknown.
        if (failure instanceof ApprovalStopped || !(failure instanceof HttpException) || failure.getStatus() >= 500) throw failure;
        refused = true;
      }
      // A refusal too counts only within the deadline: one that came late is an expired approval, not the rights' answer.
      live();
      const now = await this.gate.clock(tx);
      live();
      const last = rows[0];
      const left = last ? Date.parse(last.leaseUntil) - now.getTime() : NaN;
      if (!last || last.status !== 'sending' || last.attemptId !== t.attemptId || last.number !== String(t.number)
          || last.state !== 'sending' || !(left > 0)) return 'fenced';
      if (refused) return 'aborted';
      if (!supply || left < RENEW_BELOW_MS) {
        const { op, stored } = await this.lockDownload(tx, t.operationId);
        live();
        const download = JSON.parse(JSON.stringify(stored!.download));
        download.attempts[download.attempts.length - 1].leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
        await tx.importOperation.update({ where: { id: op.id }, data: { download, updatedAt: now } });
        live();
      }
      if (!supply) return undefined;
      // From the last database answer to the response: synchronous, under the row lock, no await in between.
      live();
      supply();
      return undefined;
    });
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
   * Unconfirmed with its checkpoints as they were; a lost or unknown approval (the attempt's stop reason `fenced`,
   * whatever the writer reported, its finish included) is Unconfirmed; a stop on its source, a length/MD5 mismatch, the
   * receiver, a cancellation or the rights is Incomplete with the writer's exact counters; any other stop is Unconfirmed.
   * An attempt already closed by someone else (it was fenced) is left as it is: that close wrote its result row.
   */
  private async closeAttempt(operationId: string, owner: ImportOwner, attemptId: string, result: any, t: SupplyTarget) {
    await this.gate.write(async tx => {
      const { op, now, stored } = await this.lockDownload(tx, operationId);
      // The stop reason as it is now, after this close's last wait: an approval still in flight may have set it meanwhile.
      const fenced = t.stop === 'fenced';
      const download = JSON.parse(JSON.stringify(stored!.download));
      const mine = download.attempts[download.attempts.length - 1];
      if (!mine || mine.attemptId !== attemptId || mine.state !== 'sending') return;
      if (Date.parse(mine.leaseUntil) <= now.getTime()) {
        await this.expireSending(tx, op, mine, now);
      } else {
        const state = fenced ? 'unconfirmed' : result?.state === 'finished' ? 'sent' : INCOMPLETE_REASONS.includes(result?.reason) ? 'incomplete' : 'unconfirmed';
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

/**
 * Why an attempt supplies nothing more: 'aborted' - the rights alone were refused or not confirmed in time (Incomplete);
 * 'fenced' - its lease or an approval was lost, failed or ran past its bound (Unconfirmed).
 */
type StopReason = 'aborted' | 'fenced';

/** The archive (one attempt) its approvals are for, with the attempt's permanent stop reason. */
interface SupplyTarget {
  operationId: string; attemptId: string; number: number; uid: string; c: Caller; req: any;
  /** Set by the first approval that finds one, read by every approval in flight, never cleared; a new attempt starts with none. */
  stop: StopReason | null;
}

/** Stops the attempt for good; 'fenced' always wins over 'aborted', whichever came first. */
function stopAttempt(t: SupplyTarget, reason: StopReason): StopReason {
  if (t.stop !== 'fenced') t.stop = reason;
  return t.stop;
}

/**
 * One stage of an approval: its monotonic deadline, fixed before its work starts and never moved, and its expiry - set
 * once, by the stage's timer or by the first completion that finds now >= deadline - which stops the attempt with the
 * stage's own reason (stage 1 'aborted', stage 2 'fenced').
 */
class ApprovalStage {
  private expired = false;
  constructor(private readonly t: SupplyTarget, readonly deadline: number, private readonly reason: StopReason) {}

  expire(): StopReason {
    this.expired = true;
    return stopAttempt(this.t, this.reason);
  }

  /** The first check of every completion of the stage: its expiry (read now, timer or not), else the attempt's stop reason. */
  stopped(): StopReason | null {
    if (this.expired || performance.now() >= this.deadline) return this.expire();
    return this.t.stop;
  }
}

/** Thrown where an approval finds its stage expired or its attempt stopped: inside a transaction, nothing of it commits. */
class ApprovalStopped extends Error {
  constructor() { super('approval stopped'); }
}

/**
 * Runs a stage's work within the stage's deadline. The timer is set before the work starts (so its synchronous part
 * counts too) for the time left, and expires the stage when it runs. The work's own answer - a value or a failure - is
 * checked against the stage first, so an answer after the deadline is never taken as one, also when a stalled event loop
 * runs it before the timer. A late answer is not cancelled: it is still consumed here, and the work's own checks keep
 * it from supplying or renewing anything.
 */
function bounded<T>(stage: ApprovalStage, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { stage.expire(); reject(new ApprovalStopped()); }, Math.max(0, stage.deadline - performance.now()));
  });
  const answer = new Promise<T>(resolve => resolve(work())).then(
    value => { if (stage.stopped()) throw new ApprovalStopped(); return value; },
    failure => { if (stage.stopped()) throw new ApprovalStopped(); throw failure; });
  return Promise.race([answer, expiry]).finally(() => clearTimeout(timer));
}

/** One reading's objects as a comparable text: the same set with the same values, whatever the enumeration order. */
function sameSet(objects: readonly ManifestObjectInput[]) {
  return JSON.stringify([...objects].sort((a, b) => (a.orthancId < b.orthancId ? -1 : a.orthancId > b.orthancId ? 1 : 0))
    .map(o => [o.orthancId, o.seriesUid, o.sopUid, o.bytes, o.md5]));
}

function totalBytes(manifest: OriginalManifest) {
  return manifest.objects.reduce((sum, o) => sum + o.bytes, 0);
}
