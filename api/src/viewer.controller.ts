import { BadRequestException, ConflictException, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { Caller, PacsService } from './pacs.service';
import { ViewerService } from './viewer.service';
import { CLINICIAN_VIEWER_CHANGED, clinicianOnly, clinicianViewerPage, clinicianViewerPinned, clinicianViewerQuery,
  clinicianViewerWithheld } from './clinician-policy';

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
   * 때만, 작성자·숨김·원본 요약 칸을 뺀 모양으로 준다. 확정 판은 **판 번호로** 고정한다: 관문이 본 머리 판을
   * 항목과 같은 SQL 문장이 다시 확인하고(listFinal), 원본 확인까지 끝난 뒤 관문이 한 번 더 같은 판·같은 범위인지 본다.
   * "확정인가"만 두 번 물으면 reset → (W에서 항목 작성·읽기·숨김) → 재승인이 사이에 끼어도 둘 다 참이라 확정 전
   * 항목이 확정본으로 나간다. 판이 바뀌었으면 섞인 답 대신 409로 끝낸다. 혼합 역할은 이 길을 타지 않고 기존 응답을 받는다.
   */
  private async clinicianItems(uid: string, query: any, c: Caller) {
    const page = clinicianViewerQuery(query);
    if (!page) throw new BadRequestException('숨긴 표시 항목은 조회할 수 없습니다');
    const version = await this.pacs.clinicianViewerHead(uid, c);
    if (version === null) return clinicianViewerWithheld(uid);
    const result = await this.svc.listFinal(uid, page, c, version);
    if (!clinicianViewerPinned(version, result.finalVersion, await this.pacs.clinicianViewerHead(uid, c)))
      throw new ConflictException({ code: CLINICIAN_VIEWER_CHANGED, message: '판독 상태가 바뀌었습니다. 새로고침하세요.' });
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
