// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code): the one raw INSERT form read by position
// (Astra S7-U3a-AUDIT-SPEC-R-001-F03). Added to the baseline, each marked statement is one resolved raw site whose action
// is the value at its `action` column, whatever the other columns, comments and strings hold, and the gate still passes.
// The S7-U3a fix4 evidence runs the same statements on a disposable PostgreSQL and compares the stored action.
import { Prisma } from '@prisma/client';

const ACTION = 'syn.allowed';

export async function positions(tx: Prisma.TransactionClient, actor: string, uid: string, at: Date) {
  await tx.$executeRaw`INSERT INTO "AuditLog" (action, actor, target) VALUES ('syn.allowed', 'syn.second', 'syn.hidden')`; // expect: resolved syn.allowed
  await tx.$executeRaw`INSERT INTO "AuditLog" (actor, target, action) VALUES ('syn.second', ${uid}, 'syn.hidden')`; // expect: resolved syn.hidden
  await tx.$executeRaw`INSERT INTO public."AuditLog" ("actor", "action", "target", detail) VALUES (${actor}, ${ACTION}, ${uid}, 'a, (b), ''syn.second''');`; // expect: resolved syn.allowed
  await tx.$executeRaw`insert into "AuditLog" (ACTOR, Action, TARGET, "at") values (${actor}, 'syn.second', ${uid}, ${at})`; // expect: resolved syn.second
  // expect: resolved syn.second
  await tx.$executeRaw`INSERT INTO "AuditLog" (actor, /* action, 'syn.hidden', */ target, action)
    VALUES (${actor}, -- 'syn.hidden', a comment
      ${uid}, 'syn.second')`;
  await tx.$executeRaw`INSERT INTO "AuditLog" (actor, target, detail, action) VALUES (lower(${actor}), ${uid}, json_build_object('action', 'syn.hidden', 'n', 1)::text, 'syn.allowed')`; // expect: resolved syn.allowed
  await tx.$executeRaw`INSERT INTO "AuditLog" (target, actor, action) VALUES (${uid}, ${actor}, ${'syn.hidden'})`; // expect: resolved syn.hidden
}
