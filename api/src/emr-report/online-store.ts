import type { SigningTransaction, ServerKeyRegistration, WrappedServerPrivateKey, ServerSignedEnvelope } from '../emr-signature/server-contract';
import { refuse } from '../emr-contract/validation';
import { lockFixedRecord } from '../emr-runtime/fixed-record-lock';

export interface StoredApproval extends ServerSignedEnvelope {
  operationId: string;
  recordId: string;
  versionId: string;
  kid: string;
  doctorId: string;
  institutionId: string;
  keyAtSigning: ServerKeyRegistration;
}

/** PostgreSQL persistence only; every method uses the caller's existing B2 transaction. */
export class OnlineSigningStore {
  async lockDoctor(tx: SigningTransaction, institutionId: string, doctorId: string): Promise<void> {
    // Includes an as-yet unregistered doctor, so first provision and revoke/use share one lock.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['c2-key', institutionId, doctorId])}, 0))::text`;
  }

  async currentKey(tx: SigningTransaction, institutionId: string, doctorId: string): Promise<ServerKeyRegistration | null> {
    const rows = await tx.$queryRaw<{ registration: ServerKeyRegistration }[]>`
      SELECT registration FROM emr_signing.doctor_key WHERE institution_id=${institutionId} AND doctor_id=${doctorId}
      AND status='active' FOR UPDATE`;
    return rows[0]?.registration ?? null;
  }

  async key(tx: SigningTransaction, kid: string): Promise<ServerKeyRegistration | null> {
    const rows = await tx.$queryRaw<{ registration: ServerKeyRegistration }[]>`SELECT registration FROM emr_signing.doctor_key WHERE kid=${kid}`;
    return rows[0]?.registration ?? null;
  }

  async insertKey(tx: SigningTransaction, key: ServerKeyRegistration, wrapped: WrappedServerPrivateKey): Promise<void> {
    await tx.$executeRaw`INSERT INTO emr_signing.doctor_key(kid,institution_id,doctor_id,status,registration)
      VALUES (${key.kid},${key.doctor.institutionId},${key.doctor.identity.id},${key.status},${JSON.stringify(key)}::jsonb)`;
    await tx.$executeRaw`INSERT INTO emr_signing.private_key(kid,wrapped) VALUES (${key.kid},${JSON.stringify(wrapped)}::jsonb)`;
  }

  async endKey(tx: SigningTransaction, key: ServerKeyRegistration, status: 'suspended' | 'revoked', at: string): Promise<void> {
    const ended = { ...key, status, endedAt: key.endedAt ?? at };
    await tx.$executeRaw`UPDATE emr_signing.doctor_key SET status=${status},registration=${JSON.stringify(ended)}::jsonb WHERE kid=${key.kid}`;
  }

  async privateKey(tx: SigningTransaction, kid: string): Promise<WrappedServerPrivateKey> {
    const rows = await tx.$queryRaw<{ wrapped: WrappedServerPrivateKey }[]>`SELECT wrapped FROM emr_signing.private_key WHERE kid=${kid}`;
    if (!rows[0]) refuse('ServerPrivateKeyUnavailable');
    return rows[0].wrapped;
  }

  async keyHistory(tx: SigningTransaction, kid: string, event: object): Promise<void> {
    await tx.$executeRaw`INSERT INTO emr_signing.key_history(kid,event) VALUES (${kid},${JSON.stringify(event)}::jsonb)`;
  }

  async history(tx: SigningTransaction, kid: string): Promise<unknown[]> {
    const rows = await tx.$queryRaw<{ event: unknown }[]>`SELECT event FROM emr_signing.key_history WHERE kid=${kid} ORDER BY sequence`;
    return rows.map(row => row.event);
  }

  async operation(tx: SigningTransaction, operationId: string, fingerprint: string): Promise<StoredApproval | null> {
    await tx.$executeRaw`INSERT INTO emr_signing.operation(operation_id,fingerprint) VALUES (${operationId},${fingerprint}) ON CONFLICT DO NOTHING`;
    const [row] = await tx.$queryRaw<{ fingerprint: string; outcome: StoredApproval | null }[]>`
      SELECT fingerprint,outcome FROM emr_signing.operation WHERE operation_id=${operationId} FOR UPDATE`;
    if (row.fingerprint !== fingerprint) refuse('SigningOperationConflict');
    return row.outcome;
  }

  async result(tx: SigningTransaction, operationId: string): Promise<StoredApproval | null> {
    const rows = await tx.$queryRaw<{ outcome: StoredApproval | null }[]>`SELECT outcome FROM emr_signing.operation WHERE operation_id=${operationId}`;
    return rows[0]?.outcome ?? null;
  }

  async save(tx: SigningTransaction, result: StoredApproval): Promise<void> {
    await lockFixedRecord(tx, result.recordId);
    await tx.$executeRaw`INSERT INTO emr_signing.signed_version(record_id,version_id,kid,outcome)
      VALUES (${result.recordId},${result.versionId},${result.kid},${JSON.stringify(result)}::jsonb)`;
    const changed = await tx.$executeRaw`UPDATE emr_signing.operation SET outcome=${JSON.stringify(result)}::jsonb
      WHERE operation_id=${result.operationId} AND outcome IS NULL`;
    if (changed !== 1) refuse('SigningOperationAlreadyCompleted');
  }
}
