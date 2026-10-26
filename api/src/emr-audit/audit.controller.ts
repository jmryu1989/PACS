import { Body, Controller, Get, HttpCode, Param, Post, Req, UseFilters, Catch, ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ContractError } from '../emr-contract/validation';
import { EmrAuditService } from './service';

@Catch(ContractError)
class AuditContractFilter implements ExceptionFilter {
  catch(error: ContractError, host: ArgumentsHost) {
    const denied = ['AuditorNotDesignated','AuditScopeNotGranted','AuditorDesignationAuthorityRequired'];
    const status = denied.includes(error.code) ? 403 :
      ['IssuanceNotFound','RequestNotFound'].includes(error.code) ? 404 :
      ['AuditRequestInvalid','InvestigationQueryRefused','DisclosureRequestRefused','AuditIdentityUnknown'].includes(error.code) ? 400 :
      error.code === 'InvestigationTimedOut' ? 503 : 409;
    const message = error.code === 'InvestigationTimedOut' ? '조회 시간이 초과되었습니다. 기간이나 조회 조건을 좁혀 다시 시도하세요.' :
      error.code === 'AuditIdentityUnknown' ? '등록된 계정이 없습니다. issuer와 subject를 확인하고 대상자가 한 번 로그인한 뒤 다시 지정하세요.' :
      '감사 권한과 요청 상태를 확인하세요';
    host.switchToHttp().getResponse().status(status)
      .json({ code: error.code, message });
  }
}

@Controller('emr-audit')
@UseFilters(AuditContractFilter)
export class EmrAuditController {
  constructor(private readonly audit: EmrAuditService) {}
  @Post('roster/:grantId') @HttpCode(200)
  roster(@Req() req: any, @Param('grantId') id: string, @Body() body: unknown) { return this.audit.changeRoster(req, id, body); }
  @Post('investigations') @HttpCode(200)
  investigate(@Req() req: any, @Body() body: unknown) { return this.audit.investigate(req, body); }
  @Post('exports') @HttpCode(200)
  export(@Req() req: any, @Body() body: unknown) { return this.audit.investigate(req, body, 'export'); }
  @Post('requests') @HttpCode(200)
  register(@Req() req: any, @Body() body: unknown) { return this.audit.register(req, body); }
  @Post('issuances') @HttpCode(200)
  prepare(@Req() req: any, @Body() body: unknown) { return this.audit.prepare(req, body); }
  @Post('issuances/:id/issue') @HttpCode(200)
  issue(@Req() req: any, @Param('id') id: string) { return this.audit.issue(req, id); }
  @Post('issuances/:id/delivery') @HttpCode(200)
  delivery(@Req() req: any, @Param('id') id: string, @Body() body: unknown) { return this.audit.delivery(req, id, body); }
  @Get('requests/:id')
  state(@Req() req: any, @Param('id') id: string) { return this.audit.requestState(req, id); }
  @Post('requests/:id/extend') @HttpCode(200)
  extend(@Req() req: any, @Param('id') id: string, @Body() body: unknown) { return this.audit.extend(req, id, body); }
  @Post('requests/:id/resolve') @HttpCode(200)
  resolve(@Req() req: any, @Param('id') id: string, @Body() body: unknown) { return this.audit.resolve(req, id, body); }
}
