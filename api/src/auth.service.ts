import {
  HttpException, Injectable, InternalServerErrorException, Logger,
  OnModuleDestroy, OnModuleInit, UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import { createRemoteJWKSet, decodeJwt, jwtVerify, JWTPayload } from 'jose';
import { PrismaService } from './prisma.service';
import { KeycloakService } from './keycloak.service';
import { clinicianOnly } from './clinician-policy';

const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 5 * 60 * 1000;
/**
 * 시작한 로그인(pending)이 통하는 시간. Keycloak 로그인 화면의 수명(accessCodeLifespanLogin)에 맞춘다: keycloak/kin-realm.json은
 * 그 값을 정하지 않으므로 Keycloak 기본값 1800초다. 이보다 짧으면(예전 600초) 폼을 연 지 10~30분 뒤에 로그인한 사람이
 * Keycloak은 통과하고 여기서 거절된다. 쿠키는 더 오래 둔다 — 만료된 **자기** 흐름의 콜백을 남의 흐름과 구별해, 그 흐름의
 * 의도를 지킨 채 한 번 다시 시작하기 위해서다.
 */
const PENDING_VALID_MS = 30 * 60 * 1000;
const PENDING_COOKIE_SECONDS = 2 * 60 * 60;
const PENDING_PREFIX = 'kin_pending_';
// 한 브라우저가 들고 있는 pending 쿠키의 상한. 넘으면 가장 오래된 것부터 치운다(버려진 탭의 흐름이 쿠키 머리글을 키우지 않게).
const PENDING_LIMIT = 8;
// 자동으로 다시 시작한 흐름의 state 꼬리표. 쿠키가 돌아오지 않는 브라우저에서도 "두 번째 자동 재시작"을 알아본다.
const RESTARTED = '~r';
// 한 요청이 하는 조건부 세션 전이(idle 삭제·refresh 저장·refresh 실패 삭제, 종료 요청의 삭제)의 상한. 경쟁자가 매번
// 먼저 바꾸면 끝없이 재시도하는 대신 409로 끝내고 다음 사용자 요청이 새 한도로 다시 한다(S7-U5 §0.A 7).
const TRANSITION_LIMIT = 3;
// 세션을 끝낸 **뒤의** provider 종료 요청 한 번이 쓸 수 있는 시간(U5S-REQ-18). 서비스 토큰 취득까지 포함한 전체 한도다.
// 넘기면 그 시도는 버리고 표식(IdpSessionEnd)이 다음 시도를 부른다 — 이 앱의 세션은 이미 끝났다.
const IDP_END_MS = 2000;
// 사람이 답을 기다리는 종료(복구 로그인의 시작, 끝내기로 한 provider 세션을 타고 온 콜백)의 한도.
const IDP_END_WAIT_MS = 5000;
// 미확인 provider 종료를 다시 살피는 주기와, 실패할수록 늘어나는 간격(상한 5분). 미확인 행은 시간만으로 버리지 않는다.
const IDP_END_TICK_MS = 5000;
const IDP_END_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000];
/**
 * 확인된 표식을 남겨 두는 시간: Keycloak SSO 세션의 최대 수명(kin-realm.json ssoSessionMaxLifespan 43200초) + 여유.
 * 그 뒤에는 그 provider 세션의 유효한 토큰이 올 수 없다 — 콜백이 잠금 뒤에 토큰의 exp를 다시 보는 것과 짝이다.
 */
const IDP_END_KEEP_MS = 13 * 60 * 60 * 1000;
// provider 세션 잠금(pg_advisory_xact_lock)의 고정 이름공간. 다른 용도의 advisory lock과 키가 겹치지 않게 한다.
const IDP_LOCK_SPACE = 0x4b494e55;
// 회원 잠금의 이름공간. 격리 사실을 쓰는 트랜잭션과 콜백의 세션 생성(그 사실을 읽는다)이 같은 회원에 대해 줄을 선다.
const MEMBER_LOCK_SPACE = 0x4b494e4d;
// 인증 서버 자체가 답하지 못했다는 OAuth 오류(그 밖의 probe 오류는 SSO를 알아내지 못한 것일 뿐이다).
const PROVIDER_DOWN = ['temporarily_unavailable', 'server_error'];
// Keycloak 토큰 교환(로그인 code, refresh) 한 번이 쓸 수 있는 시간(U5S-REQ-18의 외부 조회 한도).
const IDP_TOKEN_MS = 5000;
/**
 * 갱신은 access token이 만료되기 이만큼 **전에** 시작한다: 저장하는 `atExpiresAt`은 토큰의 exp에서 이 값을 뺀 시각이다.
 * 그 시각부터 실제 만료까지는 저장된 토큰이 아직 유효하므로 요청은 갱신을 기다리지 않는다(아래 `authenticateSession`).
 */
const REFRESH_LEAD_MS = 30_000;
// 실제 만료 직전의 토큰을 "아직 유효"로 채택하면 곧이은 서명 검증에서 만료로 떨어진다. 그 틈을 만료 쪽으로 센다.
const TOKEN_MARGIN_MS = 2000;
// 로그인 직후의 진입 증명이 통하는 시간(U5S-REQ-09). 콜백의 이동과 첫 요청 사이만 덮는다.
const ENTRY_PROOF_MS = 120_000;

// S7-U5 접속기록(FACT-S7-RETENTION): 로그인 성공·실패, 로그아웃·계정 전환·재인증, 세션 만료, 로그인 뒤 진입.
const AUTH_LOGIN = 'auth.login';
const AUTH_LOGOUT = 'auth.logout';
const AUTH_EXPIRED = 'auth.session.expired';
const AUTH_ENTRY = 'auth.entry';

/**
 * 민감한 로그인 시작이 밝히는 사유(R2). 랜딩이 아는 것을 그대로 말한다: 끝내지 못한 로그아웃, 계정 바꾸기, 떠났는지 알 수
 * 없는 브라우저(저장소 불신·기록 손상). `register`는 가입 진입이 스스로 붙인다(본문으로 받지 않는다).
 */
const LOGIN_REASONS = ['logout_unfinished', 'switch_account', 'storage_untrusted', 'record_unreadable'] as const;
type Reason = typeof LOGIN_REASONS[number] | 'register';
// isolation: 관리자가 회원을 격리(정지·승인 변경·승인 취소)하며 그 회원의 세션을 끝냈다(사람의 Log out도 만료도 아니다).
type EndCause = 'logout' | 'account_switch' | 'reauthentication' | 'idle' | 'refresh_failed' | 'sweep' | 'isolation';
/** 사유가 접속기록의 원인이 되는 표(A019): 사람의 Log out의 완료는 logout, 계정 바꾸기만 account_switch, 그 밖은 재인증이다. */
const REASON_CAUSE: Record<Reason, EndCause> = {
  logout_unfinished: 'logout',
  switch_account: 'account_switch',
  storage_untrusted: 'reauthentication',
  record_unreadable: 'reauthentication',
  register: 'reauthentication',
};

/**
 * 로그인 흐름 하나의 서버 쪽 상태(서명한 쿠키, 흐름마다 하나). 단계:
 *   plain  평범한 로그인 — 살아 있는 SSO가 있으면 폼 없이 돌아온다(끝내기로 한 SSO는 콜백이 막는다).
 *   probe  복구 의도의 첫 단계 — `prompt=none`으로 이 브라우저의 SSO만 알아낸다. code가 오면 그 SSO를 끝내고(제품 세션도
 *          진입 증명도 만들지 않는다), `login_required`면 끝낼 SSO가 없는 것이다.
 *   fresh  복구 의도의 마지막 단계 — `prompt`(login·create)로 자격을 실제로 입력한 인증만 제품 세션을 만든다.
 */
type Phase = 'plain' | 'probe' | 'fresh';
type PendingLogin = {
  state: string; verifier: string; issuedAt: number;
  phase: Phase; reason: Reason | null; prompt: 'login' | 'create' | null; restarts: number;
};
type Flow = { name: string; pending: PendingLogin; live: boolean };
type Session = {
  sid: string; sub: string; accessToken: string; refreshToken: string;
  atExpiresAt: Date; createdAt: Date; lastSeenAt: Date;
  entryProofHash: string | null; entryProofExpiresAt: Date | null;
  idpSid: string | null;
};
type Who = { actor: string; target: string; institution: string | null };
export type LoginFailureCause =
  'provider_error' | 'state_mismatch' | 'no_code' | 'exchange_failed' | 'token_invalid' | 'session_failed' | 'idp_session_ended'
  // 격리된 회원(우리 쪽 격리 사실이 있는 회원)의 로그인: 세션을 만들지 않는다.
  | 'member_isolated';
type StorageStep = 'session_read' | 'session_write' | 'end_transaction' | 'login_transaction' | 'login_failure_row'
  | 'entry_transaction' | 'sweep_read' | 'sweep_target' | 'sweep_cycle'
  | 'idp_end_read' | 'idp_end_write' | 'idp_end_cycle'
  | 'isolation_read' | 'isolation_write' | 'isolation_cycle';
type EndResult = { ended: boolean; idpSid: string | null };
/**
 * 콜백의 답. `entered`만 제품 세션을 만든다. `redirect`는 인증 서버로 다시 보내는 이동(복구의 다음 단계, 한 번의 자동
 * 재시작), `work`는 이미 살아 있는 세션의 업무 문서, `landing`은 사유와 함께 랜딩이다 — 최상위 이동에 JSON 오류를 답하지 않는다.
 */
export type CallbackResult =
  | { kind: 'entered'; sid: string; proof: string; document: 'main.html' | 'clinician.html' }
  | { kind: 'redirect'; location: string }
  | { kind: 'work' }
  | { kind: 'landing'; error: string };
/**
 * refresh 교환의 답. `refused`는 Keycloak이 **그 refresh token을 거절했다고 답한 것**(400 invalid_grant: 만료·철회)뿐이다.
 * 연결 실패·시간 초과·5xx·읽지 못한 답·검증하지 못한 새 토큰은 `unavailable`이다 — 세션이 끝났다는 증거가 아니다.
 */
type RefreshAnswer = { kind: 'tokens'; tokens: any; payload: JWTPayload & Record<string, any> } | { kind: 'refused' } | { kind: 'unavailable' };
type RefreshOutcome = { kind: 'stored'; session: Session } | { kind: 'ended' } | { kind: 'conflict' } | { kind: 'unavailable' };

/** jose가 **토큰 자체**를 판정한 오류. 이 밖의 검증 실패(JWKS 조회 시간 초과·응답 이상·연결 실패)는 토큰의 잘못이 아니다. */
const TOKEN_VERDICTS = new Set([
  'ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWT_INVALID', 'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'ERR_JOSE_ALG_NOT_ALLOWED', 'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

/**
 * 인증 거절의 한 모양: 상태 코드와 기계가 읽는 `code`(S7-U5, U5S-REQ-08). 화면은 문구가 아니라 code로 갈라 읽는다 —
 * 결속 누락(428)·다른 세션(409)·자격 없음(401)·끝난 세션(401)은 서로 다른 일을 요구한다.
 */
export function authRefusal(status: number, code: string, message: string) {
  return new HttpException({ code, message }, status);
}

/**
 * `AUTH_*` 거절은 응답 헤더 `X-KIN-Auth-Code`에도 코드를 싣는다(U5S-REQ-12). 프록시의 인증 서브요청(auth_request)은
 * 본문을 전달하지 못하므로, 직접 DICOM 요청이 받은 401/403이 어느 거절인지 알 길이 헤더뿐이다.
 */
export function markAuthCode(res: any, error: any) {
  const body = typeof error?.getResponse === 'function' ? error.getResponse() : null;
  const code = body && typeof body === 'object' ? (body as any).code : undefined;
  if (typeof code === 'string' && code.startsWith('AUTH_') && typeof res?.setHeader === 'function' && !res.headersSent)
    res.setHeader('X-KIN-Auth-Code', code);
}

/**
 * 토큰을 브라우저가 아니라 이 서비스 한 곳에서 다룬다. 콜백과 refresh가 같은 검증 함수를
 * 써야, 최초 로그인만 엄격하고 갱신 토큰은 느슨한 두 번째 인증 경로가 생기지 않는다.
 *
 * 세션 행의 버전은 읽은 accessToken·refreshToken 두 값이다. 모든 쓰기는 sid와 그 두 값을 조건으로 해서, 다른
 * 요청이나 다른 인스턴스가 그 사이에 저장한 새 버전을 옛 관찰로 지우거나 덮지 않는다(atExpiresAt·exp는 같은 값의
 * 다른 토큰을 가리지 못한다). 끝나는 세션은 조건부 삭제와 감사 행이 한 commit이고 삭제한 호출만 행을 쓴다.
 * 0행이면 그 관찰을 버리고 다시 읽는다. 외부 Keycloak 응답을 기다리는 동안에는 트랜잭션도 잠금도 잡지 않는다.
 *
 * 세션 종료의 완성(S7-U5 R1): 제품이 어떤 이유로든 제품 세션을 끝내면 그 세션이 태어난 provider 세션(`idpSid`)도 끝낸다.
 * 끝내기와 콜백의 세션 생성은 같은 provider 세션에 대해 하나의 잠금(트랜잭션 advisory lock)으로 줄을 서고, 끝내기는
 * 그 잠금 안에서 표식(IdpSessionEnd)을 남긴다 — 표식이 있는 provider 세션에서는 다시는 제품 세션이 만들어지지 않는다.
 * provider에 종료를 청하는 일(DELETE sessions/{sid})은 commit 뒤, 잠금 밖에서 하고, 확인될 때까지 표식이 다시 부른다.
 * 그 답(204·404)은 "그 SSO 세션이 인증 서버에서 끝났다"까지만 말한다: 이미 발급된 토큰은 자기 만료까지 서명이 유효하고
 * (그래서 Bearer 경로도 표식을 본다), 같은 SSO에 묶인 다른 애플리케이션의 자체 세션은 그 애플리케이션의 일이다.
 *
 * 쿠키의 주인(S7-U5, U5S-REQ-10): `kin_sid`를 쓰는 응답은 성공한 로그인 콜백 하나뿐이다. 로그아웃·만료·거절은 쿠키를
 * 지우지 않는다 — 그 응답이 늦게 닿으면 그사이 완료된 새 로그인의 쿠키를 지운다. 끝난 세션의 쿠키는 서버가 거절한다.
 */
@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly refreshes = new Map<string, Promise<RefreshOutcome>>();
  private readonly jwks = process.env.KC_JWKS_URL
    ? createRemoteJWKSet(new URL(process.env.KC_JWKS_URL))
    : null;
  private readonly logger = new Logger('AuthSession');
  private cleanupTimer?: NodeJS.Timeout;
  private idpEndTimer?: NodeJS.Timeout;
  private resuming = false;

  constructor(private prisma: PrismaService, private keycloak: KeycloakService) {}

  onModuleInit() {
    // 조회 시 idle 검사가 본체다. 타이머는 다시 오지 않는 세션 행을 치우는 수거원이고, 치운 세션도 접속기록에 남긴다.
    this.cleanupTimer = setInterval(() => {
      this.sweep().catch(() => this.storageWarning('sweep_cycle'));
    }, 60 * 60 * 1000);
    this.cleanupTimer.unref();
    // 표식 표가 곧 provider 종료의 대기열이다: 프로세스가 죽어도 잃지 않고, 시작할 때 미확인 행을 기한과 무관하게 다시 청한다.
    this.idpEndTimer = setInterval(() => { void this.resumeIdpEnds(false); }, IDP_END_TICK_MS);
    this.idpEndTimer.unref();
    void this.resumeIdpEnds(true);
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.idpEndTimer) clearInterval(this.idpEndTimer);
  }

  private cookie(req: any, name: string): string | null {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie ?? '');
    if (!match) return null;
    try { return decodeURIComponent(match[1]); }
    catch { return null; }
  }

  private appendCookie(res: any, value: string) {
    res.append('Set-Cookie', value);
  }

  sessionId(req: any): string | null {
    return this.cookie(req, 'kin_sid');
  }

  setSessionCookie(res: any, sid: string) {
    this.appendCookie(res, `kin_sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; Secure; SameSite=Strict`);
  }

  /**
   * 로그인 세션의 비밀 아닌 식별값. 쿠키 값(sid)에서 한 방향으로 만든다 — 이 값으로 쿠키를 되만들 수 없고, 이 값만으로는
   * 아무것도 인증되지 않는다. 화면은 `GET me`로 받아 그 세션의 요청마다 `X-KIN-Session`에 싣는다.
   */
  sessionRef(sid: string): string {
    return createHash('sha256').update('kin-session-id:' + sid).digest('base64url').slice(0, 32);
  }

  /** 요청이 실은 결속(X-KIN-Session)이 이 쿠키의 세션을 가리키는가. 판정에 DB도 토큰 갱신도 쓰지 않는다. */
  binding(req: any, sid: string): 'missing' | 'mismatch' | 'bound' {
    const sent = req?.headers?.['x-kin-session'];
    if (typeof sent !== 'string' || !sent) return 'missing';
    const expected = Buffer.from(this.sessionRef(sid)), actual = Buffer.from(sent);
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? 'bound' : 'mismatch';
  }

  private bindingMissing() {
    return authRefusal(428, 'AUTH_SESSION_REQUIRED', '요청에 로그인 세션 식별값(X-KIN-Session)이 없습니다');
  }

  private bindingMismatch() {
    return authRefusal(409, 'AUTH_SESSION_MISMATCH', '이 요청을 시작한 로그인 세션이 지금 브라우저의 세션과 다릅니다');
  }

  /** 결속이 없거나 다른 세션의 것이면 거절한다. 거절은 지금 쿠키의 세션이 무엇인지 말하지 않는다. */
  requireBinding(req: any, sid: string) {
    const binding = this.binding(req, sid);
    if (binding === 'missing') throw this.bindingMissing();
    if (binding === 'mismatch') throw this.bindingMismatch();
  }

  /** Bearer 호출은 CSRF 대상이 아니다. 브라우저가 자동으로 싣는 쿠키 호출만 헤더를 요구한다. */
  requireCsrf(req: any) {
    if (req?.headers?.['x-kin-csrf'] !== '1')
      throw authRefusal(403, 'AUTH_CSRF_REQUIRED', 'X-KIN-CSRF 헤더가 필요합니다');
  }

  credentialsMissing() {
    return authRefusal(401, 'AUTH_CREDENTIALS_MISSING', '인증 정보가 없습니다');
  }

  private ended(message: string) {
    return new UnauthorizedException({ code: 'AUTH_SESSION_ENDED', message });
  }

  /**
   * Keycloak에 닿지 못해 지금은 인증을 확인하지 못했다는 답(503). 세션은 그대로다 — 인증 서버의 일시 장애로 로그인된
   * 사람을 내보내지 않는다. 화면은 이 답을 세션 종료로 읽지 않고, 다음 요청이 다시 확인한다.
   */
  private idpUnavailable() {
    return authRefusal(503, 'AUTH_IDP_UNAVAILABLE',
      '인증 서버에 연결하지 못해 요청을 처리하지 못했습니다. 로그인은 유지됩니다 — 잠시 뒤 다시 시도해 주십시오');
  }

  private pendingSecret(): string {
    return process.env.KIN_COOKIE_SECRET!;
  }

  private signPending(pending: PendingLogin): string {
    const body = Buffer.from(JSON.stringify(pending)).toString('base64url');
    const signature = createHmac('sha256', this.pendingSecret()).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  /** 쿠키 이름은 state에서 한 방향으로 만든다: 콜백은 돌아온 state로 **자기 흐름의** 쿠키만 찾는다. */
  private pendingName(state: string): string {
    return PENDING_PREFIX + createHash('sha256').update('kin-pending:' + state).digest('base64url').slice(0, 22);
  }

  /** 서명과 모양이 맞는 pending. 나이는 여기서 보지 않는다 — 만료된 자기 흐름은 부른 쪽이 따로 다룬다. */
  private parsePending(value: string): PendingLogin | null {
    const parts = value.split('.');
    if (parts.length !== 2) return null;
    const expected = createHmac('sha256', this.pendingSecret()).update(parts[0]).digest();
    let actual: Buffer;
    try { actual = Buffer.from(parts[1], 'base64url'); }
    catch { return null; }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as PendingLogin;
      if (!parsed.state || !parsed.verifier || !Number.isFinite(parsed.issuedAt)) return null;
      if (!['plain', 'probe', 'fresh'].includes(parsed.phase) || !Number.isInteger(parsed.restarts)) return null;
      return parsed;
    } catch { return null; }
  }

  /** 이 브라우저가 들고 온 로그인 흐름들. 서명이 맞지 않는 쿠키는 pending이 null이다(치울 대상). */
  private pendingFlows(req: any): { name: string; pending: PendingLogin | null; live: boolean }[] {
    const flows: { name: string; pending: PendingLogin | null; live: boolean }[] = [];
    for (const part of String(req?.headers?.cookie ?? '').split(';')) {
      const at = part.indexOf('=');
      const name = at > 0 ? part.slice(0, at).trim() : '';
      if (!name.startsWith(PENDING_PREFIX)) continue;
      let pending: PendingLogin | null = null;
      try { pending = this.parsePending(decodeURIComponent(part.slice(at + 1).trim())); }
      catch { pending = null; }
      flows.push({ name, pending, live: !!pending && Date.now() - pending.issuedAt <= PENDING_VALID_MS });
    }
    return flows;
  }

  private expirePending(res: any, name: string) {
    this.appendCookie(res, `${name}=; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  }

  private publicOrigin(): string {
    return process.env.PUBLIC_ORIGIN!.replace(/\/$/, '');
  }

  private redirectUri(): string {
    return `${this.publicOrigin()}/api/auth/callback`;
  }

  private externalOidc(path: string): string {
    return `${process.env.KC_ISSUER}/protocol/openid-connect${path}`;
  }

  private internalOidc(path: string): string {
    const base = process.env.KC_JWKS_URL!.replace(/\/certs$/, '');
    return base + path;
  }

  /**
   * 접속지. 프록시가 X-Real-IP를 클라이언트 주소($remote_addr)로 덮어쓴다. req.ip는 trust proxy가 없어 프록시 주소이고
   * X-Forwarded-For 앞머리는 클라이언트가 위조할 수 있다. IP 문자열이 아니면 기록하지 않는다.
   */
  private requestIp(req: any): string | null {
    const value = req?.headers?.['x-real-ip'];
    return typeof value === 'string' && isIP(value) ? value : null;
  }

  /** 행의 신원: guard와 같은 유도(actor·sub·그룹이 정확히 하나일 때의 기관). */
  private identity(claims: Record<string, any>, sub: string): Who {
    const target = typeof claims.sub === 'string' ? claims.sub : sub;
    const groups: string[] = (Array.isArray(claims.groups) ? claims.groups : [])
      .filter((group: unknown): group is string => typeof group === 'string')
      .map(group => group.replace(/^\//, ''));
    return {
      actor: String(claims.email ?? claims.preferred_username ?? target),
      target,
      institution: groups.length === 1 ? groups[0] : null,
    };
  }

  /**
   * 끝난 세션의 신원은 삭제 조건에 쓴 그 관찰의 저장 access token에서 읽는다 — 저장 전에 검증한 토큰이다.
   * 지금 Keycloak 그룹이나 따로 먼저 읽은 다른 관찰로 귀속하지 않는다(기록 시점 기관, D7).
   */
  private storedIdentity(session: Session): Who {
    let claims: Record<string, any> = {};
    try { claims = decodeJwt(session.accessToken); }
    catch { claims = {}; }
    return this.identity(claims, session.sub);
  }

  /** 검증한 토큰의 provider 세션 id(`sid`). 비어 있지 않은 문자열만 받는다. */
  private idpSidOfClaims(claims: Record<string, any>): string | null {
    return typeof claims?.sid === 'string' && claims.sid ? claims.sid : null;
  }

  /** 이 세션이 태어난 provider 세션. 열이 생기기 전의 행은 저장된 access token(저장 전에 검증한 토큰)에서 읽는다. */
  private idpSidOf(session: Session): string | null {
    if (session.idpSid) return session.idpSid;
    try { return this.idpSidOfClaims(decodeJwt(session.accessToken)); }
    catch { return null; }
  }

  /** 원시 DB 오류는 이 경계 밖으로 나가지 않는다: 고정 분류만 로그에, 응답은 고정 500(S7-U5 §0.B). */
  private storageWarning(step: StorageStep) {
    this.logger.warn('auth_storage category=' + step);
  }

  private storageFailure() {
    return new InternalServerErrorException({
      code: 'AUTH_STORAGE_FAILURE',
      message: '로그인 세션 정보를 저장소에서 처리하지 못했습니다. 잠시 뒤 다시 시도해 주십시오',
    });
  }

  private async storage<T>(step: StorageStep, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      this.storageWarning(step);
      throw this.storageFailure();
    }
  }

  private conflict() {
    return authRefusal(409, 'AUTH_SESSION_BUSY',
      '다른 요청이 같은 로그인 세션을 바꾸고 있어 처리를 마치지 못했습니다. 다시 시도해 주십시오');
  }

  private readSession(sid: string): Promise<Session | null> {
    return this.storage('session_read', () => this.prisma.authSession.findUnique({ where: { sid } }));
  }

  /** 관찰한 버전의 조건: sid와 읽은 두 토큰 값. */
  private version(session: Session) {
    return { sid: session.sid, accessToken: session.accessToken, refreshToken: session.refreshToken };
  }

  /**
   * provider 세션 하나에 대한 줄 세우기: 트랜잭션 advisory lock. 끝내기와 콜백의 세션 생성이 같은 키를 잡으므로 "표식을
   * 보고 → 세션을 만든다"와 "표식을 남기고 → 그 세션의 행을 모두 지운다"가 겹치지 않는다. 트랜잭션이 끝나면 풀리고(연결
   * 풀에 남지 않는다), 기다림은 그 트랜잭션의 lock_timeout을 따른다. 키는 고정 이름공간과, 발급자·세션 id의 해시다 — 키가
   * 우연히 겹친 두 세션은 잠깐 줄을 설 뿐 서로의 판정에 섞이지 않는다(판정은 잠금 뒤에 읽은 행이 한다).
   */
  private async lockIdpSession(tx: any, idpSid: string): Promise<void> {
    await this.advisoryLock(tx, IDP_LOCK_SPACE, idpSid);
  }

  /**
   * 회원 하나에 대한 줄 세우기(같은 트랜잭션 advisory lock, 다른 이름공간). 격리 사실의 쓰기와 콜백의 "사실을 보고 → 세션을
   * 만든다"가 겹치지 않는다: 콜백이 먼저면 그 세션 행은 격리가 사실 뒤에 끝내는 행에 들고, 사실이 먼저면 콜백이 그것을 본다.
   * 잡는 순서는 늘 provider 세션 잠금 → 회원 잠금이다(사실을 쓰는 쪽은 회원 잠금 하나만 잡는다) — 교착이 없다.
   */
  private async lockMember(tx: any, sub: string): Promise<void> {
    await this.advisoryLock(tx, MEMBER_LOCK_SPACE, sub);
  }

  private async advisoryLock(tx: any, space: number, name: string): Promise<void> {
    const key = createHash('sha256').update(`${process.env.KC_ISSUER}\n${name}`).digest().readInt32BE(0);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${space}::int4, ${key}::int4)`;
  }

  /**
   * 관찰 S의 세션을 끝낸다(모든 원인의 한 길). 한 트랜잭션에서, S가 태어난 provider 세션의 잠금을 **먼저** 잡고:
   *   1. 끝내는 조건을 다시 확인한다 — S 조건부 삭제(idle·sweep은 lastSeenAt < cutoff를 다시). 0행이면 아무것도 남기지 않는다:
   *      경쟁에 진 관찰은 표식을 만들지 못한다(그사이 갱신되어 살아 있는 세션의 provider 세션을 끝내면 안 된다).
   *   2. 표식을 남긴다. 처음 정한 cause·decidedAt은 덮지 않고, 이미 확인된 표식이면 종료 요청을 다시 깨운다.
   *   3. 같은 provider 세션에서 태어난 다른 제품 행도 모두 끝낸다(쿠키를 잃은 뒤 같은 SSO로 생긴 둘째 행).
   *   4. 실제로 지운 행마다 접속기록 한 행. 재시도와 provider 종료 요청은 행을 더하지 않는다.
   * `ended: false`는 지우지 못했다는 뜻일 뿐 세션 부재의 증거가 아니다. provider 종료 요청은 commit 뒤에 부른 쪽이 한다.
   *
   * 대기는 유한하다(U5S-REQ-18): 연결 4초, 잠금 3초, 트랜잭션 8초. 삭제는 그 세션으로 진행 중인 초안 쓰기의 세션 잠금을
   * 기다린다 — 그 쓰기는 종료보다 먼저 commit되거나, 종료 뒤에 실패한다. 잠금을 제때 얻지 못하면 끝내지 않고 409다.
   */
  private async endSession(
    session: Session, cause: EndCause, ip: string | null, options: { idleCutoff?: Date; trigger?: Reason } = {},
  ): Promise<EndResult> {
    const idpSid = this.idpSidOf(session);
    const where = options.idleCutoff
      ? { ...this.version(session), lastSeenAt: { lt: options.idleCutoff } } : this.version(session);
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        if (idpSid) await this.lockIdpSession(tx, idpSid);
        const { count } = await tx.authSession.deleteMany({ where });
        if (count !== 1) return { ended: false, idpSid: null };
        await this.endRows(tx, idpSid, [session], cause, ip, options.trigger);
        return { ended: true, idpSid };
      }, { maxWait: 4000, timeout: 8000 });
    } catch (error: any) {
      if (lockWaitExceeded(error)) throw this.conflict();
      this.storageWarning('end_transaction');
      throw this.storageFailure();
    }
  }

  /**
   * 잠금을 쥔 트랜잭션 안에서: 표식을 남기고, 그 provider 세션의 남은 제품 행을 모두 지우고, 지운 행(`ended`에 이미 든 것
   * 포함)마다 접속기록 한 행을 쓴다. 원인은 사실대로 적는다 — 재인증으로 끝난 행은 무엇이 그 재인증을 불렀는지(trigger)도.
   */
  private async endRows(
    tx: any, idpSid: string | null, ended: Session[], cause: EndCause, ip: string | null, trigger?: Reason,
  ): Promise<void> {
    if (idpSid) {
      const now = new Date();
      await tx.idpSessionEnd.upsert({
        where: { idpSid },
        create: { idpSid, cause, decidedAt: now, nextAttemptAt: now },
        update: { confirmedAt: null, nextAttemptAt: now },
      });
      const others: Session[] = await tx.authSession.findMany({ where: { idpSid } });
      for (const other of others) {
        const { count } = await tx.authSession.deleteMany({ where: { sid: other.sid } });
        if (count === 1) ended.push(other);
      }
    }
    for (const row of ended) {
      const who = this.storedIdentity(row);
      await tx.auditLog.create({ data: {
        actor: who.actor,
        // 만료로 세는 것은 이 셋뿐이다. 사람이나 로그인 시작이 부른 종료(새 원인 포함)는 만료로 떨어지지 않는다.
        action: cause === 'idle' || cause === 'refresh_failed' || cause === 'sweep' ? AUTH_EXPIRED : AUTH_LOGOUT,
        target: who.target,
        detail: JSON.stringify(cause === 'reauthentication'
          ? { institution: who.institution, ip, dataSubject: null, cause, trigger: trigger ?? null }
          : { institution: who.institution, ip, dataSubject: null, cause }),
      } });
    }
  }

  /** 끝내고, 끝냈으면 provider 종료를 청해 둔다(기다리지 않는다). idle·refresh 거절·수거·평소의 Log out이 쓴다. */
  private async endAndTell(session: Session, cause: EndCause, ip: string | null, idleCutoff?: Date): Promise<boolean> {
    const result = await this.endSession(session, cause, ip, { idleCutoff });
    if (result.ended && result.idpSid) this.tellIdp(result.idpSid);
    return result.ended;
  }

  /**
   * 관리자의 회원 격리(정지·승인 변경·승인 취소). 순서가 계약이다:
   *   1. 우리 쪽 사실을 먼저 남긴다(MemberIsolation, 회원 잠금 안에서 한 commit). 이때부터 콜백과 갱신은 이 회원에게 세션을
   *      만들거나 잇지 않는다 — 인증 서버의 관리 API가 그 뒤에 답하지 않아도 그렇다(로그인 길에서 관리 API를 읽지 않는다).
   *   2. 그 회원의 지금 제품 세션을 끝낸다(우리 DB만의 일; 표식·접속기록·provider 종료 요청은 끝내기의 한 길 그대로).
   *   3. 인증 서버 일(finishIsolation). 어디서 끊기면 던지고, 사실은 "인증 서버 일이 남음"으로 남아 종료 재시도 주기가 잇는다.
   * 이미 사실이 있으면(앞선 격리가 끝나지 않았거나 정지된 회원을 다시 격리) 남은 인증 서버 일을 다시 하도록 되돌린다.
   */
  async isolateMember(sub: string): Promise<void> {
    const now = new Date();
    try {
      await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await this.lockMember(tx, sub);
        await tx.memberIsolation.upsert({
          where: { sub },
          create: { sub, decidedAt: now, nextAttemptAt: new Date(now.getTime() + IDP_END_BACKOFF_MS[0]) },
          update: { providerDoneAt: null, nextAttemptAt: new Date(now.getTime() + IDP_END_BACKOFF_MS[0]) },
        });
      }, { maxWait: 4000, timeout: 8000 });
    } catch (error: any) {
      if (lockWaitExceeded(error)) throw this.conflict();
      this.storageWarning('isolation_write');
      throw this.storageFailure();
    }
    await this.endMemberSessions(sub);
    await this.finishIsolation(sub);
  }

  /**
   * 격리의 인증 서버 일: 그 회원의 provider 세션을 나열해 전부 표식 → 비활성화 → 다시 나열해 그사이 생긴 것도 표식 →
   * 사용자 전체 로그아웃 → 남은 제품 행을 끝냄. 나열·표식은 비활성화 **앞에도** 한다: 비활성화가 성공하고 나열이 실패해도
   * 이미 본 provider 세션은 표식으로 막혀 있다. 모두 몇 번을 다시 해도 같은 결과가 되는 일이라 재시도 주기가 처음부터 다시
   * 한다. 끝까지 가면 사실에 완료 시각을 적는다(사실 자체는 남는다 — 지우는 것은 끝까지 성공한 재활성화뿐이다).
   */
  async finishIsolation(sub: string): Promise<void> {
    await this.endMemberSessions(sub, await this.keycloak.userSessions(sub));
    await this.keycloak.setEnabled(sub, false);
    await this.endMemberSessions(sub, await this.keycloak.userSessions(sub));
    await this.keycloak.logoutUser(sub);
    await this.endMemberSessions(sub);
    await this.storage('isolation_write', () => this.prisma.memberIsolation.updateMany({
      where: { sub, providerDoneAt: null }, data: { providerDoneAt: new Date() } }));
  }

  /** 격리 사실이 있는가(콜백 밖의 읽기: 재활성화가 남은 인증 서버 일을 먼저 끝내야 하는지 본다). */
  async isolation(sub: string): Promise<{ providerDone: boolean } | null> {
    const row = await this.storage('isolation_read', () => this.prisma.memberIsolation.findUnique({ where: { sub } }));
    return row ? { providerDone: row.providerDoneAt !== null } : null;
  }

  /**
   * 재활성화의 마지막 걸음: 회원을 다시 활성으로 만든 일이 끝까지 성공한 **뒤에** 부른다. 그 전에 실패하면 사실은 남고
   * 콜백은 계속 막는다. 격리가 표식으로 남긴 provider 세션은 이것으로 다시 열리지 않는다(표식은 따로 남는다).
   */
  async clearIsolation(sub: string): Promise<void> {
    await this.storage('isolation_write', () => this.prisma.memberIsolation.deleteMany({ where: { sub } }));
  }

  /**
   * 관리자의 회원 격리(정지·승인 변경·승인 취소, admin.service isolate)가 그 회원의 제품 세션을 끝낸다. 길은 하나다(R1):
   * 세션마다 그 provider 세션의 잠금 안에서 표식·삭제·접속기록(원인 isolation)을 한 commit으로 하고, commit 뒤 provider
   * 종료를 청한다. 표식이 있으므로 격리 전에 code를 교환해 둔 콜백도 그 provider 세션으로는 세션을 만들지 못한다.
   * 경쟁에 진 관찰(그사이 갱신된 행)은 다시 읽어 끝내고, 그래도 남으면 409다 — 부른 쪽이 격리 실패로 다룬다.
   * 다른 PC의 provider 세션까지 끝내는 것은 부른 쪽의 사용자 전체 로그아웃(logoutUser)이다: 격리는 그 회원 전체의 일이다.
   */
  async endMemberSessions(sub: string, idpSids: string[] = []): Promise<void> {
    /**
     * 먼저, 부른 쪽이 인증 서버에서 읽어 온 그 회원의 provider 세션 **전부**에 표식을 남긴다(제품 행이 아직 없는 것까지 —
     * 격리 전에 code를 교환해 둔 콜백의 SSO도 여기 있다). 기록된 사실이라 시점에 기대지 않는다: 그 콜백은 언제 commit하든,
     * 그 사이 회원이 다시 활성화되었든 콜백의 표식 검사가 막는다. 각 표식은 그 provider 세션의 잠금 안에서 남기고 그
     * provider 세션의 행을 함께 끝낸다(endRows — 같은 잠금이라 먼저 잠금을 쥔 콜백의 세션은 그 commit 뒤 여기서 끝난다).
     */
    for (const idpSid of new Set(idpSids)) {
      try {
        await this.prisma.$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
          await this.lockIdpSession(tx, idpSid);
          await this.endRows(tx, idpSid, [], 'isolation', null);
        }, { maxWait: 4000, timeout: 8000 });
      } catch (error: any) {
        if (lockWaitExceeded(error)) throw this.conflict();
        this.storageWarning('end_transaction');
        throw this.storageFailure();
      }
      this.tellIdp(idpSid);
    }
    for (let rounds = 0; ; rounds++) {
      const rows: Session[] = await this.storage('session_read', () => this.prisma.authSession.findMany({ where: { sub } }));
      if (!rows.length) return;
      if (rounds === TRANSITION_LIMIT) throw this.conflict();
      for (const row of rows) await this.endAndTell(row, 'isolation', null);
    }
  }

  /**
   * 로그아웃·계정 전환·재인증·가입 진입. 0행이면 지금 세션으로 인증을 이어 가지 않고 다시 읽는다 — 없으면 이미 끝난
   * 것이고, 있으면 그 새 관찰로 삭제를 다시 한다. 세 번째 0행 뒤에도 남아 있으면 409(종료 행 0, 쿠키 그대로).
   * 이 호출이 실제로 끝냈을 때만 `ended`이고, 그때의 provider 세션을 함께 돌려준다.
   */
  private async endByRequest(
    sid: string, session: Session | null, cause: EndCause, ip: string | null, trigger?: Reason,
  ): Promise<EndResult> {
    for (let writes = 0; session; ) {
      if (writes === TRANSITION_LIMIT) throw this.conflict();
      writes++;
      const result = await this.endSession(session, cause, ip, { trigger });
      if (result.ended) return result;
      session = await this.readSession(sid);
    }
    return { ended: false, idpSid: null };
  }

  // ── provider 종료 요청(표식이 곧 대기열) ──

  /**
   * provider에 그 세션의 종료를 한 번 청하고, 끝났다(204)·없다(404)는 답이면 표식에 확인 시각을 적는다. 그 밖의 답은
   * 미확인으로 남는다. 확인 시각을 적지 못해도(DB 오류) provider 세션은 끝났다 — 표식은 미확인으로 남아 다음 시도가 404로 닫는다.
   */
  private async confirmIdpEnd(idpSid: string, limitMs: number): Promise<boolean> {
    if (await this.keycloak.endSession(idpSid, limitMs) === 'unconfirmed') return false;
    try {
      await this.prisma.idpSessionEnd.updateMany({ where: { idpSid, confirmedAt: null }, data: { confirmedAt: new Date() } });
    } catch {
      this.storageWarning('idp_end_write');
    }
    return true;
  }

  /** 방금 끝낸 세션의 provider 종료를 청해 둔다. 답을 기다리지 않고, 실패는 표식에 남아 주기가 다시 청한다. */
  private tellIdp(idpSid: string) {
    void (async () => {
      try {
        await this.prisma.idpSessionEnd.updateMany({
          where: { idpSid, confirmedAt: null },
          data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + IDP_END_BACKOFF_MS[0]) },
        });
      } catch {
        this.storageWarning('idp_end_write');
        return;
      }
      await this.confirmIdpEnd(idpSid, IDP_END_MS);
    })();
  }

  /**
   * 미확인 표식의 provider 종료를 다시 청한다. 주기마다는 기한(nextAttemptAt)이 된 것만, 프로세스 시작 때는 미확인 전부.
   * 여러 인스턴스가 같은 행을 보면 시도 횟수를 조건으로 한 갱신이 하나만 통과시킨다. 실패하면 다음 기한이 늦어질 뿐 행은 남는다.
   */
  private async resumeIdpEnds(all: boolean) {
    if (this.resuming) return;
    this.resuming = true;
    try {
      const due = await this.prisma.idpSessionEnd.findMany({
        where: all ? { confirmedAt: null } : { confirmedAt: null, nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: 'asc' },
        take: 50,
      });
      for (const row of due) {
        const wait = IDP_END_BACKOFF_MS[Math.min(row.attempts, IDP_END_BACKOFF_MS.length - 1)];
        const { count } = await this.prisma.idpSessionEnd.updateMany({
          where: { idpSid: row.idpSid, confirmedAt: null, attempts: row.attempts },
          data: { attempts: row.attempts + 1, nextAttemptAt: new Date(Date.now() + wait) },
        });
        if (count === 1) await this.confirmIdpEnd(row.idpSid, IDP_END_MS);
      }
    } catch {
      this.storageWarning('idp_end_cycle');
    }
    // 끝나지 않은 격리의 인증 서버 일도 같은 대기열 규칙으로 잇는다(우리 쪽 사실이 곧 대기열이다): 프로세스 시작 때는 전부,
    // 주기마다는 기한이 된 것만. 시도 횟수를 조건으로 한 갱신이 여러 인스턴스 중 하나만 통과시킨다. 실패는 다음 기한을 늦출 뿐이다.
    try {
      const owed = await this.prisma.memberIsolation.findMany({
        where: all ? { providerDoneAt: null } : { providerDoneAt: null, nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: 'asc' },
        take: 20,
      });
      for (const row of owed) {
        const wait = IDP_END_BACKOFF_MS[Math.min(row.attempts + 1, IDP_END_BACKOFF_MS.length - 1)];
        const { count } = await this.prisma.memberIsolation.updateMany({
          where: { sub: row.sub, providerDoneAt: null, attempts: row.attempts },
          data: { attempts: row.attempts + 1, nextAttemptAt: new Date(Date.now() + wait) },
        });
        if (count !== 1) continue;
        try { await this.finishIsolation(row.sub); }
        catch { /* 사실은 남고 다음 기한에 다시 한다. */ }
      }
    } catch {
      this.storageWarning('isolation_cycle');
    } finally {
      this.resuming = false;
    }
  }

  /**
   * Bearer 경로의 표식 검사(가드가 부른다). 제품 세션 행을 지워도 이미 발급된 access token은 만료까지 서명이 유효하다 —
   * 끝내기로 한 provider 세션의 사용자 토큰은 여기서 거절한다. `sid`가 없는 토큰(서비스 계정·gateway)은 대상이 아니다.
   */
  async refuseEndedIdpSession(claims: Record<string, any>): Promise<void> {
    const idpSid = this.idpSidOfClaims(claims);
    if (!idpSid) return;
    const mark = await this.storage('idp_end_read', () =>
      this.prisma.idpSessionEnd.findUnique({ where: { idpSid }, select: { idpSid: true } }));
    if (mark) throw this.ended('인증 세션이 없습니다');
  }

  // ── 로그인 시작 ──

  /**
   * 로그인 흐름 하나를 시작하고 인증 서버의 주소를 준다. pending은 흐름마다 따로 둔다 — 다른 탭이 시작한 로그인이 이 탭의
   * 흐름을 덮지 않는다. 이 브라우저가 받아 둔 복구 의도(살아 있는 다른 흐름의 사유)는 평범한 시작이 낮추지 못한다: 그동안의
   * 평범한 로그인·가입 시작은 같은 의도의 probe 단계로 시작한다.
   */
  private startFlow(
    req: any, res: any, want: { phase: Phase; reason: Reason | null; prompt: 'login' | 'create' | null; restarts?: number },
  ): string {
    const flows = this.pendingFlows(req);
    let { phase, reason, prompt } = want;
    if (phase === 'plain') {
      const intent = flows.find(flow => flow.live && flow.pending!.reason);
      if (intent) {
        phase = 'probe';
        reason = intent.pending!.reason;
      }
    }
    if (phase !== 'plain' && !prompt) prompt = 'login';
    // 서명이 맞지 않는 쿠키는 치우고, 상한을 넘으면 가장 오래된 흐름부터 치운다.
    const known = flows.filter(flow => flow.pending).sort((a, b) => a.pending!.issuedAt - b.pending!.issuedAt);
    for (const flow of [...flows.filter(flow => !flow.pending), ...known.slice(0, Math.max(0, known.length - (PENDING_LIMIT - 1)))])
      this.expirePending(res, flow.name);

    const restarts = want.restarts ?? 0;
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url') + (restarts > 0 ? RESTARTED : '');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const pending: PendingLogin = { state, verifier, issuedAt: Date.now(), phase, reason, prompt, restarts };
    this.appendCookie(res, `${this.pendingName(state)}=${encodeURIComponent(this.signPending(pending))}; Path=/api/auth; `
      + `HttpOnly; Secure; SameSite=Lax; Max-Age=${PENDING_COOKIE_SECONDS}`);

    const query = new URLSearchParams({
      client_id: 'kin-bff',
      response_type: 'code',
      scope: 'openid profile email',
      redirect_uri: this.redirectUri(),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    // probe는 화면 없이 SSO만 알아낸다. fresh는 자격 입력을 요구한다(앞의 SSO가 끝났으므로 이름을 칠 수 있는 폼이다).
    if (phase === 'probe') query.set('prompt', 'none');
    else if (prompt) query.set('prompt', prompt);
    return `${this.externalOidc('/auth')}?${query}`;
  }

  /**
   * 링크로 여는 로그인·가입(GET). **아무 세션도 끝내지 않는다** — 결속 없는 GET이 세션을 끝내면 다른 문서가 쓰고 있는
   * 로그인이 링크 한 번에 사라진다. 살아 있는 세션의 쿠키가 있으면 흐름을 시작하지 않고 null을 준다(그 세션을 바꾸는
   * 로그인은 아래의 POST가 한다). 주소의 매개변수는 의도를 정하지 못한다: 재인증 의도는 CSRF로 보호된 POST만 시작한다.
   */
  async beginLogin(req: any, res: any, prompt?: 'create'): Promise<string | null> {
    if (await this.hasSession(req)) return null;
    return this.startFlow(req, res, { phase: 'plain', reason: null, prompt: prompt ?? null });
  }

  /**
   * 재인증 의도의 로그인 시작(POST, R2). 사람이 떠나려 했거나(끝내지 못한 로그아웃), 떠났는지 알 수 없거나(저장소 불신·
   * 기록 손상), 계정을 바꾸려 할 때 랜딩이 그 사유를 밝혀 보낸다. 쿠키가 없어도 받는다 — 의도는 주소가 아니라 이 요청과
   * 서버의 pending 상태에 있다.
   */
  async beginReauthentication(req: any, res: any, body: any): Promise<string> {
    this.requireCsrf(req);
    const reason = body?.intent === 'reauthenticate' && LOGIN_REASONS.includes(body?.reason) ? body.reason as Reason : null;
    if (!reason)
      throw authRefusal(400, 'AUTH_LOGIN_INTENT_INVALID', '로그인 시작 요청의 의도(intent·reason)가 올바르지 않습니다');
    return this.beginSensitive(req, res, reason, 'login');
  }

  /**
   * 가입 진입(POST). 가입은 계정 바꾸기가 아니다: 살아 있는 세션이 있으면 같은 종료 절차로 끝내되 원인은 재인증
   * (trigger=register)이고, 끝낼 세션이 없으면 접속기록 없이 가입 화면으로 간다.
   */
  async beginBoundRegister(req: any, res: any): Promise<string> {
    this.requireCsrf(req);
    return this.beginSensitive(req, res, 'register', 'create');
  }

  /**
   * 쿠키의 제품 세션이 살아 있으면: 이 요청이 **그 세션을 본 문서**의 것인지 결속으로 확인하고(다르면 아무것도 끝내지 않고
   * 거절 — 다른 탭이 그사이 새로 로그인한 세션을 옛 문서가 끝내지 못한다), 그 세션을 감사와 함께 끝낸 뒤 provider 종료를
   * **기다린다**. 확인되면 곧바로 fresh 단계의 주소를 준다. 확인되지 않으면 503이다 — 제품 세션은 이미 끝났고 표식이
   * 남아 그 SSO로는 들어오지 못하며, 같은 버튼을 다시 누르면 된다. 종료 자체를 확인하지 못하면(409·저장소 실패) 새
   * pending도 이동도 만들지 않는다.
   * 끝낼 제품 세션이 없으면: 재인증 의도는 probe 단계로 시작하고(그 단계가 이 브라우저의 SSO를 알아내 끝낸다), 가입은
   * 평범하게 시작한다.
   */
  private async beginSensitive(req: any, res: any, reason: Reason, prompt: 'login' | 'create'): Promise<string> {
    const sid = this.sessionId(req);
    let session: Session | null = null;
    if (sid) {
      // 다른 세션의 결속은 읽기 전에 거절한다. 결속 없는 요청은 끝낼 세션이 정말 있을 때만 거절한다 — 세션이 이미 없으면
      // (401을 받은 문서는 식별값을 모른다) 끝낼 것이 없으므로 결속을 요구할 이유도 없다.
      const binding = this.binding(req, sid);
      if (binding === 'mismatch') throw this.bindingMismatch();
      session = await this.readSession(sid);
      if (session && binding === 'missing') throw this.bindingMissing();
    }
    if (!sid || !session)
      return this.startFlow(req, res, reason === 'register'
        ? { phase: 'plain', reason: null, prompt } : { phase: 'probe', reason, prompt });
    const end = await this.endByRequest(sid, session, REASON_CAUSE[reason], this.requestIp(req), reason);
    // 그사이 다른 요청이 끝냈거나 provider 세션을 모르는 행이면, 남아 있을지 모르는 SSO는 probe 단계가 알아내 끝낸다.
    if (!end.ended || !end.idpSid) return this.startFlow(req, res, { phase: 'probe', reason, prompt });
    if (!await this.confirmIdpEnd(end.idpSid, IDP_END_WAIT_MS))
      throw authRefusal(503, 'AUTH_IDP_END_UNCONFIRMED',
        '이전 로그인의 종료를 인증 서버에서 확인하지 못했습니다. 잠시 뒤 다시 시도해 주십시오');
    return this.startFlow(req, res, { phase: 'fresh', reason, prompt });
  }

  async hasSession(req: any): Promise<boolean> {
    const sid = this.sessionId(req);
    if (!sid) return false;
    const session = await this.storage('session_read', () => this.prisma.authSession.findUnique({
      where: { sid }, select: { lastSeenAt: true },
    }));
    return !!session && session.lastSeenAt.getTime() >= Date.now() - SESSION_IDLE_MS;
  }

  /**
   * 로그인 실패 행(OP-2 A). 이 서버가 시작한 로그인(서명·기한이 맞는 pending)에만 쓴다 — 익명 콜백이 행을 만들지 못하게.
   * 콜백의 error 원문·code·state는 남기지 않는다. 기록 실패는 고정 분류만 남기고 콜백 응답을 바꾸지 않는다.
   */
  private async loginFailureRow(req: any, cause: LoginFailureCause, who: Who | null) {
    try {
      await this.prisma.auditLog.create({ data: {
        actor: who?.actor ?? 'unknown',
        action: AUTH_LOGIN,
        target: who?.target ?? '',
        detail: JSON.stringify({
          institution: who?.institution ?? null, ip: this.requestIp(req), dataSubject: null, outcome: 'failure', cause,
        }),
      } });
    } catch {
      this.storageWarning('login_failure_row');
    }
  }

  private proofHash(proof: string): string {
    return createHash('sha256').update('kin-entry-proof:' + proof).digest('base64url');
  }

  private async exchangeCode(code: string, verifier: string): Promise<any | null> {
    try {
      const response = await fetch(this.internalOidc('/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'kin-bff',
          client_secret: process.env.KC_WEB_SECRET!,
          code,
          redirect_uri: this.redirectUri(),
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(IDP_TOKEN_MS),
      });
      const answer: any = await response.json().catch(() => ({}));
      return response.ok && answer.access_token && answer.refresh_token ? answer : null;
    } catch {
      return null;
    }
  }

  /**
   * 로그인 콜백 — 제품 세션이 만들어지는 유일한 자리다.
   *
   * 콜백은 **자기 흐름만** 소비한다: 돌아온 state로 찾은 pending 하나만 지우고, 그것이 없거나 맞지 않으면 code를 교환하지도
   * 세션을 만들지도 않는다. 그런 콜백은 살아 있는 세션이 있으면 업무 문서로 가고, 없으면 로그인을 한 번만 다시 시작한다
   * (만료된 자기 흐름이면 그 의도를 지킨 채). 두 번째는 랜딩의 안내다.
   *
   * 성공한 로그인은 세션과 함께 **진입 증명**을 만든다(U5S-REQ-09): 콜백이 이동시키는 그 문서가 "방금 이 로그인을 한
   * 문서"임을 한 번 보일 수 있는 값이다. 저장하는 것은 해시와 만료뿐이고, 원문은 이동 주소의 fragment로만 나간다.
   */
  async finishCallback(req: any, res: any, query: { code?: string; state?: string; error?: string }): Promise<CallbackResult> {
    const { code, state, error } = query;
    if ((!code || !state) && await this.hasSession(req)) return { kind: 'work' };
    const flows = this.pendingFlows(req);
    const found = state ? flows.find(flow => flow.name === this.pendingName(state)) : undefined;
    const own: Flow | null = found?.pending && found.pending.state === state ? found as Flow : null;
    if (own) this.expirePending(res, own.name);

    if (!own?.live) {
      // 이 서버가 시작해 아직 통하는 로그인이 이 브라우저에 있을 때만 실패 행을 남긴다(익명 콜백은 행을 만들지 못한다).
      const started = flows.some(flow => flow.live);
      if (error) {
        if (started) await this.loginFailureRow(req, 'provider_error', null);
        return { kind: 'landing', error };
      }
      if (!code) {
        if (started) await this.loginFailureRow(req, 'no_code', null);
        return { kind: 'landing', error: 'stale' };
      }
      if (!own && started) await this.loginFailureRow(req, 'state_mismatch', null);
      if (await this.hasSession(req)) return { kind: 'work' };
      if (own ? own.pending.restarts > 0 : String(state ?? '').endsWith(RESTARTED)) return { kind: 'landing', error: 'stale' };
      const before = own?.pending;
      return { kind: 'redirect', location: this.startFlow(req, res, before?.reason
        ? { phase: 'probe', reason: before.reason, prompt: before.prompt, restarts: 1 }
        : { phase: 'plain', reason: null, prompt: before?.prompt ?? null, restarts: 1 }) };
    }

    const flow = own.pending;
    if (error) {
      // probe의 login_required: 이 브라우저에 끝낼 SSO가 없다. 마지막 단계로 간다.
      if (flow.phase === 'probe' && error === 'login_required')
        return { kind: 'redirect', location: this.startFlow(req, res,
          { phase: 'fresh', reason: flow.reason, prompt: flow.prompt, restarts: flow.restarts }) };
      if (flow.phase === 'probe') {
        /**
         * probe의 그 밖의 답(interaction_required·consent_required 같은): 이 브라우저의 SSO를 알아내지 못했다 — 끝낼 SSO가
         * 없다는 뜻도, 자격 없이 들어가도 된다는 뜻도 아니다. 한 번 다시 묻는다(일시적인 답이면 이번에 code나 login_required가
         * 온다). 또 그러면 fresh 단계(prompt=login)로 간다: 자격을 실제로 입력해야만 세션이 생기므로 R2가 지켜지고, 랜딩에서
         * 같은 답만 되풀이하는 막다른 길이 없다(지휘자 결정, 수정 1회차). 평범한 로그인으로 낮추지 않고, probe 단계는 어떤
         * 답에도 제품 세션을 만들지 않는다. 인증 서버 자체가 답하지 못한 것(temporarily_unavailable·server_error)만 랜딩의
         * 문장이다 — 그때는 그 의도를 실은 흐름 하나를 남겨 그동안의 평범한 시작도 probe로 간다.
         */
        if (flow.restarts === 0)
          return { kind: 'redirect', location: this.startFlow(req, res,
            { phase: 'probe', reason: flow.reason, prompt: flow.prompt, restarts: 1 }) };
        if (!PROVIDER_DOWN.includes(error))
          return { kind: 'redirect', location: this.startFlow(req, res,
            { phase: 'fresh', reason: flow.reason, prompt: flow.prompt, restarts: flow.restarts }) };
        await this.loginFailureRow(req, 'provider_error', null);
        this.startFlow(req, res, { phase: 'probe', reason: flow.reason, prompt: flow.prompt, restarts: flow.restarts });
        return { kind: 'landing', error: 'sso_unidentified' };
      }
      // 실패 행의 error 원문은 행에 싣지 않는다(OP-2 A).
      await this.loginFailureRow(req, 'provider_error', null);
      return { kind: 'landing', error };
    }
    if (!code) {
      await this.loginFailureRow(req, 'no_code', null);
      return { kind: 'landing', error: 'stale' };
    }

    const tokens = await this.exchangeCode(code, flow.verifier);
    if (!tokens) {
      await this.loginFailureRow(req, 'exchange_failed', null);
      return { kind: 'landing', error: 'login_failed' };
    }
    let payload: JWTPayload & Record<string, any>;
    let idpSid: string | null = null;
    try {
      payload = await this.verifyAccessToken(tokens.access_token);
      idpSid = this.idpSidOfClaims(payload);
    } catch {
      idpSid = null;
      payload = {};
    }
    if (!idpSid) {
      // 검증하지 못한 토큰의 sub·email·groups는 행에 쓰지 않는다. provider 세션을 밝히지 않는 토큰으로는 세션을 만들지 않는다.
      await this.loginFailureRow(req, 'token_invalid', null);
      return { kind: 'landing', error: 'login_failed' };
    }
    const ip = this.requestIp(req);

    // 받아 둔 복구 의도는 먼저 시작해 둔 평범한 흐름의 콜백도 낮추지 못한다: 그 콜백은 probe로 다뤄진다.
    const intent = flow.reason ? flow
      : flow.phase === 'plain' ? flows.find(other => other.live && other.name !== own.name && other.pending!.reason)?.pending ?? null
        : null;
    if (flow.phase === 'probe' || (flow.phase === 'plain' && intent)) {
      const reason = (flow.reason ?? intent?.reason)!;
      try {
        await this.prisma.$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
          await this.lockIdpSession(tx, idpSid!);
          await this.endRows(tx, idpSid, [], REASON_CAUSE[reason], ip, reason);
        }, { maxWait: 4000, timeout: 8000 });
      } catch {
        this.storageWarning('end_transaction');
        return { kind: 'landing', error: 'login_failed' };
      }
      // 끝났다는 답 없이 fresh로 가면 앞사람의 이름이 고정된 재인증 화면에 선다. 확인될 때까지 랜딩의 같은 버튼이 다시 한다.
      if (!await this.confirmIdpEnd(idpSid, IDP_END_WAIT_MS)) return { kind: 'landing', error: 'end_unconfirmed' };
      return { kind: 'redirect', location: this.startFlow(req, res,
        { phase: 'fresh', reason, prompt: flow.prompt ?? intent?.prompt ?? null, restarts: flow.restarts }) };
    }

    const who = this.identity(payload, String(payload.sub));
    const roles = Array.isArray(payload.realm_access?.roles) ? payload.realm_access.roles : [];
    // A single institution and a clinician role meet member approval; gateway identities are not members.
    // Deliver the proof to its consumer, since a second document cannot reuse a consumed proof.
    const document = who.institution !== null && clinicianOnly(roles) && !roles.includes('gateway')
      && !(typeof payload.azp === 'string' && payload.azp.startsWith('gw-')) ? 'clinician.html' : 'main.html';
    const sid = randomBytes(32).toString('base64url');
    const proof = randomBytes(32).toString('base64url');
    const detail = JSON.stringify({ institution: who.institution, ip, dataSubject: null, outcome: 'success' });
    let outcome: 'created' | 'blocked' | 'expired' | 'isolated';
    try {
      /**
       * 표식 검사와 세션 생성은 그 provider 세션의 잠금 안에서 한 번에 한다: 교환과 잠금 사이에 완료된 Log out은 표식으로
       * 남아 여기서 막히고, 이 생성이 먼저면 뒤의 Log out이 이 행까지 지운다. 먼저 검증한 토큰을 무기한 믿지 않는다 —
       * 잠금을 얻은 뒤 토큰의 exp와 흐름의 기한을 다시 본다(확인된 표식의 보존 기한이 이 재검사에 기대어 선다).
       * 회원의 격리는 우리 쪽 사실(MemberIsolation)로 본다 — 인증 서버의 관리 API를 이 길에서 읽지 않는다(그 API가 멈춰도
       * 평소 로그인은 막히지 않고, 격리는 그 API의 답에 기대지 않는다). 사실의 쓰기와 같은 회원 잠금 안에서 읽는다.
       * 세션 생성과 성공 행은 함께 commit되거나 함께 롤백된다.
       */
      outcome = await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await this.lockIdpSession(tx, idpSid!);
        const now = new Date();
        if (Number(payload.exp) * 1000 <= now.getTime() || now.getTime() - flow.issuedAt > PENDING_VALID_MS) return 'expired';
        const mark = await tx.idpSessionEnd.findUnique({ where: { idpSid: idpSid! } });
        if (mark) {
          // 끝내기로 한 provider 세션이 code를 냈다: 아직 살아 있다. 확인돼 있었더라도 종료 요청을 다시 깨운다.
          await tx.idpSessionEnd.update({ where: { idpSid: idpSid! }, data: { confirmedAt: null, nextAttemptAt: now } });
          return 'blocked';
        }
        await this.lockMember(tx, String(payload.sub));
        if (await tx.memberIsolation.findUnique({ where: { sub: String(payload.sub) } })) return 'isolated';
        await tx.authSession.create({ data: {
          sid,
          sub: String(payload.sub),
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          atExpiresAt: new Date(Number(payload.exp) * 1000 - REFRESH_LEAD_MS),
          lastSeenAt: now,
          entryProofHash: this.proofHash(proof),
          entryProofExpiresAt: new Date(now.getTime() + ENTRY_PROOF_MS),
          idpSid,
        } });
        await tx.auditLog.create({ data: { actor: who.actor, action: AUTH_LOGIN, target: who.target, detail } });
        return 'created';
      }, { maxWait: 4000, timeout: 8000 });
    } catch {
      this.storageWarning('login_transaction');
      await this.loginFailureRow(req, 'session_failed', who);
      return { kind: 'landing', error: 'login_failed' };
    }

    if (outcome === 'isolated') {
      await this.loginFailureRow(req, 'member_isolated', who);
      return { kind: 'landing', error: 'login_failed' };
    }
    const again = { phase: flow.phase, reason: flow.reason, prompt: flow.prompt, restarts: flow.restarts + 1 };
    if (outcome === 'expired')
      return flow.restarts > 0 ? { kind: 'landing', error: 'stale' }
        : { kind: 'redirect', location: this.startFlow(req, res, again) };
    if (outcome === 'blocked') {
      await this.loginFailureRow(req, 'idp_session_ended', who);
      // provider 세션을 끝낸 뒤 로그인을 처음부터 다시 시작한다 — 이번에는 폼이 나온다. 끝났다는 답이 없거나 같은 흐름에서
      // 두 번째면 랜딩으로 보낸다(같은 버튼으로 다시 할 수 있다). 되돌이 고리를 만들지 않는다.
      const confirmed = await this.confirmIdpEnd(idpSid, IDP_END_WAIT_MS);
      if (!confirmed || flow.restarts > 0) return { kind: 'landing', error: 'end_unconfirmed' };
      return { kind: 'redirect', location: this.startFlow(req, res, again) };
    }
    // 자격을 입력한 이 로그인이 받아 둔 복구 의도를 채웠다: 그 의도를 실은 다른 흐름은 더 필요 없다.
    if (flow.reason)
      for (const other of flows)
        if (other.name !== own.name && other.pending?.reason) this.expirePending(res, other.name);
    return { kind: 'entered', sid, proof, document };
  }

  /**
   * 진입 증명의 사용(POST auth/entry). 쿠키의 세션에 걸린 증명과 같고 만료 전일 때 **한 번만** 통한다 — 증명을 비우는
   * 조건부 갱신과 접속기록 행이 한 commit이다. 다른 세션의 증명·만료된 증명·이미 쓴 증명은 같은 거절 하나로 답한다
   * (어느 쪽인지 말하지 않는다). 답은 그 세션의 식별값뿐이다: 문서는 이 값으로 결속된 요청을 시작한다.
   */
  async enter(req: any): Promise<{ sessionId: string }> {
    const sid = this.sessionId(req);
    if (!sid) throw this.credentialsMissing();
    this.requireCsrf(req);
    const proof = req?.body?.proof;
    if (typeof proof !== 'string' || !proof || proof.length > 128)
      throw authRefusal(400, 'AUTH_ENTRY_INVALID', '진입 증명 형식이 잘못되었습니다');
    const refused = () => authRefusal(403, 'AUTH_ENTRY_REFUSED', '로그인 진입 증명을 확인하지 못했습니다. 다시 로그인해 주십시오');
    const hash = this.proofHash(proof);
    const session = await this.readSession(sid);
    if (!session?.entryProofHash || !session.entryProofExpiresAt) throw refused();
    const stored = Buffer.from(session.entryProofHash), given = Buffer.from(hash);
    if (stored.length !== given.length || !timingSafeEqual(stored, given)) throw refused();
    const who = this.storedIdentity(session);
    const detail = JSON.stringify({ institution: who.institution, ip: this.requestIp(req), dataSubject: null });
    const consumed = await this.storage('entry_transaction', () => this.prisma.$transaction(async tx => {
      // 만료는 DB에 닿는 순간에 다시 본다. 0행이면 그사이 쓰였거나 만료된 것이고, 행을 쓰지 않는다.
      const { count } = await tx.authSession.updateMany({
        where: { sid, entryProofHash: hash, entryProofExpiresAt: { gt: new Date() } },
        data: { entryProofHash: null, entryProofExpiresAt: null },
      });
      if (count !== 1) return false;
      await tx.auditLog.create({ data: { actor: who.actor, action: AUTH_ENTRY, target: who.target, detail } });
      return true;
    }));
    if (!consumed) throw refused();
    return { sessionId: this.sessionRef(sid) };
  }

  async verifyAccessToken(raw: string): Promise<JWTPayload & Record<string, any>> {
    if (!this.jwks) throw new UnauthorizedException('서버에 KC_JWKS_URL이 설정되지 않았습니다');
    try {
      const { payload } = await jwtVerify(raw, this.jwks, {
        issuer: process.env.KC_ISSUER,
        audience: process.env.KC_AUDIENCE ?? 'kin-api',
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'sub', 'iss', 'aud'],
      });
      return payload;
    } catch (error: any) {
      // 공개키를 가져오지 못한 것은 토큰의 잘못이 아니다: 인증 실패(401)로 답하면 멀쩡한 세션이 거절된 것처럼 보인다.
      if (!TOKEN_VERDICTS.has(error?.code)) throw this.idpUnavailable();
      throw new UnauthorizedException('토큰 검증 실패: ' + error.message);
    }
  }

  /**
   * Keycloak refresh 교환. **거절은 Keycloak이 거절이라고 답했을 때뿐이다**(400 invalid_grant — refresh token의 만료·철회).
   * 예전에는 연결 실패·시간 초과·5xx·읽지 못한 답도 거절로 세어 세션을 지웠다: 인증 서버가 잠깐 느리거나 재시작하면
   * 일하던 사람이 모두 로그아웃됐다. 그런 답은 `unavailable`이고 세션을 건드리지 않는다.
   * 성공 토큰 저장이나 거절 뒤 종료의 DB 오류는 여기 답이 아니라 저장소 실패다 — 한 catch에 담지 않는다(S7-U5 §0.B 2).
   */
  private async exchangeRefresh(refreshToken: string): Promise<RefreshAnswer> {
    let status: number, answer: any;
    try {
      const response = await fetch(this.internalOidc('/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'kin-bff',
          client_secret: process.env.KC_WEB_SECRET!,
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(IDP_TOKEN_MS),
      });
      status = response.status;
      answer = await response.json();
    } catch {
      return { kind: 'unavailable' };
    }
    if (status === 400 && answer?.error === 'invalid_grant') return { kind: 'refused' };
    if (status !== 200 || typeof answer?.access_token !== 'string' || !answer.access_token) return { kind: 'unavailable' };
    try {
      return { kind: 'tokens', tokens: answer, payload: await this.verifyAccessToken(answer.access_token) };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  /** 응답은 그 요청을 시작한 관찰 S에만 적용한다: 성공은 S 조건부 저장이 count 1일 때만, 거절은 S 조건부 종료. */
  private async doRefresh(session: Session, ip: string | null): Promise<RefreshOutcome> {
    const answer = await this.exchangeRefresh(session.refreshToken);
    if (answer.kind === 'unavailable') return { kind: 'unavailable' };
    if (answer.kind === 'refused')
      return await this.endAndTell(session, 'refresh_failed', ip) ? { kind: 'ended' } : { kind: 'conflict' };
    // 갱신은 같은 사람의 같은 provider 세션을 잇는 것이다. 다른 sub·다른 provider 세션의 토큰은 이 세션의 것이 아니다 —
    // 저장하지 않고, 세션을 끝내지도 않는다(인증 서버의 답이 이상한 것이지 이 세션이 끝난 것이 아니다).
    const idpSid = this.idpSidOfClaims(answer.payload), known = this.idpSidOf(session);
    if (String(answer.payload.sub) !== session.sub || !idpSid || (known !== null && idpSid !== known))
      return { kind: 'unavailable' };
    // 격리된 회원의 세션은 갱신하지 않고 그 자리에서 끝낸다(원인 isolation) — 인증 서버의 갱신 답을 믿지 않는다. 격리는
    // 우리 쪽 사실로 본다(콜백과 같은 규칙): 인증 서버의 관리 API는 이 길에서 읽지 않는다.
    const isolated = await this.storage('isolation_read', () =>
      this.prisma.memberIsolation.findUnique({ where: { sub: session.sub }, select: { sub: true } }));
    if (isolated)
      return await this.endAndTell(session, 'isolation', ip) ? { kind: 'ended' } : { kind: 'conflict' };
    const data = {
      accessToken: answer.tokens.access_token as string,
      refreshToken: (answer.tokens.refresh_token ?? session.refreshToken) as string,
      atExpiresAt: new Date(Number(answer.payload.exp) * 1000 - REFRESH_LEAD_MS),
      idpSid,
    };
    const { count } = await this.storage('session_write', () =>
      this.prisma.authSession.updateMany({ where: this.version(session), data }));
    // 0행이면 늦은 성공 토큰을 버린다 — 끝난 세션을 되살리거나 새 버전을 덮지 않는다.
    return count === 1 ? { kind: 'stored', session: { ...session, ...data } } : { kind: 'conflict' };
  }

  /** 같은 프로세스의 겹친 요청은 같은 관찰(sid와 두 토큰)일 때만 refresh 하나를 나눈다. 응답 쿠키는 각 요청이 정한다. */
  private refresh(session: Session, ip: string | null): Promise<RefreshOutcome> {
    const key = createHash('sha256').update(JSON.stringify([session.sid, session.accessToken, session.refreshToken]))
      .digest('base64url');
    const running = this.refreshes.get(key);
    if (running) return running;
    const started: Promise<RefreshOutcome> = this.doRefresh(session, ip).finally(() => {
      if (this.refreshes.get(key) === started) this.refreshes.delete(key);
    });
    this.refreshes.set(key, started);
    return started;
  }

  /**
   * 토큰 갱신과 업무의 관계(S7-U5 개정 ④): 갱신은 만료 **전**(`atExpiresAt`)에 시작하고, 저장된 토큰이 실제로 유효한
   * 동안의 요청은 그 갱신을 기다리지 않고 그 토큰으로 진행한다 — 인증 서버가 느려도 일하는 화면은 멈추지 않는다.
   * 토큰이 실제로 만료된 뒤의 요청만 갱신을 기다린다. 그때도 Keycloak에 닿지 못한 것(`unavailable`)은 503일 뿐 세션을
   * 끝내지 않는다. 세션이 끝나는 것은 Keycloak이 거절을 답했을 때와 idle뿐이다.
   */
  async authenticateSession(sid: string, res: any): Promise<any> {
    const ip = this.requestIp(res?.req);
    let session = await this.readSession(sid);
    if (!session) throw this.ended('인증 세션이 없습니다');
    // idle → refresh → 진행을 관찰마다 판정한다. 조건부 전이가 0행이면 그 관찰(과 늦은 성공 토큰)을 버리고 다시 읽는다.
    let refreshAhead = false;
    for (let writes = 0; ;) {
      const now = Date.now();
      const cutoff = new Date(now - SESSION_IDLE_MS);
      let ended: string;
      if (session.lastSeenAt.getTime() < cutoff.getTime()) {
        writes++;
        if (await this.endAndTell(session, 'idle', ip, cutoff)) throw this.ended('인증 세션이 만료되었습니다');
        ended = '인증 세션이 만료되었습니다';
      } else if (session.atExpiresAt.getTime() <= now && now < session.atExpiresAt.getTime() + REFRESH_LEAD_MS - TOKEN_MARGIN_MS) {
        // 갱신할 때가 됐고 토큰은 아직 유효하다: 이 요청은 저장된 토큰으로 가고, 갱신은 아래에서 시작만 한다.
        refreshAhead = true;
        break;
      } else if (session.atExpiresAt.getTime() <= now) {
        writes++;
        const outcome = await this.refresh(session, ip);
        // 자기 저장이 채택되면 그대로 진행한다 — 저장된 atExpiresAt이 이미 지났다는 이유로 같은 요청에서 다시 refresh하지 않는다.
        if (outcome.kind === 'stored') { session = outcome.session; break; }
        if (outcome.kind === 'ended') throw this.ended('인증 세션을 갱신할 수 없습니다');
        if (outcome.kind === 'unavailable') throw this.idpUnavailable();
        ended = '인증 세션을 갱신할 수 없습니다';
      } else {
        break;
      }
      const again = await this.readSession(sid);
      if (!again) throw this.ended(ended);
      if (writes === TRANSITION_LIMIT) throw this.conflict();
      session = again;
    }
    if (session.lastSeenAt.getTime() < Date.now() - SESSION_TOUCH_MS) {
      // touch는 관찰한 버전에만, lastSeenAt을 뒤로 돌리지 않게. 0행이어도 이미 채택한 이 요청을 바꾸지 않는다.
      const now = new Date();
      const where = { ...this.version(session), lastSeenAt: { lt: now } };
      const { count } = await this.storage('session_write', () =>
        this.prisma.authSession.updateMany({ where, data: { lastSeenAt: now } }));
      if (count === 1) session = { ...session, lastSeenAt: now };
    }
    /**
     * 미리 하는 갱신은 touch **뒤에** 시작한다: 먼저 시작하면 그 저장이 이 요청의 touch(읽은 버전 조건)를 0행으로 만들어
     * 접속 시각이 갱신되지 않는다. 기다리지 않는다 — 그 갱신의 답(저장·거절로 인한 종료·닿지 못함)은 이미 채택한 이
     * 요청을 바꾸지 않고, 저장소 실패는 `storage`가 고정 분류로 남겼다.
     */
    if (refreshAhead) this.refresh(session, ip).catch(() => undefined);
    return session;
  }

  /**
   * 로그아웃(U5S-REQ-05). 순서가 계약이다: **세션 폐기·표식·접속기록을 먼저 commit하고, 그 뒤에만 Keycloak에 알린다.**
   * 예전 순서(Keycloak 먼저)에서는 Keycloak이 멈춘 동안 이 앱의 세션이 살아 있었고, 그 응답이 늦으면 종료 자체가
   * 시작되지 않았다. 이제 DB 실패·경쟁(409)은 "끝났다"는 답도 Keycloak 호출도 만들지 않고, 폐기 뒤의 Keycloak 실패·
   * 시간 초과·프로세스 재시작은 세션을 되살리거나 접속기록을 하나 더 만들지 못한다.
   * 이미 없는 세션은 접속기록 없이 끝난 것으로 답한다. 결속과 CSRF는 가드가 토큰 갱신 없이 먼저 확인했다.
   *
   * 답은 Keycloak을 기다리지 않는다(개정 ⑨): 폐기와 접속기록이 commit되면 이 앱의 로그아웃은 끝난 것이고, 사람이
   * "로그아웃 중"을 보고 있을 이유가 없다. provider 세션의 종료는 그 뒤에 청하고, 늦거나 실패하면 표식이 다시 청한다 —
   * 그동안에도 표식이 그 SSO로의 재진입을 막는다.
   */
  async logout(req: any): Promise<void> {
    const sid: string | null = req?.sid ?? null;
    if (!sid) return;
    const session = await this.readSession(sid);
    if (!session) return;
    const end = await this.endByRequest(sid, session, 'logout', this.requestIp(req));
    if (end.ended && end.idpSid) this.tellIdp(end.idpSid);
  }

  /**
   * 다시 오지 않는 세션의 수거. 관찰한 대상마다 이번 주기에 한 번만 조건부 종료하고 0행이면 건너뛴다.
   * 한 대상의 실패는 그 대상만 롤백하고 고정 분류만 남긴 채 다음 대상으로 간다(다음 주기가 다시 평가한다).
   * 확인된 지 오래된 표식도 여기서 치운다 — 미확인 표식은 치우지 않는다.
   */
  private async sweep() {
    const cutoff = new Date(Date.now() - SESSION_IDLE_MS);
    let targets: Session[];
    try {
      targets = await this.prisma.authSession.findMany({ where: { lastSeenAt: { lt: cutoff } } });
    } catch {
      this.storageWarning('sweep_read');
      return;
    }
    for (const session of targets) {
      try {
        await this.endAndTell(session, 'sweep', null, cutoff);
      } catch {
        this.storageWarning('sweep_target');
      }
    }
    try {
      await this.prisma.idpSessionEnd.deleteMany({
        where: { confirmedAt: { not: null }, decidedAt: { lt: new Date(Date.now() - IDP_END_KEEP_MS) } },
      });
    } catch {
      this.storageWarning('idp_end_write');
    }
  }
}

/** 잠금·트랜잭션 대기 한도를 넘긴 오류인가(55P03 lock_not_available, 트랜잭션 제한 시간). 원시 오류 문구는 밖으로 내지 않는다. */
function lockWaitExceeded(error: any): boolean {
  if (error?.code === 'P2028') return true;
  if (error?.meta?.code === '55P03') return true;
  return typeof error?.message === 'string' && error.message.includes('55P03');
}
