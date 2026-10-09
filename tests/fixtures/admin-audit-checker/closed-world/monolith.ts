// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code): CW04, the writes of writer.ts,
// callers.ts and composition.ts in one class, as before the S9-U0b split — the three helpers private (W3), the same DI
// service a constructor parameter. The split and wired corpus must give the same writers, actions, prefixes and SQL
// provenance. Read alone; `// expect:` marks as in the other fixtures.
import { Prisma, PrismaClient } from '@prisma/client';

import { Injectable } from '@nestjs/common';

export class SynMonoPrisma extends PrismaClient {}
export interface SynMonoCaller { actor: string; institution: string | null; }
type SynMonoAudit = (actor: string, action: string, target: string) => Promise<unknown>;

@Injectable()
export class SynScopeService {
  async require(uid: string, tx: Prisma.TransactionClient) {
    await tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid = ${uid} FOR SHARE`; // expect: proven_non_audit its SQL names no AuditLog
  }
}

@Injectable()
export class SynMonolith {
  constructor(private prisma: SynMonoPrisma, private scope: SynScopeService) {}

  private audit(actor: string, action: string, target: string) {
    return this.prisma.auditLog.create({ data: { actor, action, target } }); // expect: resolved match study.arrived
  }

  private async scopeWrite<T>(uid: string, c: SynMonoCaller, work: (tx: Prisma.TransactionClient, audit: SynMonoAudit) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      await this.scope.require(uid, tx);
      const audit = (actor: string, action: string, target: string) => tx.auditLog.create({ data: { actor, action, target } }); // expect: resolved hold.force-release state.patch study.assign unmatch
      return work(tx, audit);
    });
  }

  private async draftTransaction<T>(uid: string, c: SynMonoCaller, work: (tx: Prisma.TransactionClient, audit: SynMonoAudit) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      const audit = (actor: string, action: string, target: string) => tx.auditLog.create({ data: { actor, action, target } }); // expect: resolved report.approve report.draft report.draft.clear report.draft.discard report.save
      return work(tx, audit);
    });
  }

  async forceRelease(uid: string, c: SynMonoCaller) {
    return this.scopeWrite(uid, c, async (tx, audit) => {
      await audit(c.actor, 'hold.force-release', uid);
    });
  }

  async assign(uid: string, c: SynMonoCaller) {
    return this.scopeWrite(uid, c, async (tx, audit) => { await audit(c.actor, 'study.assign', uid); });
  }

  async peek(uid: string, c: SynMonoCaller) {
    return this.scopeWrite(uid, c, async tx => tx.studyState.findMany({ where: { uid } }));
  }

  async patch(uid: string, body: any, c: SynMonoCaller) {
    return this.scopeWrite(uid, c, async (tx, audit) => {
      await audit(c.actor, 'state.patch', uid);
    });
  }

  async unmatch(uid: string, c: SynMonoCaller) {
    return this.scopeWrite(uid, c, async (tx, audit) => { await audit(c.actor, 'unmatch', uid); });
  }

  async match(uid: string, c: SynMonoCaller) {
    await this.audit(c.actor, 'match', uid);
  }

  async arrived(uid: string) {
    await this.audit('system', 'study.arrived', uid);
  }

  async putDraft(uid: string, c: SynMonoCaller, empty: boolean) {
    return this.draftTransaction(uid, c, async (tx, audit) => {
      await audit(c.actor, empty ? 'report.draft.clear' : 'report.draft', uid);
    });
  }

  async discardDraft(uid: string, c: SynMonoCaller) {
    return this.draftTransaction(uid, c, async (tx, audit) => { await audit(c.actor, 'report.draft.discard', uid); });
  }

  async forceDiscard(uid: string, c: SynMonoCaller) {
    return this.draftTransaction(uid, c, async tx => {
      await tx.auditLog.create({ data: { actor: c.actor, action: 'report.draft.force-discard', target: uid } }); // expect: resolved report.draft.force-discard
    });
  }

  async commit(uid: string, body: any, c: SynMonoCaller) {
    const action = body?.action;
    if (!['save', 'approve'].includes(action)) throw new Error(`unknown action: ${action}`);
    return this.draftTransaction(uid, c, async (tx, audit) => {
      await audit(c.actor, `report.${action}`, uid);
    });
  }
}
