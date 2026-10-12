import { createHash, randomUUID } from 'node:crypto';
import { AccessEvent, AccessEventV1, AppendOnlyAccessStore, DurableAccessReceipt, EvidenceFact, WorkContext, newAuditLinkId,
  parseAccessEvent } from '../emr-contract/access-event';
import { ResolvedRecord, resolveStoredRecord, verifiedRecord } from '../emr-contract/classification';
import { emrAdapters } from '../emr-contract/composition';
import { ContractError, freeze, integer, refuse, string } from '../emr-contract/validation';
import type { HoldRow } from '../emr-runtime/contract';
import type { ProvisionalAppend } from '../emr-runtime/store';
import { inspectEnvelopeV2 } from '../emr-signature/canonical-v2';
import type { ClinicalRecord, ClinicalUnit, ClinicalVersion } from './contract';
import { ClinicalProjector, ProjectionRefused, clinicalServices } from './services';
import type { SignedEnvelope } from './signing';
import {
  ClinicalStorePort, ClinicalWritePlan, CommitRolledBack, OriginalAdmission, OriginalCheckpoint, OriginalIdentity, OriginalPermit,
  RejectionEvidence, RequestAttemptEvent, RequestIdentity, RequestObservation, UnitOfWork, WriteInput, projectUnit,
} from './records';

/**
 * EMR-D round 2: the durable implementation of records.ts ClinicalStorePort over schema emr_clinical (migration
 * 20261012120000_emr_d) and B1's access ledger. Every SQL statement is a parameterized Prisma raw call of one of the
 * schema's own functions; the runtime role holds EXECUTE on those functions only.
 *
 * One commit, one transaction: B1's AccessLedgerStore.withAppendTransaction runs commit_version (version, attachment
 * references, projection, register terminal), the legacy projection of the service that owns the record (its existing
 * rows and AuditLog entry), and B1's appendInTransaction of the change's access event, in that order. A refusal of any
 * of them rolls everything back. The answer is a success only after B1's durable receipt for that event; until then the
 * register stays unconfirmed and every lookup is "unknown", never a guessed success.
 */

/** The SQLSTATE codes schema emr_clinical raises. */
export const CLINICAL_SQL_ERRORS = freeze({
  ED001: 'EmrClinicalPlacementRequired', ED002: 'RequestIdReused', ED003: 'StaleRevision', ED004: 'PermitFenced',
  ED005: 'ClinicalVersionInvalid', ED006: 'SrAlreadyAdopted',
} as const);
export function clinicalSqlState(error: unknown): string | null {
  const code = (error as any)?.meta?.code;
  if (typeof code === 'string' && /^ED\d{3}$/.test(code)) return code;
  const match = /\bCode: `(ED\d{3})`/.exec(String((error as any)?.message ?? ''));
  return match ? match[1] : null;
}
/** Failures a new transaction attempt can overcome: lock/statement timeouts, deadlocks, serialization, connections. */
export function transientDatabaseError(error: unknown): boolean {
  const code = (error as any)?.code, state = String((error as any)?.meta?.code ?? '');
  return ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034'].includes(code) ||
    (code === 'P2010' && ['55P03', '57014', '40P01', '40001'].includes(state));
}

/** Deterministic JSON: object keys sorted at every depth (the stored patient snapshot and fingerprints use it). */
export const canonicalJson = (value: unknown) => JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

/** Interactive-transaction client (the EMR ledger client): raw calls inside and outside a transaction. */
export interface ClinicalDatabase {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: any[]): Promise<T>;
}

/**
 * The part of B1's access ledger D uses (B1's AccessLedgerStore has exactly these members; B2 composes it at server
 * start). D never issues emr_access SQL itself: holds are read through B1's own adapter.
 */
export interface ClinicalLedger extends AppendOnlyAccessStore {
  withAppendTransaction<T>(work: (tx: any) => Promise<T>): Promise<T>;
  appendInTransaction(tx: object, input: AccessEvent): Promise<ProvisionalAppend>;
  confirm(appended: ProvisionalAppend): Promise<DurableAccessReceipt>;
  settleTransaction(tx: object, input: AccessEvent, error: unknown, callbackFailed: boolean): Promise<void>;
  holdRows(tx: object, recordId: string): Promise<HoldRow[]>;
}

/** A nullable text parameter, validated where it is bound. */
const textOrNull = (value: unknown): string | null => value === null || value === undefined ? null : string(value, true);
/** The SQLSTATE of a schema function, as the closed code the protocol knows; anything else unchanged. */
function sqlRefusal(error: unknown): never {
  const state = clinicalSqlState(error);
  if (state) refuse(CLINICAL_SQL_ERRORS[state as keyof typeof CLINICAL_SQL_ERRORS]);
  throw error;
}

/**
 * Server facts fixed with an original at its admission, for its commit and for recovery after a restart: the access
 * event's actor context (B2 supplies it per request) and the legacy projection's own facts (the owning service's).
 */
export interface ClinicalFacts {
  event: {
    rolesAtTime: readonly string[];
    trustedProxyIp: EvidenceFact<{ address: string; source: 'trusted-proxy' }>;
    requestId: string;
    /** Server fact: the author was reading this study when the write was admitted. */
    reading: boolean;
  };
  projection: unknown;
}
/**
 * D-18 work context of a write, bound by the server (nothing is typed): a clinician's own question or image request is a
 * clinical request about that study; a write inside the author's reading is assigned reading; any other member write
 * comes from the worklist/record view of that study.
 */
export function writeContext(plan: Readonly<ClinicalWritePlan>, facts: ClinicalFacts): WorkContext {
  const v = plan.version;
  const basis = v.capacity === 'clinical-author' && (v.kind === 'clinical-question' || v.kind === 'image-request') ? 'clinical-request' :
    facts.event.reading ? 'assigned-reading' : 'worklist';
  return { basis, studyId: v.studyId, relatedStudyId: null, reason: null };
}
/** The device signature that came with the request (C's channel), fixed with the original at its admission. */
export type CarriedSignature = SignedEnvelope;

/** The change event of one planned version: what B1 appends in the commit transaction (both streams, D-1). */
export function clinicalWriteEvent(plan: Readonly<ClinicalWritePlan>, facts: ClinicalFacts, originalId: string): Readonly<AccessEvent> {
  const v = plan.version, known = <T>(value: T) => ({ status: 'known' as const, value });
  const event: AccessEventV1 = {
    formatVersion: 1, surface: plan.access.route, eventId: `clinical-write:${originalId}`, userId: known({ ...v.author }),
    rolesAtTime: known([...facts.event.rolesAtTime]), actingInstitution: known(v.actingInstitutionId),
    managingInstitution: known(v.managingInstitutionId), occurredAt: v.at, trustedProxyIp: facts.event.trustedProxyIp, cause: 'user-view',
    context: writeContext(plan, facts), executor: 'member', targets: [plan.access.target], action: plan.access.action, result: 'succeeded',
    requestId: facts.event.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null,
  };
  return parseAccessEvent(event);
}

/** The legacy rows of a record type, registered by the service that owns them (services.ts registerClinicalProjection). */
export type { ClinicalProjector };
export { ProjectionRefused };

type Row = { kind: 'owner' | 'observer' | 'fenced'; original_id: string; epoch: number; phase: OriginalCheckpoint['phase'] | 'admitted';
  state: 'pending' | 'committed' | 'rejected'; seed: string; facts: string; envelope: string | null; checkpoint: string | null; terminal: string | null;
  record_id: string | null; access_event: string | null; confirmed: boolean };

// Attachments are A capabilities; the register keeps their stored-record references and re-resolves them through A's
// composed reader on recovery (an unresolvable reference refuses, it never becomes an empty list).
function seedText(input: WriteInput): string {
  const attachments = input.attachments.map(a => { const r = verifiedRecord(a); return { recordId: r.recordId, eventId: r.event.eventId }; });
  return JSON.stringify({ ...input, attachments });
}
function seedFrom(text: string): WriteInput {
  const seed = JSON.parse(text);
  const attachments: ResolvedRecord[] = (seed.attachments as { recordId: string; eventId: string }[])
    .map(a => resolveStoredRecord(emrAdapters().stored, a.recordId, a.eventId));
  return { ...seed, attachments };
}

const originalOf = (request: RequestIdentity, originalId: string): OriginalIdentity =>
  freeze({ receiptKey: { ...request.receiptKey }, fingerprint: request.fingerprint, originalId });
const permitOf = (original: OriginalIdentity, epoch: number) => freeze({ original, epoch }) as unknown as OriginalPermit;
function rejected(original: OriginalIdentity, epoch: number, code: string): RequestObservation {
  return { state: 'rejected', original, epoch, proof: { original, epoch, rejectionId: randomUUID(), code, fencedThrough: epoch, noClinicalEffects: true } };
}

// Every value below is validated where it is bound (string/integer/textOrNull, comparisons): the parameter list of each
// schema function is the whole statement, and nothing a caller hands in becomes SQL text.
const keyValues = (k: RequestIdentity['receiptKey']) => ({ record: string(k.record), actorId: string(k.actorId), requestId: string(k.requestId) });

export class SqlClinicalStore {
  /** Originals executing in this process: recovery never fences its own live owner. */
  private readonly active = new Set<string>();
  private readonly carried = new Map<string, CarriedSignature | null>();
  private readonly facts = new Map<string, ClinicalFacts>();
  private wake: ((request: RequestIdentity) => void) | null = null;

  constructor(private readonly db: ClinicalDatabase, private readonly ledger: ClinicalLedger, private readonly commitAttempts = 3) {}

  /** The runtime's recovery scheduler (records.ts recoverClinicalWrite with the composed ports). */
  onWake(schedule: (request: RequestIdentity) => void): void { this.wake = schedule; }
  isActive(originalId: string): boolean { return this.active.has(originalId); }
  release(originalId: string | null): void {
    if (!originalId) return;
    this.active.delete(originalId); this.carried.delete(originalId); this.facts.delete(originalId);
  }
  /** The device signature fixed with an original at admission, for its sign step (records.ts SignaturePort). */
  carriedSignature(originalId: string): CarriedSignature | null {
    if (!this.carried.has(originalId)) refuse('SignatureUnavailable');
    return this.carried.get(originalId);
  }

  /** The port one write uses: its admission fixes these facts and the carried signature with the original. */
  port(facts: ClinicalFacts, signature: CarriedSignature | null, admitted: (originalId: string) => void = () => {}): ClinicalStorePort {
    return {
      admitOrObserve: (request, seed, attemptId) => this.admit(request, seed, attemptId, facts, signature, admitted),
      observe: (request, attemptId, external) => this.observe(request, attemptId, external),
      checkpoint: (permit, value) => this.checkpoint(permit, value),
      commitOriginal: (permit, work) => this.commitOriginal(permit, work),
      sealRejected: (permit, evidence, attemptId) => this.sealRejected(permit, evidence, attemptId),
      recoverOriginal: (request, attemptId) => this.recoverOriginal(request, attemptId),
      wakeRecovery: async request => { this.wake?.(request); },
      noteAttempt: event => this.noteAttempt(event),
    };
  }
  /** The port of the server's recovery worker: it admits nothing, it only resumes registered originals. */
  recoveryPort(): ClinicalStorePort {
    const port = this.port(null as any, null);
    return { ...port, admitOrObserve: async () => refuse('RecoveryAdmitsNothing') };
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) { sqlRefusal(error); }
  }

  /** Admission under the request lock: the first caller owns the original, every later one observes it. */
  async admit(request: RequestIdentity, seed: WriteInput, attemptId: string, facts: ClinicalFacts, signature: CarriedSignature | null,
    admitted: (originalId: string) => void): Promise<OriginalAdmission> {
    const k = keyValues(request.receiptKey);
    const rows = await this.call(() => this.db.$queryRaw<Row[]>`SELECT * FROM emr_clinical.admit(${k.record}::text, ${k.actorId}::text,
      ${k.requestId}::text, ${string(request.fingerprint)}::text, ${seedText(seed)}::text, ${JSON.stringify(facts)}::text,
      ${signature === null ? null : JSON.stringify(signature)}::text, ${string(attemptId)}::text)`);
    const row = rows[0];
    if (row.kind !== 'owner') return { kind: 'observer', observation: this.observation(request, row) };
    const original = originalOf(request, row.original_id);
    this.active.add(row.original_id); this.carried.set(row.original_id, signature); this.facts.set(row.original_id, facts);
    admitted(row.original_id);
    return { kind: 'owner', execution: { permit: permitOf(original, row.epoch), seed, checkpoint: null } };
  }

  private observation(request: RequestIdentity, row: Row): RequestObservation {
    const original = originalOf(request, row.original_id);
    if (row.state === 'pending') return { state: 'pending', original, epoch: row.epoch, phase: row.phase };
    // A committed original whose ledger receipt is not yet durable is still unknown to every caller.
    if (row.state === 'committed' && !row.confirmed) return { state: 'pending', original, epoch: row.epoch, phase: 'commit-dispatched' };
    return JSON.parse(row.terminal);
  }

  async observe(request: RequestIdentity, attemptId: string, external: boolean): Promise<RequestObservation> {
    const k = keyValues(request.receiptKey);
    const rows = await this.call(() => this.db.$queryRaw<Row[]>`SELECT * FROM emr_clinical.observe(${k.record}::text, ${k.actorId}::text,
      ${k.requestId}::text, ${string(request.fingerprint)}::text, ${string(attemptId)}::text, ${external === true}::boolean)`);
    return rows.length ? this.observation(request, rows[0]) : { state: 'absent' };
  }

  async checkpoint(permit: OriginalPermit, value: Readonly<OriginalCheckpoint>): Promise<boolean> {
    const o = permit.original, k = keyValues(o.receiptKey);
    const [row] = await this.call(() => this.db.$queryRaw<{ done: boolean }[]>`SELECT emr_clinical.checkpoint(${k.record}::text, ${k.actorId}::text,
      ${k.requestId}::text, ${string(o.originalId)}::uuid, ${integer(permit.epoch)}::integer, ${string(value.phase)}::text,
      ${JSON.stringify(value)}::text, NULL::text) AS done`);
    return row.done === true;
  }

  private async factsFor(original: OriginalIdentity): Promise<ClinicalFacts> {
    const cached = this.facts.get(original.originalId);
    if (cached) return cached;
    const k = keyValues(original.receiptKey);
    const rows = await this.call(() => this.db.$queryRaw<Row[]>`SELECT * FROM emr_clinical.observe(${k.record}::text,
      ${k.actorId}::text, ${k.requestId}::text, ${string(original.fingerprint)}::text, ${string(randomUUID())}::text, false)`);
    if (!rows.length || rows[0].original_id !== original.originalId) refuse('PermitFenced');
    return JSON.parse(rows[0].facts);
  }

  async commitOriginal(permit: OriginalPermit, work: Readonly<UnitOfWork>): Promise<RequestObservation> {
    const o = permit.original, k = keyValues(o.receiptKey), plan = work.plan, v: ClinicalVersion = plan.version;
    const projector = clinicalServices.projectors.get(plan.record);
    if (!projector) refuse('ClinicalProjectorRequired');
    const facts = await this.factsFor(o);
    const event = clinicalWriteEvent(plan, facts, o.originalId);
    const terminal: RequestObservation = { state: 'committed', original: o, epoch: permit.epoch, binding: work, proof: {
      original: o, epoch: permit.epoch, transactionId: randomUUID(), changeId: event.eventId, receipt: plan.receipt,
      version: { recordId: v.recordId, versionId: v.versionId, sha256: v.sha256 }, signature: work.signature?.evidence ?? null } };
    const signature = work.signature ? JSON.stringify(this.signatureRecord(work)) : null;
    const request: RequestIdentity = { receiptKey: o.receiptKey, fingerprint: o.fingerprint };
    for (let attempt = 1; ; attempt++) {
      let appended: ProvisionalAppend, transaction: object, callbackFailed = false;
      try {
        appended = await this.ledger.withAppendTransaction(async tx => {
          transaction = tx;
          try {
            await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
            await tx.$queryRaw`SELECT emr_clinical.commit_version(${k.record}::text, ${k.actorId}::text, ${k.requestId}::text,
              ${string(o.originalId)}::uuid, ${integer(permit.epoch)}::integer, ${string(v.recordId)}::text, ${string(v.studyId)}::text,
              ${string(v.managingInstitutionId)}::text, ${canonicalJson(v.patient)}::text, ${string(plan.parties.authorId)}::text,
              ${textOrNull(plan.parties.recipientId)}::text, ${string(plan.projection.state)}::text, ${plan.projection.clinicalEntry === true}::boolean,
              ${integer(v.sequence, 1)}::integer, ${string(v.versionId)}::text, ${string(v.sha256)}::text,
              ${v.previousVersion ? string(v.previousVersion.versionId) : null}::text, ${string(v.entry)}::text, ${JSON.stringify(v)}::text,
              ${signature}::text, ${JSON.stringify(terminal)}::text, ${JSON.stringify(event)}::text)::text AS done`;
            await projector(tx, plan, facts.projection);
            // Last: B1 stages both stream rows and binds them to this transaction's commit.
            return await this.ledger.appendInTransaction(tx, event);
          } catch (error) { callbackFailed = true; throw error; }
        });
      } catch (error) {
        try { await this.ledger.settleTransaction(transaction, event, error, callbackFailed); } catch { /* the journal outcome is not the answer */ }
        // COMMIT did not report: whether anything committed is unknown here; the register answers later.
        if (!callbackFailed) throw error;
        const state = clinicalSqlState(error);
        if (state === 'ED004') return this.observe(request, randomUUID(), false);
        if (transientDatabaseError(error) && attempt < this.commitAttempts) continue;
        const code = error instanceof ProjectionRefused ? error.code : state === 'ED003' ? 'StaleRevision' :
          error instanceof ContractError ? error.code : null;
        if (code) return this.sealDirect(permit, code);
        throw new CommitRolledBack('Clinical commit rolled back', { original: o, epoch: permit.epoch, transactionId: randomUUID(), noClinicalEffects: true });
      }
      return this.confirmCommitted(o, appended, terminal);
    }
  }

  /** The durable receipt, then the register's confirmation. Without both the original stays unknown, never successful. */
  private async confirmCommitted(o: OriginalIdentity, appended: ProvisionalAppend | null, terminal: RequestObservation, event?: AccessEvent): Promise<RequestObservation> {
    const k = keyValues(o.receiptKey), request: RequestIdentity = { receiptKey: o.receiptKey, fingerprint: o.fingerprint };
    try {
      if (appended) await this.ledger.confirm(appended);
      else await this.ledger.append(event);
      await this.call(() => this.db.$queryRaw`SELECT emr_clinical.confirm_request(${k.record}::text, ${k.actorId}::text, ${k.requestId}::text,
        ${string(o.originalId)}::uuid)::text AS done`);
    } catch {
      await this.noteAttempt({ attemptId: randomUUID(), request, originalId: o.originalId, code: 'ReceiptUnconfirmed' });
      this.wake?.(request);
      return { state: 'pending', original: o, epoch: (terminal as any).epoch, phase: 'commit-dispatched' };
    }
    return terminal;
  }

  private signatureRecord(work: Readonly<UnitOfWork>) {
    const inspected = inspectEnvelopeV2((work.signature.envelope as SignedEnvelope).jws);
    return { envelope: work.signature.envelope, evidence: work.signature.evidence,
      signed: { kid: inspected.kid, signedAt: inspected.payload.signedAt, payloadSha256: createHash('sha256').update(inspected.payloadBytes).digest('hex') } };
  }

  /** A terminal rejection the store decides itself; dispatched: the original reached commit-dispatched (cause rollback). */
  private async sealDirect(permit: OriginalPermit, code: string, dispatched = true): Promise<RequestObservation> {
    const o = permit.original, k = keyValues(o.receiptKey), terminal = rejected(o, permit.epoch, code);
    const request: RequestIdentity = { receiptKey: o.receiptKey, fingerprint: o.fingerprint };
    await this.call(() => this.db.$queryRaw`SELECT emr_clinical.seal_rejected(${k.record}::text, ${k.actorId}::text, ${k.requestId}::text,
      ${string(o.originalId)}::uuid, ${integer(permit.epoch)}::integer, ${dispatched ? 'rollback' : 'not-dispatched'}::text, ${JSON.stringify(terminal)}::text)::text AS done`);
    await this.noteAttempt({ attemptId: randomUUID(), request, originalId: o.originalId, code });
    return this.observe(request, randomUUID(), false);
  }

  async sealRejected(permit: OriginalPermit, evidence: RejectionEvidence, attemptId: string): Promise<RequestObservation> {
    const o = permit.original, k = keyValues(o.receiptKey), terminal = rejected(o, permit.epoch, evidence.code);
    const request: RequestIdentity = { receiptKey: o.receiptKey, fingerprint: o.fingerprint };
    await this.call(() => this.db.$queryRaw`SELECT emr_clinical.seal_rejected(${k.record}::text, ${k.actorId}::text, ${k.requestId}::text,
      ${string(o.originalId)}::uuid, ${integer(permit.epoch)}::integer, ${string(evidence.cause)}::text, ${JSON.stringify(terminal)}::text)::text AS done`);
    await this.noteAttempt({ attemptId, request, originalId: o.originalId, code: evidence.code });
    return this.observe(request, attemptId, false);
  }

  async recoverOriginal(request: RequestIdentity, attemptId: string): Promise<OriginalAdmission> {
    const k = keyValues(request.receiptKey);
    // This process's own live owner is never fenced: it is still executing and answers for itself.
    const current = await this.observe(request, attemptId, false);
    if (current.state === 'pending' && this.active.has(current.original.originalId)) return { kind: 'observer', observation: current };
    const rows = await this.call(() => this.db.$queryRaw<Row[]>`SELECT * FROM emr_clinical.recover(${k.record}::text, ${k.actorId}::text,
      ${k.requestId}::text, ${string(request.fingerprint)}::text)`);
    if (!rows.length) return { kind: 'observer', observation: { state: 'absent' } };
    const row = rows[0], original = originalOf(request, row.original_id);
    if (row.kind === 'observer') {
      if (row.state === 'committed' && !row.confirmed)
        return { kind: 'observer', observation: await this.confirmCommitted(original, null, JSON.parse(row.terminal), JSON.parse(row.access_event)) };
      return { kind: 'observer', observation: this.observation(request, row) };
    }
    // The dispatched commit has finished without effects (the row is pending under the lock it held): seal it.
    if (row.kind === 'fenced') return { kind: 'observer', observation: await this.sealDirect(permitOf(original, row.epoch), 'StorageFailed') };
    this.active.add(row.original_id);
    this.carried.set(row.original_id, row.envelope === null ? null : JSON.parse(row.envelope));
    this.facts.set(row.original_id, JSON.parse(row.facts));
    let seed: WriteInput;
    try { seed = seedFrom(row.seed); }
    catch { return { kind: 'observer', observation: await this.sealDirect(permitOf(original, row.epoch), 'AttachmentRefused', row.phase === 'commit-dispatched') }; }
    return { kind: 'owner', execution: { permit: permitOf(original, row.epoch), seed, checkpoint: row.checkpoint === null ? null : JSON.parse(row.checkpoint) } };
  }

  async noteAttempt(event: RequestAttemptEvent): Promise<void> {
    const key = event.request ? event.request.receiptKey : null;
    const record = key === null ? null : string(key.record), actorId = key === null ? null : string(key.actorId);
    const requestId = key === null ? null : string(key.requestId);
    await this.call(() => this.db.$queryRaw`SELECT emr_clinical.note_attempt(${string(event.attemptId)}::text, ${string(event.code)}::text,
      ${record}::text, ${actorId}::text, ${requestId}::text, ${textOrNull(event.originalId)}::uuid)::text AS done`);
  }

  /** Originals the restart scan resumes (pending, or committed with an unconfirmed receipt). */
  async openRequests(limit: number = 100): Promise<RequestIdentity[]> {
    const rows = await this.call(() => this.db.$queryRaw<{ record: string; actor_id: string; request_id: string; fingerprint: string }[]>`
      SELECT * FROM emr_clinical.open_requests(${integer(limit, 1)}::integer)`);
    return rows.map(r => ({ receiptKey: { record: r.record as ClinicalRecord, actorId: r.actor_id, requestId: r.request_id }, fingerprint: r.fingerprint }));
  }

  /** The unit with its whole history in the runtime's own client; null when it does not exist. */
  unit(recordId: string): Promise<Readonly<ClinicalUnit> | null> { return readClinicalUnit(this.db, recordId); }
  /** The stored signature records of a unit's versions, by version ID (null for versions that are not clinical entries). */
  signatures(recordId: string): Promise<ReadonlyMap<string, unknown | null>> { return readClinicalSignatures(this.db, recordId); }
  /** Retained versions that incorporate or cite this record (the reference index). */
  referencesTo(recordId: string) { return readClinicalReferences(this.db, recordId); }
}

// ── reads a caller may run in its own transaction (its read snapshot): one schema function each ──
const storedUnits = new WeakSet<object>();
/** Whether `unit` came from readClinicalUnit (a body is only ever served for a unit read from storage). */
export function isStoredUnit(unit: unknown): unit is Readonly<ClinicalUnit> {
  return !!unit && typeof unit === 'object' && storedUnits.has(unit);
}
/** The unit with its whole history, verified as the fold of its versions; null when it does not exist. */
export async function readClinicalUnit(db: ClinicalDatabase, recordId: string): Promise<Readonly<ClinicalUnit> | null> {
  let rows: any[];
  try { rows = await db.$queryRaw<any[]>`SELECT * FROM emr_clinical.unit_for(${string(recordId)}::text)`; } catch (error) { sqlRefusal(error); }
  return unitFromRows(recordId, rows);
}
/** The unit of the stored rows of emr_clinical.unit_for (in version order), verified as the fold of its versions. */
export function unitFromRows(recordId: string, rows: readonly any[]): Readonly<ClinicalUnit> | null {
  if (!rows.length) return null;
  const first = rows[0], last = rows[rows.length - 1];
  const unit: ClinicalUnit = {
    record: first.record, recordId, studyId: first.study_id, managingInstitutionId: first.managing_institution_id, patient: JSON.parse(first.patient),
    parties: { authorId: first.author_id, recipientId: first.recipient_id }, state: first.state, revision: first.revision,
    head: { recordId, versionId: first.head_version_id, sha256: first.head_sha256 }, clinicalEntry: first.clinical_entry,
    versions: rows.map(r => JSON.parse(r.body)),
  };
  if (last.version_id !== first.head_version_id) refuse('UnitHistoryBroken');
  projectUnit(unit);
  const stored = freeze(unit);
  storedUnits.add(stored);
  return stored;
}
export async function readClinicalSignatures(db: ClinicalDatabase, recordId: string): Promise<ReadonlyMap<string, unknown | null>> {
  let rows: any[];
  try { rows = await db.$queryRaw<any[]>`SELECT version_id, signature FROM emr_clinical.unit_for(${string(recordId)}::text)`; } catch (error) { sqlRefusal(error); }
  return new Map(rows.map(r => [r.version_id, r.signature === null ? null : JSON.parse(r.signature)]));
}
export async function readClinicalReferences(db: ClinicalDatabase, recordId: string) {
  let rows: any[];
  try { rows = await db.$queryRaw<any[]>`SELECT * FROM emr_clinical.references_to(${string(recordId)}::text)`; } catch (error) { sqlRefusal(error); }
  return rows.map(r => ({ recordId: r.record_id as string, versionId: r.version_id as string, sha256: r.sha256 as string, kind: r.kind as string }));
}
/** The signed adoption of a prepared SR, or null (the reference fact for clean-up and reconciliation). */
export async function readSrAdoption(db: ClinicalDatabase, recordId: string) {
  let rows: any[];
  try { rows = await db.$queryRaw<any[]>`SELECT * FROM emr_clinical.sr_adoption_for(${string(recordId)}::text)`; } catch (error) { sqlRefusal(error); }
  return rows.length ? freeze({ versionId: rows[0].version_id as string, sha256: rows[0].sha256 as string, bytesSha256: rows[0].bytes_sha256 as string,
    sopInstanceUid: rows[0].sop_instance_uid as string, confirmed: rows[0].confirmed === true }) : null;
}

/** The prepared SRs among `recordIds` whose purpose end is already recorded. */
export async function readSrPurposeEnds(db: ClinicalDatabase, recordIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (!recordIds.length) return new Set();
  const ids = recordIds.map(id => string(id));
  let rows: { record_id: string }[];
  try { rows = await db.$queryRaw<{ record_id: string }[]>`SELECT record_id FROM emr_clinical.sr_purpose_ends(${ids}::text[])`; } catch (error) { sqlRefusal(error); }
  return new Set(rows.map(r => r.record_id));
}
