import { UseInterceptors } from '@nestjs/common';
import { AuthorizedResponse, ClinicalResponseInterceptor } from './emr-clinical/response';
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ImageRequestService } from './image-request.service';

// 귀속은 가드가 서명된 토큰에서 채운 값뿐이다. 표시 이름도 토큰의 이름이며 요청 본문에서 받지 않는다.
// route 이름에 transfer를 쓰지 않는다 — 요청은 Connect의 transfers와 다른 기록이다(계약 S5-U4p §6.2).
// EMR-D: 쓰기와 사유·note를 싣는 모든 응답(한 건·목록·검사별)은 요청 자체도 넘긴다. 검증된 인증 문맥(B2)과 함께 온
// 단말 서명(C)은 서버 포트가 그 요청에서만 읽으며 본문 필드로는 받지 않는다.
const caller = (r: any) => ({ sub: r.sub, actor: r.actor, roles: r.roles ?? [], institution: r.institution ?? null, kind: r.kind,
  name: typeof r.displayName === 'string' ? r.displayName : undefined });

@UseInterceptors(ClinicalResponseInterceptor)
@Controller()
export class ImageRequestController {
  constructor(private service: ImageRequestService) {}
  @Get('image-requests') list(@Req() r: any, @Query() q: any) : Promise<AuthorizedResponse> { return this.service.list(caller(r), q, r); }
  @Get('image-requests/:id') read(@Param('id') id: string, @Req() r: any) : Promise<AuthorizedResponse> { return this.service.read(id, caller(r), r); }
  @Get('studies/:uid/image-requests') forStudy(@Param('uid') uid: string, @Req() r: any) : Promise<AuthorizedResponse> { return this.service.forStudy(uid, caller(r), r); }
  @Post('studies/:uid/image-requests') create(@Param('uid') uid: string, @Req() r: any, @Body() b: any) : Promise<AuthorizedResponse> { return this.service.create(uid, caller(r), b, r); }
  @Post('image-requests/:id') change(@Param('id') id: string, @Req() r: any, @Body() b: any) : Promise<AuthorizedResponse> { return this.service.change(id, caller(r), b, r); }
}
