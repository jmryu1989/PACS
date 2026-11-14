/*
 * Merge Exam / Unmerge routes (Technician): the active group of a worklist exam with the checks Unmerge applies now
 * (GET studies/:uid/exam-group), Merge (POST exam-groups) and Unmerge (POST exam-groups/:id/dissolve). The rules are the
 * service's (exam-merge.service.ts).
 */
import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ExamMergeService } from './exam-merge.service';
import type { Caller } from './pacs/access';

/** The caller comes from the global guard's verified token and rights only (sub, actor, roles, institution, kind). */
function caller(req: any): Caller {
  return { sub: req.sub, actor: req.actor, roles: req.roles ?? [], institution: req.institution ?? null, kind: req.kind ?? 'member' };
}

/** A feature controller of its own so the PACS facade and its route snapshot stay as they are; every route needs the
 * technician role (admin passes), so a clinician-only caller is refused. */
@Controller()
export class ExamMergeController {
  constructor(private readonly groups: ExamMergeService) {}

  @Get('studies/:uid/exam-group')
  group(@Param('uid') uid: string, @Req() req: any) {
    return this.groups.group(caller(req), uid);
  }

  @Post('exam-groups')
  @HttpCode(200)
  merge(@Body() body: any, @Req() req: any) {
    return this.groups.merge(caller(req), body);
  }

  @Post('exam-groups/:id/dissolve')
  @HttpCode(200)
  dissolve(@Param('id') id: string, @Req() req: any) {
    return this.groups.dissolve(caller(req), id);
  }
}
