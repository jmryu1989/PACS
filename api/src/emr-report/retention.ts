import { RECORD_CLASSIFICATION, verifiedRecord } from '../emr-contract/classification';
import { newRetentionRecord } from '../emr-contract/lawful-defaults';
import type { RetentionRecord } from '../emr-contract/lawful-defaults';
import {
  LifecycleCommand, LifecycleOutcome, ReportFacts, RetentionOnlyEvent, ResumeClinicalUseEvent,
  reportRetentionAccess, transitionReport, transitionRetainedReport,
} from '../emr-contract/report-lifecycle';
import { freeze, object, refuse, utc } from '../emr-contract/validation';
import type { RetainedInputs, RetainedRead } from './contract';

/**
 * The only way a signed report version enters storage. The first signed version opens the retention unit; every later
 * one goes through A's combined lifecycle + retention pre-check (transitionRetainedReport), so an expired unit that only
 * survives by reference or hold cannot take an ordinary part and restart its clock (L5-01). No raw part-append is
 * exposed to the store.
 */
export function signedTransition(facts: ReportFacts, command: LifecycleCommand, retained: RetainedInputs):
  LifecycleOutcome & { retention: Readonly<RetentionRecord> } {
  const r = object(retained, ['record', 'source', 'graph', 'archive']) as RetainedInputs;
  const source = verifiedRecord(r.source);
  if (facts.contentHistory.length === 0) {
    // Nothing is retained yet: a stored record here would be someone else's unit.
    if (r.record !== null || r.archive !== null) refuse('RetainedRecordMismatch');
    if (source.recordId !== facts.recordId || source.event.versionId !== command.version?.versionId ||
        source.event.sha256 !== command.version?.sha256 || source.event.at !== command.at) refuse('RecordEventBindingRefused');
    const outcome = transitionReport(facts, command);
    return freeze({ ...outcome, retention: newRetentionRecord(source, r.graph ?? undefined) });
  }
  if (r.record === null || r.graph === null) refuse('RetainedRecordRequired');
  return transitionRetainedReport(facts, command, r.record, source, r.graph, r.archive);
}

/** Reads must name the stored retention record and the read instant; a missing argument is refused, not defaulted. */
export function requireRetainedRead(input: unknown): Readonly<RetainedRead> {
  if (input === null || input === undefined) refuse('RetainedReadArgumentRequired');
  let v: Record<string, any>;
  try { v = object(input, ['record', 'at']); utc(v.at); } catch { refuse('RetainedReadArgumentRequired'); }
  if (!v.record || typeof v.record !== 'object') refuse('RetainedReadArgumentRequired');
  return freeze({ record: v.record, at: v.at });
}
export function readRetention(facts: ReportFacts, archive: RetentionOnlyEvent | null, resume: ResumeClinicalUseEvent | null, retained: unknown) {
  const read = requireRetainedRead(retained);
  return reportRetentionAccess(facts, archive, resume, { record: read.record, at: read.at });
}

/**
 * What a device-side artifact is for retention. A signed but not yet adopted original was a real clinical signature:
 * it is kept apart from draft disposal and follows the report-version classification, never a period of its own, and
 * is never auto-published. A is the single source of that period (the 2026-10-09 legal register reads a radiology
 * report as rule 15(1)6 "그 소견서", 5 years unless incorporated into a chart record; that correction is A/H/I's D-19,
 * so nothing here fixes 5 or 10). A recovery work copy lives only for its recovery purpose. Cache copies follow E/H
 * lifetimes, never the 24-hour amend window.
 */
export type OfflineArtifact = 'signed-unadopted-original' | 'recovery-work-copy' | 'offline-cache-copy' | 'unsigned-private-draft';
export function offlineArtifactRetention(kind: OfflineArtifact): Readonly<{
  mode: 'statutory' | 'purpose' | 'cache'; years: number | null; clauseIds: readonly string[]; purposeEnds: readonly string[]; autoPublish: false;
}> {
  switch (kind) {
    case 'signed-unadopted-original': {
      const c = RECORD_CLASSIFICATION['report-version'].retention;
      return freeze({ mode: 'statutory' as const, years: c.years, clauseIds: c.statutoryMinimum.map(m => m.clauseId), purposeEnds: [], autoPublish: false as const });
    }
    case 'recovery-work-copy':
      return freeze({ mode: 'purpose' as const, years: null, clauseIds: [], purposeEnds: ['recovery-version-signed', 'explicit-discard', 'parent-cancelled'], autoPublish: false as const });
    case 'unsigned-private-draft':
      return freeze({ mode: 'purpose' as const, years: null, clauseIds: [], purposeEnds: RECORD_CLASSIFICATION['private-draft'].retention.purposeEnds, autoPublish: false as const });
    case 'offline-cache-copy':
      return freeze({ mode: 'cache' as const, years: null, clauseIds: [], purposeEnds: ['work-ended', 'grant-ended'], autoPublish: false as const });
  }
  return refuse('OfflineArtifactUnknown');
}

/**
 * Whether the device may delete its only copy of a signed original. Only the server's verified retention receipt for
 * that exact event ends local custody; draft end, cache eviction, logout, grant expiry and conflicts never do.
 */
export function mayRemoveLocalOriginal(cause: 'server-retention-receipt' | 'draft-purpose-ended' | 'cache-evicted' | 'logout' | 'grant-expired' | 'conflict',
  receipt: { eventId: string; verified: boolean } | null, eventId: string): boolean {
  if (cause !== 'server-retention-receipt') return false;
  return !!receipt && receipt.verified === true && receipt.eventId === eventId;
}
