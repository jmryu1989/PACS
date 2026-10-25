import { Body, Controller, Get, Head, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { OnlineImageService } from './emr-image/service';
import { ConnectService } from './connect.service';
import { Caller } from './pacs.service';

const caller = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [], institution: req.institution ?? null, kind: req.kind ?? 'member' });

@Controller()
export class ConnectController {
  constructor(private svc: ConnectService, private images: OnlineImageService) {}
  @Get('images/dicom-web')
  image(@Query('target') target: string, @Req() req: any, @Res() res: any) { return this.images.send(req, res, target); }
  @Head('images/dicom-web')
  imageHead(@Query('target') target: string, @Req() req: any, @Res() res: any) { return this.images.send(req, res, target); }
  @Get('admin/agreements')
  agreements(@Query() q: any, @Req() r: any) { return this.svc.listAgreements(q, caller(r)); }
  @Post('admin/agreements')
  recordAgreement(@Body() b: any, @Req() r: any) { return this.svc.recordAgreement(b, caller(r)); }
  @Patch('admin/agreements/:id')
  terminate(@Param('id') id: string, @Body() b: any, @Req() r: any) { return this.svc.terminateAgreement(id, b, caller(r)); }
  @Get('studies/:uid/basis')
  basis(@Param('uid') uid: string, @Query() q: any, @Req() r: any) { return this.svc.listBasis(uid, q, caller(r)); }
  @Post('studies/:uid/basis')
  recordBasis(@Param('uid') uid: string, @Body() b: any, @Req() r: any) { return this.svc.recordBasis(uid, b, caller(r)); }
  @Post('studies/:uid/basis/:id/revoke')
  revokeBasis(@Param('uid') uid: string, @Param('id') id: string, @Body() b: any, @Req() r: any) { return this.svc.revokeBasis(uid, id, b, caller(r)); }
  @Post('studies/:uid/transfers')
  open(@Param('uid') uid: string, @Body() b: any, @Req() r: any) { return this.svc.openTransfer(uid, b, caller(r)); }
  @Get('transfers')
  outgoing(@Query() q: any, @Req() r: any) { return this.svc.listOutgoing(q, caller(r)); }
  @Post('transfers/:id/revoke')
  revoke(@Param('id') id: string, @Body() b: any, @Req() r: any) { return this.svc.revokeTransfer(id, b, caller(r)); }
}
