// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code): the member references and objects that
// keep to the program, inside the closed list of Astra S7-U3a-AUDIT-SPEC-C-R-001 (W1 keys, W3 helpers, W4 objects, W5
// predicates). Added to the baseline of tests/fixtures/admin_audit_completeness, each marked write is one resolved site
// with exactly the marked actions and the gate still passes; nothing else in the file is a candidate. What fix6 had here
// outside the list (readonly and static readonly fields, a key joined by `+`) is refused in violations.txt (`moved-*`).
import { Prisma } from '@prisma/client';

const GO = 'go';
const LINK = 'linked';
const DATA = 'data';

export class SynMembers {
  private count = 0;

  // W3 a private helper called by a constant key and by a dot (W1: one reference either way)
  private go(tx: Prisma.TransactionClient, action: string) {
    return tx.auditLog.create({ data: { actor: 'syn', action, target: 'syn' } }); // expect: resolved syn.allowed syn.second
  }

  // W5 a WITH predicate received by a private helper that only interpolates it
  private async linked(tx: Prisma.TransactionClient, selector: Prisma.Sql) {
    // expect: resolved syn.hidden
    await tx.$executeRaw`WITH s AS (SELECT t.uid FROM "StudyState" t WHERE ${selector})
      INSERT INTO "AuditLog" (action, target) SELECT 'syn.hidden', uid FROM s`;
  }

  async write(tx: Prisma.TransactionClient, uid: string) {
    // W4 another member of the instance written (a count): the helpers still run the bodies the program has
    this.count++;
    await this[GO](tx, 'syn.allowed');
    await this.go(tx, 'syn.second');
    // W1 `data` by a constant key
    await tx.auditLog.create({ [DATA]: { actor: 'syn', target: 'syn', action: 'syn.second' } }); // expect: resolved syn.second
    // W5 the predicate through a const alias, tested, and handed to the helper by a constant key
    const selector = Prisma.sql`t.uid = ${uid}::text`;
    const same = selector;
    if (same) await this[LINK](tx, same);
  }
}
