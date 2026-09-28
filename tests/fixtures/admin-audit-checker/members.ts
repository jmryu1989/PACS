// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code): the member references and objects of
// Astra S7-U3a-E-R-001 (F02 (b), (e), (h) and the F03 fragment) that keep to the program. Added to the baseline of
// tests/fixtures/admin_audit_completeness, each marked write is one resolved site with exactly the marked actions and the
// gate still passes; nothing else in the file is a candidate.
import { Prisma } from '@prisma/client';

const GO = 'go';
const LINK = 'link' + 'ed';
const FIELD = 'field';

export class SynMembers {
  private readonly field = 'syn.allowed';
  private static readonly SECOND = 'syn.second';
  private count = 0;

  // (h) a helper called only by constant keys: a dot and a key the program fixes are one reference
  private go(tx: Prisma.TransactionClient, action: string) {
    return tx.auditLog.create({ data: { actor: 'syn', action, target: 'syn' } }); // expect: resolved syn.allowed syn.second
  }

  // F03 a WITH fragment received by a helper that only interpolates it
  private async linked(tx: Prisma.TransactionClient, selector: Prisma.Sql) {
    // expect: resolved syn.hidden
    await tx.$executeRaw`WITH s AS (SELECT t.uid FROM "StudyState" t WHERE ${selector})
      INSERT INTO "AuditLog" (action, target) SELECT 'syn.hidden', uid FROM s`;
  }

  async write(tx: Prisma.TransactionClient, uid: string) {
    // (e) another member of the instance written: the readonly field keeps its value
    this.count++;
    await this[GO](tx, this.field);
    await this['go'](tx, SynMembers.SECOND);
    // (e) the readonly field read by a constant key
    await tx.auditLog.create({ data: { actor: 'syn', target: 'syn', action: this[FIELD] } }); // expect: resolved syn.allowed
    // F03 the fragment through a const alias, tested, and handed to the helper by a constant key
    const selector = Prisma.sql`t.uid = ${uid}::text`;
    const same = selector;
    if (same) await this[LINK](tx, same);
  }
}

// (e) a class handed to other code (a module's providers) is the class's, its static members': its instances' fields
// keep their values, code outside the program being read as for (h)
export class SynProvided {
  private readonly field = 'syn.second';
  async write(tx: Prisma.TransactionClient) {
    await tx.auditLog.create({ data: { actor: 'syn', target: 'syn', action: this.field } }); // expect: resolved syn.second
  }
}
export const SYN_PROVIDERS = [SynProvided];
