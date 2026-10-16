/*
 * WORKLIST-SPLIT-UID: 원본 열거의 행을 Study Instance UID별로 묶는 작은 순수 모델이다.
 *
 * 같은 UID에 원본 Study 자원이 둘 이상이면 서로 다른 환자 자원이 한 UID를 쓰고 있다는 관측이다(정정 전후의 부분
 * 재전송, 잘못 고른 환자로 다시 보낸 영상). 이 묶음에서 첫/마지막 행을 대표 환자로 고르거나 값을 합치면 한 환자의
 * 정상 검사로 보이게 된다. 그래서 여기서는 묶고, 집합을 대조하고, 모든 행이 같은 값을 말하는지만 판정한다.
 * DB·Orthanc·Nest 예외는 없다 — 거절의 모양은 호출하는 서비스가 정한다.
 */

/** 같은 UID가 둘 이상의 원본 자원을 가리킬 때의 코드. 목록 안내와 행위 거절이 같은 코드를 쓴다. */
export const STUDY_IDENTITY_UNRESOLVED = 'STUDY_IDENTITY_UNRESOLVED';
/** 원본 자원 수를 확인하지 못했을 때의 코드. 확인하지 못한 것을 "하나"로 세지 않는다. */
export const STUDY_SOURCE_UNAVAILABLE = 'STUDY_SOURCE_UNAVAILABLE';
export const STUDY_IDENTITY_UNRESOLVED_MESSAGE = '환자 식별 불일치로 이 검사를 사용할 수 없습니다. 원본 확인이 필요합니다.';
export const STUDY_SOURCE_UNAVAILABLE_MESSAGE = '검사 원본을 확인하지 못했습니다. 잠시 후 다시 시도하세요';

export interface SourceGroups<T> {
  /** 열거에 처음 나온 순서의 UID. 정상 행의 기존 목록 순서를 그대로 지킨다. */
  readonly uids: string[];
  readonly byUid: Map<string, T[]>;
}

/** UID를 읽을 수 없는 행은 어느 묶음에도 넣지 않는다(기존 목록이 그 행을 건너뛰던 것과 같다). */
export function groupSources<T>(rows: readonly T[], uidOf: (row: T) => string): SourceGroups<T> {
  const byUid = new Map<string, T[]>(), uids: string[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const uid = uidOf(row);
    if (!uid) continue;
    const list = byUid.get(uid);
    if (list) list.push(row);
    else { byUid.set(uid, [row]); uids.push(uid); }
  }
  return { uids, byUid };
}

/** 원본 자원이 정확히 하나일 때만 정상 검사다. 0은 split이 아니라 원본 없음이다. */
export function unresolvedSource(resources: readonly unknown[] | null | undefined): boolean {
  return Array.isArray(resources) && resources.length > 1;
}

/** 두 UID 모음이 같은 집합인가. 크기만 같은 다른 집합, 한쪽의 중복은 같지 않다. */
export function sameUidSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left), b = new Set(right);
  return a.size === left.length && b.size === right.length && a.size === b.size && [...a].every(uid => b.has(uid));
}

/** 모든 값이 null이 아닌 같은 값일 때만 그 값이다. 하나라도 비었거나 다르면 null(미확정)이다. */
export function consensus<T>(values: readonly (T | null | undefined)[]): T | null {
  if (!values.length || values.some(value => value == null)) return null;
  return values.every(value => value === values[0]) ? values[0] as T : null;
}

/** 목록 응답의 안내 항목. UID와 코드만 싣는다 — 환자·기관·원본 자원 수는 싣지 않는다. */
export function identityIssueList(uids: Iterable<string>): { uid: string; code: string }[] {
  return [...new Set(uids)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map(uid => ({ uid, code: STUDY_IDENTITY_UNRESOLVED }));
}
