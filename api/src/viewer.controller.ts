import { Controller, Get, HttpCode, Inject, Optional, Param, Post, Query, Req } from '@nestjs/common';
import { EMR_CLINICAL_ROUTES, ClinicalRoutes, clinicalRoutes } from './emr-clinical/routes';
import { Caller, PacsService } from './pacs.service';
import { ViewerService } from './viewer.service';
import { ViewerContextEventService } from './viewer-context-event.service';


const caller = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });

@Controller()
export class ViewerController {
  constructor(private svc: ViewerService, private pacs: PacsService, private contextEvents: ViewerContextEventService,
    @Optional() @Inject(EMR_CLINICAL_ROUTES) private readonly clinical?: ClinicalRoutes) {}

  @Post('studies/:uid/viewer-context-events')
  @HttpCode(200)
  contextEvent(@Param('uid') uid: string, @Req() req: any) {
    return this.contextEvents.record(uid, req.rawBody, caller(req));
  }

  @Get('studies/:uid/viewer-items')
  list(@Param('uid') uid: string, @Query() query: any, @Req() req: any) {
    // Current items and revisions use the same institution and Preliminary checks for every reader.
    return this.svc.listRead(uid, query, caller(req));
  }

  @Post('studies/:uid/viewer-items')
  @HttpCode(200)
  create(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.write(uid, req.rawBody, caller(req), undefined, clinicalRoutes(this.clinical).recorder(req));
  }

  @Get('studies/:uid/viewer-items/:id/revisions')
  revisions(@Param('uid') uid: string, @Param('id') id: string, @Query() query: any, @Req() req: any) {
    return this.svc.listRead(uid, query, caller(req), id);
  }

  @Post('studies/:uid/viewer-items/:id/revisions')
  @HttpCode(200)
  revise(@Param('uid') uid: string, @Param('id') id: string, @Req() req: any) {
    return this.svc.write(uid, req.rawBody, caller(req), id, clinicalRoutes(this.clinical).recorder(req));
  }
}
