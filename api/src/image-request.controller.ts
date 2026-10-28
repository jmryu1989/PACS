import { Inject, Optional } from '@nestjs/common';
import { EMR_CLINICAL_ROUTES, ClinicalRoutes, clinicalRoutes } from './emr-clinical/routes';
import type { SurfaceKey } from './emr-clinical/contract';
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ImageRequestService } from './image-request.service';

// 귀속은 가드가 서명된 토큰에서 채운 값뿐이다. 표시 이름도 토큰의 이름이며 요청 본문에서 받지 않는다.
// route 이름에 transfer를 쓰지 않는다 — 요청은 Connect의 transfers와 다른 기록이다(계약 S5-U4p §6.2).
const caller = (r: any) => ({ sub: r.sub, actor: r.actor, roles: r.roles ?? [], institution: r.institution ?? null, kind: r.kind,
  name: typeof r.displayName === 'string' ? r.displayName : undefined });

@Controller()
export class ImageRequestController {
  constructor(private service: ImageRequestService, @Optional() @Inject(EMR_CLINICAL_ROUTES) private readonly clinical?: ClinicalRoutes) {}
  @Get('image-requests') list(@Req() r: any, @Query() q: any) { return clinicalRoutes(this.clinical).collection(r, 'GET image-requests', 'image-request', tx => this.service.list(caller(r), q, tx)); }
  @Get('image-requests/:id') read(@Param('id') id: string, @Req() r: any) {return clinicalRoutes(this.clinical).read(r, 'image-request', id.toLowerCase(), tx => this.service.read(id, caller(r), tx));}
  @Get('studies/:uid/image-requests') forStudy(@Param('uid') uid: string, @Req() r: any) { return clinicalRoutes(this.clinical).collection(r, 'GET studies/:uid/image-requests', 'image-request', tx => this.service.forStudy(uid, caller(r), tx), uid); }
  @Post('studies/:uid/image-requests') async create(@Param('uid') uid: string, @Req() r: any, @Body() b: any) {
    await this.service.prepareCreate(uid, caller(r), b);
    return clinicalRoutes(this.clinical).write(r, { surface: 'image-request.create', studyId: uid, recordId: b.requestId.toLowerCase(), body: b }, tx => this.service.create(uid, caller(r), b, tx));
  }
  @Post('image-requests/:id') async change(@Param('id') id: string, @Req() r: any, @Body() b: any) {
    const studyId = await this.service.prepareChange(id, caller(r), b);
    return clinicalRoutes(this.clinical).write(r, { surface: ('image-request.'+b.action) as SurfaceKey, studyId, recordId: id.toLowerCase(), body: b }, tx => this.service.change(id, caller(r), b, tx));
  }
}
