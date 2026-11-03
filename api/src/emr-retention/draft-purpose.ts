import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { resolveStoredRecord } from '../emr-contract/classification';
import { emrAdapters } from '../emr-contract/composition';
import { DestructionReceipt, DestructionRecord, PurposeDisposalStore, destroyAtPurposeEnd, newPurposeRecord, reloadPurposeRecord,
  resolvePurposeEnd } from '../emr-contract/lawful-defaults';
import { ContractError, refuse, string } from '../emr-contract/validation';
import { snapshotFromRows, transactionScope, withSnapshot } from '../emr-runtime/context';
import type { ClauseRow, HoldRow, RequestRow } from '../emr-runtime/contract';
import { syncDirectory } from '../emr-runtime/journal-file';

/*
 * CD-09-P: the end of a private draft work's purpose and the destruction of its content.
 *
 * The transaction that ends the work (the author's discard, or the signed result made from it) moves the exact payload
 * into ReportDraftPurposeEnd and empties the author's row. Destruction is a second transaction: it re-reads the holds on
 * that draft, lets A decide (destroyAtPurposeEnd), deletes the row, and records started/completed in an append-only ledger
 * that lives outside every database backup. The ledger names only an opaque disposal unit; the database row is the one
 * mapping from that unit to (uid, author), and it is deleted with the content.
 *
 * A restored older database brings back rows the ledger already destroyed. The startup gate (openPurposeGate) runs before
 * the server accepts a request: it re-applies every completed unit the restored copy still holds, and stays closed when it
 * cannot tell what happened (no ledger beside a copy that saw one, another ledger, a shorter ledger, an intent with no end).
 */

export const PURPOSE_LEDGER_FILE = 'purpose-ledger.jsonl';
const LINE_MAX = 4096;
// One writer at a time across the API and the sweep process: every ledger append and every destruction or re-application
// runs under this transaction lock, so the ledger order is the commit order.
const LEDGER_LOCK = 0x4b494e50; // 'KINP'
const UNIT = /^disposal:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEOUL_MS = 9 * 3600_000;
const RECORD_KEYS = ['formatVersion', 'phase', 'day', 'disposalUnitId', 'classes', 'clauseIds', 'partCount', 'expiryDay',
  'extensionUsed', 'dueDay', 'timeliness', 'method', 'basis'];

export class PurposeGateClosed extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PurposeGateClosed'; }
}

export interface LedgerEntry { seq: number; appendedAt: string; record: Readonly<DestructionRecord> }
export interface LedgerView { ledgerId: string; entries: readonly LedgerEntry[] }

function exactKeys(value: any, keys: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function parseRecord(value: any): Readonly<DestructionRecord> {
  // A closed field set: nothing but the disposal unit and the destruction facts can be read back from (or written to) a line.
  if (!exactKeys(value, RECORD_KEYS) || value.formatVersion !== 1 || !['started', 'completed', 'failed'].includes(value.phase) ||
      typeof value.disposalUnitId !== 'string' || !UNIT.test(value.disposalUnitId) || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.dueDay) || !['within-five-days', 'overdue'].includes(value.timeliness))
    refuse('PurposeLedgerRecordInvalid');
  return Object.freeze(value);
}

/** The append-only destruction ledger: one JSON line per record, fsync before a record counts. Created by its first
 * append with the ledger ID the database's anchor names. A partial last line is never repaired here. */
export class PurposeLedgerFile {
  readonly file: string;
  constructor(readonly directory: string) {
    if (!directory || !path.isAbsolute(directory)) throw new PurposeGateClosed('PurposeLedgerDirectoryRequired');
    this.file = path.join(directory, PURPOSE_LEDGER_FILE);
  }
  read(): LedgerView | null {
    if (!fs.existsSync(this.file)) return null;
    const bytes = fs.readFileSync(this.file);
    if (!bytes.length || bytes[bytes.length - 1] !== 10) refuse('PurposeLedgerPartialTail');
    const lines = bytes.toString('utf8').split('\n');
    lines.pop();
    let header: any;
    try { header = JSON.parse(lines[0]); } catch { refuse('PurposeLedgerHeaderInvalid'); }
    if (!exactKeys(header, ['kind', 'formatVersion', 'ledgerId', 'createdAt']) || header.kind !== 'header' ||
        header.formatVersion !== 1 || typeof header.ledgerId !== 'string') refuse('PurposeLedgerHeaderInvalid');
    const entries = lines.slice(1).map((line, index) => {
      if (Buffer.byteLength(line) > LINE_MAX) refuse('PurposeLedgerRecordInvalid');
      let entry: any;
      try { entry = JSON.parse(line); } catch { refuse('PurposeLedgerRecordInvalid'); }
      if (!exactKeys(entry, ['kind', 'seq', 'ledgerId', 'appendedAt', 'record']) || entry.kind !== 'entry' ||
          entry.seq !== index + 1 || entry.ledgerId !== header.ledgerId || typeof entry.appendedAt !== 'string')
        refuse('PurposeLedgerRecordInvalid');
      return Object.freeze({ seq: entry.seq, appendedAt: entry.appendedAt, record: parseRecord(entry.record) });
    });
    return Object.freeze({ ledgerId: header.ledgerId, entries: Object.freeze(entries) });
  }
  append(ledgerId: string, record: DestructionRecord): { seq: number; durableAt: string } {
    const parsed = parseRecord(JSON.parse(JSON.stringify(record)));
    const current = this.read();
    if (current && current.ledgerId !== ledgerId) refuse('PurposeLedgerMismatch');
    const lines: string[] = [];
    if (!current) {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      lines.push(JSON.stringify({ kind: 'header', formatVersion: 1, ledgerId, createdAt: new Date().toISOString() }));
    }
    const seq = (current?.entries.length ?? 0) + 1;
    lines.push(JSON.stringify({ kind: 'entry', seq, ledgerId, appendedAt: new Date().toISOString(), record: parsed }));
    const bytes = Buffer.from(lines.map(line => line + '\n').join(''));
    const fd = fs.openSync(this.file, 'a', 0o600);
    try {
      let written = 0;
      while (written < bytes.length) {
        const n = fs.writeSync(fd, bytes, written, bytes.length - written);
        if (!n) refuse('PurposeLedgerWriteFailed');
        written += n;
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (!current) syncDirectory(this.directory);
    return { seq, durableAt: new Date().toISOString() };
  }
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
    const settled = new Promise<void>(resolve => {
      const done = () => {
        response.off('finish', done); response.off('close', done); response.off('error', done);
        request.off('aborted', done);
        resolve();
      };
      response.once('finish', done); response.once('close', done); response.once('error', done);
      request.once('aborted', done);
      if (response.writableFinished || response.destroyed) done();
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
      // The row and ledger locks are the caller's transaction's; A re-reads the same facts under them.
      withPurposeLock: async (_recordId, _at, work) => work(reloadPurposeRecord(record)),
    }, record, event, requestedAt, () => destroy());
  });
}

// ── destruction ──

export type DestructionOutcome =
  | { unit: string; outcome: 'destroyed'; seq: number }
  | { unit: string; outcome: 'reapplied' }
  | { unit: string; outcome: 'absent' }
  | { unit: string; outcome: 'delivery-pending' }
  | { unit: string; outcome: 'held'; code: string }
  | { unit: string; outcome: 'refused'; code: string };
const HELD = new Set(['LegalHoldActive', 'HoldReleaseRequired']);

function seoulDay(at: string) { return new Date(Date.parse(at) + SEOUL_MS).toISOString().slice(0, 10); }

async function anchorOf(tx: Tx): Promise<{ ledgerId: string; seq: number }> {
  const rows = await tx.$queryRaw`SELECT "ledgerId"::text AS "ledgerId", seq FROM "PurposeLedgerAnchor" WHERE id = 1 FOR UPDATE`;
  if (rows.length !== 1) throw new PurposeGateClosed('PurposeLedgerAnchorMissing');
  return { ledgerId: rows[0].ledgerId, seq: rows[0].seq };
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

export class DraftPurposeDisposal {
  private readonly inflight = new Set<Promise<unknown>>();
  constructor(private readonly db: PrismaClient, readonly ledger: PurposeLedgerFile,
    private readonly deliveries: DraftDeliveries = draftDeliveries, private readonly now: () => Date = () => new Date()) {}

  /** After the ending transaction committed (API process): settle this author's deliveries, then destroy. Failures leave
   * the row pending for the sweep; they never undo the end. */
  scheduleDestruction(unit: string, author: string): void {
    const job = (async () => {
      await this.deliveries.settled(author);
      await this.db.$executeRaw`UPDATE "ReportDraftPurposeEnd" SET "deliverySettled" = true WHERE "disposalUnitId" = ${unit}`;
      const result = await this.destroy(unit);
      if (result.outcome === 'refused') console.error(`[CD-09-P] Destruction of ${unit} refused: ${result.code}`);
      return result;
    })().catch(error => { console.error('[CD-09-P] Destruction attempt failed:', error?.code ?? error?.name ?? 'error'); });
    this.inflight.add(job);
    void job.finally(() => this.inflight.delete(job));
  }
  async drained(): Promise<void> { await Promise.allSettled([...this.inflight]); }

  /** One unit, one transaction: ledger lock → row lock → A's decision → started, delete, completed → anchor. */
  async destroy(unit: string): Promise<DestructionOutcome> {
    return this.db.$transaction(async (tx: Tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK})`;
      const [row] = await tx.$queryRaw`SELECT * FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId" = ${unit} FOR UPDATE`;
      if (!row) return { unit, outcome: 'absent' as const };
      const anchor = await anchorOf(tx);
      const view = this.ledger.read();
      if (view && view.ledgerId !== anchor.ledgerId) refuse('PurposeLedgerMismatch');
      const phases = unitPhases(view).get(unit);
      if (completed(phases)) {
        await reapply(tx, unit);
        return { unit, outcome: 'reapplied' as const };
      }
      if (!row.deliverySettled) return { unit, outcome: 'delivery-pending' as const };
      if (dangling(phases)) {
        // A started record whose transaction did not commit: the row is still here, so the attempt failed. Close it
        // with its own facts before a new attempt; the ledger never shows two open attempts for one unit.
        const started = phases![phases!.length - 1].record, at = this.now().toISOString();
        this.ledger.append(anchor.ledgerId, { ...started, phase: 'failed', day: seoulDay(at),
          timeliness: seoulDay(at) <= started.dueDay ? 'within-five-days' : 'overdue' });
      }
      const requestedAt = this.now().toISOString();
      const facts = await readPurposeFacts(tx, row);
      let lastSeq = 0;
      try {
        await tx.$executeRaw`UPDATE "ReportDraftPurposeEnd" SET attempts = attempts + 1 WHERE "disposalUnitId" = ${unit}`;
        await decidePurposeEnd({ append: async event => {
          const appended = this.ledger.append(anchor.ledgerId, event);
          lastSeq = appended.seq;
          return { durableAt: appended.durableAt };
        } }, row, facts, requestedAt, async () => {
          const deleted = await tx.$executeRaw`DELETE FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId" = ${unit}`;
          if (deleted !== 1) refuse('PurposeRowChanged');
          return { completedAt: this.now().toISOString(), method: 'irreversible-permanent-deletion' };
        });
      } catch (error) {
        // Once the ledger holds this attempt (started, and failed or not), the transaction must not commit a delete
        // the ledger does not complete: roll back and let the caller report it.
        if (!(error instanceof ContractError) || lastSeq) throw error;
        // A refusal before any record or delete: the payload stays and the refusal is noted for the sweep and operator.
        return { unit, outcome: HELD.has(error.code) ? 'held' as const : 'refused' as const, code: error.code };
      }
      await tx.$executeRaw`UPDATE "PurposeLedgerAnchor" SET seq = ${lastSeq} WHERE id = 1`;
      return { unit, outcome: 'destroyed' as const, seq: lastSeq };
    }, { maxWait: 10000, timeout: 30000 }).then(async (result: DestructionOutcome) => {
      if (result.outcome === 'held' || result.outcome === 'refused')
        await this.db.$executeRaw`UPDATE "ReportDraftPurposeEnd" SET "lastRefusal" = ${result.code} WHERE "disposalUnitId" = ${unit}`;
      return result;
    }, async (error: any) => {
      const code = error instanceof ContractError ? error.code : error?.code ?? error?.name ?? 'Error';
      await this.db.$executeRaw`UPDATE "ReportDraftPurposeEnd" SET "lastRefusal" = ${String(code)} WHERE "disposalUnitId" = ${unit}`
        .catch(() => undefined);
      throw error;
    });
  }

  /** The daily recovery and the post-release resume: every ended work whose deliveries have settled. */
  async sweep(): Promise<readonly DestructionOutcome[]> {
    // A database the ledger cannot be matched with is not swept: that is the startup gate's refusal, not a unit's.
    await this.db.$transaction(async (tx: Tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK})`;
      await this.matchedLedger(tx);
    });
    const rows: { disposalUnitId: string }[] = await this.db.$queryRaw`SELECT "disposalUnitId" FROM "ReportDraftPurposeEnd"
      WHERE "deliverySettled" ORDER BY "endedAt", "disposalUnitId"`;
    const results: DestructionOutcome[] = [];
    for (const { disposalUnitId } of rows) {
      try { results.push(await this.destroy(disposalUnitId)); }
      catch (error: any) { results.push({ unit: disposalUnitId, outcome: 'refused', code: error?.code ?? error?.name ?? 'Error' }); }
    }
    return results;
  }

  /**
   * Before the server accepts a request. Re-applies every completed unit this database still holds and refuses to open
   * when the database and the ledger cannot be matched. Returns what it re-applied; never appends a completion.
   */
  /** The database and the ledger belong together: same ledger ID, and the ledger at least as long as the database saw. */
  private async matchedLedger(tx: Tx): Promise<{ anchor: { ledgerId: string; seq: number }; view: LedgerView | null }> {
    const anchor = await anchorOf(tx);
    let view: LedgerView | null;
    try { view = this.ledger.read(); }
    catch (error) { throw new PurposeGateClosed(error instanceof ContractError ? error.code : 'PurposeLedgerUnreadable'); }
    if (!view) {
      if (anchor.seq > 0) throw new PurposeGateClosed('PurposeLedgerMissing');
      return { anchor, view };
    }
    if (view.ledgerId !== anchor.ledgerId) throw new PurposeGateClosed('PurposeLedgerMismatch');
    if (view.entries.length < anchor.seq) throw new PurposeGateClosed('PurposeLedgerBehind');
    return { anchor, view };
  }

  async openGate(): Promise<{ reapplied: number; units: number; resolved: number }> {
    return this.db.$transaction(async (tx: Tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK})`;
      const { anchor, view } = await this.matchedLedger(tx);
      if (!view) {
        await tx.$executeRaw`UPDATE "ReportDraftPurposeEnd" SET "deliverySettled" = true WHERE NOT "deliverySettled"`;
        return { reapplied: 0, units: 0, resolved: 0 };
      }
      const units = unitPhases(view);
      let reapplied = 0, resolved = 0;
      for (const [unit, phases] of units) {
        if (completed(phases)) { if (await reapply(tx, unit)) reapplied++; continue; }
        if (!dangling(phases)) continue;
        // An attempt with no end. Only an ended row still present here proves it did not commit; anything else (a live
        // work of an older copy, or nothing) cannot be settled from this copy.
        const [row] = await tx.$queryRaw`SELECT 1 AS present FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId" = ${unit}`;
        if (!row) throw new PurposeGateClosed('PurposeIntentIncomplete');
        const started = phases[phases.length - 1].record, at = this.now().toISOString();
        this.ledger.append(anchor.ledgerId, { ...started, phase: 'failed', day: seoulDay(at),
          timeliness: seoulDay(at) <= started.dueDay ? 'within-five-days' : 'overdue' });
        resolved++;
      }
      // This process starts with no response in flight: whatever an earlier process was sending has ended.
      await tx.$executeRaw`UPDATE "ReportDraftPurposeEnd" SET "deliverySettled" = true WHERE NOT "deliverySettled"`;
      return { reapplied, units: units.size, resolved };
    }, { maxWait: 10000, timeout: 60000 });
  }
}

let configured: DraftPurposeDisposal | null = null;
/** Server startup composes the one disposal service; product code reads it (null when a process composed none). */
export function configureDraftPurpose(service: DraftPurposeDisposal): DraftPurposeDisposal {
  if (configured) throw new Error('DraftPurposeAlreadyConfigured');
  configured = service; return service;
}
export function draftPurpose(): DraftPurposeDisposal | null { return configured; }

/** The ledger directory: the deployment's own volume outside every backup, else beside the EMR state (tests, old hosts). */
export function purposeLedgerDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KIN_PURPOSE_LEDGER_DIR) return env.KIN_PURPOSE_LEDGER_DIR;
  if (!env.KIN_EMR_STATE_DIR) throw new PurposeGateClosed('PurposeLedgerDirectoryRequired');
  return path.join(env.KIN_EMR_STATE_DIR, 'purpose-ledger');
}

/** A new opaque unit for a new work. */
export function newWorkUnit(): string { return 'disposal:' + randomUUID(); }
