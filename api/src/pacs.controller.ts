import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { PacsService, Caller } from './pacs.service';
import { AuthGuard, Public } from './auth.guard';

/**
 * 모든 엔드포인트가 Keycloak 토큰을 요구한다(@Public 제외).
 * 호출자가 누구인지·어느 기관인지는 헤더가 아니라 **서명된 토큰**에서 나온다.
 * 역할별 권한과 기관 경계는 서비스 계층에서 검사한다 — 화면이 아니라 서버가 방어선이다.
 */
const caller = (req: any): Caller => ({
  actor: req.actor,
  roles: req.roles ?? [],
  institution: req.institution ?? null,
});

@Controller()
@UseGuards(AuthGuard)
export class PacsController {
  constructor(private svc: PacsService) {}

  @Public()
  @Get('health')
  health() {
    return { ok: true, at: new Date().toISOString(), auth: process.env.AUTH_REQUIRED !== 'false' };
  }

  @Get('me')
  me(@Req() req: any) {
    return caller(req);
  }

  /**
   * 내 기관의 다른 판독의들 — Preliminary에서 상급 판독의를 고를 때 쓴다.
   * 목록은 Keycloak이 진실의 원천이다. 우리 DB에 복사본을 두지 않는다.
   */
  @Get('colleagues')
  colleagues(@Req() req: any) {
    return this.svc.colleagues(caller(req));
  }

  // ── 개인 설정: 필터·판독 상용구 ──
  // 계정에 붙는다. 브라우저가 아니라 — PC를 바꿔도 따라온다.

  @Get('prefs')
  prefs(@Req() req: any) {
    return this.svc.prefs(caller(req));
  }

  @Post('filters')
  saveFilter(@Body() body: any, @Req() req: any) {
    return this.svc.saveFilter(body, caller(req));
  }

  /** 기본 필터 지정/해제 — 로그인하면 자동으로 걸리는 그 필터 */
  @Patch('filters/:id/default')
  setDefaultFilter(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.svc.setDefaultFilter(+id, body?.on !== false, caller(req));
  }

  @Delete('filters/:id')
  deleteFilter(@Param('id') id: string, @Req() req: any) {
    return this.svc.deleteFilter(+id, caller(req));
  }

  @Post('templates')
  saveTemplate(@Body() body: any, @Req() req: any) {
    return this.svc.saveTemplate(body, caller(req));
  }

  @Delete('templates/:id')
  deleteTemplate(@Param('id') id: string, @Req() req: any) {
    return this.svc.deleteTemplate(+id, caller(req));
  }

  @Get('bootstrap')
  bootstrap(@Req() req: any) {
    return this.svc.bootstrap(caller(req));
  }

  /**
   * 검사 목록. 서버가 Orthanc QIDO-RS를 대신 부르고 기관으로 걸러 내려준다.
   * 브라우저는 더 이상 /dicom-web/studies 를 직접 부르지 않는다.
   */
  @Get('studies')
  studies(@Req() req: any) {
    return this.svc.listStudies(caller(req));
  }

  @Patch('studies/:uid')
  patch(@Param('uid') uid: string, @Body() body: any, @Req() req: any) {
    return this.svc.patchState(uid, body, caller(req));
  }

  /** 초안 저장 — 내 것에만 쓴다. 판(version)도 안 올리고 확정본도 안 건드린다 */
  @Put('studies/:uid/report')
  report(@Param('uid') uid: string, @Body() body: any, @Req() req: any) {
    return this.svc.putReport(uid, body, caller(req));
  }

  /** 초안 버리기 — 확정본으로 돌아간다. 내 초안만 지운다 */
  @Delete('studies/:uid/draft')
  discardDraft(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.discardDraft(uid, caller(req));
  }

  /** 확정 — save / approve / addendum / reset / preliminary. 내용·버전·RS를 한 트랜잭션으로 */
  @Post('studies/:uid/report/commit')
  commit(@Param('uid') uid: string, @Body() body: any, @Req() req: any) {
    return this.svc.commitReport(uid, body, caller(req));
  }

  /** 판독문 이력 */
  @Get('studies/:uid/report/versions')
  versions(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.versions(uid, caller(req));
  }

  /** 점유 선언 / 하트비트 — 판독문을 쓰기 시작했을 때 */
  @Post('studies/:uid/hold')
  hold(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.hold(uid, caller(req));
  }

  /** 점유 해제 — 검사를 옮길 때 (확정 시에는 자동으로 풀린다) */
  @Post('studies/:uid/release')
  release(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.release(uid, caller(req));
  }

  @Delete('studies/:uid')
  remove(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.removeState(uid, caller(req));
  }

  @Post('match')
  match(@Body() body: any, @Req() req: any) {
    return this.svc.match(body.uid, body.oid, body.patient, caller(req));
  }

  @Post('unmatch')
  unmatch(@Body() body: any, @Req() req: any) {
    return this.svc.unmatch(body.uid, caller(req));
  }

  @Get('audit')
  audit(@Req() req: any, @Query('uid') uid?: string, @Query('take') take?: string) {
    return this.svc.audits(uid, take ? +take : 100, caller(req));
  }
}
