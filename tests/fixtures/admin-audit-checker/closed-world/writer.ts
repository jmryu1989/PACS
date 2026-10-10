// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code): CW01-CW16 of the closed world (W3-C,
// W4-C; Astra S9-U0b audit consult D4). The three helper shapes the S9-U0b modules have, each a public member of an
// exported class: an audit member (pacs/audit.ts), a write scope that hands its local audit function to its caller's
// callback (pacs/access.ts scopeWrite) and a draft transaction that does the same (pacs/report-draft.ts). composition.ts
// creates and owns every instance; callers.ts calls them. `// expect:` marks the candidate of its line as in the other
// fixtures; `@cw:<tag>` names a line for cases.json.
import { Prisma, PrismaClient } from '@prisma/client';
import type { SynScopeService } from './composition';

export class SynClosedPrisma extends PrismaClient {}

export interface SynCaller { actor: string; institution: string | null; }
export type SynAuditFn = (actor: string, action: string, target: string) => Promise<unknown>;

export class SynAuditWriter {
  constructor(private readonly prisma: SynClosedPrisma) {}

  audit(actor: string, action: string, target: string) {
    return this.prisma.auditLog.create({ data: { actor, action, target } }); // @cw:audit-member // expect: resolved match study.arrived
  }
}

export class SynAccess {
  constructor(private readonly prisma: SynClosedPrisma, private readonly scope: SynScopeService) {}

  async scopeWrite<T>(uid: string, c: SynCaller, work: (tx: Prisma.TransactionClient, audit: SynAuditFn) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      await this.scope.require(uid, tx); // @cw:scope-require
      const audit = (actor: string, action: string, target: string) => tx.auditLog.create({ data: { actor, action, target } }); // @cw:scope-write // expect: resolved hold.force-release state.patch study.assign unmatch
      return work(tx, audit); // @cw:scope-work
    });
  }
}

export class SynDraft {
  constructor(private readonly prisma: SynClosedPrisma) {}

  async draftTransaction<T>(uid: string, c: SynCaller, work: (tx: Prisma.TransactionClient, audit: SynAuditFn) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      const audit = (actor: string, action: string, target: string) => tx.auditLog.create({ data: { actor, action, target } }); // @cw:draft-transaction // expect: resolved report.approve report.draft report.draft.clear report.draft.discard report.save
      return work(tx, audit); // @cw:draft-work
    });
  }

  async putDraft(uid: string, c: SynCaller, empty: boolean) {
    return this.draftTransaction(uid, c, async (tx, audit) => {
      await audit(c.actor, empty ? 'report.draft.clear' : 'report.draft', uid);
    });
  }

  async discardDraft(uid: string, c: SynCaller) {
    return this.draftTransaction(uid, c, async (tx, audit) => { await audit(c.actor, 'report.draft.discard', uid); });
  }

  // Its own row in the same transaction, written directly: not one of the callback's actions.
  async forceDiscard(uid: string, c: SynCaller) {
    return this.draftTransaction(uid, c, async tx => {
      await tx.auditLog.create({ data: { actor: c.actor, action: 'report.draft.force-discard', target: uid } }); // @cw:force-discard // expect: resolved report.draft.force-discard
    });
  }
}
// end of writer.ts
