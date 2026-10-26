import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { StudyTagsService } from './study-tags.service';
import { organizationRead } from './emr-viewing/consumer-read';
const caller=(r:any)=>({sub:r.sub,actor:r.actor,roles:r.roles??[],institution:r.institution??null,kind:r.kind});
@Controller('study-tags')
export class StudyTagsController {
  constructor(private service:StudyTagsService){}
  @Get() async read(@Req() req:any){return organizationRead(await this.service.read(caller(req)), true);}
  @Post() write(@Req() req:any,@Body() body:any){return this.service.write(caller(req),body);}
}
