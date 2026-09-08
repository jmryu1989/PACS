import { Controller, ForbiddenException, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ViewerJobService } from './viewer-job.service';
import { Caller } from './pacs.service';
const caller = (r: any): Caller => {
  if (r.headers['x-kin-subject'] !== undefined && r.headers['x-kin-subject'] !== r.sub) throw new ForbiddenException('세션이 변경되었습니다');
  return { sub: r.sub, actor: r.actor, institution: r.institution ?? null, roles: r.roles ?? [], kind: r.kind };
};
@Controller()
export class ViewerJobController {
  constructor(private svc: ViewerJobService) {}
  @Get('studies/:uid/viewer-jobs')
  list(@Param('uid') uid: string, @Query() q: any, @Req() r: any) { return this.svc.list(uid, q, caller(r)); }
  @Post('studies/:uid/viewer-jobs')
  @HttpCode(200)
  create(@Param('uid') uid: string, @Req() r: any) { return this.svc.create(uid, r.rawBody, caller(r)); }
  @Get('studies/:uid/viewer-jobs/:id')
  get(@Param('uid') uid: string, @Param('id') id: string, @Req() r: any) { return this.svc.get(uid, id, caller(r)); }
  @Post('studies/:uid/viewer-jobs/:id/revisions')
  @HttpCode(200)
  revise(@Param('uid') uid: string, @Param('id') id: string, @Req() r: any) { return this.svc.revise(uid, id, r.rawBody, caller(r)); }
}
