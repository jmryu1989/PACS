/*
 * W5 Related Report 삽입(O4 R1, D1423)의 순수 규칙: `relatedInsert` 요청의 모양, 요청·제안의 SHA-256, 원문 판에서 삽입 글을
 * 다시 만드는 줄 규칙, 영수증의 답 모양. IO가 없다 — 잠금·읽기·쓰기는 `pacs/report-draft.ts`의 초안 트랜잭션 한 곳에 있다.
 * 따로 두는 이유는 책임이다: 이 파일은 "무엇이 같은 요청이고, 그 판에서 어떤 글이 나오며, 영수증이 무엇이라 답하는가"라는
 * 입력·digest·글·결과의 순수 규칙만 갖고, "언제 어떤 순서로 잠그고 무엇을 읽고 쓰는가"(트랜잭션 IO)는 초안 concern이 갖는다.
 * 인용의 `report-citation.ts`·구조화의 `report-structure.ts`가 같은 나눔이다 — 규칙은 DB 없이 그 자체로 읽히고 시험된다.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { DraftOwner } from './pacs/values';

/** 요청 digest의 첫 칸. 직렬화 규칙을 바꾸면 이 값도 바꾼다 — 옛 영수증과 새 요청이 우연히 같은 digest가 되지 않게. */
export const RELATED_INSERT_SCHEMA = 'related-insert-v1';
const PROPOSAL_SCHEMA = 'related-insert-proposal-v1';
/** 영수증에 남는 업무 거절 사유. migration의 CHECK와 같은 닫힌 목록이다. */
export const RELATED_INSERT_REFUSALS = Object.freeze(['DRAFT_CONFLICT', 'TARGET_UNVERIFIED', 'TARGET_HELD', 'SOURCE_UNAVAILABLE',
  'SOURCE_CHANGED', 'SEED_CHANGED'] as const);
export type RelatedInsertRefusal = typeof RELATED_INSERT_REFUSALS[number];
const SOURCE_FIELDS = ['findings', 'conclusion', 'recommendation'] as const;
type SourceField = typeof SOURCE_FIELDS[number];
const TARGET_SECTIONS = ['findings', 'conclusion'];
const SEED_KINDS = ['private-draft', 'report-head', 'empty'];
const KEYS = ['intent', 'insertRequestId', 'source', 'targetUid', 'targetBaseVersion', 'section', 'position', 'offset', 'text',
  'selectionSeq', 'contentRevision', 'sourceGeneration', 'seedKind'];
/** 소문자 정규형만 받는다. PostgreSQL uuid는 대소문자를 접어 같은 행을 돌려주므로, 대문자 별칭이 같은 ID가 되면 안 된다. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STUDY_UID = /^[0-9]+(\.[0-9]+)*$/;
const INT_MAX = 2147483647;

export interface RelatedInsertPart { field: SourceField; start: number; end: number }
export interface RelatedInsertRequest {
  intent: 'apply' | 'discard';
  insertRequestId: string;
  source: { uid: string; version: number; action: 'approve' | 'addendum'; parts: RelatedInsertPart[] };
  targetUid: string; targetBaseVersion: number; section: 'findings' | 'conclusion'; position: 'end'; offset: number; text: string;
  selectionSeq: number; contentRevision: number; sourceGeneration: number; seedKind: 'private-draft' | 'report-head' | 'empty';
  expectedReceiptRevision: number | null;
}
export interface RelatedProposal { findings: string; conclusion: string; recommendation: string; baseVersion: number;
  citationIds: string[]; structureIds: string[] }

export const relatedInsertInvalid = (field: string) => new BadRequestException({ code: 'RELATED_INSERT_INVALID', field,
  message: `관련 판독문 삽입 요청의 ${field} 값이 잘못되었습니다. 삽입할 글을 다시 확인하세요.` });

const plain = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const closed = (value: Record<string, any>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
const count = (value: unknown, min: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= INT_MAX;

/**
 * `relatedInsert`의 모양. 어떤 읽기보다 먼저 본다 — 거절은 검사·초안·영수증을 읽거나 쓰지 않는다.
 * 같은 ID로 다시 보내는 요청은 처음 것과 바이트까지 같아야 하므로, 모르는 칸·빠진 칸은 "그대로 두라"가 아니라 거절이다.
 * `expectedReceiptRevision`은 취소(discard)에만 있다 — 적용 요청에 실리면 그 값이 어디에도 쓰이지 않는 채 통과한다.
 */
export function relatedInsertInput(raw: unknown, uid: string, snapshot: { baseVersion: number },
    expected: { revision: number }): RelatedInsertRequest {
  if (!plain(raw)) throw relatedInsertInvalid('relatedInsert');
  if (raw.intent !== 'apply' && raw.intent !== 'discard') throw relatedInsertInvalid('intent');
  if (!closed(raw, raw.intent === 'discard' ? [...KEYS, 'expectedReceiptRevision'] : KEYS)) throw relatedInsertInvalid('relatedInsert');
  if (typeof raw.insertRequestId !== 'string' || !REQUEST_ID.test(raw.insertRequestId)) throw relatedInsertInvalid('insertRequestId');
  const source = raw.source;
  if (!plain(source) || !closed(source, ['uid', 'version', 'action', 'parts'])) throw relatedInsertInvalid('source');
  if (typeof source.uid !== 'string' || source.uid.length > 64 || !STUDY_UID.test(source.uid)) throw relatedInsertInvalid('source.uid');
  if (!count(source.version, 1)) throw relatedInsertInvalid('source.version');
  if (source.action !== 'approve' && source.action !== 'addendum') throw relatedInsertInvalid('source.action');
  // 확인창에 보인 순서(findings → conclusion → recommendation), 칸마다 비어 있지 않은 범위 하나.
  if (!Array.isArray(source.parts) || !source.parts.length || source.parts.length > SOURCE_FIELDS.length)
    throw relatedInsertInvalid('source.parts');
  let previous = -1;
  const parts = source.parts.map((part: unknown) => {
    if (!plain(part) || !closed(part, ['field', 'start', 'end'])) throw relatedInsertInvalid('source.parts');
    const at = SOURCE_FIELDS.indexOf(part.field);
    if (at <= previous || !count(part.start, 0) || !count(part.end, 1) || part.end <= part.start) throw relatedInsertInvalid('source.parts');
    previous = at;
    return { field: part.field as SourceField, start: part.start as number, end: part.end as number };
  });
  // Target은 경로의 검사다. 본문의 값은 대조만 한다 — 다른 검사를 가리키는 요청은 이 경로의 것이 아니다.
  if (raw.targetUid !== uid) throw relatedInsertInvalid('targetUid');
  if (!count(raw.targetBaseVersion, 0) || raw.targetBaseVersion !== snapshot.baseVersion) throw relatedInsertInvalid('targetBaseVersion');
  if (!TARGET_SECTIONS.includes(raw.section)) throw relatedInsertInvalid('section');
  if (raw.position !== 'end') throw relatedInsertInvalid('position');
  if (!count(raw.offset, 0)) throw relatedInsertInvalid('offset');
  // 빈 삽입·공백뿐인 삽입은 어떤 쓰기보다 먼저 거절한다. textarea의 줄바꿈은 LF뿐이다.
  if (typeof raw.text !== 'string' || !/\S/.test(raw.text) || raw.text.includes('\r')) throw relatedInsertInvalid('text');
  for (const field of ['selectionSeq', 'contentRevision', 'sourceGeneration'])
    if (!Number.isSafeInteger(raw[field]) || raw[field] < 0) throw relatedInsertInvalid(field);
  if (!SEED_KINDS.includes(raw.seedKind)) throw relatedInsertInvalid('seedKind');
  // 적용될 revision(expectedRevision + 1)이 Int를 넘으면 첫 쓰기 전에 거절한다.
  if (expected.revision >= INT_MAX) throw relatedInsertInvalid('expectedRevision');
  if (raw.intent === 'discard' && !count(raw.expectedReceiptRevision, 1)) throw relatedInsertInvalid('expectedReceiptRevision');
  return { intent: raw.intent, insertRequestId: raw.insertRequestId,
    source: { uid: source.uid, version: source.version as number, action: source.action, parts },
    targetUid: uid, targetBaseVersion: raw.targetBaseVersion as number, section: raw.section, position: 'end', offset: raw.offset as number,
    text: raw.text, selectionSeq: raw.selectionSeq, contentRevision: raw.contentRevision, sourceGeneration: raw.sourceGeneration,
    seedKind: raw.seedKind, expectedReceiptRevision: raw.intent === 'discard' ? raw.expectedReceiptRevision as number : null };
}

/** Check의 `insertRequestId` 질의. 반복(`?id=a&id=b`)·빈 값·대문자 별칭은 읽기 전에 거절한다. */
export function relatedInsertId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw relatedInsertInvalid('insertRequestId');
  return value;
}

/** 근거 ID 목록은 집합이다(기존 sameSnapshot과 같은 뜻): 중복은 거절하고, digest에는 정렬해 싣는다. */
export function relatedEvidenceIds(body: { citationIds: string[]; structureIds: string[] }) {
  for (const field of ['citationIds', 'structureIds'] as const)
    if (new Set(body[field]).size !== body[field].length) throw relatedInsertInvalid(field);
  return { citationIds: [...body.citationIds], structureIds: [...body.structureIds] };
}

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const sorted = (ids: string[]) => [...ids].sort();
const proposalTuple = (p: RelatedProposal) =>
  [PROPOSAL_SCHEMA, p.findings, p.conclusion, p.recommendation, p.baseVersion, sorted(p.citationIds), sorted(p.structureIds)];
/** 제안 초안 전체(본문 세 칸, 기준 판, 두 ID 집합)의 digest. 본문은 영수증에 싣지 않는다. */
export const relatedProposalHash = (p: RelatedProposal) => sha256(proposalTuple(p));

/**
 * 고정 요청의 digest. 칸의 순서가 곧 계약이다(R1 hash_contract): 표식, ID, 서버가 확인한 owner, 경로의 Target, 처음 CAS,
 * Source의 판·행위·범위, Target 기준과 seed 종류, 칸·끝 위치·글, 화면의 세 세대, 제안 전체. `intent`·`expectedReceiptRevision`과
 * 전송·세션 ID는 넣지 않는다 — 같은 삽입의 적용과 취소가 같은 요청이어야 취소가 그 삽입을 가리킨다.
 */
export function relatedRequestHash(r: RelatedInsertRequest, owner: DraftOwner, expected: { epoch: string; revision: number },
    proposal: RelatedProposal): string {
  return sha256([RELATED_INSERT_SCHEMA, r.insertRequestId, owner.institution, owner.sub, owner.author, r.targetUid,
    expected.epoch, expected.revision, r.source.uid, r.source.version, r.source.action, r.source.parts.map(p => [p.field, p.start, p.end]),
    r.targetBaseVersion, r.seedKind, r.section, r.position, r.offset, r.text, r.selectionSeq, r.contentRevision, r.sourceGeneration,
    proposalTuple(proposal)]);
}

const lf = (text: unknown) => String(text ?? '').replace(/\r\n?/g, '\n');
const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const splits = (text: string, at: number) => at > 0 && at < text.length && high(text.charCodeAt(at - 1)) && low(text.charCodeAt(at));

/**
 * 원문 판의 고른 범위를 표시 순서대로 이은 삽입 글(R1 source_target_validation의 줄 규칙). 범위는 그 칸의 LF 글 위의 UTF-16
 * 위치다. seed 칸이 비었거나 LF로 끝나면 앞에 아무것도 붙이지 않고, 아니면 LF 하나를 붙인다. 칸은 빈 줄 하나('\n\n')로 잇는다.
 * trim·Unicode 정규화는 하지 않는다. 범위가 그 칸 밖이거나 한 문자를 가르면 null이다(그 글은 확인창에 보일 수 없었다).
 */
export function relatedInsertionText(version: Record<SourceField, unknown>, parts: RelatedInsertPart[], seed: string): string | null {
  const blocks: string[] = [];
  for (const part of parts) {
    const text = lf(version[part.field]);
    if (part.end > text.length || splits(text, part.start) || splits(text, part.end)) return null;
    blocks.push(text.slice(part.start, part.end));
  }
  return (seed === '' || seed.endsWith('\n') ? '' : '\n') + blocks.join('\n\n');
}

/** 영수증 행이 이 owner·이 Target의 것인가. 다른 사람·다른 검사의 행은 그 내용을 한 칸도 답하지 않는다. */
export const relatedOwnReceipt = (row: any, owner: DraftOwner, uid: string) => row.ownerInstitution === owner.institution
  && row.ownerSub === owner.sub && row.ownerAuthor === owner.author && row.targetUid === uid;

/** 영수증 행이 바로 이 고정 요청의 것인가. digest만 믿지 않고 행에 남은 결속 칸도 함께 대조한다. */
export function relatedSameBinding(row: any, owner: DraftOwner, uid: string, r: RelatedInsertRequest,
    expected: { epoch: string; revision: number }, requestHash: string, proposalHash: string): boolean {
  return relatedOwnReceipt(row, owner, uid) && row.requestHash === requestHash && row.proposalHash === proposalHash
    && row.expectedEpoch === expected.epoch && row.expectedRevision === expected.revision && row.sourceUid === r.source.uid
    && row.sourceVersion === r.source.version && row.targetBaseVersion === r.targetBaseVersion && row.section === r.section;
}

/** 요청한 쪽이 아는 것: 자기 요청의 digest와 처음 CAS. 영수증이 없거나 남의 것일 때 답은 이것만 싣는다. */
export interface RelatedAsked { requestHash: string; proposalHash: string; expected: { epoch: string; revision: number };
  proposal: RelatedProposal }
interface Envelope { revision: string; present: boolean; snapshot: { findings: string; conclusion: string; recommendation: string;
  baseVersion: number; citations: string[]; structured: string[] } | null }

const sameIds = (a: string[], b: string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
/** 지금 저장된 초안(봉투의 스냅숏)이 그 제안과 본문까지 같은가. */
function sameProposal(snapshot: Envelope['snapshot'], proposal: RelatedProposal): boolean {
  return !!snapshot && snapshot.findings === proposal.findings && snapshot.conclusion === proposal.conclusion
    && snapshot.recommendation === proposal.recommendation && snapshot.baseVersion === proposal.baseVersion
    && sameIds(snapshot.citations, proposal.citationIds) && sameIds(snapshot.structured, proposal.structureIds);
}

/**
 * 답의 `relatedInsert` (R1 server_result). revision은 모두 `세대:번호` 문자열이고 없는 값은 null이다.
 *  applied  영수증이 applied이고, 지금 초안이 그 세대의 appliedRevision이며, 지금 스냅숏의 digest가 영수증의 제안 digest와
 *           같다(요청 본문이 있으면 본문도 같다). 이때만 화면이 저장됨으로 올릴 수 있다.
 *  unknown  영수증이 없거나, applied였지만 그 뒤 초안이 바뀌었거나 비워졌거나 세대가 바뀌었다(state applied, SUPERSEDED).
 *           옛 제안으로 되돌리지 않는다 — 과거 적용과 지금 저장 확인은 다른 사실이다.
 *  refused  영속 거절(state refused, 같은 ID로 다시 시도·취소 가능), 취소 표식(state discarded), 남의 ID(ID_REUSED).
 */
export function relatedResult(insertRequestId: string, row: any, envelope: Envelope, mine: boolean, asked: RelatedAsked | null) {
  const own = { requestHash: asked?.requestHash ?? null, proposalHash: asked?.proposalHash ?? null,
    expectedRevision: asked ? `${asked.expected.epoch}:${asked.expected.revision}` : null, appliedRevision: null, receiptRevision: null,
    currentMatches: false, discardable: false };
  if (!row) return { insertRequestId, result: 'unknown', state: null, ...own, reason: 'RECEIPT_ABSENT' };
  if (!mine) return { insertRequestId, result: 'refused', state: null, ...own, reason: 'ID_REUSED' };
  const applied = row.appliedRevision === null || row.appliedRevision === undefined ? null : `${row.expectedEpoch}:${row.appliedRevision}`;
  const stored = { requestHash: row.requestHash, proposalHash: row.proposalHash, expectedRevision: `${row.expectedEpoch}:${row.expectedRevision}`,
    appliedRevision: applied, receiptRevision: row.receiptRevision };
  if (row.state === 'applied') {
    const snapshot = envelope.present ? envelope.snapshot : null;
    const current = !!snapshot && envelope.revision === applied
      && relatedProposalHash({ ...snapshot, citationIds: snapshot.citations, structureIds: snapshot.structured }) === row.proposalHash
      && (!asked || sameProposal(snapshot, asked.proposal));
    return { insertRequestId, result: current ? 'applied' : 'unknown', state: 'applied', ...stored, currentMatches: current,
      discardable: false, reason: current ? null : 'SUPERSEDED' };
  }
  if (row.state === 'refused')
    return { insertRequestId, result: 'refused', state: 'refused', ...stored, currentMatches: false, discardable: true, reason: row.reason };
  return { insertRequestId, result: 'refused', state: 'discarded', ...stored, currentMatches: false, discardable: false,
    reason: 'INSERT_DISCARDED' };
}

/**
 * 200이 아닌 답. PUT의 200은 "이 제안이 지금 저장된 초안이다"(apply) 또는 "이 삽입은 취소 표식이 됐다"(discard)일 때뿐이고,
 * 나머지는 409다 — 영수증이 이 호출자의 것이면 그 상태(`relatedInsert`)와 지금 초안 봉투를 함께 싣는다. 문구에 '저장했습니다'를
 * 넣지 않는다(옛 탭이 그 부분 문자열로 서버 글을 편집기에 덮는 복구 분기로 들어간다).
 */
const MESSAGES: Record<string, string> = {
  RELATED_INSERT_REFUSED: '관련 판독문 삽입이 적용되지 않았습니다 — 사유를 확인한 뒤 같은 삽입을 다시 시도하거나 취소하세요.',
  RELATED_INSERT_DISCARDED: '이 삽입은 취소되었습니다 — 다시 넣지 않았습니다.',
  RELATED_INSERT_SUPERSEDED: '이 삽입은 이미 적용됐지만 그 뒤 초안이 바뀌었습니다 — 지금 서버의 초안을 확인하세요.',
  RELATED_INSERT_NOT_DISCARDABLE: '거절된 삽입만 취소할 수 있습니다 — 삽입 상태를 확인하세요.',
  RELATED_INSERT_RECEIPT_CHANGED: '삽입 상태가 그 사이 바뀌었습니다 — 상태를 확인한 뒤 다시 취소하세요.',
};
export const relatedInsertRefusal = (code: keyof typeof MESSAGES, envelope: object, relatedInsert: object) =>
  new ConflictException({ code, message: MESSAGES[code], ...envelope, relatedInsert });
/** 같은 ID가 다른 owner·Target·요청에 이미 쓰였다. 그 행의 내용도, 적용 여부도 말하지 않는다. */
export const relatedInsertIdReused = () => new ConflictException({ code: 'ID_REUSED',
  message: '이 삽입 ID는 다른 요청에 이미 쓰였습니다 — 삽입을 새로 시작하세요.' });
