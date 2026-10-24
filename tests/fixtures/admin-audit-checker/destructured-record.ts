import { Prisma } from '@prisma/client';

interface Command { plan: { record: string; version: { recordId: string; versionId: string; sequence: number } } }

function copy(command: Command) { return structuredClone(command); }

export async function append(tx: Prisma.TransactionClient, command: Command) {
  const { plan } = command;
  copy(command);
  await tx.$executeRaw`INSERT INTO clinical_version(record, id, version, sequence)
    VALUES (${plan.record}, ${plan.version.recordId}, ${plan.version.versionId}, ${plan.version.sequence})`;
  await tx.auditLog.create({ data: { action: 'syn.record', target: plan.version.recordId } });
}

// Returning a composed instance does not change which private body this calls.
class Writer {
  private write(tx: Prisma.TransactionClient) {
    return tx.auditLog.create({ data: { action: 'syn.private' } });
  }
  run(tx: Prisma.TransactionClient) { return this.write(tx); }
}
export const createWriter = () => new Writer();
