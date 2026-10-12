import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { DurableAccessReceipt } from '../emr-contract/access-event';
import { ContractError } from '../emr-contract/validation';
import type { Caller } from '../pacs/access';
import type { ClinicalRecord, ClinicalUnit, SurfaceKey } from './contract';
import type { ClinicalBody, ClinicalWritePlan, CommitOutcome, PreparedSr, planManualSrCleanup, reconcileManualSr } from './records';

/**
 * EMR-D round 2: the owning services' side of unit D. The six services (questions, image requests, consultations,
 * findings, manual SRs, reader assignments) reach unit D only through this module: the port the server composition binds
 * (runtime.ts composeClinicalRuntime), their projection registration, the reads they run in their own transaction and the
 * refusal wording. Nothing here calls into the ledger, signature or contract modules, and the composition binds the port
 * by assignment, so the services' code and unit B1's adapter stay apart for the raw-SQL provenance reading of code
 * connected by calls (tests/admin_audit_attribution_test.cjs).
 *
 * While nothing is composed every clinical write and every clinical body read refuses with 503
 * EMR_CLINICAL_RUNTIME_REQUIRED: there is no unsigned or unledgered fallback path.
 */

export interface ClinicalWriteRequest {
  surface: SurfaceKey;
  studyId: string;
  /** The unit this write changes, or the new unit's ID for an opening write. */
  recordId: string;
  /** The client JSON body exactly as received. */
  body: unknown;
  /** Server-built text of a 'server' surface (the finding's canonical snapshot); null elsewhere. */
  content?: string | null;
  navigation?: readonly string[];
  recipientSubject?: string | null;
  readerSubject?: string | null;
  /** Server fact: the author's current reading of this study (a hold on it), or null. */
  reading?: { referenceId: string } | null;
  /** The guard's caller of the owning service: it must be the person B2 verified, or nothing is written. */
  caller: { subject: string; institutionId: string | null };
  /** The owning service's projection facts, kept with the original for its commit and recovery. */
  projection: unknown;
}
export type ClinicalWriteResult = Readonly<{ outcome: CommitOutcome; unit: Readonly<ClinicalUnit> | null }>;
/** A body read: `rows` are the unit's stored rows read with readClinicalRows in the caller's own read snapshot. */
export interface ClinicalReadRequest<T> {
  record: ClinicalRecord; recordId: string; studyId?: string; scope: 'current' | 'history'; rows: readonly object[];
  caller: { subject: string; institutionId: string | null };
  send: (bodies: readonly ClinicalBody[], unit: Readonly<ClinicalUnit>, receipt: DurableAccessReceipt) => Promise<T>;
}
export interface ManualSrAdoptionRequest {
  studyId: string; sr: Omit<PreparedSr, 'authorId'> & { authorSubject: string }; project: (tx: any) => Promise<void>;
}
/** `earlier`: a concurrent store of the same SR committed its signed adoption first (this attempt changed nothing). */
export type ManualSrAdoption = Readonly<{ adopted: 'now' | 'earlier'; receipt: DurableAccessReceipt | null }>;
export type SrAdoptionFact = Readonly<{ versionId: string; sha256: string; bytesSha256: string; sopInstanceUid: string; confirmed: boolean }>;

/** What the composed runtime offers the owning services (runtime.ts ClinicalRuntime). */
export interface ClinicalServicePort {
  write(request: unknown, w: ClinicalWriteRequest): Promise<ClinicalWriteResult>;
  /** The stored outcome of a write's request ID when one is registered, else null; it never plans, signs or commits. */
  lookup(request: unknown, w: ClinicalWriteRequest): Promise<CommitOutcome | null>;
  unit(recordId: string): Promise<Readonly<ClinicalUnit> | null>;
  read<T>(request: unknown, r: ClinicalReadRequest<T>): Promise<T>;
  adoptManualSr(request: unknown, a: ManualSrAdoptionRequest): Promise<ManualSrAdoption>;
  srAdoption(recordId: string): Promise<SrAdoptionFact | null>;
  srPurposeEnds(recordIds: readonly string[]): Promise<ReadonlySet<string>>;
  referencesTo(recordId: string): Promise<readonly { recordId: string; versionId: string; sha256: string; kind: string }[]>;
  holdIds(recordId: string): Promise<readonly string[]>;
  planSrCleanup(facts: readonly PreparedSr[], at: string): ReturnType<typeof planManualSrCleanup>;
  reconcileSr(facts: PreparedSr, observation: unknown): ReturnType<typeof reconcileManualSr>;
}

/** The legacy rows a record type keeps beside its versions; registered by the service that owns them. */
export type ClinicalProjector = (tx: any, plan: Readonly<ClinicalWritePlan>, projection: unknown) => Promise<void>;
/** A projection's own refusal (a service rule checked again under its row locks): a terminal with that code. */
export class ProjectionRefused extends Error {
  constructor(readonly code: string, readonly response: unknown = null) { super(code); this.name = 'ProjectionRefused'; }
}

/**
 * The one binding of unit D: the composition assigns `port` once at server start; the commit reads `projectors`; a body
 * read accepts only `rows` that readClinicalRows returned.
 */
export const clinicalServices: { port: ClinicalServicePort | null; readonly projectors: Map<ClinicalRecord, ClinicalProjector>; readonly readRows: WeakSet<object> } =
  { port: null, projectors: new Map(), readRows: new WeakSet() };

const httpError = (status: number, code: string, message: string): HttpException =>
  status === 404 ? new NotFoundException({ code, message }) : status === 409 ? new ConflictException({ code, message }) :
  status === 403 ? new ForbiddenException({ code, message }) : status === 400 ? new BadRequestException({ code, message }) :
  new ServiceUnavailableException({ code, message });

/** The composed port, or 503 while the EMR composition is absent (fail closed; no legacy write path). */
export function requireClinicalRuntime(): ClinicalServicePort {
  const port = clinicalServices.port;
  if (!port) throw httpError(503, 'EMR_CLINICAL_RUNTIME_REQUIRED', '임상 기록 저장소가 연결되지 않아 저장하거나 표시하지 않았습니다');
  return port;
}
/** The composed port or null (background maintenance keeps everything while nothing is composed). */
export function clinicalRuntime(): ClinicalServicePort | null { return clinicalServices.port; }

const SIGNATURE_REFUSED = ['SignatureFailed', 'SignatureNotVerified', 'SignatureBindingRefused', 'ProxySignatureRefused', 'SignatureTimeUnverified',
  'SigningKeyInactive', 'SignatureFormatRefused', 'KeyUnknown', 'KeyDeviceRefused', 'KeyOsUserRefused', 'SignerIdentityRefused',
  'SignatureIntegrityRefused', 'TimeBasisMismatch', 'KeyEvidenceRefused', 'TimePolicyRequired', 'KeyPolicyRequired'];
/**
 * A failed or unknown outcome (or a refusal thrown before admission) as the HTTP error of the owning service. `own` maps
 * a service's codes (projection refusals and the D codes it words itself) to its existing errors; the rest has one
 * closed wording. No error carries clinical text.
 */
export function clinicalHttpError(code: string, own: Readonly<Record<string, () => HttpException>> = {}): HttpException {
  if (Object.prototype.hasOwnProperty.call(own, code)) return own[code]();
  if (code === 'NotFound') return httpError(404, 'CLINICAL_RECORD_NOT_FOUND', '기록을 찾을 수 없습니다');
  if (['StaleRevision', 'StateTransitionRefused', 'UnitExists', 'ProjectionConflict'].includes(code))
    return httpError(409, 'CLINICAL_RECORD_CHANGED', '기록이 변경되었습니다. 다시 불러온 뒤 확인하세요');
  if (code === 'OwnerChanged') return httpError(409, 'OWNER_CHANGED', '로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요');
  if (code === 'RequestIdReused') return httpError(409, 'REQUEST_ID_REUSED', '다른 내용에 이미 쓰인 요청 ID입니다. 다시 불러온 뒤 확인하세요');
  if (['ActorPathRefused', 'ServiceActorRefused', 'ProjectionForbidden'].includes(code))
    return httpError(403, 'CLINICAL_ACTION_FORBIDDEN', '이 기록에 이 동작을 할 수 없습니다');
  if (code === 'SignatureRequired' || code === 'SigningIdentityRequired')
    return httpError(403, 'CLINICAL_SIGNATURE_REQUIRED', '등록된 서명 수단으로 작성자 본인이 서명해야 저장됩니다. 작성 내용은 그대로 남아 있습니다');
  if (SIGNATURE_REFUSED.includes(code))
    return httpError(403, 'CLINICAL_SIGNATURE_REFUSED', '서명을 확인하지 못해 저장하지 않았습니다. 작성 내용은 그대로 남아 있습니다');
  if (code === 'ProjectionNotFound') return httpError(404, 'CLINICAL_RECORD_NOT_FOUND', '기록을 찾을 수 없습니다');
  if (code === 'OutcomeUnknown' || code === 'EmrClinicalRuntimeRequired' || code === 'ProjectionUnavailable' || code === 'StorageFailed' ||
      code === 'EmrClinicalPlacementRequired')
    return httpError(503, code === 'OutcomeUnknown' ? 'CLINICAL_OUTCOME_PENDING' : 'CLINICAL_STORAGE_UNAVAILABLE',
      code === 'OutcomeUnknown' ? '저장 결과를 확인하는 중입니다. 같은 요청으로 다시 확인하세요' : '저장하지 못했습니다. 작성 내용은 그대로 두고 다시 시도하세요');
  return httpError(400, 'CLINICAL_INPUT_INVALID', '요청의 형식을 확인하세요');
}
/** The closed code of a failed or unknown outcome; null for a committed or replayed one. */
export function outcomeCode(outcome: CommitOutcome): string | null {
  return outcome.status === 'failed' || outcome.status === 'unknown' ? (outcome as { code: string }).code : null;
}
/** The HTTP error of a refusal thrown by the runtime itself (A/D ContractError) or passed through unchanged. */
export function clinicalRefusal(error: unknown, own: Readonly<Record<string, () => HttpException>> = {}): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof ContractError) return clinicalHttpError(error.code, own);
  // B1's ledger could not make the access record durable: nothing was handed out, the caller may simply try again.
  const name = (error as { name?: unknown })?.name;
  if (name === 'LedgerFailure' || name === 'SealRefused') return clinicalHttpError('StorageFailed', own);
  return error;
}

/** The code a projection refusal (an owning service's HttpException under its row locks) is sealed with. */
export function projectionCode(error: HttpException): string {
  const response = error.getResponse() as any, status = error.getStatus();
  if (response && typeof response === 'object' && typeof response.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(response.code)) return response.code;
  return status === 404 ? 'ProjectionNotFound' : status === 409 ? 'ProjectionConflict' : status === 403 ? 'ProjectionForbidden' :
    status === 400 ? 'ProjectionInvalid' : status === 503 ? 'ProjectionUnavailable' : 'ProjectionRefused';
}
/**
 * The owning service registers its legacy rows for a record type at construction. Its HttpExceptions inside the commit
 * transaction become a ProjectionRefused with their code, so the whole commit rolls back and the original is sealed
 * with that code; any other error is a storage failure.
 */
export function registerClinicalProjection(record: ClinicalRecord, projector: ClinicalProjector): void {
  if (typeof projector !== 'function') throw new TypeError('ClinicalProjectorRequired');
  clinicalServices.projectors.set(record, async (tx, plan, projection) => {
    try { await projector(tx, plan, projection); }
    catch (error) { if (error instanceof HttpException) throw new ProjectionRefused(projectionCode(error)); throw error; }
  });
}

/** A text value an owning service binds into its SQL, checked where it is bound (non-empty unless `allowEmpty`). */
export function clinicalText(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw new ProjectionRefused('ProjectionInvalid');
  return value;
}
/** A non-negative safe integer an owning service binds into its SQL. */
export function clinicalCount(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new ProjectionRefused('ProjectionInvalid');
  return value as number;
}
/**
 * The guard caller an owning service kept with an original (its projection facts), validated again where its rows are
 * written: a projection runs inside the commit transaction, also after a restart, and never trusts a stored shape.
 */
export function projectedCaller(value: unknown): Caller & { name?: string } {
  const c = value as { kind?: unknown; institution?: unknown; sub?: unknown; actor?: unknown; roles?: unknown; name?: unknown } | null;
  if (!c || typeof c !== 'object' || c.kind !== 'member' || !Array.isArray(c.roles)) throw new ProjectionRefused('ProjectionInvalid');
  const caller: Caller & { name?: string } = { kind: 'member', institution: clinicalText(c.institution), sub: clinicalText(c.sub),
    actor: clinicalText(c.actor), roles: (c.roles as unknown[]).map(role => clinicalText(role)) };
  if (typeof c.name === 'string') caller.name = c.name;
  return caller;
}

/** Raw calls inside and outside a transaction (a Prisma client or interactive-transaction client). */
export interface ClinicalRowReader { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: any[]): Promise<T> }
const sqlCode = (error: unknown): string | null => {
  const code = (error as any)?.meta?.code;
  if (typeof code === 'string' && /^ED\d{3}$/.test(code)) return code;
  const match = /\bCode: `(ED\d{3})`/.exec(String((error as any)?.message ?? ''));
  return match ? match[1] : null;
};
/**
 * A unit's stored rows read in the caller's own transaction (its read snapshot, together with its legacy rows), for
 * port.read; an empty list when no unit exists. A schema refusal (placement) is a storage failure, never a body.
 */
export async function readClinicalRows(db: ClinicalRowReader, recordId: string): Promise<readonly object[]> {
  let rows: object[];
  try { rows = await db.$queryRaw<object[]>`SELECT * FROM emr_clinical.unit_for(${clinicalText(recordId)}::text)`; }
  catch (error) { if (sqlCode(error)) throw clinicalHttpError('StorageFailed'); throw error; }
  const kept = Object.freeze([...rows]);
  clinicalServices.readRows.add(kept);
  return kept;
}
/** Hand an ended preparation copy to unit H's purpose-end destruction, in the caller's transaction (the bytes stay). */
export async function recordSrPurposeEnd(db: ClinicalRowReader, recordId: string, bytesSha256: string): Promise<void> {
  await db.$queryRaw`SELECT emr_clinical.record_sr_purpose_end(${clinicalText(recordId)}::text, ${clinicalText(bytesSha256)}::text,
    'preparation-window-ended'::text)::text AS done`;
}
