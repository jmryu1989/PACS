import { Body, Controller, Get, HttpCode, Param, Post, Req, UseFilters, Catch, ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ContractError } from '../emr-contract/validation';
import { EmrAuditService } from './service';

@Catch(ContractError)
class AuditContractFilter implements ExceptionFilter {
  catch(error: ContractError, host: ArgumentsHost) {
    const denied = ['AuditorNotDesignated','AuditScopeNotGranted','AuditorDesignationAuthorityRequired'];
    host.switchToHttp().getResponse().status(denied.includes(error.code) ? 403 : 409)
      .json({ code: error.code, message: '감사 권한과 요청 상태를 확인하세요' });
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
