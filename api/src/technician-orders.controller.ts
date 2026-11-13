/*
 * Technician Order List routes: Scheduled (GET orders/scheduled) and Delete Order / Undo (POST orders/:oid/remove,
 * POST orders/:oid/restore). The rules are the service's (technician-orders.service.ts).
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { TechnicianOrdersService } from './technician-orders.service';
import type { Caller } from './pacs/access';

/** The caller comes from the global guard's verified token and rights only (sub, actor, roles, institution, kind). */
function caller(req: any): Caller {
  return { sub: req.sub, actor: req.actor, roles: req.roles ?? [], institution: req.institution ?? null, kind: req.kind ?? 'member' };
}

/** A feature controller of its own so the PACS facade and its route snapshot stay as they are; clinician-only callers are
 * refused by the guard's default and every route needs the technician role (admin passes). */
@Controller()
export class TechnicianOrdersController {
  constructor(private readonly orders: TechnicianOrdersService) {}

  @Get('orders/scheduled')
  scheduled(@Query() query: any, @Req() req: any) {
    return this.orders.scheduled(caller(req), query);
  }

  @Post('orders/:oid/remove')
  @HttpCode(200)
  remove(@Param('oid') oid: string, @Body() body: any, @Req() req: any) {
    return this.orders.remove(caller(req), oid, body);
  }

  @Post('orders/:oid/restore')
  @HttpCode(200)
  restore(@Param('oid') oid: string, @Req() req: any) {
    return this.orders.restore(caller(req), oid);
  }
}
