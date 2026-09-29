// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code): the forms of the closed list W1-W6
// (Astra S7-U3a-AUDIT-SPEC-C-R-001-F01) the writes and raw calls of api/src need, one each, and the normal controls F01-F03
// name (a string parameter in an audit INSERT; a method called, never replaced, next to a helper). Added to the baseline
// of tests/fixtures/admin_audit_completeness, each marked write is one resolved site with exactly the marked actions,
// each marked raw call is proven not a write, and the gate still passes; nothing else in the file is a candidate.
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

interface SynCaller { actor: string; institution: string }

export class SynSupported {
  // W3 a private helper: every call the program makes of it passes a W2 value
  private audit(tx: Prisma.TransactionClient, action: string) {
    return tx.auditLog.create({ data: { actor: 'syn', action, target: 'syn' } }); // expect: resolved syn.allowed syn.hidden syn.second
  }

  // W3 the one callback rule (the `scopeWrite` form): a private helper hands a local arrow to the callback its callers write
  private scoped(tx: Prisma.TransactionClient, work: (audit: (action: string) => Promise<unknown>) => Promise<unknown>) {
    const audit = (action: string) => tx.auditLog.create({ data: { actor: 'syn', action, target: 'syn' } }); // expect: resolved syn.allowed syn.hidden
    return work(audit);
  }

  async texts(tx: Prisma.TransactionClient, body: any) {
    // W2 (iii) a let of the function: its initializer and every plain assignment, one a ?: (the members console form)
    let action = 'allowed';
    if (body.a) action = 'second';
    else if (body.b) action = body.c ? 'hidden' : 'allowed';
    await tx.auditLog.create({ data: { actor: 'syn', action: `syn.${action}`, target: 'syn' } }); // expect: resolved syn.allowed syn.hidden syn.second
    // W2 (i) and (ii): a fixed start and both sides of ?: (the hanging protocol form)
    await tx.auditLog.create({ data: { actor: 'syn', action: 'syn.' + (body.d === null ? 'second' : 'hidden'), target: 'syn' } }); // expect: resolved syn.hidden syn.second
    // W2 a fixed start with a request value after it: a prefix a wildcard row must cover (the finding and viewer form)
    await tx.auditLog.create({ data: { actor: 'syn', action: 'syn.wild.' + body.kind, target: 'syn' } }); // expect: resolved prefix:syn.wild.
  }

  async helpers(tx: Prisma.TransactionClient, body: any) {
    // W2 (iv) a request value a preceding guard limits, through a template, to a W3 helper (the report commit form)
    const kind = body.kind;
    if (!body || !['allowed', 'second'].includes(kind)) throw new Error('SYN unknown kind');
    await this.audit(tx, `syn.${kind}`);
    await this.audit(tx, 'syn.hidden');
    // W3 a local arrow called directly (the gateway receipt form)
    const local = (action: string) => tx.auditLog.create({ data: { actor: 'syn', action, target: 'syn' } }); // expect: resolved syn.second
    await local('syn.second');
    // W3 the callback rule: every caller's callback calls the audit function it is handed, directly
    await this.scoped(tx, async audit => { await audit('syn.allowed'); });
    await this.scoped(tx, async audit => { if (body.x) await audit('syn.hidden'); });
  }

  // F02 values of raw calls that write no audit row (W6), each proven not a write
  async values(tx: Prisma.TransactionClient, c: SynCaller, uid: string, at: Date, body: any) {
    // a parameter declared a primitive or a Date, a declared member of a declared record, a template, `new Date()`
    await tx.$executeRaw`UPDATE "StudyState" SET ward = ${c.institution + '/' + uid}, "updatedAt" = ${at} WHERE uid = ${uid} AND ${new Date()} > ${at}`; // expect: proven_non_audit its SQL names no AuditLog
    // calls typed a primitive, and an array literal (one parameter, whatever it holds)
    await tx.$queryRaw`SELECT ${randomUUID()}::uuid AS id, ${String(body.x)} AS text, ${[body.a, body.b]} AS list`; // expect: proven_non_audit its SQL names no AuditLog
    // W6 JSON/Prisma results and their fields: a row a private helper returns (`?? null`), a destructured row, JSON.parse
    const row = await this.row(tx, uid);
    const [first] = await tx.$queryRaw<any[]>`SELECT uid FROM "StudyState" WHERE uid = ${uid}`; // expect: proven_non_audit its SQL names no AuditLog
    const cursor = body.cursor ? JSON.parse(String(body.cursor)) : null;
    await tx.$queryRaw`SELECT action FROM "AuditLog" WHERE target = ${row.uid} AND target <> ${first?.uid ?? ''} AND id > ${cursor?.id ?? 0}`; // expect: proven_non_audit one SELECT that changes no row
    // W6 an element of a delegate result
    for (const item of await tx.studyState.findMany({ where: { uid } })) await tx.$executeRaw`UPDATE "StudyState" SET ward = ${item.ward} WHERE uid = ${item.uid}`; // expect: proven_non_audit its SQL names no AuditLog
    // W3 a field of the object literal a private helper returns, and an element destructured from the array one returns
    const owner = this.owner(c);
    const [institution] = this.pair(c);
    await tx.$queryRaw`SELECT 1 FROM "StudyState" WHERE "institutionId" = ${owner.institution} AND "institutionId" = ${institution}`; // expect: proven_non_audit its SQL names no AuditLog
  }
  private async row(tx: Prisma.TransactionClient, uid: string) {
    const rows: any[] = await tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`; // expect: proven_non_audit its SQL names no AuditLog
    return rows[0] ?? null;
  }
  private owner(c: SynCaller) { return { institution: c.institution, actor: c.actor }; }
  private pair(c: SynCaller) { return [c.institution, c.actor]; }

  // The normal controls: a method called and never replaced next to a helper (F-F01), a string parameter in an audit
  // INSERT (C-RAW-CAST).
  private hook() { return 'syn'; }
  async controls(tx: Prisma.TransactionClient, value: string) {
    this.hook();
    await this.audit(tx, 'syn.allowed');
    await tx.$executeRaw`INSERT INTO "AuditLog" (action, target) VALUES ('syn.allowed', ${value})`; // expect: resolved syn.allowed
  }
}
