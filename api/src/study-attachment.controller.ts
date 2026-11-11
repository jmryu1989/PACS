import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { StudyAttachmentService } from './study-attachment.service';
import type { Caller } from './pacs/access';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource, RequestContextUnavailable, RequestWorkContext } from './emr-runtime/request-context';

/** The caller comes from the global guard's verified token and rights only (sub, actor, roles, institution, kind). */
function caller(req: any): Caller {
  return { sub: req.sub, actor: req.actor, roles: req.roles ?? [], institution: req.institution ?? null, kind: req.kind ?? 'member' };
}

/**
 * FC-076 Attach Document: attach a scanned document or PC picture to a study (one raw file per request; the body parser
 * is study-attachment-parser.ts), the study's attached documents, and withdraw one. A feature controller of its own so
 * the PACS facade and its route snapshot stay as they are. Clinician-only callers are refused by the guard's default.
 */
@Controller()
export class StudyAttachmentController {
  constructor(private readonly attachments: StudyAttachmentService,
    @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource) {}

  private async withWork<T>(req: any, task: (request: RequestWorkContext) => Promise<T>): Promise<T> {
    try { return await this.requests.withWork(req, task); }
    catch (failure) {
      if (failure instanceof HttpException || failure instanceof RequestContextUnavailable) throw failure;
      throw new ServiceUnavailableException('문서 기록을 남기지 못했습니다. 잠시 뒤 다시 시도하세요');
    }
  }

  @Post('studies/:uid/attachments')
  @HttpCode(201)
  add(@Param('uid') uid: string, @Req() req: any) {
    return this.withWork(req, request => this.attachments.add(uid, req, caller(req), request));
  }

  @Get('studies/:uid/attachments')
  list(@Param('uid') uid: string, @Req() req: any) {
    return this.attachments.list(uid, caller(req));
  }

  @Post('studies/:uid/attachments/:id/withdraw')
  @HttpCode(200)
  withdraw(@Param('uid') uid: string, @Param('id') id: string, @Body() body: unknown, @Req() req: any) {
    return this.withWork(req, request => this.attachments.withdraw(uid, id, body, caller(req), request));
  }
}
