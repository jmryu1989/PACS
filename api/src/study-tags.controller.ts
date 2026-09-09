import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { StudyTagsService } from './study-tags.service';
const caller=(r:any)=>({sub:r.sub,actor:r.actor,roles:r.roles??[],institution:r.institution??null,kind:r.kind});
@Controller('study-tags')
export class StudyTagsController {
  constructor(private service:StudyTagsService){}
  @Get() read(@Req() req:any){return this.service.read(caller(req));}
  @Post() write(@Req() req:any,@Body() body:any){return this.service.write(caller(req),body);}
}
