import { createHash } from 'node:crypto';
import { CLINICIAN_ROLE, clinicianFinal } from './clinician-policy';

/**
 * S7-U1a 중요 결과 전달(계약 S7-U1p §3~§8, §11)의 순수 판정. DB·Keycloak·Orthanc·Nest 예외를 모른다 — 서비스가 읽은
 * 값을 넘기면 사례·거절·투영·감사 칸을 돌려준다. 판정을 여기 모으는 이유: 목록 SQL의 제외 조건과 한 건 읽기·쓰기의
 * 사례가 같은 규칙이어야 하고, 겹친 실패에서 어느 거절이 먼저인지(§4 순서 12~15)를 서비스 흐름과 따로 확인할 수 있어야 한다.
 */
export const RADIOLOGIST = 'radiologist';
export const CRITICAL_RESULT_TEXT_MAX = 2000;
export const CRITICAL_RESULT_PAGE = 50;
export const CRITICAL_RESULT_STATES: readonly string[] = Object.freeze(['created', 'acknowledged', 'cancelled', 'superseded']);
/** 고정할 수 있는 머리 판 action. reset은 보낼 원천이 없다는 뜻이고 discarded는 머리가 될 수 없다(F-7). */
export const CRITICAL_RESULT_PINNABLE_ACTIONS: readonly string[] = Object.freeze(['save', 'approve', 'addendum', 'preliminary', 'defer']);
export const CRITICAL_RESULT_STATE_FILTERS: readonly string[] = Object.freeze(['pending', 'acknowledged', 'cancelled', 'superseded', 'all']);

/** 전이표(state-machine.json CR-T2..CR-T4). created에서 나가는 전이 하나씩이고 종결 상태에서 나가는 전이는 없다. */
export const CRITICAL_RESULT_TRANSITIONS: Readonly<Record<string, { from: string; to: string; event: string }>> = Object.freeze({
  ack: Object.freeze({ from: 'created', to: 'acknowledged', event: 'acknowledged' }),
  cancel: Object.freeze({ from: 'created', to: 'cancelled', event: 'cancelled' }),
  supersede: Object.freeze({ from: 'created', to: 'superseded', event: 'superseded' }),
});

export type RecipientClass = 'clinician' | 'radiologist';
export type Refusal = { status: 400 | 403 | 404 | 409 | 503; code: string; id?: string; replacedBy?: string };
export type Head = { version: number; action: string | null; author?: string | null; at?: any } | null;
export type StudyReadState = { rs?: string | null; preDoc?: string | null; preReviewer?: string | null };
export type RecipientCase = {
  case: 'C2' | 'C3' | 'C4' | 'C5' | 'R2' | 'R3' | 'R4' | 'R5';
  /** full: 메시지·고정 판·본문, stub: 기록 칸만, null: 행이 없다(C5/R5). */
  view: 'full' | 'stub' | null;
  ack: boolean;
  current: boolean;
  reason: null | 'head_moved' | 'reset';
};

export const CRITICAL_RESULT_CODES = Object.freeze({
  INPUT_INVALID: 'CRITICAL_RESULT_INPUT_INVALID',
  RECIPIENT_INVALID: 'CRITICAL_RESULT_RECIPIENT_INVALID',
  ROLE_REQUIRED: 'CRITICAL_RESULT_ROLE_REQUIRED',
  SOURCE_FORBIDDEN: 'CRITICAL_RESULT_SOURCE_FORBIDDEN',
  STUDY_NOT_FOUND: 'STUDY_NOT_FOUND',
  NOT_FOUND: 'CRITICAL_RESULT_NOT_FOUND',
  OWNER_CHANGED: 'OWNER_CHANGED',
  REUSED: 'REQUEST_ID_REUSED',
  CHANGED: 'CRITICAL_RESULT_CHANGED',
  ACKNOWLEDGED: 'CRITICAL_RESULT_ACKNOWLEDGED',
  CANCELLED: 'CRITICAL_RESULT_CANCELLED',
  SUPERSEDED: 'CRITICAL_RESULT_SUPERSEDED',
  SOURCE_MOVED: 'CRITICAL_RESULT_SOURCE_MOVED',
  SOURCE_INVALID: 'CRITICAL_RESULT_SOURCE_INVALID',
  SOURCE_CHANGED: 'CRITICAL_RESULT_SOURCE_CHANGED',
  RECIPIENT_CANNOT_READ: 'CRITICAL_RESULT_RECIPIENT_CANNOT_READ',
  PENDING_EXISTS: 'CRITICAL_RESULT_PENDING_EXISTS',
  BUSY: 'CRITICAL_RESULT_BUSY',
  UNAVAILABLE: 'CRITICAL_RESULT_UNAVAILABLE',
});
const C = CRITICAL_RESULT_CODES;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STUDY_UID = /^\d+(?:\.\d+)+$/;
const CURSOR = /^[A-Za-z0-9_-]+$/;
// 줄바꿈과 탭만 받는다. 그 밖의 C0·C1 제어문자는 화면·로그에서 보이지 않는 글자가 된다.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

export const isObject = (value: any) => !!value && typeof value === 'object' && !Array.isArray(value);
export const exactKeys = (value: any, keys: readonly string[]) =>
  isObject(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export const uuidValue = (value: any) => typeof value === 'string' && UUID.test(value);
export const studyUidValue = (value: any) => typeof value === 'string' && value.length <= 64 && STUDY_UID.test(value);
/** 판 번호·revision: 1 이상 2147483646 이하 정수(§6.1). */
export const positiveValue = (value: any) => Number.isInteger(value) && value >= 1 && value <= 2147483646;
/** 메시지·취소 사유: 앞뒤 공백을 뺀 뒤 비어 있지 않은 2000자 이하, 줄바꿈·탭 말고 제어문자 없음(§6.1). */
export const textValue = (value: any) => typeof value === 'string' && value.trim().length > 0
  && value.length <= CRITICAL_RESULT_TEXT_MAX && !CONTROL.test(value);

/** 256자는 코드 포인트로 자른다 — UTF-16 단위로 자르면 짝 없는 대리 문자가 남는다. */
export const clip = (value: unknown, max = 256) => Array.from(typeof value === 'string' ? value : '').slice(0, max).join('');
export const iso = (value: any) => value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
export const holds = (roles: readonly string[] | undefined, role: string) => Array.isArray(roles) && roles.includes(role);

/**
 * 부류(REQ-S7-U1p-RECIPIENT-CLASS, §4.2): radiologist가 있으면 R(clinician을 함께 가져도), 없고 clinician이 있으면 C
 * (clinician-only와 clinician + technician/admin 혼합), 둘 다 없으면 수신자가 아니다. 혼합 비판독의를 R로 판정하면 그들의
 * legacy 읽기가 주는 서명 전 원천이 판독의 아닌 사람에게 간다(RISK-S7-U1p-CLASS-WIDENING).
 */
export function recipientClass(roles: readonly string[] | undefined): RecipientClass | null {
  if (holds(roles, RADIOLOGIST)) return 'radiologist';
  if (holds(roles, CLINICIAN_ROLE)) return 'clinician';
  return null;
}

export type StudyScopeState = { institutionId?: string | null; teleInstitutionId?: string | null };

/**
 * 발신 범위(S7-U1c, D-S7-05 a): 지금 이 검사에서 caller 기관이 보낼 수 있는 기록의 기관. 소유 기관이면 그 기관이고,
 * 소유 기관이 따로 있는데 지금 원격판독 통로가 caller 기관이면 소유 기관이다 — 기록은 늘 검사 소유 기관(A)의 것이고
 * 수신자도 A의 회원이다. 둘 다 아니면 null이다. 통로는 지금의 StudyState만 보며 예전에 열렸던 것은 세지 않는다.
 */
export function senderScope(state: StudyScopeState | null | undefined, institution: string | null | undefined): string | null {
  if (!state || typeof institution !== 'string' || !institution) return null;
  if (state.institutionId === institution) return institution;
  if (state.teleInstitutionId === institution && typeof state.institutionId === 'string' && state.institutionId) return state.institutionId;
  return null;
}

type Party = { institution: string | null; sub: string };
type RecordSides = { institutionId: string; senderInstitutionId: string; senderSub: string; recipientSub: string };

/**
 * 발신자 가시성: 보낸 사람과 기록 시점의 발신 기관이 caller이고, 기록 기관이 caller의 지금 발신 범위다. 그래서 tele
 * 기록은 통로가 닫히면(또는 소유 기관이 바뀌면) 발신자에게서 사라지고 다시 열리면 보인다. 두 기관 칸 중 하나만 맞춰
 * 보지 않는다 — 다른 통로 기관이나 기관을 옮긴 사람에게 기록이 새지 않게.
 */
export function senderSees(record: RecordSides, state: StudyScopeState | null | undefined, caller: Party): boolean {
  return record.senderSub === caller.sub && record.senderInstitutionId === caller.institution
    && senderScope(state, caller.institution) === record.institutionId;
}

/** 수신자 가시성(S7-U1a 그대로): 기록 기관 = caller 기관 = 지금 소유 기관인 지정 수신자. 통로와 무관하다. */
export function recipientSees(record: RecordSides, state: StudyScopeState | null | undefined, caller: Party): boolean {
  return record.recipientSub === caller.sub && record.institutionId === caller.institution && !!state
    && state.institutionId === record.institutionId;
}

/** 판독의의 기존 읽기 규칙(report-preview·versions(), F-8·F-9): P면 preDoc·preReviewer만. 가시성은 따로 본다. */
export function legacyReadable(state: StudyReadState | null | undefined, actor: string): boolean {
  if (!state) return false;
  if (state.rs !== 'P') return true;
  return !!actor && (state.preDoc === actor || state.preReviewer === actor);
}

/**
 * 생성·대체 때의 수신자 판정(M-S7-CVR C1/C2, R1/R2). 고정 = 지금 머리이므로 C는 확정 원천(clinicianFinal)일 때만,
 * R은 기존 읽기 규칙이 그 머리를 줄 때만 받는다. visible은 수신자에게 지금 검사가 보이는가(기관·StudyAccess)다.
 */
export function createCase(input: { cls: RecipientClass; visible: boolean; head: Head; state: StudyReadState; actor: string }) {
  if (input.cls === 'clinician') return input.visible && clinicianFinal(input.state?.rs, input.head) ? 'C2' : 'C1';
  return input.visible && legacyReadable(input.state, input.actor) ? 'R2' : 'R1';
}

/**
 * 기록의 수신자 사례(§4.2 사례 계산, role-matrix.json case_function). 읽기·ACK·목록·보낸 목록의 delivery가 모두 이 함수다.
 *   visible = 기록 기관 = 수신자 기관 = 지금 소유 기관 && StudyAccess(수신자, uid)
 *   C: 고정 = 머리 ? (확정 ? C2 : C5) : (머리 reset ? C4 : C3)
 *   R: 고정 = 머리 ? (legacyReadable ? R2 : R5) : (머리 reset ? R4 : R3), R3/R4는 legacyReadable이면 full 아니면 stub
 * ACK는 C2·R2뿐이다 — 옛 판에 대한 확인은 새 판의 확인으로 읽힐 수 있다.
 */
export function recipientCase(input: { cls: RecipientClass; visible: boolean; pin: number; head: Head; state: StudyReadState;
  actor: string }): RecipientCase {
  const clinician = input.cls === 'clinician';
  const head = input.head;
  const current = !!head && Number.isSafeInteger(head.version) && head.version > 0 && input.pin === head.version;
  const reason = current ? null : head?.action === 'reset' ? 'reset' as const : 'head_moved' as const;
  if (!input.visible) return { case: clinician ? 'C5' : 'R5', view: null, ack: false, current, reason };
  if (clinician) {
    if (current) return clinicianFinal(input.state?.rs, head)
      ? { case: 'C2', view: 'full', ack: true, current, reason }
      // 고정 = 머리인데 확정이 아닌 것은 R→C 부류 변화로만 생긴다. 서명 전 원천은 C가 읽을 수 없다.
      : { case: 'C5', view: null, ack: false, current, reason };
    return { case: reason === 'reset' ? 'C4' : 'C3', view: 'stub', ack: false, current, reason };
  }
  const legacy = legacyReadable(input.state, input.actor);
  if (current) return legacy ? { case: 'R2', view: 'full', ack: true, current, reason } : { case: 'R5', view: null, ack: false, current, reason };
  return { case: reason === 'reset' ? 'R4' : 'R3', view: legacy ? 'full' : 'stub', ack: false, current, reason };
}

/** 보낸 목록의 delivery(§3.3): 지금 수신자가 받으면 무엇을 보는가. 종결 기록은 null, 계산 실패는 호출자가 'unknown'. */
export function deliveryOf(kase: RecipientCase | null): 'readable' | 'stub' | 'not_eligible' {
  if (!kase || kase.view === null) return 'not_eligible';
  return kase.view === 'full' ? 'readable' : 'stub';
}

/**
 * 원천 고정 판정(§5.4, §4 순서 14): 머리 없음 → INVALID, 화면이 본 판 ≠ 머리 → MOVED, 머리 reset(고정할 수 없는 action) →
 * INVALID, 발신자가 그 머리를 기존 규칙으로 읽을 수 없음 → 403 FORBIDDEN.
 */
export function sourceRefusal(input: { sourceVersion: number; head: Head; senderReadable: boolean }): Refusal | null {
  const head = input.head;
  if (!head || !Number.isSafeInteger(head.version) || head.version < 1) return { status: 409, code: C.SOURCE_INVALID };
  if (input.sourceVersion !== head.version) return { status: 409, code: C.SOURCE_MOVED };
  if (!CRITICAL_RESULT_PINNABLE_ACTIONS.includes(head.action as string)) return { status: 409, code: C.SOURCE_INVALID };
  if (!input.senderReadable) return { status: 403, code: C.SOURCE_FORBIDDEN };
  return null;
}

/** 종결 상태(§4 순서 12): 흡수 상태라 새 requestId의 모든 쓰기가 그 코드다. replacedBy는 호출자가 읽을 수 있을 때만. */
export function terminalRefusal(state: string, replacedBy?: string | null): Refusal | null {
  if (state === 'created') return null;
  if (state === 'acknowledged') return { status: 409, code: C.ACKNOWLEDGED };
  if (state === 'cancelled') return { status: 409, code: C.CANCELLED };
  if (state === 'superseded') return replacedBy ? { status: 409, code: C.SUPERSEDED, replacedBy } : { status: 409, code: C.SUPERSEDED };
  return { status: 409, code: C.CHANGED };
}

/** id route 쓰기의 순서 12·13(종결 → revision). 종결을 먼저 보아 경합에서 진 쪽이 상대의 종결 코드를 받는다. */
export function recordRefusal(record: { state: string; revision: number }, revision: number, replacedBy?: string | null): Refusal | null {
  return terminalRefusal(record.state, replacedBy) ?? (record.revision !== revision ? { status: 409, code: C.CHANGED } : null);
}

/** ACK의 순서 12~14. 사례(C5/R5는 순서 10에서 이미 404)의 ack가 거짓이면 고정 ≠ 머리라는 뜻이다(C3/C4/R3/R4). */
export function ackRefusal(record: { state: string; revision: number }, revision: number, kase: RecipientCase,
  replacedBy?: string | null): Refusal | null {
  return recordRefusal(record, revision, replacedBy) ?? (kase.ack ? null : { status: 409, code: C.SOURCE_CHANGED });
}

export type KeycloakUserLike = { id: string; username?: string; email?: string; firstName?: string; lastName?: string;
  enabled: boolean; serviceAccountClientId?: string | null; groups: string[]; roles: string[] };

/** 직원 actor는 가드와 같은 모양(email 우선, 없으면 username)이다. P 짝 비교가 이 값으로 된다. */
export const userActor = (user: KeycloakUserLike) => (user?.email || user?.username || '');
export const userName = (user: KeycloakUserLike) => clip([user?.lastName, user?.firstName].filter(Boolean).join(' ') || user?.username || '');

/**
 * 수신자 자격(T-8): Keycloak 현재 상태에서 활성·서비스 계정 아님·본인 아님·그룹 정확히 하나 = 기록 기관·clinician 또는
 * radiologist. 자격이 있으면 부류, 없으면 null(400 RECIPIENT_INVALID). 원문을 지금 읽을 수 있는지는 따로(createCase) 본다.
 * 기록 기관은 검사 소유 기관이다 — tele 발신자의 기관이 아니다(S7-U1c).
 */
export function eligibleRecipient(user: KeycloakUserLike | null, expected: { sub: string; institution: string; sender: string }): RecipientClass | null {
  if (!user || user.id !== expected.sub || expected.sub === expected.sender || user.enabled !== true || user.serviceAccountClientId
    || !Array.isArray(user.groups) || user.groups.length !== 1 || user.groups[0] !== expected.institution) return null;
  const actor = userActor(user);
  if (!actor || actor.length > 256) return null;
  return recipientClass(user.roles);
}

/**
 * 쓰기 전 caller의 Keycloak 재확인(T-9). 유효 역할 = 토큰 역할 ∩ Keycloak 역할이고, 활성·서비스 계정 아님·그룹 정확히
 * 하나 = 토큰 기관이어야 한다. 아니면 null(403 ROLE_REQUIRED)이다. route가 요구하는 역할은 호출자가 유효 역할로 본다.
 */
export function effectiveRoles(user: KeycloakUserLike | null, caller: { sub: string; institution: string | null; roles: readonly string[] }): string[] | null {
  if (!user || user.id !== caller.sub || user.enabled !== true || user.serviceAccountClientId || !Array.isArray(user.groups)
    || user.groups.length !== 1 || user.groups[0] !== caller.institution) return null;
  const current = new Set(Array.isArray(user.roles) ? user.roles : []);
  return (Array.isArray(caller.roles) ? caller.roles : []).filter(role => current.has(role));
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** 요청 지문(§7). 키 순서가 지문의 일부다 — 표의 순서 그대로 만든다. */
export const createFingerprint = (v: { uid: string; institution: string; subject: string; recipientSub: string; sourceVersion: number; message: string }) =>
  sha({ uid: v.uid, institution: v.institution, subject: v.subject, recipientSub: v.recipientSub, sourceVersion: v.sourceVersion, message: v.message });
export const ackFingerprint = (v: { id: string; institution: string; subject: string; revision: number }) =>
  sha({ id: v.id, institution: v.institution, subject: v.subject, revision: v.revision, action: 'ack' });
export const cancelFingerprint = (v: { id: string; institution: string; subject: string; revision: number; reason: string }) =>
  sha({ id: v.id, institution: v.institution, subject: v.subject, revision: v.revision, action: 'cancel', reason: v.reason });
export const supersedeFingerprint = (v: { id: string; institution: string; subject: string; revision: number; sourceVersion: number; message: string }) =>
  sha({ id: v.id, institution: v.institution, subject: v.subject, revision: v.revision, action: 'supersede', sourceVersion: v.sourceVersion,
    message: v.message });

/** 쓰기 응답의 applied(§3.4). 메시지·사유·이름·sub·환자 식별자·본문은 없다 — 재전송이 내용을 다시 내보내지 않는다. */
export function appliedResult(v: { id: string; studyUid: string; requestId: string; action: string; from: string | null; to: string;
  revision: number; replacement?: { id: string; revision: number; sourceVersion: number } | null; at: Date }) {
  return { id: v.id, studyUid: v.studyUid, requestId: v.requestId, action: v.action, from: v.from, to: v.to, revision: v.revision,
    replacement: v.replacement ?? null, at: v.at.toISOString() };
}

/** 감사 detail(§11). 정확히 이 열세 키이고 메시지·취소 사유·본문·환자 식별자·수신자 sub는 없다. */
export function auditDetail(v: { id: string; institution: string; senderInstitution: string; event: string; from: string | null;
  to: string; revision: number; requestId: string; role: string; source: number; recipient: string; supersedes: string | null;
  replacedBy: string | null }) {
  return { id: v.id, institution: v.institution, senderInstitution: v.senderInstitution, event: v.event, from: v.from, to: v.to,
    revision: v.revision, requestId: v.requestId, role: v.role, source: v.source, recipient: v.recipient, supersedes: v.supersedes,
    replacedBy: v.replacedBy };
}

/** 원본 태그 사본(§3.2). 칸 길이에 맞게 코드 포인트로 자른다 — 사본이 저장을 막지 않게. */
export function originalIdentity(tag: (key: string) => string) {
  return { origName: clip(tag('00100010').replace(/\^/g, ' ')), origPatientId: clip(tag('00100020')),
    origBirth: clip(tag('00100030'), 64), origStudyDate: clip(tag('00080020'), 64) };
}

/**
 * 표시 신원(REQ-S7-U1p-IDENTITY): 생성 때 읽은 원본 사본 위에 지금의 StudyState.ov 문자열 값을 덮는다. 키는 미리보기와
 * 같은 name·id·birth·date뿐이다(F-8). ov가 깨졌으면 사본 그대로다.
 */
export function studyIdentity(record: any, ovRaw: unknown) {
  const study: Record<string, string> = { uid: String(record?.studyUid ?? ''), name: String(record?.origName ?? ''),
    id: String(record?.origPatientId ?? ''), birth: String(record?.origBirth ?? ''), date: String(record?.origStudyDate ?? '') };
  let overlay: any = null;
  try { overlay = typeof ovRaw === 'string' && ovRaw ? JSON.parse(ovRaw) : null; } catch { overlay = null; }
  if (isObject(overlay)) for (const key of ['name', 'id', 'birth', 'date']) if (typeof overlay[key] === 'string') study[key] = overlay[key];
  return study;
}

const base = (record: any, replacedBy: string | null | undefined) => ({ id: record.id, studyUid: record.studyUid, state: record.state,
  revision: record.revision, createdAt: iso(record.createdAt), replacedBy: replacedBy ?? null });

/**
 * 수신자 투영(§3.3). full은 메시지·고정 판 메타데이터·**고정 행 자신의** 본문, stub은 기록 칸과 신원·시각만이다. stub은
 * 메시지·source 판 칸·본문·취소 사유를 싣지 않고 다른 판 본문으로 채우지 않는다(RISK-S7-U2a-BODY-SUBSTITUTE).
 */
export function recipientView(record: any, kase: RecipientCase, study: Record<string, string>, pinned: any, replacedBy: string | null) {
  if (kase.view === 'full') return { ...base(record, replacedBy), view: 'full' as const, sender: { name: record.senderName }, study,
    message: record.message,
    source: { version: record.sourceVersion, action: record.sourceAction, author: record.sourceAuthor, at: iso(record.sourceAt),
      current: kase.current, reason: kase.reason },
    body: { findings: String(pinned?.findings ?? ''), conclusion: String(pinned?.conclusion ?? ''), recommendation: String(pinned?.recommendation ?? '') },
    acknowledgedAt: iso(record.acknowledgedAt), cancelledAt: iso(record.cancelledAt), cancelReason: record.cancelReason ?? null,
    supersededAt: iso(record.supersededAt) };
  return { ...base(record, replacedBy), view: 'stub' as const, sender: { name: record.senderName }, study,
    source: { current: false, reason: kase.reason ?? 'head_moved' },
    acknowledgedAt: iso(record.acknowledgedAt), cancelledAt: iso(record.cancelledAt), supersededAt: iso(record.supersededAt) };
}

/** 발신자 투영(§3.3). 본문은 없다(발신자는 판독 화면에서 읽는다). delivery는 확인 대기 기록에만 값이 있다. */
export function senderView(record: any, head: Head, study: Record<string, string>, delivery: string | null, replacedBy: string | null) {
  const current = !!head && head.version > 0 && record.sourceVersion === head.version;
  return { ...base(record, replacedBy), supersedes: record.supersedesId ?? null, view: 'sender' as const,
    recipient: { actor: record.recipientActor, name: record.recipientName, role: record.recipientRole }, study, message: record.message,
    source: { version: record.sourceVersion, action: record.sourceAction, author: record.sourceAuthor, at: iso(record.sourceAt), current,
      reason: current ? null : head?.action === 'reset' ? 'reset' : 'head_moved' },
    delivery: record.state === 'created' ? delivery : null,
    acknowledgedAt: iso(record.acknowledgedAt), cancelledAt: iso(record.cancelledAt), cancelReason: record.cancelReason ?? null,
    supersededAt: iso(record.supersededAt) };
}

/** 목록 cursor(§6.2): base64url(JSON {at, id, r}), r = 호출자 StudyAccess revision. 형식·revision이 어긋나면 null(400). */
export function encodeCursor(at: any, id: string, revision: number) {
  return Buffer.from(JSON.stringify({ at: iso(at), id, r: revision })).toString('base64url');
}
export function decodeCursor(text: unknown, revision: number): { at: string; id: string } | null {
  try {
    if (typeof text !== 'string' || text.length > 256 || !CURSOR.test(text)) return null;
    const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (!isObject(value) || Object.keys(value).sort().join() !== 'at,id,r' || value.r !== revision || !uuidValue(value.id)
      || typeof value.at !== 'string' || new Date(value.at).toISOString() !== value.at) return null;
    return { at: value.at, id: value.id };
  } catch { return null; }
}
