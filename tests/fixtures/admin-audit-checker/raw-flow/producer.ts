// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code): the raw-client/receiver flow proof of
// tests/admin_audit_raw_flow.cjs (EMR-D a5, RF-P/H/C/R/S/A of cases.json). In a small synthetic program, the shapes the
// composed clinical runtime has: a port bound once at start and read through an interface, closed factories returning
// that interface, a store whose recovery callback its runtime registers, a seal whose SQL value comes from a private
// helper of the store, a response context carrying two clients and the access service it was given, and the access
// service's own SQL built from a private helper's tuple. `// expect:` marks the candidate of its line as in the other
// fixtures; `@rf:<tag>` names a line for cases.json.
import { Prisma, PrismaClient } from '@prisma/client';
import { synFreeze } from './consumer';

export class SynFlowPrisma extends PrismaClient {}
export interface SynFlowCaller { sub: string; institution: string; }
export interface SynFlowContext { db: any; tx: any; caller: SynFlowCaller; access: SynFlowAccess; }
export interface SynFlowPort {
  respond(request: unknown, context: SynFlowContext): Promise<number>;
  refuse(request: unknown, code: string): Promise<void>;
}

/** The access service every context carries: its SQL values come from a private helper's tuple. */
export class SynFlowAccess {
  constructor(private readonly prisma: SynFlowPrisma) {}
  private owner(c: SynFlowCaller) { return [c.institution, c.sub]; }
  async snapshot(c: SynFlowCaller, tx?: any) {
    const [institution, subject] = this.owner(c);
    return (tx || this.prisma).$queryRaw`SELECT revision FROM "SynFlowPolicy" WHERE subject = ${subject} AND institution = ${institution}`; // @rf:owner-tuple // expect: proven_non_audit its SQL names no AuditLog
  }
}

/** The store: a recovery callback slot its runtime fills, called with the store as `this`; a seal of a helper's values. */
export class SynFlowStore {
  private wake: ((request: string) => void) | null = null;
  constructor(private readonly db: SynFlowPrisma) {}
  onWake(schedule: (request: string) => void): void { this.wake = schedule; } // @rf:on-wake
  wakeUp(request: string) { this.wake?.(request); } // @rf:wake-call
  private decision(code: string, cause: 'rollback' | 'not-dispatched') { return synFreeze({ code, cause }); }
  private async seal(decision: Readonly<{ code: string; cause: 'rollback' | 'not-dispatched' }>) {
    await this.db.$queryRaw`SELECT syn_flow_seal(${decision.code}::text, ${decision.cause}::text) AS done`; // @rf:seal // expect: proven_non_audit its SQL names no AuditLog
  }
  async refuse(code: string, dispatched: boolean) {
    const filter = dispatched ? Prisma.sql`phase = ${'dispatched'}` : Prisma.empty;
    await this.db.$queryRaw`SELECT count(*) AS n FROM "SynFlowAttempt" WHERE code = ${code} ${filter}`; // @rf:composed // expect: proven_non_audit all 2 SQL alternatives
    await this.seal(this.decision(code, dispatched ? 'rollback' : 'not-dispatched')); // @rf:seal-supply
  }
}

/** The port's one implementation: it owns its store and registers the store's callback. */
export class SynFlowRuntime implements SynFlowPort {
  readonly store: SynFlowStore;
  constructor(private readonly db: SynFlowPrisma) {
    this.store = new SynFlowStore(db); // @rf:store-field
    this.store.onWake(request => this.schedule(request)); // @rf:wake-arrow
  }
  private schedule(request: string) { void request; }
  respond(request: unknown, context: SynFlowContext) { return synFlowRespond(context); } // @rf:respond
  async refuse(request: unknown, code: string) { await this.store.refuse(code, true); }
}

async function synFlowRespond(ctx: SynFlowContext): Promise<number> {
  await ctx.access.snapshot(ctx.caller, ctx.tx); // @rf:context-access
  const rows: any[] = await ctx.tx.$queryRaw`SELECT 1 AS one`; // @rf:context-read // expect: proven_non_audit its SQL names no AuditLog
  const { tx } = ctx; // @rf:destructure
  await tx.$queryRaw`SELECT 2 AS two`; // @rf:destructured-read // expect: proven_non_audit its SQL names no AuditLog
  return ctx.db.$transaction(async (inner: Prisma.TransactionClient) => { // @rf:spread-transaction
    const current = { ...ctx, tx: inner }; // @rf:spread
    return synFlowPing(current, rows.length);
  });
}
/** A closed mutual recursion carrying the context (RF-R). */
async function synFlowPing(ctx: SynFlowContext, n: number): Promise<number> {
  if (n <= 0) { await ctx.tx.$queryRaw`SELECT 3 AS three`; return 0; } // @rf:ping // expect: proven_non_audit its SQL names no AuditLog
  return synFlowPong(ctx, n - 1); // @rf:ping-pong
}
async function synFlowPong(ctx: SynFlowContext, n: number): Promise<number> {
  return synFlowPing(ctx, n); // @rf:pong
}

let bound: SynFlowPort | null = null;
/** Start only, once: no request path replaces the port. */
export function synFlowBind(port: SynFlowPort): void {
  if (bound) throw new Error('bound twice');
  if (!port || typeof port.respond !== 'function') throw new Error('no port');
  bound = port; // @rf:bind
}
export function synFlowPort(): SynFlowPort { if (!bound) throw new Error('not bound'); return bound; }
/** A closed factory of this module returning the interface (RF-P). */
export function synFlowMake(db: SynFlowPrisma): SynFlowPort { return new SynFlowRuntime(db); } // @rf:factory
// end of producer.ts
