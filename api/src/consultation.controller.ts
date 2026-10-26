import { Inject, Optional } from '@nestjs/common';
import { EMR_CLINICAL_ROUTES, ClinicalRoutes, clinicalRoutes } from './emr-clinical/routes';
import type { SurfaceKey } from './emr-clinical/contract';
import { Body, Controller, Get, Post, Param, Query, Req } from '@nestjs/common';
import { ConsultationService } from './consultation.service';
const caller=(r:any)=>({sub:r.sub,actor:r.actor,roles:r.roles??[],institution:r.institution??null,kind:r.kind});
@Controller()
export class ConsultationController {
  constructor(private service: ConsultationService, @Optional() @Inject(EMR_CLINICAL_ROUTES) private readonly clinical?: ClinicalRoutes) {}
  @Get('consultation-candidates') candidates(@Req() r:any){return this.service.candidates(caller(r));}
  @Get('consultations') list(@Req() r:any,@Query() q:any){return clinicalRoutes(this.clinical).collection(r, 'GET consultations', 'consultation', tx => this.service.list(caller(r),q,tx));}
  @Get('consultations/:id') read(@Param('id') id:string,@Req() r:any){return clinicalRoutes(this.clinical).read(r, 'consultation', id.toLowerCase(), tx => this.service.read(id,caller(r), tx));}
  @Post('studies/:uid/consultations') async create(@Param('uid') uid:string,@Req() r:any,@Body() b:any){ return clinicalRoutes(this.clinical).write(r, { surface: 'consultation.create', studyId: uid, recordId: typeof b?.requestId === 'string' ? b.requestId.toLowerCase() : null, body: b }, tx => this.service.create(uid,caller(r),b, tx)); }
  @Post('consultations/:id') async change(@Param('id') id:string,@Req() r:any,@Body() b:any){ return clinicalRoutes(this.clinical).write(r, { surface: ('consultation.'+b?.action) as SurfaceKey, studyId: (await this.service.read(id,caller(r))).item.studyUid, recordId: id.toLowerCase(), body: b }, tx => this.service.change(id,caller(r),b, tx)); }
}
