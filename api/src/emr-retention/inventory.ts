import { emrAdapters } from '../emr-contract/composition';
import { BatchDisposalAuditStore, DisposalAuditStore, DisposalRequest, RetentionGraph, RetentionRecord, parseRetentionRecord,
  retentionState } from '../emr-contract/lawful-defaults';
import { choice, freeze, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';
import { ACCESS_STREAMS, AccessFacts, AccessStream, COPY_CONTENTS, CopyContent, LocationClass, LocationDeletion, LocationRegistry,
  ORIGINAL_CLASSES, accessFloor, accessStream, accessUnitFacts, changedRecordIds, institutionEvidenceStatus, parseLocationRegistry } from './contract';

/* EMR-H round 1: the complete copy inventory of one destruction set, its ownership/copy distinction, the fixed plan,
 * and the post-erasure verification. Reads go only through readers bound once at server composition. A failed or
 * partial reading is an explicit incomplete state, never an empty list.
 */

/** What a listing is asked about. A location answers with everything it holds that belongs to, names, contains,
 * replaces or opens the scope: record-owned copies of recordIds, index rows/events/evidence naming them, the
 * containers holding them (with a complete count of the other records inside), containers declared as replacing
 * containerIds, and key copies of keyIds. complete:true means nothing in scope was left unread (for terminals: every
 * device that ever received scope data has reported). */
export interface InventoryScope { recordIds: readonly string[]; keyIds: readonly string[]; containerIds: readonly string[]; at: string }
export interface LocationReader {
  /** Every storage place actually present, found independently of the registry. */
  discover(at: string): unknown;
  list(locationId: string, scope: Readonly<InventoryScope>): unknown;
}
/** The stored access event behind an A access unit (B's ledger), read to bind its stream. */
export interface AccessEventReader { load(eventId: string): unknown }
export interface RetentionReaders { locations: LocationReader; accessEvents: AccessEventReader }

let composed: Readonly<{ registry: Readonly<LocationRegistry>; locations: LocationReader; accessEvents: AccessEventReader }> | undefined;
/** Server startup only, beside A's adapter composition. A request can neither shrink the registry nor swap a reader. */
export function composeRetentionReaders(input: RetentionReaders, registry: unknown): void {
  if (composed) refuse('RetentionReadersAlreadyComposed');
  const parsed = parseLocationRegistry(registry);
  const l = input?.locations, e = input?.accessEvents;
  if (!l || typeof l.discover !== 'function' || typeof l.list !== 'function' || !e || typeof e.load !== 'function') refuse('RetentionReadersRequired');
  composed = freeze({ registry: parsed, locations: { discover: l.discover.bind(l), list: l.list.bind(l) }, accessEvents: { load: e.load.bind(e) } });
}
function readers() {
  if (!composed) refuse('RetentionReadersRequired');
  return composed;
}

/** Closed reason codes. incomplete: the inventory cannot be judged; retained: a retention rule still runs;
 * blocked: storage cannot erase it as required. Reasons name places, never records or patients. */
export const REASONS = freeze({
  incomplete: ['LocationDiscoveryFailed', 'UnregisteredLocation', 'RegisteredLocationNotFound', 'LocationListingFailed',
    'LocationListingIncomplete', 'LocationListingStale', 'OwnerUnknown', 'DuplicateCopy', 'ContentNotRegistered', 'ContainerRequired',
    'ContainerUnknown', 'ContainerInconsistent', 'KeyUnknown', 'PartUnknown', 'PartHashMismatch', 'OriginalMissing',
    'SignaturePayloadMissing', 'ReferenceEntryMissing', 'ReferenceNotInSnapshot', 'AccessStreamMismatch', 'AccessEventUnavailable',
    'AccessEventBindingRefused', 'HoldRequestUnavailable'],
  retained: ['ChangeHistoryFollowsRecord', 'AccessFloorNotElapsed', 'UnresolvedRequestHold', 'RetentionBoundaryActive'],
  blocked: ['PendingOriginalNotDurable', 'ImmutableLocation', 'LiveIncorporator'],
  partial: ['CopyRemains', 'ContainerRemains', 'KeyRemains', 'ReplacementUnverified'],
  failed: ['ExpiredDataInReplacement', 'ReplacementUsesErasedKey', 'LiveDataLost', 'LiveKeyLost', 'RetainedCopyLost'],
} as const);
type ReasonCode = typeof REASONS[keyof typeof REASONS][number];
export interface Reason { code: ReasonCode; locationId: string | null }
function category(code: ReasonCode): keyof typeof REASONS {
  return (Object.keys(REASONS) as (keyof typeof REASONS)[]).find(k => (REASONS[k] as readonly string[]).includes(code));
}
function note(reasons: Reason[], code: ReasonCode, locationId: string | null = null): void {
  if (!reasons.some(r => r.code === code && r.locationId === locationId)) reasons.push({ code, locationId });
}

interface Copy {
  locationId: string; locationClass: LocationClass; deletion: LocationDeletion; copyId: string; content: CopyContent;
  containerId: string | null; owner: string | null; partId: string | null; sha256: string | null;
  reference: { fromRecordId: string; fromPartId: string; toRecordId: string; toPartId: string; relation: 'incorporation' | 'navigation' } | null;
  dependents: readonly string[] | null; keyId: string | null; protects: readonly string[] | null;
  access: { stream: AccessStream; occurredAt: string; facts: AccessFacts } | null;
}
interface RestoreCheck { checkedAt: string; outcome: 'restored' | 'failed'; signatures: 'verified' | 'failed'; permissions: 'verified' | 'failed'; missingLive: number }
interface Container {
  locationId: string; locationClass: LocationClass; deletion: LocationDeletion; containerId: string;
  scopeMembers: readonly string[]; otherMembers: number; keyIds: readonly string[]; replaces: readonly string[];
  restoreExcludes: readonly string[]; restoreCheck: RestoreCheck | null;
}
const COPY_FIELDS: Readonly<Record<CopyContent, readonly string[]>> = freeze({
  'record-part': ['copyId', 'content', 'recordId', 'partId', 'sha256', 'containerId'],
  'signature-payload': ['copyId', 'content', 'recordId', 'partId', 'sha256', 'containerId'],
  'derived-copy': ['copyId', 'content', 'recordId', 'partId', 'containerId'],
  'pending-original': ['copyId', 'content', 'recordId', 'partId', 'containerId'],
  'source-mapping': ['copyId', 'content', 'recordId', 'containerId'],
  'reference-entry': ['copyId', 'content', 'fromRecordId', 'fromPartId', 'toRecordId', 'toPartId', 'relation', 'containerId'],
  'identity-evidence': ['copyId', 'content', 'registrationId', 'dependents', 'containerId'],
  'access-entry': ['copyId', 'content', 'eventId', 'stream', 'occurredAt', 'action', 'result', 'targets', 'containerId'],
  'key-material': ['copyId', 'content', 'keyId', 'protects'],
});
const RECORD_OWNED: readonly CopyContent[] = freeze(['record-part', 'signature-payload', 'derived-copy', 'pending-original', 'source-mapping']);
const PART_BOUND: readonly CopyContent[] = freeze(['record-part', 'signature-payload', 'derived-copy', 'pending-original']);
function ids(value: unknown, nonEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (nonEmpty && !value.length) || new Set(value).size !== value.length) throw new Error('Distinct identifiers required');
  return value.map(v => string(v));
}
function nullable<T>(value: unknown, parse: (v: unknown) => T): T | null { return value === null ? null : parse(value); }

interface Snapshot { copies: Copy[]; containers: Container[] }
function readSnapshot(scope: Readonly<InventoryScope>, reasons: Reason[]): Snapshot {
  const { registry, locations } = readers();
  const snapshot: Snapshot = { copies: [], containers: [] };
  try {
    const d = object(locations.discover(scope.at), ['checkedAt', 'complete', 'locationIds']);
    if (d.complete !== true || utc(d.checkedAt) !== scope.at) note(reasons, 'LocationDiscoveryFailed');
    else {
      const found = ids(d.locationIds), known = registry.locations.map(l => l.locationId);
      for (const id of found) if (!known.includes(id)) note(reasons, 'UnregisteredLocation', id);
      for (const id of known) if (!found.includes(id)) note(reasons, 'RegisteredLocationNotFound', id);
    }
  } catch { note(reasons, 'LocationDiscoveryFailed'); }
  // Key places answer for the keys the data places named, so they are read second.
  const data = registry.locations.filter(l => !l.contents.includes('key-material'));
  for (const location of data) readListing(location, scope, reasons, snapshot);
  const keyIds = [...new Set([...scope.keyIds, ...snapshot.containers.flatMap(c => c.keyIds)])].sort();
  const containerIds = [...new Set([...scope.containerIds, ...snapshot.containers.map(c => c.containerId)])].sort();
  const keyScope = freeze({ ...scope, keyIds, containerIds });
  for (const location of registry.locations.filter(l => l.contents.includes('key-material'))) readListing(location, keyScope, reasons, snapshot);
  return snapshot;
}
function readListing(location: LocationRegistry['locations'][number], scope: Readonly<InventoryScope>, reasons: Reason[], into: Snapshot): void {
  const at = location.locationId;
  let raw: unknown;
  try { raw = readers().locations.list(location.locationId, scope); } catch { note(reasons, 'LocationListingFailed', at); return; }
  const copies: Copy[] = [], containers: Container[] = [], local: Reason[] = [];
  try {
    const l = object(raw, ['locationId', 'checkedAt', 'complete', 'copies', 'containers', 'unattributed']);
    if (l.locationId !== location.locationId) throw new Error('Listing for another location');
    if (l.complete !== true) { note(reasons, 'LocationListingIncomplete', at); return; }
    if (utc(l.checkedAt) !== scope.at) { note(reasons, 'LocationListingStale', at); return; }
    if (integer(l.unattributed) > 0) note(local, 'OwnerUnknown', at);
    if (!Array.isArray(l.containers) || !Array.isArray(l.copies)) throw new Error('Listing arrays required');
    for (const value of l.containers) {
      const c = object(value, ['containerId', 'scopeMembers', 'otherMembers', 'keyIds', 'replaces', 'restoreExcludes', 'restoreCheck']);
      const container: Container = { locationId: at, locationClass: location.locationClass, deletion: location.deletion,
        containerId: string(c.containerId), scopeMembers: ids(c.scopeMembers), otherMembers: integer(c.otherMembers), keyIds: ids(c.keyIds),
        replaces: ids(c.replaces), restoreExcludes: ids(c.restoreExcludes), restoreCheck: nullable(c.restoreCheck, r => {
          const v = object(r, ['checkedAt', 'outcome', 'signatures', 'permissions', 'missingLive']);
          return { checkedAt: utc(v.checkedAt), outcome: choice(v.outcome, ['restored', 'failed']), signatures: choice(v.signatures, ['verified', 'failed']),
            permissions: choice(v.permissions, ['verified', 'failed']), missingLive: integer(v.missingLive) };
        }) };
      if (containers.some(x => x.containerId === container.containerId)) note(local, 'DuplicateCopy', at);
      if (container.scopeMembers.some(m => !scope.recordIds.includes(m)) || container.restoreExcludes.some(m => !container.scopeMembers.includes(m)))
        note(local, 'ContainerInconsistent', at);
      if (!container.scopeMembers.length && !container.replaces.some(id => scope.containerIds.includes(id))) note(local, 'OwnerUnknown', at);
      containers.push(container);
    }
    for (const value of l.copies) {
      const content = choice(value?.content, COPY_CONTENTS);
      const v = object(value, COPY_FIELDS[content]);
      const copy: Copy = { locationId: at, locationClass: location.locationClass, deletion: location.deletion, copyId: string(v.copyId), content,
        containerId: content === 'key-material' ? null : nullable(v.containerId, string),
        owner: RECORD_OWNED.includes(content) ? string(v.recordId) : null,
        partId: PART_BOUND.includes(content) ? string(v.partId) : null,
        sha256: ['record-part', 'signature-payload'].includes(content) ? sha256(v.sha256) : null,
        reference: content === 'reference-entry' ? { fromRecordId: string(v.fromRecordId), fromPartId: string(v.fromPartId),
          toRecordId: string(v.toRecordId), toPartId: string(v.toPartId), relation: choice(v.relation, ['incorporation', 'navigation']) } : null,
        dependents: content === 'identity-evidence' ? (string(v.registrationId), ids(v.dependents, true)) : null,
        keyId: content === 'key-material' ? string(v.keyId) : null,
        protects: content === 'key-material' ? ids(v.protects, true) : null,
        access: content === 'access-entry' ? accessOf(v) : null };
      if (!location.contents.includes(content)) note(local, 'ContentNotRegistered', at);
      if (copies.some(x => x.copyId === copy.copyId)) note(local, 'DuplicateCopy', at);
      if (copy.containerId !== null) {
        const container = containers.find(c => c.containerId === copy.containerId);
        if (!container) note(local, 'ContainerUnknown', at);
        else if (copy.owner !== null && !container.scopeMembers.includes(copy.owner)) note(local, 'ContainerInconsistent', at);
      } else if (location.deletion === 'per-container' && content !== 'key-material') note(local, 'ContainerRequired', at);
      if (copy.access && accessStream(copy.access.facts) !== copy.access.stream) note(local, 'AccessStreamMismatch', at);
      if (!namesScope(copy, scope)) note(local, 'OwnerUnknown', at);
      copies.push(copy);
    }
  } catch { note(reasons, 'LocationListingFailed', at); return; }
  local.forEach(r => note(reasons, r.code, r.locationId));
  into.copies.push(...copies); into.containers.push(...containers);
}
function accessOf(v: Record<string, any>): Copy['access'] {
  string(v.eventId);
  if (!Array.isArray(v.targets)) throw new Error('Access targets required');
  const facts: AccessFacts = { action: v.action, result: string(v.result), targets: v.targets.map(t => {
    const target = object(t, ['kind', 'recordId']);
    return { kind: target.kind, recordId: nullable(target.recordId, string) };
  }) };
  accessStream(facts);
  return { stream: choice(v.stream, ACCESS_STREAMS), occurredAt: utc(v.occurredAt), facts };
}
function namesScope(copy: Copy, scope: Readonly<InventoryScope>): boolean {
  const inScope = (id: string | null) => id !== null && scope.recordIds.includes(id);
  if (copy.owner !== null) return inScope(copy.owner);
  if (copy.reference) return inScope(copy.reference.fromRecordId) || inScope(copy.reference.toRecordId);
  if (copy.dependents) return copy.dependents.some(inScope);
  if (copy.access) return copy.access.facts.targets.some(t => inScope(t.recordId));
  return scope.keyIds.includes(copy.keyId) || copy.protects.some(id => scope.containerIds.includes(id));
}

export type ItemDisposition = 'erase' | 'retain-other-record' | 'retain-shared-evidence' | 'retain-viewing-remainder' | 'retain-stream-floor' | 'blocked';
/** Ownership/copy distinction for one copy, at the time the set is destroyed. */
function disposition(copy: Copy, set: ReadonlySet<string>, at: string, reasons: Reason[]): ItemDisposition {
  switch (copy.content) {
    case 'pending-original':
      // Grant expiry, logout or expiry never authorize erasing an original the server has not durably received.
      note(reasons, 'PendingOriginalNotDurable', copy.locationId); return 'blocked';
    case 'reference-entry':
      if (set.has(copy.reference.fromRecordId)) return 'erase';
      if (copy.reference.relation === 'navigation') return 'retain-other-record';
      note(reasons, 'LiveIncorporator', copy.locationId); return 'blocked';
    case 'identity-evidence':
      // Kept until the longest-living record whose signature needs it is gone; never kept for expired payloads.
      return copy.dependents.every(id => set.has(id)) ? 'erase' : 'retain-shared-evidence';
    case 'access-entry': {
      const { stream, occurredAt, facts } = copy.access;
      if (stream !== 'change-history') return 'retain-stream-floor';
      if (!changedRecordIds(facts).every(id => set.has(id))) return 'retain-other-record';
      return accessFloor(stream, occurredAt) <= at ? 'erase' : 'retain-viewing-remainder';
    }
    default: return 'erase';
  }
}

export interface PlannedItem { locationId: string; locationClass: LocationClass; copyId: string; content: CopyContent; containerId: string | null; disposition: ItemDisposition }
export interface PlannedContainer {
  containerId: string; locationIds: readonly string[]; locationClasses: readonly LocationClass[];
  /** Replacement keys must preserve the old container's registered key/recovery locations. */
  keyLocationIds: readonly string[]; disposition: 'erase-container' | 'replace-container';
}
export interface PlannedKey { keyId: string; locationIds: readonly string[]; locationClasses: readonly LocationClass[]; disposition: 'erase' | 'retain-live-key' }
export interface ErasureAssessment {
  formatVersion: 1; at: string; recordIds: readonly string[];
  status: 'erasable' | 'incomplete' | 'retained' | 'blocked';
  reasons: readonly Reason[];
  items: readonly PlannedItem[]; containers: readonly PlannedContainer[]; keys: readonly PlannedKey[];
  institutionEvidence: Readonly<{ status: 'missing' | 'linked'; missingLocationIds: readonly string[] }>;
}
const assessments = new WeakSet<object>();
const STATUS_ORDER = ['incomplete', 'retained', 'blocked'] as const;

/** Assess one destruction set (a unit or a whole SCC) against the snapshot A checks under the same lock. */
export function assessErasure(units: readonly RetentionRecord[], graph: RetentionGraph, at: string): Readonly<ErasureAssessment> {
  const time = utc(at);
  if (!Array.isArray(units) || !units.length) refuse('ErasureSetRequired');
  const records = units.map(u => parseRetentionRecord(u)), recordIds = records.map(r => r.recordId).sort();
  if (new Set(recordIds).size !== recordIds.length) refuse('ErasureSetRequired');
  if (records.some(r => r.destroyedAt !== null)) refuse('RecordDestroyed');
  let g: Record<string, any>;
  try { g = object(graph, ['records', 'references', 'complete', 'revision', 'checkedAt']); } catch { refuse('ReferenceSnapshotRequired'); }
  if (g.complete !== true || !Array.isArray(g.records) || !Array.isArray(g.references)) refuse('ReferenceSnapshotIncomplete');
  if (g.checkedAt !== time || records.some(r => JSON.stringify(g.records.find(x => x?.recordId === r.recordId)) !== JSON.stringify(r)))
    refuse('ReferenceSnapshotStale');
  const set: ReadonlySet<string> = new Set(recordIds), reasons: Reason[] = [];
  for (const record of records) {
    const state = retentionState(record, graph, time);
    if (state.destroyNotBefore === null || time < state.destroyNotBefore) note(reasons, 'RetentionBoundaryActive');
    requestHolds(record, time, reasons);
    accessUnit(record, time, reasons);
  }
  const snapshot = readSnapshot(freeze({ recordIds, keyIds: [], containerIds: [], at: time }), reasons);
  coverage(records, g.references, snapshot, reasons);
  const items: PlannedItem[] = snapshot.copies.filter(c => c.content !== 'key-material').map(copy => {
    let d = disposition(copy, set, time, reasons);
    if (d === 'erase' && copy.containerId === null && copy.deletion === 'none') { note(reasons, 'ImmutableLocation', copy.locationId); d = 'blocked'; }
    return { locationId: copy.locationId, locationClass: copy.locationClass, copyId: copy.copyId, content: copy.content, containerId: copy.containerId, disposition: d };
  });
  const containers: PlannedContainer[] = [...new Set(snapshot.containers.map(c => c.containerId))].sort().map(containerId => {
    const facts = snapshot.containers.filter(c => c.containerId === containerId);
    const members = (c: Container) => JSON.stringify([ [...c.scopeMembers].sort(), c.otherMembers, [...c.keyIds].sort() ]);
    if (facts.some(c => members(c) !== members(facts[0])))
      note(reasons, 'ContainerInconsistent', facts[0].locationId);
    for (const c of facts) if (c.deletion === 'none') note(reasons, 'ImmutableLocation', c.locationId);
    // Live data or anything still retained inside makes the container a replacement, never a deletion.
    const live = facts.some(c => c.otherMembers > 0) || items.some(i => i.containerId === containerId && i.disposition !== 'erase');
    const keyLocationIds = [...new Set(snapshot.copies.filter(c => c.content === 'key-material' &&
      facts.some(f => f.keyIds.includes(c.keyId))).map(c => c.locationId))].sort();
    return { containerId, locationIds: facts.map(c => c.locationId).sort(), locationClasses: [...new Set(facts.map(c => c.locationClass))].sort(), keyLocationIds,
      disposition: live ? 'replace-container' as const : 'erase-container' as const };
  });
  const removed = containers.map(c => c.containerId);
  const keyCopies = snapshot.copies.filter(c => c.content === 'key-material');
  for (const keyId of new Set(snapshot.containers.flatMap(c => c.keyIds))) if (!keyCopies.some(k => k.keyId === keyId)) note(reasons, 'KeyUnknown');
  const keys: PlannedKey[] = [...new Set(keyCopies.map(k => k.keyId))].sort().map(keyId => {
    const copies = keyCopies.filter(k => k.keyId === keyId), protects = [...new Set(copies.flatMap(k => k.protects))];
    // A key that still opens any kept container is retained: shredding it would lose live data (ops_export_crypto boundary).
    return { keyId, locationIds: copies.map(k => k.locationId).sort(), locationClasses: [...new Set(copies.map(k => k.locationClass))].sort(),
      disposition: protects.every(id => removed.includes(id)) ? 'erase' as const : 'retain-live-key' as const };
  });
  const status: ErasureAssessment['status'] = STATUS_ORDER.find(s => reasons.some(r => category(r.code) === s)) ?? 'erasable';
  const result = freeze({ formatVersion: 1 as const, at: time, recordIds, status, reasons, items, containers, keys,
    institutionEvidence: institutionEvidenceStatus(readers().registry) });
  assessments.add(result);
  return result;
}
/** L5-06 guard: a request hold released at its old until never frees a record whose request is still unresolved. */
function requestHolds(record: Readonly<RetentionRecord>, at: string, reasons: Reason[]): void {
  for (const hold of record.holds) {
    if (!['pending-access-request', 'statutory-duty'].includes(hold.basis.type)) continue;
    let resolution: Record<string, any> | null;
    try {
      const legal = emrAdapters().legal;
      const load = hold.basis.type === 'statutory-duty' ? legal.loadCorrectionRequest : legal.loadAccessRequest;
      const r = object(load(hold.basis.requestId), ['requestId', 'recordIds', 'receivedAt', 'responseDueAt', 'resolution']);
      if (r.requestId !== hold.basis.requestId || !ids(r.recordIds, true).includes(record.recordId) ||
          utc(r.receivedAt) > at || utc(r.responseDueAt) < r.receivedAt) throw new Error('Request binding');
      resolution = nullable(r.resolution, v => object(v, ['eventId', 'at', 'outcome']));
      if (resolution) {
        string(resolution.eventId); string(resolution.outcome);
        if (utc(resolution.at) < r.receivedAt) throw new Error('Resolution before request');
      }
    } catch { note(reasons, 'HoldRequestUnavailable'); continue; }
    if (resolution === null || resolution.at > at) note(reasons, 'UnresolvedRequestHold');
  }
}
/** An access unit leaves only by its stream: change history goes with its record's set, never alone. */
function accessUnit(record: Readonly<RetentionRecord>, at: string, reasons: Reason[]): void {
  if (!['access-audit', 'delivery-receipt'].includes(record.kinds[0])) return;
  let stored: unknown = null;
  if (record.kinds[0] === 'access-audit') {
    try { stored = readers().accessEvents.load(record.recordId); } catch { note(reasons, 'AccessEventUnavailable'); return; }
  }
  let facts: ReturnType<typeof accessUnitFacts>;
  try { facts = accessUnitFacts(record, stored); } catch { note(reasons, 'AccessEventBindingRefused'); return; }
  if (facts.stream === 'change-history') note(reasons, 'ChangeHistoryFollowsRecord');
  else if (at < facts.floor) note(reasons, 'AccessFloorNotElapsed');
}
function coverage(records: readonly Readonly<RetentionRecord>[], references: readonly any[], snapshot: Snapshot, reasons: Reason[]): void {
  const byId = new Map(records.map(r => [r.recordId, r]));
  for (const copy of snapshot.copies) {
    if (copy.owner === null || !byId.has(copy.owner) || copy.partId === null) continue;
    const part = byId.get(copy.owner).parts.find(p => p.partId === copy.partId);
    if (!part) note(reasons, 'PartUnknown', copy.locationId);
    else if (copy.sha256 !== null && copy.sha256 !== part.evidence.event.sha256) note(reasons, 'PartHashMismatch', copy.locationId);
  }
  const originals = snapshot.copies.filter(c => ORIGINAL_CLASSES.includes(c.locationClass));
  for (const record of records) for (const part of record.parts) {
    const has = (content: CopyContent) => originals.some(c => c.content === content && c.owner === record.recordId && c.partId === part.partId);
    if (!has('record-part')) note(reasons, 'OriginalMissing');
    if (part.evidence.event.signature !== null && !has('signature-payload')) note(reasons, 'SignaturePayloadMissing');
  }
  // The index read under the lock and the snapshot A checked must name the same references: a reference added
  // since (a concurrent incorporation) or one the index lost stops the set before anything starts.
  const key = (r: Record<string, any>) => JSON.stringify([r.fromRecordId, r.fromPartId, r.toRecordId, r.toPartId, r.relation]);
  const expected = new Set(references.filter(r => byId.has(r?.fromRecordId) || byId.has(r?.toRecordId)).map(key));
  const listed = new Set(originals.filter(c => c.reference).map(c => key(c.reference)));
  for (const k of expected) if (!listed.has(k)) note(reasons, 'ReferenceEntryMissing');
  for (const k of listed) if (!expected.has(k)) note(reasons, 'ReferenceNotInSnapshot');
}

export function requireErasable(input: ErasureAssessment): Readonly<ErasureAssessment> {
  if (!assessments.has(input)) refuse('ErasureAssessmentRequired');
  if (input.status === 'incomplete') refuse('InventoryIncomplete');
  if (input.status === 'retained') refuse('RetentionRuleActive');
  if (input.status === 'blocked') refuse('ErasureBlocked');
  return input;
}

const fixedPlans = new Set<{ graph: string; assessment: Readonly<ErasureAssessment> }>();
type GatedStore = Partial<Pick<DisposalAuditStore, 'append' | 'withRetentionLock'> & Pick<BatchDisposalAuditStore, 'withRetentionBatchLock'>>;
/** Wraps B's lock so the inventory is read and judged under it before A writes any started record. Units A will
 * refuse (not due, held) skip the reading and reach A's own refusal; no plan is fixed for them. */
export function inventoryGate(store: GatedStore): Readonly<GatedStore> {
  const gated: GatedStore = {};
  if (typeof store?.append === 'function') gated.append = store.append.bind(store);
  if (typeof store?.withRetentionLock === 'function')
    gated.withRetentionLock = (recordId, at, work) => store.withRetentionLock(recordId, at, current => gatedWork([recordId], at, current, work));
  if (typeof store?.withRetentionBatchLock === 'function')
    gated.withRetentionBatchLock = (recordIds, at, work) => store.withRetentionBatchLock(recordIds, at, current => gatedWork(recordIds, at, current, work));
  return freeze(gated);
}
async function gatedWork<T>(recordIds: readonly string[], at: string, current: RetentionGraph, work: (graph: RetentionGraph) => Promise<T>): Promise<T> {
  const time = utc(at);
  if (!Array.isArray(recordIds) || !recordIds.length || new Set(recordIds).size !== recordIds.length) refuse('ErasureSetRequired');
  if (!current || !Array.isArray(current.records)) refuse('ReferenceSnapshotRequired');
  const units = recordIds.map(id => current.records.find(r => r?.recordId === string(id)));
  if (units.some(u => !u || u.destroyedAt !== null)) refuse('ReferenceSnapshotStale');
  const due = units.every(unit => {
    const state = retentionState(unit, current, time);
    return state.destroyNotBefore !== null && time >= state.destroyNotBefore;
  });
  if (!due) return work(current);
  // A calls the worker once per SCC. A shared backup cannot be split into independent per-record plans.
  // R1 accepts one SCC; R2 must coordinate durable fences and replacements across a multi-SCC batch.
  for (const id of recordIds) {
    const reached = new Set([id]);
    for (const from of reached) for (const ref of current.references)
      if (ref.relation === 'incorporation' && ref.fromRecordId === from && recordIds.includes(ref.toRecordId)) reached.add(ref.toRecordId);
    if (reached.size !== recordIds.length) refuse('SingleDisposalSetRequired');
  }
  const assessment = requireErasable(assessErasure(units, current, time));
  const entry = { graph: JSON.stringify(current), assessment };
  fixedPlans.add(entry);
  try { return await work(current); } finally { fixedPlans.delete(entry); }
}
/** The destroy callback reads the plan fixed under its own lock; outside a gated lock there is no plan. */
export function fixedErasurePlan(requests: readonly Readonly<DisposalRequest>[]): Readonly<ErasureAssessment> {
  if (!Array.isArray(requests) || !requests.length) refuse('ErasurePlanRequired');
  const graph = JSON.stringify(requests[0].graph), wanted = requests.map(r => r.record.recordId);
  if (new Set(wanted).size !== wanted.length || requests.some(r => JSON.stringify(r.graph) !== graph)) refuse('ErasurePlanRequired');
  const matches = [...fixedPlans].filter(p => p.graph === graph && wanted.length === p.assessment.recordIds.length &&
    wanted.every(id => p.assessment.recordIds.includes(id)));
  if (matches.length !== 1) refuse('ErasurePlanRequired');
  return matches[0].assessment;
}

export interface ErasureVerification {
  formatVersion: 1; at: string; status: 'verified' | 'partial' | 'unverified' | 'failed';
  reasons: readonly Reason[]; remaining: readonly { locationId: string; id: string; kind: 'copy' | 'container' | 'key' }[];
}
const verifications = new WeakMap<object, Readonly<ErasureAssessment>>();
function restored(check: RestoreCheck | null, from: string, to: string): boolean {
  return !!check && check.outcome === 'restored' && check.signatures === 'verified' && check.permissions === 'verified' &&
    check.missingLive === 0 && check.checkedAt >= from && check.checkedAt <= to;
}
/** Re-reads every place after the worker ran. Physical presence decides: a restore filter, a dropped row or a
 * missing completion record changes nothing. Idempotent; remaining is exactly what a resumed run still has to do. */
export function verifyErasure(input: ErasureAssessment, at: string): Readonly<ErasureVerification> {
  if (!assessments.has(input) || input.status !== 'erasable') refuse('ErasableAssessmentRequired');
  const time = utc(at);
  if (time < input.at) refuse('VerificationTimeInvalid');
  const set: ReadonlySet<string> = new Set(input.recordIds), reasons: Reason[] = [];
  const planned = input.containers.map(c => c.containerId);
  const erasedKeys = input.keys.filter(k => k.disposition === 'erase').map(k => k.keyId);
  const keptKeys = input.keys.filter(k => k.disposition !== 'erase').map(k => k.keyId);
  const snapshot = readSnapshot(freeze({ recordIds: input.recordIds, keyIds: input.keys.map(k => k.keyId), containerIds: planned, at: time }), reasons);
  const remaining: { locationId: string; id: string; kind: 'copy' | 'container' | 'key' }[] = [];
  // Container membership cannot hide expired evidence or a new incoming incorporation listed inside it.
  for (const copy of snapshot.copies) {
    const still = copy.content === 'key-material' ? erasedKeys.includes(copy.keyId) : disposition(copy, set, input.at, reasons) === 'erase';
    if (still && copy.containerId !== null) {
      const container = snapshot.containers.find(c => c.containerId === copy.containerId && c.locationId === copy.locationId);
      if (container && !container.scopeMembers.some(m => set.has(m))) note(reasons, 'ContainerInconsistent', copy.locationId);
      if (container && !planned.includes(container.containerId) && container.replaces.some(id => planned.includes(id)))
        note(reasons, 'ExpiredDataInReplacement', copy.locationId);
    }
    // Whole-container remnants are reported once below so a resumed worker does not try per-object deletion.
    if (still && copy.containerId === null) { remaining.push({ locationId: copy.locationId, id: copy.copyId, kind: copy.content === 'key-material' ? 'key' : 'copy' });
      note(reasons, copy.content === 'key-material' ? 'KeyRemains' : 'CopyRemains', copy.locationId); }
    if (copy.content === 'pending-original') note(reasons, 'PendingOriginalNotDurable', copy.locationId);
  }
  for (const item of input.items.filter(i => i.containerId === null && i.disposition !== 'erase')) {
    if (!snapshot.copies.some(c => c.locationId === item.locationId && c.copyId === item.copyId && c.content === item.content))
      note(reasons, 'RetainedCopyLost', item.locationId);
  }
  for (const container of snapshot.containers) {
    const members = container.scopeMembers;
    if (!members.some(m => set.has(m))) continue;
    if (!planned.includes(container.containerId) && container.replaces.some(id => planned.includes(id))) note(reasons, 'ExpiredDataInReplacement', container.locationId);
    else { remaining.push({ locationId: container.locationId, id: container.containerId, kind: 'container' }); note(reasons, 'ContainerRemains', container.locationId); }
  }
  for (const old of input.containers.filter(c => c.disposition === 'replace-container')) {
    const present = snapshot.containers.some(c => c.containerId === old.containerId);
    const candidates = snapshot.containers.filter(c => c.replaces.includes(old.containerId) && !planned.includes(c.containerId));
    for (const c of candidates) if (c.keyIds.some(k => erasedKeys.includes(k))) note(reasons, 'ReplacementUsesErasedKey', c.locationId);
    // A prior successful restore cannot prove that today's replacement key and its recovery copies still exist.
    for (const c of candidates) for (const keyId of c.keyIds) {
      const copies = snapshot.copies.filter(k => k.content === 'key-material' && k.keyId === keyId);
      if (!copies.length || copies.some(k => !k.protects.includes(c.containerId)) ||
          old.keyLocationIds.some(locationId => !copies.some(k => k.locationId === locationId)))
        note(reasons, 'LiveKeyLost', c.locationId);
    }
    for (const locationId of old.locationIds) {
      const here = candidates.filter(c => c.locationId === locationId);
      const good = here.length > 0 && here.every(c => restored(c.restoreCheck, input.at, time) &&
        !c.scopeMembers.some(m => set.has(m)) && !c.keyIds.some(k => erasedKeys.includes(k)));
      if (!good) note(reasons, present ? 'ReplacementUnverified' : 'LiveDataLost', locationId);
    }
  }
  for (const keyId of keptKeys) if (!snapshot.copies.some(c => c.content === 'key-material' && c.keyId === keyId)) note(reasons, 'LiveKeyLost');
  const status = reasons.some(r => category(r.code) === 'failed') ? 'failed' as const :
    reasons.some(r => category(r.code) === 'incomplete') ? 'unverified' as const :
    reasons.length ? 'partial' as const : 'verified' as const;
  const result = freeze({ formatVersion: 1 as const, at: time, status, reasons, remaining });
  verifications.set(result, input);
  return result;
}

export interface ErasureSummary {
  formatVersion: 1; day: string; verifiedAt: string; units: number; method: 'irreversible-permanent-deletion';
  locations: readonly { locationClass: LocationClass; erasedCopies: number; erasedContainers: number; replacedContainers: number; erasedKeys: number }[];
  institutionEvidence: 'missing' | 'linked';
}
/** H's completion record next to A's DestructionRecord: kind, count, time and method only. No record, part, patient,
 * copy, container or key identifier and no digest: those are the re-identifying mapping erased with the set. */
export function erasureSummary(verification: ErasureVerification): Readonly<ErasureSummary> {
  const assessment = verifications.get(verification);
  if (!assessment || verification.status !== 'verified') refuse('VerifiedErasureRequired');
  const classes = [...new Set([...assessment.items.map(i => i.locationClass), ...assessment.containers.flatMap(c => c.locationClasses),
    ...assessment.keys.flatMap(k => k.locationClasses)])].sort();
  const locations = classes.map(locationClass => ({ locationClass,
    erasedCopies: assessment.items.filter(i => i.locationClass === locationClass && i.containerId === null && i.disposition === 'erase').length,
    erasedContainers: assessment.containers.filter(c => c.disposition === 'erase-container' && c.locationClasses.includes(locationClass)).length,
    replacedContainers: assessment.containers.filter(c => c.disposition === 'replace-container' && c.locationClasses.includes(locationClass)).length,
    erasedKeys: assessment.keys.filter(k => k.disposition === 'erase' && k.locationClasses.includes(locationClass)).length }));
  return freeze({ formatVersion: 1 as const, day: new Date(Date.parse(verification.at) + 9 * 3_600_000).toISOString().slice(0, 10),
    verifiedAt: verification.at, units: assessment.recordIds.length, method: 'irreversible-permanent-deletion' as const, locations,
    institutionEvidence: assessment.institutionEvidence.status });
}
