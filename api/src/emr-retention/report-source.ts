import { createHash } from 'node:crypto';
import { resolveStoredRecord } from '../emr-contract/classification';
import { emrAdapters } from '../emr-contract/composition';
import {
  RetentionGraph, RetentionRecord, newRetentionRecord, parseRetentionRecord, recordVersionAdded, retentionState,
} from '../emr-contract/lawful-defaults';
import { snapshotFromRows, transactionScope, withSnapshot } from '../emr-runtime/context';
import type { HoldRow } from '../emr-runtime/contract';
import { verifyRegisteredServerEnvelope } from '../emr-signature/server-verification';

/** The stored native report rows of one study, read by H under its record lock. */
export interface ReportVersionRow {
  id: number; uid: string; version: number; action: string; findings: string; conclusion: string; recommendation: string;
  reason: string | null; citations: unknown; structured: unknown;
}
/** emr_signing.signed_version: the committed StoredApproval of one report version (native-signing.ts). */
export interface SignedVersionRow { recordId: string; versionId: string; outcome: any }
export type ReportUnitBuild = { status: 'built'; record: Readonly<RetentionRecord> } | { status: 'unsupported'; reason: string };

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A re-reads every member's stored holds under the destruction lock; this runs `work` with the hold rows H read under
 * that same lock as the only legal-reader input (an unread record is refused by the reader, never an empty list). */
export function withStoredHolds<T>(holds: ReadonlyMap<string, readonly HoldRow[]>, work: () => T): T {
  const scope = transactionScope();
  return withSnapshot(scope, snapshotFromRows(scope, { holds, accessRequests: new Map(), correctionRequests: new Map(),
    clauseVersions: new Map(), accessEvents: new Map() }), work);
}
const unsupported = (reason: string): ReportUnitBuild => ({ status: 'unsupported', reason });

/**
 * One study's native report is one A unit (recordId = Study UID, as native-signing.ts signs it): every ReportVersion is a
 * part, started at its own committed server signature. A version without a verifiable signature of exactly that record
 * and version is not a lawful part (A's lawfulPart), so the whole unit is reported unsupported, never shortened to the
 * signed versions or built with a guessed clock. The stable disposal ID comes from H's registration, never a new one.
 */
export function reportRetentionRecord(uid: string, versions: readonly ReportVersionRow[], signed: readonly SignedVersionRow[],
  disposalUnitId: string): ReportUnitBuild {
  if (!versions.length) return unsupported('report-without-version');
  const ordered = [...versions].sort((a, b) => a.version - b.version);
  if (ordered.some(v => v.uid !== uid) || new Set(ordered.map(v => v.version)).size !== ordered.length) return unsupported('report-version-binding');
  if (signed.some(s => s.recordId !== uid || !ordered.some(v => String(v.version) === s.versionId))) return unsupported('signature-without-version');
  const parts: { row: ReportVersionRow; signedAt: string; sha256: string }[] = [];
  for (const row of ordered) {
    const found = signed.filter(s => s.versionId === String(row.version));
    if (found.length !== 1) return unsupported('report-version-unsigned');
    const o = found[0].outcome;
    let verified: ReturnType<typeof verifyRegisteredServerEnvelope>;
    try { verified = verifyRegisteredServerEnvelope(o?.envelope, o?.keyAtSigning); } catch { return unsupported('report-signature-unverifiable'); }
    if (o.recordId !== uid || o.versionId !== String(row.version) || verified.versionSha256 !== o.versionSha256 ||
        verified.signedAt !== o.signedAt || verified.payload.recordId !== uid || verified.payload.versionId !== String(row.version) ||
        verified.payload.recordKind !== 'report-version') return unsupported('report-signature-binding');
    parts.push({ row, signedAt: o.signedAt, sha256: o.versionSha256 });
  }
  const fixedRecords = new Map<string, unknown>();
  let previous: { versionId: string; sha256: string } | null = null;
  for (const { row, signedAt, sha256 } of parts) {
    const versionId = String(row.version), eventId = `ReportVersion:${row.id}`;
    fixedRecords.set(eventId, { recordId: uid, model: 'ReportVersion', row: { uid, version: row.version, action: row.action }, event: {
      eventId, recordId: uid, versionId, sha256, at: signedAt,
      contentSha256: digest({ action: row.action, findings: row.findings, conclusion: row.conclusion, recommendation: row.recommendation,
        reason: row.reason, citations: row.citations ?? null, structured: row.structured ?? null }),
      act: previous === null ? 'entry' : row.action === 'addendum' ? 'additional-entry' : 'correction',
      signature: { versionId, sha256, signedAt, verified: true }, predecessor: previous && { recordId: uid, partId: previous.versionId, sha256: previous.sha256 },
      components: [], processing: null } });
    previous = { versionId, sha256 };
  }
  // Units with any stored hold are judged before this point (held or unsupported); this unit's hold listing is empty.
  const scope = transactionScope();
  const snapshot = snapshotFromRows(scope, { fixedRecords, holds: new Map([[uid, []]]), accessRequests: new Map(),
    correctionRequests: new Map(), clauseVersions: new Map(), accessEvents: new Map() });
  try {
    return withSnapshot(scope, snapshot, () => {
      let record: Readonly<RetentionRecord> | null = null;
      for (const eventId of fixedRecords.keys()) {
        const source = resolveStoredRecord(emrAdapters().stored, uid, eventId);
        record = record === null ? parseRetentionRecord({ ...newRetentionRecord(source), disposalUnitId })
          : recordVersionAdded(record, source, { records: [record], references: [], complete: true, revision: 'unit-build', checkedAt: source.event.at });
      }
      return { status: 'built' as const, record: record! };
    });
  } catch (error) {
    return unsupported('report-retention-refused:' + ((error as { code?: string }).code ?? 'invalid'));
  }
}

/** One row of emr_access.retention_report_retainers: a stored fact outside the unit that names it, or its projection. */
export interface StoredRetainer { source: string; fromRecordId: string; fromPartId: string | null; toPartId: string | null }
/** Everything H read for one report unit under its record lock. A missing list is an unread store, never "none". */
export interface ReportUnitRows {
  uid: string; disposalUnitId: string; versions: readonly ReportVersionRow[]; signed: readonly SignedVersionRow[];
  holds: readonly { holdId: string; phase: string }[]; openDuty: boolean; retainers: readonly StoredRetainer[];
}
export type ReportUnitJudgement =
  | { status: 'due'; record: Readonly<RetentionRecord>; eligibleAt: string }
  | { status: 'retained' | 'held' | 'unsupported'; reason: string | null };

/**
 * H's judgement of one native report unit at `at`. Before A sees it: a unit that anything outside it names (CVR pin,
 * question entry, Related Report insertion, D attachment, order fact, another record's signed attachment, F issuance)
 * or whose StudyState still projects a report state is unsupported, because no adapter here builds the referrer as an
 * A record and dropping the reference would drop its retention duty. Only then holds, duties and A's own deadline.
 */
export function judgeReportUnit(rows: ReportUnitRows, at: string): ReportUnitJudgement {
  if (!Array.isArray(rows.retainers) || !Array.isArray(rows.holds) || !Array.isArray(rows.versions) || !Array.isArray(rows.signed))
    throw Object.assign(new Error('ReportUnitRowsUnread'), { code: 'ReportUnitRowsUnread' });
  const sources = [...new Set(rows.retainers.map(r => r.source))].sort();
  if (sources.includes('report-projection')) return { status: 'unsupported', reason: 'report-projection' };
  if (sources.length) return { status: 'unsupported', reason: 'reverse-reference:' + sources[0] };
  const active = rows.holds.filter(h => h.phase === 'placed' && !rows.holds.some(r => r.holdId === h.holdId && r.phase === 'released'));
  if (active.length) return { status: 'held', reason: 'legal-hold' };
  // A released hold moves the earliest destruction to its release; reading its basis is not part of this slice.
  if (rows.holds.length) return { status: 'unsupported', reason: 'released-hold-history' };
  if (rows.openDuty) return { status: 'held', reason: 'open-duty-request' };
  const built = reportRetentionRecord(rows.uid, rows.versions, rows.signed, rows.disposalUnitId);
  if (built.status !== 'built') return { status: 'unsupported', reason: built.reason };
  // The references read for this unit: none (any retainer returned above), so A's graph holds exactly what was read.
  const graph: RetentionGraph = { records: [built.record], references: [], complete: true, revision: 'unit', checkedAt: at };
  let state: ReturnType<typeof retentionState>;
  try { state = retentionState(built.record, graph, at); }
  catch (error) { return { status: 'unsupported', reason: 'report-retention-refused:' + ((error as { code?: string }).code ?? 'invalid') }; }
  if (state.destroyNotBefore === null) return { status: 'held', reason: 'retention-state-held' };
  if (state.destroyNotBefore > at) return { status: 'retained', reason: null };
  return { status: 'due', record: built.record, eligibleAt: state.destroyNotBefore };
}
