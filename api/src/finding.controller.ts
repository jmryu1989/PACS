import { Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Caller } from './pacs.service';
import { FindingService } from './finding.service';

const caller = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });
// S2-L1 handshake: every findings answer names the record format this API writes, set before the service
// runs so its refusals carry it too. A client that sends the same header may receive version 2 records.
const SCHEMA = 'X-KIN-Finding-Schema';
const announce = (res: any) => { res.setHeader(SCHEMA, '2'); };
const requested = (req: any) => { const value = req.headers?.['x-kin-finding-schema']; return typeof value === 'string' ? value : undefined; };
// EMR-D: writes and the reads that carry finding text (the list, a finding's revisions) also pass the request itself; the
// verified context (B2) and the carried device signature (C) are read from it by server ports only, never from body fields.

@Controller()
export class FindingController {
  constructor(private svc: FindingService) {}

  @Get('studies/:uid/findings')
  list(@Param('uid') uid: string, @Query() query: any, @Req() req: any, @Res({ passthrough: true }) res: any) {
    announce(res);
    return this.svc.list(uid, query, caller(req), undefined, requested(req), req);
  }

  @Post('studies/:uid/findings')
  @HttpCode(200)
  create(@Param('uid') uid: string, @Req() req: any, @Res({ passthrough: true }) res: any) {
    announce(res);
    return this.svc.write(uid, req.rawBody, caller(req), undefined, req);
  }

  @Get('studies/:uid/findings/:id/revisions')
  revisions(@Param('uid') uid: string, @Param('id') id: string, @Query() query: any, @Req() req: any, @Res({ passthrough: true }) res: any) {
    announce(res);
    return this.svc.list(uid, query, caller(req), id, requested(req), req);
  }

  @Post('studies/:uid/findings/:id/revisions')
  @HttpCode(200)
  revise(@Param('uid') uid: string, @Param('id') id: string, @Req() req: any, @Res({ passthrough: true }) res: any) {
    announce(res);
    return this.svc.write(uid, req.rawBody, caller(req), id, req);
  }
}
