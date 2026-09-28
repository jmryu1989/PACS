// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code). With actions.ts and forward.ts it is a
// program that writes every row of contract.json and holds the accesses and reads the checker must leave alone or prove
// not to be a write; alone it passes the gate. `// expect:` marks the one candidate its line gives (alone on a line: the
// next line's); a line without a mark gives none.
import { PrismaClient } from '@prisma/client';

export class SynPrisma extends PrismaClient {}

export class SynBaseline {
  private notes: Record<string, string> = {};
  constructor(private prisma: SynPrisma) {}

  async write(body: any, uid: string, actor: string) {
    return this.prisma.$transaction(async tx => {
      await tx.auditLog.create({ data: { actor, action: 'syn.allowed', target: uid } }); // expect: resolved syn.allowed
      await tx.auditLog.create({ data: { actor, action: 'syn.hidden', target: uid } }); // expect: resolved syn.hidden
      await tx.$executeRaw`INSERT INTO "AuditLog" (actor, action, target) VALUES (${actor}, 'syn.second', ${uid})`; // expect: resolved syn.second
      await tx.auditLog.create({ data: { actor, action: 'syn.wild.' + body.kind, target: uid } }); // expect: resolved prefix:syn.wild.
      await tx.studyState.findMany({ where: { uid } });
      await tx.auditLog.count({ where: { target: uid } }); // expect: proven_non_audit a read method
      await tx.$queryRaw`SELECT action FROM "AuditLog" WHERE target = ${uid} FOR UPDATE`; // expect: proven_non_audit one SELECT that changes no row
      await tx.$executeRaw`UPDATE "StudyState" SET ss = ${'Verified'} WHERE uid = ${uid}`; // expect: proven_non_audit its SQL names no AuditLog
      await tx.$executeRaw`UPDATE "StudyState" SET note = 'AuditLog' WHERE uid = ${uid}`; // expect: proven_non_audit only in its strings or comments
      const model = 'studyState';
      return tx[model].count(); // expect: proven_non_audit the key is studyState
    });
  }

  keep(body: any) {
    for (const key of Object.keys(body)) {
      const value = body[key]; // expect: proven_non_audit no client value reaches
      this.notes[key] = String(value); // expect: proven_non_audit no client value reaches
    }
  }
}
