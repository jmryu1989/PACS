import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { RECORD_CLASSIFICATION, resolveStoredRecord } from '../emr-contract/classification';
import { emrAdapters } from '../emr-contract/composition';
import { CommitOutcomeUnknown, DestructionReceipt, DestructionRecord, DestructionRecordV2, DisposalAuditStore, RetentionGraph, RetentionRecord,
  closeDestructionRecord, destroyAtExpiry, parseRetentionRecord, reloadLegalHolds, retentionDeadline } from '../emr-contract/lawful-defaults';
import { ContractError, refuse, string } from '../emr-contract/validation';
import { snapshotFromRows, transactionScope, withSnapshot } from '../emr-runtime/context';
import type { ClauseRow, HoldRow, RequestRow } from '../emr-runtime/contract';
import { verifyRegisteredServerEnvelope } from '../emr-signature/server-verification';
import { nativeReportContent } from '../emr-report/native-snapshot';
import { CommitOutcome, destroyerAnswer, judgeSettled } from './commit-judgement';
import { destructionRecordDecoder } from './destruction-record';
import { RetentionAdapter, recordLedgerRestoration } from './retention-gate';
import { AppendOnlyLedger, LedgerEntry as FileEntry, LedgerIo, LedgerRestoration, LedgerView as FileView, ledgerDirectory,
  ledgerMirrorDirectory, nodeLedgerIo } from './ledger-file';

/*
 * CD-09-D: the destruction of a native report whose statutory retention ended (H for the report unit).
 *
 * The unit is the study's report: every ReportVersion of the study, the head Report, and the server's signature and
 * signing-operation rows of those versions. Its opaque disposal unit is StudyState.reportUnit; the external ledger
 * (beside the draft purpose ledger, outside every backup) names only that unit. A candidate is an approved report (rs A)
 * whose every version carries the server's signature, verified from its stored envelope and key evidence: the signed
 * time inside that envelope starts the version's part, and A decides
 * (destroyAtExpiry) from the stored holds whether the period ended. Anything this module cannot read as such a record
 * (no signature, an unreadable one, a report that is not approved) is kept whole and reported unconfirmed; a reference
 * from a question, a Related insertion, a critical result, an attachment or an order, and any live or ended draft of the
 * study keep it too (held). One transaction marks the study destroyed (rs D, the unit emptied, a new draft epoch), deletes
 * the versions and the head, deletes the signatures through emr_signing.destroy_report_signatures and moves the anchor;
 * A's completed record is written only after the commit judgement (commit-judgement.ts) says it committed.
 *
 * A destruction never waits for a row: it takes the study, report and version rows and (through
 * emr_signing.lock_report_signatures) the signature and signing-operation rows with NOWAIT, and the fixed-record and hold
 * locks with pg_try_advisory_xact_lock, all before its started record; a study some writer holds is deferred to the next
 * run (busy).
 *
 * completed means deleted from the operational store. WAL, dead tuples and recovery-only copies are not shown gone by
 * it (the record's method says so); the operating procedure for copies is docs/ops/release-tools-runbook.md.
 *
 * The ledger is bound to this database at the server's first start after the D migration: that start writes the header
 * under the anchor's ID and sets initialized (no report destruction can predate the migration that created the anchor).
 * From then on the gate (openGate) refuses a copy whose ledger is missing, another, or shorter, and re-applies every
 * completed unit a restored copy still holds.
 */

export const REPORT_LEDGER_FILE = 'report-retention-ledger.jsonl';
// One ledger writer at a time across the API and the sweep run (a different key from the draft purpose ledger's).
const LEDGER_LOCK = 0x4b494e52; // 'KINR'
const SEOUL_MS = 9 * 3600_000;
const REPORT_YEARS = RECORD_CLASSIFICATION['report-version'].retention.years;
const ACTS: Readonly<Record<string, 'entry' | 'additional-entry' | 'correction'>> = { approve: 'entry', amend: 'correction', addendum: 'additional-entry', reset: 'correction' };
// The signing action native signing writes for each version action (emr-report/native-signing.ts).
const SIGNED_ACTS: Readonly<Record<string, string>> = { approve: 'approve-sign', amend: 'amend', addendum: 'addendum', reset: 'cancel' };
// Every column of the stored version, all of which native signing signs (its body is the saved row). A version whose row
// differs from that body in any of them is not the version the signature dates, the citation and structured testimony
// included.
const SIGNED_COLUMNS = ['id', 'version', 'action', 'findings', 'conclusion', 'recommendation', 'reason', 'author', 'citations',
  'structured', 'at', 'groupId'] as const;
/** A JSON value compared by value: object keys in a fixed order (jsonb stores them in its own order, the signed body in
 * the writer's), arrays in theirs, an absent column the NULL the row stores for it. */
function canonical(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical((value as any)[k])]));
  return value;
}
const sameValue = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export class ReportGateClosed extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ReportGateClosed'; }
}
/** A row or lock some writer holds: the study is left for the next run. */
class Busy extends Error { constructor() { super('ReportRetentionBusy'); this.name = 'Busy'; } }
const lockNotAvailable = (error: any) => error instanceof Busy || error?.meta?.code === '55P03' || error?.code === '55P03' ||
  /55P03|could not obtain lock/.test(String(error?.message ?? ''));

export type LedgerEntry = FileEntry<DestructionRecord>;
export type LedgerView = FileView<DestructionRecord>;

/** The report retention ledger: the common append-only file under `report-retention-ledger.jsonl`, ReportLedger codes;
 * with a mirror directory, written there too (ledger-file.ts). */
export class ReportLedgerFile {
  readonly file: string;
  private readonly log: AppendOnlyLedger<DestructionRecord>;
  constructor(readonly directory: string, io: LedgerIo = nodeLedgerIo, mirrorDirectory: string | null = null) {
    if (!directory || !path.isAbsolute(directory)) throw new ReportGateClosed('ReportLedgerDirectoryRequired');
    this.file = path.join(directory, REPORT_LEDGER_FILE);
    this.log = new AppendOnlyLedger(this.file, 'ReportLedger', destructionRecordDecoder('ReportLedger'), io, mirrorDirectory);
  }
  get mirror(): string | null { return this.log.mirror; }
  read(): LedgerView | null { return this.log.read(); }
  readForGate(): { view: LedgerView | null; standIn: string | null } { return this.log.readForGate(); }
  get standingIn(): string | null { return this.log.standingIn; }
  restoreFromMirror(record: (restoration: LedgerRestoration) => Promise<unknown>): Promise<string> { return this.log.restoreFromMirror(record); }
  create(ledgerId: string): void { this.log.create(ledgerId); }
  append(ledgerId: string, record: DestructionRecord): { seq: number; durableAt: string } { return this.log.append(ledgerId, record); }
}

/** Every record of one attempt, found by its operation ID (the started record's), in ledger order: how the caller of an
 * attempt whose answer was lost reads what became of exactly that attempt. */
export function attemptRecords(ledger: ReportLedgerFile, operationId: string): readonly { seq: number; unit: string; phase: string; occurredAt: string }[] {
  return (ledger.read()?.entries ?? []).filter(e => e.record.formatVersion === 2 && e.record.operationId === operationId)
    .map(e => ({ seq: e.seq, unit: e.record.disposalUnitId, phase: e.record.phase, occurredAt: (e.record as DestructionRecordV2).occurredAt }));
}

function unitPhases(view: LedgerView | null): Map<string, LedgerEntry[]> {
  const units = new Map<string, LedgerEntry[]>();
  for (const entry of view?.entries ?? []) {
    const list = units.get(entry.record.disposalUnitId) ?? [];
    list.push(entry); units.set(entry.record.disposalUnitId, list);
  }
  return units;
}
const completed = (phases: readonly LedgerEntry[] | undefined) => !!phases?.some(e => e.record.phase === 'completed');
const dangling = (phases: readonly LedgerEntry[] | undefined) => !!phases?.length && phases[phases.length - 1].record.phase === 'started';

// ── the facts A reads, from the destruction transaction ──

type Tx = any;
const toDay = (v: unknown) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const seoulDay = (at: string) => new Date(Date.parse(at) + SEOUL_MS).toISOString().slice(0, 10);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

export interface VersionRow {
  /** `at` is the stored instant in the form the signed body serialised it (ISO, milliseconds, Z). */
  id: number; at: string; version: number; action: string; findings: string; conclusion: string; recommendation: string; reason: string | null;
  author: string; citations: unknown; structured: unknown; groupId?: string | null; snapshotFormat?: number;
}
/** What the destruction transaction read for one report, under its locks. `references` names every kind of record that
 * still points at this report (or a draft of the study), in a fixed order. */
export interface ReportFacts {
  uid: string; unit: string; rs: string;
  versions: readonly VersionRow[];
  signatures: ReadonlyMap<string, any>;
  holds: readonly HoldRow[]; accessRequests: ReadonlyMap<string, RequestRow[]>; correctionRequests: ReadonlyMap<string, RequestRow[]>;
  clauseVersions: ReadonlyMap<string, ClauseRow[]>;
  references: readonly string[];
}

async function holdFacts(tx: Tx, recordId: string) {
  const rows = await tx.$queryRaw`SELECT hold_id, phase, body FROM emr_access.holds_for(${recordId}::text)`;
  const holds: HoldRow[] = rows.map((r: any) => ({ holdId: string(r.hold_id), phase: r.phase === 'released' ? 'released' : 'placed', body: string(r.body) }));
  const accessRequests = new Map<string, RequestRow[]>(), correctionRequests = new Map<string, RequestRow[]>();
  const clauseVersions = new Map<string, ClauseRow[]>();
  const requests = async (kind: string, id: string): Promise<RequestRow[]> =>
    (await tx.$queryRaw`SELECT phase, body FROM emr_access.duty_requests(${kind}::text, ${id}::text)`)
      .map((r: any) => ({ phase: r.phase === 'resolved' ? 'resolved' : 'received', body: string(r.body) }));
  // What each stored hold names is read here, so A judges it from this transaction and never from an absent fact.
  for (const hold of holds) {
    let body: any;
    try { body = JSON.parse(hold.body); } catch { continue; }
    const basis = body?.basis ?? {};
    if (typeof basis.clauseId === 'string' && !clauseVersions.has(basis.clauseId))
      clauseVersions.set(basis.clauseId, (await tx.$queryRaw`SELECT law, article, publication, published_at, effective_at
        FROM emr_access.clause_versions(${basis.clauseId}::text)`).map((r: any) => ({ law: string(r.law), article: string(r.article),
        publication: string(r.publication), publishedAt: toDay(r.published_at), effectiveAt: toDay(r.effective_at) })));
    if (typeof basis.requestId === 'string') {
      if (basis.type === 'pending-access-request' && !accessRequests.has(basis.requestId))
        accessRequests.set(basis.requestId, await requests('access-request', basis.requestId));
      if (basis.type === 'statutory-duty' && !correctionRequests.has(basis.requestId))
        correctionRequests.set(basis.requestId, await requests('correction-request', basis.requestId));
    }
  }
  return { holds, accessRequests, correctionRequests, clauseVersions };
}

const REFERENCES = ['question', 'related', 'critical-result', 'attachment', 'order', 'live-draft', 'ended-draft', 'exam-scope'] as const;

/**
 * Lock one report without waiting (study row, head, versions, then the fixed-record and hold locks writers and hold
 * placements take, then the signature and operation rows the deletion removes) and read what A decides from. Null when no study holds this unit. A lock some writer holds throws Busy.
 */
async function readReportFacts(tx: Tx, unit: string): Promise<ReportFacts | null> {
  const [study] = await tx.$queryRaw`SELECT uid, rs FROM "StudyState" WHERE "reportUnit" = ${unit} FOR UPDATE NOWAIT`;
  if (!study) return null;
  const uid: string = study.uid;
  await tx.$queryRaw`SELECT uid FROM "Report" WHERE uid = ${uid} FOR UPDATE NOWAIT`;
  const versions: VersionRow[] = (await tx.$queryRaw`SELECT id, version, action, findings, conclusion, recommendation, reason, author,
    citations, structured, "groupId", "snapshotFormat", to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
    FROM "ReportVersion" WHERE uid = ${uid} ORDER BY version FOR UPDATE NOWAIT`)
    .map((v: any) => ({ ...v, id: Number(v.id), version: Number(v.version) }));
  for (const key of [JSON.stringify(['emr-fixed-record', uid]), 'kin-hold:' + uid]) {
    const [lock] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS ok`;
    if (lock?.ok !== true) throw new Busy();
  }
  // The signature and signing-operation rows the deletion removes, NOWAIT too (a signing retry holds its operation row).
  await tx.$queryRaw`SELECT emr_signing.lock_report_signatures(${uid})::int AS n`;
  const signatures = new Map<string, any>((await tx.$queryRaw`SELECT version_id, outcome FROM emr_signing.signed_version
    WHERE record_id = ${uid}`).map((r: any) => [String(r.version_id), r.outcome]));
  const [found] = await tx.$queryRaw`SELECT
    EXISTS (SELECT 1 FROM "StudyQuestionEntry" e JOIN "StudyQuestion" q ON q.id = e."questionId"
      WHERE q."studyUid" = ${uid} AND e."reportVersion" IS NOT NULL) AS question,
    EXISTS (SELECT 1 FROM "ReportDraftInsertReceipt" WHERE "sourceUid" = ${uid} AND state = 'applied') AS related,
    EXISTS (SELECT 1 FROM "CriticalResult" WHERE "studyUid" = ${uid}) AS "critical-result",
    EXISTS (SELECT 1 FROM emr_clinical.online_reference WHERE source_record_id = ${uid}) AS attachment,
    emr_signing.report_order_referenced(${uid}) AS "order",
    EXISTS (SELECT 1 FROM "ReportDraft" WHERE uid = ${uid} AND present) AS "live-draft",
    EXISTS (SELECT 1 FROM "ReportDraftPurposeEnd" WHERE uid = ${uid}) AS "ended-draft",
    EXISTS (SELECT 1 FROM "StudyGroupMember" m JOIN "StudyGroup" g ON g.id=m."groupId" WHERE m."studyUid"=${uid}
      AND (g."dissolvedAt" IS NULL
        OR EXISTS (SELECT 1 FROM "ReportVersion" v WHERE v."groupId"=g.id AND v.uid<>${uid})
        OR EXISTS (SELECT 1 FROM "ReportDraft" d WHERE d."groupId"=g.id AND d.present)
        OR EXISTS (SELECT 1 FROM "ReportDraftPurposeEnd" e WHERE e."groupId"=g.id))) AS "exam-scope"`;
  return { uid, unit, rs: study.rs, versions, signatures, ...await holdFacts(tx, uid),
    references: REFERENCES.filter(kind => found?.[kind] === true) };
}

// ── A's decision for one report ──

/** The signed version as its envelope says, once the server's verifier accepted it. */
interface SignedVersion { signedAt: string; sha256: string }

/**
 * Each version's signature read the way the server reads its own stored approvals (emr-audit/fixed-versions.ts): the
 * envelope verified under the key registration retained at signing. The part starts at the envelope's signed time, never
 * at the row's summary fields; a summary that disagrees with the envelope, or an envelope signing another record,
 * version or row (any stored column, the JSON testimony by value), is not this version's signature. Returns why a report is kept unread as a record (a fixed code,
 * never text from the report) or the verified signatures.
 */
function signedVersions(facts: ReportFacts): string | Map<string, SignedVersion> {
  if (facts.rs !== 'A') return 'not-approved';
  if (!facts.versions.length) return 'no-version';
  const signed = new Map<string, SignedVersion>();
  for (const v of facts.versions) {
    const versionId = String(v.version), s = facts.signatures.get(versionId);
    if (!s) return 'unsigned-version';
    if (!ACTS[v.action]) return 'version-action-unknown';
    let verified: ReturnType<typeof verifyRegisteredServerEnvelope>, body: any;
    try {
      verified = verifyRegisteredServerEnvelope(s?.envelope, s?.keyAtSigning);
      const text = verified.payload.text;
      body = text.kind === 'clinical-entry' ? nativeReportContent(text.body) : null;
      if ((v.snapshotFormat ?? 1) === 2 && (text.kind !== 'clinical-entry' || JSON.parse(text.body).formatVersion !== 'native-report/2'
        || JSON.parse(text.body).exam?.reportUid !== facts.uid || JSON.parse(text.body).exam?.groupId !== (v.groupId ?? null)))
        return 'signature-version-mismatch';
    } catch { return 'signature-unreadable'; }
    const p = verified.payload;
    if (p.recordKind !== 'report-version' || p.recordId !== facts.uid || p.versionId !== versionId || p.action !== SIGNED_ACTS[v.action] ||
        !body || typeof body !== 'object' || body.uid !== facts.uid ||
        SIGNED_COLUMNS.some(column => !sameValue(body[column], v[column]))) return 'signature-version-mismatch';
    if (s.recordId !== facts.uid || s.versionId !== versionId || s.versionSha256 !== verified.versionSha256 || s.signedAt !== verified.signedAt ||
        !HEX64.test(verified.versionSha256) || !Number.isFinite(Date.parse(verified.signedAt))) return 'signature-summary-mismatch';
    signed.set(versionId, { signedAt: verified.signedAt, sha256: verified.versionSha256 });
  }
  if (facts.signatures.size !== facts.versions.length) return 'signature-without-version';
  return signed;
}

/** Each signed version as the stored record A resolves: its verified server signature starts its part. */
function storedVersions(facts: ReportFacts, signed: ReadonlyMap<string, SignedVersion>) {
  const fixed = new Map<string, unknown>(), events: string[] = [];
  let previous: { partId: string; sha256: string } | null = null;
  for (const v of facts.versions) {
    const versionId = String(v.version), s = signed.get(versionId)!;
    const at = new Date(Date.parse(s.signedAt)).toISOString(), eventId = `report-version:${versionId}`;
    // The content digest covers the whole stored version (its number and action too), as the signed body does.
    const contentSha256 = sha256(JSON.stringify(v));
    fixed.set(eventId, { recordId: facts.uid, model: 'ReportVersion', row: { version: v.version, action: v.action },
      event: { eventId, recordId: facts.uid, versionId, sha256: s.sha256, contentSha256, at, act: ACTS[v.action],
        signature: { versionId, sha256: s.sha256, signedAt: at, verified: true },
        predecessor: previous ? { recordId: facts.uid, partId: previous.partId, sha256: previous.sha256 } : null,
        components: [], processing: null } });
    events.push(eventId);
    previous = { partId: versionId, sha256: s.sha256 };
  }
  return { fixed, events };
}

/** The civil day the five-day window of a deadline ends (its first day is the deadline's own day). */
export function dueDayOf(deadline: string): string {
  const local = new Date(Date.parse(deadline) + SEOUL_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 4)).toISOString().slice(0, 10);
}

export type ReportDecision =
  | { outcome: 'destroyed'; record: Readonly<DestructionRecordV2> }
  | { outcome: 'retained'; deadline: string }
  | { outcome: 'held'; code: string; deadline: string }
  | { outcome: 'unconfirmed'; code: string; deadline: string | null };

const HELD = new Set(['LegalHoldActive', 'HoldReleaseRequired']);

/**
 * A's decision for one report under the caller's locks. A report it cannot read as a signed record is unconfirmed (no
 * record, nothing deleted); a reference keeps it (held); otherwise destroyAtExpiry records started/completed around
 * `destroy`. A refusal before started is returned; anything after started (a failed or unknown deletion) is thrown.
 */
export async function decideReport(store: Pick<DisposalAuditStore, 'append' | 'now'>, facts: ReportFacts, requestedAt: string,
    destroy: () => Promise<DestructionReceipt>): Promise<ReportDecision> {
  const signed = signedVersions(facts);
  if (typeof signed === 'string') return { outcome: 'unconfirmed', code: signed, deadline: null };
  const { fixed, events } = storedVersions(facts, signed);
  const scope = transactionScope();
  const snapshot = snapshotFromRows(scope, { fixedRecords: fixed, holds: new Map([[facts.uid, [...facts.holds]]]),
    accessRequests: facts.accessRequests, correctionRequests: facts.correctionRequests, clauseVersions: facts.clauseVersions,
    accessEvents: new Map() });
  let started = false;
  return withSnapshot(scope, snapshot, async (): Promise<ReportDecision> => {
    let record: Readonly<RetentionRecord>, graph: RetentionGraph, deadline: string;
    try {
      const parts = events.map(eventId => {
        const evidence = resolveStoredRecord(emrAdapters().stored, facts.uid, eventId);
        return { partId: evidence.event.versionId, startedAt: evidence.event.at, evidence };
      });
      record = parseRetentionRecord({ recordId: facts.uid, disposalUnitId: facts.unit, kinds: [...new Set(parts.flatMap(p => p.evidence.kinds))],
        parts, extension: null, holds: reloadLegalHolds(facts.uid), destroyedAt: null });
      graph = { records: [record], references: [], complete: true, revision: 'report:' + facts.unit, checkedAt: requestedAt };
      deadline = retentionDeadline(record, graph);
    } catch (error) {
      return { outcome: 'unconfirmed', code: 'record-unresolved:' + (error instanceof ContractError ? error.code : 'invalid'), deadline: null };
    }
    if (facts.references.length) return { outcome: 'held', code: facts.references[0], deadline };
    try {
      const done = await destroyAtExpiry({ ...store,
        append: async event => { if (event.phase === 'started') started = true; return store.append(event); },
        // The ledger, row and hold locks are the caller's transactions'; A re-reads the same facts under them.
        withRetentionLock: async (_recordId, _at, work) => work(graph),
      }, { record, versionIds: record.parts.map(p => p.partId), requestedAt, graph }, () => destroy());
      return { outcome: 'destroyed', record: done };
    } catch (error) {
      if (started || !(error instanceof ContractError)) throw error;
      if (HELD.has(error.code)) return { outcome: 'held', code: 'legal-hold', deadline };
      if (error.code === 'RetentionNotElapsed') return { outcome: 'retained', deadline };
      return { outcome: 'unconfirmed', code: 'refused:' + error.code, deadline };
    }
  });
}

// ── the unit ──

export type ReportOutcome =
  | { unit: string; outcome: 'destroyed'; seq: number; operationId: string }
  | { unit: string; outcome: 'reapplied' | 'reapply-not-committed' | 'reapply-unconfirmed' | 'absent' | 'retained' }
  | { unit: string; outcome: 'held' | 'unconfirmed'; code: string; dueDay: string | null; overdue: boolean | null }
  | { unit: string; outcome: 'deferred'; code: 'busy' }
  | { unit: string; outcome: 'commit-unknown'; operationId: string }
  | { unit: string; outcome: 'refused'; code: string; operationId: string | null };

/** Each commit target locks a row the attempt's own transaction locked and names what committed and not committed look like. */
export type CommitTarget =
  | { kind: 'destroyed'; unit: string; uid: string; versions: number; startedSeq: number; before: { seq: number; lastCompletedUnit: string | null } }
  | { kind: 'reapplied'; units: readonly string[] };

export async function judgeCommit(db: any, target: CommitTarget): Promise<CommitOutcome> {
  return judgeSettled(db, async (tx: Tx) => {
    if (target.kind === 'destroyed') {
      // The destruction's transaction moved the anchor row: this lock waits for it to settle.
      const anchor = await anchorOf(tx, true);
      const [study] = await tx.$queryRaw`SELECT rs, "reportUnit" FROM "StudyState" WHERE uid = ${target.uid}`;
      const [left] = await tx.$queryRaw`SELECT (SELECT count(*)::int FROM "ReportVersion" WHERE uid = ${target.uid}) AS versions,
        (SELECT count(*)::int FROM emr_signing.signed_version WHERE record_id = ${target.uid}) AS signatures`;
      if (study?.rs === 'D' && study.reportUnit === null && !Number(left.versions) && !Number(left.signatures) &&
          anchor.seq === target.startedSeq + 1 && anchor.lastCompletedUnit === target.unit) return 'committed';
      if (study?.rs === 'A' && study.reportUnit === target.unit && Number(left.versions) === target.versions &&
          anchor.seq === target.before.seq && anchor.lastCompletedUnit === target.before.lastCompletedUnit) return 'not-committed';
      return 'unknown';
    }
    // The re-application emptied the unit of every study it marked destroyed: locking them waits for it.
    const left = await tx.$queryRaw`SELECT uid FROM "StudyState" WHERE "reportUnit" = ANY(${[...target.units]}::text[]) FOR UPDATE`;
    return left.length ? 'not-committed' : 'committed';
  });
}

interface Anchor { ledgerId: string; seq: number; initialized: boolean; lastCompletedUnit: string | null; lastCompletedAt: string | null }
async function anchorOf(tx: Tx, forUpdate: boolean): Promise<Anchor> {
  const rows = forUpdate
    ? await tx.$queryRaw`SELECT "ledgerId"::text AS "ledgerId", seq, initialized, "lastCompletedUnit",
        to_char("lastCompletedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastCompletedAt" FROM "ReportLedgerAnchor" WHERE id = 1 FOR UPDATE`
    : await tx.$queryRaw`SELECT "ledgerId"::text AS "ledgerId", seq, initialized, "lastCompletedUnit",
        to_char("lastCompletedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastCompletedAt" FROM "ReportLedgerAnchor" WHERE id = 1`;
  if (rows.length !== 1) throw new ReportGateClosed('ReportLedgerAnchorMissing');
  const r = rows[0];
  return { ledgerId: r.ledgerId, seq: Number(r.seq), initialized: r.initialized === true, lastCompletedUnit: r.lastCompletedUnit ?? null,
    lastCompletedAt: r.lastCompletedAt ?? null };
}

/** Mark one study's report destroyed and delete it, in this order (the signature function requires the first two). */
async function deleteReport(tx: Tx, uid: string, unit: string, versions: number, signatures: number): Promise<void> {
  const marked = await tx.$executeRaw`UPDATE "StudyState" SET rs = 'D', "reportUnit" = NULL, "repDoc" = NULL, confirm = NULL,
    "preDoc" = NULL, "preReviewer" = NULL, "preDocSub" = NULL, "preReviewerSub" = NULL, "holdReason" = NULL, holder = NULL,
    "holderInstitutionId" = NULL, "heldAt" = NULL, "draftEpoch" = gen_random_uuid(), "updatedAt" = now() AT TIME ZONE 'UTC'
    WHERE uid = ${uid} AND "reportUnit" = ${unit}`;
  if (marked !== 1) refuse('ReportRowChanged');
  if (await tx.$executeRaw`DELETE FROM "ReportVersion" WHERE uid = ${uid}` !== versions) refuse('ReportRowChanged');
  await tx.$executeRaw`DELETE FROM "Report" WHERE uid = ${uid}`;
  const [removed] = await tx.$queryRaw`SELECT emr_signing.destroy_report_signatures(${uid})::int AS n`;
  if (Number(removed?.n) !== signatures) refuse('ReportRowChanged');
}

/** Delete again a unit the ledger already completed (a lost commit answer, or a restored older copy). No new record. */
async function reapply(tx: Tx, unit: string): Promise<boolean> {
  const [study] = await tx.$queryRaw`SELECT uid FROM "StudyState" WHERE "reportUnit" = ${unit} FOR UPDATE NOWAIT`;
  if (!study) return false;
  await tx.$queryRaw`SELECT uid FROM "Report" WHERE uid = ${study.uid} FOR UPDATE NOWAIT`;
  const [counts] = await tx.$queryRaw`SELECT (SELECT count(*)::int FROM (SELECT 1 FROM "ReportVersion" WHERE uid = ${study.uid}
    FOR UPDATE NOWAIT) v) AS versions`;
  const [signatures] = await tx.$queryRaw`SELECT emr_signing.lock_report_signatures(${study.uid})::int AS n`;
  await deleteReport(tx, study.uid, unit, Number(counts.versions), Number(signatures.n));
  return true;
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const ROLLBACK = Symbol('ReportDestructionRollback');
const withOperation = (error: any, operationId: string | null) => {
  if (error && typeof error === 'object' && operationId) error.operationId = operationId;
  return error;
};

export class ReportRetention {
  private chain: Promise<unknown> = Promise.resolve();
  // Attempts of this process whose commit could not be judged (their started record is the ledger's last).
  private readonly attempts = new Map<string, Extract<CommitTarget, { kind: 'destroyed' }>>();
  /** The ledger file's code when the last gate restored it from the mirror (the log line names it). */
  restoredFrom: string | null = null;
  constructor(private readonly db: PrismaClient, readonly ledger: ReportLedgerFile, private readonly now: () => Date = () => new Date()) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** One unit under the ledger lock: the ledger is matched first, then one work transaction decides and deletes. */
  async destroy(unit: string): Promise<ReportOutcome> {
    return this.serial(() => this.db.$transaction(async (lock: Tx) => {
      await lock.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK}::bigint)`;
      const { anchor, view } = await this.matchedLedger(lock, 'destroy');
      return this.destroyLocked(unit, anchor, view);
    }, { maxWait: 10000, timeout: 60000 }));
  }

  private async destroyLocked(unit: string, anchor: Anchor, view: LedgerView | null): Promise<ReportOutcome> {
    const ledgerId = anchor.ledgerId;
    type Ready = { early: ReportOutcome } | { tx: Tx; facts: ReportFacts };
    const ready = deferred<Ready>(), finish = deferred<'commit' | 'rollback'>();
    const work = this.db.$transaction(async (tx: Tx) => {
      // A unit the ledger completed: whatever of it this database holds again is re-applied.
      if (completed(unitPhases(view).get(unit))) {
        const held = await reapply(tx, unit);
        return ready.resolve({ early: { unit, outcome: held ? 'reapplied' : 'absent' } });
      }
      const facts = await readReportFacts(tx, unit);
      if (!facts) return ready.resolve({ early: { unit, outcome: 'absent' } });
      ready.resolve({ tx, facts });
      if (await finish.promise === 'rollback') throw ROLLBACK;
    }, { maxWait: 10000, timeout: 30000 });
    work.catch(error => ready.reject(error));
    let state: Ready;
    try { state = await ready.promise; }
    catch (error) {
      if (lockNotAvailable(error)) return { unit, outcome: 'deferred', code: 'busy' };
      throw error;
    }
    if ('early' in state) {
      let answer: unknown = null;
      try { await work; } catch (error) { answer = error; }
      if (state.early.outcome !== 'reapplied') { if (answer) throw answer; return state.early; }
      // A re-application is answered from the committed database; its failure never touches the ledger.
      const outcome = await judgeCommit(this.db, { kind: 'reapplied', units: [unit] });
      return { unit, outcome: outcome === 'committed' ? 'reapplied' : outcome === 'not-committed' ? 'reapply-not-committed' : 'reapply-unconfirmed' };
    }

    const { tx, facts } = state;
    let startedSeq = 0, operationId: string | null = null;
    let decision: ReportDecision;
    try {
      decision = await decideReport({ append: async event => {
        const appended = this.ledger.append(ledgerId, event);
        if (event.phase === 'started') { startedSeq = appended.seq; operationId = (event as DestructionRecordV2).operationId; }
        return { durableAt: appended.durableAt };
      }, now: () => this.now().toISOString() }, facts, this.now().toISOString(), async () => {
        await deleteReport(tx, facts.uid, unit, facts.versions.length, facts.signatures.size);
        const completedAt = this.now().toISOString();
        // The completed record will be seq+1 (this process holds the ledger lock). The anchor names it, so a stop between
        // this commit and that record is finished from these facts at the next match.
        await tx.$executeRaw`UPDATE "ReportLedgerAnchor" SET seq = ${startedSeq + 1}, initialized = true,
          "lastCompletedUnit" = ${unit}, "lastCompletedAt" = (${completedAt}::timestamptz AT TIME ZONE 'UTC') WHERE id = 1`;
        finish.resolve('commit');
        let commitError: unknown = null;
        try { await work; } catch (error) { commitError = error; }
        // The judgement decides, both ways: a failed COMMIT can come back as success, and an error answering COMMIT is
        // not proof that nothing committed.
        const target = { kind: 'destroyed' as const, unit, uid: facts.uid, versions: facts.versions.length, startedSeq,
          before: { seq: anchor.seq, lastCompletedUnit: anchor.lastCompletedUnit } };
        const outcome = await judgeCommit(this.db, target);
        if (outcome === 'unknown') this.attempts.set(unit, target);
        return destroyerAnswer(outcome, { completedAt, method: 'operational-store-deletion' },
          () => commitError ?? Object.assign(new Error('The deletion did not commit'), { code: 'ReportDeleteNotCommitted' }));
      });
    } catch (error) {
      finish.resolve('rollback');
      await work.catch(() => undefined);
      throw withOperation(error, operationId);
    }
    if (decision.outcome === 'destroyed') return { unit, outcome: 'destroyed', seq: startedSeq + 1, operationId: decision.record.operationId };
    // Nothing was recorded or deleted: the report stays whole for a later run.
    finish.resolve('rollback');
    await work.catch(() => undefined);
    if (decision.outcome === 'retained') return { unit, outcome: 'retained' };
    const dueDay = decision.deadline ? dueDayOf(decision.deadline) : null;
    return { unit, outcome: decision.outcome, code: decision.code, dueDay,
      overdue: dueDay === null ? null : seoulDay(this.now().toISOString()) > dueDay };
  }

  /**
   * The server's sweep after the gate opened, and the dedicated run: every report whose newest version is old enough to
   * be past its period (a coarse bound A then decides exactly), and every unit the ledger completed that this database
   * still holds. Each outcome names only the opaque unit.
   */
  async sweep(): Promise<readonly ReportOutcome[]> {
    const view = await this.serial(() => this.db.$transaction(async (tx: Tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK}::bigint)`;
      return (await this.matchedLedger(tx, 'sweep')).view;
    }));
    // A period of N years starting on a civil day ends no earlier than N years after its first instant less one day.
    const bound = this.now(); bound.setUTCFullYear(bound.getUTCFullYear() - REPORT_YEARS); bound.setUTCDate(bound.getUTCDate() + 1);
    const due: { unit: string }[] = await this.db.$queryRaw`SELECT s."reportUnit" AS unit FROM "StudyState" s
      WHERE s."reportUnit" IS NOT NULL AND EXISTS (SELECT 1 FROM "ReportVersion" v WHERE v.uid = s.uid)
        AND (SELECT max(v.at) FROM "ReportVersion" v WHERE v.uid = s.uid) <= (${bound.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY s.uid`;
    const done = [...unitPhases(view)].filter(([, phases]) => completed(phases)).map(([unit]) => unit);
    const restored: { unit: string }[] = done.length ? await this.db.$queryRaw`
      SELECT "reportUnit" AS unit FROM "StudyState" WHERE "reportUnit" = ANY(${done}::text[]) ORDER BY uid` : [];
    const units = [...new Set([...restored, ...due].map(r => r.unit))];
    const results: ReportOutcome[] = [];
    for (const unit of units) {
      try { results.push(await this.destroy(unit)); }
      catch (error: any) {
        results.push(error instanceof CommitOutcomeUnknown ? { unit, outcome: 'commit-unknown', operationId: (error as any).operationId ?? '' }
          : { unit, outcome: 'refused', code: String(error?.code ?? error?.name ?? 'Error'), operationId: error?.operationId ?? null });
      }
    }
    return results;
  }

  /**
   * The database and the ledger belong together (the draft purpose rules, draft-purpose.ts matchedLedger). No ledger:
   * only the gate may bind one, and only to a database whose anchor was never initialized or moved (its first start
   * after the D migration); anything else stays closed. A ledger: the same ID, the anchor's completion at the anchor's
   * position, at least as long as the database saw (one short only when the anchor proves the started destruction
   * committed), and a last started record settled only by the process that made it. At the gate a mirror may stand in
   * for a missing or unreadable file under the same rules; openGate restores the file from it only once the gate passed.
   */
  private async matchedLedger(tx: Tx, mode: 'gate' | 'destroy' | 'sweep'): Promise<{ anchor: Anchor; view: LedgerView | null; bind: boolean }> {
    const anchor = await anchorOf(tx, false);
    let view: LedgerView | null;
    try { view = mode === 'gate' ? this.ledger.readForGate().view : this.ledger.read(); }
    catch (error) { throw new ReportGateClosed(error instanceof ContractError ? error.code : 'ReportLedgerUnreadable'); }
    if (!view) {
      if (anchor.initialized || anchor.seq > 0) throw new ReportGateClosed('ReportLedgerMissing');
      if (mode === 'gate') return { anchor, view, bind: true };
      throw new ReportGateClosed('ReportLedgerInitializationRequired');
    }
    if (view.ledgerId !== anchor.ledgerId) throw new ReportGateClosed('ReportLedgerMismatch');
    if (anchor.seq > 0 && view.entries.length >= anchor.seq) {
      const at = view.entries[anchor.seq - 1].record;
      if (at.phase !== 'completed' || at.disposalUnitId !== anchor.lastCompletedUnit) throw new ReportGateClosed('ReportLedgerAnchorMismatch');
    }
    if (view.entries.length < anchor.seq) {
      const last = view.entries[view.entries.length - 1]?.record;
      if (view.entries.length !== anchor.seq - 1 || !anchor.lastCompletedUnit || !anchor.lastCompletedAt || last?.phase !== 'started' ||
          last.formatVersion !== 2 || last.disposalUnitId !== anchor.lastCompletedUnit) throw new ReportGateClosed('ReportLedgerBehind');
      this.ledger.append(anchor.ledgerId, closeDestructionRecord(last, 'completed', anchor.lastCompletedAt));
      this.attempts.delete(last.disposalUnitId);
      view = this.ledger.read();
    }
    const last = view!.entries[view!.entries.length - 1]?.record;
    if (last?.phase === 'started') {
      const attempt = this.attempts.get(last.disposalUnitId);
      if (!attempt || last.formatVersion !== 2) throw new ReportGateClosed('ReportIntentIncomplete');
      const outcome = await judgeCommit(this.db, attempt);
      if (outcome === 'unknown') throw new ReportGateClosed('ReportIntentIncomplete');
      if (outcome === 'committed') {
        const now = await anchorOf(this.db, false);
        this.ledger.append(anchor.ledgerId, closeDestructionRecord(last, 'completed', now.lastCompletedAt ?? this.now().toISOString()));
      } else this.ledger.append(anchor.ledgerId, closeDestructionRecord(last, 'failed', this.now().toISOString()));
      this.attempts.delete(last.disposalUnitId);
      view = this.ledger.read();
    }
    return { anchor: await anchorOf(tx, false), view, bind: false };
  }

  /**
   * Before the server accepts a request: bind the ledger at the first start, otherwise match it, re-apply every completed
   * unit this database still holds and judge the re-application in the committed database.
   */
  async openGate(): Promise<{ bound: boolean; reapplied: number; units: number }> {
    const done: string[] = [];
    let bound = false, answer: unknown = null;
    let result: { bound: boolean; reapplied: number; units: number } | null = null;
    try {
      result = await this.serial(() => this.db.$transaction(async (tx: Tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK}::bigint)`;
        const { anchor, view, bind } = await this.matchedLedger(tx, 'gate');
        if (bind) {
          // The header first, then the database says so. A stop between the two leaves a header naming this anchor's ID
          // beside an uninitialized anchor, which the next start matches and initializes.
          this.ledger.create(anchor.ledgerId);
          await tx.$executeRaw`UPDATE "ReportLedgerAnchor" SET initialized = true WHERE id = 1`;
          bound = true;
          return { bound, reapplied: 0, units: 0 };
        }
        if (!anchor.initialized) await tx.$executeRaw`UPDATE "ReportLedgerAnchor" SET initialized = true WHERE id = 1`;
        const units = unitPhases(view);
        let reapplied = 0;
        for (const [unit, phases] of units) {
          if (completed(phases)) { done.push(unit); if (await reapply(tx, unit)) reapplied++; continue; }
          if (dangling(phases)) throw new ReportGateClosed('ReportIntentIncomplete');
        }
        return { bound, reapplied, units: units.size };
      }, { maxWait: 10000, timeout: 60000 }));
    } catch (error) {
      if (!done.length && !bound) throw error;
      answer = error;
    }
    if (done.length) {
      const outcome = await judgeCommit(this.db, { kind: 'reapplied', units: done });
      if (outcome === 'not-committed') throw new ReportGateClosed('ReportReapplyNotCommitted');
      if (outcome === 'unknown') throw new ReportGateClosed('ReportReapplyUnconfirmed');
    }
    if (bound) {
      const [anchor] = await this.db.$queryRaw<any[]>`SELECT initialized FROM "ReportLedgerAnchor" WHERE id = 1`;
      if (anchor?.initialized !== true) throw new ReportGateClosed('ReportLedgerBindNotCommitted');
    }
    if (answer) throw answer;
    // A mirror that stood in for a lost or damaged file passed the whole gate: only now, after its audit row, does it take
    // the file's place.
    if (this.ledger.standingIn)
      this.restoredFrom = await this.ledger.restoreFromMirror(restoration => recordLedgerRestoration(this.db, 'report-retention', restoration));
    return result!;
  }
}

/** Outcomes that are a normal state of a unit: done, nothing to do, not due, or kept by a recorded reason. */
export const REPORT_SETTLED: readonly ReportOutcome['outcome'][] = ['destroyed', 'reapplied', 'absent', 'retained', 'held'];

/** The report unit in the server's retention gate, after the draft purpose unit (main.ts). */
export function reportRetentionAdapter(service: () => ReportRetention): RetentionAdapter {
  let built: ReportRetention | null = null;
  const get = () => built ??= service();
  return {
    name: 'report-retention',
    open: async () => {
      const opened = await get().openGate();
      const restored = get().restoredFrom;
      return (opened.bound ? 'ledger bound at first start' : `${opened.reapplied} re-applied`) +
        (restored ? `; ledger file restored from the mirror (${restored})` : '');
    },
    // A study a writer holds right now is left for the next run, like a held one.
    afterOpen: async () => ({ unsettled: (await get().sweep()).filter(r => ![...REPORT_SETTLED, 'deferred'].includes(r.outcome)).length }),
  };
}

/** The ledger directory: the draft purpose ledger's (the deployment's own, outside every backup), under ReportLedger codes. */
export function reportLedgerDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return ledgerDirectory(env.KIN_PURPOSE_LEDGER_DIR, env.KIN_EMR_STATE_DIR, code => { throw new ReportGateClosed('ReportLedger' + code); });
}

/** The mirror directory of that ledger (KIN_LEDGER_MIRROR_DIR, shared with the draft purpose ledger), or none. */
export function reportLedgerMirrorDirectory(env: NodeJS.ProcessEnv = process.env, directory = reportLedgerDirectory(env)): string | null {
  return ledgerMirrorDirectory(env.KIN_LEDGER_MIRROR_DIR, directory, env.KIN_EMR_STATE_DIR,
    code => { throw new ReportGateClosed('ReportLedger' + code); });
}
