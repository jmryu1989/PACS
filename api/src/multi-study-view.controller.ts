import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Caller } from './pacs.service';
import { MultiStudyViewService } from './multi-study-view.service';

const caller = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });

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
    const transport = new AbortController();
    const end = () => {
      req.off('aborted', end); req.off('error', end);
      res.off('finish', end); res.off('close', end); res.off('error', end);
      // A1 observes the selected stream's finish first. Aborting synchronously
      // here would misclassify that successful finish as an aborted transfer.
      queueMicrotask(() => transport.abort());
    };
    req.once('aborted', end); req.once('error', end);
    res.once('finish', end); res.once('close', end); res.once('error', end);
    if (req.aborted || res.destroyed || res.writableEnded) transport.abort();
    return this.svc.resolve(req.rawBody, caller(req), transport.signal);
  }
}
