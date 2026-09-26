import { RequestMethod } from '@nestjs/common';

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
 * 기존 writer 경로 전체를 임상의에게 여는 중간 상태다. 업무 allowlist는 비어 있고 U1b가
 * narrow DTO가 준비된 행만 하나씩 채운다.
 */
export const CLINICIAN_ROLE = 'clinician';

/** 기존 세 역할. 이 중 하나라도 토큰에 있으면 기존 guard·need()·visible() 경로를 그대로 탄다. */
export const LEGACY_APP_ROLES: readonly string[] = Object.freeze(['radiologist', 'technician', 'admin']);

/** 회원 승인에 쓰이는 업무 역할 전체. gateway는 회원 역할이 아니라 client-credentials 신원이다. */
export const APP_ROLES: ReadonlySet<string> = new Set([...LEGACY_APP_ROLES, CLINICIAN_ROLE]);

/** 승인된 본인의 세션 동작. public 4개나 업무 allowlist와 섞지 않는다. */
export const CLINICIAN_SESSION_ROUTES: readonly string[] = Object.freeze(['GET me', 'POST auth/logout']);

/** clinician-only 업무 allowlist. U1a에서는 비어 있다. 항목 형식은 `METHOD controller/handler/template`. */
export const CLINICIAN_BUSINESS_ROUTES: readonly string[] = Object.freeze([]);

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
