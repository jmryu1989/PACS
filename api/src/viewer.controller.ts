import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { Caller } from './pacs.service';
import { ViewerService } from './viewer.service';

const caller = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });

@Controller()
export class ViewerController {
  constructor(private svc: ViewerService) {}

  @Get('studies/:uid/viewer-items')
  list(@Param('uid') uid: string, @Query() query: any, @Req() req: any) {
    return this.svc.list(uid, query, caller(req));
  }

  @Post('studies/:uid/viewer-items')
  @HttpCode(200)
  create(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.write(uid, req.rawBody, caller(req));
  }

  @Get('studies/:uid/viewer-items/:id/revisions')
  revisions(@Param('uid') uid: string, @Param('id') id: string, @Query() query: any, @Req() req: any) {
    return this.svc.list(uid, query, caller(req), id);
  }

  @Post('studies/:uid/viewer-items/:id/revisions')
  @HttpCode(200)
  revise(@Param('uid') uid: string, @Param('id') id: string, @Req() req: any) {
    return this.svc.write(uid, req.rawBody, caller(req), id);
  }
}
