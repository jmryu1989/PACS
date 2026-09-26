import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ClinicianQuestionService } from './clinician-question.service';

// 귀속은 가드가 서명된 토큰에서 채운 값뿐이다. 표시 이름도 토큰의 이름이며 요청 본문에서 받지 않는다.
const caller = (r: any) => ({ sub: r.sub, actor: r.actor, roles: r.roles ?? [], institution: r.institution ?? null, kind: r.kind,
  name: typeof r.displayName === 'string' ? r.displayName : undefined });

@Controller()
export class ClinicianQuestionController {
  constructor(private service: ClinicianQuestionService) {}
  @Get('questions') list(@Req() r: any, @Query() q: any) { return this.service.list(caller(r), q); }
  @Get('questions/:id') read(@Param('id') id: string, @Req() r: any) { return this.service.read(id, caller(r)); }
  @Get('studies/:uid/questions') forStudy(@Param('uid') uid: string, @Req() r: any) { return this.service.forStudy(uid, caller(r)); }
  @Post('studies/:uid/questions') create(@Param('uid') uid: string, @Req() r: any, @Body() b: any) { return this.service.create(uid, caller(r), b); }
  @Post('questions/:id/entries') reply(@Param('id') id: string, @Req() r: any, @Body() b: any) { return this.service.reply(id, caller(r), b); }
  @Post('questions/:id/close') close(@Param('id') id: string, @Req() r: any, @Body() b: any) { return this.service.close(id, caller(r), b); }
}
