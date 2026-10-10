import { createHash } from 'node:crypto';
import { refuse } from './validation';
import type { StoredRecordReader } from './classification';
import type { LegalDutyReader, PurposeEndReader } from './lawful-defaults';
import type { ClinicalStudyReader } from './report-lifecycle';
import type { AccessEvent } from './access-event';

export interface EmrAdapters {
  stored: StoredRecordReader; legal: LegalDutyReader; purpose: PurposeEndReader; clinical: ClinicalStudyReader;
}
type ReaderKind = keyof EmrAdapters;
const readers = new WeakMap<object, ReaderKind>();
let context: Readonly<EmrAdapters> | undefined;

// Only composition can mint capabilities; handlers cannot replace a reader after startup.
function bind<T extends object>(kind: ReaderKind, reader: T, required: readonly string[], optional: readonly string[] = []): Readonly<T> {
  if (!reader || required.some(key => typeof reader[key] !== 'function')) refuse('EmrAdapterRequired');
  const bound = Object.freeze(Object.fromEntries([...required, ...optional.filter(key => reader[key] !== undefined)]
    .map(key => {
      if (typeof reader[key] !== 'function') refuse('EmrAdapterRequired');
      return [key, reader[key].bind(reader)];
    }))) as Readonly<T>;
  readers.set(bound, kind); return bound;
}
/** Server startup only. A has no database dependency; B supplies the storage adapters. */
export function composeEmrAdapters(adapters: EmrAdapters): Readonly<EmrAdapters> {
  if (context) refuse('EmrAdaptersAlreadyComposed');
  const stored = bind('stored', adapters.stored, ['load']);
  const legal = bind('legal', adapters.legal, ['load', 'listHolds'], ['loadAccessRequest', 'loadCorrectionRequest', 'loadStatutoryDuty', 'loadClauseVersions']);
  const purpose = bind('purpose', adapters.purpose, ['load', 'loadSignedResult'], ['loadIntentEndingFact']);
  const clinical = bind('clinical', adapters.clinical, ['loadStudy', 'loadReportPatient']);
  context = Object.freeze({ stored, legal, purpose, clinical }); return context;
}
export function emrAdapters(): Readonly<EmrAdapters> {
  if (!context) refuse('EmrAdaptersRequired');
  return context;
}
/** Validation only; this cannot register a new capability. */
export function isEmrReader(kind: ReaderKind, reader: object): boolean { return readers.get(reader) === kind; }

// Access events have a fixed mapping owned by the contract, with no injectable model/reader.
const accessRows = new Map<string, AccessEvent>();
const accessReader = bind<StoredRecordReader>('stored', { load(recordId, eventId) {
  const event = accessRows.get(eventId);
  if (!event || recordId !== event.eventId) refuse('AccessRecordRequired');
  const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex');
  return { recordId, model: 'AuditLog', row: {}, event: {
    eventId, recordId, versionId: eventId, sha256: digest, contentSha256: digest, at: event.occurredAt,
    act: 'access', signature: null, predecessor: null, components: [], processing: null,
  } };
} }, ['load']);
export function resolveAccessRecord(input: AccessEvent) {
  // Defer the fixed mapping's consumers so importing any contract first is safe before server composition.
  const { parseAccessEvent } = require('./access-event') as typeof import('./access-event');
  const { resolveStoredRecord } = require('./classification') as typeof import('./classification');
  const event = parseAccessEvent(input);
  accessRows.set(event.eventId, event);
  try { return resolveStoredRecord(accessReader, event.eventId, event.eventId); }
  finally { accessRows.delete(event.eventId); }
}
