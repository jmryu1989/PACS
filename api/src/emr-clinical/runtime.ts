import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { AccessEvent, AccessEventV1, EvidenceFact, newAuditLinkId, parseAccessEvent } from '../emr-contract/access-event';
import { freeze, refuse } from '../emr-contract/validation';
import type { EmrRecordPort, EmrRecordWork } from '../emr-runtime/record-port';
import type { OperationResult } from '../emr-runtime/store';
import type { ActorFacts, StudyFacts, WriteReceipt } from './contract';
import { CLINICAL_SURFACES } from './contract';
import { ClinicalWritePlan, planClinicalWrite, prepareClinicalWrite, WriteInput } from './records';
import type { ClinicalSigner, ClinicalSignature } from './signing';
import { ClinicalStore, StoredClinicalCommand } from './store';

export interface ClinicalRequestFacts {
  actor: ActorFacts;
  requestId: string;
  ip: EvidenceFact<{ address: string; source: 'trusted-proxy' | 'request-peer' }>;
}
/** These are server adapters. Current session/member/study access is checked
 * under the transaction's locks; a browser's JSON cannot supply any fact. */
/** The study's institutional scope without its patient identity. Reads and lists name the
 * managing institution of what they serve; their targets carry the patient snapshots the
 * stored versions already hold, so they must not depend on the source archive answering. */
export type StudyScope = Pick<StudyFacts, 'studyId' | 'managingInstitutionId' | 'teleInstitutionId'>;
export interface ClinicalContextSource {
  facts(tx: Prisma.TransactionClient, request: object): Promise<ClinicalRequestFacts>;
  study(tx: Prisma.TransactionClient, request: object, studyId: string): Promise<StudyFacts>;
  scope(tx: Prisma.TransactionClient, request: object, studyId: string): Promise<StudyScope>;
}
export interface OnlineClinicalWrite {
  surface: WriteInput['surface']; studyId: string; recordId: string; body: unknown;
  /** Source and party resolution belongs to the owning service/A reader. */
  prepare(tx: Prisma.TransactionClient, facts: ClinicalRequestFacts): Promise<Pick<WriteInput,
    'content' | 'attachments' | 'navigation' | 'recipientId' | 'readerId' | 'workContext'> & { projection: unknown }>;
}
export interface ClinicalRuntimeParts {
  records: EmrRecordPort;
  store: ClinicalStore;
  context: ClinicalContextSource;
  signer: ClinicalSigner;
  /** Existing service projectors recheck their own state and change their rows
   * only on the B2 transaction supplied here. */
  project(tx: Prisma.TransactionClient, request: object, plan: Readonly<ClinicalWritePlan>, projection: unknown): Promise<unknown>;
}
export type OnlineClinicalOutcome =
  | { status: 'committed' | 'replayed'; receipt: WriteReceipt; response?: unknown; signature?: ClinicalSignature;
      access: { eventId: string; durableAt: string } }
  | { status: 'unknown'; code: 'OutcomeUnknown'; retry: 'same-request' }
  | { status: 'rejected'; code: 'AppendNotCommitted' };
const unknown = (): OnlineClinicalOutcome => ({ status: 'unknown', code: 'OutcomeUnknown', retry: 'same-request' });
const known = <T>(value: T) => ({ status: 'known' as const, value });

function eventFor(facts: ClinicalRequestFacts, plan: ClinicalWritePlan): Readonly<AccessEventV1> {
  const v = plan.version;
  return parseAccessEvent({ formatVersion: 1, surface: plan.access.route, eventId: randomUUID(),
    userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles), actingInstitution: known(facts.actor.institutionId),
    managingInstitution: known(v.managingInstitutionId), occurredAt: v.at, trustedProxyIp: facts.ip,
    cause: 'user-view', context: { basis: v.kind === 'clinical-question' || v.kind === 'image-request' ? 'clinical-request' : 'worklist',
      studyId: v.studyId, relatedStudyId: null, reason: null }, executor: 'member', targets: [plan.access.target],
    action: plan.access.action, result: 'succeeded', requestId: facts.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null } as AccessEventV1) as Readonly<AccessEventV1>;
}

/** One online write, one B2 operation. Lookup never signs or runs a projector. */
export class ClinicalRuntime {
  constructor(readonly parts: ClinicalRuntimeParts) {}

  private async input(tx: Prisma.TransactionClient, request: object, w: OnlineClinicalWrite,
    ids: WriteInput['ids'], at: string, resolved?: ClinicalRequestFacts): Promise<WriteInput> {
    const facts = resolved ?? await this.parts.context.facts(tx, request);
    const study = await this.parts.context.study(tx, request, w.studyId);
    const spec = CLINICAL_SURFACES[w.surface];
    if (!spec) refuse('ClinicalSurfaceUnknown');
    const unit = await this.parts.store.unit(tx, spec.record, w.recordId);
    return { surface: w.surface, actor: facts.actor, study, unit, body: w.body, ids, at,
      content: null, attachments: [], navigation: [], recipientId: null, readerId: null, workContext: null };
  }

  private async answer(work: EmrRecordWork, request: object, command: StoredClinicalCommand,
    result: OperationResult | null, replay: boolean, prepare: OnlineClinicalWrite['prepare']): Promise<OnlineClinicalOutcome> {
    if (!result || result.outcome === 'pending') return unknown();
    if (result.outcome === 'negative') return { status: 'rejected', code: 'AppendNotCommitted' };
    const plan = command.plan;
    if (result.result?.kind !== 'emr-clinical' || result.result.id !== plan.version.recordId ||
        result.result.version !== plan.version.versionId) refuse('ClinicalResultMismatch');
    const stored = await work.transactionWithRecords(async (tx, record) => {
      const facts = await this.parts.context.facts(tx, request);
      await this.parts.context.study(tx, request, plan.version.studyId);
      if (facts.actor.identity.id !== plan.version.author.id || facts.actor.institutionId !== plan.version.actingInstitutionId) refuse('OwnerChanged');
      // A replay skips the projector. Findings still need their owning reader's
      // current comparison-lineage checks before returning the old source copy.
      if (replay && plan.record === 'finding') await prepare(tx, facts);
      const stored = await this.parts.store.version(tx, plan.version.versionId);
      if (!stored || stored.operationId !== command.operationId || stored.plan.version.sha256 !== plan.version.sha256) refuse('ClinicalResultMismatch');
      if (plan.signing) {
        if (!stored.signature) refuse('SignatureRequired');
        this.parts.signer.verify(stored.signature, plan.signing);
      }
      if (stored.response !== undefined) {
        const event = { ...eventFor(facts, plan), eventId: randomUUID(), action: 'provide-prepared' as const,
          result: 'prepared' as const, occurredAt: new Date().toISOString() };
        await record(event, async () => ({ kind: 'emr-clinical', id: plan.version.recordId, version: plan.version.versionId }));
      }
      return stored;
    });
    const receipt = await work.confirm({ provisional: true, operationId: command.operationId, eventId: command.event.eventId });
    return freeze({ status: replay ? 'replayed' : 'committed', receipt: plan.receipt,
      ...(stored.response !== undefined ? { response: stored.response, signature: stored.signature } : {}),
      access: { eventId: receipt.eventId, durableAt: receipt.durableAt } });
  }

  async write(request: object, w: OnlineClinicalWrite): Promise<OnlineClinicalOutcome> {
    const work = this.parts.records.begin();
    try {
      const identity = await this.parts.store.transaction(async tx => prepareClinicalWrite(await this.input(tx, request, w,
        { recordId: w.recordId, versionId: randomUUID() }, new Date().toISOString())));
      const { command, created } = await this.parts.store.prepare(identity, async (tx, ids) => {
        const facts = await this.parts.context.facts(tx, request);
        const seed = await this.input(tx, request, w, { recordId: w.recordId, versionId: ids.versionId }, new Date().toISOString(), facts);
        const { projection, ...prepared } = await w.prepare(tx, facts);
        const input = { ...seed, ...prepared };
        const plan = planClinicalWrite(input);
        if (plan.fingerprint !== identity.fingerprint) refuse('OwnerChanged');
        return { input, plan, event: eventFor(facts, plan), projection };
      });
      if (!created) {
        const previous = await work.lookup(command.operationId);
        // Pending means the original may still own COMMIT. Only B2 settlement
        // can decide it; a timeout never authorizes another signature/projector.
        if (previous) return await this.answer(work, request, command, previous, true, w.prepare);
      }
      const operation = await work.admit(command.event, undefined,
        { operationId: command.operationId, attemptId: command.attemptId });
      const result = await work.transaction(operation, async tx => {
        const plan = command.plan;
        const facts = await this.parts.context.facts(tx, request);
        const study = await this.parts.context.study(tx, request, plan.version.studyId);
        await this.parts.store.lockUnit(tx, plan.record, plan.version.recordId);
        const unit = await this.parts.store.unit(tx, plan.record, plan.version.recordId);
        // A's verified-record capability cannot be serialized in command JSON.
        // Re-read source/party facts under the owning service's current checks,
        // then require the exact originally selected version before signing.
        const { projection: _projection, ...prepared } = await w.prepare(tx, facts);
        const current = planClinicalWrite({ ...command.input, ...prepared, actor: facts.actor, study, unit });
        if (current.version.sha256 !== plan.version.sha256) refuse('StaleRevision');
        const signature = plan.signing ? await this.parts.signer.sign(tx, request, plan.signing) : null;
        const response = await this.parts.project(tx, request, plan, command.projection);
        await this.parts.store.append(tx, command, signature, response);
        return { kind: 'emr-clinical', id: plan.version.recordId, version: plan.version.versionId };
      });
      return await this.answer(work, request, command, result, !created, w.prepare);
    } catch (error) {
      if (error?.code === 'CommitUnknown') return unknown();
      throw error;
    } finally { work.end(); }
  }

  async lookup(request: object, w: OnlineClinicalWrite): Promise<OnlineClinicalOutcome | null> {
    const work = this.parts.records.begin();
    try {
      const command = await this.parts.store.transaction(async tx => {
        const input = await this.input(tx, request, w, { recordId: w.recordId, versionId: randomUUID() }, new Date().toISOString());
        return this.parts.store.command(tx, prepareClinicalWrite(input));
      });
      return command ? await this.answer(work, request, command, await work.lookup(command.operationId), true, w.prepare) : null;
    } catch (error) {
      if (error?.code === 'CommitUnknown') return unknown();
      throw error;
    } finally { work.end(); }
  }
}

export function composeClinicalRuntime(parts: ClinicalRuntimeParts): ClinicalRuntime {
  return new ClinicalRuntime(parts);
}
