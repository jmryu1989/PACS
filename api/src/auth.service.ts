import { BackgroundWork, EMR_BACKGROUND_WORK, backgroundRetryDelayMs } from './emr-runtime/background-work';
import {
  HttpException, Inject, Injectable, InternalServerErrorException, Logger,
  OnModuleDestroy, OnModuleInit, UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import { createRemoteJWKSet, decodeJwt, jwtVerify, JWTPayload } from 'jose';
import { PrismaService } from './prisma.service';
import type { Prisma } from '@prisma/client';
import { ChangeAnswer, KeycloakService, RosterWriteFailure, within } from './keycloak.service';
import { rightsAllow, lockMemberRights } from './member-rights';
import { importMemberRights } from './member-rights-import';
import { clinicianOnly } from './clinician-policy';
import { EMR_RECORD_PORT, EmrRecordPort, EmrRecordTransaction } from './emr-runtime/record-port';
import { knownIdentity, verifiedIdentityClaims } from './emr-runtime/contract';
import type { RecordMutation } from './emr-runtime/store';
import { authRequestSurface, recordLoginFailure, sessionAccessEvent, sessionEndEvent, SessionRecordIdentity } from './emr-runtime/auth-events';
import type { AuthEndCause, AuthFailureCause, ImmutableIdentity, ReauthenticationTrigger } from './emr-contract/access-event';
import type { CurrentRequestAuthorization } from './emr-runtime/request-context';

const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 5 * 60 * 1000;
/**
 * 시작한 로그인(pending)이 통하는 시간. Keycloak 로그인 화면의 수명(accessCodeLifespanLogin)에 맞춘다: keycloak/kin-realm.json은
 * 그 값을 정하지 않으므로 Keycloak 기본값 1800초다. 이보다 짧으면(예전 600초) 폼을 연 지 10~30분 뒤에 로그인한 사람이
 * Keycloak은 통과하고 여기서 거절된다. pending 쿠키도 같은 수명을 따른다.
 */
const PENDING_VALID_MS = 30 * 60 * 1000;
const PENDING_PREFIX = 'kin_pending_';
// 한 요청이 하는 조건부 세션 전이(idle 삭제·refresh 저장·refresh 실패 삭제, 종료 요청의 삭제)의 상한. 경쟁자가 매번
// 먼저 바꾸면 끝없이 재시도하는 대신 409로 끝내고 다음 사용자 요청이 새 한도로 다시 한다(S7-U5 §0.A 7).
const TRANSITION_LIMIT = 3;
// 세션 commit 뒤 보내는 best-effort provider 종료의 기존 외부 호출 한도.
const IDP_END_MS = 2000;
// Keycloak 토큰 교환(로그인 code, refresh) 한 번이 쓸 수 있는 시간(U5S-REQ-18의 외부 조회 한도).
const IDP_TOKEN_MS = 5000;
/**
 * 갱신은 access token이 만료되기 이만큼 **전에** 시작한다: 저장하는 `atExpiresAt`은 토큰의 exp에서 이 값을 뺀 시각이다.
 * 그 시각부터 실제 만료까지는 저장된 토큰이 아직 유효하므로 요청은 갱신을 기다리지 않는다(아래 `authenticateSession`).
 */
const REFRESH_LEAD_MS = 30_000;
// 실제 만료 직전의 토큰을 "아직 유효"로 채택하면 곧이은 서명 검증에서 만료로 떨어진다. 그 틈을 만료 쪽으로 센다.
const TOKEN_MARGIN_MS = 2000;
const AUTH_LOGIN = 'auth.login';
type EndCause = 'logout' | 'account_switch' | 'reauthentication' | 'idle' | 'refresh_failed' | 'sweep' | 'isolation';
type PendingLogin = { state: string; verifier: string; issuedAt: number };
type Session = {
  sid: string; auditRef: string; sub: string; accessToken: string; refreshToken: string;
  atExpiresAt: Date; createdAt: Date; lastSeenAt: Date;
  idpSid: string | null; rightsVersion: number; institution: string | null;
};
type Who = { actor: string; target: string; institution: string | null };
export type LoginFailureCause =
  'provider_error' | 'state_mismatch' | 'no_code' | 'exchange_failed' | 'token_invalid' | 'session_failed'
  // 격리된 회원(우리 쪽 격리 사실이 있는 회원)의 로그인: 세션을 만들지 않는다.
  | 'member_isolated' | 'rights_pending' | 'storage_failure';
type StorageStep = 'session_read' | 'session_write' | 'end_transaction' | 'login_transaction' | 'login_failure_row'
  | 'sweep_read' | 'sweep_target' | 'sweep_cycle'
  | 'change_write';
/** 보내기 전에 기록한 변경 호출 하나(ProviderChange 행). */
type Change = { id: number; kind: 'credentials'; target: string };
type EndResult = { ended: boolean; idpSid: string | null };
/**
 * 콜백의 답. `entered`만 제품 세션을 만든다. `work`는 이미 살아 있는 세션의 업무 문서,
 * `landing`은 사유와 함께 랜딩이다 — 최상위 이동에 JSON 오류를 답하지 않는다.
 */
export type CallbackResult =
  | { kind: 'entered'; sid: string; document: 'main.html' | 'clinician.html' }
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
 * 세션 삭제와 접속기록은 한 commit이다. 그 뒤 provider 종료는 한 번만 청한다.
 * 다음 로그인은 항상 prompt=login으로 자격 입력을 요구한다.
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
  private stopSweep?: () => void;
  private cancelImportRetry?: () => void;
  private stopping = false;
  /**
   * 이 프로세스가 보내 놓고 아직 답을 기다리는 변경 호출의 수(대상별: `<kind>:<target>`, 회원은 `member:<sub>`). 재시도
   * 주기가 같은 대상에 요청을 쌓지 않게 할 뿐이다 — 판정은 DB의 기록이 한다(다른 프로세스의 호출은 여기에 없다).
   */
  private readonly flying = new Map<string, number>();

  constructor(private prisma: PrismaService, private keycloak: KeycloakService,
    @Inject(EMR_RECORD_PORT) private readonly ledger: EmrRecordPort,
    @Inject(EMR_BACKGROUND_WORK) private readonly background: BackgroundWork) {}

  private async withAccessRecords<T>(claims: { issuer: string; subject: string; actor: string },
    body: (tx: EmrRecordTransaction, record: RecordMutation, user: { status: 'known'; value: ImmutableIdentity }) => Promise<T>,
    options?: { maxWait: number; timeout: number }): Promise<T> {
    const work = this.ledger.begin();
    try {
      // Resolve before taking the business lane. Its immutable identity must
      // survive a later session rollback and cannot queue behind its own lane.
      const user = await knownIdentity(verifiedIdentityClaims(claims.issuer, claims.subject, claims.actor),
        (issuer, subject) => work.resolveRequestIdentity(issuer, subject));
      return await work.transactionWithRecords((tx, record) => body(tx, record, user), options);
    }
    finally { work.end(); }
  }

  async onModuleInit() {
    // Realm startup may follow API startup. Entry checks the committed marker while this single task retries.
    this.background.tryRun('auth.importRights', signal => this.importRights(1, signal));
    // 조회 시 idle 검사가 본체다. 타이머는 다시 오지 않는 세션 행을 치우는 수거원이고, 치운 세션도 접속기록에 남긴다.
    this.stopSweep = this.background.every('auth.sweep', 60 * 60 * 1000,
      () => this.sweep().catch(() => this.storageWarning('sweep_cycle')));
  }

  onModuleDestroy() {
    this.stopping = true;
    this.cancelImportRetry?.();
    this.stopSweep?.();
  }

  private async importRights(attempt: number, signal: AbortSignal): Promise<void> {
    if (this.stopping || signal.aborted) return;
    this.logger.log(`Member rights import attempt ${attempt}: checking realm-v1`);
    try {
      // The held DB import completes under the quiesce signal too: once it is aborted, no roster publication starts.
      const outcome = await importMemberRights(this.prisma, this.keycloak, this.ledger, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
      this.logger.log(`Member rights import attempt ${attempt}: ready`);
      if (outcome?.publication) await outcome.publication;
    } catch (error: any) {
      const delay = backgroundRetryDelayMs(attempt);
      this.logger.warn(`Member rights import attempt ${attempt}: ${error?.message ?? 'storage/provider failure'}; retry in ${delay}ms`);
      if (!this.stopping && !signal.aborted) {
        this.cancelImportRetry = this.background.schedule('auth.importRights', delay, next => this.importRights(attempt + 1, next));
      }
    }
  }

  async memberRightsState(): Promise<'pending' | 'ready'> {
    try { return await this.prisma.memberRightsImport.findUnique({ where: { id: 'realm-v1' } }) ? 'ready' : 'pending'; }
    catch { return 'pending'; }
  }

  /** Waiting sessions carry identity only. Before realm import, no member session can enter. */
  private async entryRights(sub: string, db: any = this.prisma) {
    const marker = await this.storage('session_read', () => db.memberRightsImport.findUnique({ where: { id: 'realm-v1' } }));
    if (!marker) throw authRefusal(401, 'AUTH_RIGHTS_PENDING', '회원 권한을 준비하고 있습니다');
    const row: any = await this.storage('session_read', () => db.memberRights.findUnique({ where: { sub } }));
    if (row?.suspended) throw this.ended('현재 회원 자격으로 접근할 수 없습니다');
    return row ?? { sub, version: 0, approved: false, suspended: false, institution: null, roles: [], newAuthAfter: null };
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
    return { ...this.identity(claims, session.sub), institution: session.institution };
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
   * 회원 하나에 대한 줄 세우기(같은 트랜잭션 advisory lock, 다른 이름공간). 격리 사실의 쓰기와 콜백의 "사실을 보고 → 세션을
   * 만든다"가 겹치지 않는다: 콜백이 먼저면 그 세션 행은 격리가 사실 뒤에 끝내는 행에 들고, 사실이 먼저면 콜백이 그것을 본다.
   */
  private async lockMember(tx: any, sub: string): Promise<void> {
    await lockMemberRights(tx, sub);
  }


  private async endSession(
    session: Session, cause: EndCause, ip: string | null, options: { idleCutoff?: Date; trigger?: ReauthenticationTrigger; surface?: string | null } = {},
  ): Promise<EndResult> {
    const idpSid = this.idpSidOf(session);
    const where = options.idleCutoff
      ? { ...this.version(session), lastSeenAt: { lt: options.idleCutoff } } : this.version(session);
    try {
      const service = cause === 'sweep' ? await this.sweepIdentity() : undefined;
      const end = async (tx: EmrRecordTransaction, record: RecordMutation, user: SessionRecordIdentity): Promise<EndResult> => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        const surface = options.surface ?? (cause === 'sweep' ? 'service:auth-session-sweep' : null);
        const ended = await this.endRow(tx, record, user, session, cause, ip, surface, options.trigger, service, where);
        if (!ended) return { ended: false, idpSid: null };
        await this.endRows(tx, record, user, idpSid, cause, ip, surface, options.trigger, service);
        return { ended: true, idpSid };
      };
      let issuer: string | undefined;
      try { issuer = decodeJwt(session.accessToken).iss; } catch { /* Keep the missing original identity explicit. */ }
      if (issuer) return await this.withAccessRecords({ issuer, subject: session.sub, actor: this.storedIdentity(session).actor }, end,
        { maxWait: 4000, timeout: 8000 });
      // An unreadable stored token must not prevent ending its existing session.
      // Keep its auditRef and the projection's stored subject; never guess an issuer.
      const work = this.ledger.begin();
      try { return await work.transactionWithRecords((tx, record) => end(tx, record, { status: 'unresolved', reason: 'not-resolved' }),
        { maxWait: 4000, timeout: 8000 }); }
      finally { work.end(); }
    } catch (error: any) {
      if (lockWaitExceeded(error)) throw this.conflict();
      this.storageWarning('end_transaction');
      throw this.storageFailure();
    }
  }

  /** 같은 provider 세션의 제품 행도 삭제와 접속기록을 한 transaction으로 끝낸다. */
  private async endRows(
    tx: EmrRecordTransaction, record: RecordMutation, user: SessionRecordIdentity,
    idpSid: string | null, cause: EndCause, ip: string | null, surface: string | null,
    trigger?: ReauthenticationTrigger, service?: { status: 'known'; value: ImmutableIdentity },
  ): Promise<void> {
    if (!idpSid) return;
    const others = await tx.authSession.findMany({ where: { idpSid } });
    for (const other of others)
      await this.endRow(tx, record, user, other, cause, ip, surface, trigger, service, { sid: other.sid });
  }

  private async sweepIdentity() {
    const work = this.ledger.begin();
    try {
      // This names the executing software task, not an invented Keycloak member.
      const issuer = 'urn:kin:pacs:service', subject = 'auth-session-sweep';
      return { status: 'known' as const, value: { issuer, subject,
        id: await work.resolveRequestIdentity(issuer, subject) } };
    } finally { work.end(); }
  }

  private async endRow(tx: EmrRecordTransaction, record: RecordMutation,
    user: SessionRecordIdentity, row: Session, cause: EndCause, ip: string | null,
    surface: string | null, trigger: ReauthenticationTrigger | undefined, service: { status: 'known'; value: ImmutableIdentity } | undefined,
    where: Prisma.AuthSessionWhereInput): Promise<boolean> {
    if (!surface || (user.status === 'known' && row.sub !== user.value.subject)) throw new Error('SessionEndObservationMissing');
    const rights = await tx.memberRights.findUnique({ where: { sub: row.sub } });
    const event = sessionEndEvent(user, { surface, roles: rights?.roles ?? [], rightsVersion: rights?.version ?? 0,
      institution: row.institution, auditRef: row.auditRef, ip, occurredAt: new Date().toISOString(),
      endCause: cause.replace(/_/g, '-') as AuthEndCause,
      trigger: cause === 'reauthentication' ? trigger! : null, service });
    const reference = await record(event, async () => {
      const { count } = await tx.authSession.deleteMany({ where });
      if (count !== 1) return null;
      const who = this.storedIdentity(row);
      const audit = await tx.auditLog.create({ data: {
        at: new Date(event.occurredAt), actor: who.actor, action: event.action, target: who.target,
        detail: JSON.stringify(cause === 'reauthentication'
          ? { institution: who.institution, ip, dataSubject: null, cause, trigger: trigger?.replace(/-/g, '_') ?? null }
          : { institution: who.institution, ip, dataSubject: null, cause }),
      } });
      return { kind: 'AuditLog', id: String(audit.id), version: null };
    });
    return reference !== null;
  }


  /** 끝내고, 끝냈으면 provider 종료를 청해 둔다(기다리지 않는다). idle·refresh 거절·수거·평소의 Log out이 쓴다. */
  private async endAndTell(session: Session, cause: EndCause, ip: string | null, idleCutoff?: Date, surface?: string | null): Promise<boolean> {
    const result = await this.endSession(session, cause, ip, { idleCutoff, surface });
    if (result.ended && result.idpSid) this.tellIdp(result.idpSid);
    return result.ended;
  }

  /** Current rights and the session's admitted version must both survive. No JWT fallback. */
  async sessionRights(session: Session, db: any = this.prisma) {
    const rights = await this.entryRights(session.sub, db);
    if (rights.version !== session.rightsVersion) throw this.ended('회원 자격이 바뀌었습니다. 다시 로그인해 주십시오');
    return rights;
  }

  async bearerRights(claims: Record<string, any>, raw: string, db: any = this.prisma) {
    const rights = await this.entryRights(String(claims.sub), db);
    if (rights.newAuthAfter && !this.authenticationAfter(claims.auth_time, rights.newAuthAfter))
      throw this.ended('회원 자격이 바뀌었습니다. 다시 로그인해 주십시오');
    return rights;
  }

  /** Credentials stay in this closure. Consumers can revalidate in their existing
   * business transaction without another transaction, a refresh or provider I/O.
   */
  bindCurrentAuthorization(payload: Record<string, any>, raw: string, session: Session | null,
      rights: { version: number; institution: string; roles: readonly string[] }): CurrentRequestAuthorization {
    const claims = Object.freeze({ iss: payload.iss, sub: payload.sub, exp: payload.exp,
      sid: payload.sid, session_state: payload.session_state, auth_time: payload.auth_time, iat: payload.iat });
    const admitted = session ? { sid: session.sid, createdAt: session.createdAt.getTime(),
      idpSid: session.idpSid, rightsVersion: session.rightsVersion, institution: session.institution } : null;
    const expected = { version: rights.version, institution: rights.institution, roles: [...rights.roles].sort() };
    return async (transaction?: EmrRecordTransaction) => {
      const db = transaction ?? this.prisma;
      if (claims.iss !== process.env.KC_ISSUER || typeof claims.sub !== 'string')
        throw this.ended('인증 신원이 변경되었습니다');
      let current: any;
      if (admitted) {
        const live: Session | null = await this.storage('session_read', () =>
          db.authSession.findUnique({ where: { sid: admitted.sid } }));
        if (!live || live.sub !== claims.sub || live.createdAt.getTime() !== admitted.createdAt
            || live.idpSid !== admitted.idpSid || live.institution !== admitted.institution
            || live.rightsVersion !== admitted.rightsVersion || live.lastSeenAt.getTime() < Date.now() - SESSION_IDLE_MS)
          throw this.ended('요청을 시작한 인증 세션이 종료되었습니다');
        // Token expiry is not a session end (S7-U5 ④): an admitted request keeps going on its stored token while a
        // refresh is slow or fails; the session ends only when its row is gone or replaced, idle, or rights change.
        const stored = decodeJwt(live.accessToken);
        if (stored.iss !== claims.iss || stored.sub !== claims.sub)
          throw this.ended('요청을 시작한 인증 세션을 확인할 수 없습니다');
        current = await this.sessionRights(live, db);
      } else {
        current = await this.bearerRights(claims, raw, db);
      }
      if (!rightsAllow(current) || current.version !== expected.version || current.institution !== expected.institution
          || JSON.stringify([...current.roles].sort()) !== JSON.stringify(expected.roles))
        throw this.ended('회원 자격이 바뀌었습니다. 다시 로그인해 주십시오');
    };
  }

  private authenticationAfter(authTime: unknown, boundary: Date): boolean {
    return typeof authTime === 'number' && Number.isSafeInteger(authTime)
      && authTime > Math.floor(boundary.getTime() / 1000);
  }

  /** A roster write is already recorded by the committing command. Its answer cannot change PACS rights. */
  publishCredentials(change: Change, institution: string, roles: string[]) {
    void this.sendChange(change, 'credentials:' + change.target, async () => {
      try {
        await this.keycloak.setGroups(change.target, [institution]);
        await this.keycloak.setRoles(change.target, roles);
        return { state: 'done', outcome: 'completed' };
      } catch (error) {
        return error instanceof RosterWriteFailure ? error.answer : { state: 'unknown', outcome: 'credentials_unconfirmed' };
      }
    }, 0).catch(() => this.storageWarning('change_write'));
  }

  /**
   * 기록한 변경 호출을 보내고 그 답을 최대 `waitMs` 기다린다. 기다림이 끝나도 요청은 끊지 않고, 그 자신의 답이 기록을 정한다
   * (settleChange) — 기다린 쪽이 시간 초과로 무엇을 지우거나 덮는 일은 없다. 답이 기다림 안에 오면 그 상태, 아니면 'pending'.
   */
  private async sendChange(change: Change, key: string, send: () => Promise<ChangeAnswer>, waitMs: number)
    : Promise<'done' | 'void' | 'unknown' | 'pending'> {
    // The send and its settlement are one owned background task. After the quiesce no provider request
    // starts: the recorded intent (state unknown) stays for the next process's resumption - 'pending' here, as for an
    // answer that did not arrive within the wait.
    let state: 'done' | 'void' | 'unknown' = 'unknown';
    const task = this.background.tryRun('auth.change:' + change.kind, async () => {
      this.flying.set(key, (this.flying.get(key) ?? 0) + 1);
      let answer: ChangeAnswer;
      try { answer = await send(); }
      catch { answer = { state: 'unknown', outcome: 'transport' }; }
      try { await this.settleChange(change, answer); }
      finally {
        const open = (this.flying.get(key) ?? 1) - 1;
        if (open > 0) this.flying.set(key, open);
        else this.flying.delete(key);
      }
      state = answer.state;
    });
    if (!task) return 'pending';
    const settled = task.settled.then(() => state);
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<'pending'>(resolve => { timer = setTimeout(() => resolve('pending'), Math.max(0, waitMs)); });
    try { return await Promise.race([settled, waited]); }
    finally { clearTimeout(timer); }
  }


  private async settleChange(change: Change, answer: ChangeAnswer): Promise<void> {
    const data = answer.state === 'unknown' ? { outcome: answer.outcome }
      : { state: answer.state, outcome: answer.outcome, settledAt: new Date() };
    for (let tries = 0; ; tries++) {
      try {
        await this.prisma.providerChange.updateMany({ where: { id: change.id,
          ...(change.kind === 'credentials' ? { OR: [{ state: 'unknown' }, { outcome: 'superseded' }] } : { state: 'unknown' }),
        }, data });
        break;
      } catch {
        if (tries === 2) { this.storageWarning('change_write'); return; }
      }
    }
  }

  private async endByRequest(
    sid: string, session: Session | null, cause: EndCause, ip: string | null, trigger?: ReauthenticationTrigger, surface?: string | null,
  ): Promise<EndResult> {
    for (let writes = 0; session; ) {
      if (writes === TRANSITION_LIMIT) throw this.conflict();
      writes++;
      const result = await this.endSession(session, cause, ip, { trigger, surface });
      if (result.ended) return result;
      session = await this.readSession(sid);
    }
    return { ended: false, idpSid: null };
  }

  /**
   * 세션 삭제가 commit된 뒤 provider 종료를 한 번 청한다(best-effort, 재시도 없음). 기다림은 IDP_END_MS까지이고 provider
   * 장애는 앱의 종료를 되돌리지 않는다.
   */
  private async endIdpOnce(idpSid: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.keycloak.endSession(idpSid, within(IDP_END_MS)),
        new Promise(resolve => { timer = setTimeout(resolve, IDP_END_MS); })]);
    } catch { this.logger.warn('auth_provider_end unavailable'); }
    finally { clearTimeout(timer); }
  }

  /** Log out·만료·수거: 답은 provider를 기다리지 않는다(U5S-REQ-05). */
  private tellIdp(idpSid: string) {
    this.background.tryRun('auth.tellIdp', () => this.endIdpOnce(idpSid));
  }

  // ── 로그인 시작 ──

  /**
   * 흐름 하나에 서명한 pending 쿠키 하나. 로그인은 언제나 prompt=login으로 자격 입력을 요구하고(살아 있는 SSO로 폼 없이
   * 돌아오지 않는다), 가입은 prompt=create의 가입 폼이다.
   */
  private startFlow(res: any, register = false): string {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const pending: PendingLogin = { state, verifier, issuedAt: Date.now() };
    this.appendCookie(res, `${this.pendingName(state)}=${encodeURIComponent(this.signPending(pending))}; Path=/api/auth; `
      + `HttpOnly; Secure; SameSite=Lax; Max-Age=${PENDING_VALID_MS / 1000}`);
    const query = new URLSearchParams({ client_id: 'kin-bff', response_type: 'code', scope: 'openid profile email',
      redirect_uri: this.redirectUri(), state, nonce: state, code_challenge: challenge, code_challenge_method: 'S256', prompt: register ? 'create' : 'login' });
    return `${this.externalOidc('/auth')}?${query}`;
  }

  /** 결속 없는 링크는 다른 문서가 쓰는 세션을 끝내지 않는다. */
  async beginLogin(req: any, res: any, prompt?: 'create'): Promise<string | null> {
    if (await this.hasSession(req)) return null;
    return this.startFlow(res, prompt === 'create');
  }

  /** 종료 원인은 접속기록에만 쓰며 다음 로그인 흐름으로 전파하지 않는다. */
  async beginReauthentication(req: any, res: any, body: any): Promise<string> {
    if (body?.intent !== 'reauthenticate')
      throw authRefusal(400, 'AUTH_LOGIN_INTENT_INVALID', '로그인 시작 요청의 의도가 올바르지 않습니다');
    switch (body.reason) {
      case 'switch_account': return this.beginSensitive(req, res, 'account_switch');
      case 'logout_unfinished': return this.beginSensitive(req, res, 'logout');
      case 'storage_untrusted': return this.beginSensitive(req, res, 'reauthentication', 'storage-untrusted');
      case 'record_unreadable': return this.beginSensitive(req, res, 'reauthentication', 'record-unreadable');
      default: throw authRefusal(400, 'AUTH_LOGIN_INTENT_INVALID', '로그인 시작 사유가 올바르지 않습니다');
    }
  }

  async beginBoundRegister(req: any, res: any): Promise<string> {
    return this.beginSensitive(req, res, 'reauthentication', 'register');
  }

  private async beginSensitive(req: any, res: any, cause: EndCause, trigger?: ReauthenticationTrigger): Promise<string> {
    const sid = this.sessionId(req);
    if (sid) {
      const binding = this.binding(req, sid);
      if (binding === 'mismatch') throw this.bindingMismatch();
      const session = await this.readSession(sid);
      if (session) {
        if (binding === 'missing') throw this.bindingMissing();
        const end = await this.endByRequest(sid, session, cause, this.requestIp(req), trigger, authRequestSurface(req));
        // 주소를 주기 전에 그 provider 종료를 한 번 기다린다: 끝나지 않은 SSO 위의 prompt=login은 다음 사람의 폼을 앞 의사의
        // 이름에 고정한다(D720). 확인되지 않아도 주소는 준다 — 그 폼도 자격 입력 없이는 세션을 만들지 않는다.
        if (end.ended && end.idpSid) await this.endIdpOnce(end.idpSid);
      }
    }
    return this.startFlow(res, trigger === 'register');
  }

  async hasSession(req: any): Promise<boolean> {
    const sid = this.sessionId(req);
    if (!sid) return false;
    const session = await this.storage('session_read', () => this.prisma.authSession.findUnique({
      where: { sid }, select: { lastSeenAt: true, sub: true, rightsVersion: true },
    }));
    if (!session || session.lastSeenAt.getTime() < Date.now() - SESSION_IDLE_MS) return false;
    if (await this.memberRightsState() !== 'ready') return false;
    const rights = await this.storage('session_read', () => this.prisma.memberRights.findUnique({ where: { sub: session.sub } }));
    return !rights?.suspended && (rights?.version ?? 0) === session.rightsVersion;
  }

  /**
   * 로그인 실패 행(OP-2 A). 이 서버가 시작한 로그인(서명·기한이 맞는 pending)에만 쓴다 — 익명 콜백이 행을 만들지 못하게.
   * 콜백의 error 원문·code·state는 남기지 않는다. 기록 실패는 고정 분류만 남기고 콜백 응답을 바꾸지 않는다.
   */
  private async loginFailureRow(req: any, cause: LoginFailureCause, who: Who | null) {
    try {
      await recordLoginFailure(this.ledger, {
        cause: cause.replace(/_/g, '-') as AuthFailureCause, legacyCause: cause,
        occurredAt: new Date().toISOString(), ip: this.requestIp(req),
        // Every non-null caller here follows verifyAccessToken; attempted or invalid
        // token claims never become a member identity in either record.
        verified: who ? { issuer: process.env.KC_ISSUER!, subject: who.target,
          actor: who.actor, institution: who.institution } : null,
      });
    } catch {
      this.storageWarning('login_failure_row');
    }
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

  /** 자기 pending만 소비하고 세션과 성공 기록을 같은 transaction으로 만든다. */
  async finishCallback(req: any, res: any, query: { code?: string; state?: string; error?: string }): Promise<CallbackResult> {
    const { code, state, error } = query;
    if ((!code || !state) && await this.hasSession(req)) return { kind: 'work' };
    const flows = this.pendingFlows(req);
    const own = state ? flows.find(item => item.name === this.pendingName(state) && item.pending?.state === state) : undefined;
    if (own) this.expirePending(res, own.name);
    if (!own?.live || !own.pending) {
      if (flows.some(item => item.live))
        await this.loginFailureRow(req, error ? 'provider_error' : !code ? 'no_code' : 'state_mismatch', null);
      return await this.hasSession(req) ? { kind: 'work' } : { kind: 'landing', error: 'stale' };
    }
    const flow = own.pending;
    if (error) {
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
    let observed: any;
    try { observed = await this.entryRights(String(payload.sub)); }
    catch (error: any) {
      const cause = error?.getResponse?.()?.code === 'AUTH_RIGHTS_PENDING' ? 'rights_pending'
        : error?.getStatus?.() === 401 ? 'member_isolated' : 'storage_failure';
      await this.loginFailureRow(req, cause, this.identity(payload, String(payload.sub)));
      return { kind: 'landing', error: 'login_failed' };
    }
    if (observed.newAuthAfter) {
      try {
        const { payload: identity } = await jwtVerify(tokens.id_token, this.jwks!, {
          issuer: process.env.KC_ISSUER, audience: 'kin-bff', algorithms: ['RS256'],
        });
        if (identity.sub !== payload.sub || identity.nonce !== flow.state ||
            typeof identity.auth_time !== 'number' || !Number.isSafeInteger(identity.auth_time))
          throw new Error('Invalid authentication identity');
        if (!this.authenticationAfter(identity.auth_time, observed.newAuthAfter))
          throw new Error('Fresh authentication required');
      } catch {
        await this.loginFailureRow(req, 'token_invalid', this.identity(payload, String(payload.sub)));
        return { kind: 'landing', error: 'login_failed' };
      }
    }

    const who = { ...this.identity(payload, String(payload.sub)), institution: observed.institution };
    const roles = rightsAllow(observed) ? observed.roles : [];
    // A single institution and a clinician role meet member approval; gateway identities are not members.
    const document = who.institution !== null && clinicianOnly(roles) && !roles.includes('gateway')
      && !(typeof payload.azp === 'string' && payload.azp.startsWith('gw-')) ? 'clinician.html' : 'main.html';
    const sid = randomBytes(32).toString('base64url');
    const auditRef = 'authref:' + randomUUID();
    const detail = JSON.stringify({ institution: who.institution, ip, dataSubject: null, outcome: 'success' });
    let outcome: 'created' | 'expired' | 'isolated';
    try {
      // MemberRights and session creation share the member lock; the session and auth.login row commit together.
      outcome = await this.withAccessRecords({ issuer: String(payload.iss), subject: String(payload.sub), actor: who.actor }, async (tx, record, user) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        const now = new Date();
        if (Number(payload.exp) * 1000 <= now.getTime() || now.getTime() - flow.issuedAt > PENDING_VALID_MS) return 'expired';
        await this.lockMember(tx, String(payload.sub));
        const rights = await this.entryRights(String(payload.sub), tx);
        if (rights.version !== observed.version) return 'isolated';
        const event = sessionAccessEvent(user, {
          action: AUTH_LOGIN,
          roles: rightsAllow(rights) ? rights.roles : [], rightsVersion: rights.version,
          institution: rights.institution, auditRef, ip, occurredAt: now.toISOString(),
        });
        await record(event, async () => {
          await tx.authSession.create({ data: {
            sid, auditRef,
            sub: String(payload.sub),
            rightsVersion: observed.version, institution: observed.institution,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            atExpiresAt: new Date(Number(payload.exp) * 1000 - REFRESH_LEAD_MS),
            lastSeenAt: now,
            idpSid,
          } });
          const projection = await tx.auditLog.create({ data: { at: now, actor: who.actor, action: AUTH_LOGIN, target: who.target, detail } });
          return { kind: 'AuditLog', id: String(projection.id), version: null };
        });
        return 'created';
      }, { maxWait: 4000, timeout: 8000 });
    } catch (error: any) {
      this.storageWarning('login_transaction');
      await this.loginFailureRow(req, error?.getStatus?.() === 401 ? 'member_isolated'
        : error?.getResponse?.()?.code === 'AUTH_STORAGE_FAILURE' ? 'storage_failure' : 'session_failed', who);
      return { kind: 'landing', error: 'login_failed' };
    }

    if (outcome === 'isolated') {
      await this.loginFailureRow(req, 'member_isolated', who);
      return { kind: 'landing', error: 'login_failed' };
    }
    if (outcome === 'expired') {
      await this.loginFailureRow(req, 'token_invalid', who);
      return { kind: 'landing', error: 'stale' };
    }
    return { kind: 'entered', sid, document };
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
  private async doRefresh(session: Session, ip: string | null, surface: string | null): Promise<RefreshOutcome> {
    await this.sessionRights(session);
    const answer = await this.exchangeRefresh(session.refreshToken);
    if (answer.kind === 'unavailable') return { kind: 'unavailable' };
    if (answer.kind === 'refused')
      return await this.endAndTell(session, 'refresh_failed', ip, undefined, surface) ? { kind: 'ended' } : { kind: 'conflict' };
    // 갱신은 같은 사람의 같은 provider 세션을 잇는 것이다. 다른 sub·다른 provider 세션의 토큰은 이 세션의 것이 아니다 —
    // 저장하지 않고, 세션을 끝내지도 않는다(인증 서버의 답이 이상한 것이지 이 세션이 끝난 것이 아니다).
    const idpSid = this.idpSidOfClaims(answer.payload), known = this.idpSidOf(session);
    if (String(answer.payload.sub) !== session.sub || !idpSid || (known !== null && idpSid !== known))
      return { kind: 'unavailable' };
    const data = {
      accessToken: answer.tokens.access_token as string,
      refreshToken: (answer.tokens.refresh_token ?? session.refreshToken) as string,
      atExpiresAt: new Date(Number(answer.payload.exp) * 1000 - REFRESH_LEAD_MS),
      idpSid,
    };
    const { count } = await this.storage('session_write', () => this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await this.lockMember(tx, session.sub);
      await this.sessionRights(session, tx);
      return tx.authSession.updateMany({ where: this.version(session), data });
    }));
    // 0행이면 늦은 성공 토큰을 버린다 — 끝난 세션을 되살리거나 새 버전을 덮지 않는다.
    return count === 1 ? { kind: 'stored', session: { ...session, ...data } } : { kind: 'conflict' };
  }

  /** 같은 프로세스의 겹친 요청은 같은 관찰(sid와 두 토큰)일 때만 refresh 하나를 나눈다. 응답 쿠키는 각 요청이 정한다. */
  private refresh(session: Session, ip: string | null, surface: string | null): Promise<RefreshOutcome> {
    const key = createHash('sha256').update(JSON.stringify([session.sid, session.accessToken, session.refreshToken]))
      .digest('base64url');
    const running = this.refreshes.get(key);
    if (running) return running;
    const started: Promise<RefreshOutcome> = this.doRefresh(session, ip, surface).finally(() => {
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
    const ip = this.requestIp(res?.req), surface = authRequestSurface(res?.req);
    let session = await this.readSession(sid);
    if (!session) throw this.ended('인증 세션이 없습니다');
    // idle → refresh → 진행을 관찰마다 판정한다. 조건부 전이가 0행이면 그 관찰(과 늦은 성공 토큰)을 버리고 다시 읽는다.
    let refreshAhead = false;
    for (let writes = 0; ;) {
      await this.sessionRights(session);
      const now = Date.now();
      const cutoff = new Date(now - SESSION_IDLE_MS);
      let ended: string;
      if (session.lastSeenAt.getTime() < cutoff.getTime()) {
        writes++;
        if (await this.endAndTell(session, 'idle', ip, cutoff, surface)) throw this.ended('인증 세션이 만료되었습니다');
        ended = '인증 세션이 만료되었습니다';
      } else if (session.atExpiresAt.getTime() <= now && now < session.atExpiresAt.getTime() + REFRESH_LEAD_MS - TOKEN_MARGIN_MS) {
        // 갱신할 때가 됐고 토큰은 아직 유효하다: 이 요청은 저장된 토큰으로 가고, 갱신은 아래에서 시작만 한다.
        refreshAhead = true;
        break;
      } else if (session.atExpiresAt.getTime() <= now) {
        writes++;
        const outcome = await this.refresh(session, ip, surface);
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
    if (refreshAhead) this.background.tryRun('auth.refreshAhead', () => this.refresh(session, ip, surface).catch(() => undefined));
    return session;
  }

  /**
   * 로그아웃(U5S-REQ-05). 순서가 계약이다: **세션 폐기·접속기록을 먼저 commit하고, 그 뒤에만 Keycloak에 알린다.**
   * 예전 순서(Keycloak 먼저)에서는 Keycloak이 멈춘 동안 이 앱의 세션이 살아 있었고, 그 응답이 늦으면 종료 자체가
   * 시작되지 않았다. 이제 DB 실패·경쟁(409)은 "끝났다"는 답도 Keycloak 호출도 만들지 않고, 폐기 뒤의 Keycloak 실패·
   * 시간 초과·프로세스 재시작은 세션을 되살리거나 접속기록을 하나 더 만들지 못한다.
   * 이미 없는 세션은 접속기록 없이 끝난 것으로 답한다. 결속은 가드가 토큰 갱신 없이 먼저 확인했다.
   *
   * 답은 Keycloak을 기다리지 않는다(개정 ⑨): 폐기와 접속기록이 commit되면 이 앱의 로그아웃은 끝난 것이고, 사람이
   * "로그아웃 중"을 보고 있을 이유가 없다. provider 세션의 종료는 그 뒤에 한 번 청한다.
   */
  async logout(req: any): Promise<void> {
    const sid: string | null = req?.sid ?? null;
    if (!sid) return;
    const session = await this.readSession(sid);
    if (!session) return;
    const end = await this.endByRequest(sid, session, 'logout', this.requestIp(req), undefined, 'POST auth/logout');
    if (end.ended && end.idpSid) this.tellIdp(end.idpSid);
  }

  /**
   * 다시 오지 않는 세션의 수거. 관찰한 대상마다 이번 주기에 한 번만 조건부 종료하고 0행이면 건너뛴다.
   * 한 대상의 실패는 그 대상만 롤백하고 고정 분류만 남긴 채 다음 대상으로 간다(다음 주기가 다시 평가한다).
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

  }
}

/** 잠금·트랜잭션 대기 한도를 넘긴 오류인가(55P03 lock_not_available, 트랜잭션 제한 시간). 원시 오류 문구는 밖으로 내지 않는다. */
export function lockWaitExceeded(error: any): boolean {
  if (error?.code === 'P2028') return true;
  if (error?.meta?.code === '55P03') return true;
  return typeof error?.message === 'string' && error.message.includes('55P03');
}
