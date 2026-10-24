import { BadRequestException, ConflictException, NotFoundException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { AccessEventV1 } from '../emr-contract/access-event';
import { ContractError, refuse } from '../emr-contract/validation';
import { READ_ROUTES, ClinicalRecord, SurfaceKey } from './contract';
import type { ClinicalWritePlan } from './records';
import { ClinicalRuntimeParts, composeClinicalRuntime, OnlineClinicalWrite } from './runtime';

export const EMR_CLINICAL_ROUTES = Symbol('EMR_CLINICAL_ROUTES');
export type RouteWrite = Pick<OnlineClinicalWrite, 'studyId' | 'recordId' | 'body'> & { surface: SurfaceKey };
export type ClinicalRouteSources = (tx: Prisma.TransactionClient, request: object, write: RouteWrite) =>
  ReturnType<OnlineClinicalWrite['prepare']>;
export interface ClinicalWorkflow {
  tx: Prisma.TransactionClient;
  closeAssignment(uid: string, owner: string, revision: number): Promise<void>;
}

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
  async workflow<T>(request: object, surface: 'PATCH studies/:uid' | 'DELETE studies/:uid',
    execute: (workflow: ClinicalWorkflow) => Promise<T>): Promise<T> {
    const work = this.parts.records.begin();
    try {
      return await work.transactionWithRecords(async (tx, record) => {
        const facts = await this.parts.context.facts(tx, request);
        return execute({ tx, closeAssignment: async (uid, owner, revision) => {
          const study = await this.parts.context.study(tx, request, uid);
          const known = <V>(value: V) => ({ status: 'known' as const, value });
          const id = JSON.stringify([uid, owner]);
          await record({ formatVersion: 1, surface, eventId: randomUUID(),
            userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles),
            actingInstitution: known(facts.actor.institutionId), managingInstitution: known(study.managingInstitutionId),
            occurredAt: new Date().toISOString(), trustedProxyIp: facts.ip, cause: 'user-view',
            context: { basis: 'worklist', studyId: uid, relatedStudyId: null, reason: null }, executor: 'member',
            targets: [{ kind: 'assignment', patientLinkSnapshot: known(study.patient), studyId: known(uid),
              recordId: known(id), versionId: known(String(revision)) }], action: 'modify', result: 'succeeded',
            requestId: facts.requestId, auditLinkId: 'audit:' + randomUUID(), relatedEventId: null },
          async () => ({ kind: 'ReaderAssignment', id, version: String(revision) }));
        } });
      }).catch(routeError);
    } finally { work.end(); }
  }
  async write<T>(request: object, write: RouteWrite,
    project: (tx: Prisma.TransactionClient, plan: Readonly<ClinicalWritePlan>) => Promise<T>): Promise<T> {
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

  async collection<T extends { items?: { id: string; studyUid: string; revision: number }[] }>(request: object,
    surface: string, recordType: ClinicalRecord, read: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const work = this.parts.records.begin();
    try {
      return await work.transactionWithRecords(async (tx, record) => {
        const facts = await this.parts.context.facts(tx, request);
        const response = await read(tx);
        if (!response.items) refuse('ClinicalListUnavailable');
        const targets: AccessEventV1['targets'][number][] = [];
        const institutions = new Set<string>(), studies = new Set<string>();
        for (const item of response.items) {
          const study = await this.parts.context.study(tx, request, item.studyUid);
          institutions.add(study.managingInstitutionId); studies.add(study.studyId);
          const versions = (await this.parts.store.versions(tx, recordType, item.id))
            .filter(v => v.plan.version.sequence <= item.revision);
          // A concurrent writer may advance the head after the list's snapshot.
          // Only versions belonging to the returned projection are provided.
          if (!versions.some(v => v.plan.version.sequence === item.revision)) refuse('ClinicalHistoryUnavailable');
          for (const version of versions) {
            if (version.plan.signing) {
              if (!version.signature) refuse('SignatureRequired');
              this.parts.signer.verify(version.signature, version.plan.signing);
            }
            targets.push(version.plan.access.target);
          }
        }
        const known = <V>(value: V) => ({ status: 'known' as const, value });
        await record({ formatVersion: 1, surface, eventId: randomUUID(),
          userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles),
          actingInstitution: known(facts.actor.institutionId), managingInstitution: institutions.size === 1 ?
            known([...institutions][0]) : { status: 'unresolved', reason: 'not-resolved' },
          occurredAt: new Date().toISOString(), trustedProxyIp: facts.ip, cause: 'user-view',
          context: { basis: 'worklist', studyId: studies.size === 1 ? [...studies][0] : null, relatedStudyId: null, reason: null },
          executor: 'member', targets, action: 'provide-prepared', result: 'prepared',
          requestId: facts.requestId, auditLinkId: 'audit:' + randomUUID(), relatedEventId: null }, async () => null);
        return response;
      }).catch(routeError);
    } finally { work.end(); }
  }

  async read<T>(request: object, recordType: ClinicalRecord, recordId: string,
    read: (tx: Prisma.TransactionClient) => Promise<T>, empty?: (value: T) => boolean,
    surface = READ_ROUTES[recordType]): Promise<T> {
    const work = this.parts.records.begin();
    try {
      return await work.transactionWithRecords(async (tx, record) => {
        const facts = await this.parts.context.facts(tx, request);
        const first = await this.parts.store.unit(tx, recordType, recordId);
        const study = first ? await this.parts.context.study(tx, request, first.studyId) : null;
        if (first) await this.parts.store.lockUnit(tx, recordType, recordId);
        const response = await read(tx);
        const unit = first ? await this.parts.store.unit(tx, recordType, recordId) : null;
        if (!unit && !empty?.(response)) refuse('ClinicalHistoryUnavailable');
        const versions = unit ? await this.parts.store.versions(tx, recordType, recordId) : [];
        for (const version of versions) if (version.plan.signing) {
          if (!version.signature) refuse('SignatureRequired');
          this.parts.signer.verify(version.signature, version.plan.signing);
        }
        const known = <V>(value: V) => ({ status: 'known' as const, value });
        const event: AccessEventV1 = { formatVersion: 1, surface, eventId: randomUUID(),
          userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles),
          actingInstitution: known(facts.actor.institutionId), managingInstitution: study ? known(study.managingInstitutionId) :
            { status: 'unresolved', reason: 'not-resolved' }, occurredAt: new Date().toISOString(), trustedProxyIp: facts.ip,
          cause: 'user-view', context: { basis: 'worklist', studyId: study?.studyId ?? null, relatedStudyId: null, reason: null },
          // The real service read above owns its existing role/party/tele and
          // source-lineage checks. Recording evidence must not change them.
          executor: 'member', targets: versions.map(v => v.plan.access.target), action: 'provide-prepared', result: 'prepared',
          requestId: facts.requestId, auditLinkId: 'audit:' + randomUUID(), relatedEventId: null };
        await record(event, async () => unit ? ({ kind: 'emr-clinical', id: recordId, version: unit.head.versionId }) : null);
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

function routeError(error: unknown, surface?: SurfaceKey): never {
  if (!(error instanceof ContractError)) throw error;
  const codes = { OwnerChanged: 'OWNER_CHANGED', RequestIdReused: 'REQUEST_ID_REUSED' };
  const changed = error.code === 'StaleRevision' || error.code === 'StateTransitionRefused';
  const code = codes[error.code] ?? (changed && surface?.startsWith('question.') ? 'QUESTION_CHANGED' : error.code);
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
