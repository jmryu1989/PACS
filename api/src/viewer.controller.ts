import { BadRequestException, ConflictException, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Caller, PacsService } from './pacs.service';
import { ViewerService } from './viewer.service';
import { CLINICIAN_VIEWER_CHANGED, clinicianOnly, clinicianViewerContinuation, clinicianViewerContinues, clinicianViewerPage,
  clinicianViewerPinned, clinicianViewerQuery, clinicianViewerWithheld } from './clinician-policy';

const caller = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });

// S5-U1b-F04 이어받기 서명 키. study-page.ts처럼 프로세스 안에서만 만들어 설정할 비밀이 없고, 재시작하면 열린 이어받기는
// 409(처음부터 다시)로 끝난다. 서명이 지키는 것은 "이 판은 서버가 앞 쪽에서 확인한 값"이라는 것뿐이다 — 권한은 매 쪽 관문이 본다.
const VIEWER_CURSOR_KEY = randomBytes(32);
const changed = (message = '판독 상태가 바뀌었습니다. 새로고침하세요.') =>
  new ConflictException({ code: CLINICIAN_VIEWER_CHANGED, message });

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
   *
   * 판 고정은 요청 하나로 끝나지 않는다(S5-U1b-F04). 다음 쪽은 앞 쪽이 서명해 준 이어받기 값의 판에서만 읽고, 관문이 본
   * 머리 판이 그 판이 아니면(재승인·addendum·reset) 409다 — 항목 id만으로 이으면 앞 쪽은 옛 판, 다음 쪽은 새 판인 연쇄가 된다.
   * 판을 확인할 수 없는 이어받기 값(판독의 경로의 항목 id, 바뀐 서명, 다른 검사)도 지금 판에서 잇지 않고 409로 돌려보낸다.
   */
  private async clinicianItems(uid: string, query: any, c: Caller) {
    const page = clinicianViewerQuery(query);
    if (!page) throw new BadRequestException('숨긴 표시 항목이나 형식이 잘못된 이어받기 값으로는 조회할 수 없습니다');
    const { cursor, ...rest } = page;
    const continued = cursor === undefined ? null : clinicianViewerContinuation(VIEWER_CURSOR_KEY, uid, cursor);
    if (cursor !== undefined && !continued) throw changed('이어받기 값을 확인할 수 없습니다. 처음부터 다시 불러오세요.');
    const version = await this.pacs.clinicianViewerHead(uid, c);
    if (!clinicianViewerContinues(continued?.version ?? null, version)) throw changed();
    if (version === null) return clinicianViewerWithheld(uid);
    const result = await this.svc.listFinal(uid, continued ? { ...rest, cursor: continued.after } : rest, c, version);
    if (!clinicianViewerPinned(version, result.finalVersion, await this.pacs.clinicianViewerHead(uid, c))) throw changed();
    return clinicianViewerPage(uid, version, result, VIEWER_CURSOR_KEY);
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
