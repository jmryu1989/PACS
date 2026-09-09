import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { FavoriteService } from './favorite.service';
const caller = (r: any) => ({ sub:r.sub,actor:r.actor,roles:r.roles ?? [],institution:r.institution ?? null,kind:r.kind ?? 'unknown' });
@Controller('favorite-folders')
export class FavoriteController {
  constructor(private svc: FavoriteService) {}
  @Get()
  read(@Req() req: any) { return this.svc.read(caller(req)); }
  @Post()
  write(@Req() req: any, @Body() body: any) { return this.svc.write(caller(req),body); }
}
