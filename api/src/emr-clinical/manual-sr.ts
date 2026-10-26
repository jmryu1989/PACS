import { ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ManualSr, Prisma } from '@prisma/client';
import { ContractError, refuse } from '../emr-contract/validation';
import { OnlineSigningStore, StoredApproval } from '../emr-report/online-store';
import type { ClinicalRuntimeParts } from './runtime';
import { planManualSrAdoption } from './records';

export const EMR_MANUAL_SR_SIGNING = Symbol('EMR_MANUAL_SR_SIGNING');
type SrApproval = StoredApproval & { plan: string };
const known = <T>(value: T) => ({ status: 'known' as const, value });
const operation = (id: string) => 'manual-sr:' + id;

/** The store intent is the author's signed entry. Orthanc acknowledgement is
 * bookkeeping against that retained intent, including after the author leaves.
 * C2 retains its signature and B1 owns the transaction and its outcome. */
export class ManualSrSigning {
  private readonly store = new OnlineSigningStore();
  constructor(private readonly parts: Pick<ClinicalRuntimeParts, 'records' | 'context' | 'signer'>) {}

  async authorized(tx: Prisma.TransactionClient, row: ManualSr): Promise<SrApproval> {
    const saved = await this.store.result(tx, operation(row.id)) as SrApproval | null;
    if (!saved || !row.attemptedAt) refuse('ManualSrAuthorizationUnavailable');
    // JSONB reorders object keys. Retain the plan's original JSON text because
    // C2 signs the serialized content in that plan.
    const plan: ReturnType<typeof planManualSrAdoption> = JSON.parse(saved.plan);
    const bytesSha256 = row.dicom && createHash('sha256').update(Buffer.from(row.dicom)).digest('hex');
    if (!plan || plan.adoption.recordId !== row.id || plan.adoption.studyId !== row.studyUid ||
        plan.adoption.author.subject !== row.authorSub || plan.adoption.bytesSha256 !== row.sha256 ||
        bytesSha256 !== row.sha256 || plan.adoption.sopInstanceUid !== (row.dataset as any)?.SOPInstanceUID ||
        plan.adoption.at !== row.attemptedAt.toISOString()) refuse('ManualSrAuthorizationConflict');
    this.parts.signer.verify({ envelope: saved.envelope, registration: saved.keyAtSigning,
      signedAt: saved.signedAt, payloadSha256: saved.versionSha256 }, plan.signing);
    return saved;
  }

  async authorize<T>(request: object, task: (tx: Prisma.TransactionClient,
    sign: (row: ManualSr, at: Date) => Promise<void>) => Promise<T>): Promise<T> {
    const work = this.parts.records.begin();
    try {
      return await work.transactionWithRecords((tx, record) => task(tx, async (row, at) => {
        const facts = await this.parts.context.facts(tx, request);
        const study = await this.parts.context.study(tx, request, row.studyUid);
        if (facts.actor.identity.subject !== row.authorSub) refuse('ActorPathRefused');
        // Bind the prepared document's patient, not a newly observed patient
        // that might now occupy the same study identifier.
        if ((row.dataset as any)?.PatientID !== study.patient.patientId) refuse('ManualSrPatientChanged');
        const plan = planManualSrAdoption({ actor: facts.actor, study, versionId: '1', at: at.toISOString(), sr: {
          id: row.id, studyId: row.studyUid, authorId: facts.actor.identity.id,
          createdAt: row.createdAt.toISOString(), attemptedAt: null, storedAt: null,
          bytesSha256: row.sha256, sopInstanceUid: (row.dataset as any).SOPInstanceUID,
          adoptedVersion: null, referencedBy: [], holdIds: [], orthanc: 'unknown',
        } });
        const fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
        await this.store.operation(tx, operation(row.id), fingerprint);
        const event = { formatVersion: 1 as const, surface: plan.access.route, eventId: randomUUID(),
          userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles),
          actingInstitution: known(facts.actor.institutionId), managingInstitution: known(study.managingInstitutionId),
          occurredAt: at.toISOString(), trustedProxyIp: facts.ip, cause: 'user-view' as const,
          context: { basis: 'worklist' as const, studyId: row.studyUid, relatedStudyId: null, reason: null },
          executor: 'member' as const, targets: [{ kind: 'manual-sr' as const,
            patientLinkSnapshot: known(study.patient), studyId: known(row.studyUid), recordId: known(row.id), versionId: known('1') }],
          action: plan.access.action, result: 'succeeded' as const, requestId: facts.requestId,
          auditLinkId: 'audit:' + randomUUID(), relatedEventId: null };
        await record(event, async () => {
          const signature = await this.parts.signer.sign(tx, request, plan.signing);
          const saved: SrApproval = { plan: JSON.stringify(plan), envelope: signature.envelope, signedAt: signature.signedAt,
            versionSha256: signature.payloadSha256, operationId: operation(row.id), recordId: row.id, versionId: '1',
            kid: signature.registration.kid, doctorId: facts.actor.identity.id, institutionId: facts.actor.institutionId,
            keyAtSigning: signature.registration };
          await this.store.save(tx, saved);
          return { kind: 'ManualSr', id: row.id, version: '1' };
        });
      }));
    } catch (error) {
      if (error instanceof ContractError) throw new ServiceUnavailableException({ code: error.code,
        message: 'SR 저장을 완료하지 못했습니다. 입력을 유지하고 같은 요청을 다시 확인하세요.' });
      throw error;
    } finally { work.end(); }
  }
}
