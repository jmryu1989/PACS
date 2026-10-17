import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { StudyTransferLocalService } from './study-transfer-local.service';
import type { Caller } from './pacs/access';

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
  constructor(private readonly transfer: StudyTransferLocalService) {}

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
    return this.transfer.prepareDownload(uid, body, caller(req));
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
    return this.transfer.issueArchiveGrant(uid, operationId, body, req, caller(req));
  }

  /** The archive writes its own response: headers before the first byte, and only the writer ends it. */
  @Get('studies/:uid/original-downloads/:operationId/archive')
  archive(@Param('uid') uid: string, @Param('operationId') operationId: string, @Req() req: any, @Res() res: any) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return this.transfer.archive(uid, operationId, req, res, caller(req));
  }

  @Post('admin/dicom-import/:operationId/files/:index/recovery')
  @HttpCode(200)
  recover(@Param('operationId') operationId: string, @Param('index') index: string, @Body() body: unknown, @Req() req: any) {
    return this.transfer.recover(operationId, index, body, caller(req));
  }
}
