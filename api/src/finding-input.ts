import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canonical, viewerJson, viewerUuid } from './viewer-input';

const invalid = (message = '소견 입력이 올바르지 않습니다'): never => { throw new BadRequestException(message); };

// Per-study lifetime bound enforced under the StudyState write lock (never recovered by hiding):
// min(revisions x snapshot, bytes) = min(4096 x 65536, 16 MiB) = 16 MiB, the viewer history order.
// A snapshot holds at most title 200 + text 4000 code points and 8 copied sources whose labels are
// bounded by the viewer's own 1000 code points; 3- and 4-byte UTF-8 maxima fit, only control-character
// saturated text can reach the 64 KiB cap and is then refused, not truncated.
export const FINDING_LIMITS = Object.freeze({ findings: 256, revisions: 4096, bytes: 16 * 1024 * 1024,
  snapshot: 65536, history: 1000, sources: 8, title: 200, text: 4000 });

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
/// Client-supplied part of a finding. Every copied field (kind, identity, values, digest) is
/// rejected here so a client can never present a forged number as provenance.
export interface FindingItemInput { schemaVersion: 1; title: string; text: string; sources: FindingSourceRef[]; primary: number }
export interface FindingCommand {
  requestId: string; expectedRevision?: number; action: 'create' | 'edit' | 'hide' | 'restore'; reason: string; item: FindingItemInput;
}
export function findingCommand(raw: Buffer, create: boolean): FindingCommand {
  const body = viewerJson(raw);
  object(body, create ? ['requestId', 'item'] : ['requestId', 'expectedRevision', 'action', 'item'], create ? [] : ['reason']);
  const action = create ? 'create' : body.action;
  if (!['create', 'edit', 'hide', 'restore'].includes(action) || (!create && action === 'create')) invalid();
  const reason = text(body.reason === undefined ? '' : body.reason, 1000);
  if ((action === 'hide' || action === 'restore') ? !reason.trim() : reason !== '') invalid('숨김/복원에는 사유가 필요합니다');
  const item = body.item;
  object(item, ['schemaVersion', 'title', 'text', 'sources'], ['primary']);
  if (item.schemaVersion !== 1) invalid();
  if (!Array.isArray(item.sources) || item.sources.length < 1 || item.sources.length > FINDING_LIMITS.sources) invalid('소견에는 1~8개의 저장 표식을 연결합니다');
  const seen = new Set<string>();
  const sources: FindingSourceRef[] = item.sources.map((source: any) => {
    object(source, ['itemId', 'revision']);
    const itemId = viewerUuid(source.itemId);
    if (seen.has(itemId)) invalid('같은 표식을 두 번 연결할 수 없습니다');
    seen.add(itemId);
    return { itemId, revision: positive(source.revision) };
  });
  const primary = item.primary === undefined ? 0 : item.primary;
  if (!Number.isSafeInteger(primary) || primary < 0 || primary >= sources.length) invalid();
  const normalized: FindingItemInput = { schemaVersion: 1, title: text(item.title, FINDING_LIMITS.title), text: text(item.text, FINDING_LIMITS.text), sources, primary };
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
