import { Body, Controller, Get, Post, Param, Req } from '@nestjs/common';
import { ReaderAssignmentService } from './reader-assignment.service';
const caller=(r:any)=>({sub:r.sub,actor:r.actor,roles:r.roles??[],institution:r.institution??null,kind:r.kind});
@Controller()
export class ReaderAssignmentController {
  constructor(private service:ReaderAssignmentService){}
  @Get('reader-candidates') candidates(@Req() r:any){return this.service.candidates(caller(r));}
  @Get('studies/:uid/reader-assignment') read(@Param('uid') uid:string,@Req() r:any){return this.service.read(uid,caller(r));}
  @Post('studies/:uid/reader-assignment') write(@Param('uid') uid:string,@Req() r:any,@Body() b:any){return this.service.write(uid,caller(r),b);}
}
