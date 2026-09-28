import { Controller, ForbiddenException, Get, Param, Query, Req } from '@nestjs/common';
import type { Caller } from './pacs.service';
import { ClinicalContextService } from './clinical-context.service';
import { CLINICIAN_ROUTE_DENIED, clinicianOnly } from './clinician-policy';

const member = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });

/**
 * S7-U4a Clinical Context(판독의 패널, 계약 S7-U4p §9). 읽기 route 하나이고 쓰기·감사가 없다. app.module의 adminNoStore와
 * 전역 StudyAccessInterceptor 범위에 있다. 역할·기관·StudyAccess·서명 머리 판 규칙은 clinical-context.service.ts가 판정한다.
 */
@Controller()
export class ClinicalContextController {
  constructor(private context: ClinicalContextService) {}

  @Get('studies/:uid/clinical-context')
  read(@Param('uid') uid: string, @Query() query: any, @Req() req: any) {
    // clinician-only never reaches this through the guard allowlist. This second line keeps a widened allowlist from
    // opening signed prior bodies and request tags to clinicians: D-S7-11 (b) is a reader panel with no clinician screen.
    if (clinicianOnly(req.roles)) throw new ForbiddenException({ code: CLINICIAN_ROUTE_DENIED });
    return this.context.read(uid, query, member(req));
  }
}
