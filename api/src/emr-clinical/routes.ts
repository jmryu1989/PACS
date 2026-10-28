import { BadRequestException, ConflictException, NotFoundException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { ContractError, refuse } from '../emr-contract/validation';
import { READ_ROUTES, ClinicalRecord, SurfaceKey } from './contract';
import type { ClinicalWritePlan } from './records';
import { ClinicalRuntimeParts, composeClinicalRuntime, OnlineClinicalWrite } from './runtime';
import type { StoredClinicalVersion } from './store';

export const EMR_CLINICAL_ROUTES = Symbol('EMR_CLINICAL_ROUTES');
export type RouteWrite = Pick<OnlineClinicalWrite, 'studyId' | 'recordId' | 'body'> & { surface: SurfaceKey };
export type ClinicalRouteSources = (tx: Prisma.TransactionClient, request: object, write: RouteWrite) =>
  ReturnType<OnlineClinicalWrite['prepare']>;
export interface ClinicalWorkflow {
  tx: Prisma.TransactionClient;
  closeAssignment(uid: string, owner: string, revision: number): Promise<void>;
}
/** S7-U3a: the receiving institution's reader allocation closes inside the study operation that
 * takes the tele channel away (PATCH/DELETE studies/:uid). D1860 / D-T5: allocation is none of
 * 제23조④'s record acts, so the close names no patient-bearing target and resolves the study
 * scope without the source archive - a WORKLIST-SPLIT-UID study has no resolved patient, and
 * its channel still closes. It is recorded on this server surface of its own: the study routes
 * serve record kinds, and a mixed surface would require a served-record manifest that no
 * stored reader can mint for an allocation row. */
export const ASSIGNMENT_CLOSE_SURFACE = 'server:reader-assignment-close';

/** Existing controllers keep their response shape and services keep their own
 * role/state checks. Their writes run on the same B2 connection as the exact
 * signed version. A lost response returns the stored result, never a re-project. */
export class ClinicalRoutes {
  constructor(readonly parts: ClinicalRuntimeParts, private readonly sources: ClinicalRouteSources) {}
  /** Allocation can also be closed by a study operation. Read its actual
   * projection revision, including that close, rather than a previous receipt. */
  async assignment<T extends { revision: number }>(request: object, uid: string,
    read: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const work = this.parts.records.begin();
    try {
      return await work.transactionWithRecords(async (tx, record) => {
        const facts = await this.parts.context.facts(tx, request);
        const study = await this.parts.context.study(tx, request, uid);
        const value = await read(tx);
        const known = <V>(value: V) => ({ status: 'known' as const, value });
        const id = JSON.stringify([uid, facts.actor.institutionId]);
        await record({ formatVersion: 1, surface: READ_ROUTES.assignment, eventId: randomUUID(),
          userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles),
          actingInstitution: known(facts.actor.institutionId), managingInstitution: known(study.managingInstitutionId),
          occurredAt: new Date().toISOString(), trustedProxyIp: facts.ip, cause: 'user-view',
          context: { basis: 'worklist', studyId: uid, relatedStudyId: null, reason: null }, executor: 'member',
          targets: [{ kind: 'assignment', patientLinkSnapshot: known(study.patient), studyId: known(uid),
            recordId: known(id), versionId: known(String(value.revision)) }], action: 'provide-prepared', result: 'prepared',
          requestId: facts.requestId, auditLinkId: 'audit:' + randomUUID(), relatedEventId: null },
        async () => ({ kind: 'ReaderAssignment', id, version: String(value.revision) }));
        return value;
      }).catch(routeError);
    } finally { work.end(); }
  }
  async workflow<T>(request: object, execute: (workflow: ClinicalWorkflow) => Promise<T>): Promise<T> {
    const work = this.parts.records.begin();
    try {
      return await work.transactionWithRecords(async (tx, record) => {
        const facts = await this.parts.context.facts(tx, request);
        return execute({ tx, closeAssignment: async (uid, owner, revision) => {
          const study = await this.parts.context.scope(tx, request, uid);
          const known = <V>(value: V) => ({ status: 'known' as const, value });
          const waived = { status: 'not-applicable' as const, reason: 'non-record-target' as const };
          const id = JSON.stringify([uid, owner]);
          await record({ formatVersion: 1, surface: ASSIGNMENT_CLOSE_SURFACE, eventId: randomUUID(),
            userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles),
            actingInstitution: known(facts.actor.institutionId), managingInstitution: known(study.managingInstitutionId),
            occurredAt: new Date().toISOString(), trustedProxyIp: facts.ip, cause: 'user-view',
            context: { basis: 'worklist', studyId: uid, relatedStudyId: null, reason: null }, executor: 'member',
            targets: [{ kind: 'assignment', patientLinkSnapshot: waived, studyId: known(uid),
              recordId: known(id), versionId: known(String(revision)) }], action: 'modify', result: 'succeeded',
            requestId: facts.requestId, auditLinkId: 'audit:' + randomUUID(), relatedEventId: null },
          async () => ({ kind: 'ReaderAssignment', id, version: String(revision) }));
        } });
      }).catch(routeError);
    } finally { work.end(); }
  }
  async write<T>(request: object, write: RouteWrite,
    project: (tx: Prisma.TransactionClient, plan: Readonly<ClinicalWritePlan>) => Promise<T>) {
    if (typeof write.recordId !== 'string' || !write.recordId || typeof write.studyId !== 'string' || !write.studyId)
      throw new BadRequestException('기록 대상과 요청 ID를 확인하세요.');
    const runtime = composeClinicalRuntime({ ...this.parts, project: (tx, _request, plan) => project(tx, plan) });
    const outcome = await runtime.write(request, { ...write, prepare: tx => this.sources(tx, request, write) })
      .catch(error => routeError(error, write.surface));
    if (outcome.status === 'unknown') throw new ServiceUnavailableException({ code: 'OutcomeUnknown',
      message: '저장 결과를 확인하지 못했습니다. 입력을 유지하고 같은 요청을 다시 확인하세요.' });
    if (outcome.status === 'rejected') throw new ServiceUnavailableException({ code: outcome.code,
      message: '저장이 완료되지 않았습니다. 입력은 유지됩니다.' });
    const response = outcome.response as T;
    return { ...response, ...(Object.prototype.hasOwnProperty.call(response, 'replayed') ?
      { replayed: outcome.status === 'replayed' } : {}), emr: { receipt: outcome.receipt, signature: outcome.signature ?? null,
      access: outcome.access, replayed: outcome.status === 'replayed' } };
  }

  /** Every record a list serves gets its own 열람 event, as a single read does: the record's
   * study and managing institution, the versions the row serves as targets, and the served
   * head as the appended reference. A row whose body folds in its earlier versions (a request's
   * reason with its latest note, a consultation's reason with its reply) serves every version up to
   * the listed revision; a list given `served` names the revisions its row actually carries (a
   * finding or question summary: its listed head), so retained history it did not return is not
   * recorded as read. A list that serves nothing records nothing (B2's record() treats a null effect as
   * a conditional write that affected no row, which is settled negative and appends no entry).
   * `studyId` is the per-study list's study, so its items resolve the study scope once. */
  async collection<T extends { items?: ListedRecord[] }>(request: object,
    surface: string, recordType: ClinicalRecord, read: (tx: Prisma.TransactionClient) => Promise<T>, studyId?: string,
    served?: (item: ListedRecord) => readonly number[]): Promise<T> {
    const work = this.parts.records.begin();
    try {
      return await work.transactionWithRecords(async (tx, record) => {
        const facts = await this.parts.context.facts(tx, request);
        const response = await read(tx);
        const scope = studyId === undefined ? null : await this.parts.context.scope(tx, request, studyId);
        if (!response.items) refuse('ClinicalListUnavailable');
        const known = <V>(value: V) => ({ status: 'known' as const, value });
        for (const item of response.items) {
          const study = scope && item.studyUid === scope.studyId ? scope : await this.parts.context.scope(tx, request, item.studyUid);
          // A row given `served` loads only the versions it serves and its listed head.
          const wanted = served?.(item);
          const stored = (await this.parts.store.versions(tx, recordType, item.id, wanted && [...wanted, item.revision]))
            .filter(v => v.plan.version.sequence <= item.revision);
          // A concurrent writer may advance the head after the list's snapshot.
          // Only versions belonging to the returned projection are provided.
          const head = stored.find(v => v.plan.version.sequence === item.revision);
          if (!head) refuse('ClinicalHistoryUnavailable');
          const versions = wanted ? servedVersions(stored, wanted) : stored;
          verifySigned(this.parts.signer, versions);
          await record({ formatVersion: 1, surface, eventId: randomUUID(),
            userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles),
            actingInstitution: known(facts.actor.institutionId), managingInstitution: known(study.managingInstitutionId),
            occurredAt: new Date().toISOString(), trustedProxyIp: facts.ip, cause: 'user-view',
            context: { basis: 'worklist', studyId: study.studyId, relatedStudyId: null, reason: null },
            executor: 'member', targets: versions.map(v => v.plan.access.target), action: 'provide-prepared', result: 'prepared',
            requestId: facts.requestId, auditLinkId: 'audit:' + randomUUID(), relatedEventId: null },
          async () => ({ kind: 'emr-clinical', id: item.id, version: head.plan.version.versionId }));
        }
        return response;
      }).catch(routeError);
    } finally { work.end(); }
  }

  /** A read that serves no record (a study without a note yet) records nothing: there is no
   * 열람 and B2 would settle a null effect negative anyway. The record's own study scope names
   * the managing institution; the source archive is not consulted for a read. A read whose body
   * is the whole record serves every stored version; a paged read gives `served`, the revisions
   * its page returned, and its event, signing facts and reference name exactly those. A page that
   * returns no revision serves no version and records nothing. */
  async read<T>(request: object, recordType: ClinicalRecord, recordId: string,
    read: (tx: Prisma.TransactionClient) => Promise<T>, empty?: (value: T) => boolean,
    surface = READ_ROUTES[recordType], served?: (value: T) => readonly number[]): Promise<T> {
    const work = this.parts.records.begin();
    try {
      return await work.transactionWithRecords(async (tx, record) => {
        const facts = await this.parts.context.facts(tx, request);
        const first = await this.parts.store.unit(tx, recordType, recordId);
        if (first) await this.parts.store.lockUnit(tx, recordType, recordId);
        const response = await read(tx);
        const study = first ? await this.parts.context.scope(tx, request, first.studyId) : null;
        const { unit, versions: stored } = first ? await this.parts.store.history(tx, recordType, recordId) : { unit: null, versions: [] };
        if (!unit && !empty?.(response)) refuse('ClinicalHistoryUnavailable');
        const versions = served && unit ? servedVersions(stored, served(response)) : stored;
        verifySigned(this.parts.signer, versions);
        const known = <V>(value: V) => ({ status: 'known' as const, value });
        if (unit && study && versions.length) {
          // The real service read above owns its existing role/party/tele and
          // source-lineage checks. Recording evidence must not change them.
          await record({ formatVersion: 1, surface, eventId: randomUUID(),
            userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles),
            actingInstitution: known(facts.actor.institutionId), managingInstitution: known(study.managingInstitutionId),
            occurredAt: new Date().toISOString(), trustedProxyIp: facts.ip,
            cause: 'user-view', context: { basis: 'worklist', studyId: study.studyId, relatedStudyId: null, reason: null },
            executor: 'member', targets: versions.map(v => v.plan.access.target), action: 'provide-prepared', result: 'prepared',
            requestId: facts.requestId, auditLinkId: 'audit:' + randomUUID(), relatedEventId: null },
          // The latest served version names the page, which need not hold the current head.
          async () => ({ kind: 'emr-clinical', id: recordId, version: versions[versions.length - 1].plan.version.versionId }));
        }
        return { ...response, emr: { recordId, studyId: unit?.studyId ?? null,
          signatures: versions.map(v => ({ versionId: v.plan.version.versionId, revision: v.plan.version.sequence,
            // The envelope contains clinical text. The page needs its verified
            // signing facts, not additional bodies outside this read's result.
            signature: v.signature ? { signedAt: v.signature.signedAt, payloadSha256: v.signature.payloadSha256,
              kid: v.signature.registration.kid, signer: v.signature.registration.doctor.identity } : null })) } };
      }).catch(routeError);
    } finally { work.end(); }
  }
}

type ListedRecord = { id: string; studyUid: string; revision: number };

/** The stored versions a response actually returned. Each served revision must be a stored,
 * signed version: a page naming a revision D does not hold is refused, never recorded partially. */
function servedVersions(stored: readonly StoredClinicalVersion[], revisions: readonly number[]): StoredClinicalVersion[] {
  const wanted = new Set(revisions);
  const versions = stored.filter(v => wanted.has(v.plan.version.sequence));
  if (versions.length !== wanted.size) refuse('ClinicalHistoryUnavailable');
  return versions;
}

function verifySigned(signer: ClinicalRuntimeParts['signer'], versions: readonly StoredClinicalVersion[]): void {
  for (const version of versions) if (version.plan.signing) {
    if (!version.signature) refuse('SignatureRequired');
    signer.verify(version.signature, version.plan.signing);
  }
}

function routeError(error: unknown, surface?: SurfaceKey): never {
  if (!(error instanceof ContractError)) throw error;
  const codes = { OwnerChanged: 'OWNER_CHANGED', RequestIdReused: 'REQUEST_ID_REUSED' };
  const changed = error.code === 'StaleRevision' || error.code === 'StateTransitionRefused';
  // The clinical ledger uses shared refusal codes; callers still consume the image-request API's vocabulary.
  const imageCodes = { UnitExists: 'REQUEST_ID_REUSED', StaleRevision: 'IMAGE_REQUEST_CHANGED',
    StateTransitionRefused: 'IMAGE_REQUEST_STATE', AuthorityFieldRefused: 'IMAGE_REQUEST_INPUT_INVALID',
    RequestShapeRefused: 'IMAGE_REQUEST_INPUT_INVALID', TextRequired: 'IMAGE_REQUEST_INPUT_INVALID',
    TextRefused: 'IMAGE_REQUEST_INPUT_INVALID', ReasonRequired: 'IMAGE_REQUEST_INPUT_INVALID' };
  const code = codes[error.code] ?? (surface?.startsWith('image-request.') ? imageCodes[error.code] : undefined) ??
    (changed && surface?.startsWith('question.') ? 'QUESTION_CHANGED' : error.code);
  const body = { code, message: '임상 기록을 처리하지 못했습니다. 입력을 유지하고 대상과 현재 상태를 확인하세요.' };
  if (error.code === 'NotFound') throw new NotFoundException(body);
  if (['ActorPathRefused', 'ServiceActorRefused', 'OnlineDoctorApprovalRequired'].includes(error.code)) throw new ForbiddenException(body);
  if (changed || ['OwnerChanged', 'RequestIdReused', 'UnitExists'].includes(error.code)) throw new ConflictException(body);
  if (['RequestShapeRefused', 'ClinicalSurfaceUnknown', 'AuthorityFieldRefused', 'TextRequired', 'TextRefused', 'ReasonRequired'].includes(error.code))
    throw new BadRequestException(body);
  throw new ServiceUnavailableException(body);
}

export function clinicalRoutes(routes: ClinicalRoutes | undefined): ClinicalRoutes {
  if (!routes) throw new ServiceUnavailableException('온라인 임상 기록 연결을 확인할 수 없습니다. 입력은 유지됩니다.');
  return routes;
}
