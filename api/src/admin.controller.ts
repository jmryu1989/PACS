import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { AdminService } from './admin.service';
import { Caller } from './pacs.service';

const caller = (req: any): Caller => ({
  sub: req.sub,
  actor: req.actor,
  roles: req.roles ?? [],
  institution: req.institution ?? null,
  kind: req.kind ?? 'member',
});

/**
 * 관리자가 호출할 수 있는 Keycloak 동작을 이 네 경로로만 고정한다.
 * manage-users 권한을 범용 URL 프록시로 노출하면 이 화이트리스트 자체가 사라진다.
 */
@Controller('admin/users')
export class AdminController {
  constructor(private admin: AdminService) {}

  @Get()
  list(@Query('page') page: string | undefined, @Req() req: any) {
    return this.admin.listUsers(page, caller(req));
  }

  @Post()
  create(@Body() body: any, @Req() req: any) {
    return this.admin.createUser(body, caller(req));
  }

  @Patch(':id')
  patch(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.admin.patchUser(id, body, caller(req));
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.admin.resetPassword(id, body, caller(req));
  }
}
