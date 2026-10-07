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
   * 돌려보낸다. 주소의 매개변수로는 재인증을 청할 수 없다: 그 의도는 CSRF로 보호된 POST만 시작한다.
   */
  @Public()
  @Get('login')
  async login(@Req() req: any, @Res() res: any) {
    const url = await this.auth.beginLogin(req, res);
    res.redirect(302, url ?? `${this.origin()}/worklist/hpacs-lite/index.html?auth_error=session_active`);
  }

  @Public()
  @Get('register')
  async register(@Req() req: any, @Res() res: any) {
    const url = await this.auth.beginLogin(req, res, 'create');
    res.redirect(302, url ?? `${this.origin()}/worklist/hpacs-lite/index.html?auth_error=session_active`);
  }

  /**
   * 재인증 의도의 로그인 개시(끝내지 못한 로그아웃 뒤의 Login, 계정 전환, 떠났는지 알 수 없는 브라우저의 Login). 본문은
   * `{intent: 'reauthenticate', reason}`이다. CSRF와, 살아 있는 세션이 있으면 그 세션의 결속을 확인한 뒤에만 그 세션을
   * 끝낸다. 답은 이동할 주소다 — 헤더를 실어야 하는 요청이라 링크로는 보낼 수 없다.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  async startLogin(@Req() req: any, @Res({ passthrough: true }) res: any, @Body() body: any) {
    return this.coded(res, async () => ({ location: await this.auth.beginReauthentication(req, res, body) }));
  }

  @Public()
  @Post('register')
  @HttpCode(200)
  async startRegister(@Req() req: any, @Res({ passthrough: true }) res: any) {
    return this.coded(res, async () => ({ location: await this.auth.beginBoundRegister(req, res) }));
  }

  /**
   * 로그인 콜백은 브라우저의 최상위 이동이다: 어느 경우에도 JSON 오류로 답하지 않고 갈 곳으로 보낸다(업무 문서, 인증
   * 서버의 다음 단계, 사유가 붙은 랜딩). 판정은 서비스가 한다 — 여기는 그 답을 이동으로 옮길 뿐이다.
   */
  @Public()
  @Get('callback')
  async callback(
    @Req() req: any,
    @Res() res: any,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const pages = `${this.origin()}/worklist/hpacs-lite`;
    let result;
    try {
      result = await this.auth.finishCallback(req, res, { code, state, error });
    } catch {
      result = { kind: 'landing' as const, error: 'login_failed' };
    }
    if (result.kind === 'entered') {
      // `kin_sid`를 쓰는 응답은 이것 하나다. 진입 증명은 fragment로만 나간다 — 서버·프록시 기록과 Referer에 실리지 않는다.
      this.auth.setSessionCookie(res, result.sid);
      res.redirect(302, `${pages}/${result.document}#kin-entry=${encodeURIComponent(result.proof)}`);
    } else if (result.kind === 'redirect') {
      res.redirect(302, result.location);
    } else if (result.kind === 'work') {
      res.redirect(302, `${pages}/main.html`);
    } else {
      res.redirect(302, `${pages}/index.html?auth_error=${encodeURIComponent(result.error)}`);
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
