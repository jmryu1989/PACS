import type { DestructionRecord, DestructionRecordV1, DestructionRecordV2 } from '../emr-contract/lawful-defaults';
import { refuse } from '../emr-contract/validation';
import type { RecordDecoder } from './ledger-file';

/*
 * CD-09-C: the destruction records a retention ledger holds, by format. Each format is a closed field set with its own
 * value rules; the record format is dispatched before any field is read, so a format this build does not know is told
 * apart from a damaged record (`FormatUnsupported`, not `RecordInvalid`). Nothing but the opaque unit and the
 * destruction facts can be read back from (or written to) a line.
 *
 * Format 1 (the CD-09-P release) is read with exactly its old rules and is otherwise read only: a ledger never gets a new
 * format-1 attempt, only the terminal record of a format-1 attempt it already holds open. Format 2 is every new attempt.
 * Across lines: once a format-2 record is in a ledger no format-1 record follows it (there is one switch); an attempt is
 * closed in the format it started in; a format-2 terminal record closes the open started of its unit with the same
 * operation and the same facts; a new attempt does not start over an open one and never reuses an operation.
 */

const UNIT = /^disposal:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A reason for a late destruction is a code from a closed vocabulary, never free text (no patient, text or error goes in).
const REASON = /^[a-z][a-z0-9-]{0,63}$/;
const SEOUL_MS = 9 * 3600_000;
const PHASES = ['started', 'completed', 'failed'];
const V1_KEYS = ['formatVersion', 'phase', 'day', 'disposalUnitId', 'classes', 'clauseIds', 'partCount', 'expiryDay',
  'extensionUsed', 'dueDay', 'timeliness', 'method', 'basis'];
const V2_KEYS = ['formatVersion', 'kind', 'operationId', 'phase', 'occurredAt', 'day', 'disposalUnitId', 'classes', 'clauseIds',
  'partCount', 'expiryDay', 'extensionUsed', 'dueDay', 'timeliness', 'delayReasonStatus', 'justifiedDelay', 'method', 'basis'];
// What every record of one format-2 attempt states the same way.
const ATTEMPT_FACTS = ['kind', 'operationId', 'disposalUnitId', 'classes', 'clauseIds', 'partCount', 'expiryDay', 'extensionUsed',
  'dueDay', 'justifiedDelay', 'method', 'basis'];

function exactKeys(value: any, keys: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
const seoulDay = (at: string) => new Date(Date.parse(at) + SEOUL_MS).toISOString().slice(0, 10);
const isUtc = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');

function v1(value: any): boolean {
  // The P release's parser, unchanged (claude-plan-cd-09c.md F1: format-1 lines read by the same rules).
  return exactKeys(value, V1_KEYS) && PHASES.includes(value.phase) && typeof value.disposalUnitId === 'string' &&
    UNIT.test(value.disposalUnitId) && DAY.test(value.day) && DAY.test(value.dueDay) &&
    ['within-five-days', 'overdue'].includes(value.timeliness);
}
function v2(value: any): boolean {
  if (!exactKeys(value, V2_KEYS) || value.kind !== 'operational-deletion' || typeof value.operationId !== 'string' ||
      !OPERATION.test(value.operationId) || !PHASES.includes(value.phase) || !isUtc(value.occurredAt) ||
      value.day !== seoulDay(value.occurredAt) || typeof value.disposalUnitId !== 'string' || !UNIT.test(value.disposalUnitId) ||
      !strings(value.classes) || !strings(value.clauseIds) || !Number.isInteger(value.partCount) || value.partCount < 1 ||
      !DAY.test(value.expiryDay) || typeof value.extensionUsed !== 'boolean' || !DAY.test(value.dueDay) ||
      value.method !== 'operational-store-deletion' || value.basis !== 'privacy-act-21-and-decree-16-1-1' ||
      !(value.justifiedDelay === null || (typeof value.justifiedDelay === 'string' && REASON.test(value.justifiedDelay))))
    return false;
  // The phase's own time decides timeliness against the attempt's due day; a reason is required only past it.
  const timeliness = value.day <= value.dueDay ? 'within-five-days' : 'overdue';
  const status = timeliness === 'within-five-days' ? 'not-required' : value.justifiedDelay === null ? 'missing' : 'recorded';
  return value.timeliness === timeliness && value.delayReasonStatus === status &&
    (timeliness === 'overdue' || value.justifiedDelay === null);
}

/** The decoder of one ledger read (or one append after it): the order rules see every earlier record. */
export function destructionRecordDecoder(codes: string): () => RecordDecoder<DestructionRecord> {
  return () => {
    const last = new Map<string, DestructionRecord>();
    const operations = new Set<string>();
    let formatTwoSeen = false;
    return {
      decode(value: any, mode): DestructionRecord {
        const invalid = () => refuse(codes + 'RecordInvalid');
        if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isInteger(value.formatVersion)) invalid();
        if (value.formatVersion !== 1 && value.formatVersion !== 2) refuse(codes + 'FormatUnsupported');
        const record = value as DestructionRecord;
        const open = (() => { const l = last.get(record.disposalUnitId); return l?.phase === 'started' ? l : null; })();
        if (record.formatVersion === 1) {
          if (!v1(record) || formatTwoSeen) invalid();
          // A new format-1 attempt is never written; only the open format-1 attempt of this unit is closed in format 1.
          if (mode === 'append' && (record.phase === 'started' || open?.formatVersion !== 1)) invalid();
        } else {
          if (!v2(record)) invalid();
          const r = record as DestructionRecordV2;
          if (r.phase === 'started') {
            if (open || operations.has(r.operationId)) invalid();
            operations.add(r.operationId);
          } else {
            const s = open as DestructionRecordV2 | null;
            if (!s || s.formatVersion !== 2 || r.occurredAt < s.occurredAt ||
                ATTEMPT_FACTS.some(k => JSON.stringify((r as any)[k]) !== JSON.stringify((s as any)[k]))) invalid();
          }
          formatTwoSeen = true;
        }
        last.set(record.disposalUnitId, record);
        return record as DestructionRecordV1 | DestructionRecordV2;
      },
    };
  };
}
