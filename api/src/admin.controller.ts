import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { AdminService } from './admin.service';
import { Caller, PacsService } from './pacs.service';
import { EMR_RECORD_PORT, EmrRecordPort } from './emr-runtime/record-port';
import type { RightsRequestFacts } from './member-rights';

const caller = (req: any): Caller => ({
  sub: req.sub,
  actor: req.actor,
  roles: req.roles ?? [],
  institution: req.institution ?? null,
  kind: req.kind ?? 'member',
});

/**
 * 관리자가 호출할 수 있는 Keycloak 동작을 아래 `users` 네 경로로만 고정한다.
 * manage-users 권한을 범용 URL 프록시로 노출하면 이 화이트리스트 자체가 사라진다.
 *
 * 접두어가 `admin`인 이유: S5-U6b 운영 지표 읽기(`metrics`)를 같은 컨트롤러에 두면 app.module 등록과
 * no-store 미들웨어를 그대로 쓴다. 회원 경로의 URL과 route key(`GET admin/users` 등)는 접두어와 핸들러
 * 경로를 이어 붙인 값이라 바뀌지 않는다.
 */
@Controller('admin')
export class AdminController {
  constructor(private admin: AdminService, private pacs: PacsService,
    @Inject(EMR_RECORD_PORT) private readonly ledger: EmrRecordPort) {}

  private async rightsFacts(req: any, surface: string): Promise<RightsRequestFacts> {
    const work = this.ledger.begin();
    try {
      const issuer = process.env.KC_ISSUER;
      const proxy = req.headers?.['x-real-ip'];
      const peer = req.socket?.remoteAddress;
      const observedProxy = typeof proxy === 'string' && isIP(proxy);
      // AuthGuard supplies the member and rights snapshot; nginx supplies the
      // observed client address. A direct request retains its actual peer.
      return { surface, actor: { issuer, subject: req.sub,
        id: await work.resolveRequestIdentity(issuer, req.sub) },
        roles: req.roles, rightsVersion: req.rightsVersion, institution: req.institution ?? null,
        ip: observedProxy ? proxy : typeof peer === 'string' && isIP(peer) ? peer : null,
        ipSource: observedProxy ? 'trusted-proxy' : 'request-peer',
        sessionRef: req.sessionId ?? null, requestId: randomUUID() };
    } finally { work.end(); }
  }

  @Get('users')
  list(@Query('page') page: string | undefined, @Req() req: any) {
    return this.admin.listUsers(page, caller(req));
  }

  @Post('users')
  async create(@Body() body: any, @Req() req: any) {
    return this.admin.createUser(body, caller(req), await this.rightsFacts(req, 'POST admin/users'));
  }

  @Patch('users/:id')
  async patch(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.admin.patchUser(id, body, caller(req), await this.rightsFacts(req, 'PATCH admin/users/:id'));
  }

  @Post('users/:id/reset-password')
  @HttpCode(200)
  resetPassword(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.admin.resetPassword(id, body, caller(req));
  }

  /** S5-U6b 운영 지표. admin 역할·기관 범위·검사 접근 제한은 서비스(need·inst·visible)가 판정한다. */
  @Get('metrics')
  metrics(@Req() req: any) {
    return this.pacs.adminMetrics(caller(req));
  }

  /**
   * S5-U5b 감사·보안 기록. admin 역할, 행을 쓸 때 남은 기관으로 정하는 귀속, 쪽을 자르기 전의 거르기와 봉인한
   * 다음 쪽 값은 서비스(admin-audit.ts)가 판정한다. clinician-only는 guard 기본 거절이다.
   */
  @Get('audit')
  auditEvents(@Query() query: any, @Req() req: any) {
    return this.admin.auditEvents(query, caller(req));
  }
}
