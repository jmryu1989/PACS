import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { AdminService } from './admin.service';
import { Caller, PacsService } from './pacs.service';

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
  constructor(private admin: AdminService, private pacs: PacsService) {}

  @Get('users')
  list(@Query('page') page: string | undefined, @Req() req: any) {
    return this.admin.listUsers(page, caller(req));
  }

  @Post('users')
  create(@Body() body: any, @Req() req: any) {
    return this.admin.createUser(body, caller(req));
  }

  @Patch('users/:id')
  patch(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.admin.patchUser(id, body, caller(req));
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
}
