import { Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public()
  @Get('login')
  async login(@Req() req: any, @Res() res: any, @Query('prompt') prompt?: string) {
    const url = await this.auth.beginLogin(req, res, prompt === 'login' ? 'login' : undefined);
    res.redirect(302, url);
  }

  @Public()
  @Get('register')
  async register(@Req() req: any, @Res() res: any) {
    res.redirect(302, await this.auth.beginLogin(req, res, 'create'));
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
    const origin = process.env.PUBLIC_ORIGIN!.replace(/\/$/, '');
    if ((!code || !state) && await this.auth.hasSession(req)) {
      res.redirect(302, `${origin}/worklist/hpacs-lite/main.html`);
      return;
    }
    if (error) {
      res.redirect(302, `${origin}/worklist/hpacs-lite/index.html?auth_error=${encodeURIComponent(error)}`);
      return;
    }
    if (!code) {
      res.redirect(302, `${origin}/worklist/hpacs-lite/index.html?auth_error=stale`);
      return;
    }
    try {
      const sid = await this.auth.finishLogin(req, code ?? '', state ?? '');
      this.auth.setSessionCookie(res, sid);
      res.redirect(302, `${origin}/worklist/hpacs-lite/main.html`);
    } catch (caught: any) {
      if (caught?.getStatus?.() === 400) throw caught;
      res.redirect(302, `${origin}/worklist/hpacs-lite/index.html?auth_error=login_failed`);
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: any, @Res() res: any) {
    await this.auth.logout(req.sid ?? null, res);
    res.status(204).send();
  }
}
