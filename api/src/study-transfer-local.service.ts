/*
 * S9-U4b self-institution DICOM import and original download (contract S9-U4p 3, 4.4, 4.6, 4.8, 5.2-5.3, 6).
 *
 * The routes' own rules: who may call (need/inst, the verified issuer and subject as the owner key, StudyAccess), the
 * request shape, readiness, and the original download (fixed manifest, ZIP32 plan, one sending attempt at a time, headers
 * before the first byte, per-object checkpoints, no byte after a lost right or a lost lease). Every import write goes
 * through DicomImportGateService. A refusal never names another institution's study, a patient value or an upstream body.
 */
import { ForbiddenException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { AuthService, authRefusal } from './auth.service';
import { need, inst } from './pacs/access';
import type { Caller } from './pacs/access';
import { rightsAllow } from './member-rights';
import { readDicomPart10 } from './dicom-part10-reader';
import { canonicalManifest, parseCanonicalManifest, planArchive, writeArchive, ORIGINAL_ARCHIVE_LIMITS, ORIGINAL_ARCHIVE_MESSAGES } from './original-archive';
import type { ArchiveObjectResult, ManifestObjectInput, OriginalManifest } from './original-archive';
import { DicomImportGateService, IMPORT_OBJECT_LIMIT, IMPORT_FILE_SLOTS, IMPORT_STORAGE_MESSAGE, StoredFormatError, exactKeys, precheckFile, storedTime } from './dicom-import-gate.service';
import type { ImportOwner } from './dicom-import-gate.service';
import type { RequestWorkContext } from './emr-runtime/request-context';
import type { EmrRecordTransaction } from './emr-runtime/record-port';
import type { RecordMutation } from './emr-runtime/store';
import { newAuditLinkId } from './emr-contract/access-event';
import type { OriginalDownloadAccessEventV2 } from './emr-contract/access-event';

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
/**
 * Grant issuance remains compatible with existing clients and stored rows. Archive GET now checks the cookie session
 * and operation owner directly; it neither admits nor consumes this value. Retain historical uses/refusals as recorded.
 * The 120 s timestamp is issuance metadata only; its passage does not expire a download or change its reported result.
 */
const GRANT_TTL_MS = 120000;
const GRANT_ROUTE = 'original-archive';
const GRANT_STATES = ['issued', 'refused'];
/** The archive GET's Nest route key (clinician-policy routeKey of its METHOD/PATH metadata): the only grant route. */
export const ARCHIVE_ROUTE_KEY = 'GET studies/:uid/original-downloads/:operationId/archive';
/** Download JSON format 2 = format 1 plus the grant fields; 1 is still read as it is and becomes 2 at the first issue. */
const DOWNLOAD_KEYS_V2 = [...DOWNLOAD_KEYS, 'activeArchiveGrant', 'archiveGrantUses'];
const GRANT_BIND_KEYS = ['grantId', 'hash', 'sessionRef', 'ownerIssuer', 'ownerSubject', 'institutionId', 'operationId', 'studyUid',
  'manifestSha256', 'method', 'route', 'issuedAt', 'expiresAt'];
const ACTIVE_GRANT_KEYS = [...GRANT_BIND_KEYS, 'state', 'refusal'];
const GRANT_USE_KEYS = [...GRANT_BIND_KEYS, 'admittedAt', 'consumedAt', 'attemptId'];
const grantHash = (raw: string) => createHash('sha256').update('kin-original-download-grant-v1:' + raw).digest('hex');

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
  /** The status read's own storage answer: it starts nothing, and says nothing of what earlier attempts supplied. */
  statusStorage: '원본 다운로드 기록을 읽지 못했습니다. 이 작업의 상태를 잠시 뒤 다시 확인하세요.',
  sent: '서버가 이 검사의 모든 원본을 보냈습니다. 내 컴퓨터에 저장됐는지는 브라우저의 다운로드 목록에서 확인하세요.',
  grantSession: '원본 내려받기 권한은 로그인한 브라우저 화면에서만 받을 수 있습니다.',
  grantOrigin: '이 화면에서 시작한 내려받기만 받을 수 있습니다. 화면의 Download 단추로 다시 시도하세요.',
  grantInvalid: '내려받기 권한이 맞지 않습니다. 화면의 Download 단추로 다시 시도하세요.',
  grantExpired: '내려받기 권한의 사용 시간이 지났습니다. 화면의 Download 단추로 다시 시도하세요.',
  grantConsumed: '이미 사용한 내려받기 권한입니다. 상태를 확인한 뒤 화면의 Download 단추로 다시 시도하세요.',
  grantRefused: '내려받기를 시작하지 못했습니다. 상태를 확인한 뒤 다시 시도하세요.',
  methodNotAllowed: '원본 내려받기는 GET 요청으로만 받을 수 있습니다.',
});

/** The refusal codes a grant may be closed with or shown under, and their Korean answer (the archive's own codes reused). */
const GRANT_CODE_MESSAGES: Record<string, string> = {
  DOWNLOAD_GRANT_EXPIRED: TRANSFER_MESSAGES.grantExpired, DOWNLOAD_GRANT_INVALID: TRANSFER_MESSAGES.grantInvalid,
  DOWNLOAD_GRANT_CONSUMED: TRANSFER_MESSAGES.grantConsumed, MANIFEST_CHANGED: TRANSFER_MESSAGES.changed,
  DOWNLOAD_ALREADY_SENT: TRANSFER_MESSAGES.alreadySent, DOWNLOAD_IN_PROGRESS: TRANSFER_MESSAGES.inProgress,
};

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
const statusStorage = () => error(503, 'IMPORT_STORAGE_UNAVAILABLE', TRANSFER_MESSAGES.statusStorage);
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
  const v2 = d?.schemaVersion === 2;
  const keys = v2 ? DOWNLOAD_KEYS_V2 : DOWNLOAD_KEYS;
  // Older prepared operations have no retained source-subject observation.
  const hasSourcePatients = d && Object.prototype.hasOwnProperty.call(d, 'sourcePatientIds');
  if (!exactKeys(d, hasSourcePatients ? [...keys, 'sourcePatientIds'] : keys) || (d.schemaVersion !== 1 && !v2) || d.targetStudyUid !== op.studyUid
      || d.destination !== 'browser-download' || !storedTime(d.preparedAt) || !Array.isArray(d.attempts)) fail();
  if (hasSourcePatients && (!Array.isArray(d.sourcePatientIds) || !d.sourcePatientIds.length
      || d.sourcePatientIds.some((id: unknown) => id !== null && !(typeof id === 'string' && id.trim())))) fail();
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
  if (v2) checkGrants(op, d, seen, fail);
  return { download: d, manifest, manifestCanonical: d.manifestCanonical, manifestSha256: op.manifestSha256 };
}

/**
 * Format 2's grant fields: at most one active grant (issued, or closed as refused with its code and time) and the uses
 * appended at consumption, each bound to this row's owner, operation, study and manifest, with a 120 s window, unique
 * grant ids and hashes, and a use naming one of this row's attempts. Anything else is a format violation.
 */
function checkGrants(op: any, d: any, attempts: Set<string>, fail: () => never) {
  const ids = new Set<string>(), hashes = new Set<string>();
  const bound = (g: any) => {
    if (typeof g.grantId !== 'string' || !UUID_TEXT.test(g.grantId) || ids.has(g.grantId) || typeof g.hash !== 'string' || !HEX64.test(g.hash)
        || hashes.has(g.hash) || !text(g.sessionRef, 256) || g.ownerIssuer !== op.ownerIssuer || g.ownerSubject !== op.ownerSubject
        || g.institutionId !== op.institutionId || g.operationId !== op.id || g.studyUid !== op.studyUid || g.manifestSha256 !== op.manifestSha256
        || g.method !== 'GET' || g.route !== GRANT_ROUTE || !storedTime(g.issuedAt) || !storedTime(g.expiresAt)
        || Date.parse(g.expiresAt) - Date.parse(g.issuedAt) !== GRANT_TTL_MS) fail();
    ids.add(g.grantId);
    hashes.add(g.hash);
  };
  if (!Array.isArray(d.archiveGrantUses)) fail();
  for (const u of d.archiveGrantUses) {
    if (!exactKeys(u, GRANT_USE_KEYS)) fail();
    bound(u);
    if (!storedTime(u.admittedAt) || !storedTime(u.consumedAt) || typeof u.attemptId !== 'string' || !attempts.has(u.attemptId)
        || Date.parse(u.admittedAt) >= Date.parse(u.expiresAt) || Date.parse(u.consumedAt) < Date.parse(u.admittedAt)) fail();
  }
  const a = d.activeArchiveGrant;
  if (a === null) return;
  if (!exactKeys(a, ACTIVE_GRANT_KEYS) || !GRANT_STATES.includes(a.state)) fail();
  bound(a);
  if (a.state === 'issued' ? a.refusal !== null
    : !(exactKeys(a.refusal, ['code', 'at']) && text(a.refusal.code, 64) && storedTime(a.refusal.at))) fail();
}

/** What the status read shows of the latest archive request: never the raw value, its hash or the session reference. */
function archiveRequestView(d: any) {
  if (d.schemaVersion !== 2) return null;
  const a = d.activeArchiveGrant;
  if (a) {
    const code = a.state === 'refused' ? a.refusal.code : null;
    return { grantId: a.grantId, state: a.state, expiresAt: a.expiresAt,
      attemptId: null, code, message: code ? GRANT_CODE_MESSAGES[code] ?? TRANSFER_MESSAGES.grantRefused : null };
  }
  const u = d.archiveGrantUses[d.archiveGrantUses.length - 1];
  return u ? { grantId: u.grantId, state: 'consumed', expiresAt: u.expiresAt, attemptId: u.attemptId, code: null, message: null } : null;
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
        if (process.env.AUTH_REQUIRED !== 'false') await this.recoveryRightsNow(tx, c);
        await this.ownStudyLocked(tx, uid, c);
      }, importStorage);
    } catch (failure) {
      if (failure instanceof NotFoundException) throw new NotFoundException(IMPORT_NOT_FOUND);
      throw failure;
    }
  }

  /**
   * The admin's durable member rights read again inside a recovery transaction (U4BB3-03): a lost admin role or a
   * disabled account is the existing 403; an admin whose current institution is now another one no longer reaches this
   * institution's operation - the same 404 as an absent one, never the "no institution" refusal.
   */
  private async recoveryRightsNow(tx: any, c: Caller) {
    const row = await tx.memberRights.findUnique({ where: { sub: c.sub } });
    const allowed = rightsAllow(row);
    this.role(allowed ? row.roles : [], 'recovery');
    if (typeof row.institution === 'string' && row.institution && row.institution !== c.institution) throw new NotFoundException(IMPORT_NOT_FOUND);
    inst({ ...c, institution: row.institution === c.institution ? c.institution : null });
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
  private async downloadStudyNow(uid: string, c: Caller, failure: () => HttpException = downloadStorage) {
    try { await this.storageRead(() => this.ownStudy(uid, c), failure); }
    catch (failure) { if (failure instanceof NotFoundException) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound); throw failure; }
  }

  private ownsDownload(op: any, owner: ImportOwner) {
    return op.kind === 'download' && op.ownerIssuer === owner.ownerIssuer && op.ownerSubject === owner.ownerSubject
      && op.institutionId === owner.institutionId;
  }

  private downloadView(op: any, stored: StoredDownload, now: Date | null = null) {
    const attempts = stored.download.attempts;
    return { operationId: op.id, studyUid: op.studyUid, state: op.status, manifestSha256: op.manifestSha256, preparedAt: stored.download.preparedAt,
      objects: stored.manifest.objects.length, bytes: totalBytes(stored.manifest), note: op.status === 'sent' ? TRANSFER_MESSAGES.sent : null,
      attempts: attempts.map((a: any) => ({ attemptId: a.attemptId, number: a.number, state: a.state, startedAt: a.startedAt, endedAt: a.endedAt,
        archiveSha256: a.archiveSha256, responseFinished: a.responseFinished,
        objectsComplete: a.objects.filter((o: any) => o.complete).length, bytesSupplied: a.objects.reduce((n: number, o: any) => n + o.bytesSupplied, 0) })),
      archiveRequest: archiveRequestView(stored.download) };
  }

  // ── POST /api/studies/:uid/original-downloads (contract 5.2 steps 1-2) ──

  private downloadWrite<T>(request: RequestWorkContext,
    task: (tx: EmrRecordTransaction, record: RecordMutation) => Promise<T>): Promise<T> {
    // Keep the download gate's existing transaction bounds. B2 owns the same
    // transaction so a ledger failure rolls back the stage and its AuditLog row.
    return request.work.transactionWithRecords(task, { maxWait: 4000, timeout: 8000 });
  }

  private async downloadAudit(tx: EmrRecordTransaction, record: RecordMutation, request: RequestWorkContext,
    download: { sourcePatientIds?: readonly (string | null)[] },
    action: OriginalDownloadAccessEventV2['action'], audit: { actor: string; action: string; target: string; detail: string },
    eventId = randomUUID(), relatedEventId: string | null = null) {
    const detail = JSON.parse(audit.detail), facts = request.facts;
    const known = <T>(value: T) => ({ status: 'known' as const, value });
    // Retain the preparation's observations even after the source is unavailable; these are not formal PatientLinks.
    const notObserved = { status: 'unresolved' as const, reason: 'not-observed' as const };
    const event: OriginalDownloadAccessEventV2 = {
      formatVersion: 2, branch: 'original-download', surface: facts.surface, eventId,
      userId: known(facts.actor), rolesAtTime: known(facts.roles), actingInstitution: known(facts.institution),
      rightsVersion: facts.rightsVersion, session: facts.binding,
      managingInstitution: known(detail.institutionId), occurredAt: detail.at, trustedProxyIp: facts.ingress,
      cause: 'user-view', executor: 'member', targets: (download.sourcePatientIds ?? [null]).map(sourcePatientId => ({ kind: 'download', studyId: known(audit.target),
        recordId: known(detail.operationId), versionId: known(detail.manifestSha256),
        sourcePatientId: sourcePatientId === null ? notObserved : known(sourcePatientId), sourceInstitution: notObserved,
        projectionSha256: detail.manifestSha256 })),
      action, result: action === 'provide-prepared' ? 'prepared' : action === 'transfer-aborted' ? 'aborted' :
        action === 'permission-refused' ? 'refused' : action === 'conflict' ? 'failed' : 'succeeded',
      requestId: facts.requestId, auditLinkId: newAuditLinkId(), relatedEventId,
    };
    // Admin's existing audit report still reads these rows. B2 records their
    // projection in this transaction instead of creating a second success log.
    await record(event, async () => {
      const row = await tx.auditLog.create({ data: audit });
      return { kind: 'AuditLog', id: String(row.id), version: null };
    });
  }

  async prepareDownload(uid: string, body: unknown, c: Caller, request: RequestWorkContext) {
    const owner = this.owner(c, 'download');
    await this.gate.ready(true);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'operationId'
        || typeof (body as any).operationId !== 'string' || !OPERATION_ID.test((body as any).operationId))
      throw error(400, 'IMPORT_REQUEST_INVALID', TRANSFER_MESSAGES.request);
    const operationId = (body as any).operationId.toLowerCase();
    await this.storageRead(() => this.ownStudy(uid, c), downloadStorage);
    // A preparation and its replay alike: no download of a Study UID two original resources answer (WORKLIST-SPLIT-UID).
    await this.unsplitSource(uid, c);
    const existing = await this.storageRead(() => this.prisma.importOperation.findUnique({ where: { id: operationId } }), downloadStorage);
    if (existing) return this.replayPrepared(existing, owner, uid);
    const built = await this.preparedManifest(uid);
    if (built.ok === false) throw error(409, built.code, built.message);
    const plan = planArchive(built.manifest);
    if (plan.ok === false) throw error(409, plan.code, plan.message);
    let answer: { replay: any } | { view: any };
    try {
      answer = await this.downloadWrite(request, async (tx, record) => {
        await request.requireCurrent(tx);
        const found = await this.gate.lockOperation(tx, operationId);
        // Two POSTs of one id: the second sees the winner's committed row and replays it (contract 5.2 step 1).
        if (found) return { replay: found };
        const now = await this.gate.clock(tx);
        const download = { schemaVersion: 1, targetStudyUid: uid, destination: 'browser-download', preparedAt: now.toISOString(),
          manifestCanonical: built.manifestCanonical, sourcePatientIds: built.sourcePatientIds, attempts: [] as any[] };
        // claimKey and claim are left out, so both are the columns' SQL NULL that the kind check requires of a download
        // (U4BL-02): a literal null on the JSONB claim is written as the JSON null value, which is not NULL. The answer is
        // made from the row the database returned, which reads both back as null.
        const row = await tx.importOperation.create({ data: { id: operationId, ...owner, kind: 'download', studyUid: uid, status: 'prepared',
          results: [], manifestSha256: built.manifestSha256, download, createdAt: now, updatedAt: now } });
        await this.downloadAudit(tx, record, request, download, 'provide-prepared', { actor: owner.actor, action: 'original.download.prepare', target: uid,
          detail: JSON.stringify({ institutionId: owner.institutionId, operationId, studyUid: uid, manifestSha256: built.manifestSha256,
            objects: built.manifest.objects.length, bytes: totalBytes(built.manifest), ownerIssuer: owner.ownerIssuer,
            ownerSubject: owner.ownerSubject, at: now.toISOString() }) });
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

  /**
   * WORKLIST-SPLIT-UID for the download routes: the source observed for this request, outside any lock and after the
   * scope checks (which keep their own answers and never tell a split): 409 STUDY_IDENTITY_UNRESOLVED when two or more
   * original resources answer the UID, 503 STUDY_SOURCE_UNAVAILABLE when it could not be observed. Nothing is prepared
   * or sent then. The import path does not call it: its own identity gate decides (EXISTING_STUDY_IDENTITY_UNRESOLVED).
   */
  private async unsplitSource(uid: string, c: Caller) {
    await this.studyAccess.prepareSourceIdentity(c, [uid]);
    this.studyAccess.assertUnsplitSource(c, uid);
  }

  private replayPrepared(op: any, owner: ImportOwner, uid: string) {
    if (!this.ownsDownload(op, owner) || op.studyUid !== uid) throw error(409, 'OPERATION_CONFLICT', TRANSFER_MESSAGES.conflict);
    return this.downloadView(op, this.storedDownload(op));
  }

  /**
   * One complete reading of the study's originals: every instance id (Expand false) with its Study/Series/SOP UIDs and its
   * stored size/MD5. 'failed' when any read fails or answers outside its form; 'tooMany' above the ZIP32 object bound.
   */
  private async readOriginals(uid: string): Promise<{ kind: 'read'; objects: ManifestObjectInput[]; sourcePatientIds: (string | null)[] } | { kind: 'failed' } | { kind: 'tooMany' }> {
    const ids = await this.gate.studyInstanceIds(uid, ORIGINAL_ARCHIVE_LIMITS.maxDicomObjects + 1);
    if (!ids) return { kind: 'failed' };
    if (ids.length > ORIGINAL_ARCHIVE_LIMITS.maxDicomObjects) return { kind: 'tooMany' };
    const objects: ManifestObjectInput[] = [];
    const sourcePatientIds = new Set<string | null>();
    for (const orthancId of ids) {
      const uids = await this.gate.instanceUids(orthancId);
      if (!uids || uids.studyUid !== uid) return { kind: 'failed' };
      const info = await this.gate.attachmentInfo(orthancId);
      if (!info) return { kind: 'failed' };
      objects.push({ orthancId, seriesUid: uids.seriesUid, sopUid: uids.sopUid, bytes: info.bytes, md5: info.md5 });
      sourcePatientIds.add(uids.sourcePatientId);
    }
    return { kind: 'read', objects, sourcePatientIds: [...sourcePatientIds] };
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
    // Both reads processed these subjects. Preserve every observed ID without inventing a patient match.
    return built.ok ? { ...built, sourcePatientIds: [...new Set([...first.sourcePatientIds, ...second.sourcePatientIds])] } : incomplete;
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
    const op = OPERATION_ID.test(operationId ?? '') ? await this.storageRead(() => this.prisma.importOperation.findUnique({ where: { id: operationId.toLowerCase() } }), statusStorage) : null;
    if (!op || !this.ownsDownload(op, owner) || op.studyUid !== uid) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
    // The study now (contract 3): still the institution's own and inside StudyAccess, else the same 404 as no operation.
    await this.downloadStudyNow(uid, c, statusStorage);
    this.storedDownload(op);
    // The expiry scan is a read before the answer too (U4BB3-04): a store that cannot answer is the status route's own
    // storage answer, never an uncoded 500; what was committed (attempts, checkpoints) stays as it was.
    await this.storageRead(() => this.expireDownloads(op.id), statusStorage);
    const fresh = await this.storageRead(() => this.prisma.importOperation.findUnique({ where: { id: op.id } }), statusStorage);
    const now = await this.storageRead(() => this.gate.dbNow(), statusStorage);
    return this.downloadView(fresh, this.storedDownload(fresh), now);
  }

  // ── POST /api/studies/:uid/original-downloads/:operationId/archive/grant (D1489, consult option A) ──

  /**
   * One grant for the browser's own archive GET, issued only to a bound cookie session (the request passed the guard's
   * binding check; a bearer caller needs none and gets none), for the owner's own download operation that may
   * start now (Ready, Incomplete or Unconfirmed; an expired sending attempt is reconciled first), with the rights now.
   * Format 1 becomes format 2 in this transaction; an unused grant of the operation is replaced. The answer is no-store
   * (the controller) and the raw value appears nowhere else - not in the row, the audit or a log.
   */
  async issueArchiveGrant(uid: string, operationId: string, body: unknown, req: any, c: Caller, request: RequestWorkContext) {
    if (req?.authMethod !== 'session' || !text(req.sessionId, 256))
      throw error(403, 'DOWNLOAD_GRANT_SESSION_REQUIRED', TRANSFER_MESSAGES.grantSession);
    const owner = this.owner(c, 'download');
    await this.gate.ready(true);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0)
      throw error(400, 'IMPORT_REQUEST_INVALID', TRANSFER_MESSAGES.request);
    const found = OPERATION_ID.test(operationId ?? '') ? await this.storageRead(() => this.prisma.importOperation.findUnique({ where: { id: operationId.toLowerCase() } }), downloadStorage) : null;
    if (!found || !this.ownsDownload(found, owner) || found.studyUid !== uid) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
    await this.downloadStudyNow(uid, c);
    this.storedDownload(found);
    await this.storageRead(() => this.expireDownloads(found.id), downloadStorage);
    await this.storageRead(() => this.currentRights(c, 'download', uid, req), downloadStorage);
    try {
      return await this.downloadWrite(request, async (tx, record) => {
        await request.requireCurrent(tx);
        const { op, now, stored } = await this.lockDownload(tx, found.id);
        if (!op || !this.ownsDownload(op, owner) || op.studyUid !== uid) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
        if (op.status === 'sent') throw error(409, 'DOWNLOAD_ALREADY_SENT', TRANSFER_MESSAGES.alreadySent);
        if (op.status === 'sending') throw error(409, 'DOWNLOAD_IN_PROGRESS', TRANSFER_MESSAGES.inProgress);
        const download = JSON.parse(JSON.stringify(stored!.download));
        if (download.schemaVersion === 1) Object.assign(download, { schemaVersion: 2, activeArchiveGrant: null, archiveGrantUses: [] });
        const replaced = download.activeArchiveGrant?.state === 'issued' ? download.activeArchiveGrant.grantId : null;
        const raw = randomBytes(32).toString('base64url');
        const grant = { grantId: randomUUID(), hash: grantHash(raw), sessionRef: req.sessionId, ownerIssuer: owner.ownerIssuer,
          ownerSubject: owner.ownerSubject, institutionId: op.institutionId, operationId: op.id, studyUid: uid, manifestSha256: op.manifestSha256,
          method: 'GET', route: GRANT_ROUTE, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + GRANT_TTL_MS).toISOString(),
          state: 'issued', refusal: null };
        download.activeArchiveGrant = grant;
        checkDownloadRow({ ...op, download });
        await tx.importOperation.update({ where: { id: op.id }, data: { download, updatedAt: now } });
        await this.downloadAudit(tx, record, request, download, 'provide-prepared', { actor: owner.actor, action: 'original.download.grant', target: uid,
          detail: JSON.stringify({ institutionId: op.institutionId, phase: 'issued', operationId: op.id, studyUid: uid, grantId: grant.grantId,
            grantHash: grant.hash, sessionRef: grant.sessionRef, ownerIssuer: owner.ownerIssuer, ownerSubject: owner.ownerSubject,
            manifestSha256: op.manifestSha256, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt, replacedGrantId: replaced,
            authMethod: 'session', bindingMethod: 'session-header', at: now.toISOString() }) });
        return { operationId: op.id, grantId: grant.grantId, grant: raw, expiresAt: grant.expiresAt };
      });
    } catch (failure) {
      if (failure instanceof HttpException) throw failure;
      if (failure instanceof StoredFormatError) throw storeInvalid();
      throw downloadStorage();
    }
  }

  /** A refused start has no supply attempt; retain its access record independently of the retired grant check. */
  private async refuseDownload(operationId: string, owner: ImportOwner, uid: string, code: string,
    status: number, request: RequestWorkContext) {
    await this.downloadWrite(request, async (tx, record) => {
      const { op, now, stored } = await this.lockDownload(tx, operationId);
      if (!op || !this.ownsDownload(op, owner) || op.studyUid !== uid) return;
      await this.downloadAudit(tx, record, request, stored!.download, status === 409 ? 'conflict' : 'permission-refused',
        { actor: owner.actor, action: 'original.download.refused', target: op.studyUid,
          detail: JSON.stringify({ institutionId: op.institutionId, operationId: op.id, studyUid: op.studyUid,
            ownerIssuer: owner.ownerIssuer, ownerSubject: owner.ownerSubject, manifestSha256: op.manifestSha256,
            code, at: now.toISOString() }) });
    });
  }

  // ── GET /api/studies/:uid/original-downloads/:operationId/archive (5.2 steps 3-7) ──

  async archive(uid: string, operationId: string, req: any, res: any, c: Caller, request: RequestWorkContext): Promise<void> {
    // Express maps HEAD to a GET handler: a HEAD starts no supply.
    if (req.method !== 'GET') throw error(405, 'DOWNLOAD_METHOD_NOT_ALLOWED', TRANSFER_MESSAGES.methodNotAllowed);
    const owner = this.owner(c, 'download');
    await this.gate.ready(true);
    const op = OPERATION_ID.test(operationId ?? '') ? await this.storageRead(() => this.prisma.importOperation.findUnique({ where: { id: operationId.toLowerCase() } }), downloadStorage) : null;
    const refused = async (failure: unknown) => {
      if (op && this.ownsDownload(op, owner) && op.studyUid === uid && failure instanceof HttpException
          && [403, 404, 409].includes(failure.getStatus())) {
        const code = String((failure.getResponse() as any)?.code ?? 'HTTP_' + failure.getStatus());
        await this.refuseDownload(op.id, owner, uid, code, failure.getStatus(), request).catch(() => undefined);
      }
      return failure;
    };
    let stored!: StoredDownload;
    let archivePlan!: Extract<ReturnType<typeof planArchive>, { ok: true }>['plan'];
    try {
      if (!op || !this.ownsDownload(op, owner) || op.studyUid !== uid) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
      await this.downloadStudyNow(uid, c);
      // After the scope check: an operation prepared before its Study UID became split is refused at the start too.
      await this.unsplitSource(uid, c);
      stored = this.storedDownload(op);
      const plan = planArchive(stored.manifest);
      if (plan.ok === false) throw error(409, plan.code, plan.message);
      archivePlan = plan.plan;
      if (op.status === 'sent') throw error(409, 'DOWNLOAD_ALREADY_SENT', TRANSFER_MESSAGES.alreadySent);
      await this.unchangedOriginals(uid, stored);
      await this.storageRead(() => this.currentRights(c, 'download', uid, req), downloadStorage);
    } catch (failure) { throw await refused(failure); }
    if (!op) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
    let attempt!: Awaited<ReturnType<StudyTransferLocalService['openAttempt']>>;
    try { attempt = await this.openAttempt(op.id, owner, stored, c, uid, request); }
    catch (failure) { throw await refused(failure); }

    // Everything is decided: headers, then bytes. From here no error becomes an HTTP status (5.2 step 6).
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="KIN-originals-${op.id.slice(0, 8)}.zip"`);
    res.setHeader('Content-Length', String(archivePlan.totalSize));
    res.setHeader('Cache-Control', 'no-store');
    const stop = new AbortController();
    const target: SupplyTarget = { operationId: op.id, attemptId: attempt.attemptId, number: attempt.number, uid, c, req, stop: null,
      approvals: new Set(), closing: false };
    let lastWritten = 0;
    const lost = () => { if (!res.writableFinished) stop.abort(); };
    res.once('close', lost);
    let idle = setTimeout(() => stop.abort(), NO_PROGRESS_MS);
    // Between chunks (a slow source or receiver) the same approval without a chunk every 10 s: it keeps the lease and
    // stops the archive on a lost right or a lost lease.
    const renew = setInterval(() => {
      void this.startApproval(target, null).then(verdict => { if (verdict) stop.abort(); });
    }, RENEW_MS);
    renew.unref?.();
    let result;
    try {
      result = await writeArchive({ plan: archivePlan, sink: res, signal: stop.signal,
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
        supplyGate: supply => this.startApproval(target, supply) });
    } finally {
      clearTimeout(idle);
      clearInterval(renew);
      target.closing = true;
      res.removeListener('close', lost);
    }
    // The writer ended and no approval starts any more. An approval already running (a renewal whose answer is still on
    // its way back) decides the result as much as one that answered: the close waits until each is judged - within its
    // own stage deadlines, which run on their own timers (nothing here adds time) - and holds no lock meanwhile.
    while (target.approvals.size) await Promise.allSettled([...target.approvals]);
    await this.closeAttempt(op.id, owner, attempt.attemptId, result, target, request).catch(() => undefined);
  }

  /**
   * An approval of this attempt (a chunk's, or the 10 s renewal's), registered with the attempt from its start until
   * its result is judged and merged into the attempt's stop reason (approve resolves only then); none starts once the
   * attempt is closing - the writer has ended, so there is no chunk left to approve and no lease to keep.
   */
  private startApproval(t: SupplyTarget, supply: (() => boolean) | null): Promise<StopReason | undefined> {
    if (t.closing) return Promise.resolve(t.stop ?? 'aborted');
    const judged = this.approve(t, supply);
    t.approvals.add(judged);
    const settled = () => { t.approvals.delete(judged); };
    judged.then(settled, settled);
    return judged;
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
   * A stage-2 failure stays what it is (U4BB4-01): a store or commit error is an unknown approval and joins the stop
   * reason as 'fenced' even when another approval already stopped the attempt on its rights - the rights stop never
   * stands for it. Only a stage's own expiry or the attempt's stop, found by a check, is ApprovalStopped.
   */
  private async approve(t: SupplyTarget, supply: (() => boolean) | null): Promise<StopReason | undefined> {
    if (t.stop) return t.stop;
    const start = performance.now();
    const credential = new ApprovalStage(t, start + CHECK_BOUND_MS, 'aborted');
    const prepared = await bounded(credential, () => this.rightsBeforeLock(t.c, t.uid, t.req, credential)).then(() => true, () => false);
    // Where stage 1's answer is consumed: past this check only stage 2's own deadline counts. A failure here is the
    // rights' (they could not be confirmed): stage 1 touches no row and supplies nothing.
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
    // Where stage 2's answer - success, refusal or failure - is consumed: first its deadline (an expiry is 'fenced'),
    // then an unknown database answer joins the stop reason, and only then is the attempt's stop reason the verdict.
    locked.stopped();
    if (unknown) stopAttempt(t, 'fenced');
    if (t.stop) return t.stop;
    return verdict ? stopAttempt(t, verdict) : undefined;
  }

  /**
   * Approval step 1: the credential the guard admitted, still live; the StudyAccess metadata prepared before any lock.
   * The stage is checked between the two: an answer that came past the deadline starts no metadata read.
   */
  private async rightsBeforeLock(c: Caller, uid: string, req: any, stage: ApprovalStage) {
    if (process.env.AUTH_REQUIRED !== 'false' && req) await this.liveCredential(req, c);
    if (stage.stopped()) throw new ApprovalStopped();
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
      // A fence found here is the attempt's stop reason at once, whatever any other approval found meanwhile.
      if (!last || last.status !== 'sending' || last.attemptId !== t.attemptId || last.number !== String(t.number)
          || last.state !== 'sending' || !(left > 0)) return stopAttempt(t, 'fenced');
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
      // The supply's own time is the stage's too: found expired here, the transaction - its renewal included - rolls
      // back; what was handed to the response stays handed (the attempt ends Unconfirmed, never as bytes taken back).
      live();
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
  private async openAttempt(operationId: string, owner: ImportOwner, expected: StoredDownload, c: Caller, uid: string,
    request: RequestWorkContext) {

    try {
      return await this.downloadWrite(request, async (tx, record) => {
        await request.requireCurrent(tx);
        const { op, now, stored } = await this.lockDownload(tx, operationId);
        if (!op || !this.ownsDownload(op, owner) || op.studyUid !== uid) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
        const download = JSON.parse(JSON.stringify(stored!.download));
        // The rights now, in this transaction under its lock (U4C-05): what the preflight read may have changed before the
        // lock was taken, so the member rights and the study (still the institution's own, inside StudyAccess - its metadata
        // prepared by the preflight, outside the lock) are read again here, as each supply approval does. A change is
        // refused before anything is written: no grant consumed, no attempt, no intent, byte 0.
        try {
          if (process.env.AUTH_REQUIRED !== 'false') await this.memberRightsNow(tx, c, 'download');
          await this.ownStudyLocked(tx, uid, c);
        } catch (failure) {
          if (failure instanceof NotFoundException) throw new NotFoundException(TRANSFER_MESSAGES.operationNotFound);
          throw failure;
        }
        if (stored!.manifestCanonical !== expected.manifestCanonical || stored!.manifestSha256 !== expected.manifestSha256)
          throw error(409, 'MANIFEST_CHANGED', TRANSFER_MESSAGES.changed);
        if (op.status === 'sent') throw error(409, 'DOWNLOAD_ALREADY_SENT', TRANSFER_MESSAGES.alreadySent);
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
        await this.downloadAudit(tx, record, request, download, 'provide-prepared', { actor: owner.actor, action: 'original.download.intent', target: op.studyUid,
          detail: JSON.stringify({ institutionId: op.institutionId, operationId, attemptId: attempt.attemptId, number: attempt.number,
            manifestSha256: op.manifestSha256, ownerIssuer: owner.ownerIssuer, ownerSubject: owner.ownerSubject, at: now.toISOString() }) }, attempt.attemptId);

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
   * after the writer's own finish and while this attempt still holds a live lease. It runs once every approval of the
   * attempt was judged (archive), so its stop reason no longer changes. First what leaves the supply unknown: a lease
   * that ran out by now closes it Unconfirmed with its checkpoints as they were, as does a lost or unknown approval (the
   * stop reason `fenced`, whatever the writer reported, its finish included) or a writer stop of its own that is not
   * one of the exact ones; then a rights stop (`aborted`, also after the writer's finish) and a stop on the source, a
   * length/MD5 mismatch, the receiver or a cancellation are Incomplete with the writer's exact counters; Sent only with
   * no stop at all. Unconfirmed keeps the checkpoint committed before it: what was supplied after it is unknown, and
   * nothing here says it was taken back. An attempt already closed by someone else (it was fenced) is left as it is:
   * that close wrote its result row.
   */
  private async closeAttempt(operationId: string, owner: ImportOwner, attemptId: string, result: any, t: SupplyTarget,
    request: RequestWorkContext) {
    await this.downloadWrite(request, async (tx, record) => {
      const { op, now, stored } = await this.lockDownload(tx, operationId);
      const download = JSON.parse(JSON.stringify(stored!.download));
      const mine = download.attempts[download.attempts.length - 1];
      if (!mine || mine.attemptId !== attemptId || mine.state !== 'sending') return;
      if (Date.parse(mine.leaseUntil) <= now.getTime()) {
        await this.expireSending(tx, op, mine, now);
      } else {
        const finished = result?.state === 'finished';
        const exact = finished || INCOMPLETE_REASONS.includes(result?.reason);
        const state = t.stop === 'fenced' || !exact ? 'unconfirmed' : t.stop === 'aborted' || !finished ? 'incomplete' : 'sent';
        mine.state = state;
        mine.endedAt = now.toISOString();
        if (state !== 'unconfirmed' && Array.isArray(result?.objects)) mine.objects = result.objects;
        mine.archiveSha256 = state === 'sent' ? result.archiveSha256 : null;
        mine.responseFinished = state === 'sent';
        // The reason that decided the state: the stop reason over a finished writer or a fence, else the writer's own.
        const reason = t.stop === 'fenced' || (finished && t.stop) ? t.stop : result?.reason ?? null;
        const audit = { actor: owner.actor, action: 'original.download.result', target: op.studyUid,
          detail: JSON.stringify({ institutionId: op.institutionId, operationId, attemptId, state, manifestSha256: op.manifestSha256,
            archiveSha256: mine.archiveSha256, responseFinished: mine.responseFinished, reason,
            objects: mine.objects.map((o: ArchiveObjectResult) => ({ sopUid: o.sopUid, sha256: o.sha256, bytesSupplied: o.bytesSupplied, complete: o.complete })),
            at: now.toISOString() }) };
        // E has no access action for an unknown transfer. Keep the durable
        // preparation and existing operational result; never manufacture success.
        if (state === 'unconfirmed') await tx.auditLog.create({ data: audit });
        else await this.downloadAudit(tx, record, request, download, state === 'sent' ? 'transfer-ended' : 'transfer-aborted',
          audit, randomUUID(), attemptId);
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
  /** Every approval started for the attempt and not yet judged (startApproval); the close waits for them. */
  approvals: Set<Promise<StopReason | undefined>>;
  /** Set once the writer ended: no approval starts after it. */
  closing: boolean;
}

/** Stops the attempt for good; 'fenced' always wins over 'aborted', whichever came first. */
function stopAttempt(t: SupplyTarget, reason: StopReason): StopReason {
  if (t.stop !== 'fenced') t.stop = reason;
  return t.stop;
}

/**
 * One stage of an approval, owned by the attempt it approves for: its monotonic deadline, fixed before its work starts and
 * never moved, and its expiry - set once, by the stage's timer or by the first completion that finds now >= deadline -
 * never cleared. An expired stage stops its attempt for good with the stage's own reason (stage 1 'aborted', stage 2
 * 'fenced'); the stage keeps that link, so no caller can judge it against another attempt or with another reason.
 */
class ApprovalStage {
  private expired = false;

  constructor(private readonly target: SupplyTarget, readonly deadline: number, private readonly expiryReason: StopReason) {}

  /** The stage's timer ran out: the stage expires and stops its attempt. */
  expire(): StopReason {
    this.expired = true;
    return stopAttempt(this.target, this.expiryReason);
  }

  /** The first check of every completion: its expiry, read now whether or not its timer could run; else the attempt's stop reason. */
  stopped(): StopReason | null {
    if (this.expired || performance.now() >= this.deadline) return this.expire();
    return this.target.stop;
  }
}

/** Thrown where an approval finds its stage expired or its attempt stopped: inside a transaction, nothing of it commits. */
class ApprovalStopped extends Error {
  constructor() { super('approval stopped'); }
}

/**
 * Runs a stage's work within the stage's deadline. The timer is set before the work starts (so its synchronous part
 * counts too) for the time left, and expires the stage when it runs. The work's own answer - a value or a failure - is
 * read through the stage's check first, so an answer after the deadline is never taken as one, also when a stalled event
 * loop runs it before the timer. A late answer is not cancelled: it is still consumed here, and the work's own checks
 * keep it from supplying or renewing anything. A failure is passed on as it is, after the same check: the caller tells
 * an unknown database answer from a stop, so a stop found meanwhile never stands in for it (U4BB4-01).
 */
function bounded<T>(stage: ApprovalStage, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { stage.expire(); reject(new ApprovalStopped()); }, Math.max(0, stage.deadline - performance.now()));
  });
  const answer = new Promise<T>(resolve => resolve(work())).then(
    value => { if (stage.stopped()) throw new ApprovalStopped(); return value; },
    failure => { stage.stopped(); throw failure; });
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
