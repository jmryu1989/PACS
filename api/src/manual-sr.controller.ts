import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Caller } from './pacs.service';
import { ManualSrService } from './manual-sr.service';
const caller = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [], institution: req.institution ?? null, kind: req.kind ?? 'member' });
@Controller('studies/:uid/manual-sr')
export class ManualSrController {
  constructor(private svc: ManualSrService) {}
  @Post() @HttpCode(200)
  prepare(@Param('uid') uid: string, @Req() req: any) { return this.svc.prepare(uid, req.rawBody, caller(req)); }
  @Post(':id/store') @HttpCode(200)
  store(@Param('uid') uid: string, @Param('id') id: string, @Req() req: any) { return this.svc.store(uid, id, req.rawBody, caller(req)); }
}
