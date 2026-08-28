import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { PacsService } from './pacs.service';

/**
 * 인증은 아직 없다. 프론트가 X-KIN-User 헤더로 자기가 누구인지 말하고, 서버는 그대로 믿는다.
 * 3단계 후반에 Keycloak(OIDC)으로 교체하면서 이 헤더는 토큰의 subject로 바뀐다.
 * 그때까지 이 API를 사내망 밖에 노출하지 않는다.
 */
@Controller()
export class PacsController {
  constructor(private svc: PacsService) {}

  @Get('health')
  health() {
    return { ok: true, at: new Date().toISOString() };
  }

  @Get('bootstrap')
  bootstrap() {
    return this.svc.bootstrap();
  }

  @Patch('studies/:uid')
  patch(@Param('uid') uid: string, @Body() body: any, @Headers('x-kin-user') actor: string) {
    return this.svc.patchState(uid, body, actor);
  }

  @Put('studies/:uid/report')
  report(@Param('uid') uid: string, @Body() body: any, @Headers('x-kin-user') actor: string) {
    return this.svc.putReport(uid, body, actor);
  }

  @Delete('studies/:uid')
  remove(@Param('uid') uid: string, @Headers('x-kin-user') actor: string) {
    return this.svc.removeState(uid, actor);
  }

  @Post('match')
  match(@Body() body: any, @Headers('x-kin-user') actor: string) {
    return this.svc.match(body.uid, body.oid, body.patient, actor);
  }

  @Post('unmatch')
  unmatch(@Body() body: any, @Headers('x-kin-user') actor: string) {
    return this.svc.unmatch(body.uid, actor);
  }

  @Get('audit')
  audit(@Query('uid') uid?: string, @Query('take') take?: string) {
    return this.svc.audits(uid, take ? +take : 100);
  }
}
