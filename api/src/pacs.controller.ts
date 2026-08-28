import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { PacsService } from './pacs.service';
import { AuthGuard, Public } from './auth.guard';

/**
 * 모든 엔드포인트가 Keycloak 토큰을 요구한다(@Public 제외).
 * 호출자가 누구인지는 헤더가 아니라 **서명된 토큰**에서 나온다 — req.actor / req.roles.
 * 역할별 권한은 서비스 계층에서 필드 단위로 검사한다 (기사는 Verify, 판독의는 Approve).
 */
@Controller()
@UseGuards(AuthGuard)
export class PacsController {
  constructor(private svc: PacsService) {}

  @Public()
  @Get('health')
  health() {
    return { ok: true, at: new Date().toISOString(), auth: process.env.AUTH_REQUIRED !== 'false' };
  }

  @Get('me')
  me(@Req() req: any) {
    return { actor: req.actor, roles: req.roles };
  }

  @Get('bootstrap')
  bootstrap() {
    return this.svc.bootstrap();
  }

  @Patch('studies/:uid')
  patch(@Param('uid') uid: string, @Body() body: any, @Req() req: any) {
    return this.svc.patchState(uid, body, req.actor, req.roles);
  }

  /** 임시 저장 — 버전을 남기지 않는다 */
  @Put('studies/:uid/report')
  report(@Param('uid') uid: string, @Body() body: any, @Req() req: any) {
    return this.svc.putReport(uid, body, req.actor, req.roles);
  }

  /** 확정 — save / approve / addendum / reset. 내용·버전·RS를 한 트랜잭션으로 */
  @Post('studies/:uid/report/commit')
  commit(@Param('uid') uid: string, @Body() body: any, @Req() req: any) {
    return this.svc.commitReport(uid, body, req.actor, req.roles);
  }

  /** 판독문 이력 */
  @Get('studies/:uid/report/versions')
  versions(@Param('uid') uid: string) {
    return this.svc.versions(uid);
  }

  @Delete('studies/:uid')
  remove(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.removeState(uid, req.actor, req.roles);
  }

  @Post('match')
  match(@Body() body: any, @Req() req: any) {
    return this.svc.match(body.uid, body.oid, body.patient, req.actor, req.roles);
  }

  @Post('unmatch')
  unmatch(@Body() body: any, @Req() req: any) {
    return this.svc.unmatch(body.uid, req.actor, req.roles);
  }

  @Get('audit')
  audit(@Query('uid') uid?: string, @Query('take') take?: string) {
    return this.svc.audits(uid, take ? +take : 100);
  }
}
