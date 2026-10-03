import {
  BadRequestException, ConflictException, Injectable, InternalServerErrorException, Logger,
  OnModuleDestroy, OnModuleInit, UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import { createRemoteJWKSet, decodeJwt, jwtVerify, JWTPayload } from 'jose';
import { PrismaService } from './prisma.service';

const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 5 * 60 * 1000;
const PENDING_MAX_AGE_SECONDS = 10 * 60;
// 한 요청이 하는 조건부 세션 전이(idle 삭제·refresh 저장·refresh 실패 삭제, 종료 요청의 삭제)의 상한. 경쟁자가 매번
// 먼저 바꾸면 끝없이 재시도하는 대신 409로 끝내고 다음 사용자 요청이 새 한도로 다시 한다(S7-U5 §0.A 7).
const TRANSITION_LIMIT = 3;

// S7-U5 접속기록(FACT-S7-RETENTION): 로그인 성공·실패, 로그아웃·계정 전환, 세션 만료.
const AUTH_LOGIN = 'auth.login';
const AUTH_LOGOUT = 'auth.logout';
const AUTH_EXPIRED = 'auth.session.expired';

type PendingLogin = { state: string; verifier: string; issuedAt: number };
type Session = {
  sid: string; sub: string; accessToken: string; refreshToken: string;
  atExpiresAt: Date; createdAt: Date; lastSeenAt: Date;
};
type Who = { actor: string; target: string; institution: string | null };
type EndCause = 'logout' | 'account_switch' | 'idle' | 'refresh_failed' | 'sweep';
export type LoginFailureCause =
  'provider_error' | 'state_mismatch' | 'no_code' | 'exchange_failed' | 'token_invalid' | 'session_failed';
type StorageStep = 'session_read' | 'session_write' | 'end_transaction' | 'login_transaction' | 'login_failure_row'
  | 'sweep_read' | 'sweep_target' | 'sweep_cycle';
type RefreshOutcome = { kind: 'stored'; session: Session } | { kind: 'ended' } | { kind: 'conflict' };

/**
 * 토큰을 브라우저가 아니라 이 서비스 한 곳에서 다룬다. 콜백과 refresh가 같은 검증 함수를
 * 써야, 최초 로그인만 엄격하고 갱신 토큰은 느슨한 두 번째 인증 경로가 생기지 않는다.
 *
 * 세션 행의 버전은 읽은 accessToken·refreshToken 두 값이다. 모든 쓰기는 sid와 그 두 값을 조건으로 해서, 다른
 * 요청이나 다른 인스턴스가 그 사이에 저장한 새 버전을 옛 관찰로 지우거나 덮지 않는다(atExpiresAt·exp는 같은 값의
 * 다른 토큰을 가리지 못한다). 끝나는 세션은 조건부 삭제와 감사 행이 한 commit이고 삭제한 호출만 행을 쓴다.
 * 0행이면 그 관찰을 버리고 다시 읽는다. 외부 Keycloak 응답을 기다리는 동안에는 트랜잭션도 잠금도 잡지 않는다.
 */
@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly refreshes = new Map<string, Promise<RefreshOutcome>>();
  private readonly jwks = process.env.KC_JWKS_URL
    ? createRemoteJWKSet(new URL(process.env.KC_JWKS_URL))
    : null;
  private readonly logger = new Logger('AuthSession');
  private cleanupTimer?: NodeJS.Timeout;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    // 조회 시 idle 검사가 본체다. 타이머는 다시 오지 않는 세션 행을 치우는 수거원이고, 치운 세션도 접속기록에 남긴다.
    this.cleanupTimer = setInterval(() => {
      this.sweep().catch(() => this.storageWarning('sweep_cycle'));
    }, 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
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

  expireSessionCookie(res: any) {
    this.appendCookie(res, 'kin_sid=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  }

  private setPendingCookie(res: any, value: string) {
    this.appendCookie(
      res,
      `kin_pending=${encodeURIComponent(value)}; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=${PENDING_MAX_AGE_SECONDS}`,
    );
  }

  expirePendingCookie(res: any) {
    this.appendCookie(res, 'kin_pending=; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  }

  private pendingSecret(): string {
    return process.env.KIN_COOKIE_SECRET!;
  }

  private signPending(pending: PendingLogin): string {
    const body = Buffer.from(JSON.stringify(pending)).toString('base64url');
    const signature = createHmac('sha256', this.pendingSecret()).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  private readPending(req: any): PendingLogin | null {
    const value = this.cookie(req, 'kin_pending');
    const parts = value?.split('.') ?? [];
    if (parts.length !== 2) return null;
    const expected = createHmac('sha256', this.pendingSecret()).update(parts[0]).digest();
    let actual: Buffer;
    try { actual = Buffer.from(parts[1], 'base64url'); }
    catch { return null; }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as PendingLogin;
      if (!parsed.state || !parsed.verifier || !Number.isFinite(parsed.issuedAt)) return null;
      if (Date.now() - parsed.issuedAt > PENDING_MAX_AGE_SECONDS * 1000) return null;
      return parsed;
    } catch { return null; }
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
    return new ConflictException('다른 요청이 같은 로그인 세션을 바꾸고 있어 처리를 마치지 못했습니다. 다시 시도해 주십시오');
  }

  private readSession(sid: string): Promise<Session | null> {
    return this.storage('session_read', () => this.prisma.authSession.findUnique({ where: { sid } }));
  }

  /** 관찰한 버전의 조건: sid와 읽은 두 토큰 값. */
  private version(session: Session) {
    return { sid: session.sid, accessToken: session.accessToken, refreshToken: session.refreshToken };
  }

  /**
   * 관찰 S의 세션을 끝낸다: S 조건부 삭제(idle·sweep은 lastSeenAt < cutoff를 다시)와 접속기록 행 한 commit.
   * 실제로 지운 호출(count 1)만 행을 쓴다. false는 지우지 못했다는 뜻일 뿐 세션 부재의 증거가 아니다.
   */
  private async endSession(session: Session, cause: EndCause, ip: string | null, idleCutoff?: Date): Promise<boolean> {
    const who = this.storedIdentity(session);
    const where = idleCutoff ? { ...this.version(session), lastSeenAt: { lt: idleCutoff } } : this.version(session);
    const detail = JSON.stringify({ institution: who.institution, ip, dataSubject: null, cause });
    return this.storage('end_transaction', () => this.prisma.$transaction(async tx => {
      const { count } = await tx.authSession.deleteMany({ where });
      if (count !== 1) return false;
      await tx.auditLog.create({ data: {
        actor: who.actor,
        action: cause === 'logout' || cause === 'account_switch' ? AUTH_LOGOUT : AUTH_EXPIRED,
        target: who.target,
        detail,
      } });
      return true;
    }));
  }

  /**
   * 로그아웃·계정 전환·가입 진입. 0행이면 지금 세션으로 인증을 이어 가지 않고 다시 읽는다 — 없으면 이미 끝난
   * 것이고, 있으면 그 새 관찰로 삭제를 다시 한다. 세 번째 0행 뒤에도 남아 있으면 409(종료 행 0, 쿠키 그대로).
   */
  private async endByRequest(sid: string, session: Session | null, cause: EndCause, ip: string | null) {
    for (let writes = 0; session; ) {
      if (writes === TRANSITION_LIMIT) throw this.conflict();
      writes++;
      if (await this.endSession(session, cause, ip)) return;
      session = await this.readSession(sid);
    }
  }

  private async discardBrowserSession(req: any, res: any) {
    const sid = this.sessionId(req);
    if (sid) await this.endByRequest(sid, await this.readSession(sid), 'account_switch', this.requestIp(req));
    this.expireSessionCookie(res);
  }

  async beginLogin(req: any, res: any, prompt?: 'login' | 'create'): Promise<string> {
    // Strict 세션 쿠키는 KC에서 돌아오는 cross-site 콜백에 실리지 않는다. 계정 전환과
    // 가입 진입 전에 고아 행을 없앨 수 있는 자리는 같은 출처인 이 진입점뿐이다.
    // 종료를 확인하지 못하면(409·저장소 실패) 새 pending도 Keycloak 이동도 만들지 않는다.
    if (prompt === 'login' || prompt === 'create') await this.discardBrowserSession(req, res);

    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.setPendingCookie(res, this.signPending({ state, verifier, issuedAt: Date.now() }));

    const query = new URLSearchParams({
      client_id: 'kin-bff',
      response_type: 'code',
      scope: 'openid profile email',
      redirect_uri: this.redirectUri(),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (prompt) query.set('prompt', prompt);
    return `${this.externalOidc('/auth')}?${query}`;
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
   * 로그인 실패 행(OP-2 A). 이 서버가 시작한 로그인(서명·만료가 맞는 kin_pending)만 기록한다 — 익명 콜백이 행을
   * 만들지 못하게. 콜백의 error 원문·code·state는 남기지 않는다. 기록 실패는 고정 분류만 남기고 콜백 응답을 바꾸지 않는다.
   */
  async recordLoginFailure(req: any, cause: LoginFailureCause): Promise<void> {
    if (this.readPending(req)) await this.loginFailureRow(req, cause, null);
  }

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

  async finishLogin(req: any, code: string, state: string): Promise<string> {
    const pending = this.readPending(req);
    if (!pending || pending.state !== state) {
      if (pending) await this.loginFailureRow(req, 'state_mismatch', null);
      throw new BadRequestException('로그인 state 또는 pending 검증에 실패했습니다');
    }
    if (!code) throw new BadRequestException('로그인 code가 없습니다');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'kin-bff',
      client_secret: process.env.KC_WEB_SECRET!,
      code,
      redirect_uri: this.redirectUri(),
      code_verifier: pending.verifier,
    });
    let tokens: any = null;
    try {
      const response = await fetch(this.internalOidc('/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const answer: any = await response.json().catch(() => ({}));
      if (response.ok && answer.access_token && answer.refresh_token) tokens = answer;
    } catch {
      tokens = null;
    }
    if (!tokens) {
      await this.loginFailureRow(req, 'exchange_failed', null);
      throw new UnauthorizedException('Keycloak code 교환에 실패했습니다');
    }

    let payload: JWTPayload & Record<string, any>;
    try { payload = await this.verifyAccessToken(tokens.access_token); }
    catch (error) {
      // 검증하지 못한 토큰의 sub·email·groups는 행에 쓰지 않는다.
      await this.loginFailureRow(req, 'token_invalid', null);
      throw error;
    }
    const who = this.identity(payload, String(payload.sub));
    const sid = randomBytes(32).toString('base64url');
    const now = new Date();
    const detail = JSON.stringify({ institution: who.institution, ip: this.requestIp(req), dataSubject: null, outcome: 'success' });
    try {
      // 세션 생성과 성공 행은 함께 commit되거나 함께 롤백된다.
      await this.prisma.$transaction(async tx => {
        await tx.authSession.create({ data: {
          sid,
          sub: String(payload.sub),
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          atExpiresAt: new Date(Number(payload.exp) * 1000 - 30_000),
          lastSeenAt: now,
        } });
        await tx.auditLog.create({ data: { actor: who.actor, action: AUTH_LOGIN, target: who.target, detail } });
      });
    } catch {
      this.storageWarning('login_transaction');
      await this.loginFailureRow(req, 'session_failed', who);
      throw this.storageFailure();
    }
    return sid;
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
      throw new UnauthorizedException('토큰 검증 실패: ' + error.message);
    }
  }

  /**
   * Keycloak refresh 교환과 토큰 검증만 거절(refresh_failed)이다. 성공 토큰 저장이나 실패 종료의 DB 오류는 거절이
   * 아니라 저장소 실패다 — 두 실패를 한 catch에 담지 않는다(S7-U5 §0.B 2).
   */
  private async exchangeRefresh(refreshToken: string): Promise<{ tokens: any; payload: JWTPayload & Record<string, any> } | null> {
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
      });
      const tokens: any = await response.json().catch(() => ({}));
      if (!response.ok || !tokens.access_token) return null;
      return { tokens, payload: await this.verifyAccessToken(tokens.access_token) };
    } catch {
      return null;
    }
  }

  /** 응답은 그 요청을 시작한 관찰 S에만 적용한다: 성공은 S 조건부 저장이 count 1일 때만, 실패는 S 조건부 종료. */
  private async doRefresh(session: Session, ip: string | null): Promise<RefreshOutcome> {
    const answer = await this.exchangeRefresh(session.refreshToken);
    if (!answer) return await this.endSession(session, 'refresh_failed', ip) ? { kind: 'ended' } : { kind: 'conflict' };
    const data = {
      sub: String(answer.payload.sub),
      accessToken: answer.tokens.access_token as string,
      refreshToken: (answer.tokens.refresh_token ?? session.refreshToken) as string,
      atExpiresAt: new Date(Number(answer.payload.exp) * 1000 - 30_000),
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

  async authenticateSession(sid: string, res: any): Promise<any> {
    const ip = this.requestIp(res?.req);
    let session = await this.readSession(sid);
    if (!session) {
      this.expireSessionCookie(res);
      throw new UnauthorizedException('인증 세션이 없습니다');
    }
    // idle → refresh → 진행을 관찰마다 판정한다. 조건부 전이가 0행이면 그 관찰(과 늦은 성공 토큰)을 버리고 다시 읽는다.
    for (let writes = 0; ;) {
      const now = Date.now();
      const cutoff = new Date(now - SESSION_IDLE_MS);
      let ended: string;
      if (session.lastSeenAt.getTime() < cutoff.getTime()) {
        writes++;
        if (await this.endSession(session, 'idle', ip, cutoff)) {
          this.expireSessionCookie(res);
          throw new UnauthorizedException('인증 세션이 만료되었습니다');
        }
        ended = '인증 세션이 만료되었습니다';
      } else if (session.atExpiresAt.getTime() <= now) {
        writes++;
        const outcome = await this.refresh(session, ip);
        // 자기 저장이 채택되면 그대로 진행한다 — 저장된 atExpiresAt이 이미 지났다는 이유로 같은 요청에서 다시 refresh하지 않는다.
        if (outcome.kind === 'stored') { session = outcome.session; break; }
        if (outcome.kind === 'ended') {
          this.expireSessionCookie(res);
          throw new UnauthorizedException('인증 세션을 갱신할 수 없습니다');
        }
        ended = '인증 세션을 갱신할 수 없습니다';
      } else {
        break;
      }
      const again = await this.readSession(sid);
      if (!again) {
        this.expireSessionCookie(res);
        throw new UnauthorizedException(ended);
      }
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
    return session;
  }

  async logout(req: any, res: any): Promise<void> {
    const sid: string | null = req?.sid ?? null;
    if (!sid) return;
    const session = await this.readSession(sid);
    try {
      if (session) await fetch(this.internalOidc('/logout'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'kin-bff',
          client_secret: process.env.KC_WEB_SECRET!,
          refresh_token: session.refreshToken,
        }),
      });
    } catch {
      // Keycloak이 멈춰도 이 앱의 세션 종료는 시도한다. Keycloak 로그아웃은 이 요청에서 다시 보내지 않는다.
    }
    await this.endByRequest(sid, session, 'logout', this.requestIp(req));
    this.expireSessionCookie(res);
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
        await this.endSession(session, 'sweep', null, cutoff);
      } catch {
        this.storageWarning('sweep_target');
      }
    }
  }
}
