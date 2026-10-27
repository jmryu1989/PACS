import { ConflictException, ForbiddenException, GoneException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ManualSr, Prisma } from '@prisma/client';
import { ContractError, refuse } from '../emr-contract/validation';
import { OnlineSigningStore, StoredApproval } from '../emr-report/online-store';
import type { ClinicalRuntimeParts } from './runtime';
import { manualSrAdoptionDigest, planManualSrAdoption } from './records';

export const EMR_MANUAL_SR_SIGNING = Symbol('EMR_MANUAL_SR_SIGNING');
type SrApproval = StoredApproval & { plan: string };
const known = <T>(value: T) => ({ status: 'known' as const, value });
const operation = (id: string) => 'manual-sr:' + id;

/** The retained approval of an attempted SR does not verify. Its row, plan and
 * signature are fixed, so no later retry or background pass can change this. */
export class ManualSrApprovalRefused extends ConflictException {
  constructor(readonly code: string) {
    super({ code, message: '이 SR의 보존된 서명 승인을 확인할 수 없어 저장을 완료할 수 없습니다. 같은 요청을 반복하지 말고 관리자에게 알리세요.' });
  }
}

// Refusals a same-request retry of this SR cannot pass. Anything else (key
// state, a changed study scope) is answered as retryable.
const permanent: Record<string, (code: string) => HttpException> = {
  PreparationExpired: code => new GoneException({ code, message: 'SR 준비 파일의24시간 보관 기한이 지났습니다. 새 파일을 준비하세요' }),
  ManualSrPatientChanged: code => new ConflictException({ code, message: '검사의 원본 환자가 SR 준비 때와 다릅니다. 새 SR을 준비하세요' }),
  SigningIdentityRequired: code => new ForbiddenException({ code, message: '서명할 수 있는 판독의 계정으로 저장하세요' }),
  ActorPathRefused: code => new ForbiddenException({ code, message: '이 측정의 SR을 만들거나 저장할 수 없습니다' }),
  NotFound: code => new ForbiddenException({ code, message: '이 측정의 SR을 만들거나 저장할 수 없습니다' }),
};
const refusal = (code: string) => permanent[code]?.(code) ?? new ServiceUnavailableException({ code,
  message: 'SR 저장을 완료하지 못했습니다. 입력을 유지하고 같은 요청을 다시 확인하세요.' });

/** The store intent is the author's signed entry. Orthanc acknowledgement is
 * bookkeeping against that retained intent, including after the author leaves.
 * C2 retains its signature and B1 owns the transaction and its outcome. */
export class ManualSrSigning {
  private readonly store = new OnlineSigningStore();
  constructor(private readonly parts: Pick<ClinicalRuntimeParts, 'records' | 'store' | 'context' | 'signer'>) {}

  async authorized(tx: Prisma.TransactionClient, row: ManualSr): Promise<SrApproval> {
    try { return await this.verified(tx, row); } catch (error) {
      if (error instanceof ContractError) throw new ManualSrApprovalRefused(error.code);
      throw error;
    }
  }

  private async verified(tx: Prisma.TransactionClient, row: ManualSr): Promise<SrApproval> {
    const saved = await this.store.result(tx, operation(row.id)) as SrApproval | null;
    if (!saved || !row.attemptedAt) refuse('ManualSrAuthorizationUnavailable');
    // JSONB reorders object keys. Retain the plan's original JSON text because
    // C2 signs the serialized content in that plan.
    let plan: ReturnType<typeof planManualSrAdoption>;
    try { plan = JSON.parse(saved.plan); } catch { refuse('ManualSrAuthorizationConflict'); }
    const bytesSha256 = row.dicom && createHash('sha256').update(Buffer.from(row.dicom)).digest('hex');
    const sop = (row.dataset as any)?.SOPInstanceUID;
    const adoption = plan?.adoption, signing = plan?.signing;
    if (!adoption || !signing || adoption.recordId !== row.id || adoption.studyId !== row.studyUid ||
        adoption.author?.subject !== row.authorSub || adoption.bytesSha256 !== row.sha256 ||
        bytesSha256 !== row.sha256 || adoption.sopInstanceUid !== sop ||
        adoption.at !== row.attemptedAt.toISOString()) refuse('ManualSrAuthorizationConflict');
    // The signature covers plan.signing. It must name this row's bytes and the
    // retained adoption, or a valid signature over other content would pass.
    const digest = manualSrAdoptionDigest(adoption);
    if (adoption.sha256 !== digest || signing.versionSha256 !== digest || signing.recordId !== row.id ||
        signing.versionId !== adoption.versionId || signing.studyId !== row.studyUid ||
        !signing.content || signing.content.kind !== 'dicom' || signing.content.sha256 !== row.sha256 || signing.content.sopInstanceUid !== sop ||
        signing.author?.subject !== row.authorSub || JSON.stringify(signing.author) !== JSON.stringify(adoption.author) ||
        JSON.stringify(signing.patient) !== JSON.stringify(adoption.patient) ||
        signing.managingInstitutionId !== adoption.managingInstitutionId) refuse('ManualSrAuthorizationConflict');
    this.parts.signer.verify({ envelope: saved.envelope, registration: saved.keyAtSigning,
      signedAt: saved.signedAt, payloadSha256: saved.versionSha256 }, signing);
    return saved;
  }

  async authorize<T>(request: object, studyUid: string, task: (tx: Prisma.TransactionClient,
    sign: (row: ManualSr, at: Date) => Promise<void>) => Promise<T>): Promise<T> {
    const work = this.parts.records.begin();
    try {
      // The patient observation reads Orthanc. Take it before the task locks the
      // study and SR rows; under the locks only the institution is rechecked.
      const study = await this.parts.store.transaction(tx => this.parts.context.study(tx, request, studyUid));
      return await work.transactionWithRecords((tx, record) => task(tx, async (row, at) => {
        const facts = await this.parts.context.facts(tx, request);
        const state = await tx.studyState.findUnique({ where: { uid: row.studyUid } });
        if (row.studyUid !== study.studyId || state?.institutionId !== study.managingInstitutionId) refuse('StudyScopeChanged');
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
      if (error instanceof ContractError) throw refusal(error.code);
      throw error;
    } finally { work.end(); }
  }
}
