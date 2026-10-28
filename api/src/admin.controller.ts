import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminAccessReview } from './admin-access-review';
import { Caller, PacsService } from './pacs.service';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource } from './emr-runtime/request-context';
import type { AdminRequestFacts } from './admin.service';

const caller = (req: any): Caller => ({
  sub: req.sub,
  actor: req.actor,
  roles: req.roles ?? [],
  institution: req.institution ?? null,
  kind: req.kind ?? 'member',
});

/**
 * 관리자가 호출할 수 있는 Keycloak 동작을 아래 `users` 네 경로로만 고정한다.
 * manage-users 권한을 범용 URL 프록시로 노출하면 이 화이트리스트 자체가 사라진다.
 *
 * 접두어가 `admin`인 이유: S5-U6b 운영 지표 읽기(`metrics`)를 같은 컨트롤러에 두면 app.module 등록과
 * no-store 미들웨어를 그대로 쓴다. 회원 경로의 URL과 route key(`GET admin/users` 등)는 접두어와 핸들러
 * 경로를 이어 붙인 값이라 바뀌지 않는다.
 */
@Controller('admin')
export class AdminController {
  constructor(private admin: AdminService, private pacs: PacsService,
    @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource,
    private readonly accessReview: AdminAccessReview) {}

  private withRightsFacts<T>(req: any, task: (facts: AdminRequestFacts) => Promise<T>): Promise<T> {
    return this.requests.withWork(req, async request => {
      await request.requireCurrent();
      const facts = request.facts;
      try {
        return await task({ surface: facts.surface, actor: facts.actor,
          roles: facts.roles, rightsVersion: facts.rightsVersion, institution: facts.institution,
          ip: facts.ingress.status === 'known' ? facts.ingress.value.address : null,
          ipSource: 'trusted-proxy', sessionRef: facts.binding.sessionRef, requestId: facts.requestId, request });
      } finally {
        await request.requireCurrent();
      }
    });
  }

  @Get('users')
  list(@Query('page') page: string | undefined, @Req() req: any) {
    return this.admin.listUsers(page, caller(req));
  }

  @Post('users')
  async create(@Body() body: any, @Req() req: any) {
    return this.withRightsFacts(req, facts => this.admin.createUser(body, caller(req), facts));
  }

  @Patch('users/:id')
  async patch(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.withRightsFacts(req, facts => this.admin.patchUser(id, body, caller(req), facts));
  }

  @Post('users/:id/reset-password')
  @HttpCode(200)
  resetPassword(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.admin.resetPassword(id, body, caller(req));
  }

  /** S5-U6b 운영 지표. admin 역할·기관 범위·검사 접근 제한은 서비스(need·inst·visible)가 판정한다. */
  @Get('metrics')
  metrics(@Req() req: any) {
    return this.pacs.adminMetrics(caller(req));
  }

  /**
   * D1882 수신 보류 알림. 보낸 병원을 모르는 검사를 장비·기관명 원문·도착 시각·건수로만 묶는다(환자·검사 정보 없음).
   * 등록 두 경로는 병원과 확인한 장비(AE Title)·기관명 표기를 관리자 자기 기관에 등록하고, 그로써 정해진 보류 검사를
   * 붙인다. admin 역할·기관 판정은 서비스(need·inst)가 한다.
   */
  @Get('held-sources')
  heldSources(@Req() req: any) {
    return this.pacs.heldSources(caller(req));
  }

  @Post('source-devices')
  registerDevice(@Body() body: any, @Req() req: any) {
    return this.pacs.registerSourceDevice(body, caller(req));
  }

  @Post('institution-aliases')
  registerAlias(@Body() body: any, @Req() req: any) {
    return this.pacs.registerInstitutionAlias(body, caller(req));
  }

  /**
   * S5-U5b 감사·보안 기록. admin 역할, 행을 쓸 때 남은 기관으로 정하는 귀속, 쪽을 자르기 전의 거르기와 봉인한
   * 다음 쪽 값은 서비스(admin-audit.ts)가 판정한다. clinician-only는 guard 기본 거절이다.
   */
  @Get('audit')
  auditEvents(@Query() query: any, @Req() req: any) {
    if (query.report === 'access') return this.requests.withWork(req, request => this.accessReview.read(query, caller(req), request));
    return this.admin.auditEvents(query, caller(req));
  }
}
