import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canonical, viewerJson, viewerUuid } from './viewer-input';

const invalid = (message = '소견 입력이 올바르지 않습니다'): never => { throw new BadRequestException(message); };

// Per-study lifetime bound enforced under the StudyState write lock (never recovered by hiding):
// min(revisions x snapshot, bytes) = min(4096 x 65536, 16 MiB) = 16 MiB, the viewer history order.
// A snapshot holds at most title 200 + text 4000 code points and 8 copied sources whose labels are
// bounded by the viewer's own 1000 code points; 3- and 4-byte UTF-8 maxima fit, only control-character
// saturated text can reach the 64 KiB cap and is then refused, not truncated.
// Version 2 adds up to 1000 code points of characteristics: 8 worst printable item sources then reach
// 60,640 bytes in jsonb spacing, and a saved job copy is smaller than an item copy. The 64 KiB cap stays
// authoritative and a larger snapshot is refused, never truncated.
export const FINDING_LIMITS = Object.freeze({ findings: 256, revisions: 4096, bytes: 16 * 1024 * 1024,
  snapshot: 65536, history: 1000, sources: 8, title: 200, text: 4000 });
export const FINDING_CHARACTERISTICS = 1000;
// Saved Comparison Job snapshot versions a finding may link, each with its validator, restorer and hosted
// suite. A later version stays unlinkable until it is added here and to the viewer's allowlist.
export const FINDING_JOB_VERSIONS: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

function object(value: any, required: string[], optional: string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function text(value: any, limit: number): string {
  if (typeof value !== 'string' || /[\u0000\uD800-\uDFFF]/u.test(value) || [...value].length > limit) invalid();
  return value;
}
function positive(value: any): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) invalid();
  return value;
}

export interface FindingSourceRef { itemId: string; revision: number }
/// A Saved Comparison Job anchored on the finding's study at metadata revision `revision`: the whole saved
/// view, or with `markId` one of its immutable version 6 3D points. `markId` is omitted, never undefined.
export interface FindingJobRef { jobId: string; revision: number; markId?: string }
export type FindingRef = FindingSourceRef | FindingJobRef;
/// Client-supplied part of a finding. Every copied field (kind, identity, values, digest, study set,
/// point, volume) is rejected here so a client can never present a forged number as provenance.
/// Version 1 is exactly the shipped shape (item pairs only); version 2 adds the required free-text
/// `characteristics` and job references.
export interface FindingItemInput { schemaVersion: 1 | 2; title: string; text: string; characteristics?: string; sources: FindingRef[]; primary: number }
export interface FindingCommand {
  requestId: string; expectedRevision?: number; action: 'create' | 'edit' | 'hide' | 'restore'; reason: string; item: FindingItemInput;
}
export const isJobRef = (ref: FindingRef): ref is FindingJobRef => Object.prototype.hasOwnProperty.call(ref, 'jobId');
// Frozen reuse key: an unchanged key keeps its copy byte for byte. Item keys are the shipped `<itemId>:<revision>`.
export function refKey(ref: FindingRef): string {
  return isJobRef(ref) ? 'job:' + ref.jobId + ':' + ref.revision + ':' + (ref.markId ?? '') : ref.itemId + ':' + ref.revision;
}
// The pair a stored copy was made from, in the exact client shape.
export function sourceRef(source: any): FindingRef {
  if (source?.kind !== 'job') return { itemId: source?.itemId, revision: source?.revision };
  return { jobId: source.jobId, revision: source.revision, ...(source.mark ? { markId: source.mark.id } : {}) };
}
function reference(source: any, version: 1 | 2, seen: Set<string>): FindingRef {
  if (version === 1 || !source || typeof source !== 'object' || Array.isArray(source) || !Object.prototype.hasOwnProperty.call(source, 'jobId')) {
    object(source, ['itemId', 'revision']);
    const itemId = viewerUuid(source.itemId);
    if (seen.has(itemId)) invalid('같은 표식을 두 번 연결할 수 없습니다');
    seen.add(itemId);
    return { itemId, revision: positive(source.revision) };
  }
  object(source, ['jobId', 'revision'], ['markId']);
  const jobId = viewerUuid(source.jobId), markId = Object.prototype.hasOwnProperty.call(source, 'markId') ? viewerUuid(source.markId) : undefined;
  const identity = 'job:' + jobId + ':' + (markId ?? '');
  if (seen.has(identity)) invalid('같은 표식을 두 번 연결할 수 없습니다');
  seen.add(identity);
  return { jobId, revision: positive(source.revision), ...(markId === undefined ? {} : { markId }) };
}
export function findingCommand(raw: Buffer, create: boolean): FindingCommand {
  const body = viewerJson(raw);
  object(body, create ? ['requestId', 'item'] : ['requestId', 'expectedRevision', 'action', 'item'], create ? [] : ['reason']);
  const action = create ? 'create' : body.action;
  if (!['create', 'edit', 'hide', 'restore'].includes(action) || (!create && action === 'create')) invalid();
  const reason = text(body.reason === undefined ? '' : body.reason, 1000);
  if ((action === 'hide' || action === 'restore') ? !reason.trim() : reason !== '') invalid('숨김/복원에는 사유가 필요합니다');
  const item = body.item;
  const version: 1 | 2 = item && typeof item === 'object' && !Array.isArray(item) && item.schemaVersion === 2 ? 2 : 1;
  if (version === 2) object(item, ['schemaVersion', 'title', 'text', 'characteristics', 'sources'], ['primary']);
  else {
    object(item, ['schemaVersion', 'title', 'text', 'sources'], ['primary']);
    if (item.schemaVersion !== 1) invalid();
  }
  if (!Array.isArray(item.sources) || item.sources.length < 1 || item.sources.length > FINDING_LIMITS.sources) invalid('소견에는 1~8개의 저장 표식을 연결합니다');
  const seen = new Set<string>();
  const sources: FindingRef[] = item.sources.map((source: any) => reference(source, version, seen));
  const primary = item.primary === undefined ? 0 : item.primary;
  if (!Number.isSafeInteger(primary) || primary < 0 || primary >= sources.length) invalid();
  const normalized: FindingItemInput = version === 1
    ? { schemaVersion: 1, title: text(item.title, FINDING_LIMITS.title), text: text(item.text, FINDING_LIMITS.text), sources, primary }
    : { schemaVersion: 2, title: text(item.title, FINDING_LIMITS.title), text: text(item.text, FINDING_LIMITS.text),
      characteristics: text(item.characteristics, FINDING_CHARACTERISTICS), sources, primary };
  return { requestId: viewerUuid(body.requestId), ...(create ? {} : { expectedRevision: positive(body.expectedRevision) }), action, reason, item: normalized };
}

// The fingerprint covers only what the client sent, so a replay after a source head changed
// still matches its original request and returns the recorded result.
export function findingFingerprint(studyUid: string, id: string | null, command: FindingCommand): string {
  const { requestId: _requestId, ...body } = command;
  return createHash('sha256').update(canonical({ studyUid, id, ...body })).digest('hex');
}

export function findingPage(query: any, revisions = false) {
  object(query, [], revisions ? ['limit', 'cursor'] : ['limit', 'cursor', 'includeHidden']);
  if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9]\d{0,2}$/.test(query.limit))) invalid();
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (limit > 100) invalid();
  let cursor: string | number | null = null;
  if (query.cursor !== undefined) cursor = revisions
    ? (typeof query.cursor === 'string' && /^[1-9]\d{0,9}$/.test(query.cursor) ? positive(Number(query.cursor)) : invalid()) : viewerUuid(query.cursor);
  if (query.includeHidden !== undefined && !['true', 'false'].includes(query.includeHidden)) invalid();
  return { limit, cursor, includeHidden: query.includeHidden === 'true' };
}

/// Server-copied provenance of one linked display item at link time. `label` holds the item
/// label, or the key image title; `values` are the completed baseline numbers or null.
/// `studyUid` is always copied from the item head. It is the finding's own (anchor) study or,
/// since S2-B2, the single comparison study that finding's whole revision lineage may link.
export interface FindingSource {
  itemId: string; revision: number; studyUid: string; kind: string; seriesUid: string; sopUid: string; frame: number;
  frameOfReferenceUid: string | null; label: string; values: number[] | null; calculator: string | null;
  sourceDigest: string | null; authorActor: string;
}
export function copySource(head: any): FindingSource {
  const item = head.snapshot ?? {};
  return { itemId: head.id, revision: head.revision, studyUid: head.studyUid, kind: item.kind, seriesUid: item.seriesUid,
    sopUid: item.sopUid, frame: item.frame, frameOfReferenceUid: item.frameOfReferenceUid ?? null,
    label: item.kind === 'key' ? item.title ?? '' : item.label ?? '', values: Array.isArray(item.baseline?.values) ? item.baseline.values : null,
    calculator: item.baseline?.calculator ?? null, sourceDigest: item.sourceDigest ?? null, authorActor: head.authorActor };
}
/// Distinct studies other than the anchor, in code-unit order. This order is for stable results
/// only; row locks follow the database's ORDER BY, never this sort. A missing or non-string
/// study reads as '', which no study row can match, so it stays unreadable.
export function comparisonStudies(anchor: string, studyUids: Iterable<unknown>): string[] {
  const found = new Set<string>();
  for (const uid of studyUids) if (uid !== anchor) found.add(typeof uid === 'string' ? uid : '');
  return [...found].sort();
}

export type LinkState = 'current' | 'revised' | 'hidden' | 'missing';
export function linkState(source: { itemId: string; revision: number; studyUid?: string }, head: any): LinkState {
  if (!head || head.id !== source.itemId || (source.studyUid !== undefined && head.studyUid !== source.studyUid)) return 'missing';
  if (head.hidden) return 'hidden';
  if (head.revision !== source.revision) return 'revised';
  return 'current';
}

/* ---------- S2-L1 saved locations ---------- */
/// Server-made copy of a Saved Comparison Job at link time. The job's image state is immutable, so the copy
/// names it (anchor, ordered study set, snapshot version) and only its title/author follow a metadata
/// revision. `studyUid` is the authorization projection (the comparison study when there is one) that
/// shipped readers already require; `jobStudyUid` and `studies` are the whole lineage the new readers
/// require. `mark` is a version 6 3D point with the identity of the volume it was placed on.
export interface FindingJobMark {
  id: string; label: string; point: number[];
  volume: { study: string; series: string; frameOfReferenceUid: string; sourceDigest: string; sopCount: number };
}
export interface FindingJobSource {
  kind: 'job'; jobId: string; revision: number; jobStudyUid: string; studyUid: string; studies: string[]; snapshotVersion: number;
  title: string; authorActor: string; mark: FindingJobMark | null;
}
const JOB_ABSENT = '연결할 저장 작업이 이 검사에 없습니다';
export const jobAbsent = (): never => { throw new NotFoundException(JOB_ABSENT); };
const jobMarkInvalid = (): never => {
  throw new BadRequestException({ code: 'FINDING_JOB_MARK', message: '저장 작업의 3D 표식과 볼륨 원본을 확인할 수 없어 연결하지 않았습니다' });
};
const uidLike = (value: any) => typeof value === 'string' && value.length >= 3 && value.length <= 64 && /^[0-9]+(?:\.[0-9]+)+$/.test(value);
/** W1-W3: a job anchored on `anchor` whose ordered study set starts there and holds one or two distinct studies.
 * Every other row (another anchor, a malformed set) is an unknown job with the same body and no further read. */
export function jobStudies(anchor: string, job: any): string[] {
  const studies = job?.studies;
  if (!job || job.studyUid !== anchor || !Array.isArray(studies) || studies.length < 1 || studies.length > 2 ||
      studies.some((uid: any) => typeof uid !== 'string' || !uid) || new Set(studies).size !== studies.length || studies[0] !== anchor) jobAbsent();
  return [...studies];
}
/** W4 on the immutable snapshot: a linkable version, and with `markId` a version 6 point on a volume of the
 * job's own studies with a complete source digest. Returns the point and its volume, or null for a saved view. */
export function jobMark(snapshot: any, studies: string[], markId: string | undefined) {
  if (!FINDING_JOB_VERSIONS.includes(snapshot?.version)) {
    throw new BadRequestException({ code: 'FINDING_JOB_VERSION', message: '이 판의 저장 작업은 소견에 연결할 수 없습니다' });
  }
  if (markId === undefined) return null;
  const volume = snapshot.volume, marks = snapshot.marks?.marks;
  const mark = snapshot.version === 6 && Array.isArray(marks) ? marks.find((m: any) => m?.id === markId) : undefined;
  if (!mark || typeof mark.label !== 'string' || !Array.isArray(mark.point) || mark.point.length !== 3 ||
      mark.point.some((n: any) => typeof n !== 'number' || !Number.isFinite(n)) || !volume || !studies.includes(volume.study) ||
      !uidLike(volume.series) || !Array.isArray(volume.sops) || volume.sops.length < 1 || !uidLike(volume.sops[0]) ||
      typeof volume.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(volume.sourceDigest)) jobMarkInvalid();
  return { id: mark.id as string, label: mark.label as string, point: [...mark.point] as number[],
    volume: { study: volume.study as string, series: volume.series as string, sop: volume.sops[0] as string, sourceDigest: volume.sourceDigest as string, sopCount: volume.sops.length as number } };
}
/** The Frame of Reference of the first original of a verified point volume, read after authorization. */
export function jobFrame(tags: any, volume: { study: string; series: string; sop: string }): string {
  if (!tags || tags.SOPInstanceUID !== volume.sop || tags.StudyInstanceUID !== volume.study || tags.SeriesInstanceUID !== volume.series ||
      !uidLike(tags.FrameOfReferenceUID)) throw new ConflictException('저장 작업의 볼륨 원본이 달라져 연결하지 않았습니다');
  return tags.FrameOfReferenceUID;
}
export function copyJob(job: any, studies: string[], snapshot: any, mark: ReturnType<typeof jobMark>, frameOfReferenceUid: string | null): FindingJobSource {
  return { kind: 'job', jobId: job.id, revision: job.revision, jobStudyUid: studies[0], studyUid: studies[1] ?? studies[0], studies: [...studies],
    snapshotVersion: snapshot.version, title: job.title, authorActor: job.authorActor,
    mark: mark === null ? null : { id: mark.id, label: mark.label, point: mark.point,
      volume: { study: mark.volume.study, series: mark.volume.series, frameOfReferenceUid: frameOfReferenceUid as string,
        sourceDigest: mark.volume.sourceDigest, sopCount: mark.volume.sopCount } } };
}
/** The immutable location of a job copy: a metadata refresh must reproduce it exactly. */
export function jobLocation(source: any): string {
  return canonical({ jobId: source?.jobId, jobStudyUid: source?.jobStudyUid, studyUid: source?.studyUid, studies: source?.studies ?? null,
    snapshotVersion: source?.snapshotVersion, mark: source?.mark ?? null });
}
/** The shape rule of a stored job copy (R6), the same rule the lineage SQL applies. */
export function jobShape(source: any): boolean {
  const studies = source?.studies;
  return Array.isArray(studies) && studies.length >= 1 && studies.length <= 2 && studies.every((uid: any) => typeof uid === 'string') &&
    new Set(studies).size === studies.length && studies[0] === source.jobStudyUid && source.studyUid === (studies[1] ?? studies[0]);
}
/** Every study a stored copy contributes to the lineage; a malformed job copy contributes the unreadable ''. */
export function sourceStudies(source: any): unknown[] {
  if (source?.kind !== 'job') return [source?.studyUid];
  return jobShape(source) ? [source.studyUid, ...source.studies, source.jobStudyUid] : [source?.studyUid, ''];
}
export type JobLinkState = 'current' | 'metadata-changed' | 'hidden' | 'missing';
export function jobLinkState(source: { jobId: string; revision: number; jobStudyUid: string }, head: any): JobLinkState {
  if (!head || head.id !== source.jobId || head.studyUid !== source.jobStudyUid) return 'missing';
  if (head.hidden) return 'hidden';
  if (head.revision !== source.revision) return 'metadata-changed';
  return 'current';
}
