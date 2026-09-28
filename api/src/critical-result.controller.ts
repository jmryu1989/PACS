import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { CriticalResultService } from './critical-result.service';

// 귀속은 가드가 서명된 토큰에서 채운 값뿐이다. 표시 이름도 토큰의 이름이며 요청 본문에서 받지 않는다(계약 S7-U1p §3.1).
const caller = (r: any) => ({ sub: r.sub, actor: r.actor, roles: r.roles ?? [], institution: r.institution ?? null, kind: r.kind,
  name: typeof r.displayName === 'string' ? r.displayName : undefined });

/**
 * S7-U1a 중요 결과 전달(계약 S7-U1p §6.1의 route 8개). consultation·질문·영상 요청 route와 따로다. clinician-only가 닿는
 * 것은 받은 목록·한 건·ACK 세 행뿐이고(clinician-policy.ts), 동작별 역할·기관·StudyAccess·참여자·원문 권한은 서비스가 판정한다.
 */
@Controller()
export class CriticalResultController {
  constructor(private service: CriticalResultService) {}
  @Get('studies/:uid/critical-result-recipients') recipients(@Param('uid') uid: string, @Req() r: any) { return this.service.recipients(uid, caller(r)); }
  @Post('studies/:uid/critical-results') create(@Param('uid') uid: string, @Req() r: any, @Body() b: any) { return this.service.create(uid, caller(r), b); }
  @Get('critical-results') list(@Req() r: any, @Query() q: any) { return this.service.list(caller(r), q); }
  @Get('critical-results/:id') read(@Param('id') id: string, @Req() r: any) { return this.service.read(id, caller(r)); }
  @Get('studies/:uid/critical-results') forStudy(@Param('uid') uid: string, @Req() r: any) { return this.service.forStudy(uid, caller(r)); }
  @Post('critical-results/:id/ack') ack(@Param('id') id: string, @Req() r: any, @Body() b: any) { return this.service.ack(id, caller(r), b); }
  @Post('critical-results/:id/cancel') cancel(@Param('id') id: string, @Req() r: any, @Body() b: any) { return this.service.cancel(id, caller(r), b); }
  @Post('critical-results/:id/supersede') supersede(@Param('id') id: string, @Req() r: any, @Body() b: any) { return this.service.supersede(id, caller(r), b); }
}
