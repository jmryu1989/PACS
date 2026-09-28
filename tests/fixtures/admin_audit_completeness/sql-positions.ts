// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code): the two raw INSERT forms read by position
// (Astra S7-U3a-AUDIT-SPEC-R-001-F03, amended by S7-U3a-AUDIT-SPEC-B-R-001: G1 INSERT … VALUES, G2 [WITH …] INSERT … SELECT
// … FROM one source). Added to the baseline, each marked statement is one resolved raw site whose action is the value or
// item at its `action` column, whatever the other columns, comments, strings and WITH bodies hold, and the gate still
// passes. The S7-U3a evidence runs the same statements on a disposable PostgreSQL (with one synthetic StudyState row, and
// each fragment spliced as each of its callers passes it) and compares the stored action.
import { Prisma } from '@prisma/client';

const ACTION = 'syn.allowed';

export async function positions(tx: Prisma.TransactionClient, actor: string, uid: string, ward: string, at: Date) {
  // G1
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
  // G2 without a WITH list: the source is one [schema.]table (the first was the violation case f03-insert-select).
  await tx.$executeRaw`INSERT INTO "AuditLog" (actor, action, target) SELECT ${actor}, 'syn.allowed', uid FROM "StudyState"`; // expect: resolved syn.allowed
  await tx.$executeRaw`INSERT INTO public."AuditLog" (action, actor, target) SELECT 'syn.hidden', ${actor}, "uid" FROM public."StudyState";`; // expect: resolved syn.hidden
  // G2 after a WITH list: the source is one of its names (the violation case f03-with).
  await tx.$executeRaw`WITH s AS (SELECT uid FROM "StudyState") INSERT INTO "AuditLog" (actor, action, target) SELECT ${actor}, 'syn.allowed', uid FROM s`; // expect: resolved syn.allowed
  // Columns in another order; registered actions in a WITH body, another item, a comment and a string holding commas and
  // parentheses; commas inside a function call.
  // expect: resolved syn.second
  await tx.$executeRaw`WITH one AS NOT MATERIALIZED (SELECT 'syn.hidden' AS kind, uid FROM "StudyState")
    INSERT INTO "AuditLog" (target, /* action, */ detail, action, actor)
    SELECT uid, json_build_object('action', kind, 'note', 'syn.allowed, (syn.hidden)')::text, 'syn.second', -- 'syn.hidden',
      lower(${actor}) FROM one`;
  // The action by a const interpolation after a WITH list with a column list, MATERIALIZED and a body that changes rows
  // of another table (the shape of the Connect writer).
  // expect: resolved syn.allowed
  await tx.$executeRaw`WITH picked (uid) AS MATERIALIZED (SELECT uid FROM "StudyState" WHERE uid = ${uid} FOR UPDATE),
    touched AS (UPDATE "StudyState" s SET ward = ${ward} FROM picked p WHERE s.uid = p.uid RETURNING s.uid)
    INSERT INTO "AuditLog" (actor, action, target, at) SELECT ${actor}, ${ACTION}, uid, ${at} FROM touched`;
}

// G2 with a fragment in a WITH body: every source of `selector` is the fixed predicate `[alias.]column = ${value}::type`
// (one caller passes it directly, the other through a const), as the Connect writer's two callers pass theirs.
export class SynLinked {
  private async linked(tx: Prisma.TransactionClient, actor: string, selector: Prisma.Sql, at: Date) {
    // expect: resolved syn.allowed
    await tx.$executeRaw`WITH picked AS (SELECT s.uid FROM "StudyState" s WHERE ${selector} FOR UPDATE)
      INSERT INTO "AuditLog" (actor, action, target, at) SELECT ${actor}, 'syn.allowed', uid, ${at} FROM picked`;
  }
  async byStudy(tx: Prisma.TransactionClient, actor: string, uid: string, at: Date) {
    await this.linked(tx, actor, Prisma.sql`s.uid=${uid}::text`, at);
  }
  async byWard(tx: Prisma.TransactionClient, actor: string, ward: string, at: Date) {
    const selector = Prisma.sql`s."ward" = ${ward}::text`;
    await this.linked(tx, actor, selector, at);
  }
}
