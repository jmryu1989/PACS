import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { resolveStoredRecord } from '../emr-contract/classification';
import { emrAdapters } from '../emr-contract/composition';
import { CommitOutcomeUnknown, DestructionReceipt, DestructionRecord, PurposeDisposalStore, closeDestructionRecord, destroyAtPurposeEnd,
  newPurposeRecord, reloadPurposeRecord, resolvePurposeEnd } from '../emr-contract/lawful-defaults';
import { ContractError, refuse, string } from '../emr-contract/validation';
import { snapshotFromRows, transactionScope, withSnapshot } from '../emr-runtime/context';
import type { ClauseRow, HoldRow, RequestRow } from '../emr-runtime/contract';
import { CommitOutcome, destroyerAnswer, judgeSettled } from './commit-judgement';
import { destructionRecordDecoder } from './destruction-record';
import type { RetentionAdapter } from './retention-gate';
import { AppendOnlyLedger, LedgerIo, LedgerEntry as FileEntry, LedgerView as FileView, ledgerDirectory, ledgerMirrorDirectory,
  nodeLedgerIo, replaceAtomically } from './ledger-file';

/*
 * CD-09-P: the end of a private draft work's purpose and the destruction of its content.
 *
 * The transaction that ends the work (the author's discard, or the signed result made from it) moves the exact payload
 * into ReportDraftPurposeEnd and empties the author's row. Destruction is a second transaction: under the ledger lock it
 * takes the record's hold lock (the one emr_access.place_hold takes), re-reads the holds, lets A decide
 * (destroyAtPurposeEnd), deletes the row and commits; A's completed record is written only after that commit. The ledger
 * is append-only and lives outside every database backup. It names only an opaque disposal unit; the database row is the
 * one mapping from that unit to (uid, author), and it is deleted with the content.
 *
 * A restored older database brings back rows the ledger already destroyed. The startup gate (openGate) runs before the
 * server accepts a request: it re-applies every completed unit the restored copy still holds, and stays closed when it
 * cannot tell what happened (no ledger beside a copy that had one, drafts with no ledger and no prepared first start,
 * another ledger, a shorter ledger, an intent with no end). Every path answers from one commit judgement (judgeCommit).
 */

export const PURPOSE_LEDGER_FILE = 'purpose-ledger.jsonl';
export const PURPOSE_ADOPTION_FILE = 'purpose-adoption.json';
// One writer at a time across the API and the sweep process: every ledger append and every destruction or re-application
// runs under this transaction lock, so the ledger order is the commit order.
const LEDGER_LOCK = 0x4b494e50; // 'KINP'
const SEOUL_MS = 9 * 3600_000;

export class PurposeGateClosed extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PurposeGateClosed'; }
}

export type LedgerEntry = FileEntry<DestructionRecord>;
export type LedgerView = FileView<DestructionRecord>;

function exactKeys(value: any, keys: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export interface Adoption { state: 'prepared' | 'consumed'; ledgerId: string | null }

/** The draft purpose ledger: the common append-only file (ledger-file.ts) under the name `purpose-ledger.jsonl` and the
 * PurposeLedger codes, read through the destruction record decoder (format 1 read only, format 2 for new attempts). Only `create` writes its header (the ledger ID the
 * database's anchor names); an append to a missing file is refused, because a missing ledger is the gate's question
 * (lost, or never initialized) and a new header would answer it wrongly. Beside it, the adoption record of a server that
 * had drafts before CD-09-P (one file, replaced whole). Another unit's ledger in the same directory is not read here.
 * With a mirror directory the ledger is written there too (ledger-file.ts); the adoption record is not: it is read only
 * while no ledger exists, and a mirror holds a ledger. */
export class PurposeLedgerFile {
  readonly file: string;
  readonly adoptionFile: string;
  private readonly log: AppendOnlyLedger<DestructionRecord>;
  constructor(readonly directory: string, private readonly io: LedgerIo = nodeLedgerIo, mirrorDirectory: string | null = null) {
    if (!directory || !path.isAbsolute(directory)) throw new PurposeGateClosed('PurposeLedgerDirectoryRequired');
    this.file = path.join(directory, PURPOSE_LEDGER_FILE);
    this.adoptionFile = path.join(directory, PURPOSE_ADOPTION_FILE);
    this.log = new AppendOnlyLedger(this.file, 'PurposeLedger', destructionRecordDecoder('PurposeLedger'), io, mirrorDirectory);
  }
  get mirror(): string | null { return this.log.mirror; }
  readAdoption(): Adoption | null {
    if (!fs.existsSync(this.adoptionFile)) return null;
    let value: any;
    try { value = JSON.parse(fs.readFileSync(this.adoptionFile, 'utf8')); } catch { refuse('PurposeAdoptionInvalid'); }
    const prepared = exactKeys(value, ['kind', 'formatVersion', 'state', 'preparedAt']) && value.state === 'prepared';
    const consumed = exactKeys(value, ['kind', 'formatVersion', 'state', 'preparedAt', 'ledgerId', 'consumedAt']) &&
      value.state === 'consumed' && typeof value.ledgerId === 'string';
    if (value?.kind !== 'adoption' || value.formatVersion !== 1 || !(prepared || consumed)) refuse('PurposeAdoptionInvalid');
    return { state: value.state, ledgerId: consumed ? value.ledgerId : null };
  }
  /** The operator's preparation, before the P migration of a server that already has drafts. */
  prepareAdoption(): void {
    this.replaceAdoption({ kind: 'adoption', formatVersion: 1, state: 'prepared', preparedAt: new Date().toISOString() });
  }
  /** The first gate consumes the preparation once, naming the ledger it is about to create. */
  consumeAdoption(ledgerId: string): void {
    const raw = JSON.parse(fs.readFileSync(this.adoptionFile, 'utf8'));
    this.replaceAdoption({ ...raw, state: 'consumed', ledgerId, consumedAt: new Date().toISOString() });
  }
  private replaceAdoption(value: object): void {
    replaceAtomically(this.directory, this.adoptionFile, JSON.stringify(value) + '\n', this.io);
  }
  read(): LedgerView | null { return this.log.read(); }
  readForGate(): { view: LedgerView | null; standIn: string | null } { return this.log.readForGate(); }
  get standingIn(): string | null { return this.log.standingIn; }
  restoreFromMirror(): string { return this.log.restoreFromMirror(); }
  create(ledgerId: string): void { this.log.create(ledgerId); }
  append(ledgerId: string, record: DestructionRecord): { seq: number; durableAt: string } { return this.log.append(ledgerId, record); }
}

/** Per unit, the phases the ledger holds in order. */
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

// ── in-process delivery of draft content ──

/**
 * Responses that can carry an author's private draft (the draft read, a draft save's answer, the worklist and bootstrap
 * lists) register when the request enters its handler, before anything is read, and leave when the response finishes or
 * closes. Destruction of that author's ended work first waits for the deliveries registered when it starts: a content
 * read before the end committed is settled (sent or cut) before the ledger says completed. Responses that start later read
 * the emptied row. Nothing here recalls bytes a client already received.
 */
export class DraftDeliveries {
  private readonly open = new Map<string, Set<Promise<void>>>();
  track(author: string, request: IncomingMessage, response: ServerResponse | undefined): void {
    // A handler invoked without an HTTP response (a direct call) delivers nothing over the network.
    if (!response || typeof response.once !== 'function' || typeof request?.once !== 'function') return;
    // The connection's own close also ends it: a pipelined response still queued behind an earlier one when the client
    // cuts the connection never gets the socket, so it emits neither finish nor close (served p10 waited forever on it).
    const connection = request.socket;
    const settled = new Promise<void>(resolve => {
      const done = () => {
        response.off('finish', done); response.off('close', done); response.off('error', done);
        request.off('aborted', done); connection?.off('close', done);
        resolve();
      };
      response.once('finish', done); response.once('close', done); response.once('error', done);
      request.once('aborted', done); connection?.once('close', done);
      if (response.writableFinished || response.destroyed || connection?.destroyed) done();
    });
    const set = this.open.get(author) ?? new Set<Promise<void>>();
    set.add(settled); this.open.set(author, set);
    void settled.then(() => {
      set.delete(settled);
      if (!set.size && this.open.get(author) === set) this.open.delete(author);
    });
  }
  async settled(author: string): Promise<void> {
    await Promise.all([...(this.open.get(author) ?? [])]);
  }
  pending(author: string): number { return this.open.get(author)?.size ?? 0; }
}
export const draftDeliveries = new DraftDeliveries();

// ── the facts A reads, from this transaction ──

type Tx = any;
const toDay = (v: unknown) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();
export const draftRecordId = (uid: string, author: string) => JSON.stringify([uid, author]);
const intentOf = (unit: string) => unit.slice('disposal:'.length);

async function holdRows(tx: Tx, recordId: string): Promise<HoldRow[]> {
  const rows = await tx.$queryRaw`SELECT hold_id, phase, body FROM emr_access.holds_for(${recordId}::text)`;
  return rows.map((r: any) => ({ holdId: string(r.hold_id), phase: r.phase === 'released' ? 'released' : 'placed', body: string(r.body) }));
}
async function requestRows(tx: Tx, kind: 'access-request' | 'correction-request', id: string): Promise<RequestRow[]> {
  const rows = await tx.$queryRaw`SELECT phase, body FROM emr_access.duty_requests(${kind}::text, ${id}::text)`;
  return rows.map((r: any) => ({ phase: r.phase === 'resolved' ? 'resolved' : 'received', body: string(r.body) }));
}
async function clauseRows(tx: Tx, id: string): Promise<ClauseRow[]> {
  const rows = await tx.$queryRaw`SELECT law, article, publication, published_at, effective_at FROM emr_access.clause_versions(${id}::text)`;
  return rows.map((r: any) => ({ law: string(r.law), article: string(r.article), publication: string(r.publication),
    publishedAt: toDay(r.published_at), effectiveAt: toDay(r.effective_at) }));
}

/** The stored source A resolves for one ended work: the draft record, its owner and the result it was written for. */
function storedWork(row: any) {
  const recordId = draftRecordId(row.uid, row.author);
  const content = JSON.stringify([row.findings, row.conclusion, row.recommendation, row.baseVersion, row.citations ?? null, row.structured ?? null]);
  const digest = createHash('sha256').update(content).digest('hex');
  const eventId = 'draft-work:' + intentOf(row.disposalUnitId);
  return { recordId, eventId, fixed: { recordId, model: 'ReportDraft',
    row: { ownerId: row.author, draftBinding: { reportId: row.uid, intentId: intentOf(row.disposalUnitId), action: row.workIntent } },
    event: { eventId, recordId, versionId: row.disposalUnitId, sha256: digest, contentSha256: digest, at: iso(row.workSince),
      act: 'creation', signature: null, predecessor: null, components: [], processing: null } } };
}

/** What the destruction transaction read for one ended work (holds, what they name, and the signed result if any). */
export interface PurposeFacts {
  holds: readonly HoldRow[]; accessRequests: ReadonlyMap<string, RequestRow[]>; correctionRequests: ReadonlyMap<string, RequestRow[]>;
  clauseVersions: ReadonlyMap<string, ClauseRow[]>; signed: { outcome: any; action: string } | null;
}
async function readPurposeFacts(tx: Tx, row: any): Promise<PurposeFacts> {
  const work = storedWork(row);
  const holds = await holdRows(tx, work.recordId);
  const accessRequests = new Map<string, RequestRow[]>(), correctionRequests = new Map<string, RequestRow[]>();
  const clauseVersions = new Map<string, ClauseRow[]>();
  // Read what each stored hold names, so that A judges it from this transaction and never from an absent fact.
  for (const hold of holds) {
    let body: any;
    try { body = JSON.parse(hold.body); } catch { continue; }
    const basis = body?.basis ?? {};
    if (typeof basis.clauseId === 'string' && !clauseVersions.has(basis.clauseId)) clauseVersions.set(basis.clauseId, await clauseRows(tx, basis.clauseId));
    if (typeof basis.requestId === 'string') {
      if (basis.type === 'pending-access-request' && !accessRequests.has(basis.requestId))
        accessRequests.set(basis.requestId, await requestRows(tx, 'access-request', basis.requestId));
      if (basis.type === 'statutory-duty' && !correctionRequests.has(basis.requestId))
        correctionRequests.set(basis.requestId, await requestRows(tx, 'correction-request', basis.requestId));
    }
  }
  let signed: PurposeFacts['signed'] = null;
  if (row.trigger === 'result-version-signed') {
    // The signed result is the server's own signature row and the report version it signed, never the end row alone.
    const rows = await tx.$queryRaw`SELECT s.outcome, v.action FROM emr_signing.signed_version s
      JOIN "ReportVersion" v ON v.uid = s.record_id AND v.version::text = s.version_id
      WHERE s.record_id = ${row.signedRecordId} AND s.version_id = ${row.signedVersionId}`;
    signed = rows.length === 1 ? { outcome: rows[0].outcome, action: rows[0].action } : null;
  }
  return { holds, accessRequests, correctionRequests, clauseVersions, signed };
}

/** The snapshot A decides from: the work as a stored private-draft record, its end, and only the facts read above. */
export function purposeSnapshot(scope: object, row: any, facts: PurposeFacts) {
  const work = storedWork(row);
  const end = { eventId: row.eventId, recordId: work.recordId, trigger: row.trigger, actorId: row.actorId, at: iso(row.endedAt),
    result: row.trigger === 'result-version-signed' ? { draftId: work.recordId, intentId: intentOf(row.disposalUnitId),
      recordId: row.signedRecordId, versionId: row.signedVersionId, signedAt: iso(row.endedAt), action: row.workIntent, verified: true } : null,
    superseded: null };
  const signedResults = new Map<string, unknown>();
  const s = facts.signed;
  if (row.trigger === 'result-version-signed' && s && s.outcome?.recordId === row.signedRecordId && s.outcome?.versionId === row.signedVersionId)
    signedResults.set(JSON.stringify([row.signedRecordId, row.signedVersionId]), { draftId: work.recordId, intentId: intentOf(row.disposalUnitId),
      recordId: row.signedRecordId, versionId: row.signedVersionId, signedAt: iso(s.outcome.signedAt), action: s.action, verified: true });
  const snapshot = snapshotFromRows(scope, { holds: new Map([[work.recordId, [...facts.holds]]]), accessRequests: facts.accessRequests,
    correctionRequests: facts.correctionRequests, clauseVersions: facts.clauseVersions, accessEvents: new Map(),
    fixedRecords: new Map([[work.eventId, work.fixed]]), purposeEnds: new Map([[row.eventId, end]]), signedResults });
  return { work, snapshot };
}

/**
 * A's decision for one ended work, under the caller's locks: the stored work keeps the unit its row and the ledger know
 * (A would draw a new one for a new record), the end is resolved from the snapshot, and destroyAtPurposeEnd records
 * started/completed around `destroy`. Throws A's refusal code; nothing is recorded before A accepts.
 */
export async function decidePurposeEnd(store: Omit<PurposeDisposalStore, 'withPurposeLock' | 'withRetentionLock'>, row: any,
    facts: PurposeFacts, requestedAt: string, destroy: () => Promise<DestructionReceipt>): Promise<Readonly<DestructionRecord>> {
  const scope = transactionScope();
  const { work, snapshot } = purposeSnapshot(scope, row, facts);
  return withSnapshot(scope, snapshot, async () => {
    const source = resolveStoredRecord(emrAdapters().stored, work.recordId, work.eventId);
    const record = reloadPurposeRecord({ ...newPurposeRecord(source, [row.disposalUnitId]), disposalUnitId: row.disposalUnitId });
    const event = resolvePurposeEnd(emrAdapters().purpose, row.eventId);
    return destroyAtPurposeEnd({ ...store,
      withRetentionLock: async () => refuse('RetentionLockRequired'),
      // The ledger, row and hold locks are the caller's transactions'; A re-reads the same facts under them.
      withPurposeLock: async (_recordId, _at, work) => work(reloadPurposeRecord(record)),
    }, record, event, requestedAt, () => destroy());
  });
}

// ── destruction ──

export type DestructionOutcome =
  | { unit: string; outcome: 'destroyed'; seq: number }
  | { unit: string; outcome: 'reapplied' }
  | { unit: string; outcome: 'reapply-not-committed' }
  | { unit: string; outcome: 'reapply-unconfirmed' }
  | { unit: string; outcome: 'unconfirmed' }
  | { unit: string; outcome: 'absent' }
  | { unit: string; outcome: 'delivery-pending' }
  | { unit: string; outcome: 'held'; code: string }
  | { unit: string; outcome: 'refused'; code: string };

/**
 * r3: one judgement for every path that changes the database for a work's purpose (its end, its destruction, a
 * re-application to a restored copy), read through the judgement every retention unit shares (commit-judgement.ts: a
 * new transaction after the attempt settled, a bounded lock wait, unknown for a read that cannot be made).
 *
 * Each target locks a row the attempt's own transaction locked and names what the committed and the not-committed
 * database each look like. A row that is merely absent is never the evidence by itself; anything else (including
 * contradicting facts) is unknown.
 */
export type CommitTarget =
  // An ending transaction (Discard, Clear, the author's Reset, a signed result) on (uid, author) from `revision`.
  | { kind: 'ended'; uid: string; author: string; unit: string; revision: number }
  // A destruction attempt: the anchor before it, and the started record's position.
  | { kind: 'destroyed'; unit: string; startedSeq: number; before: { seq: number; lastCompletedUnit: string | null } }
  // A re-application of completed units to a restored copy (sweep or gate).
  | { kind: 'reapplied'; units: readonly string[] };

export async function judgeCommit(db: any, target: CommitTarget, ledger: PurposeLedgerFile | null): Promise<CommitOutcome> {
  return judgeSettled(db, async (tx: Tx) => {
      if (target.kind === 'ended') {
        // The ending transaction held the study row (draftTransaction's lock order) until it settled.
        await tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid = ${target.uid} FOR UPDATE`;
        const end = await tx.$queryRaw`SELECT 1 AS present FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId" = ${target.unit}`;
        const [draft] = await tx.$queryRaw`SELECT revision, present, "workUnit" FROM "ReportDraft"
          WHERE uid = ${target.uid} AND author = ${target.author}`;
        const moved = !!draft && Number(draft.revision) >= target.revision + 1 && draft.workUnit !== target.unit;
        if (moved && end.length) return 'committed';
        // The end row is gone only when a destruction of this unit followed the committed end.
        const recorded = !end.length && moved && !!ledger && unitPhases(ledger.read()).has(target.unit);
        if (recorded) return 'committed';
        if (!end.length && draft?.present === true && Number(draft.revision) === target.revision && draft.workUnit === target.unit &&
            !(ledger && unitPhases(ledger.read()).has(target.unit))) return 'not-committed';
        return 'unknown';
      }
      if (target.kind === 'destroyed') {
        // The destruction's transaction moved the anchor row: this lock waits for it to settle.
        const anchor = await anchorOf(tx, true);
        const end = await tx.$queryRaw`SELECT 1 AS present FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId" = ${target.unit}`;
        const [live] = await tx.$queryRaw`SELECT count(*)::int AS n FROM "ReportDraft" WHERE "workUnit" = ${target.unit}`;
        if (!end.length && !Number(live?.n) && anchor.seq === target.startedSeq + 1 && anchor.lastCompletedUnit === target.unit)
          return 'committed';
        if (end.length && anchor.seq === target.before.seq && anchor.lastCompletedUnit === target.before.lastCompletedUnit)
          return 'not-committed';
        return 'unknown';
      }
      // The re-application deleted the ended rows and emptied the live rows of these units: locking them waits for it.
      const units = [...target.units];
      const ended = await tx.$queryRaw`SELECT "disposalUnitId" FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId" = ANY(${units}::text[]) FOR UPDATE`;
      const live = await tx.$queryRaw`SELECT "workUnit" FROM "ReportDraft" WHERE "workUnit" = ANY(${units}::text[]) FOR UPDATE`;
      return ended.length || live.length ? 'not-committed' : 'committed';
  });
}
const HELD = new Set(['LegalHoldActive', 'HoldReleaseRequired']);
// A failed attempt the server itself retries (a database error: the settle update, the destruction transaction or its
// commit). A refusal (hold, ledger the database cannot be matched with) waits for the sweep after its cause is cleared.
const RETRY_MS = [1000, 5000, 30_000, 120_000, 600_000];

function seoulDay(at: string) { return new Date(Date.parse(at) + SEOUL_MS).toISOString().slice(0, 10); }
/** The record of an attempt that started: completed or failed at `at`, judged against the started record's own due day.
 * An attempt closes in the format it started in: an open format-1 attempt (a P release's) gets a format-1 terminal
 * record, since format 1 has no operation to tie a format-2 one to. */
function ending(started: Readonly<DestructionRecord>, phase: 'completed' | 'failed', at: string): DestructionRecord {
  if (started.formatVersion === 1)
    return { ...started, phase, day: seoulDay(at), timeliness: seoulDay(at) <= started.dueDay ? 'within-five-days' : 'overdue' };
  return closeDestructionRecord(started, phase, at);
}

interface Anchor { ledgerId: string; seq: number; initialized: boolean; lastCompletedUnit: string | null; lastCompletedAt: string | null }
async function anchorOf(tx: Tx, forUpdate: boolean): Promise<Anchor> {
  const rows = forUpdate
    ? await tx.$queryRaw`SELECT "ledgerId"::text AS "ledgerId", seq, initialized, "lastCompletedUnit",
        to_char("lastCompletedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastCompletedAt" FROM "PurposeLedgerAnchor" WHERE id = 1 FOR UPDATE`
    : await tx.$queryRaw`SELECT "ledgerId"::text AS "ledgerId", seq, initialized, "lastCompletedUnit",
        to_char("lastCompletedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastCompletedAt" FROM "PurposeLedgerAnchor" WHERE id = 1`;
  if (rows.length !== 1) throw new PurposeGateClosed('PurposeLedgerAnchorMissing');
  const r = rows[0];
  return { ledgerId: r.ledgerId, seq: Number(r.seq), initialized: r.initialized === true, lastCompletedUnit: r.lastCompletedUnit ?? null,
    lastCompletedAt: r.lastCompletedAt ?? null };
}
const holdLock = (row: any) => 'kin-hold:' + draftRecordId(row.uid, row.author);
/** Whether this database ever handed out a work (a numbered live draft or an ended one). */
async function anyWork(tx: Tx): Promise<boolean> {
  const [works] = await tx.$queryRaw`SELECT EXISTS (SELECT 1 FROM "ReportDraft" WHERE "workUnit" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "ReportDraftPurposeEnd") AS any`;
  return works?.any === true;
}

/** Delete the stored payload of a unit the ledger already completed (a destruction whose commit was lost, or a restored
 * older copy). No new ledger record: the original completion and its day stand. */
async function reapply(tx: Tx, unit: string): Promise<boolean> {
  const ended = await tx.$executeRaw`DELETE FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId" = ${unit}`;
  // A copy taken while the work was still live holds the content in the author's row. Empty exactly that work: the row
  // keeps its revision boundary (and moves past it), so no request of the old work can write it back.
  const live = await tx.$executeRaw`UPDATE "ReportDraft" SET present = false, findings = '', conclusion = '', recommendation = '',
    "baseVersion" = 0, citations = NULL, structured = NULL, revision = revision + 1, "workUnit" = NULL, "workSince" = NULL,
    "workIntent" = NULL, "updatedAt" = now() AT TIME ZONE 'UTC' WHERE "workUnit" = ${unit}`;
  return ended + live > 0;
}

/** A promise with its settle functions, for one transaction that stays open across A's decision. */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const ROLLBACK = Symbol('PurposeDestructionRollback');

export class DraftPurposeDisposal {
  private readonly inflight = new Set<Promise<unknown>>();
  // One ledger writer per process at a time (each holds two pooled connections: the ledger lock and the work).
  private chain: Promise<unknown> = Promise.resolve();
  private initializedSeen = false;
  // Attempts of this process whose commit could not be judged (their started record is the ledger's last). Only the
  // process that made the attempt knows what the anchor was before it; another process finds no evidence and refuses.
  private readonly attempts = new Map<string, Extract<CommitTarget, { kind: 'destroyed' }>>();
  /** The ledger file's code when the last gate restored it from the mirror (the log line names it). */
  restoredFrom: string | null = null;
  /**
   * `deliveries` is this process's registry of responses that carry drafts: the API server's own. A process without
   * one (the sweep run) cannot know what the server is still sending and reports such a work as delivery-pending.
   */
  constructor(private readonly db: PrismaClient, readonly ledger: PurposeLedgerFile,
    private readonly deliveries: DraftDeliveries | null = draftDeliveries, private readonly now: () => Date = () => new Date()) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** After the ending transaction committed (API process): settle this author's deliveries, then destroy. A database
   * failure is retried here with a growing wait; a refusal stays pending for the sweep. Nothing undoes the end. */
  scheduleDestruction(unit: string, author: string, attempt = 0): void {
    const job = (async () => {
      if (this.deliveries) await this.deliveries.settled(author);
      await this.db.$executeRaw`UPDATE "ReportDraftPurposeEnd" SET "deliverySettled" = true WHERE "disposalUnitId" = ${unit}`;
      const result = await this.destroy(unit);
      if (result.outcome === 'refused') console.error(`[CD-09-P] Destruction of ${unit} refused: ${result.code}`);
      return result;
    })().catch(error => {
      // An attempt of this unit whose outcome is unknown is this process's to settle: keep trying until it can read.
      const retry = (this.attempts.has(unit) || !(error instanceof ContractError) && !(error instanceof PurposeGateClosed)) &&
        attempt < RETRY_MS.length;
      console.error(`[CD-09-P] Destruction attempt failed${retry ? `; retry ${attempt + 1} in ${RETRY_MS[attempt]} ms` : ''}:`,
        error?.code ?? error?.name ?? 'error');
      if (retry) setTimeout(() => this.scheduleDestruction(unit, author, attempt + 1), RETRY_MS[attempt]).unref();
    });
    this.inflight.add(job);
    void job.finally(() => this.inflight.delete(job));
  }
  async drained(): Promise<void> { await Promise.allSettled([...this.inflight]); }

  /**
   * An end whose commit could not be confirmed (its answer was 503 REPORT_DRAFT_END_UNCONFIRMED): judged again here
   * with the same growing wait. Committed: destroyed like any end. Not committed: nothing to do (the draft is as it was).
   */
  recheckEnd(target: Extract<CommitTarget, { kind: 'ended' }>, attempt = 0): void {
    if (attempt >= RETRY_MS.length) {
      console.error(`[CD-09-P] End of ${target.unit} still unconfirmed; the sweep or the author's next request settles it`);
      return;
    }
    setTimeout(() => {
      void judgeCommit(this.db, target, this.ledger).then(outcome => {
        if (outcome === 'committed') this.scheduleDestruction(target.unit, target.author);
        else if (outcome === 'unknown') this.recheckEnd(target, attempt + 1);
      });
    }, RETRY_MS[attempt]).unref();
  }

  /**
   * One unit under the ledger lock (its own transaction): the database and the ledger are matched first, then one work
   * transaction locks the ended row, takes the record's hold lock, reads the facts and lets A decide. A records started,
   * the delete and the anchor are committed, and A is answered from the commit judgement: committed is done (A records
   * completed), not committed is A's failed (the row stays for the next attempt), unknown leaves started as the last
   * record for this process to settle (CommitOutcomeUnknown).
   */
  async destroy(unit: string): Promise<DestructionOutcome> {
    return this.serial(() => this.db.$transaction(async (lock: Tx) => {
      await lock.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK}::bigint)`;
      const { anchor, view } = await this.matchedLedger(lock, 'destroy');
      return this.destroyLocked(unit, anchor, view);
    }, { maxWait: 10000, timeout: 60000 })).then(async (result: DestructionOutcome) => {
      if (result.outcome === 'held' || result.outcome === 'refused')
        await this.db.$executeRaw`UPDATE "ReportDraftPurposeEnd" SET attempts = attempts + 1, "lastRefusal" = ${result.code}
          WHERE "disposalUnitId" = ${unit}`;
      return result;
    }, async (error: any) => {
      const code = error instanceof ContractError ? error.code : error?.code ?? error?.name ?? 'Error';
      await this.db.$executeRaw`UPDATE "ReportDraftPurposeEnd" SET attempts = attempts + 1, "lastRefusal" = ${String(code)}
        WHERE "disposalUnitId" = ${unit}`.catch(() => undefined);
      throw error;
    });
  }

  private async destroyLocked(unit: string, anchor: Anchor, view: LedgerView | null): Promise<DestructionOutcome> {
    const ledgerId = anchor.ledgerId;
    type Ready = { early: DestructionOutcome } | { tx: Tx; row: any; facts: PurposeFacts };
    const ready = deferred<Ready>(), finish = deferred<'commit' | 'rollback'>();
    const work = this.db.$transaction(async (tx: Tx) => {
      const [row] = await tx.$queryRaw`SELECT * FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId" = ${unit} FOR UPDATE`;
      const phases = unitPhases(view).get(unit);
      // A unit the ledger completed: whatever of it this database holds again (its ended row, or the live row of a copy
      // taken before the end) is re-applied. Nothing held is absent.
      if (completed(phases)) {
        const held = await reapply(tx, unit);
        return ready.resolve({ early: { unit, outcome: held ? 'reapplied' : 'absent' } });
      }
      if (!row) return ready.resolve({ early: { unit, outcome: 'absent' } });
      if (!row.deliverySettled) return ready.resolve({ early: { unit, outcome: 'delivery-pending' } });
      // The record's holds are read after any placement in flight committed (emr_access.place_hold takes this lock).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${holdLock(row)}, 0))`;
      ready.resolve({ tx, row, facts: await readPurposeFacts(tx, row) });
      if (await finish.promise === 'rollback') throw ROLLBACK;
    }, { maxWait: 10000, timeout: 30000 });
    work.catch(error => ready.reject(error));
    const state = await ready.promise;
    if ('early' in state) {
      let answer: unknown = null;
      try { await work; } catch (error) { answer = error; }
      if (state.early.outcome !== 'reapplied') { if (answer) throw answer; return state.early; }
      // A re-application is answered from the committed database, whatever the transaction answered. Its failure never
      // touches the ledger: the original completed stands.
      const outcome = await judgeCommit(this.db, { kind: 'reapplied', units: [unit] }, null);
      return { unit, outcome: outcome === 'committed' ? 'reapplied' : outcome === 'not-committed' ? 'reapply-not-committed' : 'reapply-unconfirmed' };
    }

    const { tx, row, facts } = state;
    let startedSeq = 0;
    try {
      await decidePurposeEnd({ append: async event => {
        const appended = this.ledger.append(ledgerId, event);
        if (event.phase === 'started') startedSeq = appended.seq;
        return { durableAt: appended.durableAt };
      }, now: () => this.now().toISOString() }, row, facts, this.now().toISOString(), async () => {
        const deleted = await tx.$executeRaw`DELETE FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId" = ${unit}`;
        if (deleted !== 1) refuse('PurposeRowChanged');
        const completedAt = this.now().toISOString();
        // The completed record will be seq+1 (this process holds the ledger lock). The anchor names it, so a stop between
        // this commit and that record is finished from these facts at the next match.
        await tx.$executeRaw`UPDATE "PurposeLedgerAnchor" SET seq = ${startedSeq + 1}, initialized = true,
          "lastCompletedUnit" = ${unit}, "lastCompletedAt" = (${completedAt}::timestamptz AT TIME ZONE 'UTC') WHERE id = 1`;
        finish.resolve('commit');
        let commitError: unknown = null;
        try { await work; } catch (error) { commitError = error; }
        // The judgement decides, both ways: a failed COMMIT can reach the client as a resolved transaction (a deferred
        // constraint's error at COMMIT was answered as success on the served stack), and an error answering COMMIT is
        // not proof that nothing committed.
        const target = { kind: 'destroyed' as const, unit, startedSeq, before: { seq: anchor.seq, lastCompletedUnit: anchor.lastCompletedUnit } };
        const outcome = await judgeCommit(this.db, target, null);
        if (outcome === 'unknown') this.attempts.set(unit, target);
        return destroyerAnswer(outcome, { completedAt, method: 'operational-store-deletion' },
          () => commitError ?? Object.assign(new Error('The deletion did not commit'), { code: 'PurposeDeleteNotCommitted' }));
      });
    } catch (error) {
      finish.resolve('rollback');
      await work.catch(() => undefined);
      // A refusal before any record or delete: the payload stays and the refusal is noted for the sweep and operator.
      if (!startedSeq && error instanceof ContractError)
        return { unit, outcome: HELD.has(error.code) ? 'held' : 'refused', code: error.code };
      throw error;
    }
    return { unit, outcome: 'destroyed', seq: startedSeq + 1 };
  }

  /**
   * The daily recovery and the post-release resume: every ended work. A work whose deliveries this process cannot see
   * settled (the sweep run, while the server may still be sending it) is reported delivery-pending, never skipped.
   */
  async sweep(): Promise<readonly DestructionOutcome[]> {
    // A database the ledger cannot be matched with is not swept: that is the startup gate's refusal, not a unit's.
    const view = await this.serial(() => this.db.$transaction(async (tx: Tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK}::bigint)`;
      return (await this.matchedLedger(tx, 'sweep')).view;
    }));
    const rows: { disposalUnitId: string; author: string; deliverySettled: boolean }[] = await this.db.$queryRaw`
      SELECT "disposalUnitId", author, "deliverySettled" FROM "ReportDraftPurposeEnd" ORDER BY "endedAt", "disposalUnitId"`;
    // A copy taken while a work the ledger completed was still live holds it in the author's row, with no ended row.
    const done = [...unitPhases(view)].filter(([, phases]) => completed(phases)).map(([unit]) => unit);
    const liveUnits: { workUnit: string }[] = done.length ? await this.db.$queryRaw`
      SELECT DISTINCT "workUnit" FROM "ReportDraft" WHERE "workUnit" = ANY(${done}::text[])` : [];
    const ended = new Set(rows.map(r => r.disposalUnitId));
    const targets = [...rows, ...liveUnits.filter(r => !ended.has(r.workUnit))
      .map(r => ({ disposalUnitId: r.workUnit, author: '', deliverySettled: true }))];
    const results: DestructionOutcome[] = [];
    for (const { disposalUnitId, author, deliverySettled } of targets) {
      try {
        if (!deliverySettled) {
          if (!this.deliveries) { results.push({ unit: disposalUnitId, outcome: 'delivery-pending' }); continue; }
          await this.deliveries.settled(author);
          await this.db.$executeRaw`UPDATE "ReportDraftPurposeEnd" SET "deliverySettled" = true WHERE "disposalUnitId" = ${disposalUnitId}`;
        }
        results.push(await this.destroy(disposalUnitId));
      } catch (error: any) {
        results.push(error instanceof CommitOutcomeUnknown ? { unit: disposalUnitId, outcome: 'unconfirmed' }
          : { unit: disposalUnitId, outcome: 'refused', code: error?.code ?? error?.name ?? 'Error' });
      }
    }
    return results;
  }

  /**
   * The database and the ledger belong together. Runs under the ledger lock; reads the anchor without locking its row.
   *
   * No ledger (C5): accepted only beside a database that never handed out a work (I1), or - for the gate only - beside
   * a database that did, never initialized, whose operator prepared its adoption before the P migration (I2; the gate
   * consumes it). Everything else the product can tell apart stays closed: works with nothing prepared (I3/I9), an
   * adoption already consumed (I4), an initialized or advanced database (I5). A database and directory copied together
   * before the first start cannot be told from a real first start; that copy is excluded by the operating procedure.
   *
   * A ledger: the same ID (I6), the anchor's completion at the anchor's position (R2), and at least as long as the
   * database saw - one record short only when the anchor proves the started destruction committed (R1: its completed
   * record is written now from the anchor's completion time). A last started record (an attempt with no end) is settled
   * only by the process that made it, from the commit judgement (R3); no other evidence exists (R4), and while it stays
   * unknown no other unit starts (R5): both refuse with PurposeIntentIncomplete and leave the ledger as it is.
   *
   * At the gate a mirror may stand in for a missing or unreadable ledger file (ledger-file.ts readForGate): every rule
   * above applies to it unchanged, and openGate puts it in the file's place only after the whole gate passed.
   */
  private async matchedLedger(tx: Tx, mode: 'gate' | 'destroy' | 'sweep'):
      Promise<{ anchor: Anchor; view: LedgerView | null; adopt: boolean }> {
    const anchor = await anchorOf(tx, false);
    let view: LedgerView | null, adoption: Adoption | null;
    try { view = mode === 'gate' ? this.ledger.readForGate().view : this.ledger.read(); adoption = this.ledger.readAdoption(); }
    catch (error) { throw new PurposeGateClosed(error instanceof ContractError ? error.code : 'PurposeLedgerUnreadable'); }
    if (!view) {
      if (anchor.initialized || anchor.seq > 0 || adoption?.state === 'consumed') throw new PurposeGateClosed('PurposeLedgerMissing');
      if (mode === 'gate' && adoption?.state === 'prepared') return { anchor, view, adopt: true };
      if (!await anyWork(tx)) return { anchor, view, adopt: false };
      throw new PurposeGateClosed('PurposeLedgerInitializationRequired');
    }
    if (view.ledgerId !== anchor.ledgerId) throw new PurposeGateClosed('PurposeLedgerMismatch');
    if (anchor.seq > 0 && view.entries.length >= anchor.seq) {
      const at = view.entries[anchor.seq - 1].record;
      if (at.phase !== 'completed' || at.disposalUnitId !== anchor.lastCompletedUnit) throw new PurposeGateClosed('PurposeLedgerAnchorMismatch');
    }
    if (view.entries.length < anchor.seq) {
      const last = view.entries[view.entries.length - 1]?.record;
      if (view.entries.length !== anchor.seq - 1 || !anchor.lastCompletedUnit || !anchor.lastCompletedAt || last?.phase !== 'started' ||
          last.disposalUnitId !== anchor.lastCompletedUnit) throw new PurposeGateClosed('PurposeLedgerBehind');
      this.ledger.append(anchor.ledgerId, ending(last, 'completed', anchor.lastCompletedAt));
      this.attempts.delete(last.disposalUnitId);
      view = this.ledger.read();
    }
    const last = view!.entries[view!.entries.length - 1]?.record;
    if (last?.phase === 'started') {
      const attempt = this.attempts.get(last.disposalUnitId);
      if (!attempt) throw new PurposeGateClosed('PurposeIntentIncomplete');
      const outcome = await judgeCommit(this.db, attempt, null);
      if (outcome === 'unknown') throw new PurposeGateClosed('PurposeIntentIncomplete');
      if (outcome === 'committed') {
        // Committed after the anchor read above: the anchor now names it (R1 from the committed values).
        const now = await anchorOf(this.db, false);
        this.ledger.append(anchor.ledgerId, ending(last, 'completed', now.lastCompletedAt ?? this.now().toISOString()));
      } else this.ledger.append(anchor.ledgerId, ending(last, 'failed', this.now().toISOString()));
      this.attempts.delete(last.disposalUnitId);
      view = this.ledger.read();
    }
    return { anchor: await anchorOf(tx, false), view, adopt: false };
  }

  /**
   * Before a new work unit is handed out (in the saving transaction): the ledger file exists and the database says so.
   * From then on a copy of this database without its ledger beside it does not open.
   */
  async ensureLedger(tx: Tx): Promise<void> {
    if (this.initializedSeen) return;
    const [anchor] = await tx.$queryRaw`SELECT initialized FROM "PurposeLedgerAnchor" WHERE id = 1`;
    if (anchor?.initialized === true) { this.initializedSeen = true; return; }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK}::bigint)`;
    const locked = await anchorOf(tx, true);
    if (locked.initialized) return;
    // The same reading as the gate's: the header is created here only for a database that never handed out a work.
    // A ledger already there (this header written by an earlier transaction that did not commit) must be this one.
    let view: LedgerView | null, adoption: Adoption | null;
    try { view = this.ledger.read(); adoption = this.ledger.readAdoption(); }
    catch (error) { throw new PurposeGateClosed(error instanceof ContractError ? error.code : 'PurposeLedgerUnreadable'); }
    if (view && view.ledgerId !== locked.ledgerId) throw new PurposeGateClosed('PurposeLedgerMismatch');
    if (!view) {
      if (locked.seq > 0 || adoption) throw new PurposeGateClosed(adoption?.state === 'prepared'
        ? 'PurposeLedgerInitializationRequired' : 'PurposeLedgerMissing');
      if (await anyWork(tx)) throw new PurposeGateClosed('PurposeLedgerInitializationRequired');
      this.ledger.create(locked.ledgerId);
    }
    await tx.$executeRaw`UPDATE "PurposeLedgerAnchor" SET initialized = true WHERE id = 1`;
  }

  /**
   * Before the server accepts a request. Re-applies every completed unit this database still holds and refuses to open
   * when the database and the ledger cannot be matched. Returns what it re-applied; never appends a completion except
   * the one the anchor proves committed (matchedLedger).
   */
  async openGate(): Promise<{ reapplied: number; units: number; resolved: number }> {
    const done: string[] = [];
    let adopted = false, answer: unknown = null;
    let result: { reapplied: number; units: number; resolved: number } | null = null;
    try {
      result = await this.serial(() => this.db.$transaction(async (tx: Tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK}::bigint)`;
        const { anchor, view, adopt } = await this.matchedLedger(tx, 'gate');
        if (adopt) {
          // I2, in this order: the preparation is consumed (naming this ledger), the header is written, the database
          // says so. A stop between the first two leaves a consumed adoption and no ledger: closed (I4), never re-opened.
          this.ledger.consumeAdoption(anchor.ledgerId);
          this.ledger.create(anchor.ledgerId);
          await tx.$executeRaw`UPDATE "PurposeLedgerAnchor" SET initialized = true WHERE id = 1`;
          adopted = true;
        }
        if (!view) {
          await tx.$executeRaw`UPDATE "ReportDraftPurposeEnd" SET "deliverySettled" = true WHERE NOT "deliverySettled"`;
          return { reapplied: 0, units: 0, resolved: 0 };
        }
        if (!anchor.initialized) await tx.$executeRaw`UPDATE "PurposeLedgerAnchor" SET initialized = true WHERE id = 1`;
        const units = unitPhases(view);
        let reapplied = 0;
        for (const [unit, phases] of units) {
          if (completed(phases)) { done.push(unit); if (await reapply(tx, unit)) reapplied++; continue; }
          // matchedLedger settled the last record; an attempt with no end anywhere else has no evidence in this copy.
          if (dangling(phases)) throw new PurposeGateClosed('PurposeIntentIncomplete');
        }
        // This process starts with no response in flight: whatever an earlier process was sending has ended.
        await tx.$executeRaw`UPDATE "ReportDraftPurposeEnd" SET "deliverySettled" = true WHERE NOT "deliverySettled"`;
        return { reapplied, units: units.size, resolved: 0 };
      }, { maxWait: 10000, timeout: 60000 }));
    } catch (error) {
      if (!done.length && !adopted) throw error;
      answer = error;
    }
    // The re-application is judged in the committed database, not taken from the transaction's answer (a failed COMMIT
    // can come back as success): the server opens only when every completed unit is confirmed gone.
    if (done.length) {
      const outcome = await judgeCommit(this.db, { kind: 'reapplied', units: done }, null);
      if (outcome === 'not-committed') throw new PurposeGateClosed('PurposeReapplyNotCommitted');
      if (outcome === 'unknown') throw new PurposeGateClosed('PurposeReapplyUnconfirmed');
    }
    if (adopted) {
      const [anchor] = await this.db.$queryRaw<any[]>`SELECT initialized FROM "PurposeLedgerAnchor" WHERE id = 1`;
      if (anchor?.initialized !== true) throw new PurposeGateClosed('PurposeAdoptionNotCommitted');
    }
    if (answer) throw answer;
    // The mirror stood in for a lost or damaged ledger file and passed everything the file would have had to: it takes
    // the file's place now, and not before (a closed gate leaves the file as it found it).
    if (this.ledger.standingIn) this.restoredFrom = this.ledger.restoreFromMirror();
    return result!;
  }
}

// What the server's own sweep may leave without that being anything but a normal open unit (a hold, a delivery still
// in flight, nothing left): the classification main.ts used before the gate was composed.
const SERVER_SETTLED: readonly DestructionOutcome['outcome'][] = ['destroyed', 'reapplied', 'absent', 'held', 'delivery-pending'];

/**
 * The draft purpose unit in the server's retention gate (retention-gate.ts). `service` builds the one disposal service
 * when the gate opens this adapter, so a missing or backed-up ledger directory is this adapter's closure, named as such.
 * open = openGate (match, re-apply, judge); afterOpen = the server's sweep of ended works.
 */
export function draftPurposeAdapter(service: () => DraftPurposeDisposal): RetentionAdapter {
  let built: DraftPurposeDisposal | null = null;
  const get = () => built ??= service();
  return {
    name: 'draft-purpose',
    open: async () => {
      const opened = await get().openGate();
      const restored = get().restoredFrom;
      return `${opened.reapplied} re-applied, ${opened.resolved} unfinished attempts closed` +
        (restored ? `; ledger file restored from the mirror (${restored})` : '');
    },
    afterOpen: async () => ({ unsettled: (await get().sweep()).filter(r => !SERVER_SETTLED.includes(r.outcome)).length }),
  };
}

let configured: DraftPurposeDisposal | null = null;
/** Server startup composes the one disposal service; product code reads it (null when a process composed none). */
export function configureDraftPurpose(service: DraftPurposeDisposal): DraftPurposeDisposal {
  if (configured) throw new Error('DraftPurposeAlreadyConfigured');
  configured = service; return service;
}
export function draftPurpose(): DraftPurposeDisposal | null { return configured; }

/**
 * The ledger directory: the deployment's own, outside every backup. There is no fallback - a ledger inside the backed-up
 * EMR state would come back with an older database and prove nothing - so a missing or contained directory refuses.
 */
export function purposeLedgerDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return ledgerDirectory(env.KIN_PURPOSE_LEDGER_DIR, env.KIN_EMR_STATE_DIR, code => { throw new PurposeGateClosed('PurposeLedger' + code); });
}

/** The ledger's mirror directory (KIN_LEDGER_MIRROR_DIR), or none; refused under the same codes' prefix. */
export function purposeLedgerMirrorDirectory(env: NodeJS.ProcessEnv = process.env, directory = purposeLedgerDirectory(env)): string | null {
  return ledgerMirrorDirectory(env.KIN_LEDGER_MIRROR_DIR, directory, env.KIN_EMR_STATE_DIR,
    code => { throw new PurposeGateClosed('PurposeLedger' + code); });
}

/** A new opaque unit for a new work. */
export function newWorkUnit(): string { return 'disposal:' + randomUUID(); }

/**
 * C5: the operator's one preparation of a server that already has drafts, run before the P migration (its own command,
 * draft-purpose-prepare). It records only that this directory was prepared before the migration: the first gate
 * consumes it once (I2). It refuses, writing nothing, when the directory is not the deployment's own (P1), a ledger
 * (P2) or an adoption record (P3) is already there, the database already has the P migration (P4), or the database
 * cannot be read (P5). No flag or declaration can make a prepared record later.
 */
export async function prepareLedgerAdoption(db: any, env: NodeJS.ProcessEnv = process.env): Promise<Adoption> {
  const ledger = new PurposeLedgerFile(purposeLedgerDirectory(env), nodeLedgerIo, purposeLedgerMirrorDirectory(env));
  // A ledger in the mirror is a ledger too: the gate would read it for the missing file.
  if (fs.existsSync(ledger.file) || (ledger.mirror && fs.existsSync(ledger.mirror))) throw new PurposeGateClosed('PurposeAdoptionLedgerExists');
  if (fs.existsSync(ledger.adoptionFile)) throw new PurposeGateClosed('PurposeAdoptionExists');
  let tables: any;
  try {
    [tables] = await db.$queryRaw`SELECT to_regclass('public."PurposeLedgerAnchor"')::text AS anchor,
      to_regclass('public."ReportDraftPurposeEnd"')::text AS ended`;
  } catch { throw new PurposeGateClosed('PurposeAdoptionDatabaseUnavailable'); }
  if (!tables) throw new PurposeGateClosed('PurposeAdoptionDatabaseUnavailable');
  if (tables.anchor || tables.ended) throw new PurposeGateClosed('PurposeAdoptionAfterMigration');
  ledger.prepareAdoption();
  return ledger.readAdoption()!;
}
