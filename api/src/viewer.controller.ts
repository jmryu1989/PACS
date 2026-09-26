import { BadRequestException, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { Caller, PacsService } from './pacs.service';
import { ViewerService } from './viewer.service';
import { clinicianOnly, clinicianViewerPage, clinicianViewerQuery, clinicianViewerWithheld } from './clinician-policy';

const caller = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });

@Controller()
export class ViewerController {
  constructor(private svc: ViewerService, private pacs: PacsService) {}

  @Get('studies/:uid/viewer-items')
  list(@Param('uid') uid: string, @Query() query: any, @Req() req: any) {
    const c = caller(req);
    return clinicianOnly(c.roles) ? this.clinicianItems(uid, query, c) : this.svc.list(uid, query, c);
  }

  /**
   * S5-U1b clinician-only 읽기. 판독의가 남긴 표시 항목(key·화살표·측정)은 판독 작업의 일부라 확정본(S5-F5)일
   * 때만, 작성자·숨김·원본 요약 칸을 뺀 모양으로 준다. 확정 여부는 읽기 **뒤에** 한 번 더 본다 — 항목을 읽는
   * 사이 reset이 끼어들면 확정 전 판의 항목이 답이 된다. 혼합 역할은 이 길을 타지 않고 기존 응답을 받는다.
   */
  private async clinicianItems(uid: string, query: any, c: Caller) {
    const page = clinicianViewerQuery(query);
    if (!page) throw new BadRequestException('숨긴 표시 항목은 조회할 수 없습니다');
    if (!await this.pacs.clinicianViewerFinal(uid, c)) return clinicianViewerWithheld(uid);
    const result = await this.svc.list(uid, page, c);
    if (!await this.pacs.clinicianViewerFinal(uid, c)) return clinicianViewerWithheld(uid);
    return clinicianViewerPage(uid, result);
  }

  @Post('studies/:uid/viewer-items')
  @HttpCode(200)
  create(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.write(uid, req.rawBody, caller(req));
  }

  @Get('studies/:uid/viewer-items/:id/revisions')
  revisions(@Param('uid') uid: string, @Param('id') id: string, @Query() query: any, @Req() req: any) {
    return this.svc.list(uid, query, caller(req), id);
  }

  @Post('studies/:uid/viewer-items/:id/revisions')
  @HttpCode(200)
  revise(@Param('uid') uid: string, @Param('id') id: string, @Req() req: any) {
    return this.svc.write(uid, req.rawBody, caller(req), id);
  }
}
