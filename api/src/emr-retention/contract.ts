import { createHash } from 'node:crypto';
import { ACCESS_ACTIONS, AccessAction, AccessEvent, NON_RECORD_TARGETS, parseAccessEvent } from '../emr-contract/access-event';
import { RECORD_CLASSIFICATION, RecordKind } from '../emr-contract/classification';
import { STATUTORY_MINIMUM } from '../emr-contract/legal-basis';
import { RetentionRecord, civilPeriodEnd, parseRetentionRecord } from '../emr-contract/lawful-defaults';
import { choice, freeze, object, refuse, string, utc } from '../emr-contract/validation';

/* EMR-H round 1: the vocabulary an erasure must reach and the access-ledger stream rule it consumes.
 * Nothing here deletes, schedules or obtains credentials (round 2 worker). Every rule only adds refusals
 * on top of the A contract; none of them can grant a destruction that A refuses. Periods always come from
 * A's civilPeriodEnd, so the calendar rule has one owner (legal register D-21).
 */

/** Every kind of place a copy can rest. A deployment registers each place it has; discovery reports the rest. */
export const LOCATION_CLASSES = freeze([
  'primary-database', 'database-replica', 'database-wal-archive', 'database-snapshot', 'access-ledger',
  'image-store', 'derivative-cache', 'object-store-version', 'backup-snapshot', 'offsite-backup', 'export-archive',
  'key-store', 'key-backup', 'staging', 'crash-dump', 'terminal-store', 'removable-media',
] as const);
export type LocationClass = typeof LOCATION_CLASSES[number];
/** Places that hold the legal original of a part (A: product version store and protected object store). */
export const ORIGINAL_CLASSES: readonly LocationClass[] = freeze(['primary-database', 'image-store', 'access-ledger']);
const KEY_CLASSES: readonly LocationClass[] = freeze(['key-store', 'key-backup']);

/** What one listed copy is. Owner, part, digest and stream come from storage, never from a request. */
export const COPY_CONTENTS = freeze([
  'record-part',        // the bytes of one version of a record (an access unit's part is its ledger entry)
  'signature-payload',  // the exact signed payload of one version; holds patient data, never kept as "evidence"
  'derived-copy',       // thumbnail, rendered frame, cache, print/PDF/download output of one version
  'reference-entry',    // one incorporation or navigation index row
  'source-mapping',     // disposal-unit or search mapping that re-identifies the unit
  'identity-evidence',  // signer registration, public key and revocation history (person-linked)
  'access-entry',       // one access-ledger event naming a record of the set
  'pending-original',   // a terminal-held original that has no durable server receipt yet
  'key-material',       // a key, or a recovery copy of a key, that opens containers
] as const);
export type CopyContent = typeof COPY_CONTENTS[number];

/** per-object: single objects/versions can be removed. per-container: only whole archives/dumps/snapshots can be
 * removed or replaced. none: write-once media; anything of an expired unit there blocks completion. */
export const LOCATION_DELETION = freeze(['per-object', 'per-container', 'none'] as const);
export type LocationDeletion = typeof LOCATION_DELETION[number];

export interface StorageLocation {
  locationId: string; locationClass: LocationClass; country: 'KR'; contents: readonly CopyContent[];
  deletion: LocationDeletion;
  /** I's evidence record for the real facility, domestic site, physical separation and processor contract. */
  facilityEvidenceId: string | null;
}
export interface LocationRegistry { formatVersion: 1; locations: readonly StorageLocation[] }

/** 고시 제2023-245호 별표1 4.3·별표2 4.3: the EMR system and its backups stay in Korea. No foreign or unknown site. */
export function parseLocationRegistry(input: unknown): Readonly<LocationRegistry> {
  const v = object(input, ['formatVersion', 'locations']);
  if (v.formatVersion !== 1) refuse('LocationRegistryInvalid');
  if (!Array.isArray(v.locations) || !v.locations.length) refuse('LocationRegistryInvalid');
  const locations = v.locations.map(raw => {
    const l = object(raw, ['locationId', 'locationClass', 'country', 'contents', 'deletion', 'facilityEvidenceId']);
    const locationClass = choice(l.locationClass, LOCATION_CLASSES);
    if (l.country !== 'KR') refuse('DomesticLocationRequired');
    if (!Array.isArray(l.contents) || !l.contents.length || new Set(l.contents).size !== l.contents.length) refuse('LocationRegistryInvalid');
    const contents = l.contents.map(c => choice(c, COPY_CONTENTS));
    // Keys live only in key places and terminal originals only on terminals, so neither hides inside a data listing.
    if (KEY_CLASSES.includes(locationClass) !== contents.includes('key-material') ||
        (KEY_CLASSES.includes(locationClass) && contents.length !== 1)) refuse('LocationContentRefused');
    if (contents.includes('pending-original') && locationClass !== 'terminal-store') refuse('LocationContentRefused');
    return { locationId: string(l.locationId), locationClass, country: 'KR' as const, contents,
      deletion: choice(l.deletion, LOCATION_DELETION), facilityEvidenceId: l.facilityEvidenceId === null ? null : string(l.facilityEvidenceId) };
  });
  if (new Set(locations.map(l => l.locationId)).size !== locations.length) refuse('LocationRegistryInvalid');
  if (!locations.some(l => ORIGINAL_CLASSES.includes(l.locationClass) && l.contents.includes('record-part'))) refuse('OriginalLocationRequired');
  return freeze({ formatVersion: 1 as const, locations });
}

/** Linked is the most software can say: I reviews the evidence; settings or CI never make a site compliant. */
export function institutionEvidenceStatus(registry: LocationRegistry): Readonly<{ status: 'missing' | 'linked'; missingLocationIds: readonly string[] }> {
  const parsed = parseLocationRegistry(registry);
  const missing = parsed.locations.filter(l => l.facilityEvidenceId === null).map(l => l.locationId).sort();
  return freeze({ status: missing.length ? 'missing' : 'linked', missingLocationIds: missing });
}

/** The access ledger's streams (legal register D-1 as revised in round 9, D-8). Computed when destruction is
 * attempted from the stored action/result/targets; no expiry is ever stored on an event row. */
export const ACCESS_STREAMS = freeze(['change-history', 'viewing', 'permission-history', 'non-record'] as const);
export type AccessStream = typeof ACCESS_STREAMS[number];
export const ACCESS_STREAM_RULE = freeze({
  // D-1 ①, PREDICTED-CONSERVATIVE (LR-11 §5-11): who changed a record, when, where and on what basis is that
  // record's change history (시행규칙 제16조①2·② 이력관리 장비). It leaves with the record's destruction set; the part
  // of its own two-year floor still running at that moment stays behind with the viewing stream's floor. Re-check
  // when 시행규칙 제16조② (above 제1177호) or the 고시 after 2023-245 is promulgated; a fixed period there is
  // applied as the longer of that period and this rule.
  'change-history': { clauseIds: [STATUTORY_MINIMUM.access.clauseId, 'medical:23.4'], years: STATUTORY_MINIMUM.access.years, withRecord: true },
  // D-1 ②: 제공·표시·출력·다운로드. 안전성 확보조치 기준 제8조①2 two-year floor; longer only under a hold.
  viewing: { clauseIds: [STATUTORY_MINIMUM.access.clauseId], years: STATUTORY_MINIMUM.access.years, withRecord: false },
  // D-8: 안전성 확보조치 기준 제5조③ "최소 3년간" for granting, changing or revoking access rights.
  'permission-history': { clauseIds: [STATUTORY_MINIMUM.access.clauseId, 'access-safety:5.3'], years: 3, withRecord: false },
  // Failures, sessions and other events without an EMR record: 제8조①2 two years.
  'non-record': { clauseIds: [STATUTORY_MINIMUM.access.clauseId], years: STATUTORY_MINIMUM.access.years, withRecord: false },
});

export interface AccessFacts {
  action: AccessAction; result: string; targets: readonly { kind: RecordKind; recordId: string | null }[];
}
const actions = Object.values(ACCESS_ACTIONS).flat() as readonly AccessAction[];
const kinds = Object.keys(RECORD_CLASSIFICATION) as RecordKind[];
/** One closed decision per event. Every successful write-family action changes a record's state (서명·공개·취소·
 * Addendum·보존 조치 alike), so it is change history; a read/export of a record is viewing. */
export function accessStream(input: AccessFacts): AccessStream {
  const action = choice(input.action, actions), result = string(input.result);
  if (!Array.isArray(input.targets)) refuse('AccessStreamFactsRequired');
  const targets = input.targets.map(t => ({ kind: choice(t.kind, kinds), recordId: t.recordId === null ? null : string(t.recordId) }));
  const emr = targets.filter(t => !NON_RECORD_TARGETS.includes(t.kind));
  const write = (ACCESS_ACTIONS.write as readonly string[]).includes(action) && result === 'succeeded';
  const read = (ACCESS_ACTIONS.read as readonly string[]).includes(action) || (ACCESS_ACTIONS.export as readonly string[]).includes(action);
  if (emr.length && (write || read) && emr.some(t => t.recordId === null)) refuse('AccessStreamFactsRequired');
  if (write && emr.length) return 'change-history';
  if (write && targets.some(t => t.kind === 'identity-access')) return 'permission-history';
  if (read && emr.length) return 'viewing';
  return 'non-record';
}
/** The stream's own floor. A's civilPeriodEnd owns the calendar (D-21), H only chooses the years. */
export function accessFloor(stream: AccessStream, occurredAt: string): string {
  return civilPeriodEnd(utc(occurredAt), ACCESS_STREAM_RULE[choice(stream, ACCESS_STREAMS)].years);
}
/** EMR records whose change history an event is. */
export function changedRecordIds(input: AccessFacts): readonly string[] {
  if (accessStream(input) !== 'change-history') return freeze([]);
  return freeze([...new Set(input.targets.filter(t => !NON_RECORD_TARGETS.includes(t.kind)).map(t => t.recordId as string))].sort());
}

export interface AccessUnitFacts { stream: AccessStream; floor: string; changedRecordIds: readonly string[] }
/** Binds an A access unit to its stored event by the digest A's access mapping recorded. */
export function accessUnitFacts(unit: RetentionRecord, storedEvent: unknown): Readonly<AccessUnitFacts> {
  const record = parseRetentionRecord(unit);
  if (record.parts.length !== 1 || record.kinds.length !== 1) refuse('AccessEventBindingRefused');
  const part = record.parts[0];
  // A delivery receipt is a provision of the pinned record (A maps disclosure/transfer to 열람): the viewing stream.
  if (record.kinds[0] === 'delivery-receipt') return freeze({ stream: 'viewing' as const, floor: accessFloor('viewing', part.startedAt), changedRecordIds: [] });
  if (record.kinds[0] !== 'access-audit') refuse('AccessEventBindingRefused');
  let event: Readonly<AccessEvent>;
  try { event = parseAccessEvent(storedEvent); } catch { refuse('AccessEventBindingRefused'); }
  const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex');
  if (event.eventId !== record.recordId || event.occurredAt !== part.startedAt || digest !== part.evidence.event.sha256) refuse('AccessEventBindingRefused');
  const facts: AccessFacts = { action: event.action, result: event.result,
    targets: event.targets.map(t => ({ kind: t.kind, recordId: t.recordId.status === 'known' ? t.recordId.value : null })) };
  const stream = accessStream(facts);
  return freeze({ stream, floor: accessFloor(stream, event.occurredAt), changedRecordIds: changedRecordIds(facts) });
}
