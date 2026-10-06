import { randomUUID } from 'node:crypto';
import { RECORD_CLASSIFICATION, RecordKind, PurposeEnd } from './classification';
import { STATUTORY_MINIMUM } from './legal-basis';
import { choice, freeze, object, string, utc } from './validation';

export interface RecordPolicy { retentionYears: number; accessYears: number; requireSignature: boolean }
export type ProductConfiguration = Readonly<Record<RecordKind, Readonly<RecordPolicy>>>;
export type Tightening = Partial<Record<RecordKind, { requireSignature?: boolean }>>;
const kinds = Object.keys(RECORD_CLASSIFICATION) as RecordKind[];
const validated = new WeakSet<object>();

export const PRODUCT_DEFAULTS = freeze({
  keepEveryVersion: true, recordAuthorTimeHash: true, logEveryAccess: true, automaticDestruction: true,
  retentionStart: 'each-content-part-own-start; unit-latest-part-expiry; Asia/Seoul-civil-calendar',
  linkedEvidence: 'incorporation-inherits-latest-referencing-deadline; navigation-never-propagates',
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
    if (requireSignature && !['required', 'clinical-entry-only'].includes(RECORD_CLASSIFICATION[kind].signature.rule))
      throw new Error('Only human clinical authors can receive additional signature duties');
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
const DAY_MS = 86_400_000;
const SEOUL_MS = 9 * 3_600_000;

/** Exclusive boundary: the last civil day has fully ended at this instant. */
export function civilPeriodEnd(startedAt: string, years: number): string {
  if (!Number.isSafeInteger(years) || years < 1) throw new Error('Whole positive calendar years required');
  const local = new Date(Date.parse(utc(startedAt)) + SEOUL_MS);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // Civil Act 157: only a period starting at 00:00 includes the initial day.
  const start = new Date(midnight + (local.getTime() === midnight ? 0 : DAY_MS));
  start.setUTCFullYear(start.getUTCFullYear() + years); // Feb 29 -> Mar 1 boundary (160(3)).
  if (!Number.isFinite(start.getTime()) || start.getUTCFullYear() > 9999) throw new Error('Unsupported period');
  return new Date(start.getTime() - SEOUL_MS).toISOString();
}
export function statutoryClasses(recordKinds: readonly RecordKind[]): readonly StatutoryClass[] {
  if (!Array.isArray(recordKinds) || !recordKinds.length || new Set(recordKinds).size !== recordKinds.length)
    throw new Error('Distinct classified record kinds required');
  const classes = new Set<StatutoryClass>();
  for (const kind of recordKinds) {
    const row = RECORD_CLASSIFICATION[choice(kind, kinds)];
    if (row.retention.mode !== 'statutory') throw new Error('Source and purpose records have no independent statutory clock');
    for (const minimum of row.retention.statutoryMinimum) {
      classes.add((Object.keys(STATUTORY_MINIMUM) as StatutoryClass[]).find(key => STATUTORY_MINIMUM[key].clauseId === minimum.clauseId)!);
    }
  }
  if (classes.has('access') && classes.size > 1) throw new Error('Access events must have separate retention units');
  return freeze([...classes].sort());
}
export interface ContinuingTreatmentExtension {
  cause: 'continuing-treatment'; actorId: string; reason: string; at: string; until: string;
}
export interface RetentionPart { partId: string; startedAt: string }
export interface LegalHold {
  holdId: string; recordId: string; basis: { law: string; authority: string; documentReference: string };
  actorId: string; at: string;
  release: { actorId: string; at: string; documentReference: string } | null;
}
export interface RetentionRecord {
  recordId: string; disposalUnitId: string; kinds: readonly RecordKind[]; parts: readonly RetentionPart[];
  extension: ContinuingTreatmentExtension | null; holds: readonly LegalHold[];
}
function opaqueUnit(value: unknown): string {
  const id = string(value);
  if (!/^disposal:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('Opaque disposal unit required');
  return id;
}
function yearsFor(recordKinds: readonly RecordKind[]): number {
  return Math.max(...statutoryClasses(recordKinds).map(c => STATUTORY_MINIMUM[c].years));
}
function partDeadline(record: Pick<RetentionRecord, 'kinds' | 'parts'>): string {
  return record.parts.map(p => civilPeriodEnd(p.startedAt, yearsFor(record.kinds))).sort().slice(-1)[0];
}
export function newRetentionRecord(recordId: string, recordKinds: readonly RecordKind[], startedAt: string,
  partId: string = recordId): Readonly<RetentionRecord> {
  return parseRetentionRecord({ recordId, disposalUnitId: `disposal:${randomUUID()}`, kinds: recordKinds,
    parts: [{ partId, startedAt }], extension: null, holds: [] });
}
function parseLegalHolds(input: unknown, recordId: string, startedAt: string): readonly LegalHold[] {
  if (!Array.isArray(input)) throw new Error('Explicit hold history required');
  const holds = input.map(h => {
    object(h, ['holdId', 'recordId', 'basis', 'actorId', 'at', 'release']);
    const b = object(h.basis, ['law', 'authority', 'documentReference']);
    if (h.recordId !== recordId || utc(h.at) < startedAt) throw new Error('Record-specific legal duty required');
    let release: LegalHold['release'] = null;
    if (h.release !== null) {
      const r = object(h.release, ['actorId', 'at', 'documentReference']);
      release = { actorId: string(r.actorId), at: utc(r.at), documentReference: string(r.documentReference) };
      if (release.at < h.at) throw new Error('Release precedes hold');
    }
    return { holdId: string(h.holdId), recordId, basis: { law: string(b.law), authority: string(b.authority), documentReference: string(b.documentReference) },
      actorId: string(h.actorId), at: h.at, release };
  });
  if (new Set(holds.map(h => h.holdId)).size !== holds.length) throw new Error('Duplicate hold');
  return holds;
}
export function parseRetentionRecord(input: unknown): Readonly<RetentionRecord> {
  const v = object(input, ['recordId', 'disposalUnitId', 'kinds', 'parts', 'extension', 'holds']);
  const recordId = string(v.recordId); statutoryClasses(v.kinds);
  if (!Array.isArray(v.parts) || !v.parts.length) throw new Error('All content parts required');
  const parts = v.parts.map(p => { object(p, ['partId', 'startedAt']); return { partId: string(p.partId), startedAt: utc(p.startedAt) }; });
  if (new Set(parts.map(p => p.partId)).size !== parts.length || parts.some((p, i) => i && p.startedAt < parts[i - 1].startedAt))
    throw new Error('Distinct chronological parts required');
  let extension: ContinuingTreatmentExtension | null = null;
  if (v.extension !== null) {
    const e = object(v.extension, ['cause', 'actorId', 'reason', 'at', 'until']);
    extension = { cause: choice(e.cause, ['continuing-treatment']), actorId: string(e.actorId), reason: string(e.reason), at: utc(e.at), until: utc(e.until) };
    const atDecision = parts.filter(p => p.startedAt <= extension!.at);
    const baseExpiry = atDecision.length ? partDeadline({ kinds: v.kinds, parts: atDecision }) : '';
    if (statutoryClasses(v.kinds).includes('access') || !baseExpiry || extension.at >= baseExpiry ||
        extension.until <= baseExpiry || extension.until > civilPeriodEnd(baseExpiry, yearsFor(v.kinds)))
      throw new Error('Only one timely continuing-treatment extension within the statutory period is allowed');
  }
  const holds = parseLegalHolds(v.holds, recordId, parts[0].startedAt);
  return freeze({ recordId, disposalUnitId: opaqueUnit(v.disposalUnitId), kinds: [...v.kinds], parts, extension, holds });
}
/** Persist only a new content part, after signature verification where that kind requires it. Never call for a read/copy. */
export function recordVersionAdded(input: RetentionRecord, partId: string, startedAt: string): Readonly<RetentionRecord> {
  const record = parseRetentionRecord(input);
  if (statutoryClasses(record.kinds).includes('access')) throw new Error('Each access event has its own unit');
  return parseRetentionRecord({ ...record, parts: [...record.parts, { partId, startedAt }] });
}
export function extendRetention(input: RetentionRecord, extension: ContinuingTreatmentExtension): Readonly<RetentionRecord> {
  const record = parseRetentionRecord(input);
  if (record.extension !== null || extension === null) throw new Error('Extension already used or missing');
  return parseRetentionRecord({ ...record, extension });
}
export function placeLegalHold(input: RetentionRecord, hold: Omit<LegalHold, 'release'>): Readonly<RetentionRecord> {
  const record = parseRetentionRecord(input);
  object(hold, ['holdId', 'recordId', 'basis', 'actorId', 'at']);
  return parseRetentionRecord({ ...record, holds: [...record.holds, { ...hold, release: null }] });
}
export function liftLegalHold(input: RetentionRecord, holdId: string, release: NonNullable<LegalHold['release']>): Readonly<RetentionRecord> {
  const record = parseRetentionRecord(input), held = record.holds.find(h => h.holdId === holdId);
  if (!held || held.release || !release) throw new Error('An active hold and explicit release required');
  return parseRetentionRecord({ ...record, holds: record.holds.map(h => h === held ? { ...h, release } : h) });
}
export interface RecordReference {
  fromRecordId: string; fromPartId: string; toRecordId: string; toPartId: string; relation: 'incorporation' | 'navigation';
}
/** B supplies the complete current reverse-reference closure under the same lock as disposal/append/hold. */
export interface RetentionGraph { records: readonly RetentionRecord[]; references: readonly RecordReference[] }
function retainingUnits(input: RetentionRecord, graph?: RetentionGraph): readonly RetentionRecord[] {
  const record = parseRetentionRecord(input);
  if (!graph) return [record];
  object(graph, ['records', 'references']);
  if (!Array.isArray(graph.records) || !Array.isArray(graph.references)) throw new Error('Complete graph required');
  const records = graph.records.map(parseRetentionRecord), byId = new Map(records.map(r => [r.recordId, r]));
  if (byId.size !== records.length || JSON.stringify(byId.get(record.recordId)) !== JSON.stringify(record)) throw new Error('Stale or missing graph unit');
  for (const ref of graph.references) {
    object(ref, ['fromRecordId', 'fromPartId', 'toRecordId', 'toPartId', 'relation']); choice(ref.relation, ['incorporation', 'navigation']);
    if (!byId.get(string(ref.fromRecordId))?.parts.some(p => p.partId === ref.fromPartId) ||
        !byId.get(string(ref.toRecordId))?.parts.some(p => p.partId === ref.toPartId)) throw new Error('Pinned part missing');
  }
  const retained = new Set([record.recordId]);
  // Cycles terminate, and transitive incorporation keeps the entire signed content verifiable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const ref of graph.references) if (ref.relation === 'incorporation' && retained.has(ref.toRecordId) && !retained.has(ref.fromRecordId)) {
      retained.add(ref.fromRecordId); changed = true;
    }
  }
  return [...retained].map(id => byId.get(id)!);
}
export function retentionDeadline(input: RetentionRecord, graph?: RetentionGraph): string {
  return retainingUnits(input, graph).flatMap(r => [partDeadline(r), ...(r.extension ? [r.extension.until] : [])]).sort().slice(-1)[0];
}
export function retentionState(input: RetentionRecord, graph?: RetentionGraph): Readonly<{ state: 'retained' | 'legal-hold'; deadline: string; destroyNotBefore: string | null }> {
  const units = retainingUnits(input, graph), deadline = retentionDeadline(input, graph);
  const held = units.some(r => r.holds.some(h => h.release === null));
  const releases = units.flatMap(r => r.holds.flatMap(h => h.release ? [h.release.at] : []));
  return freeze({ state: held ? 'legal-hold' : 'retained', deadline,
    destroyNotBefore: held ? null : [deadline, ...releases].sort().slice(-1)[0] });
}
export interface DisposalRequest { record: RetentionRecord; versionIds: readonly string[]; requestedAt: string; graph: RetentionGraph }
/** disposalUnitId is random, never a source ID/hash; its source mapping must be erased with the unit. */
export interface DestructionRecord {
  formatVersion: 1; phase: 'started' | 'completed' | 'failed'; day: string;
  disposalUnitId: string; classes: readonly StatutoryClass[]; clauseIds: readonly string[]; partCount: number;
  expiryDay: string; extensionUsed: boolean; dueDay: string; timeliness: 'within-five-days' | 'overdue';
  method: 'irreversible-permanent-deletion'; basis: 'privacy-act-21-and-decree-16-1-1';
}
export interface DisposalAuditStore { append(event: Readonly<DestructionRecord>): Promise<{ durableAt: string }> }
export interface DestructionReceipt { completedAt: string; method: 'irreversible-permanent-deletion' }
function seoulDay(at: string): string { return new Date(Date.parse(utc(at)) + SEOUL_MS).toISOString().slice(0, 10); }
function dueBy(at: string): string {
  const local = new Date(Date.parse(utc(at)) + SEOUL_MS);
  // The five-day outside bound is no grace period: the job is due immediately.
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (local.getUTCHours() === 0 && local.getUTCMinutes() === 0 && local.getUTCSeconds() === 0 && local.getUTCMilliseconds() === 0 ? 5 : 6)) - SEOUL_MS).toISOString();
}
async function destroyWithJournal<T>(store: DisposalAuditStore, request: T, requestedAt: string, eligibleAt: string,
  details: Pick<DestructionRecord, 'disposalUnitId' | 'classes' | 'clauseIds' | 'partCount' | 'expiryDay' | 'extensionUsed'>,
  destroy: (request: T) => Promise<DestructionReceipt>): Promise<Readonly<DestructionRecord>> {
  if (requestedAt < eligibleAt) throw new Error('Retention period has not elapsed');
  const due = dueBy(eligibleAt);
  const append = async (phase: DestructionRecord['phase'], at: string) => {
    const event: Readonly<DestructionRecord> = freeze({ formatVersion: 1, phase, day: seoulDay(at), ...details,
      dueDay: seoulDay(new Date(Date.parse(due) - 1).toISOString()), timeliness: at < due ? 'within-five-days' : 'overdue',
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
    if (receipt.method !== 'irreversible-permanent-deletion' || completedAt < requestedAt) throw new Error('Irreversible destruction completion required');
  } catch (error) { await append('failed', requestedAt); throw error; }
  return append('completed', completedAt);
}
/** B erases all parts/signatures/replicas/recoverable backups atomically against the reference/hold snapshot. */
export async function destroyAtExpiry(store: DisposalAuditStore, input: DisposalRequest,
  destroy: (request: Readonly<DisposalRequest>) => Promise<DestructionReceipt>): Promise<Readonly<DestructionRecord>> {
  const v = object(input, ['record', 'versionIds', 'requestedAt', 'graph']);
  const record = parseRetentionRecord(v.record), requestedAt = utc(v.requestedAt);
  if (!Array.isArray(v.versionIds) || new Set(v.versionIds).size !== v.versionIds.length ||
      v.versionIds.length !== record.parts.length || record.parts.some(p => !v.versionIds.includes(p.partId))) throw new Error('Complete version set required');
  const state = retentionState(record, v.graph);
  if (state.destroyNotBefore === null) throw new Error('Record-specific legal preservation is active');
  const request = freeze({ record, versionIds: [...v.versionIds], requestedAt, graph: structuredClone(v.graph) }) as Readonly<DisposalRequest>;
  const classes = statutoryClasses(record.kinds);
  return destroyWithJournal(store, request, requestedAt, state.destroyNotBefore, {
    disposalUnitId: record.disposalUnitId, classes, clauseIds: classes.map(c => STATUTORY_MINIMUM[c].clauseId), partCount: record.parts.length,
    expiryDay: seoulDay(new Date(Date.parse(state.deadline) - 1).toISOString()), extensionUsed: retainingUnits(record, v.graph).some(r => r.extension !== null),
  }, destroy);
}
export interface PurposeRecord { recordId: string; disposalUnitId: string; kind: RecordKind; ownerId: string; createdAt: string; partIds: readonly string[]; holds: readonly LegalHold[] }
export interface PurposeEndEvent { recordId: string; trigger: PurposeEnd; actorId: string; at: string }
export function newPurposeRecord(recordId: string, kind: RecordKind, ownerId: string, createdAt: string, partIds: readonly string[]): Readonly<PurposeRecord> {
  const row = RECORD_CLASSIFICATION[choice(kind, kinds)];
  if (row.retention.mode !== 'purpose' || !row.retention.purposeEnds.length || !Array.isArray(partIds) || !partIds.length || new Set(partIds).size !== partIds.length)
    throw new Error('Purpose kind and complete revisions required');
  return freeze({ recordId: string(recordId), disposalUnitId: `disposal:${randomUUID()}`, kind, ownerId: string(ownerId), createdAt: utc(createdAt), partIds: partIds.map(id => string(id)), holds: [] });
}
function parsePurposeRecord(record: PurposeRecord): Readonly<PurposeRecord> {
  object(record, ['recordId', 'disposalUnitId', 'kind', 'ownerId', 'createdAt', 'partIds', 'holds']);
  const parsed = newPurposeRecord(record.recordId, record.kind, record.ownerId, record.createdAt, record.partIds);
  return freeze({ ...parsed, disposalUnitId: opaqueUnit(record.disposalUnitId), holds: parseLegalHolds(record.holds, record.recordId, record.createdAt) });
}
export function placePurposeLegalHold(input: PurposeRecord, hold: Omit<LegalHold, 'release'>): Readonly<PurposeRecord> {
  const record = parsePurposeRecord(input); object(hold, ['holdId', 'recordId', 'basis', 'actorId', 'at']);
  return parsePurposeRecord({ ...record, holds: [...record.holds, { ...hold, release: null }] });
}
export function liftPurposeLegalHold(input: PurposeRecord, holdId: string, release: NonNullable<LegalHold['release']>): Readonly<PurposeRecord> {
  const record = parsePurposeRecord(input), held = record.holds.find(h => h.holdId === holdId);
  if (!held || held.release || !release) throw new Error('An active hold and explicit release required');
  return parsePurposeRecord({ ...record, holds: record.holds.map(h => h === held ? { ...h, release } : h) });
}
/** B binds approval/finalization to the parent report and discards to the owner; no arbitrary timer can end purpose. */
export async function destroyAtPurposeEnd(store: DisposalAuditStore, record: PurposeRecord, event: PurposeEndEvent, requestedAt: string,
  destroy: (record: Readonly<PurposeRecord>) => Promise<DestructionReceipt>): Promise<Readonly<DestructionRecord>> {
  const parsed = parsePurposeRecord(record);
  if (parsed.holds.some(h => !h.release)) throw new Error('Record-specific legal preservation is active');
  const e = object(event, ['recordId', 'trigger', 'actorId', 'at']);
  choice(e.trigger, RECORD_CLASSIFICATION[parsed.kind].retention.purposeEnds); string(e.actorId);
  if (e.recordId !== parsed.recordId || utc(e.at) < parsed.createdAt ||
      (['explicit-discard', 'owner-deleted'].includes(e.trigger) && e.actorId !== parsed.ownerId)) throw new Error('Purpose-end binding refused');
  return destroyWithJournal(store, freeze(parsed), utc(requestedAt), [e.at, ...parsed.holds.map(h => h.release!.at)].sort().slice(-1)[0], { disposalUnitId: parsed.disposalUnitId, classes: [], clauseIds: ['privacy:21.1'],
    partCount: parsed.partIds.length, expiryDay: seoulDay(e.at), extensionUsed: false }, destroy);
}
export interface DestructionConfirmation {
  action: 'destruction-confirmed'; batchId: string; disposalUnitIds: readonly string[]; officerId: string; role: 'privacy-officer'; at: string;
}
export function confirmDestruction(batchId: string, completed: readonly DestructionRecord[], officerId: string, at: string): Readonly<DestructionConfirmation> {
  if (!completed.length || completed.some(e => e.phase !== 'completed' || e.day > seoulDay(at))) throw new Error('Completed batch required');
  return freeze({ action: 'destruction-confirmed', batchId: string(batchId), disposalUnitIds: completed.map(e => opaqueUnit(e.disposalUnitId)),
    officerId: string(officerId), role: 'privacy-officer', at: utc(at) });
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
