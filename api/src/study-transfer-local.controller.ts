import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { StudyTransferLocalService, TRANSFER_MESSAGES } from './study-transfer-local.service';
import type { Caller } from './pacs/access';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource, RequestContextUnavailable, RequestWorkContext } from './emr-runtime/request-context';

/** The caller comes from the global guard's verified token and rights only (sub, actor, roles, institution, kind). */
function caller(req: any): Caller {
  return { sub: req.sub, actor: req.actor, roles: req.roles ?? [], institution: req.institution ?? null, kind: req.kind ?? 'member' };
}

/**
 * S9-U4b self-institution DICOM import and original download (contract S9-U4p 6): five member routes and the own-institution
 * admin's recovery confirmation. A feature controller of its own so the PACS facade and its route snapshot stay as they are.
 */
@Controller()
export class StudyTransferLocalController {
  constructor(private readonly transfer: StudyTransferLocalService,
    @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource) {}

  private async withDownload<T>(req: any, task: (request: RequestWorkContext) => Promise<T>): Promise<T> {
    try { return await this.requests.withWork(req, task); }
    catch (failure) {
      if (failure instanceof HttpException || failure instanceof RequestContextUnavailable) throw failure;
      throw new ServiceUnavailableException({ code: 'IMPORT_STORAGE_UNAVAILABLE', message: TRANSFER_MESSAGES.storage });
    }
  }

  /** One application/dicom object per request; the HTTP status is the file result's own (contract 4.8). */
  @Post('dicom-import')
  async importFile(@Req() req: any, @Res({ passthrough: true }) res: any) {
    const answer = await this.transfer.importFile(req, caller(req));
    res.status(answer.status);
    return answer.body;
  }

  @Get('dicom-import/:operationId')
  importStatus(@Param('operationId') operationId: string, @Req() req: any) {
    return this.transfer.importStatus(operationId, caller(req));
  }

  @Post('studies/:uid/original-downloads')
  @HttpCode(200)
  prepareDownload(@Param('uid') uid: string, @Body() body: unknown, @Req() req: any) {
    return this.withDownload(req, request => this.transfer.prepareDownload(uid, body, caller(req), request));
  }

  @Get('studies/:uid/original-downloads/:operationId')
  downloadStatus(@Param('uid') uid: string, @Param('operationId') operationId: string, @Req() req: any) {
    return this.transfer.downloadStatus(uid, operationId, caller(req));
  }

  /**
   * D1489: the one-time grant the browser's own archive GET carries instead of the session binding header. Issued only to
   * a bound cookie session; the answer is never stored by the browser or sent on as a referrer.
   */
  @Post('studies/:uid/original-downloads/:operationId/archive/grant')
  @HttpCode(200)
  archiveGrant(@Param('uid') uid: string, @Param('operationId') operationId: string, @Body() body: unknown, @Req() req: any,
    @Res({ passthrough: true }) res: any) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return this.withDownload(req, request => this.transfer.issueArchiveGrant(uid, operationId, body, req, caller(req), request));
  }

  /** The archive writes its own response: headers before the first byte, and only the writer ends it. */
  @Get('studies/:uid/original-downloads/:operationId/archive')
  archive(@Param('uid') uid: string, @Param('operationId') operationId: string, @Req() req: any, @Res() res: any) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return this.withDownload(req, request => this.transfer.archive(uid, operationId, req, res, caller(req), request))
      .catch(failure => {
        // The writer ends the response before its retained work settles the result.
        if (failure instanceof RequestContextUnavailable && (res.writableEnded || res.destroyed)) return;
        throw failure;
      });
  }

  @Post('admin/dicom-import/:operationId/files/:index/recovery')
  @HttpCode(200)
  recover(@Param('operationId') operationId: string, @Param('index') index: string, @Body() body: unknown, @Req() req: any) {
    return this.transfer.recover(operationId, index, body, caller(req));
  }
}
