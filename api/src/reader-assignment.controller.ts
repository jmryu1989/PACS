import { UseInterceptors } from '@nestjs/common';
import { AuthorizedResponse, ClinicalResponseInterceptor } from './emr-clinical/response';
import { Body, Controller, Get, Post, Param, Req } from '@nestjs/common';
import { ReaderAssignmentService } from './reader-assignment.service';
// EMR-D: a write also passes the request itself; the verified context (B2) is read from it by a server port only.
const caller=(r:any)=>({sub:r.sub,actor:r.actor,roles:r.roles??[],institution:r.institution??null,kind:r.kind});
@UseInterceptors(ClinicalResponseInterceptor)
@Controller()
export class ReaderAssignmentController {
  constructor(private service:ReaderAssignmentService){}
  @Get('reader-candidates') candidates(@Req() r:any): Promise<AuthorizedResponse> {return this.service.candidates(caller(r),r);}
  @Get('studies/:uid/reader-assignment') read(@Param('uid') uid:string,@Req() r:any): Promise<AuthorizedResponse> {return this.service.read(uid,caller(r),r);}
  @Post('studies/:uid/reader-assignment') write(@Param('uid') uid:string,@Req() r:any,@Body() b:any): Promise<AuthorizedResponse> {return this.service.write(uid,caller(r),b,r);}
}
