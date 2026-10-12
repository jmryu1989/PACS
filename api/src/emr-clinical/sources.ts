import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { ResolvedRecord, StoredRecordReader, resolveStoredRecord } from '../emr-contract/classification';
import { emrAdapters } from '../emr-contract/composition';
import { ContractError, freeze, refuse, string } from '../emr-contract/validation';

/**
 * EMR-D (DR2-05): what a clinical text incorporates - the measurement, key image or saved comparison a finding copies - is
 * a fixed reference to one immutable version of that source record: its record ID, the version and the SHA-256 of that
 * version's stored content, resolved by A (resolveStoredRecord) from the stored row. The same references go into the
 * plan, the author's signed payload, the version store's reference index (emr_clinical.attachment, which unit H's
 * retention lookup and the manual SR clean-up read) and the recovery of the original. A comparison study that is only
 * linked for navigation is not a source and gets no reference.
 *
 * A resolves through the one stored-record reader the server start composes (composeEmrAdapters). B's reader serves B's
 * own storage from a snapshot read under the caller's transaction; the sources live in the product's tables, so the
 * composition wraps B's reader with clinicalStoredReader: a source's event ID is answered only from the rows D read in the
 * caller's transaction for exactly that resolution (an AsyncLocalStorage frame); everything else goes to B's reader
 * unchanged. Outside such a frame a source is refused, never answered with a guess.
 *
 * The content digests: a viewer item revision is the canonical JSON of its stored snapshot; a saved comparison revision
 * is the canonical JSON of its immutable snapshot and study set with that revision's title, description and visibility.
 */
export type SourceRef = Readonly<{ kind: 'item'; itemId: string; revision: number } | { kind: 'job'; jobId: string; revision: number }>;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SOURCE_EVENT = new RegExp(`^viewer-(revision|job):(${UUID}):([1-9][0-9]{0,9})$`);
export function sourceEventId(ref: SourceRef): string {
  return ref.kind === 'item' ? `viewer-revision:${ref.itemId}:${ref.revision}` : `viewer-job:${ref.jobId}:${ref.revision}`;
}
/** The source a stored reference names (a recovery re-reads it), or null for any other stored record. */
export function sourceRefOf(recordId: string, eventId: string): SourceRef | null {
  const match = SOURCE_EVENT.exec(eventId);
  if (!match || match[2] !== recordId) return null;
  const revision = Number(match[3]);
  return freeze(match[1] === 'revision' ? { kind: 'item' as const, itemId: match[2], revision } : { kind: 'job' as const, jobId: match[2], revision });
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const digest = (value: unknown) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : string(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : refuse('ClinicalSourceRefused');
// The viewer's item kinds: a key image, or a manual geometry drawn by a person on the original image (AGENTS §7).
const ITEM_TYPES: Readonly<Record<string, 'measurement' | 'key-image'>> = freeze({ key: 'key-image', length: 'measurement', angle: 'measurement',
  ellipse: 'measurement', arrow: 'measurement' });
const ITEM_ACTS: Readonly<Record<string, string>> = freeze({ create: 'creation', edit: 'correction', hide: 'bookkeeping', restore: 'bookkeeping' });

function event(recordId: string, eventId: string, revision: number, sha256: string, at: string, act: string) {
  return { eventId, recordId, versionId: `revision:${revision}`, sha256, contentSha256: sha256, at, act, signature: null, predecessor: null,
    components: [], processing: null };
}
function itemRecord(ref: Extract<SourceRef, { kind: 'item' }>, row: any) {
  const snapshot = JSON.parse(string(row.snapshot)), revision = positive(row.revision);
  const type = Object.prototype.hasOwnProperty.call(ITEM_TYPES, snapshot?.kind) ? ITEM_TYPES[snapshot.kind] : refuse('ClinicalSourceRefused');
  const act = Object.prototype.hasOwnProperty.call(ITEM_ACTS, row.action) ? ITEM_ACTS[row.action] : refuse('ClinicalSourceRefused');
  // A reads a viewer record's type from row.snapshot.type; the product stores the item's geometry kind, mapped here.
  return { recordId: ref.itemId, model: 'ViewerRevision', row: { itemId: ref.itemId, revision, studyUid: string(row.studyUid), snapshot: { ...snapshot, type } },
    event: event(ref.itemId, sourceEventId(ref), revision, digest(snapshot), iso(row.at), act) };
}
function jobRecord(ref: Extract<SourceRef, { kind: 'job' }>, row: any) {
  const revision = positive(row.revision), snapshot = JSON.parse(string(row.snapshot));
  const content = { studyUid: string(row.studyUid), studies: [...row.studies].map(uid => string(uid)), snapshot, title: string(row.title, true),
    description: string(row.description, true), hidden: row.hidden === true };
  // No saved comparison carries a signed clinical adoption of its text (none exists in the product): it is a layout.
  return { recordId: ref.jobId, model: 'ViewerJobRevision', row: { jobId: ref.jobId, revision, ...content, clinicalEntry: false },
    event: event(ref.jobId, sourceEventId(ref), revision, digest(content), iso(row.at), revision === 1 ? 'creation' : 'correction') };
}

const frames = new AsyncLocalStorage<ReadonlyMap<string, unknown>>();
/** The stored-record reader the server start composes: D's sources from the current frame, anything else from `base`. */
export function clinicalStoredReader(base: StoredRecordReader): StoredRecordReader {
  if (!base || typeof base.load !== 'function') refuse('EmrAdapterRequired');
  return Object.freeze({
    load(recordId: string, eventId: string): unknown {
      if (typeof eventId === 'string' && SOURCE_EVENT.test(eventId)) {
        const loaded = frames.getStore()?.get(eventId);
        if (!loaded) refuse('ClinicalSourceRequired');
        return loaded;
      }
      return base.load(recordId, eventId);
    },
  });
}

function resolveAll(loaded: ReadonlyMap<string, unknown>, refs: readonly SourceRef[]): ResolvedRecord[] {
  try {
    return frames.run(loaded, () => refs.map(ref => resolveStoredRecord(emrAdapters().stored, ref.kind === 'item' ? ref.itemId : ref.jobId, sourceEventId(ref))));
  } catch (error) {
    // The composed reader does not serve D's sources (B's reader alone): nothing can be referenced, so nothing is written.
    if (error instanceof ContractError && ['EmrAdaptersRequired', 'EmrContextRequired', 'EmrRecordUnsupported', 'EmrContextRecordMissing',
      'ClinicalSourceRequired'].includes(error.code)) refuse('ClinicalSourcesNotComposed');
    throw error;
  }
}
/**
 * A's resolutions of the distinct source versions `refs` cite, in the order each is first cited, from the version rows the
 * caller read (services.ts readClinicalSources). Copies of one source version - two marks of one saved comparison, or the
 * saved view and a mark on it - are one fixed reference to that version (DR3-03): the text keeps every copy, the version
 * cites the record/version once.
 */
export function resolveSourceRows(refs: readonly SourceRef[], itemRows: readonly any[], jobRows: readonly any[]): readonly ResolvedRecord[] {
  const loaded = new Map<string, unknown>(), cited: SourceRef[] = [];
  for (const ref of refs) {
    if (loaded.has(sourceEventId(ref))) continue;
    const row = ref.kind === 'item' ? itemRows.find(r => r.itemId === ref.itemId && r.revision === ref.revision)
      : jobRows.find(r => r.jobId === ref.jobId && r.revision === ref.revision);
    if (!row) refuse('ClinicalSourceMissing');
    loaded.set(sourceEventId(ref), ref.kind === 'item' ? itemRecord(ref, row) : jobRecord(ref, row));
    cited.push(ref);
  }
  return Object.freeze(resolveAll(loaded, cited));
}

/** Server start: A's composed reader must serve D's sources, or the runtime is not composed (no write could cite one). */
export function requireClinicalSourceComposition(): void {
  const probe: SourceRef = { kind: 'item', itemId: '00000000-0000-4000-8000-000000000000', revision: 1 };
  const row = { itemId: probe.itemId, revision: 1, action: 'create', at: '2026-01-01T00:00:00.000Z', snapshot: '{"kind":"length"}', studyUid: '0.0' };
  const [resolved] = resolveSourceRows([probe], [row], []);
  if (!resolved.kinds.includes('measurement')) refuse('ClinicalSourcesNotComposed');
}
