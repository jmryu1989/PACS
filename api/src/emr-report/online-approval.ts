import { createHash, randomUUID } from 'node:crypto';
import { patientLink } from '../emr-contract/access-event';
import { transitionReport, LifecycleCommand } from '../emr-contract/report-lifecycle';
import { choice, freeze, integer, object, refuse, string } from '../emr-contract/validation';
import type { LedgerPort, RequestIdentityPort, SigningEvent, ServerSigningContent } from '../emr-signature/server-contract';
import { clinicalIdentity, ServerKeys } from '../emr-signature/server-keys';
import { ServerSigning } from '../emr-signature/server-signing';
import { institutionAllows, parseStudyFacts } from './contract';
import { expectedPreviousVersion } from './commands';
import type { OnlineReportBoundary } from './current-study';
import { OnlineSigningStore, StoredApproval } from './online-store';

export function parseOnlineApproval(input: unknown) {
  const v = object(input, ['operationId', 'action', 'recordId', 'studyId', 'patient', 'expectedClaimGeneration',
    'expectedPublishedVersionId', 'submittedDraftRevision', 'text', 'reason']);
  const t = object(v.text, ['findings', 'conclusion', 'recommendation']);
  return freeze({ operationId: string(v.operationId), action: choice(v.action, ['approve', 'amend', 'addendum', 'cancel'] as const),
    recordId: string(v.recordId), studyId: string(v.studyId), patient: patientLink(v.patient),
    expectedClaimGeneration: integer(v.expectedClaimGeneration),
    expectedPublishedVersionId: v.expectedPublishedVersionId === null ? null : string(v.expectedPublishedVersionId),
    submittedDraftRevision: v.submittedDraftRevision === null ? null : string(v.submittedDraftRevision),
    text: { kind: 'report' as const, findings: string(t.findings, true), conclusion: string(t.conclusion, true), recommendation: string(t.recommendation, true) },
    reason: v.reason === null ? null : string(v.reason) });
}

export class OnlineApproval {
  constructor(private readonly ledger: LedgerPort, private readonly identities: RequestIdentityPort,
    private readonly reports: OnlineReportBoundary, private readonly store: OnlineSigningStore,
    private readonly keys: ServerKeys, private readonly signing: ServerSigning) {}

  /** Called only by an explicit online clinical command, never a poll, login, save or reconnect worker. */
  async approve(request: object, input: unknown): Promise<StoredApproval> {
    const command = parseOnlineApproval(input);
    return this.ledger.transactionWithRecords(async (tx, record) => {
      const currentIdentity = clinicalIdentity(await this.identities.resolve(tx, request));
      const { actor } = currentIdentity;
      const fingerprint = createHash('sha256').update(JSON.stringify({ command, identity: actor.identity,
        registration: actor.identityRegistrationId, institution: actor.institutionId })).digest('hex');
      const previous = await this.store.operation(tx, command.operationId, fingerprint);
      if (previous) {
        await this.reports.authorizeResult(tx, currentIdentity, previous);
        await record(this.viewEvent(currentIdentity, previous), async () => ({ kind: 'report-version', id: previous.recordId, version: previous.versionId }));
        return freeze(previous);
      }
      const current = await this.reports.lock(tx, currentIdentity, command.recordId);
      const study = parseStudyFacts(current.study);
      if (!institutionAllows(actor, study) || current.facts.recordId !== command.recordId || study.studyId !== command.studyId ||
          current.facts.studyId !== study.studyId || JSON.stringify(study.patient) !== JSON.stringify(command.patient)) refuse('SigningStudyConflict');
      if (current.facts.claimGeneration !== command.expectedClaimGeneration ||
          (current.facts.publishedVersion?.versionId ?? null) !== command.expectedPublishedVersionId) refuse('SigningReportConflict');
      const key = await this.keys.forApproval(tx, currentIdentity);
      const versionId = randomUUID();
      const content: ServerSigningContent = { formatVersion: 'emr-signature/1', text: command.text, patient: study.patient,
        studyId: study.studyId, managingInstitutionId: study.managingInstitutionId, actingInstitutionId: actor.institutionId,
        recordKind: 'report-version', recordId: command.recordId, versionId, author: current.author, signer: actor.identity,
        identityRegistrationId: actor.identityRegistrationId, action: command.action === 'approve' ? 'approve-sign' : command.action,
        previousVersion: expectedPreviousVersion(current.facts, command.action), attachments: current.attachments, reason: command.reason };
      const signed = await this.signing.sign(tx, currentIdentity, key, content);
      const approval: StoredApproval = { ...signed, operationId: command.operationId, recordId: command.recordId, versionId,
        kid: key.kid, doctorId: actor.identity.id, institutionId: actor.institutionId, keyAtSigning: key };
      const lifecycle: LifecycleCommand = { action: command.action, actor: { id: actor.identity.id, kind: actor.kind, roles: actor.roles,
        canReadStudy: true, canSign: actor.canSign, canCancel: actor.canCancel }, at: signed.signedAt,
        expectedClaimGeneration: command.expectedClaimGeneration, expectedPublishedVersionId: command.expectedPublishedVersionId,
        version: { recordId: command.recordId, versionId, sha256: signed.versionSha256 }, reason: command.reason ?? undefined,
        eventId: command.operationId };
      // Reuse A's clinical rules; the report owner also performs its retained-source checks below.
      transitionReport(current.facts, lifecycle);
      await this.reports.validate(tx, current, lifecycle, approval);
      const event: SigningEvent = { eventId: randomUUID(), operationId: command.operationId, actor: actor.identity,
        roles: actor.roles, managingInstitutionId: study.managingInstitutionId,
        institutionId: actor.institutionId, at: signed.signedAt, ingress: currentIdentity.ingress, task: content.action as SigningEvent['task'],
        result: 'succeeded', doctorId: actor.identity.id, kid: key.kid, patient: study.patient, studyId: study.studyId,
        recordId: command.recordId, versionId };
      let recorded = false;
      await record(event, async () => {
        await this.store.save(tx, approval);
        await this.reports.publish(tx, current, lifecycle, approval, command.submittedDraftRevision);
        recorded = true;
        return { kind: 'report-version', id: command.recordId, version: versionId };
      });
      if (!recorded) refuse('ApprovalNotRecorded');
      return freeze(approval);
    });
  }

  /** A missing outcome is unresolved, never evidence that a lost COMMIT rolled back. No signing occurs here. */
  async result(request: object, operationId: string): Promise<StoredApproval | null> {
    string(operationId);
    return this.ledger.transactionWithRecords(async (tx, record) => {
      const current = clinicalIdentity(await this.identities.resolve(tx, request));
      const result = await this.store.result(tx, operationId);
      if (!result) return null;
      if (result.doctorId !== current.actor.identity.id || result.institutionId !== current.actor.institutionId) refuse('SigningResultOwnerMismatch');
      await this.reports.authorizeResult(tx, current, result);
      await record(this.viewEvent(current, result), async () => ({ kind: 'report-version', id: result.recordId, version: result.versionId }));
      return freeze(result);
    });
  }

  private viewEvent(current: Awaited<ReturnType<RequestIdentityPort['resolve']>>, result: StoredApproval): SigningEvent {
    const payload = JSON.parse(Buffer.from(result.envelope.payload, 'base64url').toString('utf8'));
    return { eventId: randomUUID(), operationId: randomUUID(), actor: current.actor.identity, institutionId: current.actor.institutionId,
      roles: current.actor.roles, managingInstitutionId: payload.managingInstitutionId,
      at: new Date().toISOString(), ingress: current.ingress, task: 'view', result: 'succeeded', doctorId: result.doctorId,
      kid: result.kid, patient: payload.patient, studyId: payload.studyId, recordId: result.recordId, versionId: result.versionId };
  }
}
