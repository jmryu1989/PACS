/*
 * The member import gate of the self-institution DICOM import (S9-U4b, contract S9-U4p 4.3-4.5, 4.8; B-U4b-WRITER-GATE).
 *
 * Every member import write passes here: the durable global Study/SOP reservations (ImportOperation claim rows) are
 * committed with the attempt's intent before any Orthanc write; a Study UID that already has originals is first bound
 * from the stored-file headers of every one of its instances; each SOP is looked up before and read back after the one
 * POST /instances. Only member imports are serialised (D1203): Gateway, manual SR and the dev/test C-STORE seeding stay
 * outside and their objects are treated as pre-existing originals (B-U4b-WRITER-RACE). Lock order is always the claim
 * keys (sorted, advisory lock then row) and then the operation row; no database transaction is held across network IO.
 *
 * Orthanc is reached through this file's own bounded reads with the settings OrthancService uses (ORTHANC_URL/USER/PASS,
 * redirect error, 5 s to body EOF, size caps, fatal UTF-8 then JSON). Upstream bodies and tag values never reach an
 * error, a log line or an audit detail. Claim rows hold patient identity values; nothing here returns them to a caller.
 */
import { HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { PrismaService } from './prisma.service';
import type { DicomReadResult } from './dicom-part10-reader';
import { DICOM_READER_MESSAGES } from './dicom-part10-reader';
import { birthKey, nameKey, sexKey } from './study-identity';

export const IMPORT_MIGRATION = '20261015013945_import_operation';
/** One object per request (contract 4): 24 MiB. */
export const IMPORT_OBJECT_LIMIT = 25165824;
/** Files of one import operation are indexed 0-99 (a screen selects at most 100). */
export const IMPORT_FILE_SLOTS = 100;

const LEASE_MS = 30000;
const RENEW_MS = 10000;
const READ_TIMEOUT_MS = 5000;
const INIT_BUDGET_MS = 240000;
const SMALL_LIMIT = 262144;
const CONTEXT_LIMIT = 16777216;
const POST_ANSWER_LIMIT = 4096;
const ENUMERATION_SENTINEL = 4097;
const UID = /^[0-9]+(\.[0-9]+)*$/;
const ORTHANC_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/;
const INTERNAL = Object.freeze({ ownerIssuer: 'kin-internal', ownerSubject: 'dicom-import-gate', actor: 'dicom-import-gate' });
/** Node 22 fetch: a TypeError whose cause carries one of these ended before any request byte reached Orthanc (4.4). */
const CONNECT_PHASE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

export type ImportOutcome = 'stored' | 'already-present' | 'rejected' | 'retryable' | 'unconfirmed';
export type WriteDisposition = 'pre-write' | 'may-have-written';

const IDENTITY_NOTICE = '환자 정보가 기존 검사와 다릅니다. 파일은 저장되지 않았습니다. 다른 환자의 영상이면 해당 검사로 따로 반입하고, '
  + '기존 검사의 오더 연결이 잘못되었으면 Technician 화면의 Match/Unmatch로 바로잡으세요.';
const MAY_HAVE_WRITTEN_NOTICE = '저장된 원본과 충돌하여 완료를 확인할 수 없습니다.';
const AFTER_RECHECK_NOTICE = '저장 결과를 확인하지 못했습니다. 관리자에게 이 파일의 확인을 요청하세요.';

/**
 * Contract 4.8, the one table for every file result of POST/GET /api/dicom-import: code -> HTTP of the file POST,
 * outcome token, final (the same operationId/index/sha256 replays it) and the Korean description. `stored` and
 * `already-present` have no code (OUTCOME_ANSWERS). IMPORT_PERMISSION_REVOKED answers with the refusal's own 403/404.
 */
export const IMPORT_RESULT_CODES = Object.freeze({
  IMPORT_UNCONFIRMED: { http: 202, outcome: 'unconfirmed', final: false, message: '저장 결과를 확인 중입니다. 같은 작업의 상태를 다시 확인하세요.' },
  ORTHANC_UNAVAILABLE: { http: 503, outcome: 'retryable', final: false, message: 'Orthanc에 연결하거나 저장된 원본을 읽지 못했습니다. 이 파일은 저장되지 않았습니다. 잠시 뒤 같은 파일로 다시 시도하세요.' },
  IMPORT_PERMISSION_REVOKED: { http: 403, outcome: 'retryable', final: false, message: '보내기 직전에 권한을 다시 확인하지 못해 이 파일은 저장되지 않았습니다. 권한을 확인한 뒤 같은 파일로 다시 시도하세요.' },
  IMPORT_ATTEMPT_EXPIRED: { http: 200, outcome: 'retryable', final: false, message: '이전 시도가 보내기 전에 끝났습니다. 이 파일은 저장되지 않았습니다. 같은 파일로 다시 시도하세요.' },
  STUDY_WRITE_PENDING: { http: 409, outcome: 'retryable', final: false, message: '같은 검사의 다른 파일 저장 결과가 아직 정해지지 않아 이 파일을 보내지 않았습니다. 잠시 뒤 다시 시도하세요.' },
  SOP_WRITE_PENDING: { http: 409, outcome: 'retryable', final: false, message: '같은 영상(SOP)을 다른 작업이 저장하고 있어 이 파일을 보내지 않았습니다. 잠시 뒤 다시 시도하세요.' },
  STUDY_OWNERSHIP_UNDETERMINED: { http: 409, outcome: 'retryable', final: false, message: '이 검사의 소유 기관이 아직 정해지지 않았습니다. 워크리스트에 검사가 나타난 뒤 다시 시도하세요. 이 파일은 저장되지 않았습니다.' },
  RECOVERED_NO_OBJECT: { http: 200, outcome: 'retryable', final: false, message: '저장된 원본이 없음을 확인하고 근거를 기록했습니다. 같은 파일을 다시 보낼 수 있습니다.' },
  DICOM_NOT_PART10: { http: 400, outcome: 'rejected', final: true, message: DICOM_READER_MESSAGES.DICOM_NOT_PART10 },
  DICOM_FILE_META_MISSING: { http: 400, outcome: 'rejected', final: true, message: DICOM_READER_MESSAGES.DICOM_FILE_META_MISSING },
  DICOM_TRANSFER_SYNTAX_UNSUPPORTED: { http: 400, outcome: 'rejected', final: true, message: DICOM_READER_MESSAGES.DICOM_TRANSFER_SYNTAX_UNSUPPORTED },
  DICOM_MALFORMED: { http: 400, outcome: 'rejected', final: true, message: DICOM_READER_MESSAGES.DICOM_MALFORMED },
  PATIENT_ID_UNREADABLE: { http: 400, outcome: 'rejected', final: true, message: DICOM_READER_MESSAGES.PATIENT_ID_UNREADABLE },
  PATIENT_ID_MISSING: { http: 400, outcome: 'rejected', final: true, message: '환자 ID가 없는 파일입니다. 이 파일은 저장되지 않았습니다.' },
  MODALITY_NOT_IMPORTABLE: { http: 400, outcome: 'rejected', final: true, message: '이 종류의 영상은 아직 직접 반입할 수 없습니다.' },
  PATIENT_ISSUER_CONFLICT: { http: 409, outcome: 'rejected', final: true, message: '환자 ID 발급 기관이 이 기관 하나로 확인되지 않습니다. 파일은 저장되지 않았습니다.' },
  PATIENT_ID_CONFLICT: { http: 409, outcome: 'rejected', final: true, message: IDENTITY_NOTICE },
  PATIENT_IDENTITY_CONFLICT: { http: 409, outcome: 'rejected', final: true, message: IDENTITY_NOTICE },
  STUDY_OWNERSHIP_CONFLICT: { http: 409, outcome: 'rejected', final: true, message: '다른 기관의 검사이거나 소유 기관이 배정되지 않은 검사라 반입할 수 없습니다. 파일은 저장되지 않았습니다.' },
  STUDY_UID_MISMATCH: { http: 409, outcome: 'rejected', final: true, message: '선택한 검사와 파일의 검사가 다릅니다. 파일은 저장되지 않았습니다.' },
  EXISTING_STUDY_IDENTITY_UNRESOLVED: { http: 409, outcome: 'rejected', final: true, message: '이 검사에 이미 저장된 영상들의 환자 정보가 서로 다르거나 확인할 수 없어 반입할 수 없습니다. 파일은 저장되지 않았습니다. 관리자에게 이 검사의 환자 정보 확인을 요청하세요.' },
  SOP_UID_AMBIGUOUS: { http: 409, outcome: 'rejected', final: true, message: '같은 영상 식별자(SOP)가 저장소에 둘 이상 있어 반입할 수 없습니다. 파일은 저장되지 않았습니다.' },
  SOP_CONTENT_CONFLICT: { http: 409, outcome: 'rejected', final: true, message: '같은 영상 식별자(SOP)의 다른 원본이 이미 있어 반입할 수 없습니다. 파일은 저장되지 않았습니다.' },
} as const);
export type ImportCode = keyof typeof IMPORT_RESULT_CODES;

export const OUTCOME_ANSWERS = Object.freeze({
  stored: { http: 200, final: true, message: '원본을 저장하고 다시 읽어 같음을 확인했습니다.' },
  'already-present': { http: 200, final: true, message: '같은 원본이 이미 저장되어 있습니다.' },
});

/** 4.7 lean list (D1161; D1244 keeps it). The Korean texts are the contract's. */
const MODALITY_NOTICES = Object.freeze({
  usCine: '초음파 동영상은 아직 직접 반입할 수 없습니다.',
  xaCine: '혈관조영 동영상은 아직 직접 반입할 수 없습니다.',
  mammography: '유방촬영 영상은 아직 직접 반입할 수 없습니다.',
  other: '이 종류의 영상은 아직 직접 반입할 수 없습니다.',
});
const SINGLE_FRAME_ALWAYS = new Set(['CT', 'MR', 'CR', 'DX', 'SR', 'KO', 'PR', 'SEG', 'DOC']);

export const RECOVERY_NOTICES = Object.freeze({
  stored: '원본이 저장되어 있음을 확인해 Stored로 정리했습니다. 점유를 해제했습니다.',
  noObject: '저장된 원본이 없음을 확인하고 근거를 기록했습니다. 같은 파일을 다시 보낼 수 있습니다.',
  mayHaveWritten: '원본 충돌로 반입 완료를 확인할 수 없습니다. 점유만 해제했습니다. Orthanc의 원본은 그대로 두었습니다.',
  orthanc: 'Orthanc를 확인하지 못했습니다. 아무것도 바꾸지 않았습니다. 잠시 뒤 다시 시도하세요.',
  notApplicable: '확인할 미확인 시도가 없거나 아직 진행 중입니다.',
  evidence: '확인 근거와 확인 시각을 확인하세요. 확인 시각은 그 시도의 시작 뒤, 지금 이전이어야 합니다.',
});
export const RECOVERY_BASES = Object.freeze(['orthanc-restarted', 'orthanc-log-checked']);

export const IMPORT_NOT_READY_MESSAGE = 'DICOM 반입 기능이 아직 준비되지 않았습니다. 파일은 저장되지 않았습니다. 관리자에게 알려 주세요.';
export const IMPORT_STORAGE_MESSAGE = '반입 기록을 읽거나 저장하지 못했습니다. 아무것도 저장하지 않았습니다. 잠시 뒤 같은 파일로 다시 시도하세요.';

export interface ImportOwner { institutionId: string; ownerIssuer: string; ownerSubject: string; actor: string }
export interface InstitutionRow { id: string; name: string; dicomNames: string | null }

export interface ImportAttempt {
  attemptId: string; actor: string; generation: number; ownerInstance: string;
  phase: 'prepared' | 'dispatching' | 'finished' | 'unknown';
  leaseUntil: string; startedAt: string; finishedAt: string | null;
  outcome: ImportOutcome; code: ImportCode | null; transport: null | 'certain-no-write' | 'unknown';
  autoRecheckedAt: string | null;
  recovery: null | { basis: string; checkedAt: string; adminIssuer: string; adminSubject: string; adminActor: string; requestedAt: string; resolvedAt: string | null };
}

export interface ImportFileEntry {
  index: number; sha256: string; bytes: number; studyUid: string | null; seriesUid: string | null; sopUid: string | null;
  expectedStudyUid: string | null; outcome: ImportOutcome; code: ImportCode | null;
  identity: null | 'new-study' | 'matched' | 'not_comparable'; writeDisposition: WriteDisposition | null; at: string;
  attempts: ImportAttempt[];
}

/** The file facts of an accepted read: what the gate binds and compares. */
export interface AcceptedFile {
  ok: true; studyUid: string; seriesUid: string; sopUid: string; patientId: string; issuerInstitutionId: string;
  nameKey: string | null; birthKey: string | null; sexKey: string | null; institutionNameMismatch: boolean | null;
}
/** A refused file: its code and message, and - when the reader accepted the bytes - the three UIDs it already verified. */
export type RefusedFile = { ok: false; code: ImportCode; message: string;
  uids: { studyUid: string; seriesUid: string; sopUid: string } | null; institutionNameMismatch: boolean | null };
export type FilePrecheck = AcceptedFile | RefusedFile;

export interface ImportRequest {
  owner: ImportOwner; operationId: string; index: number; expectedStudyUid: string | null;
  bytes: Buffer; sha256: string; precheck: FilePrecheck;
  /** Contract 3: the current role, institution and StudyAccess immediately before the first Orthanc write; throws the refusal. */
  recheck: () => Promise<void>;
}

export interface ImportAnswer { status: number; entry: ImportFileEntry; message: string; refusal?: HttpException }

/**
 * Contract 3 for the admin recovery: the target index's study within the admin's reach now. Each throws the route's
 * refusal (the same 404 as an absent operation when out of reach).
 */
export interface RecoveryScope {
  /** Before the evidence is judged and before any Orthanc read or recovery row (the StudyAccess metadata prepared here). */
  before: (studyUid: string) => Promise<void>;
  /** Inside each recovery transaction, after its claim and operation locks and before its DB time. */
  locked: (tx: Tx, studyUid: string) => Promise<void>;
}

type ClaimRow = { id: string; kind: string; studyUid: string; claimKey: string; claim: any } | null;
type Tx = any;

class OrthancFailure extends Error {
  constructor(readonly kind: 'config' | 'connect' | 'transport' | 'timeout' | 'status' | 'size' | 'decode' | 'parse') { super('orthanc ' + kind); }
}

/** The file-level reading of SOP state at Orthanc (4.5 steps 1 and 3). */
type SopReading =
  | { kind: 'absent' } | { kind: 'exact'; id: string } | { kind: 'conflict' } | { kind: 'ambiguous' } | { kind: 'failed' };

type InitVerdict =
  | { kind: 'bound'; patientId: string; nameKey: string | null; birthKey: string | null; sexKey: string | null }
  | { kind: 'empty' } | { kind: 'unresolved' } | { kind: 'unavailable' } | { kind: 'lost' };

type Step =
  | { kind: 'answer'; answer: ImportAnswer }
  | { kind: 'enumerate' }
  | { kind: 'fence'; attemptId: string }
  | { kind: 'initialize'; attempt: ImportAttempt }
  | { kind: 'recheck'; attempt: ImportAttempt; token: string }
  | { kind: 'send'; attempt: ImportAttempt };

const studyKey = (uid: string) => 'study:' + uid;
const sopKey = (uid: string) => 'sop:' + uid;
const iso = (at: Date) => at.toISOString();
const later = (at: Date, ms: number) => new Date(at.getTime() + ms).toISOString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const FINAL_OUTCOMES = new Set(['stored', 'already-present', 'rejected']);

// ── the persisted formats (contract 4.4, 5.2): every stored row and JSON value is checked before its first use ──

/**
 * A stored ImportOperation row or JSON value that is not exactly the persisted format. It is never used and never rebuilt
 * or overwritten: an import or a reservation answers 503 IMPORT_STORAGE_UNAVAILABLE with no Orthanc write, a download
 * 503 MANIFEST_STORE_INVALID with no byte.
 */
export class StoredFormatError extends Error {
  constructor(readonly what: string) { super('stored ImportOperation format: ' + what); }
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const UTC_TEXT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * The instant of a UTC ISO-8601 text whose calendar fields exist as written (2026-02-30 is refused, never rolled over to
 * March the way Date.parse does); null otherwise.
 */
export function utcInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = UTC_TEXT.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const at = Date.UTC(year, month - 1, day, hour, minute, second, m[7] ? Number(m[7].padEnd(3, '0')) : 0);
  const back = new Date(at);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? at : null;
}

/** A time the server itself stored (Date.toISOString): a real UTC instant in exactly that form. */
export const storedTime = (value: unknown): value is string => {
  const at = utcInstant(value);
  return at !== null && new Date(at).toISOString() === value;
};

export const plainRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Exactly these keys: a missing key, an extra key or a non-plain value is a format violation. */
export function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, any> {
  if (!plainRecord(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

const text = (value: unknown, max = 1024): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const uidText = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && UID.test(value);
const count = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => typeof value === 'string' && (allowed as readonly string[]).includes(value);
const OUTCOMES = ['stored', 'already-present', 'rejected', 'retryable', 'unconfirmed'] as const;
const PHASES = ['prepared', 'dispatching', 'finished', 'unknown'] as const;
const ENTRY_KEYS = ['index', 'sha256', 'bytes', 'studyUid', 'seriesUid', 'sopUid', 'expectedStudyUid', 'outcome', 'code', 'identity',
  'writeDisposition', 'at', 'attempts'];
const ATTEMPT_KEYS = ['attemptId', 'actor', 'generation', 'ownerInstance', 'phase', 'leaseUntil', 'startedAt', 'finishedAt', 'outcome', 'code',
  'transport', 'autoRecheckedAt', 'recovery'];
const RECOVERY_KEYS = ['basis', 'checkedAt', 'adminIssuer', 'adminSubject', 'adminActor', 'requestedAt', 'resolvedAt'];
const STUDY_CLAIM_KEYS = ['schemaVersion', 'phase', 'institutionId', 'studyUid', 'patientId', 'issuerInstitutionId', 'nameKey', 'birthKey',
  'sexKey', 'heldByAttemptId', 'createdAt'];
const SOP_CLAIM_KEYS = ['schemaVersion', 'institutionId', 'studyUid', 'seriesUid', 'sopUid', 'patientId', 'issuerInstitutionId', 'sha256',
  'bytes', 'heldByAttemptId', 'createdAt'];

/** An outcome with its code: no code exactly for stored/already-present, otherwise a table code of that outcome (4.8). */
function outcomeWithCode(outcome: unknown, code: unknown): boolean {
  if (!oneOf(outcome, OUTCOMES)) return false;
  if (outcome === 'stored' || outcome === 'already-present') return code === null;
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(IMPORT_RESULT_CODES, code)
    && IMPORT_RESULT_CODES[code as ImportCode].outcome === outcome;
}

function checkAttempt(a: unknown, generation: number, last: boolean): a is ImportAttempt {
  if (!exactKeys(a, ATTEMPT_KEYS)) return false;
  if (!(typeof a.attemptId === 'string' && UUID_TEXT.test(a.attemptId)) || !text(a.actor, 256) || a.generation !== generation
      || !(typeof a.ownerInstance === 'string' && UUID_TEXT.test(a.ownerInstance)) || !oneOf(a.phase, PHASES)
      || !storedTime(a.leaseUntil) || !storedTime(a.startedAt) || !(a.finishedAt === null || storedTime(a.finishedAt))
      || !outcomeWithCode(a.outcome, a.code) || !(a.transport === null || oneOf(a.transport, ['certain-no-write', 'unknown']))
      || !(a.autoRecheckedAt === null || storedTime(a.autoRecheckedAt))) return false;
  // prepared/dispatching are still running (no end); finished and unknown ended; only the last attempt may still run.
  if ((a.phase === 'prepared' || a.phase === 'dispatching') !== (a.finishedAt === null)) return false;
  if (!last && a.phase !== 'finished') return false;
  if ((a.phase === 'finished') === (a.outcome === 'unconfirmed')) return false;
  if (a.recovery !== null) {
    const r = a.recovery;
    if (!exactKeys(r, RECOVERY_KEYS) || !oneOf(r.basis, RECOVERY_BASES) || utcInstant(r.checkedAt) === null || !text(r.adminIssuer)
        || !text(r.adminSubject, 256) || !text(r.adminActor, 256) || !storedTime(r.requestedAt) || !(r.resolvedAt === null || storedTime(r.resolvedAt)))
      return false;
  }
  return true;
}

function checkEntry(e: unknown, seen: { indexes: Set<number>; attempts: Set<string> }): e is ImportFileEntry {
  if (!exactKeys(e, ENTRY_KEYS)) return false;
  if (!count(e.index, IMPORT_FILE_SLOTS - 1) || seen.indexes.has(e.index) || !(typeof e.sha256 === 'string' && HEX64.test(e.sha256))
      || !count(e.bytes, IMPORT_OBJECT_LIMIT) || !(e.expectedStudyUid === null || uidText(e.expectedStudyUid))
      || !outcomeWithCode(e.outcome, e.code) || !(e.identity === null || oneOf(e.identity, ['new-study', 'matched', 'not_comparable']))
      || !(e.writeDisposition === null || oneOf(e.writeDisposition, ['pre-write', 'may-have-written']))
      || (e.writeDisposition === 'may-have-written' && e.outcome !== 'rejected') || !storedTime(e.at) || !Array.isArray(e.attempts))
    return false;
  seen.indexes.add(e.index);
  // The three UIDs are known together (a file the reader accepted) or not at all (a file it refused).
  const uids = [e.studyUid, e.seriesUid, e.sopUid];
  if (!(uids.every(uid => uid === null) || uids.every(uidText))) return false;
  if (e.studyUid === null && e.attempts.length) return false;
  for (const [i, a] of e.attempts.entries()) {
    if (!checkAttempt(a, i + 1, i === e.attempts.length - 1) || seen.attempts.has(a.attemptId)) return false;
    seen.attempts.add(a.attemptId);
  }
  const last = e.attempts.length ? e.attempts[e.attempts.length - 1] : null;
  // A file is Unconfirmed exactly while its last attempt has no result of its own.
  return (e.outcome === 'unconfirmed') === (!!last && last.phase !== 'finished')
    && (e.outcome !== 'unconfirmed' || last!.outcome === 'unconfirmed')
    && resultBound(e as ImportFileEntry);
}

/** Codes an attempt ends retryable with, having written nothing (4.5 lookup/POST connect failure, 3, a fence, 4.4 SOP held). */
const ATTEMPT_RETRY_CODES = new Set(['ORTHANC_UNAVAILABLE', 'IMPORT_PERMISSION_REVOKED', 'IMPORT_ATTEMPT_EXPIRED', 'SOP_WRITE_PENDING']);
/** Codes a file is answered retryable with before any attempt of this request (enumeration, ownership, a held Study/SOP). */
const BEFORE_ATTEMPT_RETRY_CODES = new Set(['ORTHANC_UNAVAILABLE', 'STUDY_OWNERSHIP_UNDETERMINED', 'STUDY_WRITE_PENDING', 'SOP_WRITE_PENDING']);
/** The reader's and the precheck's refusals of the bytes (4.1, 4.2, 4.7): decided before any reservation, never by an attempt. */
const BYTES_REFUSAL_CODES = new Set(['DICOM_NOT_PART10', 'DICOM_FILE_META_MISSING', 'DICOM_TRANSFER_SYNTAX_UNSUPPORTED', 'DICOM_MALFORMED',
  'PATIENT_ID_UNREADABLE', 'PATIENT_ID_MISSING', 'MODALITY_NOT_IMPORTABLE', 'STUDY_UID_MISMATCH', 'PATIENT_ISSUER_CONFLICT']);
/** Pre-write refusals at the claims, before an attempt (4.4 ownership, identity, SOP content). */
const CLAIM_REFUSAL_CODES = new Set(['STUDY_OWNERSHIP_CONFLICT', 'PATIENT_ID_CONFLICT', 'PATIENT_ISSUER_CONFLICT', 'PATIENT_IDENTITY_CONFLICT',
  'SOP_CONTENT_CONFLICT']);
/** Pre-write refusals an attempt ends with (claim initialisation, the pre-write lookup). */
const ATTEMPT_REFUSAL_CODES = new Set(['STUDY_OWNERSHIP_CONFLICT', 'PATIENT_ID_CONFLICT', 'PATIENT_ISSUER_CONFLICT', 'PATIENT_IDENTITY_CONFLICT',
  'EXISTING_STUDY_IDENTITY_UNRESOLVED', 'SOP_UID_AMBIGUOUS', 'SOP_CONTENT_CONFLICT']);
/** Refusals after a write that may have happened (the read-back, a re-check or a reconciliation of an unknown attempt). */
const MAY_HAVE_WRITTEN_CODES = new Set(['SOP_UID_AMBIGUOUS', 'SOP_CONTENT_CONFLICT']);

/**
 * An attempt that ended retryable as only the gate ends one: with a code of its own end and certain-no-write, or with
 * RECOVERED_NO_OBJECT after a resolved admin recovery, keeping the transport its dispatch left (null or unknown). Every
 * attempt before the last is one of these (no attempt follows a final result).
 */
function retryEnded(a: ImportAttempt): boolean {
  if (a.phase !== 'finished' || a.outcome !== 'retryable') return false;
  if (a.code === 'RECOVERED_NO_OBJECT') return a.transport !== 'certain-no-write' && !!a.recovery?.resolvedAt;
  return ATTEMPT_RETRY_CODES.has(a.code as string) && a.transport === 'certain-no-write';
}

/**
 * Contract 4.4 / 4.6, the stored result bound to the attempt it rests on (U4BB2-03 transition table). A row that
 * matches none of these is not the persisted format (503 IMPORT_STORAGE_UNAVAILABLE, kept as it is, never rebuilt from an
 * older attempt):
 *    1 stored                         the last attempt finished stored; transport null (POST, read-back) or unknown (re-check)
 *    2 already-present                the last attempt finished already-present; certain-no-write (lookup) or null (POST)
 *    3/4 retryable, the attempt's own the last attempt finished retryable with the file's code (retryEnded)
 *    5 retryable before an attempt    no attempt, or the last one ended retryable (its code may differ)
 *    6 rejected by its bytes          no attempt
 *    7 PATIENT_ISSUER_CONFLICT        after a retryable attempt: the issuer's institutions changed, the same bytes refused
 *    8 pre-write at the claims        no attempt, or the last one ended retryable
 *    9 pre-write at an attempt's end  the last attempt finished rejected with the file's code, certain-no-write
 *   10 may-have-written               the last attempt finished rejected with the file's code, transport null or unknown
 *   11 unconfirmed                    the last attempt still without a result: prepared/dispatching (transport null) or
 *                                     unknown (null or unknown)
 */
function resultBound(e: ImportFileEntry): boolean {
  const last = lastAttempt(e);
  if (!e.attempts.slice(0, -1).every(retryEnded)) return false;
  const lastEnded = (outcome: ImportOutcome, code: string | null) => !!last && last.phase === 'finished' && last.outcome === outcome && last.code === code;
  const noneOrRetry = !last || retryEnded(last);
  const code = e.code as string;
  if (e.outcome === 'stored')
    return e.writeDisposition === null && lastEnded('stored', null) && (last!.transport === null || last!.transport === 'unknown');
  if (e.outcome === 'already-present')
    return e.writeDisposition === null && lastEnded('already-present', null) && (last!.transport === 'certain-no-write' || last!.transport === null);
  if (e.outcome === 'retryable')
    return e.writeDisposition === null && ((lastEnded('retryable', code) && retryEnded(last!)) || (BEFORE_ATTEMPT_RETRY_CODES.has(code) && noneOrRetry));
  if (e.outcome === 'rejected' && e.writeDisposition === null)
    return (BYTES_REFUSAL_CODES.has(code) && !last) || (code === 'PATIENT_ISSUER_CONFLICT' && !!last && retryEnded(last));
  if (e.outcome === 'rejected' && e.writeDisposition === 'pre-write')
    return (CLAIM_REFUSAL_CODES.has(code) && noneOrRetry)
      || (ATTEMPT_REFUSAL_CODES.has(code) && lastEnded('rejected', code) && last!.transport === 'certain-no-write');
  if (e.outcome === 'rejected')
    return MAY_HAVE_WRITTEN_CODES.has(code) && lastEnded('rejected', code) && last!.transport !== 'certain-no-write';
  return e.outcome === 'unconfirmed' && !!last && last.phase !== 'finished' && last.outcome === 'unconfirmed' && last.code === 'IMPORT_UNCONFIRMED'
    && (last.phase === 'unknown' ? last.transport !== 'certain-no-write' : last.transport === null);
}

/** A member import row (4.4 table): owner, closed columns, every file entry and attempt; status follows the entries. */
export function checkImportRow(row: any): any {
  const seen = { indexes: new Set<number>(), attempts: new Set<string>() };
  const ok = !!row && row.kind === 'import' && text(row.institutionId, 256) && text(row.ownerIssuer) && text(row.ownerSubject, 256)
    && text(row.actor, 256) && row.studyUid === null && oneOf(row.status, ['open', 'settled']) && Array.isArray(row.results)
    && row.results.length <= IMPORT_FILE_SLOTS && row.manifestSha256 === null && row.download === null && row.claimKey === null && row.claim === null
    && row.results.every((e: unknown) => checkEntry(e, seen))
    && row.status === (row.results.every((e: ImportFileEntry) => FINAL_OUTCOMES.has(e.outcome)) ? 'settled' : 'open');
  if (!ok) throw new StoredFormatError('import ' + (row?.id ?? '?'));
  return row;
}

/** A gate reservation row (4.4 claim JSON): the internal owner, the exact key of its UID and the closed claim object. */
export function checkClaimRow(row: any): any {
  const claim = row?.claim;
  const owner = !!row && row.ownerIssuer === INTERNAL.ownerIssuer && row.ownerSubject === INTERNAL.ownerSubject && row.actor === INTERNAL.actor
    && text(row.institutionId, 256) && row.status === 'reserved' && Array.isArray(row.results) && row.results.length === 0
    && row.manifestSha256 === null && row.download === null && uidText(row.studyUid);
  let ok = false;
  if (owner && row.kind === 'study-claim' && exactKeys(claim, STUDY_CLAIM_KEYS)) {
    const values = [claim.patientId, claim.issuerInstitutionId, claim.nameKey, claim.birthKey, claim.sexKey];
    ok = claim.schemaVersion === 1 && row.claimKey === studyKey(row.studyUid) && claim.studyUid === row.studyUid
      && claim.institutionId === row.institutionId && storedTime(claim.createdAt)
      && (claim.heldByAttemptId === null || (typeof claim.heldByAttemptId === 'string' && UUID_TEXT.test(claim.heldByAttemptId)))
      && (claim.phase === 'initializing' ? values.every(v => v === null)
        : claim.phase === 'bound' && text(claim.patientId, 256) && text(claim.issuerInstitutionId, 256)
          && [claim.nameKey, claim.birthKey, claim.sexKey].every(v => v === null || text(v, 1024)));
  } else if (owner && row.kind === 'sop-claim' && exactKeys(claim, SOP_CLAIM_KEYS)) {
    ok = claim.schemaVersion === 1 && uidText(claim.sopUid) && row.claimKey === sopKey(claim.sopUid) && claim.studyUid === row.studyUid
      && uidText(claim.seriesUid) && claim.institutionId === row.institutionId && text(claim.patientId, 256) && text(claim.issuerInstitutionId, 256)
      && typeof claim.sha256 === 'string' && HEX64.test(claim.sha256) && count(claim.bytes, IMPORT_OBJECT_LIMIT) && storedTime(claim.createdAt)
      && (claim.heldByAttemptId === null || (typeof claim.heldByAttemptId === 'string' && UUID_TEXT.test(claim.heldByAttemptId)));
  }
  if (!ok) throw new StoredFormatError('claim ' + (row?.claimKey ?? row?.id ?? '?'));
  return row;
}
/** The signed 64-bit advisory key of a claim text; a hash collision only serialises two keys, the exact text is re-read. */
const advisory = (key: string) => createHash('sha256').update(key, 'utf8').digest().readBigInt64BE(0).toString();
const lastAttempt = (entry: ImportFileEntry): ImportAttempt | null => entry.attempts.length ? entry.attempts[entry.attempts.length - 1] : null;
const leaseLive = (attempt: ImportAttempt, now: Date) => Date.parse(attempt.leaseUntil) > now.getTime();

/**
 * Contract 4.4 transition table: the one reading of a file, by the database's time read after the row locks, that every
 * path decides from (the owner's POST, GET, startup, the automatic re-check, the admin recovery, a needed holder).
 *   final            stored / already-present / rejected: replayed, nothing else (a may-have-written occupancy is the
 *                    admin recovery's alone)
 *   retryable        the same POST runs a new generation
 *   live             the last attempt holds a live lease - a worker preparing, initialising or dispatching, or a reader
 *                    re-reading an unknown result: nobody else reconciles, fences, re-checks or recovers it
 *   expired-prepared the last attempt never dispatched and its lease ran out: anyone fences it (IMPORT_ATTEMPT_EXPIRED,
 *                    certain-no-write, only its own holders released), never a write to Orthanc
 *   expired-unknown  the last attempt dispatched (or its read-back failed) and its lease ran out: read-only reconciliation,
 *                    the automatic re-check once, the admin recovery
 */
export type FileState = 'final' | 'retryable' | 'live' | 'expired-prepared' | 'expired-unknown';
export function fileState(entry: ImportFileEntry, now: Date): FileState {
  if (FINAL_OUTCOMES.has(entry.outcome)) return 'final';
  if (entry.outcome === 'retryable') return 'retryable';
  const last = lastAttempt(entry)!;   // an Unconfirmed file always ends with an attempt that has no result (checked format)
  if (leaseLive(last, now)) return 'live';
  return last.phase === 'prepared' ? 'expired-prepared' : 'expired-unknown';
}

/**
 * A worker's own CAS before it writes anything for its attempt (initialisation result, dispatch, result, renewal): its
 * attempt is still the file's last, the same generation, in one of these phases, and its lease is live by DB time.
 */
function holdsAttempt(entry: ImportFileEntry | undefined, attempt: ImportAttempt, now: Date, phases: readonly string[]): boolean {
  const last = entry ? lastAttempt(entry) : null;
  return !!last && last.attemptId === attempt.attemptId && last.generation === attempt.generation && phases.includes(last.phase) && leaseLive(last, now);
}

/** The answer of a stored file entry: HTTP, message, from the one table. */
export function fileAnswer(entry: ImportFileEntry): ImportAnswer {
  if (entry.code === null) {
    const row = OUTCOME_ANSWERS[entry.outcome as 'stored' | 'already-present'];
    return { status: row ? row.http : 500, entry, message: row ? row.message : '' };
  }
  const row = IMPORT_RESULT_CODES[entry.code];
  let message: string = row.message;
  if (entry.outcome === 'rejected' && entry.writeDisposition === 'may-have-written') message = MAY_HAVE_WRITTEN_NOTICE;
  if (entry.outcome === 'unconfirmed' && lastAttempt(entry)?.autoRecheckedAt) message = AFTER_RECHECK_NOTICE;
  return { status: row.http, entry, message };
}

/** 4.4 transport classes: certain-no-write only for a fetch TypeError ended in the connect phase, never for our own abort. */
export function connectPhaseFailure(error: unknown, ownAbort: boolean): boolean {
  if (ownAbort || !(error instanceof TypeError)) return false;
  const cause: any = (error as any).cause;
  if (!cause) return false;
  if (typeof cause.code === 'string' && CONNECT_PHASE_CODES.has(cause.code)) return true;
  return Array.isArray(cause.errors) && cause.errors.length > 0
    && cause.errors.every((inner: any) => typeof inner?.code === 'string' && CONNECT_PHASE_CODES.has(inner.code));
}

/** 4.2 issuer rule: every institution whose id, name or alias equals the value after trim and lower-casing. */
export function issuerInstitutions(value: string, institutions: readonly InstitutionRow[]): Set<string> {
  const key = value.trim().toLowerCase();
  const found = new Set<string>();
  for (const row of institutions) {
    const names = [row.id, row.name, ...String(row.dicomNames ?? '').split(',')].map(name => String(name).trim().toLowerCase()).filter(Boolean);
    if (names.includes(key)) found.add(row.id);
  }
  return found;
}

/** 4.7: null when the modality is importable in Part 1, else the Korean notice. */
export function modalityRefusal(modality: string | null, frames: number | null): string | null {
  const value = (modality ?? '').trim().toUpperCase();
  const multiFrame = (frames ?? 1) > 1;
  if (SINGLE_FRAME_ALWAYS.has(value)) return null;
  if (value === 'US') return multiFrame ? MODALITY_NOTICES.usCine : null;
  if (value === 'XA') return multiFrame ? MODALITY_NOTICES.xaCine : null;
  if (value === 'MG') return MODALITY_NOTICES.mammography;
  return MODALITY_NOTICES.other;
}

/**
 * 4.1-4.3 and 4.7 on the bytes alone (no reservation, no StudyState change): the reader's five codes, PatientID present,
 * the modality, the expected study and the issuer set. A non-UI NUL is never stripped here to make a value valid (B-01).
 */
export function precheckFile(read: DicomReadResult, expectedStudyUid: string | null, institutionId: string,
  institutions: readonly InstitutionRow[]): FilePrecheck {
  if (read.ok === false)
    return { ok: false, code: read.code, message: IMPORT_RESULT_CODES[read.code].message, uids: null, institutionNameMismatch: null };
  const h = read.header;
  // Once the reader accepted the bytes their three UIDs are known and kept with any business refusal (4.6, 4.9 target).
  const uids = { studyUid: h.studyInstanceUid, seriesUid: h.seriesInstanceUid, sopUid: h.sopInstanceUid };
  const institutionNameMismatch = institutionNameSignal(h.institutionName, institutionId, institutions);
  const refused = (code: ImportCode, message: string): FilePrecheck => ({ ok: false, code, message, uids, institutionNameMismatch });
  if (h.patientId === null || h.patientId.trim() === '') return refused('PATIENT_ID_MISSING', IMPORT_RESULT_CODES.PATIENT_ID_MISSING.message);
  const modality = modalityRefusal(h.modality, h.numberOfFrames);
  if (modality) return refused('MODALITY_NOT_IMPORTABLE', modality);
  if (expectedStudyUid !== null && expectedStudyUid !== h.studyInstanceUid) return refused('STUDY_UID_MISMATCH', IMPORT_RESULT_CODES.STUDY_UID_MISMATCH.message);
  if (h.issuerOfPatientId !== null && h.issuerOfPatientId.trim() !== '') {
    const found = issuerInstitutions(h.issuerOfPatientId, institutions);
    if (found.size !== 1 || !found.has(institutionId)) return refused('PATIENT_ISSUER_CONFLICT', IMPORT_RESULT_CODES.PATIENT_ISSUER_CONFLICT.message);
  }
  const keyOrNull = (value: string) => value === '' ? null : value;
  return { ok: true, ...uids, patientId: h.patientId.trim(), issuerInstitutionId: institutionId,
    nameKey: h.patientNameComparable ? keyOrNull(nameKey(h.patientName)) : null,
    birthKey: keyOrNull(birthKey(h.patientBirthDate)), sexKey: keyOrNull(sexKey(h.patientSex)), institutionNameMismatch };
}

/**
 * 4.3: InstitutionName is a mismatch signal only, never an ownership fact. null when the tag is absent or empty; false when
 * it names the importing institution by its id, name or an alias (the 4.2 trim/lower-case normalisation); true otherwise.
 * Only this boolean reaches an audit detail; the tag text never does.
 */
export function institutionNameSignal(name: string | null, institutionId: string, institutions: readonly InstitutionRow[]): boolean | null {
  if (name === null || name.trim() === '') return null;
  return !issuerInstitutions(name, institutions).has(institutionId);
}

/** 4.4 claim initialisation, step 3: judged over every header read; never over an index or a partial read. */
export function judgeExistingHeaders(headers: readonly any[], studyUid: string, institutionId: string,
  institutions: readonly InstitutionRow[]): InitVerdict {
  const sops = new Set<string>();
  const ids = new Set<string>(), issuers = new Set<string>();
  const demographics = { nameKey: new Set<string>(), birthKey: new Set<string>(), sexKey: new Set<string>() };
  for (const h of headers) {
    if (!h || typeof h !== 'object' || Array.isArray(h)) return { kind: 'unresolved' };
    for (const key of ['IssuerOfPatientID', 'PatientName', 'PatientBirthDate', 'PatientSex'])
      if (Object.prototype.hasOwnProperty.call(h, key) && typeof h[key] !== 'string') return { kind: 'unresolved' };
    if (h.StudyInstanceUID !== studyUid) return { kind: 'unresolved' };
    if (typeof h.SOPInstanceUID !== 'string' || h.SOPInstanceUID.length > 64 || !UID.test(h.SOPInstanceUID) || sops.has(h.SOPInstanceUID))
      return { kind: 'unresolved' };
    sops.add(h.SOPInstanceUID);
    if (typeof h.PatientID !== 'string' || h.PatientID.trim() === '') return { kind: 'unresolved' };
    ids.add(h.PatientID.trim());
    issuers.add(typeof h.IssuerOfPatientID === 'string' ? h.IssuerOfPatientID.trim() : '');
    const name = nameKey(h.PatientName ?? ''), birth = birthKey(h.PatientBirthDate ?? ''), sex = sexKey(h.PatientSex ?? '');
    if (name) demographics.nameKey.add(name);
    if (birth) demographics.birthKey.add(birth);
    if (sex) demographics.sexKey.add(sex);
  }
  if (ids.size !== 1 || issuers.size !== 1) return { kind: 'unresolved' };
  const [issuer] = [...issuers];
  if (issuer !== '') {
    const found = issuerInstitutions(issuer, institutions);
    if (found.size !== 1 || !found.has(institutionId)) return { kind: 'unresolved' };
  }
  if (demographics.nameKey.size > 1 || demographics.birthKey.size > 1 || demographics.sexKey.size > 1) return { kind: 'unresolved' };
  const one = (set: Set<string>) => set.size ? [...set][0] : null;
  return { kind: 'bound', patientId: [...ids][0], nameKey: one(demographics.nameKey), birthKey: one(demographics.birthKey),
    sexKey: one(demographics.sexKey) };
}

/** 4.2 on a bound Study claim: refusal code, identity relation, and the empty demographic fields this file fills. */
export function compareWithStudyClaim(claim: any, file: AcceptedFile, institutionId: string):
  { code: ImportCode | null; identity: 'matched' | 'not_comparable'; fill: Record<string, string> } {
  if (claim.institutionId !== institutionId) return { code: 'STUDY_OWNERSHIP_CONFLICT', identity: 'matched', fill: {} };
  if (claim.patientId !== file.patientId) return { code: 'PATIENT_ID_CONFLICT', identity: 'matched', fill: {} };
  if (claim.issuerInstitutionId !== file.issuerInstitutionId) return { code: 'PATIENT_ISSUER_CONFLICT', identity: 'matched', fill: {} };
  let comparable = true;
  const fill: Record<string, string> = {};
  for (const field of ['nameKey', 'birthKey', 'sexKey'] as const) {
    const stored = claim[field], given = file[field];
    if (stored && given && stored !== given) return { code: 'PATIENT_IDENTITY_CONFLICT', identity: 'matched', fill: {} };
    if (!stored || !given) comparable = false;
    if (!stored && given) fill[field] = given;
  }
  return { code: null, identity: comparable ? 'matched' : 'not_comparable', fill };
}

/** 4.4 SOP claim: the identity tuple, hash and length of a reserved SOP must all equal this file's. */
export function sameSopContent(claim: any, file: AcceptedFile, sha256: string, bytes: number, institutionId: string): boolean {
  return claim.institutionId === institutionId && claim.studyUid === file.studyUid && claim.seriesUid === file.seriesUid
    && claim.sopUid === file.sopUid && claim.patientId === file.patientId && claim.issuerInstitutionId === file.issuerInstitutionId
    && claim.sha256 === sha256 && claim.bytes === bytes;
}

@Injectable()
export class DicomImportGateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DicomImportGate');
  /** ownerInstance of this process's attempts; a restart never mistakes an old attempt for its own. */
  readonly bootId = randomUUID();
  private stopping = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Startup reconciliation runs beside the server, never in front of it: a slow Orthanc must not hold the API down.
    const timer = setTimeout(() => {
      if (!this.stopping) void this.reconcileOnStart().catch(() => this.logger.warn('import reconciliation stopped; the next start or request retries it'));
    }, 0);
    timer.unref?.();
  }

  onModuleDestroy() { this.stopping = true; }

  // ── readiness (4.5): the migration applied and Orthanc answering, each checked per request, never cached ──

  async migrationApplied(): Promise<boolean> {
    try {
      const rows: any[] = await this.prisma.$queryRaw`SELECT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = ${IMPORT_MIGRATION}
          AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
        (pg_catalog.to_regclass('public."ImportOperation"') IS NOT NULL) AS present`;
      return rows.length === 1 && rows[0].applied === true && rows[0].present === true;
    } catch { return false; }
  }

  async orthancAnswering(): Promise<boolean> {
    try {
      const system = await this.orthancJson('GET', '/system', undefined, SMALL_LIMIT);
      return !!system && typeof system === 'object' && !Array.isArray(system) && typeof system.Version === 'string';
    } catch { return false; }
  }

  /** 503 IMPORT_NOT_READY on member import routes only; Gateway and manual SR never call this. */
  async ready(orthanc: boolean): Promise<void> {
    if (!await this.migrationApplied() || (orthanc && !await this.orthancAnswering()))
      throw new ServiceUnavailableException({ code: 'IMPORT_NOT_READY', message: IMPORT_NOT_READY_MESSAGE });
  }

  async institutions(): Promise<InstitutionRow[]> {
    return this.prisma.institution.findMany({ select: { id: true, name: true, dicomNames: true } });
  }

  // ── the import state machine (4.4 transition table: fileState) ──

  async importFile(r: ImportRequest): Promise<ImportAnswer> {
    let enumeration: { failed: boolean; count: number } | null = null;
    for (let round = 0; round < 8; round++) {
      const step = await this.storage(() => this.intake(r, enumeration));
      if (step.kind === 'answer') return step.answer;
      if (step.kind === 'enumerate' && r.precheck.ok) { enumeration = await this.enumerateNewStudy(r.precheck.studyUid); continue; }
      if (step.kind === 'fence') { await this.storage(() => this.fenceExpired(step.attemptId)); continue; }
      if (step.kind === 'recheck') return this.autoRecheck(r, step.attempt, step.token);
      if (step.kind === 'initialize') {
        const next = await this.storage(() => this.initialize(r, step.attempt));
        if (next.kind === 'answer') return next.answer;
        return this.send(r, next.attempt);
      }
      if (step.kind === 'send') return this.send(r, step.attempt);
    }
    throw new ServiceUnavailableException({ code: 'IMPORT_STORAGE_UNAVAILABLE', message: IMPORT_STORAGE_MESSAGE });
  }

  /**
   * The intake transaction: claims (sorted) then the operation row (whose advisory lock also serialises the creation of a
   * new operation id), then the database's time; the reservation and the intent commit together.
   */
  private intake(r: ImportRequest, enumeration: { failed: boolean; count: number } | null): Promise<Step> {
    const file = r.precheck;
    const said = { institutionNameMismatch: file.institutionNameMismatch };
    return this.write(async tx => {
      const claims = file.ok ? await this.lockClaims(tx, [studyKey(file.studyUid), sopKey(file.sopUid)]) : new Map<string, ClaimRow>();
      const op = await this.lockOperation(tx, r.operationId);
      const now = await this.clock(tx);
      if (op && !this.sameOwner(op, r.owner, 'import')) throw this.requestConflict('OPERATION_CONFLICT');
      const results: ImportFileEntry[] = op ? clone(op.results) : [];
      let entry = results.find(e => e.index === r.index) ?? null;
      if (entry && (entry.sha256 !== r.sha256 || entry.bytes !== r.bytes.length || entry.expectedStudyUid !== r.expectedStudyUid))
        throw this.requestConflict('OPERATION_CONTENT_CONFLICT');
      const save = () => this.saveImport(tx, op, r, results, now);
      if (entry) {
        const state = fileState(entry, now);
        if (state === 'final') return { kind: 'answer', answer: this.replay(entry, file) };
        if (state === 'live') return { kind: 'answer', answer: fileAnswer(entry) };
        const last = lastAttempt(entry)!;
        if (state === 'expired-unknown') {
          if (last.autoRecheckedAt || !file.ok) return { kind: 'answer', answer: fileAnswer(entry) };
          // The one automatic re-check (4.4): its reading right is taken here, with the row, before any Orthanc read, so
          // a second same-key POST meanwhile finds the attempt live and reads nothing.
          const wasDispatching = this.takeReading(entry, last, now);
          await save();
          if (wasDispatching) await this.auditResult(tx, r.owner.institutionId, r.operationId, entry, last, now, said);
          return { kind: 'recheck', attempt: last, token: last.leaseUntil };
        }
        if (state === 'expired-prepared') {
          this.finishAttempt(entry, last, now, { outcome: 'retryable', code: 'IMPORT_ATTEMPT_EXPIRED', transport: 'certain-no-write' });
          await this.releaseHolders(tx, claims, last.attemptId, now, true);
          await this.auditResult(tx, r.owner.institutionId, r.operationId, entry, last, now, said);
        }
      }
      // A refusal written by this request is this request's: its actor, not the operation's first one (4.9).
      const refusedBy = { actor: r.owner.actor, ...said };
      if (file.ok === false) {
        // A new file, or a retryable one whose bytes are now refused before any reservation (e.g. an issuer that no
        // longer resolves to this institution alone): a final result, no reservation, no StudyState change. The three
        // UIDs the reader already verified stay with it; only a file the reader refused has none.
        if (!entry) { entry = this.newEntry(r, file.uids, now); results.push(entry); }
        this.settle(entry, now, file.code, 'rejected', null);
        await save();
        await this.auditResult(tx, r.owner.institutionId, r.operationId, entry, null, now, refusedBy);
        return { kind: 'answer', answer: { ...fileAnswer(entry), message: file.message } };
      }
      if (!entry) { entry = this.newEntry(r, file, now); results.push(entry); }
      const refuse = async (code: ImportCode, disposition: WriteDisposition | null = null): Promise<Step> => {
        this.settle(entry, now, code, IMPORT_RESULT_CODES[code].outcome as ImportOutcome, disposition);
        await save();
        await this.auditResult(tx, r.owner.institutionId, r.operationId, entry, null, now, refusedBy);
        return { kind: 'answer', answer: fileAnswer(entry) };
      };
      const state = await tx.studyState.findUnique({ where: { uid: file.studyUid } });
      if (state && state.institutionId !== r.owner.institutionId) return refuse('STUDY_OWNERSHIP_CONFLICT', 'pre-write');
      const study = claims.get(studyKey(file.studyUid)), sop = claims.get(sopKey(file.sopUid));
      // Decide everything before changing anything, so a refusal leaves every reservation as it was.
      let identity: ImportFileEntry['identity'] = 'new-study';
      let fill: Record<string, string> = {};
      let initialize = false;
      if (!study) {
        if (!state) {
          if (!enumeration) return { kind: 'enumerate' };
          if (enumeration.failed) return refuse('ORTHANC_UNAVAILABLE');
          if (enumeration.count > 0) return refuse('STUDY_OWNERSHIP_UNDETERMINED');
        } else initialize = true;
      } else {
        const holder = study.claim.heldByAttemptId;
        if (holder) {
          const blocking = await this.holderBlocks(tx, study, now);
          if (blocking === 'expired') return { kind: 'fence', attemptId: holder };
          if (blocking) return refuse('STUDY_WRITE_PENDING');
        }
        if (study.claim.phase === 'initializing') initialize = true;
        else {
          const compared = compareWithStudyClaim(study.claim, file, r.owner.institutionId);
          if (compared.code) return refuse(compared.code, 'pre-write');
          identity = compared.identity; fill = compared.fill;
        }
      }
      if (!initialize && sop) {
        if (!sameSopContent(sop.claim, file, r.sha256, r.bytes.length, r.owner.institutionId)) return refuse('SOP_CONTENT_CONFLICT', 'pre-write');
        const holder = sop.claim.heldByAttemptId;
        if (holder) {
          const blocking = await this.holderBlocks(tx, sop, now);
          if (blocking === 'expired') return { kind: 'fence', attemptId: holder };
          if (blocking) return refuse('SOP_WRITE_PENDING');
        }
      }
      // From here on: one new attempt holds the Study (and, unless the Study is still being initialised, the SOP).
      const attempt = this.newAttempt(entry, r.owner.actor, now);
      entry.attempts.push(attempt);
      entry.outcome = 'unconfirmed'; entry.code = 'IMPORT_UNCONFIRMED'; entry.writeDisposition = null; entry.at = iso(now);
      if (!study) {
        if (initialize) {
          await this.createClaim(tx, 'study-claim', file.studyUid, studyKey(file.studyUid), this.studyClaim(file, r.owner.institutionId, 'initializing', attempt.attemptId, now, false), now);
        } else {
          await tx.studyState.createMany({ data: [{ uid: file.studyUid, institutionId: r.owner.institutionId,
            reqHosp: await this.institutionName(tx, r.owner.institutionId), ss: 'Unverified', origin: 'local-import' }], skipDuplicates: true });
          const owned = await tx.studyState.findUnique({ where: { uid: file.studyUid } });
          if (!owned || owned.institutionId !== r.owner.institutionId) {
            entry.attempts.pop();
            return refuse('STUDY_OWNERSHIP_CONFLICT', 'pre-write');
          }
          await this.createClaim(tx, 'study-claim', file.studyUid, studyKey(file.studyUid), this.studyClaim(file, r.owner.institutionId, 'bound', attempt.attemptId, now, true), now);
        }
      } else {
        await this.updateClaim(tx, study, { ...study.claim, ...fill, heldByAttemptId: attempt.attemptId }, now);
      }
      if (!initialize) {
        entry.identity = identity;
        if (sop) await this.updateClaim(tx, sop, { ...sop.claim, heldByAttemptId: attempt.attemptId }, now);
        else await this.createClaim(tx, 'sop-claim', file.studyUid, sopKey(file.sopUid), this.sopClaim(file, r, attempt.attemptId, now), now);
      }
      await save();
      await this.auditIntent(tx, r, entry, attempt, now);
      return initialize ? { kind: 'initialize', attempt } : { kind: 'send', attempt };
    });
  }

  /**
   * A final result replayed (4.8). A refusal of these very bytes is answered with the description it was refused with
   * (e.g. the mammography sentence of 4.7, read again from the same bytes); GET, which has no bytes, gives the code's
   * general description of the one table.
   */
  private replay(entry: ImportFileEntry, file: FilePrecheck): ImportAnswer {
    const answer = fileAnswer(entry);
    if (file.ok === false && entry.outcome === 'rejected' && entry.writeDisposition === null && file.code === entry.code) return { ...answer, message: file.message };
    return answer;
  }

  /** 4.4 claim initialisation for a Study UID whose StudyState exists and that has no bound claim. */
  private async initialize(r: ImportRequest, attempt: ImportAttempt): Promise<{ kind: 'answer'; answer: ImportAnswer } | { kind: 'send'; attempt: ImportAttempt }> {
    const file = r.precheck as AcceptedFile;
    const said = { institutionNameMismatch: file.institutionNameMismatch };
    const lease = this.keepLease(r, attempt, ['prepared']);
    let verdict: InitVerdict;
    try { verdict = await this.readExistingStudy(file.studyUid, r.owner.institutionId, lease.signal); }
    finally { lease.stop(); }
    return this.write(async tx => {
      const claims = await this.lockClaims(tx, [studyKey(file.studyUid), sopKey(file.sopUid)]);
      const op = await this.lockOperation(tx, r.operationId);
      const now = await this.clock(tx);
      const results: ImportFileEntry[] = clone(op.results);
      const entry = results.find(e => e.index === r.index)!;
      const mine = lastAttempt(entry);
      const study = claims.get(studyKey(file.studyUid)), sop = claims.get(sopKey(file.sopUid));
      const save = () => this.saveImport(tx, op, r, results, now);
      const end = async (code: ImportCode, disposition: WriteDisposition | null = 'pre-write') => {
        this.finishAttempt(entry, mine!, now, { outcome: IMPORT_RESULT_CODES[code].outcome as ImportOutcome, code, transport: 'certain-no-write' }, disposition);
        // No Orthanc write happened: the initializing claim this attempt holds goes away and the next import reads again.
        await this.releaseHolders(tx, claims, mine!.attemptId, now, true);
        await save();
        await this.auditResult(tx, r.owner.institutionId, r.operationId, entry, mine, now, said);
        return { kind: 'answer' as const, answer: fileAnswer(entry) };
      };
      // The worker's CAS: still its file's last attempt, prepared, holding the initializing claim, its lease live by DB time.
      // Its own expired prepared attempt is fenced here exactly as anyone would fence it; anything else is someone else's.
      if (!holdsAttempt(entry, attempt, now, ['prepared']) || !study || study.claim.phase !== 'initializing' || study.claim.heldByAttemptId !== attempt.attemptId) {
        if (mine?.attemptId === attempt.attemptId && fileState(entry, now) === 'expired-prepared') return end('IMPORT_ATTEMPT_EXPIRED', null);
        return { kind: 'answer' as const, answer: fileAnswer(entry) };
      }
      if (verdict.kind === 'lost') return end('IMPORT_ATTEMPT_EXPIRED', null);
      if (verdict.kind === 'unavailable') return end('ORTHANC_UNAVAILABLE', null);
      if (verdict.kind === 'unresolved') return end('EXISTING_STUDY_IDENTITY_UNRESOLVED');
      let values: { patientId: string; nameKey: string | null; birthKey: string | null; sexKey: string | null };
      if (verdict.kind === 'empty') {
        const state = await tx.studyState.findUnique({ where: { uid: file.studyUid } });
        if (!state || (state.origin !== 'gateway' && state.origin !== 'local-import')) return end('EXISTING_STUDY_IDENTITY_UNRESOLVED');
        values = { patientId: file.patientId, nameKey: file.nameKey, birthKey: file.birthKey, sexKey: file.sexKey };
      } else values = verdict;
      const bound = { ...study.claim, phase: 'bound', patientId: values.patientId, issuerInstitutionId: r.owner.institutionId,
        nameKey: values.nameKey, birthKey: values.birthKey, sexKey: values.sexKey };
      const compared = compareWithStudyClaim(bound, file, r.owner.institutionId);
      const blocked = async (code: ImportCode, disposition: WriteDisposition | null, fill: Record<string, string>) => {
        await this.updateClaim(tx, study, { ...bound, ...fill, heldByAttemptId: null }, now);
        this.finishAttempt(entry, mine!, now, { outcome: IMPORT_RESULT_CODES[code].outcome as ImportOutcome, code, transport: 'certain-no-write' }, disposition);
        await save();
        await this.auditResult(tx, r.owner.institutionId, r.operationId, entry, mine, now, said);
        return { kind: 'answer' as const, answer: fileAnswer(entry) };
      };
      if (compared.code) return blocked(compared.code, 'pre-write', {});
      if (sop) {
        if (!sameSopContent(sop.claim, file, r.sha256, r.bytes.length, r.owner.institutionId)) return blocked('SOP_CONTENT_CONFLICT', 'pre-write', compared.fill);
        if (sop.claim.heldByAttemptId && sop.claim.heldByAttemptId !== attempt.attemptId) return blocked('SOP_WRITE_PENDING', null, compared.fill);
        await this.updateClaim(tx, sop, { ...sop.claim, heldByAttemptId: attempt.attemptId }, now);
      } else await this.createClaim(tx, 'sop-claim', file.studyUid, sopKey(file.sopUid), this.sopClaim(file, r, attempt.attemptId, now), now);
      await this.updateClaim(tx, study, { ...bound, ...compared.fill }, now);
      entry.identity = compared.identity;
      mine!.leaseUntil = later(now, LEASE_MS);
      await save();
      return { kind: 'send' as const, attempt: mine! };
    });
  }

  /** 4.5 steps 1-3 for one prepared attempt that holds its Study and SOP. */
  private async send(r: ImportRequest, attempt: ImportAttempt): Promise<ImportAnswer> {
    const file = r.precheck as AcceptedFile;
    const lease = this.keepLease(r, attempt, ['prepared', 'dispatching']);
    try {
      const before = await this.readSop(file, r.bytes.length, r.sha256, null);
      if (before.kind !== 'absent') {
        const ended: Record<string, [ImportOutcome, ImportCode | null, WriteDisposition | null]> = {
          failed: ['retryable', 'ORTHANC_UNAVAILABLE', null], ambiguous: ['rejected', 'SOP_UID_AMBIGUOUS', 'pre-write'],
          conflict: ['rejected', 'SOP_CONTENT_CONFLICT', 'pre-write'], exact: ['already-present', null, null] };
        const [outcome, code, disposition] = ended[before.kind];
        return this.finish(r, attempt, { outcome, code, transport: 'certain-no-write', disposition, release: true, from: ['prepared'] });
      }
      // Contract 3: the rights and the request's own credential now, immediately before the first Orthanc write.
      try { await r.recheck(); }
      catch (refusal) {
        if (refusal instanceof HttpException && [403, 404].includes(refusal.getStatus())) {
          const answer = await this.finish(r, attempt, { outcome: 'retryable', code: 'IMPORT_PERMISSION_REVOKED', transport: 'certain-no-write', disposition: null, release: true, from: ['prepared'] });
          return answer.entry.code === 'IMPORT_PERMISSION_REVOKED' ? { ...answer, status: refusal.getStatus(), refusal } : answer;
        }
        // Not a refusal (the database, the identity provider): nothing was written and nothing is decided; the prepared
        // attempt keeps its holders until its lease runs out and is fenced like any other (IMPORT_ATTEMPT_EXPIRED).
        throw new ServiceUnavailableException({ code: 'IMPORT_STORAGE_UNAVAILABLE', message: IMPORT_STORAGE_MESSAGE });
      }
      if (!await this.storage(() => this.markDispatching(r, attempt))) return this.current(r);
      const posted = await this.postInstance(r.bytes);
      if (posted.kind === 'certain-no-write')
        return this.finish(r, attempt, { outcome: 'retryable', code: 'ORTHANC_UNAVAILABLE', transport: 'certain-no-write', disposition: null, release: true, from: ['dispatching'] });
      if (posted.kind === 'unknown')
        return this.finish(r, attempt, { outcome: 'unconfirmed', code: 'IMPORT_UNCONFIRMED', transport: 'unknown', disposition: null, release: false, from: ['dispatching'], phase: 'unknown' });
      const after = await this.readSop(file, r.bytes.length, r.sha256, posted.id);
      if (after.kind === 'exact')
        return this.finish(r, attempt, { outcome: posted.status === 'AlreadyStored' ? 'already-present' : 'stored', code: null, transport: null, disposition: null, release: true, from: ['dispatching'] });
      if (after.kind === 'conflict' || after.kind === 'ambiguous')
        return this.finish(r, attempt, { outcome: 'rejected', code: after.kind === 'ambiguous' ? 'SOP_UID_AMBIGUOUS' : 'SOP_CONTENT_CONFLICT', transport: null, disposition: 'may-have-written', release: false, from: ['dispatching'] });
      return this.finish(r, attempt, { outcome: 'unconfirmed', code: 'IMPORT_UNCONFIRMED', transport: null, disposition: null, release: false, from: ['dispatching'], phase: 'unknown' });
    } finally { lease.stop(); }
  }

  /**
   * 4.4 automatic re-check, once per attempt: one bounded read under the reading right the intake took (the attempt's
   * lease, `token`), never a resend. A completed read is recorded once (autoRecheckedAt and its result row, absence
   * included); a read that itself failed records nothing, so the next POST may check once more. The reading right is
   * given back either way; a crash keeps the holders, and the right simply runs out.
   */
  private async autoRecheck(r: ImportRequest, attempt: ImportAttempt, token: string): Promise<ImportAnswer> {
    const file = r.precheck as AcceptedFile;
    const reading = await this.readSop(file, r.bytes.length, r.sha256, null);
    return this.storage(() => this.write(async tx => {
      const claims = await this.lockClaims(tx, [studyKey(file.studyUid), sopKey(file.sopUid)]);
      const op = await this.lockOperation(tx, r.operationId);
      const now = await this.clock(tx);
      const results: ImportFileEntry[] = clone(op.results);
      const entry = results.find(e => e.index === r.index)!;
      const mine = lastAttempt(entry);
      if (!this.readingHeld(entry, attempt, token, now) || mine!.autoRecheckedAt) return fileAnswer(entry);
      mine!.leaseUntil = iso(now);
      if (reading.kind !== 'failed') {
        mine!.autoRecheckedAt = iso(now);
        if (reading.kind === 'exact') {
          this.finishAttempt(entry, mine!, now, { outcome: 'stored', code: null, transport: mine!.transport });
          await this.releaseHolders(tx, claims, mine!.attemptId, now, false);
        } else if (reading.kind === 'conflict' || reading.kind === 'ambiguous') {
          this.finishAttempt(entry, mine!, now, { outcome: 'rejected', code: reading.kind === 'ambiguous' ? 'SOP_UID_AMBIGUOUS' : 'SOP_CONTENT_CONFLICT', transport: mine!.transport }, 'may-have-written');
        }
      }
      await this.saveImport(tx, op, r, results, now);
      if (reading.kind !== 'failed')
        await this.auditResult(tx, r.owner.institutionId, r.operationId, entry, mine, now, { institutionNameMismatch: file.institutionNameMismatch });
      return fileAnswer(entry);
    }));
  }

  /** A reader's own right on an unknown attempt: still the file's last attempt, unknown, with the very lease it set, live. */
  private readingHeld(entry: ImportFileEntry | undefined, attempt: ImportAttempt, token: string, now: Date): boolean {
    const last = entry ? lastAttempt(entry) : null;
    return !!last && last.attemptId === attempt.attemptId && last.phase === 'unknown' && last.leaseUntil === token && leaseLive(last, now);
  }

  /**
   * Take the reading right of an expired unknown attempt (GET, startup, the automatic re-check, the admin recovery): a
   * fresh lease for this reader, so no other reader acts on it meanwhile. A dispatching attempt whose lease ran out first
   * becomes unknown (its result was never written); the caller writes that generation's unconfirmed result row.
   */
  private takeReading(entry: ImportFileEntry, attempt: ImportAttempt, now: Date): boolean {
    const wasDispatching = attempt.phase === 'dispatching';
    if (wasDispatching) this.markUnknown(entry, attempt, now);
    attempt.leaseUntil = later(now, LEASE_MS);
    return wasDispatching;
  }

  /**
   * The attempt's result, committed with its audit under the claim -> operation locks and the worker's CAS. A lost CAS
   * writes no result: a prepared attempt whose own lease ran out is fenced by its worker as anyone would (certain-no-write,
   * IMPORT_ATTEMPT_EXPIRED); a dispatched one leaves its result unknown for the reconciliation (4.4).
   */
  private finish(r: ImportRequest, attempt: ImportAttempt, change: { outcome: ImportOutcome; code: ImportCode | null;
    transport: ImportAttempt['transport']; disposition: WriteDisposition | null; release: boolean; from: string[]; phase?: 'unknown' }): Promise<ImportAnswer> {
    const file = r.precheck as AcceptedFile;
    const said = { institutionNameMismatch: file.institutionNameMismatch };
    return this.write(async tx => {
      const claims = await this.lockClaims(tx, [studyKey(file.studyUid), sopKey(file.sopUid)]);
      const op = await this.lockOperation(tx, r.operationId);
      const now = await this.clock(tx);
      const results: ImportFileEntry[] = clone(op.results);
      const entry = results.find(e => e.index === r.index)!;
      const mine = lastAttempt(entry);
      if (!holdsAttempt(entry, attempt, now, change.from)) {
        if (change.from.includes('prepared') && mine?.attemptId === attempt.attemptId && fileState(entry, now) === 'expired-prepared') {
          this.finishAttempt(entry, mine, now, { outcome: 'retryable', code: 'IMPORT_ATTEMPT_EXPIRED', transport: 'certain-no-write' });
          await this.releaseHolders(tx, claims, mine.attemptId, now, true);
          await this.saveImport(tx, op, r, results, now);
          await this.auditResult(tx, r.owner.institutionId, r.operationId, entry, mine, now, said);
        }
        return fileAnswer(entry);
      }
      this.finishAttempt(entry, mine!, now, { outcome: change.outcome, code: change.code, transport: change.transport }, change.disposition, change.phase);
      if (change.release) await this.releaseHolders(tx, claims, mine!.attemptId, now, true);
      await this.saveImport(tx, op, r, results, now);
      await this.auditResult(tx, r.owner.institutionId, r.operationId, entry, mine, now, said);
      return fileAnswer(entry);
    }).catch(() => {
      // After the POST a result that could not be committed with its audit leaves the file Unconfirmed with its holders
      // (no rollback-delete, 4.4); before any write it is 503 with nothing changed (the prepared attempt expires and is fenced).
      if (change.from.includes('dispatching')) return this.unconfirmedAnswer(r, attempt);
      throw new ServiceUnavailableException({ code: 'IMPORT_STORAGE_UNAVAILABLE', message: IMPORT_STORAGE_MESSAGE });
    });
  }

  private unconfirmedAnswer(r: ImportRequest, attempt: ImportAttempt): ImportAnswer {
    const file = r.precheck as AcceptedFile;
    const entry: ImportFileEntry = { index: r.index, sha256: r.sha256, bytes: r.bytes.length, studyUid: file.studyUid, seriesUid: file.seriesUid,
      sopUid: file.sopUid, expectedStudyUid: r.expectedStudyUid, outcome: 'unconfirmed', code: 'IMPORT_UNCONFIRMED', identity: null,
      writeDisposition: null, at: attempt.startedAt, attempts: [attempt] };
    return fileAnswer(entry);
  }

  private async current(r: ImportRequest): Promise<ImportAnswer> {
    const op = await this.storage(async () => {
      const row = await this.prisma.importOperation.findUnique({ where: { id: r.operationId } });
      return row ? checkImportRow(row) : null;
    });
    const entry = (op?.results as any[] ?? []).find((e: any) => e.index === r.index);
    if (!entry) throw new ServiceUnavailableException({ code: 'IMPORT_STORAGE_UNAVAILABLE', message: IMPORT_STORAGE_MESSAGE });
    return fileAnswer(entry);
  }

  /** prepared -> dispatching under the claim -> operation locks, only under the worker's CAS and while it holds both claims. */
  private markDispatching(r: ImportRequest, attempt: ImportAttempt): Promise<boolean> {
    const file = r.precheck as AcceptedFile;
    return this.write(async tx => {
      const claims = await this.lockClaims(tx, [studyKey(file.studyUid), sopKey(file.sopUid)]);
      const op = await this.lockOperation(tx, r.operationId);
      const now = await this.clock(tx);
      const results: ImportFileEntry[] = clone(op.results);
      const entry = results.find(e => e.index === r.index);
      const holds = [...claims.values()].every(row => row && row.claim.heldByAttemptId === attempt.attemptId);
      if (!holdsAttempt(entry, attempt, now, ['prepared']) || !holds) return false;
      const mine = lastAttempt(entry!)!;
      mine.phase = 'dispatching';
      mine.leaseUntil = later(now, LEASE_MS);
      await this.saveImport(tx, op, r, results, now);
      return true;
    });
  }

  /**
   * A Study/SOP holder blocks unless it is a prepared attempt whose lease ran out (that one is fenced first). The holder
   * must be an attempt of a file of this very claim (its Study, and for a SOP claim its SOP): anything else is a stored
   * relation that the gate did not write and never repairs. An initializing Study claim whose attempt is gone is the
   * startup pass's to remove (nothing was written for it); until then it blocks like any other holder.
   */
  private async holderBlocks(tx: Tx, row: NonNullable<ClaimRow>, now: Date): Promise<boolean | 'expired'> {
    const found = await this.findAttempt(tx, row.claim.heldByAttemptId);
    if (!found) {
      if (row.kind === 'study-claim' && row.claim.phase === 'initializing') return true;
      throw new StoredFormatError('claim holder of ' + row.claimKey);
    }
    if (found.entry.studyUid !== row.studyUid || (row.kind === 'sop-claim' && found.entry.sopUid !== row.claim.sopUid))
      throw new StoredFormatError('claim holder of ' + row.claimKey);
    return lastAttempt(found.entry)?.attemptId === found.attempt.attemptId && fileState(found.entry, now) === 'expired-prepared' ? 'expired' : true;
  }

  private async findAttempt(db: Tx, attemptId: string): Promise<{ opId: string; entry: ImportFileEntry; attempt: ImportAttempt } | null> {
    const probe = JSON.stringify([{ attempts: [{ attemptId }] }]);
    const rows: any[] = await db.$queryRaw`SELECT * FROM "ImportOperation" WHERE kind = 'import' AND results @> ${probe}::jsonb`;
    for (const row of rows) for (const entry of checkImportRow(row).results as ImportFileEntry[]) {
      const attempt = entry.attempts.find(a => a.attemptId === attemptId);
      if (attempt) return { opId: row.id, entry, attempt };
    }
    return null;
  }

  /**
   * Fence a prepared attempt whose lease ran out (it never sent anything): retryable IMPORT_ATTEMPT_EXPIRED, only its own
   * holders released, an initializing Study claim it held deleted (no Orthanc write happened; the next import reads again).
   */
  private async fenceExpired(attemptId: string): Promise<void> {
    const seen = await this.findAttempt(this.prisma, attemptId);
    if (!seen) return;
    const keys = [seen.entry.studyUid && studyKey(seen.entry.studyUid), seen.entry.sopUid && sopKey(seen.entry.sopUid)].filter(Boolean) as string[];
    await this.write(async tx => {
      const claims = await this.lockClaims(tx, keys);
      const op = await this.lockOperation(tx, seen.opId);
      const now = await this.clock(tx);
      if (!op) return;
      const results: ImportFileEntry[] = clone(op.results);
      const entry = results.find(e => e.index === seen.entry.index);
      const attempt = entry && lastAttempt(entry);
      if (!entry || !attempt || attempt.attemptId !== attemptId || fileState(entry, now) !== 'expired-prepared') return;
      this.finishAttempt(entry, attempt, now, { outcome: 'retryable', code: 'IMPORT_ATTEMPT_EXPIRED', transport: 'certain-no-write' });
      await this.releaseHolders(tx, claims, attemptId, now, true);
      await tx.importOperation.update({ where: { id: op.id }, data: { results: results as any, status: this.settledStatus(results), updatedAt: now } });
      await this.auditResult(tx, op.institutionId, op.id, entry, attempt, now);
    });
  }

  /** New Study UID without StudyState: one bounded enumeration before any reservation (4.4 "StudyState가 아직 없으면"). */
  private async enumerateNewStudy(studyUid: string): Promise<{ failed: boolean; count: number }> {
    try {
      const ids = await this.orthancJson('POST', '/tools/find', JSON.stringify({ Level: 'Instance', Query: { StudyInstanceUID: studyUid },
        Limit: ENUMERATION_SENTINEL, Expand: false }), CONTEXT_LIMIT);
      // Any answer that is not a clean empty list means originals may exist: the ownership is undetermined.
      return { failed: false, count: Array.isArray(ids) ? ids.length : 1 };
    } catch (error) {
      return error instanceof OrthancFailure && ['size', 'decode', 'parse'].includes(error.kind) ? { failed: false, count: 1 } : { failed: true, count: 0 };
    }
  }

  /**
   * 4.4 steps 1-4: one enumeration of the study's exact instance set, then the stored-file header of every instance, one
   * at a time, each 5 s / 16 MiB, all within 240 s; at most 4,097 Orthanc requests. Only a failed first enumeration is
   * "unavailable" (503); every later failure is "unresolved" (409); a partial read is never judged.
   */
  async readExistingStudy(studyUid: string, institutionId: string, lease?: AbortSignal): Promise<InitVerdict> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), INIT_BUDGET_MS);
    const started = performance.now();
    const stop = () => deadline.abort();
    lease?.addEventListener('abort', stop, { once: true });
    try {
      let ids: any;
      try {
        ids = await this.orthancJson('POST', '/tools/find', JSON.stringify({ Level: 'Instance', Query: { StudyInstanceUID: studyUid },
          Limit: ENUMERATION_SENTINEL, Expand: false }), CONTEXT_LIMIT, deadline.signal);
      } catch (error) {
        if (lease?.aborted) return { kind: 'lost' };
        return error instanceof OrthancFailure && ['size', 'decode', 'parse'].includes(error.kind) ? { kind: 'unresolved' } : { kind: 'unavailable' };
      }
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !ORTHANC_ID.test(id)) || new Set(ids).size !== ids.length)
        return { kind: 'unresolved' };
      if (ids.length === 0) return { kind: 'empty' };
      if (ids.length >= ENUMERATION_SENTINEL) return { kind: 'unresolved' };
      const headers: any[] = [];
      for (const id of ids) {
        if (performance.now() - started >= INIT_BUDGET_MS) return { kind: 'unresolved' };
        try {
          const h = await this.orthancJson('GET', `/instances/${id}/tags?simplify`, undefined, CONTEXT_LIMIT, deadline.signal);
          // Keep the seven values only; the rest of a (possibly large) header is released at once.
          headers.push(h && typeof h === 'object' && !Array.isArray(h) ? pick(h) : h);
        } catch {
          if (lease?.aborted) return { kind: 'lost' };
          return { kind: 'unresolved' };
        }
      }
      if (performance.now() - started >= INIT_BUDGET_MS) return { kind: 'unresolved' };
      return judgeExistingHeaders(headers, studyUid, institutionId, await this.institutions());
    } finally {
      clearTimeout(timer);
      lease?.removeEventListener('abort', stop);
    }
  }

  // ── GET status, startup reconciliation and the admin recovery ──

  /** The owner's own member import row in its persisted format; null for another owner, another kind or no row (one 404). */
  async ownImport(owner: ImportOwner, operationId: string): Promise<any | null> {
    const op = await this.storage(() => this.prisma.importOperation.findUnique({ where: { id: operationId } }));
    if (!op || !this.sameOwner(op, owner, 'import')) return null;
    return this.storage(async () => checkImportRow(op));
  }

  /**
   * GET /api/dicom-import/:id after the route's own access checks: the 4.4 table applied by DB time - an expired prepared
   * attempt is fenced (IMPORT_ATTEMPT_EXPIRED, its own holders released, its result row; no Orthanc write) and an expired
   * unknown one is reconciled read-only when Orthanc answers. A live attempt is never touched.
   */
  async importStatus(owner: ImportOwner, operationId: string, orthanc: boolean) {
    const op = await this.ownImport(owner, operationId);
    if (!op) throw new NotFoundException('반입 작업을 찾을 수 없습니다');
    const now = await this.storage(() => this.dbNow());
    for (const entry of op.results as ImportFileEntry[]) {
      const state = fileState(entry, now);
      if (state === 'expired-prepared') await this.fenceExpired(lastAttempt(entry)!.attemptId).catch(() => undefined);
      else if (state === 'expired-unknown') await this.reconcileUnknown(op.id, entry.index, lastAttempt(entry)!.attemptId, orthanc);
    }
    const fresh = await this.ownImport(owner, operationId);
    if (!fresh) throw new NotFoundException('반입 작업을 찾을 수 없습니다');
    return { operationId, status: fresh.status, files: (fresh.results as ImportFileEntry[]).map(entry => this.publicFile(entry)) };
  }

  /** A file as the routes answer it. Its message is the one table's description of its code (no bytes here to read again). */
  publicFile(entry: ImportFileEntry) {
    const answer = fileAnswer(entry);
    const last = lastAttempt(entry);
    return { index: entry.index, outcome: entry.outcome, code: entry.code, message: answer.message, identity: entry.identity,
      writeDisposition: entry.writeDisposition, studyUid: entry.studyUid, seriesUid: entry.seriesUid, sopUid: entry.sopUid,
      sha256: entry.sha256, bytes: entry.bytes, at: entry.at, generation: last ? last.generation : 0,
      attempts: entry.attempts.map(a => ({ attemptId: a.attemptId, generation: a.generation, phase: a.phase, outcome: a.outcome, code: a.code,
        transport: a.transport, startedAt: a.startedAt, finishedAt: a.finishedAt, autoRecheckedAt: a.autoRecheckedAt,
        recovery: a.recovery ? { basis: a.recovery.basis, checkedAt: a.recovery.checkedAt, requestedAt: a.recovery.requestedAt, resolvedAt: a.recovery.resolvedAt } : null })) };
  }

  /**
   * An expired dispatching or unknown attempt, read only (GET and startup). Under the row locks a dispatching attempt
   * becomes unknown with its generation's unconfirmed result row, and the reading right is taken; then one bounded SOP
   * read; then, under the same locks and only while that right is still this reader's: exact -> stored (holders
   * released), confirmed different -> rejected may-have-written (occupancy kept), otherwise Unconfirmed as it was. Never a
   * resend, never a release on absence; the right is given back at the end.
   */
  private async reconcileUnknown(operationId: string, index: number, attemptId: string, orthanc: boolean): Promise<void> {
    try {
      const op = await this.prisma.importOperation.findUnique({ where: { id: operationId } });
      if (!op) return;
      const seen = (checkImportRow(op).results as ImportFileEntry[]).find(e => e.index === index);
      if (!seen?.studyUid || !seen.sopUid) return;
      const keys = [studyKey(seen.studyUid), sopKey(seen.sopUid)];
      const taken = await this.write(async tx => {
        const claims = await this.lockClaims(tx, keys);
        const locked = await this.lockOperation(tx, operationId);
        const now = await this.clock(tx);
        const results: ImportFileEntry[] = clone(locked.results);
        const entry = results.find(e => e.index === index);
        const mine = entry && lastAttempt(entry);
        if (!entry || !mine || mine.attemptId !== attemptId || fileState(entry, now) !== 'expired-unknown') return null;
        const claim = claims.get(sopKey(seen.sopUid))?.claim;
        const readable = orthanc && !!claim && claim.sha256 === entry.sha256;
        const wasDispatching = readable ? this.takeReading(entry, mine, now) : mine.phase === 'dispatching';
        if (!readable && wasDispatching) this.markUnknown(entry, mine, now);
        if (!readable && !wasDispatching) return null;
        await tx.importOperation.update({ where: { id: operationId }, data: { results: results as any, updatedAt: now } });
        if (wasDispatching) await this.auditResult(tx, locked.institutionId, operationId, entry, mine, now);
        return readable ? { token: mine.leaseUntil, attempt: mine, patientId: claim.patientId as string } : null;
      });
      if (!taken) return;
      const reading = await this.readSop({ studyUid: seen.studyUid, seriesUid: seen.seriesUid, sopUid: seen.sopUid, patientId: taken.patientId } as AcceptedFile,
        seen.bytes, seen.sha256, null);
      await this.write(async tx => {
        const claims = await this.lockClaims(tx, keys);
        const locked = await this.lockOperation(tx, operationId);
        const now = await this.clock(tx);
        const results: ImportFileEntry[] = clone(locked.results);
        const entry = results.find(e => e.index === index)!;
        if (!this.readingHeld(entry, taken.attempt, taken.token, now)) return;
        const mine = lastAttempt(entry)!;
        mine.leaseUntil = iso(now);
        const settled = reading.kind === 'exact' || reading.kind === 'conflict' || reading.kind === 'ambiguous';
        if (reading.kind === 'exact') {
          this.finishAttempt(entry, mine, now, { outcome: 'stored', code: null, transport: mine.transport });
          await this.releaseHolders(tx, claims, attemptId, now, false);
        } else if (settled) {
          this.finishAttempt(entry, mine, now, { outcome: 'rejected', code: reading.kind === 'ambiguous' ? 'SOP_UID_AMBIGUOUS' : 'SOP_CONTENT_CONFLICT', transport: mine.transport }, 'may-have-written');
        }
        await tx.importOperation.update({ where: { id: operationId }, data: { results: results as any, status: this.settledStatus(results), updatedAt: now } });
        if (settled) await this.auditResult(tx, locked.institutionId, operationId, entry, mine, now);
      });
    } catch { /* GET and the startup pass answer what is stored; the next reader reads again */ }
  }

  /**
   * Startup (4.4 "복원·maintenance"): 500-row cursor batches, the same table as every request. An expired prepared attempt
   * is fenced; an expired dispatching/unknown one is reconciled read-only; an initializing claim whose attempt is gone is
   * deleted (no write happened). A live lease - another instance's included - is never taken. (Expired download attempts
   * are the download service's own startup pass.)
   */
  async reconcileOnStart(): Promise<{ fenced: number; reconciled: number; claimsRemoved: number }> {
    const counts = { fenced: 0, reconciled: 0, claimsRemoved: 0 };
    if (!await this.migrationApplied()) return counts;
    const orthanc = await this.orthancAnswering();
    let cursor: string | null = null;
    for (;;) {
      const page: any[] = await this.prisma.importOperation.findMany({ where: { kind: 'import', status: 'open', ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' }, take: 500 });
      for (const op of page) {
        // A row that is not its persisted format is left exactly as it is (never rebuilt); a request on it answers 503.
        try { checkImportRow(op); } catch { this.logger.warn('import reconciliation: a stored row is not in its format; left as it is'); continue; }
        const now = await this.dbNow();
        for (const entry of op.results as ImportFileEntry[]) {
          const state = fileState(entry, now);
          if (state === 'expired-prepared') { await this.fenceExpired(lastAttempt(entry)!.attemptId).catch(() => undefined); counts.fenced++; }
          else if (state === 'expired-unknown') { await this.reconcileUnknown(op.id, entry.index, lastAttempt(entry)!.attemptId, orthanc); counts.reconciled++; }
        }
      }
      if (page.length < 500 || this.stopping) break;
      cursor = page[page.length - 1].id;
    }
    cursor = null;
    for (;;) {
      const page: any[] = await this.prisma.importOperation.findMany({ where: { kind: 'study-claim', ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' }, take: 500 });
      for (const row of page) {
        if (row.claim?.phase !== 'initializing') continue;
        const holder = row.claim.heldByAttemptId ? await this.findAttempt(this.prisma, row.claim.heldByAttemptId).catch(() => 'unknown') : null;
        if (holder) continue;   // its attempt was fenced above, or is live elsewhere (or could not be read: left as it is)
        await this.write(async tx => {
          const claims = await this.lockClaims(tx, [row.claimKey]);
          const locked = claims.get(row.claimKey);
          if (locked && locked.claim.phase === 'initializing' && !(locked.claim.heldByAttemptId && await this.findAttempt(tx, locked.claim.heldByAttemptId))) {
            await tx.importOperation.delete({ where: { id: locked.id } });
            counts.claimsRemoved++;
          }
        }).catch(() => undefined);
      }
      if (page.length < 500 || this.stopping) break;
      cursor = page[page.length - 1].id;
    }
    if (counts.fenced || counts.reconciled || counts.claimsRemoved)
      this.logger.log(`import reconciliation: fenced ${counts.fenced}, reconciled ${counts.reconciled}, claims removed ${counts.claimsRemoved}`);
    return counts;
  }

  /**
   * What the admin recovery read, as one comparable value: the attempt (id, generation, phase, lease), the file's result,
   * both claims' holders and the recovery record itself (whose admin, basis and time tell two requests apart even within
   * one database millisecond). The result is committed only if this is still exactly what it was.
   */
  private recoverySnapshot(entry: ImportFileEntry, mine: ImportAttempt, claims: Map<string, ClaimRow>): string {
    return JSON.stringify([mine.attemptId, mine.generation, mine.phase, mine.leaseUntil, entry.outcome, entry.code, entry.writeDisposition,
      mine.recovery, [...claims.entries()].map(([key, row]) => [key, row ? row.claim.heldByAttemptId : null])]);
  }

  /**
   * POST /api/admin/dicom-import/:operationId/files/:index/recovery (4.4 "관리자 확인"):
   *   1. the request record and its audit row in one transaction (an expired unknown attempt's reading right taken with
   *      them, so no GET, re-check or other recovery reads it meanwhile);
   *   2. the same bounded SOP re-read for both kinds - an unknown attempt and a may-have-written occupancy (a failed read
   *      is 503 ORTHANC_UNAVAILABLE: result and occupancy unchanged, only the reading right given back);
   *   3./4. the result, the release and both result rows in one transaction, only while everything read in step 1 is
   *      still exactly as it was (recoverySnapshot): a reconciliation or another admin request that won meanwhile makes
   *      this one 409 RECOVERY_NOT_APPLICABLE with nothing written.
   * The target index's study is checked against the admin's reach now (`scope`, contract 3) before anything else is
   * judged or read, and again inside both transactions: out of reach first is the same 404 as no operation, with no SOP
   * read and no row; lost during the Orthanc re-read it is that 404 with nothing of the result written (the request row
   * and the reading right recorded while it was in reach stay). Another owner's operation of the admin's institution is
   * recovered under the same rule; its owner and attempts stay, the admin is recorded beside them.
   * The admin route never writes to or deletes from Orthanc.
   */
  async recover(admin: ImportOwner, operationId: string, index: number, body: unknown, scope: RecoveryScope) {
    const op = await this.storage(() => this.prisma.importOperation.findUnique({ where: { id: operationId } }));
    const mineToSee = !!op && op.kind === 'import' && op.institutionId === admin.institutionId;
    if (mineToSee) await this.storage(async () => checkImportRow(op));
    const seen = mineToSee ? (op.results as any as ImportFileEntry[]).find(e => e.index === index) : null;
    if (!seen) throw new NotFoundException('반입 작업을 찾을 수 없습니다');
    // A file refused before any study has none: not a recovery target (409 below), never a question of scope.
    if (seen.studyUid) await scope.before(seen.studyUid);
    const evidence = parseRecoveryBody(body);
    if (!evidence) throw new HttpException({ code: 'RECOVERY_EVIDENCE_INVALID', message: RECOVERY_NOTICES.evidence }, 400);
    const notApplicable = () => new HttpException({ code: 'RECOVERY_NOT_APPLICABLE', message: RECOVERY_NOTICES.notApplicable }, 409);
    if (!seen.studyUid || !seen.sopUid) throw notApplicable();
    const keys = [studyKey(seen.studyUid), sopKey(seen.sopUid)];
    const requested = await this.storage(() => this.write(async tx => {
      const claims = await this.lockClaims(tx, keys);
      const locked = await this.lockOperation(tx, operationId);
      const results: ImportFileEntry[] = clone(locked.results);
      const entry = results.find(e => e.index === index)!;
      await scope.locked(tx, entry.studyUid!);
      const now = await this.clock(tx);
      const mine = lastAttempt(entry);
      const holds = !!mine && [...claims.values()].some(row => row?.claim?.heldByAttemptId === mine.attemptId);
      const unknown = !!mine && fileState(entry, now) === 'expired-unknown';
      const occupied = !!mine && entry.outcome === 'rejected' && entry.writeDisposition === 'may-have-written' && holds;
      if (!unknown && !occupied) throw notApplicable();
      const checkedAt = utcInstant(evidence.checkedAt)!;
      if (checkedAt < Date.parse(mine!.startedAt) || checkedAt > now.getTime())
        throw new HttpException({ code: 'RECOVERY_EVIDENCE_INVALID', message: RECOVERY_NOTICES.evidence }, 400);
      const sop = claims.get(sopKey(seen.sopUid!));
      if (!sop) throw new StoredFormatError('the SOP claim of a dispatched attempt');
      const wasDispatching = unknown ? this.takeReading(entry, mine!, now) : false;
      mine!.recovery = { basis: evidence.basis, checkedAt: evidence.checkedAt, adminIssuer: admin.ownerIssuer, adminSubject: admin.ownerSubject,
        adminActor: admin.actor, requestedAt: iso(now), resolvedAt: null };
      await tx.importOperation.update({ where: { id: operationId }, data: { results: results as any, updatedAt: now } });
      if (wasDispatching) await this.auditResult(tx, locked.institutionId, operationId, entry, mine, now);
      await tx.auditLog.create({ data: { actor: admin.actor, action: 'dicom.import.recovery.request', target: entry.studyUid ?? operationId,
        detail: JSON.stringify({ institutionId: locked.institutionId, operationId, index, attemptId: mine!.attemptId, generation: mine!.generation,
          basis: evidence.basis, checkedAt: evidence.checkedAt, adminIssuer: admin.ownerIssuer, adminSubject: admin.ownerSubject, at: iso(now) }) } });
      return { snapshot: this.recoverySnapshot(entry, mine!, claims), unknown, patientId: sop.claim.patientId as string,
        sha256: entry.sha256, bytes: entry.bytes };
    }));
    const reading = await this.readSop({ studyUid: seen.studyUid, seriesUid: seen.seriesUid, sopUid: seen.sopUid, patientId: requested.patientId } as AcceptedFile,
      requested.bytes, requested.sha256, null);
    const underSnapshot = <T>(work: (tx: Tx, entry: ImportFileEntry, mine: ImportAttempt, claims: Map<string, ClaimRow>, locked: any, now: Date) => Promise<T>,
      write = true) =>
      this.write(async tx => {
        const claims = await this.lockClaims(tx, keys);
        const locked = await this.lockOperation(tx, operationId);
        const results: ImportFileEntry[] = clone(locked.results);
        const entry = results.find(e => e.index === index)!;
        await scope.locked(tx, entry.studyUid!);
        const now = await this.clock(tx);
        const mine = lastAttempt(entry);
        if (!mine || this.recoverySnapshot(entry, mine, claims) !== requested.snapshot || (requested.unknown && !leaseLive(mine, now))) throw notApplicable();
        const answer = await work(tx, entry, mine, claims, locked, now);
        if (write) await tx.importOperation.update({ where: { id: operationId }, data: { results: results as any, status: this.settledStatus(results), updatedAt: now } });
        return answer;
      });
    if (reading.kind === 'failed') {
      // The reading right goes back (unknown) only while the study is still in reach; out of reach (or the admin's rights
      // gone) answers that refusal, the right then simply runs out. Anything else: the Orthanc answer, nothing changed.
      await underSnapshot(async (_tx, _entry, mine, _claims, _locked, now) => { if (requested.unknown) mine.leaseUntil = iso(now); }, requested.unknown)
        .catch(failure => { if (failure instanceof HttpException && [403, 404].includes(failure.getStatus())) throw failure; });
      throw new ServiceUnavailableException({ code: 'ORTHANC_UNAVAILABLE', message: RECOVERY_NOTICES.orthanc });
    }
    return this.storage(() => underSnapshot(async (tx, entry, mine, claims, locked, now) => {
      let notice: string;
      if (!requested.unknown) notice = RECOVERY_NOTICES.mayHaveWritten;
      else if (reading.kind === 'exact') {
        this.finishAttempt(entry, mine, now, { outcome: 'stored', code: null, transport: mine.transport });
        notice = RECOVERY_NOTICES.stored;
      } else if (reading.kind === 'absent') {
        this.finishAttempt(entry, mine, now, { outcome: 'retryable', code: 'RECOVERED_NO_OBJECT', transport: mine.transport });
        notice = RECOVERY_NOTICES.noObject;
      } else {
        this.finishAttempt(entry, mine, now, { outcome: 'rejected', code: reading.kind === 'ambiguous' ? 'SOP_UID_AMBIGUOUS' : 'SOP_CONTENT_CONFLICT', transport: mine.transport }, 'may-have-written');
        notice = RECOVERY_NOTICES.mayHaveWritten;
      }
      mine.recovery!.resolvedAt = iso(now);
      await this.releaseHolders(tx, claims, mine.attemptId, now, false);
      await tx.auditLog.create({ data: { actor: admin.actor, action: 'dicom.import.recovery.result', target: entry.studyUid ?? operationId,
        detail: JSON.stringify({ institutionId: locked.institutionId, operationId, index, attemptId: mine.attemptId, generation: mine.generation,
          basis: mine.recovery!.basis, checkedAt: mine.recovery!.checkedAt, adminIssuer: admin.ownerIssuer, adminSubject: admin.ownerSubject,
          outcome: entry.outcome, code: entry.code, at: iso(now) }) } });
      await this.auditResult(tx, locked.institutionId, operationId, entry, mine, now, { actor: admin.actor });
      return { operationId, index, outcome: entry.outcome, code: entry.code, writeDisposition: entry.writeDisposition, message: notice };
    }));
  }

  /**
   * H's disposal hook (4.4 claim lifetime, U4P3-07): inside H's retention lock, delete the Study claim and every SOP claim
   * of the study, so no patient identity value of the disposed originals stays here. Refused CLAIM_OCCUPIED (nothing
   * deleted) while any of them has a holder or a new reservation appears meanwhile; H then counts the set incomplete.
   */
  async disposeImportClaims(studyUid: string, tx?: Tx): Promise<{ disposed: number } | { refused: 'CLAIM_OCCUPIED' }> {
    const work = async (db: Tx) => {
      const listed = async () => (await db.importOperation.findMany({ where: { kind: 'sop-claim', studyUid }, select: { claimKey: true } }))
        .map((row: any) => row.claimKey as string).sort();
      const before = await listed();
      const claims = await this.lockClaims(db, [studyKey(studyUid), ...before]);
      const after = await listed();
      if (JSON.stringify(after) !== JSON.stringify(before)) return { refused: 'CLAIM_OCCUPIED' as const };
      const rows = [...claims.values()].filter(Boolean);
      if (rows.some(row => row.claim?.heldByAttemptId)) return { refused: 'CLAIM_OCCUPIED' as const };
      for (const row of rows) await db.importOperation.delete({ where: { id: row.id } });
      return { disposed: rows.length };
    };
    return tx ? work(tx) : this.write(work);
  }

  // ── reservations, entries and audit rows ──

  private studyClaim(file: AcceptedFile, institutionId: string, phase: 'initializing' | 'bound', holder: string, now: Date, values: boolean) {
    return { schemaVersion: 1, phase, institutionId, studyUid: file.studyUid,
      patientId: values ? file.patientId : null, issuerInstitutionId: values ? file.issuerInstitutionId : null,
      nameKey: values ? file.nameKey : null, birthKey: values ? file.birthKey : null, sexKey: values ? file.sexKey : null,
      heldByAttemptId: holder, createdAt: iso(now) };
  }

  private sopClaim(file: AcceptedFile, r: ImportRequest, holder: string, now: Date) {
    return { schemaVersion: 1, institutionId: r.owner.institutionId, studyUid: file.studyUid, seriesUid: file.seriesUid, sopUid: file.sopUid,
      patientId: file.patientId, issuerInstitutionId: file.issuerInstitutionId, sha256: r.sha256, bytes: r.bytes.length,
      heldByAttemptId: holder, createdAt: iso(now) };
  }

  private async createClaim(tx: Tx, kind: 'study-claim' | 'sop-claim', studyUid: string, claimKey: string, claim: any, now: Date) {
    await tx.importOperation.create({ data: { id: randomUUID(), institutionId: claim.institutionId, ...INTERNAL, kind, studyUid,
      status: 'reserved', results: [], claimKey, claim, createdAt: now, updatedAt: now } });
  }

  private async updateClaim(tx: Tx, row: ClaimRow, claim: any, now: Date) {
    await tx.importOperation.update({ where: { id: row.id }, data: { claim, updatedAt: now } });
  }

  /**
   * Release only the holders this attempt holds; an initializing Study claim it held goes away when asked (no write). The
   * locked rows of this transaction are updated in place, so the decisions after a release read what was committed.
   */
  private async releaseHolders(tx: Tx, claims: Map<string, ClaimRow>, attemptId: string, now: Date, dropInitializing: boolean) {
    for (const [key, row] of claims) {
      if (!row || row.claim?.heldByAttemptId !== attemptId) continue;
      if (dropInitializing && row.kind === 'study-claim' && row.claim.phase === 'initializing') {
        await tx.importOperation.delete({ where: { id: row.id } });
        claims.set(key, null);
      } else {
        const claim = { ...row.claim, heldByAttemptId: null };
        await this.updateClaim(tx, row, claim, now);
        claims.set(key, { ...row, claim });
      }
    }
  }

  /** A new file entry; its three UIDs when the reader accepted the bytes (even if the file is then refused), else null. */
  private newEntry(r: ImportRequest, file: { studyUid: string; seriesUid: string; sopUid: string } | null, now: Date): ImportFileEntry {
    return { index: r.index, sha256: r.sha256, bytes: r.bytes.length, studyUid: file?.studyUid ?? null, seriesUid: file?.seriesUid ?? null,
      sopUid: file?.sopUid ?? null, expectedStudyUid: r.expectedStudyUid, outcome: 'unconfirmed', code: 'IMPORT_UNCONFIRMED', identity: null,
      writeDisposition: null, at: iso(now), attempts: [] };
  }

  private newAttempt(entry: ImportFileEntry, actor: string, now: Date): ImportAttempt {
    const generation = entry.attempts.reduce((max, a) => Math.max(max, a.generation), 0) + 1;
    return { attemptId: randomUUID(), actor, generation, ownerInstance: this.bootId, phase: 'prepared', leaseUntil: later(now, LEASE_MS),
      startedAt: iso(now), finishedAt: null, outcome: 'unconfirmed', code: 'IMPORT_UNCONFIRMED', transport: null, autoRecheckedAt: null, recovery: null };
  }

  private settle(entry: ImportFileEntry, now: Date, code: ImportCode, outcome: ImportOutcome, disposition: WriteDisposition | null) {
    entry.outcome = outcome; entry.code = code; entry.writeDisposition = disposition; entry.at = iso(now);
  }

  private finishAttempt(entry: ImportFileEntry, attempt: ImportAttempt, now: Date,
    result: { outcome: ImportOutcome; code: ImportCode | null; transport: ImportAttempt['transport'] }, disposition: WriteDisposition | null = null,
    phase: 'finished' | 'unknown' = 'finished') {
    attempt.phase = phase; attempt.finishedAt = iso(now);
    attempt.outcome = result.outcome; attempt.code = result.code; attempt.transport = result.transport;
    entry.outcome = result.outcome; entry.code = result.code; entry.writeDisposition = disposition; entry.at = iso(now);
  }

  /** A dispatching attempt whose result was never written (lease ran out, process ended): unknown, entry Unconfirmed. */
  private markUnknown(entry: ImportFileEntry, attempt: ImportAttempt, now: Date) {
    attempt.phase = 'unknown'; attempt.transport = attempt.transport ?? 'unknown'; attempt.finishedAt = iso(now);
    attempt.outcome = 'unconfirmed'; attempt.code = 'IMPORT_UNCONFIRMED';
    entry.outcome = 'unconfirmed'; entry.code = 'IMPORT_UNCONFIRMED'; entry.at = iso(now);
  }

  private settledStatus(results: ImportFileEntry[]) {
    return results.every(entry => FINAL_OUTCOMES.has(entry.outcome)) ? 'settled' : 'open';
  }

  private async saveImport(tx: Tx, op: any, r: ImportRequest, results: ImportFileEntry[], now: Date) {
    const status = this.settledStatus(results);
    if (op) await tx.importOperation.update({ where: { id: op.id }, data: { results: results as any, status, updatedAt: now } });
    else await tx.importOperation.create({ data: { id: r.operationId, ...r.owner, kind: 'import', studyUid: null, status,
      results: results as any, createdAt: now, updatedAt: now } });
  }

  private sameOwner(op: any, owner: ImportOwner, kind: string) {
    return op.kind === kind && op.ownerIssuer === owner.ownerIssuer && op.ownerSubject === owner.ownerSubject
      && op.institutionId === owner.institutionId;
  }

  private requestConflict(code: 'OPERATION_CONFLICT' | 'OPERATION_CONTENT_CONFLICT') {
    return new HttpException({ code, message: code === 'OPERATION_CONFLICT'
      ? '다른 사용자나 다른 종류의 작업에 쓰인 작업 번호입니다. 새 작업으로 다시 시도하세요.'
      : '이 작업의 같은 파일 번호에 다른 파일이나 다른 검사가 이미 기록되어 있습니다. 기존 결과는 그대로입니다.' }, 409);
  }

  private async institutionName(tx: Tx, id: string): Promise<string> {
    const row = await tx.institution.findUnique({ where: { id } });
    return row?.name ?? id;
  }

  private auditIntent(tx: Tx, r: ImportRequest, entry: ImportFileEntry, attempt: ImportAttempt, now: Date) {
    return tx.auditLog.create({ data: { actor: attempt.actor, action: 'dicom.import.intent', target: entry.studyUid ?? r.operationId,
      detail: JSON.stringify({ institutionId: r.owner.institutionId, operationId: r.operationId, index: entry.index, attemptId: attempt.attemptId,
        generation: attempt.generation, kind: 'import', actor: attempt.actor, ownerIssuer: r.owner.ownerIssuer, ownerSubject: r.owner.ownerSubject,
        studyUid: entry.studyUid, seriesUid: entry.seriesUid, sopUid: entry.sopUid, sha256: entry.sha256, bytes: entry.bytes,
        institutionNameMismatch: r.precheck.institutionNameMismatch, at: iso(now) }) } });
  }

  /**
   * Every file result (final, retryable, unconfirmed; reconciliation, re-check, recovery) has this row; no patient value.
   * The actor is the one who caused this result: the request that refused a file (its own req.actor), the attempt's actor
   * for the attempt's result, the admin for a recovery; never the operation's first actor for someone else's refusal (4.9).
   * Rows written while the request's bytes are at hand carry the InstitutionName mismatch signal (4.3): a boolean or null
   * (no tag), never the tag text.
   */
  private async auditResult(tx: Tx, institutionId: string, operationId: string, entry: ImportFileEntry, attempt: ImportAttempt | null,
    now: Date, by: { actor?: string; institutionNameMismatch?: boolean | null } = {}) {
    const op = await tx.importOperation.findUnique({ where: { id: operationId }, select: { ownerIssuer: true, ownerSubject: true, actor: true } });
    const who = by.actor ?? attempt?.actor ?? op?.actor ?? 'unknown';
    const signal = by.institutionNameMismatch === undefined ? {} : { institutionNameMismatch: by.institutionNameMismatch };
    await tx.auditLog.create({ data: { actor: who, action: 'dicom.import.result', target: entry.studyUid ?? operationId,
      detail: JSON.stringify({ institutionId, operationId, index: entry.index, attemptId: attempt?.attemptId ?? null,
        generation: attempt?.generation ?? 0, kind: 'import', actor: who, ownerIssuer: op?.ownerIssuer ?? null, ownerSubject: op?.ownerSubject ?? null,
        studyUid: entry.studyUid, seriesUid: entry.seriesUid, sopUid: entry.sopUid, sha256: entry.sha256, bytes: entry.bytes,
        outcome: entry.outcome, code: entry.code, writeDisposition: entry.writeDisposition, transport: attempt?.transport ?? null, ...signal,
        at: iso(now) }) } });
  }

  // ── locks and transactions ──

  /** The claim rows of these keys (sorted; advisory lock, then the row), each checked against its persisted format. */
  private async lockClaims(tx: Tx, keys: string[]): Promise<Map<string, ClaimRow>> {
    const rows = new Map<string, ClaimRow>();
    for (const key of [...new Set(keys)].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${advisory(key)}::bigint)`;
      const found: any[] = await tx.$queryRaw`SELECT * FROM "ImportOperation" WHERE "claimKey" = ${key} FOR UPDATE`;
      rows.set(key, found[0] ? checkClaimRow(found[0]) : null);
    }
    return rows;
  }

  /**
   * The operation row, locked after any claim rows. Its advisory lock comes first and holds whether or not the row exists:
   * PostgreSQL's SELECT ... FOR UPDATE locks no absent row, so two requests creating the same new operation id (or an
   * import and a download preparation of one id) are serialised here and the second sees the first's committed row.
   * A member import row is checked against its persisted format.
   */
  async lockOperation(tx: Tx, id: string): Promise<any> {
    await this.lockOperationKey(tx, id);
    const found: any[] = await tx.$queryRaw`SELECT * FROM "ImportOperation" WHERE id = ${id}::uuid FOR UPDATE`;
    const row = found[0] ?? null;
    return row && row.kind === 'import' ? checkImportRow(row) : row;
  }

  /**
   * The advisory lock of an operation id alone, for a statement that then locks the row itself (the download chunk CAS):
   * every transaction takes it before the operation row, so the two locks are never taken in opposite orders.
   */
  async lockOperationKey(tx: Tx, id: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${advisory('operation:' + id)}::bigint)`;
  }

  /**
   * The database's time now. Read after a transaction's locks are held, so a decision on a lease is made at the moment
   * the row is ours, never at a transaction start that may lie before a lock wait (contract 4.4: "잠금 취득 후 유효 DB 시각").
   */
  async clock(db: Tx): Promise<Date> {
    const rows: any[] = await db.$queryRaw`SELECT clock_timestamp() AS now`;
    return new Date(rows[0].now);
  }

  dbNow(): Promise<Date> { return this.clock(this.prisma); }

  /** One short transaction: lock timeout 3 s, no network inside; the work reads the clock after taking its locks. */
  write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      return work(tx);
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 });
  }

  /** Database failures before any Orthanc write are 503 IMPORT_STORAGE_UNAVAILABLE with nothing changed (4.8). */
  private async storage<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({ code: 'IMPORT_STORAGE_UNAVAILABLE', message: IMPORT_STORAGE_MESSAGE });
    }
  }

  /**
   * Renew the attempt's lease every 10 s while its work runs, in the same lock order as every other write of the file
   * (its claims, then the operation row, then the DB time) and under the worker's CAS: a lease that already ran out is
   * never revived. Losing it aborts the work's signal.
   */
  private keepLease(r: ImportRequest, attempt: ImportAttempt, phases: string[]) {
    const file = r.precheck as AcceptedFile;
    const lost = new AbortController();
    const timer = setInterval(() => {
      void this.write(async tx => {
        await this.lockClaims(tx, [studyKey(file.studyUid), sopKey(file.sopUid)]);
        const op = await this.lockOperation(tx, r.operationId);
        const now = await this.clock(tx);
        const results: ImportFileEntry[] = clone(op.results);
        const entry = results.find(e => e.index === r.index);
        if (!holdsAttempt(entry, attempt, now, phases)) return false;
        lastAttempt(entry!)!.leaseUntil = later(now, LEASE_MS);
        await tx.importOperation.update({ where: { id: r.operationId }, data: { results: results as any, updatedAt: now } });
        return true;
      }).then(kept => { if (!kept) lost.abort(); }, () => lost.abort());
    }, RENEW_MS);
    timer.unref?.();
    return { signal: lost.signal, stop: () => clearInterval(timer) };
  }

  // ── Orthanc: this file's own bounded client (OrthancService settings, no access to its private members) ──

  private orthancConfig(): { base: string; auth: string } {
    const user = process.env.ORTHANC_USER, pass = process.env.ORTHANC_PASS;
    if (!user || !pass) throw new OrthancFailure('config');
    return { base: (process.env.ORTHANC_URL ?? 'http://orthanc:8042').replace(/\/$/, ''), auth: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') };
  }

  /**
   * One request with a 5 s deadline to body EOF and a byte cap; the body is returned only for a 200. A transport failure
   * carries whether it ended in the connect phase (4.4); upstream text never leaves this function.
   */
  private async orthancCall(method: 'GET' | 'POST', path: string, body: string | Uint8Array | undefined, limit: number,
    signal?: AbortSignal, contentType = 'text/plain', onChunk?: (chunk: Uint8Array) => boolean): Promise<{ status: number; bytes: Buffer }> {
    const { base, auth } = this.orthancConfig();
    const controller = new AbortController();
    let timedOut = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = () => { controller.abort(); void reader?.cancel().catch(() => undefined); };
    const timer = setTimeout(() => { timedOut = true; abort(); }, READ_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      let response: Response;
      try {
        response = await fetch(base + path, { method, redirect: 'error', signal: controller.signal,
          headers: { Authorization: auth, ...(body === undefined ? {} : { 'Content-Type': contentType }) }, body: body as any });
      } catch (error) {
        throw Object.assign(new OrthancFailure(timedOut ? 'timeout' : 'transport'), { connect: connectPhaseFailure(error, controller.signal.aborted) });
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new OrthancFailure('status');
      }
      reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (onChunk) { if (!onChunk(value)) break; continue; }
          if (total > limit) throw new OrthancFailure('size');
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        if (error instanceof OrthancFailure) throw error;
        throw new OrthancFailure(timedOut ? 'timeout' : 'transport');
      }
      return { status: response.status, bytes: Buffer.concat(chunks) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await reader?.cancel().catch(() => undefined);
    }
  }

  private async orthancJson(method: 'GET' | 'POST', path: string, body: string | undefined, limit: number, signal?: AbortSignal): Promise<any> {
    // /tools/find takes a JSON body, /tools/lookup a bare UID (the OrthancService precedents).
    const contentType = body !== undefined && body.startsWith('{') ? 'application/json' : 'text/plain';
    const { bytes } = await this.orthancCall(method, path, body, limit, signal, contentType);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new OrthancFailure('decode'); }
    try { return JSON.parse(text); } catch { throw new OrthancFailure('parse'); }
  }

  /**
   * 4.5 steps 1/3: lookup (Type Instance only, 256 KiB), then the stored file streamed through SHA-256 and stopped at
   * length + 1, then /simplified-tags (16 MiB) for PatientID and the three UIDs. Exact match only is "exact".
   */
  async readSop(file: AcceptedFile, length: number, sha256: string, expectedId: string | null): Promise<SopReading> {
    try {
      const found = await this.orthancJson('POST', '/tools/lookup', file.sopUid, SMALL_LIMIT);
      if (!Array.isArray(found)) return { kind: 'failed' };
      const instances = found.filter((item: any) => item?.Type === 'Instance');
      if (instances.some((item: any) => typeof item.ID !== 'string' || !ORTHANC_ID.test(item.ID))) return { kind: 'failed' };
      if (instances.length === 0) return { kind: 'absent' };
      if (instances.length > 1) return { kind: 'ambiguous' };
      const id: string = instances[0].ID;
      if (expectedId !== null && id !== expectedId) return { kind: 'conflict' };
      const hash = createHash('sha256');
      let read = 0;
      await this.orthancCall('GET', `/instances/${id}/file`, undefined, length + 1, undefined, 'text/plain', chunk => {
        const room = length + 1 - read;
        const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
        hash.update(part); read += part.byteLength;
        return read <= length;
      });
      const tags = await this.orthancJson('GET', `/instances/${id}/simplified-tags`, undefined, CONTEXT_LIMIT);
      if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return { kind: 'failed' };
      for (const key of ['PatientID', 'StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID'])
        if (typeof tags[key] !== 'string') return { kind: 'failed' };
      const same = read === length && hash.digest('hex') === sha256 && tags.PatientID.trim() === file.patientId
        && tags.StudyInstanceUID === file.studyUid && tags.SeriesInstanceUID === file.seriesUid && tags.SOPInstanceUID === file.sopUid;
      return same ? { kind: 'exact', id } : { kind: 'conflict' };
    } catch { return { kind: 'failed' }; }
  }

  /** 4.5 step 2: one POST /instances of the original bytes; only a connect-phase failure is a certain no-write. */
  private async postInstance(bytes: Buffer): Promise<{ kind: 'ok'; id: string; status: string } | { kind: 'certain-no-write' } | { kind: 'unknown' }> {
    let answer: { status: number; bytes: Buffer };
    try { answer = await this.orthancCall('POST', '/instances', new Uint8Array(bytes), POST_ANSWER_LIMIT, undefined, 'application/dicom'); }
    catch (error: any) { return error instanceof OrthancFailure && (error as any).connect ? { kind: 'certain-no-write' } : { kind: 'unknown' }; }
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(answer.bytes));
      if (parsed && (parsed.Status === 'Success' || parsed.Status === 'AlreadyStored') && typeof parsed.ID === 'string' && ORTHANC_ID.test(parsed.ID))
        return { kind: 'ok', id: parsed.ID, status: parsed.Status };
    } catch { /* an answer that is not the documented shape proves nothing */ }
    return { kind: 'unknown' };
  }

  // ── reads the original download composes (contract 5.2) ──

  /** The study's instance ids (Expand false, one bounded read); null when Orthanc could not be read. */
  async studyInstanceIds(studyUid: string, limit: number): Promise<string[] | null> {
    try {
      const ids = await this.orthancJson('POST', '/tools/find', JSON.stringify({ Level: 'Instance', Query: { StudyInstanceUID: studyUid },
        Limit: limit, Expand: false }), CONTEXT_LIMIT);
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !ORTHANC_ID.test(id)) || new Set(ids).size !== ids.length) return null;
      return ids;
    } catch { return null; }
  }

  async instanceUids(id: string): Promise<{ studyUid: string; seriesUid: string; sopUid: string } | null> {
    try {
      const tags = await this.orthancJson('GET', `/instances/${id}/simplified-tags`, undefined, CONTEXT_LIMIT);
      if (!tags || typeof tags !== 'object' || [tags.StudyInstanceUID, tags.SeriesInstanceUID, tags.SOPInstanceUID].some(v => typeof v !== 'string')) return null;
      return { studyUid: tags.StudyInstanceUID, seriesUid: tags.SeriesInstanceUID, sopUid: tags.SOPInstanceUID };
    } catch { return null; }
  }

  /**
   * The stored size and MD5 of one original (5.2 step 2). The size is taken only as Orthanc writes it: a JSON integer (the
   * 64-bit value of the fixed image) or, should a build print it as text the way /statistics does, the same digits as a
   * string. Nothing else is coerced: null, a boolean, an empty or signed or fractional value is a malformed answer.
   */
  async attachmentInfo(id: string): Promise<{ bytes: number; md5: string } | null> {
    try {
      const info = await this.orthancJson('GET', `/instances/${id}/attachments/dicom/info`, undefined, SMALL_LIMIT);
      if (!plainRecord(info)) return null;
      const size = info.UncompressedSize;
      const bytes = typeof size === 'number' ? size : typeof size === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(size) ? Number(size) : NaN;
      if (!Number.isSafeInteger(bytes) || bytes < 0 || typeof info.UncompressedMD5 !== 'string' || !/^[0-9a-f]{32}$/i.test(info.UncompressedMD5)) return null;
      return { bytes, md5: info.UncompressedMD5.toLowerCase() };
    } catch { return null; }
  }

  /**
   * The archive source of one object (B-03): the stream is handed to adopt synchronously in the same turn the response
   * arrives; the wait for the response is bounded by the signal and its own 30 s, and a late answer is released.
   */
  openOriginal(orthancId: string, signal: AbortSignal, adopt: (readable: Readable) => void): Promise<void> {
    // The id comes from a stored manifest: only Orthanc's own id shape ever reaches the request path.
    if (!ORTHANC_ID.test(orthancId)) return Promise.reject(new Error('original unavailable'));
    const { base, auth } = this.orthancConfig();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, LEASE_MS);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return fetch(`${base}/instances/${orthancId}/file`, { redirect: 'error', signal: controller.signal, headers: { Authorization: auth } })
      .then(response => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (response.status !== 200 || !response.body) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error('original unavailable');
        }
        adopt(Readable.fromWeb(response.body as any));
      }, () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        throw new Error('original unavailable');
      });
  }
}

/** The seven header values the judgement uses (4.4 step 2); nothing else of a header is kept. */
function pick(h: any) {
  const kept: any = {};
  for (const key of ['PatientID', 'IssuerOfPatientID', 'PatientName', 'PatientBirthDate', 'PatientSex', 'StudyInstanceUID', 'SOPInstanceUID'])
    if (Object.prototype.hasOwnProperty.call(h, key)) kept[key] = h[key];
  return kept;
}

/**
 * The closed recovery body {basis, checkedAt}: one of the two bases and a UTC ISO-8601 instant whose calendar date exists
 * as written (2026-02-30 is refused, never read as 2 March).
 */
export function parseRecoveryBody(body: unknown): { basis: string; checkedAt: string } | null {
  if (!exactKeys(body, ['basis', 'checkedAt'])) return null;
  if (!RECOVERY_BASES.includes(body.basis) || utcInstant(body.checkedAt) === null) return null;
  return { basis: body.basis, checkedAt: body.checkedAt };
}
