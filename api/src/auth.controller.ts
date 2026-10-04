import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { AuthService, markAuthCode } from './auth.service';
import { Public } from './auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  private origin(): string {
    return process.env.PUBLIC_ORIGIN!.replace(/\/$/, '');
  }

  /** 가드를 지나지 않는 진입점의 `AUTH_*` 거절에도 가드와 같은 코드 헤더를 싣는다. */
  private async coded<T>(res: any, work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { markAuthCode(res, error); throw error; }
  }

  /**
   * 링크로 여는 로그인. 어떤 세션도 끝내지 않는다 — 살아 있는 세션의 쿠키가 있으면 Keycloak으로 보내지 않고 입구로
   * 돌려보낸다(그 세션을 바꾸는 로그인은 결속된 POST다).
   */
  @Public()
  @Get('login')
  async login(@Req() req: any, @Res() res: any, @Query('prompt') prompt?: string) {
    const url = await this.auth.beginLogin(req, res, prompt === 'login' ? 'login' : undefined);
    res.redirect(302, url ?? `${this.origin()}/worklist/hpacs-lite/index.html?auth_error=session_active`);
  }

  @Public()
  @Get('register')
  async register(@Req() req: any, @Res() res: any) {
    const url = await this.auth.beginLogin(req, res, 'create');
    res.redirect(302, url ?? `${this.origin()}/worklist/hpacs-lite/index.html?auth_error=session_active`);
  }

  /**
   * 세션을 바꿀 수 있는 로그인 개시(계정 전환, 끝내지 못한 세션 뒤의 다시 로그인). CSRF와, 쿠키가 있으면 그 세션의
   * 결속을 확인한 뒤에만 그 세션을 끝낸다. 답은 이동할 주소다 — 헤더를 실어야 하는 요청이라 링크로는 보낼 수 없다.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  async startLogin(@Req() req: any, @Res({ passthrough: true }) res: any, @Body() body: any) {
    return this.coded(res, async () =>
      ({ location: await this.auth.beginBoundLogin(req, res, body?.prompt === 'login' ? 'login' : undefined) }));
  }

  @Public()
  @Post('register')
  @HttpCode(200)
  async startRegister(@Req() req: any, @Res({ passthrough: true }) res: any) {
    return this.coded(res, async () => ({ location: await this.auth.beginBoundLogin(req, res, 'create') }));
  }

  @Public()
  @Get('callback')
  async callback(
    @Req() req: any,
    @Res() res: any,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    this.auth.expirePendingCookie(res);
    const origin = this.origin();
    if ((!code || !state) && await this.auth.hasSession(req)) {
      res.redirect(302, `${origin}/worklist/hpacs-lite/main.html`);
      return;
    }
    if (error) {
      // 실패 행은 이 서버가 시작한 로그인일 때만 남고, error 원문은 행에 싣지 않는다(OP-2 A).
      await this.auth.recordLoginFailure(req, 'provider_error');
      res.redirect(302, `${origin}/worklist/hpacs-lite/index.html?auth_error=${encodeURIComponent(error)}`);
      return;
    }
    if (!code) {
      await this.auth.recordLoginFailure(req, 'no_code');
      res.redirect(302, `${origin}/worklist/hpacs-lite/index.html?auth_error=stale`);
      return;
    }
    try {
      const { sid, proof, document } = await this.auth.finishLogin(req, code ?? '', state ?? '');
      // `kin_sid`를 쓰는 응답은 이것 하나다. 진입 증명은 fragment로만 나간다 — 서버·프록시 기록과 Referer에 실리지 않는다.
      this.auth.setSessionCookie(res, sid);
      res.redirect(302, `${origin}/worklist/hpacs-lite/${document}#kin-entry=${encodeURIComponent(proof)}`);
    } catch (caught: any) {
      if (caught?.getStatus?.() === 400) throw caught;
      res.redirect(302, `${origin}/worklist/hpacs-lite/index.html?auth_error=login_failed`);
    }
  }

  /** 로그인 직후의 문서가 진입 증명을 한 번 쓰고 그 세션의 식별값을 받는다. */
  @Public()
  @Post('entry')
  @HttpCode(200)
  async entry(@Req() req: any, @Res({ passthrough: true }) res: any) {
    return this.coded(res, () => this.auth.enter(req));
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: any, @Res() res: any) {
    // 접속기록의 접속지는 요청에서, 신원은 끝낸 세션에서 온다. 409(경쟁)·500(저장소)은 "끝났다"는 답 없이 그대로 나가고,
    // 어느 답도 쿠키를 바꾸지 않는다.
    await this.coded(res, () => this.auth.logout(req));
    res.status(204).send();
  }
}
