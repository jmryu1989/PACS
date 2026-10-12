import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { DurableAccessReceipt } from '../emr-contract/access-event';
import type { ResolvedRecord } from '../emr-contract/classification';
import { ContractError } from '../emr-contract/validation';
import type { Caller } from '../pacs/access';
import type { ClinicalRecord, ClinicalUnit, SurfaceKey } from './contract';
import type { ClinicalBody, ClinicalReadScope, ClinicalWritePlan, CommitOutcome, PreparedSr, planManualSrCleanup, reconcileManualSr } from './records';
import { SourceRef, resolveSourceRows } from './sources';

/**
 * EMR-D: the owning services' side of unit D. The six services (questions, image requests, consultations, findings,
 * manual SRs, reader assignments) reach unit D through this module: the port of the composed runtime, their projection
 * registration, the reads they run in their own transaction (unit rows, incorporated sources) and the refusal wording.
 *
 * Why a port and not the runtime itself (product requirements, not a test's): Nest constructs the six services when the
 * application module is created, before the server start has B1's ledger (started after its seal recovery), B2's verified
 * request context and C's verification ports; the runtime exists only once those exist (runtime.ts
 * composeClinicalRuntime). The services therefore depend on this interface and the server start binds it exactly once
 * (bindClinicalPort): no request path can replace it, a second binding is refused, and while nothing is bound every
 * clinical write and every response carrying clinical text refuses with 503 EMR_CLINICAL_RUNTIME_REQUIRED - there is no
 * unsigned or unledgered fallback path.
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
  /** A-resolved fixed references of what the text incorporates (readClinicalSources), in the text's order. */
  attachments?: readonly ResolvedRecord[];
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
/**
 * One unit a response serves. `rows` are the unit's stored rows read with readClinicalRows/readClinicalUnits in the
 * caller's own read snapshot (together with the legacy rows it answers with). `parties` are the subjects the served
 * projection names as the record's author and recipient: the runtime refuses the response when they are not the unit's
 * own (the opening version's author; the recipient fixed by it).
 */
export interface ClinicalProvision {
  record: ClinicalRecord; recordId: string; studyId?: string; scope: ClinicalReadScope; rows: readonly object[];
  parties?: { author?: string; recipient?: string | null };
}
export type ClinicalServed = Readonly<{ unit: Readonly<ClinicalUnit>; bodies: readonly ClinicalBody[] }>;
/**
 * A response that carries clinical text of one or more units (a record read, a list, a write that answers with its
 * record): `send` receives the signed versions it may show only after the provide-prepared events naming exactly those
 * versions are durable in B1's ledger. `route` is the route that answers (A's route contract).
 */
export interface ClinicalProvideRequest<T> {
  route: string; units: readonly ClinicalProvision[];
  caller: { subject: string; institutionId: string | null };
  send: (served: readonly ClinicalServed[], receipts: readonly DurableAccessReceipt[]) => Promise<T>;
}
/** A one-unit read on the record's own read route. */
export interface ClinicalReadRequest<T> {
  record: ClinicalRecord; recordId: string; studyId?: string; scope: ClinicalReadScope; rows: readonly object[];
  parties?: ClinicalProvision['parties'];
  caller: { subject: string; institutionId: string | null };
  send: (bodies: readonly ClinicalBody[], unit: Readonly<ClinicalUnit>, receipt: DurableAccessReceipt) => Promise<T>;
}
export interface ManualSrAdoptionRequest {
  studyId: string; sr: Omit<PreparedSr, 'authorId'> & { authorSubject: string }; project: (tx: any) => Promise<void>;
}
/** `earlier`: a concurrent store of the same SR committed its signed adoption first (this attempt changed nothing). */
export type ManualSrAdoption = Readonly<{ adopted: 'now' | 'earlier'; receipt: DurableAccessReceipt | null }>;
export type SrAdoptionFact = Readonly<{ versionId: string; sha256: string; bytesSha256: string; sopInstanceUid: string; confirmed: boolean }>;
/** The author's own adopted SR handed back by the store route after its provision is durable. */
export interface SrProvideRequest<T> {
  recordId: string; studyId: string; route: string; caller: { subject: string; institutionId: string | null };
  send: (receipt: DurableAccessReceipt) => Promise<T>;
}

/** What the composed runtime offers the owning services (runtime.ts ClinicalRuntime). */
export interface ClinicalServicePort {
  write(request: unknown, w: ClinicalWriteRequest): Promise<ClinicalWriteResult>;
  /** The stored outcome of a write's request ID when one is registered, else null; it never plans, signs or commits. */
  lookup(request: unknown, w: ClinicalWriteRequest): Promise<CommitOutcome | null>;
  unit(recordId: string): Promise<Readonly<ClinicalUnit> | null>;
  read<T>(request: unknown, r: ClinicalReadRequest<T>): Promise<T>;
  provide<T>(request: unknown, p: ClinicalProvideRequest<T>): Promise<T>;
  adoptManualSr(request: unknown, a: ManualSrAdoptionRequest): Promise<ManualSrAdoption>;
  srAdoption(recordId: string): Promise<SrAdoptionFact | null>;
  /** The signed adoption made durable in the ledger (confirmed now if it was not yet), or null; throws when it cannot be. */
  confirmedSrAdoption(recordId: string): Promise<SrAdoptionFact | null>;
  provideSrAdoption<T>(request: unknown, p: SrProvideRequest<T>): Promise<T>;
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

/** The commit reads `projectors`; a body read accepts only `readRows` that readClinicalRows/readClinicalUnits returned. */
export const clinicalServices: { readonly projectors: Map<ClinicalRecord, ClinicalProjector>; readonly readRows: WeakSet<object> } =
  { projectors: new Map(), readRows: new WeakSet() };

let bound: ClinicalServicePort | null = null;
/** Server start only, once (runtime.ts composeClinicalRuntime); a second binding is refused. */
export function bindClinicalPort(port: ClinicalServicePort): void {
  if (bound) throw new ContractError('ClinicalRuntimeAlreadyComposed');
  if (!port || typeof port.write !== 'function') throw new ContractError('ClinicalRuntimePartRequired');
  bound = port;
}

const httpError = (status: number, code: string, message: string): HttpException =>
  status === 404 ? new NotFoundException({ code, message }) : status === 409 ? new ConflictException({ code, message }) :
  status === 403 ? new ForbiddenException({ code, message }) : status === 400 ? new BadRequestException({ code, message }) :
  new ServiceUnavailableException({ code, message });

/** The bound port, or 503 while the EMR composition is absent (fail closed; no legacy write or body path). */
export function requireClinicalRuntime(): ClinicalServicePort {
  if (!bound) throw httpError(503, 'EMR_CLINICAL_RUNTIME_REQUIRED', '임상 기록 저장소가 연결되지 않아 저장하거나 표시하지 않았습니다');
  return bound;
}
/** The bound port or null (background maintenance keeps everything while nothing is composed). */
export function clinicalRuntime(): ClinicalServicePort | null { return bound; }

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
  if (['StaleRevision', 'StateTransitionRefused', 'UnitExists', 'ProjectionConflict', 'ProjectionMismatch'].includes(code))
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
  if (code === 'OutcomeUnknown') return httpError(503, 'CLINICAL_OUTCOME_PENDING', '저장 결과를 확인하는 중입니다. 같은 요청으로 다시 확인하세요');
  if (['EmrClinicalRuntimeRequired', 'ProjectionUnavailable', 'StorageFailed', 'EmrClinicalPlacementRequired', 'ClinicalSourcesNotComposed'].includes(code))
    return httpError(503, 'CLINICAL_STORAGE_UNAVAILABLE', '저장하지 못했습니다. 작성 내용은 그대로 두고 다시 시도하세요');
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
/**
 * A response whose record change is already committed but whose clinical text could not be handed back (its provision is
 * not durable): the same request answers it later (replay), so the caller is told the result is still being confirmed.
 */
export function clinicalEchoRefusal(error: unknown, own: Readonly<Record<string, () => HttpException>> = {}): unknown {
  const name = (error as { name?: unknown })?.name;
  if (name === 'LedgerFailure' || name === 'SealRefused') return clinicalHttpError('OutcomeUnknown');
  return clinicalRefusal(error, own);
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
 * port.read/provide; an empty list when no unit exists. A schema refusal (placement) is a storage failure, never a body.
 */
export async function readClinicalRows(db: ClinicalRowReader, recordId: string): Promise<readonly object[]> {
  let rows: object[];
  try { rows = await db.$queryRaw<object[]>`SELECT * FROM emr_clinical.unit_for(${clinicalText(recordId)}::text)`; }
  catch (error) { if (sqlCode(error)) throw clinicalHttpError('StorageFailed'); throw error; }
  const kept = Object.freeze([...rows]);
  clinicalServices.readRows.add(kept);
  return kept;
}
/** The stored rows of several units (a page of a list) in one statement of the caller's transaction, by record ID. */
export async function readClinicalUnits(db: ClinicalRowReader, recordIds: readonly string[]): Promise<ReadonlyMap<string, readonly object[]>> {
  const ids = [...new Set(recordIds.map(id => clinicalText(id)))];
  if (ids.length > 200) throw new ProjectionRefused('ProjectionInvalid');
  let rows: { record_id: string }[] = [];
  if (ids.length) {
    try { rows = await db.$queryRaw<{ record_id: string }[]>`SELECT * FROM emr_clinical.units_for(${ids}::text[])`; }
    catch (error) { if (sqlCode(error)) throw clinicalHttpError('StorageFailed'); throw error; }
  }
  const units = new Map<string, readonly object[]>();
  for (const id of ids) {
    const kept = Object.freeze(rows.filter(row => row.record_id === id).map(({ record_id: _id, ...row }) => row));
    clinicalServices.readRows.add(kept);
    units.set(id, kept);
  }
  return units;
}
/**
 * The fixed references of what a write incorporates (sources.ts): each source's immutable version read in the caller's
 * transaction - a viewer item revision, a saved comparison revision with its immutable snapshot - and resolved by A.
 * A source whose version row is missing is refused, never left out.
 */
export async function readClinicalSources(db: ClinicalRowReader, refs: readonly SourceRef[]): Promise<readonly ResolvedRecord[]> {
  const items = refs.filter(ref => ref.kind === 'item') as Extract<SourceRef, { kind: 'item' }>[];
  const jobs = refs.filter(ref => ref.kind === 'job') as Extract<SourceRef, { kind: 'job' }>[];
  const itemIds = items.map(ref => clinicalText(ref.itemId)), itemRevisions = items.map(ref => clinicalCount(ref.revision, 1));
  const jobIds = jobs.map(ref => clinicalText(ref.jobId)), jobRevisions = jobs.map(ref => clinicalCount(ref.revision, 1));
  const itemRows = itemIds.length ? await db.$queryRaw<object[]>`SELECT r."itemId"::text AS "itemId", r.revision, r.action, r.at,
      r.snapshot::text AS snapshot, i."studyUid" AS "studyUid"
    FROM unnest(${itemIds}::uuid[], ${itemRevisions}::int[]) AS k(id, revision)
    JOIN "ViewerRevision" r ON r."itemId" = k.id AND r.revision = k.revision JOIN "ViewerItem" i ON i.id = r."itemId"` : [];
  const jobRows = jobIds.length ? await db.$queryRaw<object[]>`SELECT j.id::text AS "jobId", r.revision, r.at, r.title, r.description, r.hidden,
      j."studyUid" AS "studyUid", j.studies, j.snapshot::text AS snapshot
    FROM unnest(${jobIds}::uuid[], ${jobRevisions}::int[]) AS k(id, revision)
    JOIN "ViewerJobRevision" r ON r."jobId" = k.id AND r.revision = k.revision JOIN "ViewerJob" j ON j.id = r."jobId"` : [];
  return resolveSourceRows(refs, itemRows, jobRows);
}
/** Hand an ended preparation copy to unit H's purpose-end destruction, in the caller's transaction (the bytes stay). */
export async function recordSrPurposeEnd(db: ClinicalRowReader, recordId: string, bytesSha256: string): Promise<void> {
  await db.$queryRaw`SELECT emr_clinical.record_sr_purpose_end(${clinicalText(recordId)}::text, ${clinicalText(bytesSha256)}::text,
    'preparation-window-ended'::text)::text AS done`;
}
