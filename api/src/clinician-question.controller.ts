import { Inject, Optional } from '@nestjs/common';
import { EMR_CLINICAL_ROUTES, ClinicalRoutes, clinicalRoutes } from './emr-clinical/routes';
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ClinicianQuestionService } from './clinician-question.service';

// 귀속은 가드가 서명된 토큰에서 채운 값뿐이다. 표시 이름도 토큰의 이름이며 요청 본문에서 받지 않는다.
const caller = (r: any) => ({ sub: r.sub, actor: r.actor, roles: r.roles ?? [], institution: r.institution ?? null, kind: r.kind,
  name: typeof r.displayName === 'string' ? r.displayName : undefined });

@Controller()
export class ClinicianQuestionController {
  constructor(private service: ClinicianQuestionService, @Optional() @Inject(EMR_CLINICAL_ROUTES) private readonly clinical?: ClinicalRoutes) {}
  @Get('questions') list(@Req() r: any, @Query() q: any) { return clinicalRoutes(this.clinical).collection(r, 'GET questions', 'question', tx => this.service.list(caller(r), q, tx)); }
  @Get('questions/:id') read(@Param('id') id: string, @Req() r: any) {return clinicalRoutes(this.clinical).read(r, 'question', id.toLowerCase(), tx => this.service.read(id, caller(r), tx));}
  @Get('studies/:uid/questions') forStudy(@Param('uid') uid: string, @Req() r: any) { return clinicalRoutes(this.clinical).collection(r, 'GET studies/:uid/questions', 'question', tx => this.service.forStudy(uid, caller(r), tx), uid); }
  @Post('studies/:uid/questions') async create(@Param('uid') uid: string, @Req() r: any, @Body() b: any) { return clinicalRoutes(this.clinical).write(r, { surface: 'question.create', studyId: uid, recordId: typeof b?.requestId === 'string' ? b.requestId.toLowerCase() : null, body: b }, tx => this.service.create(uid, caller(r), b, tx)); }
  @Post('questions/:id/entries') async reply(@Param('id') id: string, @Req() r: any, @Body() b: any) { return clinicalRoutes(this.clinical).write(r, { surface: 'question.reply', studyId: (await this.service.read(id, caller(r))).item.studyUid, recordId: id.toLowerCase(), body: b }, tx => this.service.reply(id, caller(r), b, tx)); }
  @Post('questions/:id/close') async close(@Param('id') id: string, @Req() r: any, @Body() b: any) { return clinicalRoutes(this.clinical).write(r, { surface: 'question.close', studyId: (await this.service.read(id, caller(r))).item.studyUid, recordId: id.toLowerCase(), body: b }, tx => this.service.close(id, caller(r), b, tx)); }
}
