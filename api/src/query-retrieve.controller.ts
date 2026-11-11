import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { QueryRetrieveService } from './query-retrieve.service';
import type { Caller } from './pacs/access';

/** The caller comes from the global guard's verified token and rights only (sub, actor, roles, institution, kind). */
function caller(req: any): Caller {
  return { sub: req.sub, actor: req.actor, roles: req.roles ?? [], institution: req.institution ?? null, kind: req.kind ?? 'member' };
}

/**
 * FC-070 Query/Retrieve: the members' search and retrieve of another PACS, and the administrator's peer registration.
 * A feature controller of its own so the PACS facade and its route snapshot stay as they are. Roles, institution and
 * requester binding are the service's (query-retrieve.service.ts); clinician-only callers are refused by the guard's
 * default.
 */
@Controller()
export class QueryRetrieveController {
  constructor(private readonly qr: QueryRetrieveService) {}

  @Get('query-retrieve/peers')
  peers(@Req() req: any) {
    return this.qr.peers(caller(req));
  }

  @Post('query-retrieve/search')
  @HttpCode(200)
  search(@Body() body: any, @Req() req: any) {
    return this.qr.search(body, caller(req));
  }

  @Post('query-retrieve/retrieve')
  @HttpCode(200)
  retrieve(@Body() body: any, @Req() req: any) {
    return this.qr.retrieve(body, caller(req));
  }

  @Get('query-retrieve/jobs/:id')
  job(@Param('id') id: string, @Req() req: any) {
    return this.qr.job(id, caller(req));
  }

  @Get('admin/dicom-peers')
  adminPeers(@Req() req: any) {
    return this.qr.adminPeers(caller(req));
  }

  @Post('admin/dicom-peers')
  registerPeer(@Body() body: any, @Req() req: any) {
    return this.qr.registerPeer(body, caller(req));
  }

  @Delete('admin/dicom-peers/:id')
  removePeer(@Param('id') id: string, @Req() req: any) {
    return this.qr.removePeer(id, caller(req));
  }
}
