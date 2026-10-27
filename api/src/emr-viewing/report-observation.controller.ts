import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Caller } from '../pacs/access';
import { ReportObservationService } from './report-observation.service';

const caller = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });

/**
 * MODULE_A A4. 200 is the acknowledgement of a committed (or replayed) display record; the route exposes no new
 * resource, and a refused or unrecorded report never answers 200.
 */
@Controller()
export class ReportObservationController {
  constructor(private readonly observations: ReportObservationService) {}

  @Post('studies/:uid/view-observations')
  @HttpCode(200)
  observe(@Param('uid') uid: string, @Body() body: unknown, @Req() req: any) {
    return this.observations.observe(uid, body, caller(req), req);
  }
}
