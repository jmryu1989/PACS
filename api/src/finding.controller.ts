import { Controller, Get, HttpCode, Inject, Optional, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Caller } from './pacs.service';
import { FindingService } from './finding.service';
import { findingCommand } from './finding-input';
import { canonical } from './viewer-input';
import { refuse } from './emr-contract/validation';
import { ClinicalRoutes, clinicalRoutes, EMR_CLINICAL_ROUTES } from './emr-clinical/routes';
import type { SurfaceKey } from './emr-clinical/contract';

const caller = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });
// S2-L1 handshake: every findings answer names the record format this API writes, set before the service
// runs so its refusals carry it too. A client that sends the same header may receive version 2 records.
const SCHEMA = 'X-KIN-Finding-Schema';
const announce = (res: any) => { res.setHeader(SCHEMA, '2'); };
const requested = (req: any) => { const value = req.headers?.['x-kin-finding-schema']; return typeof value === 'string' ? value : undefined; };

@Controller()
export class FindingController {
  constructor(private svc: FindingService,
    @Optional() @Inject(EMR_CLINICAL_ROUTES) private readonly clinical?: ClinicalRoutes) {}

  private write(uid: string, req: any, id?: string) {
    const command = findingCommand(req.rawBody, id === undefined);
    return clinicalRoutes(this.clinical).write(req, {
      surface: ('finding.' + command.action) as SurfaceKey, studyId: uid,
      recordId: id ?? command.requestId, body: JSON.parse(req.rawBody.toString('utf8')),
    }, async (tx, plan) => {
      const saved = await this.svc.write(uid, req.rawBody, caller(req), id, { tx, recordId: plan.version.recordId });
      // A's prepared source copies and the service's actual stored snapshot
      // must describe one version. A changed source rolls the transaction back.
      if (saved.id !== plan.version.recordId || saved.revision !== plan.version.sequence ||
          canonical(saved.item) !== plan.version.text) refuse('StaleRevision');
      return saved;
    });
  }

  @Get('studies/:uid/findings')
  list(@Param('uid') uid: string, @Query() query: any, @Req() req: any, @Res({ passthrough: true }) res: any) {
    announce(res);
    return clinicalRoutes(this.clinical).collection(req, 'GET studies/:uid/findings', 'finding',
      tx => this.svc.list(uid, query, caller(req), undefined, requested(req), tx));
  }

  @Post('studies/:uid/findings')
  @HttpCode(200)
  create(@Param('uid') uid: string, @Req() req: any, @Res({ passthrough: true }) res: any) {
    announce(res);
    return this.write(uid, req);
  }

  @Get('studies/:uid/findings/:id/revisions')
  revisions(@Param('uid') uid: string, @Param('id') id: string, @Query() query: any, @Req() req: any, @Res({ passthrough: true }) res: any) {
    announce(res);
    return clinicalRoutes(this.clinical).read(req, 'finding', id,
      tx => this.svc.list(uid, query, caller(req), id, requested(req), tx));
  }

  @Post('studies/:uid/findings/:id/revisions')
  @HttpCode(200)
  revise(@Param('uid') uid: string, @Param('id') id: string, @Req() req: any, @Res({ passthrough: true }) res: any) {
    announce(res);
    return this.write(uid, req, id);
  }
}
