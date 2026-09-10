import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Caller } from './pacs.service';
import { StudyAccessService } from './study-access.service';
const caller=(r:any):Caller=>({sub:r.sub,actor:r.actor,roles:r.roles??[],institution:r.institution??null,kind:r.kind??'member'});
@Controller()
export class StudyAccessController {
  constructor(private access:StudyAccessService) {}
  @Get('study-access')
  status(@Req() r:any){return this.access.status(caller(r));}
  @Get('admin/users/:id/study-access')
  read(@Param('id') id:string,@Req() r:any){return this.access.read(id,caller(r));}
  @Post('admin/users/:id/study-access')
  write(@Param('id') id:string,@Body() b:any,@Req() r:any){return this.access.write(id,caller(r),b);}
}
