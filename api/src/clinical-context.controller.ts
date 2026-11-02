import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Caller } from './pacs.service';
import { ClinicalContextService } from './clinical-context.service';

const member = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });

/**
 * S7-U4a Clinical Context(판독의 패널, 계약 S7-U4p §9). 읽기 route 하나이고 업무 쓰기·감사가 없다. 답은 실린 기록의
 * 열람 접속기록(LocalReadResponse)이 commit된 뒤에만 나간다. 공통 API 응답의 no-store 정책을 따른다. 역할·기관·StudyAccess·서명 머리 판 규칙은 clinical-context.service.ts가 판정한다.
 */
@Controller()
export class ClinicalContextController {
  constructor(private context: ClinicalContextService) {}

  @Get('studies/:uid/clinical-context')
  read(@Param('uid') uid: string, @Query() query: any, @Req() req: any) {
    return this.context.read(uid, query, member(req));
  }
}
