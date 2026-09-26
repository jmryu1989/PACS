import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ImageRequestService } from './image-request.service';

// 귀속은 가드가 서명된 토큰에서 채운 값뿐이다. 표시 이름도 토큰의 이름이며 요청 본문에서 받지 않는다.
// route 이름에 transfer를 쓰지 않는다 — 요청은 Connect의 transfers와 다른 기록이다(계약 S5-U4p §6.2).
const caller = (r: any) => ({ sub: r.sub, actor: r.actor, roles: r.roles ?? [], institution: r.institution ?? null, kind: r.kind,
  name: typeof r.displayName === 'string' ? r.displayName : undefined });

@Controller()
export class ImageRequestController {
  constructor(private service: ImageRequestService) {}
  @Get('image-requests') list(@Req() r: any, @Query() q: any) { return this.service.list(caller(r), q); }
  @Get('image-requests/:id') read(@Param('id') id: string, @Req() r: any) { return this.service.read(id, caller(r)); }
  @Get('studies/:uid/image-requests') forStudy(@Param('uid') uid: string, @Req() r: any) { return this.service.forStudy(uid, caller(r)); }
  @Post('studies/:uid/image-requests') create(@Param('uid') uid: string, @Req() r: any, @Body() b: any) { return this.service.create(uid, caller(r), b); }
  @Post('image-requests/:id') change(@Param('id') id: string, @Req() r: any, @Body() b: any) { return this.service.change(id, caller(r), b); }
}
