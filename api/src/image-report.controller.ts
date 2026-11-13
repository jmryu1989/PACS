import { Controller, Get, NotFoundException, Param, Req } from '@nestjs/common';
import { Caller, PacsService } from './pacs.service';
// CD-09-P: a response that can carry the caller's private draft registers before it reads (destruction waits for it).
import { draftDeliveries } from './emr-retention/draft-purpose';

/** The caller comes from the global guard's verified token and rights only (sub, actor, roles, institution, kind). */
function caller(req: any): Caller {
  return { sub: req.sub, actor: req.actor, roles: req.roles ?? [], institution: req.institution ?? null, kind: req.kind ?? 'member' };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function drawingId(id: string): string {
  if (!UUID.test(id)) throw new NotFoundException('그림을 찾을 수 없습니다');
  return id;
}

/**
 * Image Report: the drawings a report holds. Attaching and removing ride the draft write (PUT studies/:uid/report with
 * `drawing` / `removeDrawing`) and committing binds them to the version (POST studies/:uid/report/commit); this controller
 * only reads: the list of the head version and of my draft, and one drawing's picture (clinicians read both under the
 * same report-read rules, clinician-policy.ts). A feature controller of its own so the PACS facade and its route snapshot stay as they are.
 */
@Controller()
export class ImageReportController {
  constructor(private readonly pacs: PacsService) {}

  @Get('studies/:uid/report/drawings')
  drawings(@Param('uid') uid: string, @Req() req: any) {
    draftDeliveries.track(caller(req).actor, req, req.res);   // my draft's drawings
    return this.pacs.reportDrawings(uid, caller(req));
  }

  @Get('studies/:uid/report/drawings/:id')
  drawing(@Param('uid') uid: string, @Param('id') id: string, @Req() req: any) {
    draftDeliveries.track(caller(req).actor, req, req.res);   // a drawing my draft holds
    return this.pacs.reportDrawing(uid, drawingId(id), caller(req));
  }
}
