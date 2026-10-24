import { verifiedRecord } from '../emr-contract/classification';
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
