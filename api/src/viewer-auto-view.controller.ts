import { Controller, ForbiddenException, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ViewerAutoViewService } from './viewer-auto-view.service';
import { Caller } from './pacs.service';
const caller = (r: any): Caller => {
  if (r.headers['x-kin-subject'] !== undefined && r.headers['x-kin-subject'] !== r.sub) throw new ForbiddenException('세션이 변경되었습니다');
  return { sub: r.sub, actor: r.actor, institution: r.institution ?? null, roles: r.roles ?? [], kind: r.kind };
};
/** Auto Save View: the caller's own saved view of a study (read, overwrite, discard). Never part of the Jobs list. */
@Controller()
export class ViewerAutoViewController {
  constructor(private svc: ViewerAutoViewService) {}
  @Get('studies/:uid/viewer-auto-view')
  read(@Param('uid') uid: string, @Req() r: any) { return this.svc.read(uid, caller(r)); }
  @Post('studies/:uid/viewer-auto-view')
  @HttpCode(200)
  save(@Param('uid') uid: string, @Req() r: any) { return this.svc.save(uid, r.rawBody, caller(r)); }
  @Post('studies/:uid/viewer-auto-view/discard')
  @HttpCode(200)
  discard(@Param('uid') uid: string, @Req() r: any) { return this.svc.discard(uid, caller(r)); }
}
