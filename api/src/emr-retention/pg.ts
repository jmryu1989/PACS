import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  BatchDisposalAuditStore, DestructionReceipt, DestructionRecord, DisposalRequest, RetentionGraph, RetentionRecord,
  completedFromStarted, failedFromStarted, retentionState,
} from '../emr-contract/lawful-defaults';
import { freeze, refuse } from '../emr-contract/validation';
import { ReportVersionRow, SignedVersionRow, reportRetentionRecord, withStoredHolds } from './report-source';
import { DraftCheck, HPorts, InventoryUnit, ReconcileResult, refusalCode, sweepLedgerExpiry } from './worker';

/** PG rows of one execution, child first: the deletion function accepts only these closed-list tables. */
interface Target { schema: string; table: string; key: Record<string, string | number> }
interface UnitPlan { recordId: string; disposalUnitId: string; eligibleAt: string; targets: Target[] }
const iso = (value: Date | string) => new Date(value).toISOString();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CHUNK = 200;

/**
 * H's PostgreSQL adapter for the native report units (slice CD-09a). One dedicated connection (connection_limit=1 in the
 * entry) carries H's session record locks between the separately committed journal, execution and deletion steps.
 * Every read failure throws: an unreadable store is never an empty inventory.
 */
export class PgRetention {
  private plans = new Map<string, UnitPlan>();
  private revision = '';
  private execution: { operationId: string; disposalUnitIds: readonly string[]; recordIds: readonly string[] } | null = null;
  private offset = 0;
  constructor(private readonly db: PrismaClient) {}

  async clock(): Promise<string> {
    const [row] = await this.db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    this.offset = new Date(row.now).getTime() - Date.now();
    return iso(row.now);
  }

  /** Builds every report unit of these study UIDs from the stored rows, judged at `at`, with the stable unit IDs. */
  private async units(uids: readonly string[], at: string): Promise<{ units: InventoryUnit[]; plans: UnitPlan[]; raw: unknown[] }> {
    const ids = [...uids];
    const versions = await this.db.$queryRaw<any[]>`SELECT id, uid, version, action, findings, conclusion, recommendation, reason,
      citations::text AS citations, structured::text AS structured FROM "ReportVersion" WHERE uid = ANY(${ids}::text[]) ORDER BY uid, version`;
    const signed = await this.db.$queryRaw<any[]>`SELECT record_id, version_id, outcome::text AS outcome
      FROM emr_signing.signed_version WHERE record_id = ANY(${ids}::text[]) ORDER BY record_id, version_id`;
    const operations = await this.db.$queryRaw<{ operation_id: string; record_id: string }[]>`SELECT operation_id, outcome ->> 'recordId' AS record_id
      FROM emr_signing.operation WHERE outcome ->> 'recordId' = ANY(${ids}::text[]) ORDER BY operation_id`;
    const heads = await this.db.$queryRaw<{ uid: string }[]>`SELECT uid FROM "Report" WHERE uid = ANY(${ids}::text[])`;
    const pinned = await this.db.$queryRaw<{ uid: string }[]>`SELECT DISTINCT "studyUid" AS uid FROM "CriticalResult" WHERE "studyUid" = ANY(${ids}::text[])`;
    const holds = await this.db.$queryRaw<{ record_id: string; hold_id: string; phase: string }[]>`SELECT record_id, hold_id, phase
      FROM emr_access.legal_hold_event WHERE record_id = ANY(${ids}::text[]) ORDER BY hold_id, phase`;
    const duties = await this.db.$queryRaw<{ body: string }[]>`SELECT d.body FROM emr_access.duty_request_event d WHERE d.phase = 'received'
      AND NOT EXISTS (SELECT FROM emr_access.duty_request_event x WHERE x.kind = d.kind AND x.request_id = d.request_id AND x.phase = 'resolved')`;
    const mapping = await this.db.$queryRaw<{ record_id: string; disposal_unit_id: string }[]>`SELECT record_id, disposal_unit_id
      FROM emr_access.register_retention_units('report', ${ids}::text[])`;
    const dutyRecords = new Set(duties.flatMap(d => { const ids = JSON.parse(d.body)?.recordIds; return Array.isArray(ids) ? ids : []; }));
    const units: InventoryUnit[] = [], plans: UnitPlan[] = [], raw: unknown[] = [];
    for (const uid of ids) {
      const disposalUnitId = mapping.find(m => m.record_id === uid)?.disposal_unit_id;
      if (!disposalUnitId) refuse('RetentionUnitMappingRequired');
      const rows: ReportVersionRow[] = versions.filter(v => v.uid === uid).map(v => ({ id: v.id, uid, version: v.version, action: v.action,
        findings: v.findings, conclusion: v.conclusion, recommendation: v.recommendation, reason: v.reason, citations: v.citations, structured: v.structured }));
      const sigs: SignedVersionRow[] = signed.filter(s => s.record_id === uid).map(s => ({ recordId: uid, versionId: s.version_id, outcome: JSON.parse(s.outcome) }));
      const unitHolds = holds.filter(h => h.record_id === uid), ops = operations.filter(o => o.record_id === uid);
      raw.push({ uid, rows, sigs, ops, head: heads.some(h => h.uid === uid), pinned: pinned.some(p => p.uid === uid), unitHolds, duty: dutyRecords.has(uid) });
      const unit = (status: InventoryUnit['status'], reason: string | null, record: Readonly<RetentionRecord> | null = null) =>
        units.push(freeze({ recordId: uid, disposalUnitId, status, reason, record }));
      // A CVR pins its report version (FK Restrict); no CVR adapter exists in this slice, so the unit is not judged here.
      if (pinned.some(p => p.uid === uid)) { unit('unsupported', 'critical-result-pins-report'); continue; }
      const active = unitHolds.filter(h => h.phase === 'placed' && !unitHolds.some(r => r.hold_id === h.hold_id && r.phase === 'released'));
      if (active.length) { unit('held', 'legal-hold'); continue; }
      // A released hold moves the earliest destruction to its release; reading its basis is not part of this slice.
      if (unitHolds.length) { unit('unsupported', 'released-hold-history'); continue; }
      if (dutyRecords.has(uid)) { unit('held', 'open-duty-request'); continue; }
      const built = reportRetentionRecord(uid, rows, sigs, disposalUnitId);
      if (built.status !== 'built') { unit('unsupported', built.reason); continue; }
      const graph: RetentionGraph = { records: [built.record], references: [], complete: true, revision: 'unit', checkedAt: at };
      const state = retentionState(built.record, graph, at);
      if (state.destroyNotBefore === null) { unit('held', 'retention-state-held'); continue; }
      if (state.destroyNotBefore > at) { unit('retained', null); continue; }
      unit('due', null, built.record);
      plans.push({ recordId: uid, disposalUnitId, eligibleAt: state.destroyNotBefore, targets: [
        ...sigs.map(s => ({ schema: 'emr_signing', table: 'signed_version', key: { record_id: uid, version_id: s.versionId } })),
        ...ops.map(o => ({ schema: 'emr_signing', table: 'operation', key: { operation_id: o.operation_id } })),
        ...rows.map(r => ({ schema: 'public', table: 'ReportVersion', key: { id: r.id } })),
        ...(heads.some(h => h.uid === uid) ? [{ schema: 'public', table: 'Report', key: { uid } }] : []),
      ] });
    }
    return { units, plans, raw };
  }

  async inventory(at: string) {
    const uids = (await this.db.$queryRaw<{ uid: string }[]>`SELECT DISTINCT uid FROM "ReportVersion" ORDER BY uid`).map(r => r.uid);
    const units: InventoryUnit[] = [];
    for (let i = 0; i < uids.length; i += CHUNK) units.push(...(await this.units(uids.slice(i, i + CHUNK), at)).units);
    const uncovered = (await this.db.$queryRaw<{ name: string }[]>`SELECT name FROM emr_access.retention_uncovered() AS name`).map(r => r.name);
    const [drafts] = await this.db.$queryRaw<any[]>`SELECT count(*) FILTER (WHERE present)::int AS live,
      count(*) FILTER (WHERE NOT present AND findings = '' AND conclusion = '' AND recommendation = '' AND citations IS NULL AND structured IS NULL)::int AS cleared,
      count(*) FILTER (WHERE NOT present AND (findings <> '' OR conclusion <> '' OR recommendation <> '' OR citations IS NOT NULL OR structured IS NOT NULL))::int AS inconsistent
      FROM "ReportDraft"`;
    return { units, uncovered, drafts: drafts as DraftCheck };
  }

  /** The due units' graph, re-read from storage; A compares it with the one read again under the lock. */
  async graphFor(recordIds: readonly string[], at: string): Promise<RetentionGraph> {
    const { units, plans, raw } = await this.units(recordIds, at);
    if (units.some(u => u.status !== 'due')) refuse('ReferenceSnapshotStale');
    this.plans = new Map(plans.map(p => [p.disposalUnitId, p]));
    this.revision = 'report:' + digest(raw);
    return freeze({ records: units.map(u => u.record!), references: [], complete: true as const, revision: this.revision, checkedAt: at });
  }

  /** The A batch store. Session record locks are held from the re-read through completion of every set. */
  store(): BatchDisposalAuditStore {
    return {
      withRetentionBatchLock: async (recordIds, at, work) => {
        for (const id of [...recordIds].sort())
          await this.db.$queryRaw`SELECT pg_advisory_lock(hashtextextended(${JSON.stringify(['emr-fixed-record', id])}, 0))::text`;
        try {
          const current = await this.graphFor(recordIds, at);
          const rows = await this.db.$queryRaw<{ record_id: string; hold_id: string; phase: 'placed' | 'released'; body: string }[]>`
            SELECT record_id, hold_id, phase, body FROM emr_access.legal_hold_event WHERE record_id = ANY(${[...recordIds]}::text[]) ORDER BY hold_id, phase`;
          const holds = new Map(recordIds.map(id => [id, rows.filter(r => r.record_id === id).map(r => ({ holdId: r.hold_id, phase: r.phase, body: r.body }))]));
          return await withStoredHolds(holds, () => work(current));
        } finally { this.execution = null; await this.db.$queryRaw`SELECT pg_advisory_unlock_all()::text`; }
      },
      now: () => new Date(Date.now() + this.offset).toISOString(),
      beginSet: async disposalUnitIds => {
        const plans = disposalUnitIds.map(id => this.plans.get(id));
        if (plans.some(p => !p) || new Set(disposalUnitIds).size !== disposalUnitIds.length) refuse('ErasurePlanRequired');
        const operationId = randomUUID(), fixed = plans as UnitPlan[];
        const eligible = fixed.map(p => p.eligibleAt).sort().slice(-1)[0];
        await this.db.$queryRaw`SELECT emr_access.begin_retention_execution(${operationId}::uuid, ${fixed.map(p => p.disposalUnitId)}::text[],
          ${fixed.map(p => p.recordId)}::text[], ${eligible}::timestamptz, ${this.revision}, ${JSON.stringify(fixed.flatMap(p => p.targets))}::jsonb)::text`;
        this.execution = { operationId, disposalUnitIds: [...disposalUnitIds], recordIds: fixed.map(p => p.recordId) };
        return { operationId };
      },
      append: event => this.append(event),
      appendCompletedSet: events => this.appendCompletedSet(events),
    };
  }

  private async append(event: Readonly<DestructionRecord>): Promise<{ durableAt: string }> {
    const [row] = await this.db.$queryRaw<{ recorded_at: Date }[]>`INSERT INTO emr_access.retention_journal
      (operation_id, kind, phase, revision, disposal_unit_id, occurred_at, body)
      VALUES (${event.operationId}::uuid, ${event.kind}, ${event.phase}, ${event.revision}, ${event.disposalUnitId},
        ${event.occurredAt}::timestamptz, ${JSON.stringify(event)}::jsonb) RETURNING recorded_at`;
    return { durableAt: iso(row.recorded_at) };
  }

  /** Every completion of one execution in one transaction: a partial completion set is never durable. */
  private async appendCompletedSet(events: readonly Readonly<DestructionRecord>[]): Promise<{ durableAt: string }> {
    if (!events.length || events.some(e => e.phase !== 'completed' || e.operationId !== events[0].operationId)) refuse('CompletedSetInvalid');
    const times = await this.db.$transaction(async tx => {
      const out: Date[] = [];
      for (const event of events) {
        const [row] = await tx.$queryRaw<{ recorded_at: Date }[]>`INSERT INTO emr_access.retention_journal
          (operation_id, kind, phase, revision, disposal_unit_id, occurred_at, body)
          VALUES (${event.operationId}::uuid, ${event.kind}, ${event.phase}, ${event.revision}, ${event.disposalUnitId},
            ${event.occurredAt}::timestamptz, ${JSON.stringify(event)}::jsonb) RETURNING recorded_at`;
        out.push(row.recorded_at);
      }
      return out;
    });
    return { durableAt: times.map(iso).sort().slice(-1)[0] };
  }

  /** destroySet for one SCC: the PG step of exactly the bound execution, then its durable confirmation as completedAt. */
  async destroySet(requests: readonly Readonly<DisposalRequest>[]): Promise<DestructionReceipt> {
    const e = this.execution;
    const units = requests.map(r => r.record.disposalUnitId);
    if (!e || JSON.stringify([...units].sort()) !== JSON.stringify([...e.disposalUnitIds].sort())) refuse('ErasurePlanRequired');
    const completedAt = await this.deleteAndConfirm(e.operationId);
    return freeze({ formatVersion: 2 as const, kind: 'operational-deletion' as const, method: 'operational-store-deletion' as const,
      operationId: e.operationId, disposalUnitIds: [...e.disposalUnitIds], completedAt });
  }

  private async deleteAndConfirm(operationId: string): Promise<string> {
    await this.db.$queryRaw`SELECT emr_access.delete_operational_rows(${operationId}::uuid)::text`;
    const [row] = await this.db.$queryRaw<{ at: Date }[]>`SELECT emr_access.confirm_operational_commit(${operationId}::uuid) AS at`;
    return iso(row.at);
  }

  /**
   * Before any new judgement: an execution with a durable started journal is resumed to completion (or recorded failed
   * and left fenced); one without was never started and is released; a committed deletion whose completion write was
   * lost gets its completion from the started records at the first durable confirmation. Nothing here re-decides expiry.
   */
  async reconcile(): Promise<ReconcileResult> {
    const result = { resumed: 0, abandoned: 0, unfinished: 0, failures: [] as string[] };
    const live = await this.db.$queryRaw<{ operation_id: string; units: string[] }[]>`SELECT operation_id::text, disposal_unit_ids AS units
      FROM emr_access.retention_execution ORDER BY started_at, operation_id`;
    for (const { operation_id: op, units } of live) {
      const started = await this.started(op);
      if (started.length < units.length) {
        const [row] = await this.db.$queryRaw<{ released: boolean }[]>`SELECT emr_access.abandon_retention_execution(${op}::uuid) AS released`;
        if (!row.released) refuse('RetentionReconcileConflict');
        // Nothing was deleted; the started records it did write end as failed, and the units are judged afresh.
        const at = new Date(Date.now() + this.offset).toISOString();
        for (const event of started) await this.append(failedFromStarted(event, at));
        result.abandoned++; continue;
      }
      try {
        await this.completeFromStarted(op, started, await this.deleteAndConfirm(op));
        result.resumed++;
      } catch (error) {
        const at = new Date(Date.now() + this.offset).toISOString();
        for (const event of started) await this.append(failedFromStarted(event, at));
        result.unfinished++; result.failures.push(refusalCode(error));
        // The same failed set is retried on the next run; no later set starts before it completes.
        return result;
      }
    }
    const lost = await this.db.$queryRaw<{ operation_id: string }[]>`SELECT c.operation_id::text FROM emr_access.retention_commit c
      WHERE EXISTS (SELECT FROM emr_access.retention_journal j WHERE j.operation_id = c.operation_id AND j.phase = 'started')
        AND EXISTS (SELECT FROM unnest(c.disposal_unit_ids) u WHERE NOT EXISTS (SELECT FROM emr_access.retention_journal j
          WHERE j.operation_id = c.operation_id AND j.disposal_unit_id = u AND j.phase = 'completed'))
      ORDER BY c.deleted_at, c.operation_id`;
    for (const { operation_id: op } of lost) {
      const [row] = await this.db.$queryRaw<{ at: Date }[]>`SELECT emr_access.confirm_operational_commit(${op}::uuid) AS at`;
      await this.completeFromStarted(op, await this.started(op), iso(row.at));
      result.resumed++;
    }
    return result;
  }

  private async started(operationId: string): Promise<DestructionRecord[]> {
    const rows = await this.db.$queryRaw<{ body: string }[]>`SELECT DISTINCT ON (disposal_unit_id) body::text AS body FROM emr_access.retention_journal
      WHERE operation_id = ${operationId}::uuid AND kind = 'operational-deletion' AND phase = 'started' ORDER BY disposal_unit_id, sequence`;
    return rows.map(r => JSON.parse(r.body));
  }

  private async completeFromStarted(operationId: string, started: readonly DestructionRecord[], completedAt: string): Promise<void> {
    const done = new Set((await this.db.$queryRaw<{ unit: string }[]>`SELECT disposal_unit_id AS unit FROM emr_access.retention_journal
      WHERE operation_id = ${operationId}::uuid AND kind = 'operational-deletion' AND phase = 'completed'`).map(r => r.unit));
    const missing = started.filter(s => !done.has(s.disposalUnitId)).map(s => completedFromStarted(s, completedAt));
    if (missing.length) await this.appendCompletedSet(missing);
  }

  ports(openPhases: readonly string[]): HPorts {
    return {
      sweepLedger: () => sweepLedgerExpiry(this.db), clock: () => this.clock(), reconcile: () => this.reconcile(),
      inventory: at => this.inventory(at), graphFor: (ids, at) => this.graphFor(ids, at), store: this.store(),
      destroySet: requests => this.destroySet(requests), openPhases,
    };
  }
}
