import { FINDING_LIMITS } from './finding-input';

/**
 * 판독문 인용의 **순수 규칙** — 줄 블록 일치, 존재 상태, 유지·제거 목록, 한도.
 *
 * 왜 별도 파일인가: 같은 정의를 서버 검사기와 (나중의) 화면 비교기가 따로 구현한다.
 * 두 구현이 갈라지면 사람은 "같은 문장인데 한쪽은 있다고 하고 한쪽은 없다고 한다"를 본다.
 * 그래서 이 규칙들은 Nest·Prisma를 모르고, 컴파일된 채로 직접 불릴 수 있으며,
 * **하나의 벡터 파일**(`tests/report_citation_vectors.json`)이 양쪽의 신탁이다.
 *
 * 저장하는 것은 동결 사본이 아니라 포인터 + 서버 증언이다. 동결 사본은 이미
 * `FindingRevision(findingId, revision).snapshot.sources[sourceIndex]`에 불변으로 있다.
 */

/**
 * 한도. 64 × 4096 > 65536이므로 **총합이 구속 조건**이다.
 * `bytes`는 PostgreSQL이 세는 canonical `jsonb::text`의 UTF-8 바이트다 — JS의 더 짧은
 * 표현으로 재면 DB CHECK보다 느슨해져서 CHECK가 500으로 새어 나간다. 재는 일은 DB가 한다.
 */
export const REPORT_CITATION_LIMITS = Object.freeze({ entries: 64, bytes: 65536, insertedText: 4096 });
export const REPORT_CITATION_FIELDS = Object.freeze(['findings', 'conclusion', 'recommendation'] as const);
export type ReportCitationField = typeof REPORT_CITATION_FIELDS[number];
/** 저장 형식의 판. `Finding.snapshot`의 schemaVersion과 별개다. */
export const REPORT_CITATION_SCHEMA = 2;
/** 화면이 읽을 수 없는 건에 다는 단 하나의 중립 상태. 거절인지 부재인지 말하지 않는다. */
export const SOURCE_UNAVAILABLE = 'source-unavailable';

/**
 * 모양이 틀린 요청. 호출자가 400으로 옮긴다 — 이 파일은 Nest를 모르는 채로 남아야
 * 컴파일된 상태에서 그대로 단위 시험에 불려 나올 수 있다.
 */
export class CitationInputError extends Error {}

export interface ReportCitationInsert {
  field: ReportCitationField;
  findingId: string;
  findingRevision: number;
  sourceIndex: number;
  insertedText: string;
  expectedLinkState: string;
  expectedHeadRevision: number | null;
}

/**
 * 비교할 때만 쓰는 정규화. **저장된 바이트는 정규화하지 않는다** — 의무기록의 글자를
 * 바꾸는 일이기 때문이다. CRLF와 **홀로 있는 CR**까지 LF로 모으고 NFC로 맞춘다.
 * 같은 등식이 `k`(본문 출현 수)와 `sameTextCount`(같은 글 인용 수) 양쪽에 쓰인다.
 */
export function normalizeForCompare(text: string): string {
  return String(text ?? '').replace(/\r\n?/g, '\n').normalize('NFC');
}

/**
 * 줄 블록 = 한 줄 이상의 **연속된 완전한 줄**.
 *
 * 블록 끝의 LF는 빈 줄이 아니라 마지막 줄의 **종결자**다. 그러지 않으면 사용자가
 * 삽입된 문장 바로 아래에 이어 치는 순간 `present`가 `absent`로 뒤집힌다 — 아무것도
 * 지우지 않았는데 "넣은 문장이 사라졌습니다"라고 말하게 된다.
 */
export function blockLines(block: string): string[] {
  const lines = normalizeForCompare(block).split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 한 칸 안에서 그 줄 블록이 **겹치지 않게** 몇 번 나오는지. 부분 문자열 일치는 쓰지 않는다 —
 * 더 긴 토큰 안의 조각이나 부정 접두사가 붙은 줄을 "그대로 있다"고 말하면 안 되기 때문이다.
 */
export function lineBlockOccurrences(body: string, block: string): number {
  // 공백만인 블록은 **아무것도 세지 않는다.** `[""]`로 세면 본문의 빈 줄 하나가
  // "넣은 문장이 그대로 있습니다"를 참으로 만든다.
  if (blockIsBlank(block)) return 0;
  const want = blockLines(block);
  if (!want.length) return 0;
  const lines = normalizeForCompare(body).split('\n');
  let count = 0;
  for (let i = 0; i + want.length <= lines.length;) {
    let hit = true;
    for (let j = 0; j < want.length; j++) if (lines[i + j] !== want[j]) { hit = false; break; }
    if (hit) { count += 1; i += want.length; } else i += 1;
  }
  return count;
}

/**
 * 공백만인 블록은 **서버에서도** 거절한다. 그러지 않으면 아무 빈 줄이나 조건을 만족시켜
 * "이 문장은 본문에 있습니다"가 언제나 참인 무의미한 증언이 된다.
 */
export function blockIsBlank(block: string): boolean {
  return normalizeForCompare(block).trim() === '';
}

/**
 * 어휘는 셋이고 전부 중립이다. `present`는 **주변 문장에 대해 아무것도 말하지 않는다.**
 * `n`은 인용 집합의 성질(그 행 전체에서 같은 칸·같은 글을 가진 건의 수)이고
 * `k`는 본문의 출현 수다. 편집 중에는 `k`만 변한다.
 */
export function presenceState(occurrences: number, sameTextCount: number): 'present' | 'absent' | 'ambiguous' {
  if (occurrences <= 0) return 'absent';
  return occurrences >= sameTextCount ? 'present' : 'ambiguous';
}

/** 저장된 값이 배열이 아니면(없음·손상·옛 행) 빈 배열이다. 조용히 고치지 않는다. */
export function citationArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

/**
 * `sameTextCount` — 행 **전체**(축약되어 화면에 글이 안 나가는 건까지)에서 같은 칸·같은
 * 글을 가진 건의 수. 화면이 자기가 받은 건수로 세면 축약된 건이 빠져 `ambiguous`여야 할
 * 것이 `present`로 보인다. 그래서 서버가 읽기 시점에 센다.
 */
export function sameTextCounts(entries: any[]): number[] {
  const tally = new Map<string, number>();
  const keys = entries.map(entry => {
    const key = String(entry?.field ?? '') + '\u0000' + normalizeForCompare(entry?.insertedText ?? '');
    tally.set(key, (tally.get(key) ?? 0) + 1);
    return key;
  });
  return keys.map(key => tally.get(key) ?? 0);
}

/**
 * 유지 목록은 **내 초안 행의 건에 대한 교집합**이다.
 *   키가 없으면(undefined) 변경 없음 — 옛 탭은 인용을 지울 수 없다.
 *   `[]`이면 내 초안 건 전부 제거.
 *   **모르는 cid는 거절이 아니라 무시**한다. 자동 저장은 절대 거절되어서는 안 된다.
 */
export function applyKeepList(entries: any[], keep: string[] | undefined): { kept: any[]; ignored: number } {
  if (keep === undefined) return { kept: entries.slice(), ignored: 0 };
  const wanted = new Set(keep);
  const known = new Set(entries.map(entry => String(entry?.cid ?? '')));
  let ignored = 0;
  for (const cid of wanted) if (!known.has(cid)) ignored += 1;
  return { kept: entries.filter(entry => wanted.has(String(entry?.cid ?? ''))), ignored };
}

/**
 * 확정 시의 새 판 인용 = ((머리 − 제거) ∪ (내 초안 ∩ 유지)).
 *
 * `cid`로 중복을 제거하고 **머리의 바이트가 이긴다.** 서버 난수 `cid`에서는 충돌이
 * 사실상 없으므로 이것은 방어선이지 동작하는 경로가 아니다(비용 0, 옛 자료 방어).
 * 머리 건은 **명시적 제거 의사**로만 빠진다 — 모르는 값과 키 부재는 무동작이라
 * 낡은 화면은 제거에 실패할 수는 있어도 **보지 못한 건을 지울 수는 없다.**
 */
export function citationUnion(head: any[], remove: string[] | undefined, draft: any[]): { entries: any[]; removed: string[] } {
  const drop = new Set(remove ?? []);
  const removed: string[] = [];
  const kept = head.filter(entry => {
    const cid = String(entry?.cid ?? '');
    if (!drop.has(cid)) return true;
    removed.push(cid);
    return false;
  });
  const seen = new Set(kept.map(entry => String(entry?.cid ?? '')));
  const entries = kept.slice();
  for (const entry of draft) {
    const cid = String(entry?.cid ?? '');
    if (seen.has(cid)) continue;
    seen.add(cid);
    entries.push(entry);
  }
  return { entries, removed };
}

/**
 * 출처를 **가리키는** 최소 정보. 측정 수치·계산기·표시 문구·설명은 복사하지 않는다 —
 * 비교 검사의 수치를 약한 표면으로 옮기는 일이고, Json 변환이 17자리 double을 1 ULP
 * 옮길 수 있어 "동결 사본"이 `FindingRevision`과 어긋날 수도 있기 때문이다.
 * 환자·검사 동일성은 사본이 아니라 구조로 지킨다(행이 `uid`로 키가 잡혀 있고 서버가
 * 삽입 시점에 `Finding.studyUid === uid`를 확인한다).
 */
export function citationSourceRef(source: any) {
  const revision = Number.isSafeInteger(Number(source?.revision)) ? Number(source.revision) : null;
  if (source?.kind === 'job')
    return { kind: 'job', jobId: String(source.jobId ?? ''),
      ...(source?.mark?.id === undefined ? {} : { markId: String(source.mark.id) }), sourceRevision: revision };
  return { kind: 'item', itemId: String(source?.itemId ?? ''), sourceRevision: revision };
}

const isPlainString = (value: any) => typeof value === 'string';
const isIndex = (value: any) => Number.isSafeInteger(value) && value >= 0;

/** 클라이언트가 보낸 cid 목록. 모양이 아니면 거절한다 — 모르는 **값**만 무시 대상이다. */
export function citationIdList(value: any, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > REPORT_CITATION_LIMITS.entries * 2 || !value.every(isPlainString))
    throw new CitationInputError(`${what}은(는) 문자열 배열이어야 합니다`);
  return value.map(String);
}

/**
 * 삽입 요청의 모양. **허용된 일곱 칸만 읽는다** — `cid`·`insertedBy`·`insertedAt`·
 * `sourceRef`·`linkStateAtInsert`·`headRevisionAtInsert`를 클라이언트가 보내도 여기서
 * 사라진다. 형식 검사로는 위조를 가릴 수 없기 때문에(`findingId`도 UUID다) 서버가
 * 만들어야 할 값은 **읽지 않는 것**이 유일한 구조적 방어다.
 */
export function citationInsertInput(value: any): ReportCitationInsert {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CitationInputError('insert는 객체여야 합니다');
  const field = value.field;
  if (!REPORT_CITATION_FIELDS.includes(field))
    throw new CitationInputError(`insert.field는 ${REPORT_CITATION_FIELDS.join('·')} 중 하나여야 합니다`);
  if (!isPlainString(value.findingId) || !value.findingId)
    throw new CitationInputError('insert.findingId가 필요합니다');
  if (!isIndex(value.findingRevision) || value.findingRevision < 1)
    throw new CitationInputError('insert.findingRevision은 1 이상의 정수여야 합니다');
  if (!isIndex(value.sourceIndex) || value.sourceIndex >= FINDING_LIMITS.sources)
    throw new CitationInputError(`insert.sourceIndex는 0..${FINDING_LIMITS.sources - 1} 여야 합니다`);
  if (!isPlainString(value.insertedText) || !value.insertedText)
    throw new CitationInputError('insert.insertedText가 필요합니다');
  if (Buffer.byteLength(value.insertedText, 'utf8') > REPORT_CITATION_LIMITS.insertedText)
    throw new CitationInputError(`삽입 문구가 ${REPORT_CITATION_LIMITS.insertedText}바이트를 넘습니다`);
  if (blockIsBlank(value.insertedText))
    throw new CitationInputError('공백만 있는 문구는 인용할 수 없습니다');
  if (!isPlainString(value.expectedLinkState) || !value.expectedLinkState)
    throw new CitationInputError('insert.expectedLinkState가 필요합니다');
  if (value.expectedHeadRevision !== null && !isIndex(value.expectedHeadRevision))
    throw new CitationInputError('insert.expectedHeadRevision이 필요합니다');
  return {
    field, findingId: value.findingId, findingRevision: value.findingRevision,
    sourceIndex: value.sourceIndex, insertedText: value.insertedText,
    expectedLinkState: value.expectedLinkState, expectedHeadRevision: value.expectedHeadRevision,
  };
}

/**
 * 화면으로 나가는 투영. 읽을 수 있는 건은 그대로 + `sameTextCount`, 읽을 수 없는 건은
 * **중립 상태와 네 칸만**. 인용을 원본으로 되짚는 우회 해결기는 만들지 않는다.
 */
export function projectCitation(entry: any, readable: boolean, sameTextCount: number) {
  if (!readable)
    return { cid: entry?.cid ?? null, field: entry?.field ?? null,
      insertedAt: entry?.insertedAt ?? null, insertedBy: entry?.insertedBy ?? null, state: SOURCE_UNAVAILABLE };
  return { ...entry, sameTextCount };
}
