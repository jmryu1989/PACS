import { RECORD_CLASSIFICATION, RecordKind } from './classification';
import { STATUTORY_MINIMUM } from './legal-basis';
import { choice, freeze, integer, object, string, utc } from './validation';

export interface RecordPolicy { retentionYears: number; accessYears: number; requireSignature: boolean }
export type ProductConfiguration = Readonly<Record<RecordKind, Readonly<RecordPolicy>>>;
export type Tightening = Partial<Record<RecordKind, Partial<RecordPolicy>>>;
const kinds = Object.keys(RECORD_CLASSIFICATION) as RecordKind[];
const validated = new WeakSet<object>();

export const PRODUCT_DEFAULTS = freeze({
  keepEveryVersion: true, recordAuthorTimeHash: true, logEveryAccess: true, automaticDestruction: false,
  retentionStart: 'latest-version-or-clinical-use',
  linkedEvidence: 'retain-until-every-linked-record-and-evidence-period-expires',
  disposal: 'explicit-authorized-logged-act-after-expiry-and-hold-clearance',
  clinicalContentInOperationalRecord: 'add-clinical-classification-before-saving',
  unknownRecordKind: 'reject',
});

export const DEFAULT_CONFIGURATION: ProductConfiguration = freeze(Object.fromEntries(kinds.map(kind => {
  const row = RECORD_CLASSIFICATION[kind];
  return [kind, { retentionYears: row.retention.years,
    accessYears: Math.max(STATUTORY_MINIMUM.access.years, row.retention.years),
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
    const v = Object.hasOwnProperty.call(overrides, kind) ? fields(overrides[kind], ['retentionYears', 'accessYears', 'requireSignature']) : {};
    const retentionYears = Object.hasOwnProperty.call(v, 'retentionYears') ? integer(v.retentionYears, base.retentionYears) : base.retentionYears;
    const accessFloor = Math.max(base.accessYears, retentionYears, STATUTORY_MINIMUM.access.years);
    const accessYears = Object.hasOwnProperty.call(v, 'accessYears') ? integer(v.accessYears, accessFloor) : accessFloor;
    const requireSignature = Object.hasOwnProperty.call(v, 'requireSignature') ? v.requireSignature : base.requireSignature;
    if (typeof requireSignature !== 'boolean' || (base.requireSignature && !requireSignature)) throw new Error('Signature protection cannot be reduced');
    return [kind, { retentionYears, accessYears, requireSignature }];
  })) as Record<RecordKind, RecordPolicy>;
  const resolved = freeze(result);
  validated.add(resolved);
  return resolved;
}

/** All kinds of a mixed/linked record contribute; a chart reference can never inherit a shorter image period. */
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

export interface DisposalRequest {
  recordId: string; versionIds: readonly string[]; kinds: readonly RecordKind[];
  lastVersionOrClinicalUseAt: string; lastAccessAt: string; linkedRetainUntil: readonly string[];
  requestedAt: string; actorId: string; reason: string; legalBasisReference: string; holdActive: boolean;
}
export interface DisposalEvent { request: Readonly<DisposalRequest>; eventId: string; retainUntil: string }
export interface DisposalAuditStore { append(event: Readonly<DisposalEvent>): Promise<{ eventId: string; durableAt: string }> }

function anniversary(value: string, years: number): string {
  const date = new Date(utc(value)), month = date.getUTCMonth();
  // A leap-day period ends on March 1 in a non-leap year: never shorten it by rounding down.
  date.setUTCFullYear(date.getUTCFullYear() + years);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) throw new Error('Retention date outside supported range');
  if (date.getUTCMonth() < month) throw new Error('Invalid retention date');
  return date.toISOString();
}

/** B executes deletion only after a durable explicit event; no timer/automatic deletion API exists. */
export async function destroyAfterDurableEvent<T>(store: DisposalAuditStore, input: DisposalRequest, eventId: string,
  destroy: (event: Readonly<DisposalEvent>) => Promise<T>, settings: ProductConfiguration = DEFAULT_CONFIGURATION): Promise<T> {
  const v = object(input, ['recordId', 'versionIds', 'kinds', 'lastVersionOrClinicalUseAt', 'lastAccessAt', 'linkedRetainUntil',
    'requestedAt', 'actorId', 'reason', 'legalBasisReference', 'holdActive']);
  const policy = retentionFor(v.kinds, settings);
  if (v.holdActive !== false) throw new Error('Active or unresolved retention hold');
  if (!Array.isArray(v.versionIds) || !v.versionIds.length || new Set(v.versionIds).size !== v.versionIds.length ||
      !Array.isArray(v.linkedRetainUntil)) throw new Error('Complete version and linked retention sets required');
  const request: DisposalRequest = { recordId: string(v.recordId), versionIds: v.versionIds.map(id => string(id)), kinds: [...v.kinds],
    lastVersionOrClinicalUseAt: utc(v.lastVersionOrClinicalUseAt), lastAccessAt: utc(v.lastAccessAt),
    linkedRetainUntil: v.linkedRetainUntil.map(at => utc(at)), requestedAt: utc(v.requestedAt),
    actorId: string(v.actorId), reason: string(v.reason), legalBasisReference: string(v.legalBasisReference), holdActive: false };
  const deadlines = [anniversary(request.lastVersionOrClinicalUseAt, policy.retentionYears),
    anniversary(request.lastAccessAt, policy.accessYears), ...request.linkedRetainUntil].sort();
  const retainUntil = deadlines[deadlines.length - 1];
  if (request.requestedAt < retainUntil) throw new Error('Retention period has not elapsed');
  const event = freeze({ request, eventId: string(eventId), retainUntil });
  const receipt = object(await store.append(event), ['eventId', 'durableAt']);
  if (receipt.eventId !== event.eventId || utc(receipt.durableAt) < request.requestedAt) throw new Error('Invalid durable disposal receipt');
  return destroy(event);
}

export const KEY_MANAGEMENT = freeze({
  operator: 'product', scope: 'per-doctor', sharedPrivateKey: false,
  privateKeyStore: 'protected-key-volume', wrappingSecret: 'separate-secret-outside-key-volume-and-database',
  identityRegistration: 'product-verifies-immutable-identity-and-medical-signing-authority-before-activation',
  custody: 'encrypted-private-keys; signer-bound-authenticated-use; no-private-key-export-to-browser-or-audit',
  recovery: 'verify-identity-and-authority; two-distinct-authorized-operators; encrypted-backup-and-separate-secret; issue-new-kid',
  recoveryFailure: 'block-signing-preserve-drafts-and-all-previous-signatures',
  revocation: 'immediate-on-loss-compromise-or-offboarding; append-reason-and-effective-time; block-new-signatures',
  verificationEvidence: 'retain-public-keys-registration-validity-and-revocation-history-with-linked-records',
  basis: '의료법 제23조①②; 시행규칙 제16조①1·2·3·5·6; 보관 방식과 복구 절차는 제품 보호 기본값',
});

export type KeyStatus = 'active' | 'suspended' | 'revoked' | 'retired';
export function transitionSigningKey(status: KeyStatus, action: 'suspend' | 'revoke' | 'retire' | 'recover'): KeyStatus {
  choice(status, ['active', 'suspended', 'revoked', 'retired']); choice(action, ['suspend', 'revoke', 'retire', 'recover']);
  if (action === 'revoke') return 'revoked';
  if (status === 'revoked' || status === 'retired') throw new Error('Terminal key cannot be reactivated; register a new key');
  return action === 'suspend' ? 'suspended' : 'retired'; // Recovery retires the old key, never silently re-enables it.
}
