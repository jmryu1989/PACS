import { RECORD_CLASSIFICATION, RecordKind } from './classification';
import { STATUTORY_MINIMUM } from './legal-basis';
import { choice, freeze, object, string, utc } from './validation';

export interface RecordPolicy { retentionYears: number; accessYears: number; requireSignature: boolean }
export type ProductConfiguration = Readonly<Record<RecordKind, Readonly<RecordPolicy>>>;
export type Tightening = Partial<Record<RecordKind, { requireSignature?: boolean }>>;
const kinds = Object.keys(RECORD_CLASSIFICATION) as RecordKind[];
const validated = new WeakSet<object>();

export const PRODUCT_DEFAULTS = freeze({
  keepEveryVersion: true, recordAuthorTimeHash: true, logEveryAccess: true, automaticDestruction: true,
  retentionStart: 'persisted-record-class-start; never-reset-by-read-copy-or-link',
  linkedEvidence: 'source-specific-expiry; no-deadline-propagation-between-records',
  disposal: 'irreversible-permanent-deletion-at-expiry; no-personal-data-in-destruction-record',
  extension: 'continuing-treatment-only; once-per-record; at-most-its-statutory-period',
  retentionOnly: 'explicit-purpose-end-with-stored-lifecycle-event; separate-storage-and-restricted-access',
  clinicalContentInOperationalRecord: 'add-clinical-classification-before-saving',
  unknownRecordKind: 'reject',
});

export const DEFAULT_CONFIGURATION: ProductConfiguration = freeze(Object.fromEntries(kinds.map(kind => {
  const row = RECORD_CLASSIFICATION[kind];
  return [kind, { retentionYears: row.retention.years,
    accessYears: STATUTORY_MINIMUM.access.years,
    requireSignature: row.signature.rule === 'required' }];
})) as Record<RecordKind, RecordPolicy>);
validated.add(DEFAULT_CONFIGURATION);

function config(value: ProductConfiguration): ProductConfiguration {
  if (!validated.has(value)) throw new Error('Use tightenConfiguration to resolve and validate persisted settings');
  return value;
}
function fields(input: unknown, allowed: readonly string[]): Record<string, any> {
  const keys = input && typeof input === 'object' ? Object.keys(input) : [];
  const v = object(input, keys);
  if (keys.some(key => !allowed.includes(key))) throw new Error('Unknown configuration field');
  return v;
}

/** Persisted sparse settings resolve into a complete immutable policy. Explicit undefined is invalid. */
export function tightenConfiguration(input: unknown = {}, current: ProductConfiguration = DEFAULT_CONFIGURATION): ProductConfiguration {
  config(current);
  const overrides = fields(input, kinds);
  const result = Object.fromEntries(kinds.map(kind => {
    const base = current[kind];
    const v = Object.hasOwnProperty.call(overrides, kind) ? fields(overrides[kind], ['requireSignature']) : {};
    const requireSignature = Object.hasOwnProperty.call(v, 'requireSignature') ? v.requireSignature : base.requireSignature;
    if (typeof requireSignature !== 'boolean' || (base.requireSignature && !requireSignature)) throw new Error('Signature protection cannot be reduced');
    return [kind, { retentionYears: base.retentionYears, accessYears: base.accessYears, requireSignature }];
  })) as Record<RecordKind, RecordPolicy>;
  const resolved = freeze(result);
  validated.add(resolved);
  return resolved;
}

/** Only actual classes of ONE record contribute. Call separately for linked records and access events. */
export function retentionFor(recordKinds: readonly RecordKind[], settings: ProductConfiguration = DEFAULT_CONFIGURATION): Readonly<RecordPolicy> {
  config(settings);
  if (!Array.isArray(recordKinds) || !recordKinds.length) throw new Error('At least one classified record required');
  const rows = recordKinds.map(kind => settings[choice(kind, kinds)]);
  return freeze({ retentionYears: Math.max(...rows.map(row => row.retentionYears)),
    accessYears: Math.max(...rows.map(row => row.accessYears)), requireSignature: rows.some(row => row.requireSignature) });
}

/** The default is the kind's described content. Clinical use of working material always invokes the statutory signature rule. */
export function signatureRequired(kind: RecordKind, use: 'described-content' | 'clinical-entry' = 'described-content',
  settings: ProductConfiguration = DEFAULT_CONFIGURATION): boolean {
  config(settings); choice(kind, kinds); choice(use, ['described-content', 'clinical-entry']);
  return settings[kind].requireSignature || use === 'clinical-entry';
}

export type StatutoryClass = keyof typeof STATUTORY_MINIMUM;
export interface ContinuingTreatmentExtension {
  cause: 'continuing-treatment'; actorId: string; reason: string; at: string; until: string;
}
export interface RetentionRecord {
  recordId: string; recordClass: StatutoryClass; startedAt: string; extension: ContinuingTreatmentExtension | null;
}

function anniversary(value: string, years: number): string {
  const date = new Date(utc(value)), month = date.getUTCMonth();
  // A leap-day period ends on March 1 in a non-leap year: never shorten it by rounding down.
  date.setUTCFullYear(date.getUTCFullYear() + years);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) throw new Error('Retention date outside supported range');
  if (date.getUTCMonth() < month) throw new Error('Invalid retention date');
  return date.toISOString();
}

/** B persists this once for each legal record unit. References and derived copies reuse its schedule. */
export function newRetentionRecord(recordId: string, recordClass: StatutoryClass, startedAt: string): Readonly<RetentionRecord> {
  return parseRetentionRecord({ recordId, recordClass, startedAt, extension: null });
}

export function parseRetentionRecord(input: unknown): Readonly<RetentionRecord> {
  const v = object(input, ['recordId', 'recordClass', 'startedAt', 'extension']);
  const recordClass = choice(v.recordClass, Object.keys(STATUTORY_MINIMUM) as StatutoryClass[]);
  const startedAt = utc(v.startedAt), years = STATUTORY_MINIMUM[recordClass].years;
  const baseExpiry = anniversary(startedAt, years);
  let extension: ContinuingTreatmentExtension | null = null;
  if (v.extension !== null) {
    const e = object(v.extension, ['cause', 'actorId', 'reason', 'at', 'until']);
    extension = { cause: choice(e.cause, ['continuing-treatment']), actorId: string(e.actorId), reason: string(e.reason),
      at: utc(e.at), until: utc(e.until) };
    if (recordClass === 'access' || extension.at < startedAt || extension.at >= baseExpiry ||
        extension.until <= baseExpiry || extension.until > anniversary(baseExpiry, years))
      throw new Error('Only one timely continuing-treatment extension within the statutory period is allowed');
  }
  return freeze({ recordId: string(v.recordId), recordClass, startedAt, extension });
}

export function retentionDeadline(input: RetentionRecord): string {
  const record = parseRetentionRecord(input);
  return record.extension?.until ?? anniversary(record.startedAt, STATUTORY_MINIMUM[record.recordClass].years);
}

/** B must compare-and-append under the same record lock as expiry disposal; settings cannot extend retention. */
export function extendRetention(input: RetentionRecord, extension: ContinuingTreatmentExtension): Readonly<RetentionRecord> {
  const record = parseRetentionRecord(input);
  if (record.extension !== null || extension === null) throw new Error('Extension already used or missing');
  return parseRetentionRecord({ ...record, extension });
}

export interface DisposalRequest { record: RetentionRecord; versionIds: readonly string[]; requestedAt: string }
/** No free text, actor, patient/record/version ID, content hash, audit correlation or request payload is retained. */
export interface DestructionRecord {
  formatVersion: 1; phase: 'started' | 'completed' | 'failed'; day: string;
  method: 'irreversible-permanent-deletion'; basis: 'privacy-act-21-and-decree-16-1-1';
}
export interface DisposalAuditStore { append(event: Readonly<DestructionRecord>): Promise<{ durableAt: string }> }
export interface DestructionReceipt { completedAt: string; method: 'irreversible-permanent-deletion' }

/** A contract callback only: B erases originals, earlier versions, signatures, replicas and recoverable backups. */
export async function destroyAtExpiry(store: DisposalAuditStore, input: DisposalRequest,
  destroy: (request: Readonly<DisposalRequest>) => Promise<DestructionReceipt>): Promise<Readonly<DestructionRecord>> {
  const v = object(input, ['record', 'versionIds', 'requestedAt']);
  const record = parseRetentionRecord(v.record), requestedAt = utc(v.requestedAt);
  if (!Array.isArray(v.versionIds) || !v.versionIds.length || new Set(v.versionIds).size !== v.versionIds.length)
    throw new Error('Complete version set required');
  const request = freeze({ record, versionIds: v.versionIds.map(id => string(id)), requestedAt });
  if (requestedAt < retentionDeadline(record)) throw new Error('Retention period has not elapsed');
  const append = async (phase: DestructionRecord['phase'], at: string): Promise<Readonly<DestructionRecord>> => {
    const event: Readonly<DestructionRecord> = freeze({ formatVersion: 1, phase, day: at.slice(0, 10),
      method: 'irreversible-permanent-deletion', basis: 'privacy-act-21-and-decree-16-1-1' });
    const receipt = object(await store.append(event), ['durableAt']);
    if (utc(receipt.durableAt) < at) throw new Error('Invalid durable destruction receipt');
    return event;
  };
  await append('started', requestedAt);
  let completedAt: string;
  try {
    const receipt = object(await destroy(request), ['completedAt', 'method']);
    completedAt = utc(receipt.completedAt);
    if (receipt.method !== 'irreversible-permanent-deletion' || completedAt < requestedAt)
      throw new Error('Irreversible destruction completion required');
  } catch (error) {
    await append('failed', requestedAt);
    throw error;
  }
  // A completed row is never written before successful deletion; append failure remains an incomplete operation.
  return append('completed', completedAt);
}

export const KEY_MANAGEMENT = freeze({
  operator: 'product', scope: 'per-doctor', sharedPrivateKey: false,
  privateKeyStore: 'protected-key-volume', wrappingSecret: 'separate-secret-outside-key-volume-and-database',
  identityRegistration: 'product-verifies-immutable-identity-and-medical-signing-authority-before-activation',
  custody: 'encrypted-private-keys; signer-bound-authenticated-use; no-private-key-export-to-browser-or-audit',
  recovery: 'verify-identity-and-authority; two-distinct-authorized-operators; encrypted-backup-and-separate-secret; issue-new-kid',
  recoveryFailure: 'block-signing-preserve-drafts-and-all-previous-signatures',
  revocation: 'immediate-on-loss-compromise-or-offboarding; append-reason-and-effective-time; block-new-signatures',
  verificationEvidence: 'person-linked-key-registration-and-revocation-evidence-follow-each-source-record-expiry',
  basis: '의료법 제23조①②; 시행규칙 제16조①1·2·3·5·6; 보관 방식과 복구 절차는 제품 보호 기본값',
});

export type KeyStatus = 'active' | 'suspended' | 'revoked' | 'retired';
export function transitionSigningKey(status: KeyStatus, action: 'suspend' | 'revoke' | 'retire' | 'recover'): KeyStatus {
  choice(status, ['active', 'suspended', 'revoked', 'retired']); choice(action, ['suspend', 'revoke', 'retire', 'recover']);
  if (action === 'revoke') return 'revoked';
  if (status === 'revoked' || status === 'retired') throw new Error('Terminal key cannot be reactivated; register a new key');
  return action === 'suspend' ? 'suspended' : 'retired'; // Recovery retires the old key, never silently re-enables it.
}
