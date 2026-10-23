// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code): CW21, a record a class keeps in a
// private readonly parameter property (S9-U4b part (c) U4BB4-02, Astra consult u4bb4_02_shape; the form of
// api/src/study-transfer-local.service.ts's ApprovalStage). The same raw read and audit write of one record value in two
// forms - a class `SynStage` that keeps the attempt's record and its own expiry, and the equivalent plain record judged by
// a free function - so the two give the same SQL bound values and the same writers and actions. Read as a corpus of its
// own (no other closed-world file); `// expect:` marks the candidate of its line as in the other fixtures; `@cw:<tag>`
// names a line for cases.json's record_flow.
import { Prisma, PrismaClient } from '@prisma/client';

export class SynRecordPrisma extends PrismaClient {}

interface SynTarget { uid: string; operationId: string; stop: string | null }
type SynReason = 'aborted' | 'fenced';

function synStop(t: SynTarget, reason: SynReason): string {
  if (t.stop !== 'fenced') t.stop = reason;
  return t.stop;
}

/** The class form: the stage keeps its attempt's record and its own expiry, and writes its own audit row. */
class SynStage {
  private expired = false;

  constructor(private readonly target: SynTarget, readonly deadline: number, private readonly reason: SynReason) {}

  expire(): string {
    this.expired = true;
    return synStop(this.target, this.reason);
  }

  stopped(): string | null {
    if (this.expired || Date.now() >= this.deadline) return this.expire();
    return this.target.stop;
  }

  record(tx: Prisma.TransactionClient, actor: string) {
    return tx.auditLog.create({ data: { actor, action: 'synrecord.stage', target: this.target.uid } }); // @cw:class-audit // expect: resolved synrecord.stage
  }
}

/** The record form: the same expiry as a plain record and a free function. */
interface SynRecordStage { readonly deadline: number; expired: boolean }

function synStageStopped(t: SynTarget, stage: SynRecordStage, reason: SynReason): string | null {
  if (!stage.expired && Date.now() >= stage.deadline) stage.expired = true;
  return stage.expired ? synStop(t, reason) : t.stop;
}

export class SynSupply {
  constructor(private readonly prisma: SynRecordPrisma) {}

  async classForm(uid: string, operationId: string, actor: string) {
    const t: SynTarget = { uid, operationId, stop: null };
    const stage = new SynStage(t, Date.now() + 5000, 'fenced'); // @cw:class-new
    return this.classLocked(t, stage, actor);
  }

  private classLocked(t: SynTarget, stage: SynStage, actor: string) {
    return this.prisma.$transaction(async tx => {
      if (stage.stopped()) throw new Error('stopped');
      await stage.record(tx, actor); // @cw:class-record-call
      return tx.$queryRaw`SELECT status FROM "ImportOperation" WHERE id = ${t.operationId}::uuid AND "studyUid" = ${t.uid} FOR UPDATE`; // @cw:class-read // expect: proven_non_audit its SQL names no AuditLog
    });
  }

  async recordForm(uid: string, operationId: string, actor: string) {
    const t: SynTarget = { uid, operationId, stop: null };
    const stage: SynRecordStage = { deadline: Date.now() + 5000, expired: false };
    return this.recordLocked(t, stage, actor);
  }

  private recordLocked(t: SynTarget, stage: SynRecordStage, actor: string) {
    return this.prisma.$transaction(async tx => {
      if (synStageStopped(t, stage, 'fenced')) throw new Error('stopped');
      await tx.auditLog.create({ data: { actor, action: 'synrecord.stage', target: t.uid } }); // @cw:record-audit // expect: resolved synrecord.stage
      return tx.$queryRaw`SELECT status FROM "ImportOperation" WHERE id = ${t.operationId}::uuid AND "studyUid" = ${t.uid} FOR UPDATE`; // @cw:record-read // expect: proven_non_audit its SQL names no AuditLog
    });
  }
}
// end of constructor-record-flow.ts
