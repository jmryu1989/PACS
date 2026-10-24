import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AccessEvent } from '../emr-contract/access-event';
import { refuse } from '../emr-contract/validation';
import { EMR_TX_MAX_WAIT_MS, EMR_TX_TIMEOUT_MS } from '../emr-runtime/limits';
import type { ClinicalRecord, ClinicalUnit } from './contract';
import { applyPlan, ClinicalWritePlan, projectUnit, RequestIdentity, WriteInput } from './records';
import type { ClinicalSignature } from './signing';

export interface StoredClinicalCommand {
  operationId: string;
  attemptId: string;
  identity: RequestIdentity;
  input: WriteInput;
  plan: Readonly<ClinicalWritePlan>;
  event: Readonly<AccessEvent>;
  projection: unknown;
}
export interface StoredClinicalVersion {
  plan: ClinicalWritePlan;
  signature: ClinicalSignature | null;
  operationId: string;
}
const options = { maxWait: EMR_TX_MAX_WAIT_MS, timeout: EMR_TX_TIMEOUT_MS };
const parse = <T>(text: string): T => JSON.parse(text);

/** D stores original commands and immutable versions. B2 alone owns admission,
 * terminal outcomes and COMMIT settlement; no D success/negative register. */
export class ClinicalStore {
  constructor(readonly db: PrismaClient) {}

  async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.db.$transaction(work, options);
  }

  async command(tx: Prisma.TransactionClient, identity: RequestIdentity): Promise<StoredClinicalCommand | null> {
    const k = identity.receiptKey;
    const rows = await tx.$queryRaw<{ body: string }[]>`SELECT body FROM emr_clinical.online_command
      WHERE record_type=${k.record} AND actor_id=${k.actorId} AND request_id=${k.requestId}`;
    if (!rows.length) return null;
    const command = parse<StoredClinicalCommand>(rows[0].body);
    if (command.identity.fingerprint !== identity.fingerprint) refuse('RequestIdReused');
    return command;
  }

  async prepare(identity: RequestIdentity, build: (tx: Prisma.TransactionClient,
    ids: { operationId: string; attemptId: string; versionId: string }) => Promise<Omit<StoredClinicalCommand, 'operationId' | 'attemptId' | 'identity'>>
  ): Promise<{ command: StoredClinicalCommand; created: boolean }> {
    return this.transaction(async tx => {
      const k = identity.receiptKey;
      // Serializes two honest deliveries of the same request before either
      // chooses a version/event. B2 later serializes their business commit.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['emr-d-request', k.record, k.actorId, k.requestId])}, 0))::text`;
      const previous = await this.command(tx, identity);
      if (previous) return { command: previous, created: false };
      const ids = { operationId: randomUUID(), attemptId: randomUUID(), versionId: randomUUID() };
      const command: StoredClinicalCommand = { ...(await build(tx, ids)), operationId: ids.operationId, attemptId: ids.attemptId, identity };
      await tx.$executeRaw`INSERT INTO emr_clinical.online_command(record_type, actor_id, request_id, operation_id, body)
        VALUES (${k.record}, ${k.actorId}, ${k.requestId}, ${ids.operationId}::uuid, ${JSON.stringify(command)})`;
      return { command, created: true };
    });
  }

  async lockUnit(tx: Prisma.TransactionClient, record: ClinicalRecord, recordId: string): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['emr-d-unit', record, recordId])}, 0))::text`;
  }

  async versions(tx: Prisma.TransactionClient, record: ClinicalRecord, recordId: string): Promise<StoredClinicalVersion[]> {
    const rows = await tx.$queryRaw<{ body: string; signature: string | null; operation_id: string }[]>`
      SELECT body, signature, operation_id::text FROM emr_clinical.online_version
      WHERE record_type=${record} AND record_id=${recordId} ORDER BY sequence`;
    return rows.map(row => ({ plan: parse<ClinicalWritePlan>(row.body),
      signature: row.signature === null ? null : parse<ClinicalSignature>(row.signature), operationId: row.operation_id }));
  }

  async unit(tx: Prisma.TransactionClient, record: ClinicalRecord, recordId: string): Promise<Readonly<ClinicalUnit> | null> {
    let unit: Readonly<ClinicalUnit> | null = null;
    for (const version of await this.versions(tx, record, recordId)) unit = applyPlan(unit, version.plan);
    return unit;
  }

  async version(tx: Prisma.TransactionClient, versionId: string): Promise<StoredClinicalVersion | null> {
    const rows = await tx.$queryRaw<{ body: string; signature: string | null; operation_id: string }[]>`
      SELECT body, signature, operation_id::text FROM emr_clinical.online_version WHERE version_id=${versionId}`;
    return rows.length ? { plan: parse<ClinicalWritePlan>(rows[0].body),
      signature: rows[0].signature === null ? null : parse<ClinicalSignature>(rows[0].signature), operationId: rows[0].operation_id } : null;
  }

  async append(tx: Prisma.TransactionClient, command: StoredClinicalCommand, signature: ClinicalSignature | null): Promise<void> {
    const { plan } = command;
    if ((plan.signing === null) !== (signature === null)) refuse('SignatureRequired');
    const current = await this.unit(tx, plan.record, plan.version.recordId);
    projectUnit(applyPlan(current, plan));
    await tx.$executeRaw`INSERT INTO emr_clinical.online_version
      (record_type, record_id, version_id, sequence, operation_id, body, signature)
      VALUES (${plan.record}, ${plan.version.recordId}, ${plan.version.versionId}, ${plan.version.sequence},
        ${command.operationId}::uuid, ${JSON.stringify(plan)}, ${signature === null ? null : JSON.stringify(signature)})`;
    for (const reference of plan.version.attachments) {
      await tx.$executeRaw`INSERT INTO emr_clinical.online_reference
        (version_id, source_kind, source_record_id, source_version_id, source_sha256)
        VALUES (${plan.version.versionId}, ${reference.kind}, ${reference.recordId}, ${reference.versionId}, ${reference.sha256})`;
    }
  }
}
