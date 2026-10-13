import { UseInterceptors } from '@nestjs/common';
import { AuthorizedResponse, ClinicalResponseInterceptor } from './emr-clinical/response';
import { Body, Controller, Get, Post, Param, Query, Req } from '@nestjs/common';
import { ConsultationService } from './consultation.service';
// EMR-D: writes and every response carrying consultation text (list, read, write answer) also pass the request itself;
// the verified context (B2) and the carried device signature (C) are read from it by server ports only, never from body fields.
const caller=(r:any)=>({sub:r.sub,actor:r.actor,roles:r.roles??[],institution:r.institution??null,kind:r.kind});
@UseInterceptors(ClinicalResponseInterceptor)
@Controller()
export class ConsultationController {
  constructor(private service:ConsultationService) {}
  @Get('consultation-candidates') candidates(@Req() r:any): Promise<AuthorizedResponse> {return this.service.candidates(caller(r),r);}
  @Get('consultations') list(@Req() r:any,@Query() q:any): Promise<AuthorizedResponse> {return this.service.list(caller(r),q,r);}
  @Get('consultations/:id') read(@Param('id') id:string,@Req() r:any): Promise<AuthorizedResponse> {return this.service.read(id,caller(r),r);}
  @Post('studies/:uid/consultations') create(@Param('uid') uid:string,@Req() r:any,@Body() b:any): Promise<AuthorizedResponse> {return this.service.create(uid,caller(r),b,r);}
  @Post('consultations/:id') change(@Param('id') id:string,@Req() r:any,@Body() b:any): Promise<AuthorizedResponse> {return this.service.change(id,caller(r),b,r);}
}
