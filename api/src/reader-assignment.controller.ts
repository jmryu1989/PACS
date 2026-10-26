import { Inject, Optional } from '@nestjs/common';
import { EMR_CLINICAL_ROUTES, ClinicalRoutes, clinicalRoutes } from './emr-clinical/routes';
import { Body, Controller, Get, Post, Param, Req } from '@nestjs/common';
import { ReaderAssignmentService } from './reader-assignment.service';
const caller=(r:any)=>({sub:r.sub,actor:r.actor,roles:r.roles??[],institution:r.institution??null,kind:r.kind});
@Controller()
export class ReaderAssignmentController {
  constructor(private service: ReaderAssignmentService, @Optional() @Inject(EMR_CLINICAL_ROUTES) private readonly clinical?: ClinicalRoutes){}
  @Get('reader-candidates') candidates(@Req() r:any){return this.service.candidates(caller(r));}
  @Get('studies/:uid/reader-assignment') read(@Param('uid') uid:string,@Req() r:any){return clinicalRoutes(this.clinical).assignment(r, uid, tx => this.service.read(uid,caller(r), tx));}
  @Post('studies/:uid/reader-assignment') async write(@Param('uid') uid:string,@Req() r:any,@Body() b:any){ await clinicalRoutes(this.clinical).write(r, { surface: 'assignment.write', studyId: uid, recordId: JSON.stringify([uid,r.institution]), body: b }, tx => this.service.write(uid,caller(r),b, tx)); return this.read(uid, r); }
}
