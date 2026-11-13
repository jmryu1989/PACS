import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { FilmPrintService } from './film-print.service';
import type { Caller } from './pacs/access';

/** The caller comes from the global guard's verified token and rights only (sub, actor, roles, institution, kind). */
function caller(req: any): Caller {
  return { sub: req.sub, actor: req.actor, roles: req.roles ?? [], institution: req.institution ?? null, kind: req.kind ?? 'member' };
}

/**
 * Film / DICOM Print: the institution's printers and devices, one film's layout as it will be printed, a print job and
 * its state. Roles, institution, the study the caller's list opens and requester binding are the service's
 * (film-print.service.ts); clinician-only callers are refused by the guard's default.
 */
@Controller()
export class FilmPrintController {
  constructor(private readonly films: FilmPrintService) {}

  @Get('film-print/destinations')
  destinations(@Req() req: any) {
    return this.films.destinations(caller(req));
  }

  @Post('film-print/layout')
  @HttpCode(200)
  layout(@Body() body: any, @Req() req: any) {
    return this.films.layout(body, caller(req));
  }

  @Post('film-print/jobs')
  @HttpCode(200)
  create(@Body() body: any, @Req() req: any) {
    return this.films.create(body, caller(req));
  }

  @Get('film-print/jobs/:id')
  job(@Param('id') id: string, @Req() req: any) {
    return this.films.job(id, caller(req));
  }
}
