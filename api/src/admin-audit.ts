import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * S5-U5b 관리자 감사·보안 기록의 귀속 규칙(REQ-S5-U5b-ADMIN-AUDIT / MOVE-PROJECTION / UNCLEAR-HIDDEN,
 * stage5 카드의 audit_attribution_contract).
 *
 * 행이 어느 기관의 것인지는 **행을 쓸 때 함께 남은 값**으로만 정한다. 회원의 지금 Keycloak 그룹, 검사의 지금
 * StudyState 소유·원격판독 기관, 지금 StudyAccess는 읽지 않는다 — A→B로 옮긴 회원의 A 시절 행이 B에게 가고,
 * 지웠다가 다른 소유 기관으로 다시 생긴 검사의 옛 행(오더 매칭 overlay 포함)이 새 소유 기관에게 간다
 * (RISK-S5-U5b-CURRENT-GROUP/OWNER-ATTRIBUTION). AuditLog에는 기관 칸이 없고 이 판은 migration을 두지 않으므로
 * (D7 a) 기관을 분명히 남기지 않은 행은 아무에게도 보이지 않는다. 표에 없는 action도 같다(fail closed).
 *
 * 이 모듈은 node:crypto 말고는 가져오지 않는다. tests/admin_audit_attribution_test.cjs가 이 소스를 Node type
 * stripping으로 그대로 싣는다. 표의 action 이름은 큰따옴표로 쓴다 — api/src에서 작은따옴표 action 문자열은 감사
 * 쓰기 자리로 읽히고(tests/gateway_retry_source_test.py는 Now Retry 요청 감사 action의 작은따옴표 문자열이 api/src
 * 전체에 한 번뿐임을 센다), 이 표는 아무것도 쓰지 않는다.
 */

/** 회원 행: 행에 남은 before/after 스냅숏의 기관으로 귀속한다(admin.service.ts의 row() 모양). */
export const AUDIT_MEMBER_ACTIONS: readonly string[] = Object.freeze([
  "admin.user.create", "admin.user.create.failed", "admin.user.approve", "admin.user.update",
  "admin.user.unapprove", "admin.user.suspend", "admin.user.activate", "admin.user.reset-password",
  "admin.user.patch.failed",
]);

export type AuditFieldSource = 'detail.institutionId' | 'detail.by' | 'detail.institution' | 'target';

/** 검사·기관 행: 행이 기록한 칸 하나가 귀속 기관이다. 값이 없거나 문자열이 아니면 숨긴다. */
export const AUDIT_FIELD_RULES: Readonly<Record<string, AuditFieldSource>> = Object.freeze({
  "study.arrived": 'detail.institutionId',        // 생성 때의 소유 기관(system 동기화, null = 미배정)
  "study.announce": 'detail.institutionId',       // 생성 때의 소유 기관(Gateway 자격증명 기관)
  "study.assign": 'detail.institutionId',         // 새로 배정한 소유 기관(재배정은 거절됨)
  "match": 'detail.by',                           // 호출 기관, 소유 기관만 매칭한다
  "unmatch": 'detail.by',
  "state.delete": 'detail.by',
  "tech-note.revise": 'detail.institutionId',     // 호출 기관, 소유 기관만 쓴다
  "state.patch": 'detail.by',                     // 행위 기관(소유 기관 또는 자기 TS 구간의 원격판독 수신 기관)
  "report.draft.force-discard": 'detail.by',
  "hold.force-release": 'detail.by',
  "reader.assignment": 'detail.institution',      // 소유 기관만 배정한다
  "study.access": 'detail.institution',           // 정책 기관, 쓸 때 대상 회원이 그 기관 소속이었다
  "study.consultation": 'detail.institution',     // 소유 기관만 의뢰한다
  "hanging-protocol.site.save": 'target',         // target이 기관 id다
  "hanging-protocol.site.reset": 'target',
});

/** `report.<action>` 확정 행은 detail.by(행위 기관)로 귀속한다. commitReport가 받는 여섯 동작이다. */
export const AUDIT_REPORT_COMMIT_ACTIONS: readonly string[] = Object.freeze([
  "addendum", "approve", "defer", "preliminary", "reset", "save",
]);

/** 쓸 때 기관을 남기지 않는 행. `*`로 끝나는 항목은 그 접두어의 모든 action이다. */
export const AUDIT_HIDDEN_NO_RECORD_TIME_INSTITUTION: readonly string[] = Object.freeze([
  "admin.user.list", "report.draft", "report.draft.clear", "report.draft.rebase", "report.draft.discard", "report.hold",
  "dictation.request", "gateway.receipt.first", "gateway.receipt.transition", "gateway.receipt.epoch_unrecognised",
  "gateway.retry.request", "viewer.job", "manualSr.expire", "manualSr.expire-deferred", "manualSr.store",
  "manualSr.prepare", "manualSr.store-intent", "finding.*", "viewer.*", "favorite.*", "study.tag.*",
]);

/** Connect 행은 이 단위가 넓히지 않는다. */
export const AUDIT_HIDDEN_CONNECT: readonly string[] = Object.freeze([
  "basis.record", "basis.revoke", "agreement.record", "agreement.terminate", "transfer.open", "transfer.expire",
  "transfer.revoke",
]);

/** 회원 스냅숏에서 내보내는 칸. email은 어느 회원 행에도 싣지 않는다. */
export const AUDIT_MEMBER_SNAPSHOT_FIELDS: readonly string[] = Object.freeze([
  "id", "username", "name", "roles", "enabled", "approvalState", "emailVerified", "institution",
]);

const MEMBER = new Set(AUDIT_MEMBER_ACTIONS);
const COMMITS = new Set(AUDIT_REPORT_COMMIT_ACTIONS);
const APPROVAL_STATES = new Set(["PENDING", "APPROVED", "INVALID"]);
const own = (value: any, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const plain = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function listed(list: readonly string[], action: string) {
  return list.some(entry => entry.endsWith('*') ? action.startsWith(entry.slice(0, -1)) : entry === action);
}

/**
 * action 하나의 계약 규칙: `member_snapshots`, `field:<원천>`, `hidden:<이유>`. 표에 없으면 `hidden:unknown_action`
 * 이다 — 나중에 생긴 action이 계약 행 없이 보이게 되지 않는다(RISK-S5-U5b-NEW-ACTION-DEFAULT).
 */
export function auditRule(action: unknown): string {
  if (typeof action !== 'string') return 'hidden:unknown_action';
  if (MEMBER.has(action)) return 'member_snapshots';
  if (own(AUDIT_FIELD_RULES, action)) return 'field:' + AUDIT_FIELD_RULES[action];
  if (action.startsWith('report.') && COMMITS.has(action.slice('report.'.length))) return 'field:detail.by';
  if (listed(AUDIT_HIDDEN_NO_RECORD_TIME_INSTITUTION, action)) return 'hidden:no_record_time_institution';
  if (listed(AUDIT_HIDDEN_CONNECT, action)) return 'hidden:connect_out_of_scope';
  return 'hidden:unknown_action';
}

/** 조회 후보 action(SQL 사전 거르기). 숨김 규칙은 넣지 않는다 — 표에 없는 action은 SQL에서부터 빠진다. */
export const AUDIT_CANDIDATE_ACTIONS: readonly string[] = Object.freeze([
  ...AUDIT_MEMBER_ACTIONS, ...Object.keys(AUDIT_FIELD_RULES), ...AUDIT_REPORT_COMMIT_ACTIONS.map(a => 'report.' + a),
]);
/** target 칸이 기관인 action. 나머지는 detail 안에 기관 문자열이 들어 있어야 후보가 된다. */
export const AUDIT_TARGET_ACTIONS: readonly string[] = Object.freeze(
  Object.keys(AUDIT_FIELD_RULES).filter(action => AUDIT_FIELD_RULES[action] === 'target'));

export interface AuditLogRow {
  id?: number;
  at: Date | string;
  actor: string;
  action: string;
  target: string;
  detail: string | null;
}

/**
 * detail 사전 거르기의 검색어: 읽는 기관 문자열의 JSON 표기. 후보 action의 detail은 모두 JSON.stringify로 쓰이므로,
 * 이 기관을 적은 행의 detail에는 이 글자들이 그대로 들어 있다. 서비스는 이것을 strpos(패턴 해석 없는 부분 문자열)로
 * 찾는다 — LIKE 패턴에 넣으면 JSON 표기의 역슬래시를 LIKE가 이스케이프로 먹어, `\`·`"`가 든 기관의 행을 판정 전에
 * 놓친다(Astra S5-U5b-B-F02).
 */
export function auditMention(reader: string): string {
  return JSON.stringify(reader);
}

const CANDIDATES = new Set(AUDIT_CANDIDATE_ACTIONS);
const TARGETS = new Set(AUDIT_TARGET_ACTIONS);

/**
 * 서비스 SQL 사전 거르기(admin.service.ts auditEvents)의 순수 쌍둥이. strpos와 includes는 둘 다 글자 그대로의 부분
 * 문자열이다. 넓은 조건이라 다른 기관 행이 섞일 수 있고, 보일지는 projectAuditRow가 정한다.
 */
export function auditCandidateRow(row: AuditLogRow, reader: string): boolean {
  if (!CANDIDATES.has(row?.action)) return false;
  return (typeof row.detail === 'string' && row.detail.includes(auditMention(reader)))
    || (TARGETS.has(row.action) && row.target === reader);
}

/** 읽는 기관 한 곳에 내보내는 행. 회원 행의 before/after는 스냅숏, `{withheld:'other_institution'}`, 또는 null. */
export interface AuditProjection {
  at: string;
  actor: string;
  action: string;
  target: string;
  rule: string;
  detail: Record<string, any>;
}

export interface AuditAttribution {
  rule: string;
  /** 기록 시점 기관(정렬). 비었으면 아무에게도 보이지 않는다. */
  visible_to: string[];
  projection_by_side: Map<string, AuditProjection>;
  /** visible_to가 비었을 때 왜 비었는가(시험·진단용). 응답에는 싣지 않는다. */
  hidden: string | null;
}

const WITHHELD = Object.freeze({ withheld: 'other_institution' });

function hidden(rule: string, reason: string): AuditAttribution {
  return { rule, visible_to: [], projection_by_side: new Map(), hidden: reason };
}

function isoTime(value: unknown): string | null {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function parsedDetail(text: unknown): Record<string, any> | null {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text);
    return plain(value) ? value : null;
  } catch {
    return null;
  }
}

type Snapshot = { recorded: false } | { recorded: true; institution: string | null; view: Record<string, any> };

/**
 * 회원 스냅숏 한 칸. null은 기록 없음이다. 스냅숏이 있는데 기관을 분명히 말하지 못하면(여러 그룹이라 institution이
 * null인 INVALID, PENDING인데 기관이 있음 같은 row()가 쓰지 않는 모양, 다른 회원 id) undefined — 행 전체를 숨긴다.
 */
function snapshot(value: unknown, target: string): Snapshot | undefined {
  if (value === null) return { recorded: false };
  if (!plain(value) || !own(value, 'institution') || !own(value, 'approvalState')) return undefined;
  const state = value.approvalState, institution = value.institution;
  if (typeof state !== 'string' || !APPROVAL_STATES.has(state)) return undefined;
  if (institution === null) {
    if (state !== 'PENDING') return undefined;
  } else if (typeof institution !== 'string' || !institution || state === 'PENDING') {
    return undefined;
  }
  if (value.id !== target) return undefined;
  // 기록된 칸만 모양을 확인해 싣는다. 모양이 다른 칸은 싣지 않는다(화면은 not recorded) — 값을 짐작해 채우지 않는다.
  const view: Record<string, any> = { institution, approvalState: state };
  if (typeof value.id === 'string') view.id = value.id;
  if (typeof value.username === 'string') view.username = value.username;
  if (typeof value.name === 'string') view.name = value.name;
  if (Array.isArray(value.roles) && value.roles.every((role: unknown) => typeof role === 'string')) view.roles = [...value.roles];
  if (typeof value.enabled === 'boolean') view.enabled = value.enabled;
  if (typeof value.emailVerified === 'boolean') view.emailVerified = value.emailVerified;
  return { recorded: true, institution, view };
}

function side(value: Snapshot, reader: string) {
  if (!value.recorded) return null;
  if (value.institution !== null && value.institution !== reader) return { ...WITHHELD };
  return { ...value.view, ...(value.view.roles ? { roles: [...value.view.roles] } : {}) };
}

function memberAttribution(rule: string, base: Omit<AuditProjection, 'rule' | 'detail'>, detail: Record<string, any>) {
  if (!own(detail, 'before') || !own(detail, 'after')) return hidden(rule, 'unparsable_detail');
  const before = snapshot(detail.before, base.target), after = snapshot(detail.after, base.target);
  if (!before || !after) return hidden(rule, 'ambiguous_snapshot');
  const sides = [...new Set([before, after].flatMap(s => s.recorded && s.institution !== null ? [s.institution] : []))].sort();
  if (!sides.length) return hidden(rule, 'no_institution_recorded');
  const events: Record<string, any> = {};
  if (typeof detail.verificationOverride === 'boolean') events.verificationOverride = detail.verificationOverride;
  if (detail.mode === 'temp' || detail.mode === 'email') events.mode = detail.mode;
  if (detail.failed === true) events.failed = true;
  const projection_by_side = new Map<string, AuditProjection>();
  for (const reader of sides)
    projection_by_side.set(reader, { ...base, rule, detail: { before: side(before, reader), after: side(after, reader), ...events } });
  return { rule, visible_to: sides, projection_by_side, hidden: null };
}

function fieldAttribution(rule: string, base: Omit<AuditProjection, 'rule' | 'detail'>, detail: Record<string, any>) {
  const source = rule.slice('field:'.length);
  const key = source.startsWith('detail.') ? source.slice('detail.'.length) : null;
  const value = key === null ? base.target : own(detail, key) ? detail[key] : undefined;
  if (typeof value !== 'string' || !value) return hidden(rule, 'no_institution_recorded');
  // 기록된 detail 그대로다(파싱한 새 객체라 행끼리 공유하지 않는다). 기록되지 않은 값은 채우지 않는다.
  return { rule, visible_to: [value], projection_by_side: new Map([[value, { ...base, rule, detail }]]), hidden: null };
}

/** 저장된 행 하나의 기록 시점 귀속과 기관별 투영(REQ-S5-U5b-ADMIN-AUDIT/MOVE-PROJECTION/UNCLEAR-HIDDEN). */
export function attributeAuditRow(row: AuditLogRow): AuditAttribution {
  const rule = auditRule(row?.action);
  if (rule.startsWith('hidden:')) return hidden(rule, rule.slice('hidden:'.length));
  const at = isoTime(row.at);
  if (at === null || typeof row.actor !== 'string' || typeof row.target !== 'string') return hidden(rule, 'malformed_row');
  const detail = parsedDetail(row.detail);
  if (!detail) return hidden(rule, 'unparsable_detail');
  const base = { at, actor: row.actor, action: row.action, target: row.target };
  return rule === 'member_snapshots' ? memberAttribution(rule, base, detail) : fieldAttribution(rule, base, detail);
}

/** 읽는 기관에게 보일 행, 없으면 null. 읽는 기관은 "누가 읽는가"일 뿐 행의 귀속을 정하지 않는다. */
export function projectAuditRow(row: AuditLogRow, reader: string): AuditProjection | null {
  return attributeAuditRow(row).projection_by_side.get(reader) ?? null;
}

/** 아래 id(null이면 맨 위)보다 작은 행을 id 내림차순으로 최대 take개. 조회 기준 top 이하만 준다(서비스가 감싼다). */
export type AuditSource = (below: number | null, take: number) => Promise<AuditLogRow[]>;

/**
 * 한 쪽 읽기. 거르기와 투영은 쪽을 자르기 **전에** 한다: 원천을 끝까지 걸어 보이는 행만 세고(total), `after`보다
 * 작은 id의 보이는 행 중 앞 `limit`개를 담는다. 숨긴 행은 total·쪽 경계·다음 쪽 여부 어디에도 들어가지 않는다
 * (RISK-S5-U5b-HIDDEN-COUNT). 원천 실패는 그대로 던진다 — 빈 목록으로 바꾸지 않는다(RISK-S5-U5b-FAILURE-AS-EMPTY).
 * `last`는 다음 쪽이 있을 때만 이 쪽 마지막 행의 id이며 응답에 그대로 나가지 않는다(서비스가 봉인한다).
 */
export async function readAuditPage(source: AuditSource, reader: string,
    page: { after: number | null; limit: number; batch?: number }) {
  const batch = page.batch ?? 1000;
  const rows: AuditProjection[] = [];
  let below: number | null = null, previous = Infinity, total = 0, last: number | null = null, more = false;
  for (;;) {
    const chunk = await source(below, batch);
    if (!Array.isArray(chunk) || chunk.length > batch) throw new Error('audit source answer');
    for (const row of chunk) {
      // 내림차순이 아니면 같은 행을 두 번 세거나 건너뛴다. 조용히 넘기지 않는다.
      if (!Number.isSafeInteger(row?.id) || row.id >= previous) throw new Error('audit source order');
      previous = row.id;
      const shown = projectAuditRow(row, reader);
      if (!shown) continue;
      total++;
      if (page.after !== null && row.id >= page.after) continue;
      if (rows.length < page.limit) { rows.push(shown); last = row.id; }
      else more = true;
    }
    if (chunk.length < batch) break;
    below = previous;
  }
  return { rows, total, last: more ? last : null };
}

/** 다음 쪽 값. 행 id를 읽을 수 있게 내보내면 id 사이의 틈이 숨긴 행의 수를 알려 준다 — 그래서 암호화한다. */
export interface AuditCursor { top: number; after: number }
export const AUDIT_CURSOR_MAX = 1024;
export const AUDIT_CURSOR_TTL_MS = 10 * 60 * 1000;
export const AUDIT_PAGE_DEFAULT = 25;
export const AUDIT_PAGE_MAX = 100;

// 봉인 전 값은 판 1바이트와 top·after·expires 각 8바이트(부호 없는 big-endian)로 늘 25바이트다. GCM은 평문 길이를
// 숨기지 않으므로 숫자를 가변 길이로 적으면 값의 길이가 top(기관을 가리지 않은 전체 감사 id의 최댓값)의 자리수,
// 곧 다른 기관 행이 늘어난 구간을 드러낸다(Astra S5-U5b-B-F01). 읽는 사람(기관·계정)은 평문에 넣지 않고 GCM 추가
// 인증 자료(AAD)로 묶는다 — 다른 사람의 값은 인증 태그에서 떨어지고, 값의 길이는 누구에게나 같다.
const CURSOR_VERSION = 2;
const CURSOR_IV = 12;
const CURSOR_TAG = 16;
const CURSOR_PLAIN = 1 + 8 * 3;
const CURSOR_BYTES = CURSOR_IV + CURSOR_TAG + CURSOR_PLAIN;
/** 봉인한 값의 글자 수(base64url, 채움 없음). 소유자·id·숨긴 행과 무관하게 늘 이 길이다. */
export const AUDIT_CURSOR_LENGTH = Math.ceil(CURSOR_BYTES * 4 / 3);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const ownerData = (owner: readonly string[]) => Buffer.from(JSON.stringify(owner), 'utf8');

/** AES-256-GCM(무작위 IV)으로 봉인한다. 같은 상태도 매번 다른 값이고, 읽는 사람(기관·계정)과 유효시간이 묶인다. */
export function sealAuditCursor(key: Uint8Array, owner: readonly string[], cursor: AuditCursor, now = Date.now()): string {
  const values = [cursor.top, cursor.after, now + AUDIT_CURSOR_TTL_MS];
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) throw new RangeError('audit cursor value');
  const payload = Buffer.alloc(CURSOR_PLAIN);
  payload.writeUInt8(CURSOR_VERSION, 0);
  values.forEach((value, i) => payload.writeBigUInt64BE(BigInt(value), 1 + 8 * i));
  const iv = randomBytes(CURSOR_IV);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(ownerData(owner));
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** 봉인을 풀지 못하거나(위조·다른 키·API 재시작 전 값) 다른 사람·만료된 값이면 null. */
export function openAuditCursor(key: Uint8Array, owner: readonly string[], token: unknown, now = Date.now()): AuditCursor | null {
  if (typeof token !== 'string' || token.length !== AUDIT_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length !== CURSOR_BYTES || raw.toString('base64url') !== token) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, CURSOR_IV));
    decipher.setAAD(ownerData(owner));
    decipher.setAuthTag(raw.subarray(CURSOR_IV, CURSOR_IV + CURSOR_TAG));
    const data = Buffer.concat([decipher.update(raw.subarray(CURSOR_IV + CURSOR_TAG)), decipher.final()]);
    if (data.length !== CURSOR_PLAIN || data.readUInt8(0) !== CURSOR_VERSION) return null;
    const values = [0, 1, 2].map(i => data.readBigUInt64BE(1 + 8 * i));
    if (values.some(value => value > MAX_SAFE)) return null;
    const [top, after, expires] = values.map(Number);
    if (after < 1 || after > top || expires <= now) return null;
    return { top, after };
  } catch {
    return null;
  }
}

/** `limit`(1–100, 기본 25)과 `after`(봉인한 다음 쪽 값)만 받는다. 형식이 틀리면 null(400). */
export function auditPageQuery(query: unknown): { limit: number; after: string | null } | null {
  if (query === undefined || query === null) return { limit: AUDIT_PAGE_DEFAULT, after: null };
  if (!plain(query) || Object.keys(query).some(key => key !== 'limit' && key !== 'after')) return null;
  let limit = AUDIT_PAGE_DEFAULT, after: string | null = null;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^[1-9]\d{0,2}$/.test(query.limit) || Number(query.limit) > AUDIT_PAGE_MAX) return null;
    limit = Number(query.limit);
  }
  if (query.after !== undefined) {
    if (typeof query.after !== 'string' || !query.after || query.after.length > AUDIT_CURSOR_MAX) return null;
    after = query.after;
  }
  return { limit, after };
}
