import { ForbiddenException, BadRequestException, ConflictException, Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { PacsService, Caller } from './pacs.service';
import { Public } from './auth.guard';

/**
 * URL의 `:id`를 정수로. **`+id`를 그대로 쓰면 안 된다.**
 *
 * `+"abc"`는 `NaN`이고, Prisma는 `where: { id: NaN }`을 받으면 쿼리를 만들다
 * 터져서 **500**을 낸다. 잘못된 요청(400)이 서버 오류(500)로 보이면,
 * 로그를 보는 사람은 서버가 고장난 줄 알고 엉뚱한 데를 파게 된다.
 * 경계에서 걸러야 안쪽이 깨끗하다.
 */
function noteCaller(req: any): Caller {
  for (const [header, actual] of [['x-kin-subject', req.sub], ['x-kin-institution', req.institution]]) {
    if (req.headers[header] !== undefined && req.headers[header] !== actual) throw new ForbiddenException('메모 계정이 변경되었습니다');
  }
  return caller(req);
}

function numId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new BadRequestException(`잘못된 id입니다: ${raw}`);
  return n;
}

/**
 * 모든 엔드포인트가 Keycloak 토큰을 요구한다(@Public 제외).
 * 호출자가 누구인지·어느 기관인지는 헤더가 아니라 **서명된 토큰**에서 나온다.
 * 역할별 권한과 기관 경계는 서비스 계층에서 검사한다 — 화면이 아니라 서버가 방어선이다.
 */
const caller = (req: any): Caller => ({
  sub: req.sub,
  actor: req.actor,
  roles: req.roles ?? [],
  institution: req.institution ?? null,
  kind: req.kind ?? 'member',
});

/**
 * 초안 쓰기 순서(S7-U5, Astra S7-U5-R-001-F03)가 기억하는 범위.
 *
 * 한 문서의 순번을 기억해야 하는 시간은 그 문서가 앞서 보낸 쓰기가 네트워크·앞단 프록시에 남았다가 뒤늦게 닿을 수 있는
 * 동안이다(프록시 제한 시간이 분 단위) — 넉넉히 한 시간을 둔다. 문서 ID는 요청이 정하는 값이라 한 초안 행이 기억하는 문서
 * 수와 ID 길이에도 한도를 둔다. 한도가 없으면 한 계정이 이 표를 끝없이 키울 수 있다.
 */
const DRAFT_ORDER_KEEP_MS = 60 * 60 * 1000;
const DRAFT_ORDER_SWEEP_MS = 60 * 1000;
const DRAFT_ORDER_PAGES = 32;
const DRAFT_ORDER_PAGE_ID = 64;

type DraftOrder = [page: string, seq: number];

interface DraftLine {
  /** 이 초안 행의 마지막 쓰기가 끝나면 풀린다. 다음 쓰기는 이것을 기다린 뒤에 들어간다. */
  tail: Promise<void>;
  /** 줄에 선 쓰기 수(처리 중 포함). 0이 아니면 줄을 지우지 않는다. */
  busy: number;
  /** 문서 ID → 그 문서의 쓰기 중 마지막으로 저장된 순번과 저장 시각. 오래 저장하지 않은 문서가 앞에 온다. */
  pages: Map<string, { seq: number; at: number }>;
}

@Controller()
export class PacsController {
  constructor(private svc: PacsService) {}

  /** 초안 행(검사·작성자)마다의 쓰기 줄. 이 프로세스의 메모리에만 있다 — 아래 `draftWrite`의 한계를 본다. */
  private readonly draftLines = new Map<string, DraftLine>();
  private draftLinesSweptAt = 0;

  @Public()
  @Get('health')
  health() {
    return { ok: true, at: new Date().toISOString(), auth: process.env.AUTH_REQUIRED !== 'false' };
  }

  @Get('me')
  me(@Req() req: any) {
    return { ...caller(req), user: req.actor, displayName: req.displayName ?? req.actor };
  }

  /** nginx auth_request 전용. 204=통과, 403=기관 경계 밖. PHI 본문은 싣지 않는다. */
  @Get('authz/dicom')
  @HttpCode(204)
  authzDicom(@Req() req: any) {
    return this.svc.authzDicom(
      String(req.headers['x-original-uri'] ?? ''),
      String(req.headers['x-original-method'] ?? req.method ?? ''),
      caller(req),
    );
  }

  /** Gateway가 바이트를 보내기 전에 자격증명의 기관으로 Study 소유권을 고정한다. */
  @Post('gateway/announce')
  @HttpCode(200)
  announce(@Body() body: any, @Req() req: any) {
    return this.svc.announceStudy(body?.studyUid, body?.institutionNameTag, caller(req));
  }

  /** S4-U3 전송 영수증. 본문 전체가 닫힌 키 집합 검사를 받는다 — 기관·시각은 본문에서 받지 않는다. */
  @Post('gateway/receipt')
  @HttpCode(200)
  gatewayReceipt(@Body() body: any, @Req() req: any) {
    return this.svc.gatewayReceipt(body, caller(req));
  }

  /** S4-U4 Gateway 전용: 이 epoch에 대기 중인 Now Retry 요청의 studyUid 목록만. 쿼리는 epoch 하나다. */
  @Get('gateway/retry-requests')
  @Header('Cache-Control', 'no-store')
  gatewayRetryRequests(@Query() query: any, @Req() req: any) {
    return this.svc.gatewayRetryRequests(query, caller(req));
  }

  @Post('dicom/lookup')
  @HttpCode(200)
  dicomLookup(@Body() body: any, @Req() req: any) {
    return this.svc.dicomLookup(body?.studyUid, body?.sopUid, caller(req));
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

  @Get('workspace-layout')
  workspaceLayout(@Req() req: any) {
    return this.svc.workspaceLayout(caller(req));
  }

  @Get('reading-preferences')
  readingPreferences(@Req() req: any) { return this.svc.readingPreferences(caller(req)); }

  @Put('reading-preferences')
  saveReadingPreferences(@Body() body: any, @Req() req: any) { return this.svc.saveReadingPreferences(body, caller(req)); }

  @Get('hanging-protocols')
  hangingProtocols(@Req() req: any) { return this.svc.hangingProtocols(caller(req)); }

  @Put('hanging-protocols')
  saveHangingProtocols(@Body() body: any, @Req() req: any) { return this.svc.saveHangingProtocols(body, caller(req)); }

  // 기관 공용 Hanging Protocol. 소속 회원은 읽고, 저장은 admin 전용 — 서버에서 막는다.
  @Get('hanging-protocols/site')
  siteHangingProtocols(@Req() req: any) { return this.svc.siteHangingProtocols(caller(req)); }

  @Put('hanging-protocols/site')
  saveSiteHangingProtocols(@Body() body: any, @Req() req: any) { return this.svc.saveSiteHangingProtocols(body, caller(req)); }

  @Get('workspace-shortcuts')
  workspaceShortcuts(@Req() req: any) { return this.svc.workspaceShortcuts(caller(req)); }

  @Put('workspace-shortcuts')
  saveWorkspaceShortcuts(@Body() body: any, @Req() req: any) { return this.svc.saveWorkspaceShortcuts(body, caller(req)); }

  @Get('reading-appearance')
  readingAppearance(@Req() req: any) { return this.svc.readingAppearance(caller(req)); }

  @Put('reading-appearance')
  saveReadingAppearance(@Body() body: any, @Req() req: any) { return this.svc.saveReadingAppearance(body, caller(req)); }

  @Put('workspace-layout')
  saveWorkspaceLayout(@Body() body: any, @Req() req: any) {
    return this.svc.writeWorkspaceLayout(body, caller(req), false);
  }

  @Delete('workspace-layout')
  clearWorkspaceLayout(@Body() body: any, @Req() req: any) {
    return this.svc.writeWorkspaceLayout(body, caller(req), true);
  }

  @Get('worklist-columns')
  worklistColumns(@Req() req: any) { return this.svc.worklistColumns(caller(req)); }

  @Put('worklist-columns')
  saveWorklistColumns(@Body() body: any, @Req() req: any) { return this.svc.writeWorklistColumns(body, caller(req), false); }

  @Delete('worklist-columns')
  clearWorklistColumns(@Body() body: any, @Req() req: any) { return this.svc.writeWorklistColumns(body, caller(req), true); }

  @Post('filters')
  saveFilter(@Body() body: any, @Req() req: any) {
    return this.svc.saveFilter(body, caller(req));
  }

  @Get('filter-folders')
  readFilterFolders(@Req() req: any) { return this.svc.readFilterFolders(caller(req)); }

  @Post('filter-folders')
  writeFilterFolders(@Body() body: any, @Req() req: any) { return this.svc.writeFilterFolders(body, caller(req)); }

  @Get('shared-filters')
  readSharedFilters(@Req() req: any) { return this.svc.readSharedFilters(caller(req)); }

  @Post('shared-filters')
  writeSharedFilters(@Body() body: any, @Req() req: any) { return this.svc.writeSharedFilters(body, caller(req)); }

  @Post('shared-filters/copy')
  copySharedFilters(@Body() body: any, @Req() req: any) { return this.svc.copySharedFilters(body, caller(req)); }

  /** 기본 필터 지정/해제 — 로그인하면 자동으로 걸리는 그 필터 */
  @Patch('filters/:id/default')
  setDefaultFilter(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.svc.setDefaultFilter(numId(id), body?.on !== false, caller(req));
  }

  @Delete('filters/:id')
  deleteFilter(@Param('id') id: string, @Req() req: any) {
    return this.svc.deleteFilter(numId(id), caller(req));
  }

  @Post('templates')
  saveTemplate(@Body() body: any, @Req() req: any) {
    return this.svc.saveTemplate(body, caller(req));
  }

  @Delete('templates/:id')
  deleteTemplate(@Param('id') id: string, @Req() req: any) {
    return this.svc.deleteTemplate(numId(id), caller(req));
  }

  @Get('bootstrap')
  @Header('Cache-Control', 'no-store')
  bootstrap(@Req() req: any, @Query() query: any) {
    return this.svc.bootstrap(caller(req), query);
  }

  /**
   * 검사 목록. 서버가 Orthanc QIDO-RS를 대신 부르고 기관으로 걸러 내려준다.
   * 브라우저는 더 이상 /dicom-web/studies 를 직접 부르지 않는다.
   */
  @Get('studies')
  @Header('Cache-Control', 'no-store')
  studies(@Req() req: any, @Query() query: any) {
    return this.svc.listStudies(caller(req), query);
  }

  /** 기관을 못 알아본 검사 — 관리자 전용 통로. 워크리스트에는 안 섞인다 */
  @Get('unassigned')
  unassigned(@Req() req: any) {
    return this.svc.unassigned(caller(req));
  }

  /** 미배정 검사를 기관에 배정 (고아를 집에 보내는 것만 한다 — 기관 이동은 아니다) */
  @Post('studies/:uid/assign')
  assign(@Param('uid') uid: string, @Body() body: any, @Req() req: any) {
    return this.svc.assignInstitution(uid, String(body?.institutionId ?? ''), caller(req));
  }

  /** S4-U4 Now Retry 요청. 본문은 비어 있어야 하고 묶을 영수증은 서버가 정한다. 200은 "저장됨"이지 "재시도됨"이 아니다. */
  @Post('studies/:uid/gateway-retry')
  @HttpCode(200)
  requestGatewayRetry(@Param('uid') uid: string, @Body() body: any, @Req() req: any) {
    return this.svc.requestGatewayRetry(uid, body, caller(req));
  }

  @Patch('studies/:uid')
  patch(@Param('uid') uid: string, @Body() body: any, @Req() req: any) {
    return this.svc.patchState(uid, body, caller(req));
  }

  @Get('studies/:uid/tech-note')
  techNote(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.techNote(uid, noteCaller(req));
  }

  @Post('studies/:uid/tech-note')
  saveTechNote(@Param('uid') uid: string, @Body() body: any, @Req() req: any) {
    return this.svc.saveTechNote(uid, body, noteCaller(req));
  }

  @Get('studies/:uid/tech-note/history')
  techNoteHistory(@Param('uid') uid: string, @Query('before') before: string, @Req() req: any) {
    return this.svc.techNote(uid, noteCaller(req), before ?? '2147483647');
  }

  /** 초안 저장 — 내 것에만 쓴다. 판(version)도 안 올리고 확정본도 안 건드린다 */
  @Put('studies/:uid/report')
  report(@Param('uid') uid: string, @Body() body: any, @Req() req: any) {
    const c = caller(req);
    /**
     * S7-U5 작성자 결속. `expectedOwner`([기관, 사용자 ID, 작성자])는 화면이 이 판독문을 받아 둔 계정이다. 쿠키의 계정이
     * 그사이 바뀌었으면(다른 탭의 계정 전환, 복구 직전 확인 뒤의 교체) 받아 둔 글을 지금 계정의 초안으로 만들거나 덮거나
     * 지우지 않는다 — `putReport`에 넘기기 전에 거절하므로 검사·초안 행을 읽거나 쓰거나 감사를 남기는 일이 하나도 없다.
     * 값은 대조에만 쓰고 권한과 작성자는 언제나 인증된 호출자에서 정한다. 칸이 없는 요청(삽입·구조화·기준 다시 잡기·API
     * 클라이언트)은 예전처럼 호출자의 행에 쓴다. 이 PUT 밖에서 `putReport`를 부르는 곳이 생기면 그곳도 이 대조를 거쳐야 한다.
     */
    if (body?.expectedOwner !== undefined) {
      const owner = body.expectedOwner;
      if (!Array.isArray(owner) || owner.length !== 3 || (owner[0] !== null && typeof owner[0] !== 'string')
          || typeof owner[1] !== 'string' || typeof owner[2] !== 'string')
        throw new BadRequestException('expectedOwner는 [기관, 사용자 ID, 작성자] 형식이어야 합니다');
      if (JSON.stringify(owner) !== JSON.stringify([c.institution ?? null, c.sub, c.actor]))
        throw new ConflictException({ code: 'REPORT_DRAFT_OWNER_CHANGED',
          message: '판독문 초안을 쓰던 계정이 아닙니다. 그 계정으로 다시 로그인한 뒤 저장하세요.' });
    }
    /**
     * S7-U5 쓰기 순서. `draftOrder`([문서 ID, 순번])는 화면(문서)이 자기 초안 쓰기에 매긴 순서다 — 아래 `draftWrite`가
     * 그 문서가 이미 저장한 순번 이하의 쓰기를 `putReport`에 넘기기 전에 거절한다. 모양이 틀리면 아무것도 읽기 전에 400이다.
     * 칸이 없는 요청(이 칸을 모르는 열린 화면, 삽입·구조화·기준 다시 잡기, API 클라이언트)은 예전처럼 저장한다: 같은 줄에서
     * 차례는 지키지만 순서로 거절하지 않고, 기억된 순번을 바꾸지 않으며, 답에 `draftOrder`가 없다.
     */
    const order = body?.draftOrder;
    if (order !== undefined && (!Array.isArray(order) || order.length !== 2 || typeof order[0] !== 'string' || !order[0]
        || order[0].length > DRAFT_ORDER_PAGE_ID || !Number.isSafeInteger(order[1]) || order[1] < 1))
      throw new BadRequestException('draftOrder는 [문서 ID, 1 이상의 순번] 형식이어야 합니다');
    return this.draftWrite(uid, c, order === undefined ? null : [order[0], order[1]], () => this.svc.putReport(uid, body, c));
  }

  /**
   * 한 초안 행(검사·작성자)의 쓰기를 처리기에 닿은 차례대로 하나씩 `putReport`에 넘기고, 순서를 실은 쓰기는 같은 문서가
   * 이미 저장한 순번 이하이면 넘기지 않는다(Astra S7-U5-R-001-F03).
   *
   * 피하는 실패: 브라우저의 연결이 끊겨 답을 받지 못한 앞선 초안 쓰기가 서버에서 늦게 끝나거나 뒤늦게 닿아, 그 뒤에 저장한
   * 글(로그아웃 준비의 저장, 세션 종료 뒤의 Recover Draft)을 옛 글로 덮는다. `putReport`의 upsert는 요청 순서를 보지 않는다.
   *  - 처리 중인 앞선 쓰기: 뒤 쓰기는 그것이 끝난 뒤에 들어가므로 어느 쪽이 먼저 끝나든 나중에 보낸 글이 남는다. 순번은
   *    초안 행에 저장되지 않아 검사와 저장을 한 트랜잭션에 넣을 수 없으므로, 줄이 그 둘을 한 덩어리로 만든다.
   *  - 뒤늦게 닿은 앞선 쓰기: 같은 문서가 저장한 순번 이하라 409 `REPORT_DRAFT_SUPERSEDED`로 거절한다. 거절은 `putReport`
   *    전이라 검사·초안 행을 읽거나 쓰거나 감사를 남기지 않는다.
   * 순번은 **저장된** 쓰기만 기억한다 — 거절되거나 실패한 쓰기는 아무것도 남기지 않는다. 순서를 확인한 저장은 답에 같은
   * `draftOrder`를 돌려준다: 화면은 그 답을 받았을 때만 앞선 쓰기가 이 글을 덮지 못한다고 본다.
   *
   * 한계: 줄과 순번은 이 API 프로세스의 메모리에 있다. 재시작하면 잊고(그때 처리 중이던 쓰기도 함께 끝난다), API를 여러
   * 프로세스로 띄우면 프로세스끼리는 순서를 모른다 — 그 구성은 순번을 초안 행과 함께 저장하는 migration이 먼저다. 서로
   * 다른 문서(같은 계정의 다른 탭)의 쓰기 사이에는 예전처럼 순서가 없다.
   */
  private async draftWrite<T extends object>(uid: string, c: Caller, order: DraftOrder | null, write: () => Promise<T>) {
    this.sweepDraftLines(Date.now());
    const key = JSON.stringify([uid, c.actor]);
    let line = this.draftLines.get(key);
    if (!line) this.draftLines.set(key, line = { tail: Promise.resolve(), busy: 0, pages: new Map() });
    const before = line.tail;
    let finish!: () => void;
    line.tail = new Promise<void>(resolve => { finish = resolve; });
    line.busy++;
    try {
      await before;
      if (!order) return await write();
      const last = line.pages.get(order[0]);
      if (last && order[1] <= last.seq)
        throw new ConflictException({ code: 'REPORT_DRAFT_SUPERSEDED',
          message: '같은 화면에서 더 나중에 보낸 판독문 초안이 이미 저장되어, 앞서 보낸 이 저장은 반영하지 않았습니다.' });
      const saved = await write();
      // 다시 넣어 가장 최근에 저장한 문서가 맨 뒤에 오게 한다. 한도를 넘으면 가장 오래 저장하지 않은 문서부터 잊는다.
      line.pages.delete(order[0]);
      line.pages.set(order[0], { seq: order[1], at: Date.now() });
      if (line.pages.size > DRAFT_ORDER_PAGES) {
        const oldest = line.pages.keys().next();
        if (!oldest.done) line.pages.delete(oldest.value);
      }
      return { ...saved, draftOrder: [order[0], order[1]] };
    } finally {
      line.busy--;
      finish();
      if (!line.busy && !line.pages.size) this.draftLines.delete(key);
    }
  }

  /** 기억한 지 오래된 순번을 지운다(메모리 한도일 뿐 규칙이 아니다). 쓰기가 올 때 드물게 돌고, 처리 중인 줄은 남긴다. */
  private sweepDraftLines(now: number) {
    if (now - this.draftLinesSweptAt < DRAFT_ORDER_SWEEP_MS) return;
    this.draftLinesSweptAt = now;
    for (const [key, line] of this.draftLines) {
      for (const [page, kept] of line.pages) if (now - kept.at > DRAFT_ORDER_KEEP_MS) line.pages.delete(page);
      if (!line.busy && !line.pages.size) this.draftLines.delete(key);
    }
  }

  /** 초안 버리기 — 확정본으로 돌아간다. 내 초안만 지운다 */
  @Delete('studies/:uid/draft')
  discardDraft(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.discardDraft(uid, caller(req));
  }

  /** 관리자 강제 해제 — 모든 초안을 폐기 이력으로 보존한 뒤 지운다 */
  @Delete('studies/:uid/draft/force')
  forceDiscardDrafts(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.forceDiscardDrafts(uid, caller(req));
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

  /** 인용 — 머리 판과 내 초안의 증언. 소견 가독을 여기서 다시 건다 */
  @Get('studies/:uid/report/citations')
  citations(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.reportCitations(uid, caller(req));
  }

  /** 과거 판의 인용 — 보존된 그 한 행의 증언만. 머리 읽기의 의미를 넓히지 않는다 */
  @Get('studies/:uid/report/versions/:version/citations')
  versionCitations(@Param('uid') uid: string, @Param('version') version: string, @Req() req: any) {
    return this.svc.reportVersionCitations(uid, version, caller(req));
  }

  /** 구조화 항목 — 머리 판과 내 초안의 타입 있는 값. 관문은 `versions()`와 같다 */
  @Get('studies/:uid/report/structure')
  structure(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.reportStructure(uid, caller(req));
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

  @Post('studies/:uid/release/force')
  @HttpCode(200)
  forceRelease(@Param('uid') uid: string, @Req() req: any) {
    return this.svc.forceRelease(uid, caller(req));
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
    let n = 100;
    if (take !== undefined) {
      n = Number(take);
      if (!Number.isInteger(n) || n < 1 || n > 500)
        throw new BadRequestException(`잘못된 take입니다: ${take} (1~500 정수)`);
    }
    return this.svc.audits(uid, n, caller(req));
  }
}
