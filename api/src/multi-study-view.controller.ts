import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Caller } from './pacs.service';
import { MultiStudyViewService } from './multi-study-view.service';
import type { TransferOutcome } from './multi-study-view.service';

const caller = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });

/**
 * What happened to this response's body, observed on the response itself and installed before the service prepares any
 * provision. A finished 200 is the resolve's own body; a finished refusal (the interceptor's post-handler policy check, a
 * serializer error) or a connection closed before finishing is a body that did not go out whole.
 */
function transferOf(res: any): Promise<TransferOutcome> {
  return new Promise(settle => {
    res.once('finish', () => settle(res.statusCode === 200 ? 'ended' : 'aborted'));
    res.once('close', () => settle('aborted'));
  });
}

/**
 * W9-LITE multi-study viewing (server half). Its own controller keeps ViewerController's injectable and route metadata as
 * they are; the route reads only, and its one durable write is the access record its service binds (never a clinical row).
 */
@Controller()
export class MultiStudyViewController {
  constructor(private svc: MultiStudyViewService) {}

  @Post('studies/viewing-set/resolve')
  @HttpCode(200)
  resolve(@Req() req: any, @Res({ passthrough: true }) res: any) {
    return this.svc.resolve(req.rawBody, caller(req), transferOf(res));
  }
}
