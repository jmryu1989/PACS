/**
 * S4-U5 연결된 오더와 검사의 식별 필드 비교 — **엔지니어링 전용 신호**이지 환자 확인이 아니다.
 *
 * 입력은 둘뿐이다. 서버가 이번 목록에서 읽은 QIDO 태그(목록 행이 보여주는 바로 그 값)와 저장된 Order 행.
 * StudyState.ov(화면 덮어쓰기)와 orig(클라이언트가 보낸 원래 값)는 입력이 아니다(P12) — 덮어쓰기로
 * 비교 결과를 바꿀 수 있으면 불일치 신호가 Modify 한 번으로 사라진다.
 *
 * 경계(P11): 검사·오더·호출자가 같은 기관이고, 두 행이 서로를 가리킬 때만 답한다. 그 밖(원격판독 수신,
 * 한쪽만 가리키는 연결, 다른 기관 오더)은 null(모름)이다. 오더 값은 응답에 나가지 않고 관계만 나간다.
 *
 * 관계는 세 값이다. 어느 쪽이든 비었거나 읽을 수 없는 형식이면 not_comparable — 같음도 다름도 아니다.
 * match는 "두 기록 문자열이 이 규칙으로 같다"는 뜻일 뿐이다. 음역·유사 일치·0 제거·순서 바꾸기·필드 간
 * 추론은 하지 않는다. 사람이 누구인지는 이 규칙이 판정하지 않는다.
 */
import { accessionRelation, ORDER_RECONCILIATION_SOURCE } from './order-reconciliation';
import type { AccessionRelation } from './order-reconciliation';

export type IdentityRelation = AccessionRelation;

/** 이 읽기가 고르는 칸. 목록 쿼리는 이 상수만 쓴다 — 관계를 판정할 칸 밖의 오더 값은 읽지도 않는다. */
export const ORDER_IDENTITY_SELECT = {
  oid: true, institutionId: true, studyUid: true, matched: true,
  accession: true, patientId: true, name: true, birth: true, sex: true,
} as const;

export interface OrderIdentityRow {
  oid: string; institutionId: string; studyUid: string | null; matched: string;
  accession: string | null; patientId: string; name: string; birth: string; sex: string;
}
export interface IdentityStudyRow { uid: string; institutionId: string | null; matched: string; orderOid: string | null }

export interface OrderIdentity {
  source: typeof ORDER_RECONCILIATION_SOURCE;
  oid: string;
  accession: IdentityRelation;
  patientId: IdentityRelation;
  patientName: IdentityRelation;
  birth: IdentityRelation;
  sex: IdentityRelation;
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';

function relate(left: string, right: string): IdentityRelation {
  if (!left || !right) return 'not_comparable';
  return left === right ? 'match' : 'mismatch';
}

/**
 * PN은 Alphabetic 그룹만 온다(OrthancService.tag). NFC, `^`를 공백으로, 공백 연속을 하나로, 앞뒤 공백 제거,
 * ASCII a-z만 대문자로. `^`를 공백으로 보므로 성명 구분 위치만 다른 두 값은 같다고 읽는다(N-2) — 표시 신호의
 * 규칙이고 사람 판정이 아니다. 비ASCII 대소문자는 바꾸지 않는다.
 */
export function nameKey(value: unknown): string {
  return text(value).normalize('NFC').replace(/\^/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[a-z]+/g, part => part.toUpperCase());
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * YYYYMMDD 또는 YYYY-MM-DD이고 실제 그레고리력 날짜일 때만 YYYYMMDD. 그 밖은 ''(비교 불가).
 * 달력은 표로 판정한다 — Date는 1962-02-30을 3월 2일로 넘겨 없는 날짜를 같은 날로 만든다(N-3).
 */
export function birthKey(value: unknown): string {
  const raw = text(value).trim();
  const parts = /^(\d{4})(\d{2})(\d{2})$/.exec(raw) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!parts) return '';
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leap ? 29 : MONTH_DAYS[month - 1];
  if (year < 1 || !days || day < 1 || day > days) return '';
  return parts[1] + parts[2] + parts[3];
}

/** M·F만 비교한다. O·U·빈 값은 해석하지 않는다(다르다고도 같다고도 하지 않는다). */
export function sexKey(value: unknown): string {
  const key = text(value).trim().replace(/[a-z]/g, part => part.toUpperCase());
  return key === 'M' || key === 'F' ? key : '';
}

/**
 * 한 목록 행의 관계. `tag(key)`는 서버가 이번에 읽은 그 행의 태그 문자열이다(없으면 '').
 * accession과 Patient ID는 U2의 규칙 그대로다: 앞뒤 공백만 무시하고 대소문자·내부 문자는 그대로 비교한다.
 */
export function orderIdentity(me: string, study: IdentityStudyRow, order: OrderIdentityRow | null | undefined,
  tag: (key: string) => string): OrderIdentity | null {
  if (!study || study.institutionId !== me || study.matched !== 'M' || !study.orderOid) return null;
  if (!order || order.oid !== study.orderOid || order.institutionId !== me || order.matched !== 'M'
    || order.studyUid !== study.uid) return null;
  return {
    source: ORDER_RECONCILIATION_SOURCE,
    oid: order.oid,
    accession: accessionRelation(order.accession, tag('00080050')),
    patientId: accessionRelation(order.patientId, tag('00100020')),
    patientName: relate(nameKey(order.name), nameKey(tag('00100010'))),
    birth: relate(birthKey(order.birth), birthKey(tag('00100030'))),
    sex: relate(sexKey(order.sex), sexKey(tag('00100040'))),
  };
}

/**
 * 화면 덮어쓰기(ov)와 Match가 저장하는 원래 값(orig)의 모양 — Modify·Match가 쓰는 칸과 판독문 미리보기가
 * 읽는 칸의 합이다. 이 값은 행을 보는 모든 기관(원격판독 수신 기관 포함)에 그대로 전달되므로, 표시 칸
 * 밖의 키나 문자열이 아닌 값은 저장하지 않는다(M-1). null은 덮어쓰기를 지우는 기존 동작이다.
 */
export const OVERLAY_KEYS = ['id', 'name', 'sex', 'birth', 'age', 'desc', 'ward', 'date', 'acc', 'modality'] as const;
export const OVERLAY_RULE_TEXT = `허용 키 ${OVERLAY_KEYS.join(', ')} · 값은 문자열(age는 유한한 숫자도 가능)`;

export function overlayShape(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    return false;
  return Object.entries(value).every(([key, item]) => (OVERLAY_KEYS as readonly string[]).includes(key)
    && (typeof item === 'string' || (key === 'age' && typeof item === 'number' && Number.isFinite(item))));
}
