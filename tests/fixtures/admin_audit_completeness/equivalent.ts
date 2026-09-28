// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code): the supported notations, the finite list
// (a)-(i) of Astra S7-U3a-AUDIT-SPEC-R-001-F02. Added to the baseline, each marked write is one resolved site with exactly
// the marked actions, and the gate still passes; nothing else in the file is a candidate.
import { Prisma } from '@prisma/client';
import { SYN_ALLOWED as MOVED, RE_EXPORTED } from './actions';
import * as ACTIONS from './actions';
import { FORWARDED } from './forward';

const ACTION = 'syn.allowed';
const LOG = 'auditLog';
const LOG_PIECES = 'audit' + 'Log';
const CREATE = 'create';
const DATA = 'data';
const COL = 'action';
const SYN = 'syn';
const TABLE = { syn: { allowed: 'syn.allowed', hidden: 'syn.hidden' } } as const;
enum Kind { Allowed = 'syn.allowed' }

export class SynEquivalent {
  private static readonly FIELD = 'syn.allowed';
  private readonly field = 'syn.second';

  private audit(tx: Prisma.TransactionClient, action: string) {
    return tx.auditLog.create({ data: { action } }); // expect: resolved syn.allowed syn.second
  }

  private scoped(tx: Prisma.TransactionClient, work: (audit: (action: string) => Promise<unknown>) => Promise<unknown>) {
    const audit = (action: string) => tx.auditLog.create({ data: { action } }); // expect: resolved syn.hidden
    return work(audit);
  }

  async write(tx: Prisma.TransactionClient, body: any) {
    // (a) comments, line breaks, trailing commas, parentheses and assertions around the delegate and the value
    await (tx.auditLog as any).create({ data: { /* the row */ action: (ACTION as string)!, }, }); // expect: resolved syn.allowed
    // (b) keys that are one string, for the delegate, its method, `data` and `action`; the last definition wins
    await tx[LOG].create({ data: { action: 'syn.allowed' } }); // expect: resolved syn.allowed
    await tx[LOG_PIECES]['create']({ data: { action: 'syn.allowed' } }); // expect: resolved syn.allowed
    await tx['auditLog'][CREATE]({ [DATA]: { [COL]: 'syn.allowed' } }); // expect: resolved syn.allowed
    await tx.auditLog.create({ data: { action: 'syn.unlisted', [COL]: 'syn.allowed' } }); // expect: resolved syn.allowed
    await tx.auditLog.create({ data: { ...body.extra, action: 'syn.allowed' } }); // expect: resolved syn.allowed
    // (c) templates and + of fixed pieces
    await tx.auditLog.create({ data: { action: `${SYN}.allowed` } }); // expect: resolved syn.allowed
    await tx.auditLog.create({ data: { action: SYN + '.' + 'allowed' } }); // expect: resolved syn.allowed
    // (d) a const renamed on import, re-exported, forwarded from another module, read through a namespace
    await tx.auditLog.create({ data: { action: MOVED } }); // expect: resolved syn.allowed
    await tx.auditLog.create({ data: { action: RE_EXPORTED } }); // expect: resolved syn.allowed
    await tx.auditLog.create({ data: { action: FORWARDED } }); // expect: resolved syn.allowed
    await tx.auditLog.create({ data: { action: ACTIONS.SYN_ALLOWED } }); // expect: resolved syn.allowed
    // (e) an `as const` table nothing changes or hands on, a string enum member, readonly fields
    await tx.auditLog.create({ data: { action: TABLE.syn.allowed } }); // expect: resolved syn.allowed
    await tx.auditLog.create({ data: { action: TABLE['syn'][SYN === 'syn' ? 'hidden' : 'allowed'] } }); // expect: resolved syn.allowed syn.hidden
    await tx.auditLog.create({ data: { action: Kind.Allowed } }); // expect: resolved syn.allowed
    await tx.auditLog.create({ data: { action: SynEquivalent.FIELD } }); // expect: resolved syn.allowed
    await tx.auditLog.create({ data: { action: this.field } }); // expect: resolved syn.second
    // (f) every side of ?:, || and ??
    await tx.auditLog.create({ data: { action: body.x ? 'syn.allowed' : 'syn.second' } }); // expect: resolved syn.allowed syn.second
    await tx.auditLog.create({ data: { action: ACTION || 'syn.second' } }); // expect: resolved syn.allowed syn.second
    // (g) a let with every value assigned to it
    let chosen = 'syn.allowed';
    if (body.again) chosen = 'syn.second';
    await tx.auditLog.create({ data: { action: chosen } }); // expect: resolved syn.allowed syn.second
    // (h) a private helper, a local arrow and a callback, with every call the program makes of each
    await this.audit(tx, 'syn.allowed');
    await this.audit(tx, MOVED === ACTION ? 'syn.second' : 'syn.allowed');
    const local = (action: string) => tx.auditLog.create({ data: { action } }); // expect: resolved syn.allowed
    await local(MOVED);
    await this.scoped(tx, audit => audit('syn.hidden'));
    // (i) a guard of the same flow that exits for every other value, before the write, on a binding nothing changes
    const kind = body.kind;
    if (!body || !['syn.allowed', 'syn.second'].includes(kind)) throw new Error('SYN unknown kind');
    await tx.auditLog.create({ data: { action: kind } }); // expect: resolved syn.allowed syn.second
  }
}
