import { RequestMethod } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * S5-U1a — clinician 역할과 clinician-only 기본 거절.
 *
 * 역할 이름 목록이 여기 한 곳에만 있는 이유: guard(승인 판정)·회원콘솔(역할 검증/표시)·
 * Keycloak 클라이언트(역할 매핑 쓰기) 세 곳이 같은 목록을 읽어야 한다. 한 곳만 갱신하면
 * "승인 요청은 통과하는데 Keycloak 역할 변경이 503→409 USER_ISOLATED로 끝난다"거나
 * "역할은 붙었는데 guard가 모른다" 같은 반쪽 상태가 생긴다.
 *
 * 기본값이 deny인 이유: clinician을 APP_ROLES에 넣는 순간 memberState()가 APPROVED를 주므로,
 * 역할 이름 추가와 아래 allowlist 게이트는 **같은 커밋**에 있어야 한다. 이름만 먼저 넣은 후보는
 * 기존 writer 경로 전체를 임상의에게 여는 중간 상태다. U1a의 업무 allowlist는 비어 있었고
 * S5-U1b가 narrow DTO가 준비된 읽기 행만 채웠다(아래 CLINICIAN_BUSINESS_ROUTES).
 */
export const CLINICIAN_ROLE = 'clinician';

/** 기존 세 역할. 이 중 하나라도 토큰에 있으면 기존 guard·need()·visible() 경로를 그대로 탄다. */
export const LEGACY_APP_ROLES: readonly string[] = Object.freeze(['radiologist', 'technician', 'admin']);

/** 회원 승인에 쓰이는 업무 역할 전체. gateway는 회원 역할이 아니라 client-credentials 신원이다. */
export const APP_ROLES: ReadonlySet<string> = new Set([...LEGACY_APP_ROLES, CLINICIAN_ROLE]);

/** 승인된 본인의 세션 동작. public 4개나 업무 allowlist와 섞지 않는다. */
export const CLINICIAN_SESSION_ROUTES: readonly string[] = Object.freeze(['GET me', 'POST auth/logout']);

/**
 * clinician-only 업무 allowlist(S5-U1b). 항목 형식은 `METHOD controller/handler/template`.
 * 좁은 응답이 준비된 읽기만 있다 — 행 하나를 더하는 일은 그 행의 응답 칸을 정하는 일과 같은 변경이다.
 *  - `GET authz/dicom`·`POST dicom/lookup`: 뷰어 읽기 쌍. 하나만 열면 영상 한 장도 열리지 않는다.
 *  - `GET studies/:uid/viewer-items`: clinician-only에게는 확정본일 때만, 아래 투영으로 좁혀서 준다.
 *  - `GET clinician/studies`: 워크리스트의 기관·원격판독·StudyAccess·페이지 파이프라인에 좁은 행을 얹는다.
 *  - `GET clinician/studies/:uid/report`: 머리 판이 확정본이면 본문과 key image, 아니면 상태만.
 * `GET studies`·`GET bootstrap`·`GET studies/:uid/report-preview`·`GET audit`는 계속 거절한다 —
 * 초안·오더·상용구·작성자 칸이나 확정 전 본문을 싣는 응답이다.
 */
export const CLINICIAN_BUSINESS_ROUTES: readonly string[] = Object.freeze([
  'GET authz/dicom', 'POST dicom/lookup', 'GET studies/:uid/viewer-items',
  'GET clinician/studies', 'GET clinician/studies/:uid/report',
]);

export const CLINICIAN_ALLOWED_ROUTES: ReadonlySet<string> =
  new Set([...CLINICIAN_SESSION_ROUTES, ...CLINICIAN_BUSINESS_ROUTES]);

export const CLINICIAN_ROUTE_DENIED = 'CLINICIAN_ROUTE_DENIED';

/**
 * 업무 역할이 clinician뿐인가. Keycloak 기본 역할(default-roles-kin, offline_access 등)은 무시한다.
 * legacy 역할이 하나라도 섞이면 false — 그 사용자는 기존 강한 역할의 명시 권한과 기존 검사를 그대로 받는다.
 * 업무 역할이 없으면 false — 그 경우는 memberState()가 이미 INVALID/PENDING으로 막는다.
 */
export function clinicianOnly(roles: readonly string[] | undefined): boolean {
  const app = (Array.isArray(roles) ? roles : []).filter(role => APP_ROLES.has(role));
  return app.length > 0 && app.every(role => role === CLINICIAN_ROLE);
}

function segments(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  return value.split('/').filter(Boolean);
}

/**
 * Nest가 데코레이터에 저장한 메타데이터(METHOD_METADATA, 컨트롤러/핸들러 PATH_METADATA)로
 * `METHOD prefix/child` 키를 만든다. 요청 URL 문자열이나 정규식을 믿지 않는 이유는 URL은
 * 호출자가 정하고 route template은 서버가 정하기 때문이다. 해석할 수 없는 형태(배열 경로,
 * 알 수 없는 method)는 null이며 호출측은 null을 deny로 다룬다 — 새 데코레이터 형태가
 * 조용히 허용으로 새지 않는다.
 */
export function routeKey(method: unknown, controllerPath: unknown, handlerPath: unknown): string | null {
  const name = typeof method === 'number' && Number.isInteger(method) ? RequestMethod[method] : undefined;
  if (typeof name !== 'string' || !/^[A-Z]+$/.test(name)) return null;
  const prefix = segments(controllerPath);
  const child = segments(handlerPath);
  if (prefix === null || child === null) return null;
  return `${name} ${[...prefix, ...child].join('/')}`;
}

export function clinicianRouteAllowed(key: string | null): boolean {
  return key !== null && CLINICIAN_ALLOWED_ROUTES.has(key);
}

// ── S5-U1b 임상의 읽기 투영 ──
// 아래 함수는 입력 행에서 **정해진 칸만 새로 만들어** 돌려준다. 행을 펼친 뒤 칸을 지우는 방식은
// 쓰지 않는다 — 서비스 행에 새 칸(초안·오더·영수증처럼 뒤에 붙은 칸)이 생기면 지우는 목록이
// 따라가지 못해 그대로 새기 때문이다. 이 파일은 순수 함수만 둔다(DB·Orthanc·Nest 예외 없음).

/**
 * S5-F5 보수 기본값 — D-S5-NONFINAL-VIEW는 미결이다. 임상의에게 본문·key image·표시 항목이
 * 나가는 것은 머리 판(ReportVersion(uid, Report.version))의 action이 approve/addendum이고
 * 같은 순간 RS가 A일 때뿐이다. 둘 중 하나만 보면 기록이 어긋난 행(RS만 A이거나, 머리 판만
 * 승인)이 확정본으로 나간다. 그 밖의 상태는 본문 없이 상태만 알리고 확정이라고 부르지 않는다.
 */
export const CLINICIAN_FINAL_ACTIONS: readonly string[] = Object.freeze(['approve', 'addendum']);

/** 본문 없이 그대로 알려도 되는 진행 상태. 그 밖(확정 머리가 아닌 A, 모르는 값)은 null — 모름. */
export const CLINICIAN_OPEN_STATES: readonly string[] = Object.freeze(['W', 'T', 'P', 'H']);

/** 확정본 판정. head는 Report.version 번 ReportVersion 행이다(없으면 null). */
export function clinicianFinal(rs: unknown, head: any): boolean {
  const action = head?.action;
  return rs === 'A' && typeof action === 'string' && CLINICIAN_FINAL_ACTIONS.includes(action)
    && Number.isSafeInteger(head?.version) && head.version > 0;
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const own = (value: any, key: string): boolean =>
  !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);

/**
 * 판독 상태. 확정본이면 누가(repDoc)·언제(confirm)·어느 판인지를, 아니면 RS만 싣는다.
 * holdReason·preDoc·preReviewer·holder·초안은 작성자 쪽 칸이라 어느 경우에도 없다.
 */
export function clinicianReportStatus(state: any, head: any) {
  if (!clinicianFinal(state?.rs, head))
    return { final: false, rs: CLINICIAN_OPEN_STATES.includes(state?.rs) ? state.rs as string : null };
  return { final: true, rs: 'A', action: head.action as string, version: head.version as number,
    repDoc: typeof state.repDoc === 'string' ? state.repDoc : null,
    confirm: typeof state.confirm === 'string' ? state.confirm : null };
}

/** 판독문 읽기. 본문은 **머리 판 행 자신의** 세 칸이다 — 판정한 action과 같은 불변 행에서 읽는다. */
export function clinicianReport(state: any, head: any) {
  const status = clinicianReportStatus(state, head);
  if (!status.final) return status;
  return { ...status, findings: text(head.findings), conclusion: text(head.conclusion),
    recommendation: text(head.recommendation) };
}

const SNAPSHOT_COMMON = ['schemaVersion', 'kind', 'seriesUid', 'sopUid', 'frame'];
const SNAPSHOT_MEASURE = [...SNAPSHOT_COMMON, 'frameOfReferenceUid', 'label', 'points', 'viewPlaneNormal', 'viewUp', 'baseline'];
/** 표시 항목 종류별로 내보내는 칸(viewer-input.ts viewerCommand의 저장 칸에서 sourceDigest·hidden을 뺀 것). */
export const CLINICIAN_SNAPSHOT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  key: Object.freeze([...SNAPSHOT_COMMON, 'title', 'description']),
  arrow: Object.freeze([...SNAPSHOT_COMMON, 'frameOfReferenceUid', 'label', 'points']),
  length: Object.freeze(SNAPSHOT_MEASURE),
  angle: Object.freeze(SNAPSHOT_MEASURE),
  ellipse: Object.freeze(SNAPSHOT_MEASURE),
});
const MEASUREMENT_KINDS = ['length', 'angle', 'ellipse'];

/** 저장된 표시 항목 한 건의 내용. 모르는 종류와 숨긴 항목은 null이다(닫힌 쪽으로 실패). */
export function clinicianSnapshot(snapshot: any) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.hidden === true) return null;
  const kind = snapshot.kind;
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(CLINICIAN_SNAPSHOT_FIELDS, kind)) return null;
  const out: Record<string, unknown> = {};
  for (const field of CLINICIAN_SNAPSHOT_FIELDS[kind]) if (own(snapshot, field)) out[field] = snapshot[field];
  return out;
}

/** 확정본에 딸린 key image. 작성자는 싣지 않는다 — 누가 확정했는지는 판독 상태의 repDoc이 말한다. */
export function clinicianKeyImage(row: any) {
  const item = clinicianSnapshot(row?.snapshot);
  if (!item || item.kind !== 'key' || row.hidden === true) return null;
  return { id: row.id as string, revision: row.revision as number, item };
}

/**
 * 표시 항목 조회(viewer.service list) 한 건. authorSub·authorActor·studyUid·hidden은 뺀다.
 * 수동 측정은 원본 확인 결과를 **항상** 싣는다 — 값이 없으면 'unverified'다. 빠진 칸을
 * 화면이 확인된 측정으로 읽는 일이 없게 한다.
 */
export function clinicianViewerItem(row: any) {
  const item = clinicianSnapshot(row?.item);
  if (!item || row.hidden === true) return null;
  return { id: row.id as string, revision: row.revision as number, createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null, item,
    ...(MEASUREMENT_KINDS.includes(item.kind as string)
      ? { referenceStatus: row.referenceStatus === 'verified' ? 'verified' : 'unverified' } : {}) };
}

/**
 * 확정본의 표시 항목 한 쪽. uid를 싣는 이유: 화면은 늦게 온 응답을 쓰기 전에 요청한 검사와 대조한다.
 * reportVersion은 이 쪽을 읽은 확정 판 번호다 — 판독문 읽기의 report.version과 대조할 수 있다(S5-U1b-F04).
 * nextCursor는 마지막 항목 id가 아니라 (검사, 판, 마지막 id)를 서명한 이어받기 값이라 다음 쪽도 이 판에서만 읽힌다.
 * 판 번호 없이 확정 쪽을 만들지 않는다 — 호출측이 고정 검사를 건너뛴 것이므로 답 대신 실패한다.
 */
export function clinicianViewerPage(uid: string, version: number, page: any, key: Uint8Array) {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('a final viewer page needs its signed report version');
  const items = (Array.isArray(page?.items) ? page.items : []).map(clinicianViewerItem).filter(Boolean);
  return { uid, final: true, reportVersion: version, items,
    nextCursor: typeof page?.nextCursor === 'string' ? clinicianViewerCursor(key, uid, version, page.nextCursor) : null };
}

/** 확정 전에는 항목을 싣지 않는다. items가 null인 이유: 빈 목록(항목 없음)과 가려진 목록은 다르다. */
export function clinicianViewerWithheld(uid: string) {
  return { uid, final: false, items: null, nextCursor: null };
}

/** 표시 항목을 읽는 사이 확정 머리 판이 바뀌었을 때의 409 코드. 목록의 STUDY_LIST_CHANGED와 같은 "다시 불러오라"다. */
export const CLINICIAN_VIEWER_CHANGED = 'VIEWER_REPORT_CHANGED';

/**
 * 표시 항목 한 쪽을 확정본으로 내보내도 되는가. 세 판 번호가 **같은 확정 판**이어야 한다 — 읽기 전 관문의 머리 판,
 * 항목과 같은 SQL 문장에서 읽은 확정 머리 판, 읽기 뒤 관문의 머리 판. "확정인가"를 두 번 묻는 것으로는 부족하다:
 * reset → (W에서 항목 작성·읽기·숨김) → 재승인이 끼면 앞뒤 모두 확정이지만 가운데서 읽은 항목은 확정 전의 것이다.
 * commitReport는 매번 더 큰 판 번호를 쓰므로(`Report.version`은 줄지 않는다) 같은 번호면 그 사이 확정 변경이 없었다.
 */
export function clinicianViewerPinned(before: unknown, read: unknown, after: unknown): boolean {
  return Number.isSafeInteger(before) && (before as number) > 0 && read === before && after === before;
}

/**
 * S5-U1b-F04 — 이 요청이 관문이 본 머리 판(head)에서 읽어도 되는가. 첫 쪽(started null)은 지금 머리 판에서 시작한다
 * (없으면 뒤에서 가린다). 다음 쪽은 이어받기 값이 실어 온 판(started)과 지금 머리 판이 **같은 확정 판**일 때만 이어진다.
 * 요청 하나 안의 고정(clinicianViewerPinned)만으로는 쪽 사이의 재승인·addendum·reset을 보지 못한다: 옛 이어받기로 새 판의
 * 다음 쪽을 받으면 두 판의 항목이 한 연쇄로 합쳐져 어느 승인 시점에도 없던 목록이 된다. 머리 판이 없어졌어도(reset) 거절이다 —
 * 가린 답(items null)을 다음 쪽으로 주면 목록 끝과 구분되지 않는다. 통과한 판 하나를 listFinal과 마지막 검사가 함께 쓴다.
 */
export function clinicianViewerContinues(started: number | null, head: unknown): boolean {
  return started === null || (Number.isSafeInteger(head) && (head as number) > 0 && head === started);
}

/** 이어받기 값의 최대 길이. 이보다 길거나 문자열이 아니면 서명을 따지기 전에 형식 오류(400)다. */
export const CLINICIAN_VIEWER_CURSOR_MAX = 512;
const VIEWER_CURSOR_PART = /^[A-Za-z0-9_-]+$/;
const VIEWER_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function viewerCursorMac(key: Uint8Array, payload: string) {
  // 짧거나 빈 키의 서명은 누구나 만들 수 있어 판 번호를 호출자가 정하는 것과 같다 — 서명하지 않고 실패한다.
  if (!(key instanceof Uint8Array) || key.length < 32) throw new Error('the clinician viewer cursor key must be at least 32 bytes');
  return createHmac('sha256', key).update(payload).digest();
}

/**
 * S5-U1b-F04 이어받기 값: `base64url(JSON {v, uid, version, after}).base64url(HMAC-SHA256)` — study-page.ts 목록 cursor와 같은
 * 모양이다. 판 번호는 서버가 이 쪽에서 확인한 확정 판이고, 서명이 있으므로 호출자가 다른 판으로 바꿔 이어 갈 수 없다.
 * 권한은 아니다: 다음 쪽도 관문(범위·역할·확정 판)을 처음부터 다시 탄다. 만료 시각이 없는 이유도 같다 — 매 쪽 머리 판과
 * 비교하므로 오래된 값은 같은 판이면 여전히 맞고, 아니면 거절된다.
 */
export function clinicianViewerCursor(key: Uint8Array, uid: string, version: number, after: string): string {
  if (typeof uid !== 'string' || !Number.isSafeInteger(version) || version < 1 || typeof after !== 'string' || !VIEWER_ITEM_ID.test(after))
    throw new Error('a clinician viewer cursor needs the study, a signed report version and an item id');
  const payload = Buffer.from(JSON.stringify({ v: 1, uid, version, after }), 'utf8').toString('base64url');
  return payload + '.' + viewerCursorMac(key, payload).toString('base64url');
}

/**
 * 이어받기 값을 읽는다. 이 키로 서명된 이 검사의 값이면 { version, after }, 그 밖은 모두 null이다 — 판 번호가 없는 값
 * (판독의 경로의 항목 id 그대로), 서명이 맞지 않는 값(바꾼 값 또는 API 재시작 전의 값), 다른 검사의 값. null은 호출측에서
 * 409(처음부터 다시)다. 판을 모르는 이어받기를 지금 머리 판에서 이어 주면 F04의 섞인 연쇄가 그대로 남는다.
 */
export function clinicianViewerContinuation(key: Uint8Array, uid: string, cursor: unknown): { version: number; after: string } | null {
  if (typeof cursor !== 'string' || cursor.length > CLINICIAN_VIEWER_CURSOR_MAX) return null;
  const [payload, signature, extra] = cursor.split('.');
  if (extra !== undefined || !payload || !signature || !VIEWER_CURSOR_PART.test(payload) || !VIEWER_CURSOR_PART.test(signature)) return null;
  const actual = Buffer.from(signature, 'base64url'), expected = viewerCursorMac(key, payload);
  if (actual.toString('base64url') !== signature || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let data: any;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || typeof data !== 'object' || data.v !== 1 || data.uid !== uid || !Number.isSafeInteger(data.version) || data.version < 1
      || typeof data.after !== 'string' || !VIEWER_ITEM_ID.test(data.after)) return null;
  return { version: data.version, after: data.after };
}

/**
 * clinician-only의 표시 항목 쿼리. 숨긴 항목은 요청할 수 없다 — includeHidden은 없거나 'false'만
 * 받고 그 밖은 null(거절)이다. cursor는 CLINICIAN_VIEWER_CURSOR_MAX 이하의 문자열 하나이고(서명은 호출측이
 * clinicianViewerContinuation으로 판정), 한 항목 재확인(recheck)과 함께 올 수 없다. limit·recheck의 형식은 viewerPage가 판정한다.
 */
export function clinicianViewerQuery(query: any): Record<string, unknown> | null {
  const source = query ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) return null;
  if (own(source, 'includeHidden') && source.includeHidden !== 'false') return null;
  if (own(source, 'cursor') && (typeof source.cursor !== 'string' || source.cursor.length > CLINICIAN_VIEWER_CURSOR_MAX
      || own(source, 'recheck'))) return null;
  return { ...source, includeHidden: 'false' };
}

/** 판독문 미리보기와 같은 표시 덮어쓰기 칸. 기사가 고친 환자·검사 정보가 원본 태그보다 앞선다. */
const OVERLAY_DISPLAY = ['id', 'name', 'birth', 'sex', 'date', 'acc', 'desc', 'modality'];

/**
 * 임상의 목록의 판독 상태 한 건을 이루는 칸. 모두 **한 SQL 문장**(한 스냅샷)에서 함께 읽는다 — StudyState의 기관 두 칸과
 * rs·repDoc·confirm, Report.version(행이 없으면 0), 그 판 ReportVersion의 action. 워크리스트 행의 state(toClient)는
 * StudyState와 Report를 서로 다른 시점에 읽어 합친 것이라, 그 사이 Addendum이 끼면 새 판 번호에 이전 서명자·확정일이
 * 붙는다. 그래서 임상의 목록의 상태는 이 스냅샷 행에서만 만들고, 워크리스트 행과 이 칸들이 하나라도 다르면 답 전체를 거절한다.
 */
export const CLINICIAN_LIST_PINS: readonly string[] = Object.freeze(['institutionId', 'teleInstitutionId', 'rs', 'repDoc', 'confirm', 'version']);

/**
 * 임상의 목록 한 행. 입력은 워크리스트 목록(listStudies)의 한 행과 그 검사의 스냅샷 행(CLINICIAN_LIST_PINS + uid·action)이다.
 * 판독 상태는 **스냅샷 행에서만** 만든다 — 워크리스트 행의 state는 판 번호와 서명자를 다른 시점에 읽었을 수 있다.
 * 스냅샷 행이 없거나 다른 검사의 것이면 모름(확정 아님)이다.
 * 덮어쓰기(state.ov)는 서버에서 적용하고 ov·orig 자체는 싣지 않는다. ov는 RS=W에서만 바뀌고, RS·판 번호가 목록과
 * 스냅샷에서 같아야 답이 나가므로 확정 행에 확정 뒤 바뀐 ov가 붙지 않는다. sourcePatientKey는 워크리스트가 **원본**
 * PatientID로 만든 값 그대로다 — 덮어쓰기로 같은 환자 묶음이 바뀌지 않는다.
 * state·techNote·readerAssignment·gatewayReceipt·orderIdentity와 초안은 이 행에 없다.
 */
export function clinicianStudyRow(row: any, snapshot: any) {
  const state = row?.state && typeof row.state === 'object' ? row.state : null;
  const ov = state?.ov;
  const overlay = ov && typeof ov === 'object' && !Array.isArray(ov) ? ov : null;
  const shown = (key: string) => own(overlay, key) && typeof overlay[key] === 'string' ? overlay[key] as string : text(row?.[key]);
  const record = snapshot && typeof snapshot === 'object' && typeof row?.uid === 'string' && snapshot.uid === row.uid ? snapshot : null;
  return {
    uid: text(row?.uid),
    id: shown('id'), name: shown('name'), birth: shown('birth'), sex: shown('sex'), date: shown('date'),
    acc: shown('acc'), desc: shown('desc'), modality: shown('modality'),
    count: Number.isSafeInteger(row?.count) ? row.count as number : null,
    series: Number.isSafeInteger(row?.series) ? row.series as number : null,
    sourcePatientKey: typeof row?.sourcePatientKey === 'string' ? row.sourcePatientKey : null,
    institutionName: text(row?.institutionName),
    tele: row?.tele === true,
    report: clinicianReportStatus(record, record ? { version: record.version, action: record.action } : null),
  };
}

/**
 * 페이지 정보. total은 이 호출자가 지금 볼 수 있는 검사(기관·원격판독·StudyAccess로 거른 열거)의
 * 수다 — 거르기 전 개수는 studyPageSlice에 들어가지도 않는다. owner는 호출자 자신의 식별자라 뺀다.
 */
export function clinicianPagination(pagination: any) {
  if (!pagination) return undefined;
  return { next: typeof pagination.next === 'string' ? pagination.next : null, total: pagination.total,
    offset: pagination.offset, limit: pagination.limit };
}

/**
 * 임상의 목록 응답. 워크리스트 응답에서 studies(좁힌 행)·serverTime·pagination만 남긴다 —
 * observedAt·notObserved·orderReconciliation은 기사·엔지니어링 화면의 칸이라 버린다.
 */
export function clinicianList(list: any, snapshots: any[]) {
  const byUid = new Map((Array.isArray(snapshots) ? snapshots : []).map(snapshot => [snapshot?.uid, snapshot]));
  const studies = (Array.isArray(list?.studies) ? list.studies : []).map((row: any) => clinicianStudyRow(row, byUid.get(row?.uid)));
  return { studies, serverTime: typeof list?.serverTime === 'string' ? list.serverTime : null,
    ...(list?.pagination ? { pagination: clinicianPagination(list.pagination) } : {}) };
}

/**
 * 목록을 만든 뒤 스냅샷 행을 읽는 사이 기관·원격판독·RS·서명자·확정일·판 번호 중 하나라도 바뀌었는가(CLINICIAN_LIST_PINS).
 * 바뀌었으면 워크리스트와 같이 답 전체를 거절한다(STUDY_LIST_CHANGED). 행이 사라지거나 다른 행이 끼어도 바뀐 것이다.
 * 판 번호와 서명 칸까지 보는 이유: 워크리스트 행이 이전 판의 서명자와 새 판 번호를 섞어 들고 있었다면 여기서 드러난다.
 */
export function clinicianListChanged(rows: any[], current: any[]): boolean {
  const now = new Map((Array.isArray(current) ? current : []).map(state => [state?.uid, state]));
  const listed = Array.isArray(rows) ? rows : [];
  if (now.size !== new Set(listed.map(row => row?.uid)).size) return true;
  return listed.some(row => {
    const state = now.get(row?.uid), seen = row?.state && typeof row.state === 'object' ? row.state : {};
    return !state || CLINICIAN_LIST_PINS.some(key => (state[key] ?? null) !== (seen[key] ?? null));
  });
}
