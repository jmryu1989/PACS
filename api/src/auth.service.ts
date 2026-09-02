import {
  BadRequestException, Injectable, OnModuleDestroy, OnModuleInit, UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { PrismaService } from './prisma.service';

const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 5 * 60 * 1000;
const PENDING_MAX_AGE_SECONDS = 10 * 60;

type PendingLogin = { state: string; verifier: string; issuedAt: number };

/**
 * 토큰을 브라우저가 아니라 이 서비스 한 곳에서 다룬다. 콜백과 refresh가 같은 검증 함수를
 * 써야, 최초 로그인만 엄격하고 갱신 토큰은 느슨한 두 번째 인증 경로가 생기지 않는다.
 */
@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly refreshes = new Map<string, Promise<any>>();
  private readonly jwks = process.env.KC_JWKS_URL
    ? createRemoteJWKSet(new URL(process.env.KC_JWKS_URL))
    : null;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    // 조회 시 idle 검사가 본체다. 타이머는 다시 오지 않는 세션 행을 치우는 수거원일 뿐이다.
    this.cleanupTimer = setInterval(() => {
      const before = new Date(Date.now() - SESSION_IDLE_MS);
      this.prisma.authSession.deleteMany({ where: { lastSeenAt: { lt: before } } })
        .catch(error => console.error('[KIN API] 만료 인증 세션 정리 실패:', error.message));
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

  private async discardBrowserSession(req: any, res: any) {
    const sid = this.sessionId(req);
    if (sid) await this.prisma.authSession.deleteMany({ where: { sid } });
    this.expireSessionCookie(res);
  }

  async beginLogin(req: any, res: any, prompt?: 'login' | 'create'): Promise<string> {
    // Strict 세션 쿠키는 KC에서 돌아오는 cross-site 콜백에 실리지 않는다. 계정 전환과
    // 가입 진입 전에 고아 행을 없앨 수 있는 자리는 같은 출처인 이 진입점뿐이다.
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
    const session = await this.prisma.authSession.findUnique({
      where: { sid }, select: { lastSeenAt: true },
    });
    return !!session && session.lastSeenAt.getTime() >= Date.now() - SESSION_IDLE_MS;
  }

  async finishLogin(req: any, code: string, state: string): Promise<string> {
    const pending = this.readPending(req);
    if (!pending || pending.state !== state)
      throw new BadRequestException('로그인 state 또는 pending 검증에 실패했습니다');
    if (!code) throw new BadRequestException('로그인 code가 없습니다');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'kin-bff',
      client_secret: process.env.KC_WEB_SECRET!,
      code,
      redirect_uri: this.redirectUri(),
      code_verifier: pending.verifier,
    });
    const response = await fetch(this.internalOidc('/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const tokens: any = await response.json().catch(() => ({}));
    if (!response.ok || !tokens.access_token || !tokens.refresh_token)
      throw new UnauthorizedException('Keycloak code 교환에 실패했습니다');

    const payload = await this.verifyAccessToken(tokens.access_token);
    const sid = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.prisma.authSession.create({ data: {
      sid,
      sub: String(payload.sub),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      atExpiresAt: new Date(Number(payload.exp) * 1000 - 30_000),
      lastSeenAt: now,
    } });
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

  private async doRefresh(sid: string): Promise<any> {
    const session = await this.prisma.authSession.findUnique({ where: { sid } });
    if (!session) throw new UnauthorizedException('인증 세션이 없습니다');
    if (session.atExpiresAt.getTime() > Date.now()) return session;

    try {
      const response = await fetch(this.internalOidc('/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'kin-bff',
          client_secret: process.env.KC_WEB_SECRET!,
          refresh_token: session.refreshToken,
        }),
      });
      const tokens: any = await response.json().catch(() => ({}));
      if (!response.ok || !tokens.access_token) throw new Error('refresh 거부');
      const payload = await this.verifyAccessToken(tokens.access_token);
      return await this.prisma.authSession.update({
        where: { sid },
        data: {
          sub: String(payload.sub),
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? session.refreshToken,
          atExpiresAt: new Date(Number(payload.exp) * 1000 - 30_000),
        },
      });
    } catch (error) {
      await this.prisma.authSession.deleteMany({ where: { sid } });
      throw new UnauthorizedException('인증 세션을 갱신할 수 없습니다');
    }
  }

  private refresh(sid: string): Promise<any> {
    const running = this.refreshes.get(sid);
    if (running) return running;
    const started = this.doRefresh(sid).finally(() => this.refreshes.delete(sid));
    this.refreshes.set(sid, started);
    return started;
  }

  async authenticateSession(sid: string, res: any): Promise<any> {
    let session = await this.prisma.authSession.findUnique({ where: { sid } });
    if (!session) {
      this.expireSessionCookie(res);
      throw new UnauthorizedException('인증 세션이 없습니다');
    }
    if (session.lastSeenAt.getTime() < Date.now() - SESSION_IDLE_MS) {
      await this.prisma.authSession.deleteMany({ where: { sid } });
      this.expireSessionCookie(res);
      throw new UnauthorizedException('인증 세션이 만료되었습니다');
    }
    if (session.atExpiresAt.getTime() <= Date.now()) {
      try { session = await this.refresh(sid); }
      catch (error) { this.expireSessionCookie(res); throw error; }
    }
    if (session.lastSeenAt.getTime() < Date.now() - SESSION_TOUCH_MS) {
      const now = new Date();
      await this.prisma.authSession.updateMany({ where: { sid }, data: { lastSeenAt: now } });
      session.lastSeenAt = now;
    }
    return session;
  }

  async logout(sid: string | null, res: any): Promise<void> {
    if (!sid) return;
    const session = await this.prisma.authSession.findUnique({ where: { sid } });
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
      // Keycloak이 멈춰도 이 앱의 세션 폐기와 204 응답은 끝까지 수행한다.
    } finally {
      await this.prisma.authSession.deleteMany({ where: { sid } });
      this.expireSessionCookie(res);
    }
  }
}
