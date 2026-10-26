import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { refuse } from '../emr-contract/validation';
import type { ClinicalContextSource } from '../emr-clinical/runtime';
import type { EmrRecordPort } from '../emr-runtime/record-port';
import type { RequestIdentityPort, WrappingSecrets } from '../emr-signature/server-contract';
import { pgSigningLedger } from '../emr-signature/pg-ledger';
import { clinicalIdentity, ServerKeys } from '../emr-signature/server-keys';
import { ServerSigning } from '../emr-signature/server-signing';
import { verifyRegisteredServerEnvelope } from '../emr-signature/server-verification';
import { OnlineSigningStore, StoredApproval } from './online-store';

export const EMR_NATIVE_REPORT_SIGNING = Symbol('EMR_NATIVE_REPORT_SIGNING');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The native report state machine owns publication and its B2 transaction.
 * C2 owns keys and crypto; A supplies the current patient/study identity. */
export class NativeReportSigning {
  private readonly store = new OnlineSigningStore();
  private readonly keys: ServerKeys;
  private readonly signing: ServerSigning;
  constructor(private readonly parts: {
    records: EmrRecordPort; identity: RequestIdentityPort; secrets: WrappingSecrets;
    context: Pick<ClinicalContextSource, 'study'>;
  }) {
    this.keys = new ServerKeys(pgSigningLedger(parts.records), parts.identity, this.store, parts.secrets);
    this.signing = new ServerSigning(this.keys);
  }

  async sign(tx: Prisma.TransactionClient, request: object, operationId: string,
    version: { uid: string; version: number; action: string; [key: string]: unknown }, previous: number): Promise<StoredApproval> {
    const current = clinicalIdentity(await this.parts.identity.resolve(tx, request));
    const study = await this.parts.context.study(tx, request, version.uid);
    if (study.studyId !== version.uid) refuse('SigningStudyConflict');
    const recordId = version.uid, versionId = String(version.version);
    const fingerprint = digest({ version, actor: current.actor.identity, institution: current.actor.institutionId });
    const existing = await this.store.operation(tx, operationId, fingerprint);
    if (existing) return existing;
    const before = previous ? await tx.reportVersion.findUnique({ where: { uid_version: { uid: version.uid, version: previous } } }) : null;
    if (previous && !before) refuse('PreviousVersionRequired');
    const key = await this.keys.forApproval(tx, current);
    // Include the entire native snapshot (citations/structured data/reason too),
    // so the signature cannot describe a different preserved report version.
    const signed = await this.signing.sign(tx, current, key, {
      formatVersion: 'emr-signature/1', text: { kind: 'clinical-entry', body: JSON.stringify(version) },
      patient: study.patient, studyId: study.studyId, managingInstitutionId: study.managingInstitutionId,
      actingInstitutionId: current.actor.institutionId, recordKind: 'report-version', recordId, versionId,
      author: current.actor.identity, signer: current.actor.identity,
      identityRegistrationId: current.actor.identityRegistrationId,
      action: version.action === 'approve' ? 'approve-sign' : version.action === 'reset' ? 'cancel' : 'addendum',
      previousVersion: before ? { recordId: before.uid,
        versionId: String(before.version), sha256: digest(before) } : null,
      attachments: [], reason: typeof version.reason === 'string' ? version.reason : null,
    });
    verifyRegisteredServerEnvelope(signed.envelope, key);
    const approval: StoredApproval = { ...signed, operationId, recordId, versionId, kid: key.kid,
      doctorId: current.actor.identity.id, institutionId: current.actor.institutionId, keyAtSigning: key };
    await this.store.save(tx, approval);
    return approval;
  }
}
