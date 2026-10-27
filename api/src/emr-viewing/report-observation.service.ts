import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException,
  ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { DurableAccessReceipt, LocalReadAccessEventV2, newAuditLinkId, parseLocalReadEvent } from '../emr-contract/access-event';
import { ContractError, object, utc } from '../emr-contract/validation';
import { transactionScope } from '../emr-runtime/context';
import { isDurableReceipt } from '../emr-runtime/contract';
import type { EmrRecordWork } from '../emr-runtime/record-port';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource, RequestFacts } from '../emr-runtime/request-context';
import { Caller, PacsAccess } from '../pacs/access';
import { canReadPreliminary } from '../preliminary-reader';
import { PrismaService } from '../prisma.service';
import { StudyAccessService } from '../study-access.service';
import { LOCAL_READ_UNAVAILABLE } from './response-lifecycle';

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPORT_KINDS: readonly string[] = ['report-version', 'report-evidence'];
const invalid = () => new BadRequestException({ code: 'VIEW_OBSERVATION_INVALID', message: '표시 보고 입력이 올바르지 않습니다' });
// An absent, lawfully disposed, another member's or another session's reference, or one that is not a report read:
// one answer, as the access gate answers an absent study and another institution's study alike.
const unknownReference = () => new NotFoundException({ code: 'VIEW_OBSERVATION_REFERENCE',
  message: '표시한 판독문의 제공 기록을 찾을 수 없습니다' });
const conflict = () => new ConflictException({ code: 'VIEW_OBSERVATION_CONFLICT',
  message: '같은 표시 보고 ID가 다른 내용으로 이미 기록되었습니다' });
const unavailable = () => new ServiceUnavailableException(LOCAL_READ_UNAVAILABLE);

interface Observation { accessRef: string; eventId: string; shownAt: string }

/** The client names the provision it displayed, its own display event and when it displayed. Nothing else is read. */
function observation(input: unknown): Observation {
  let report: Observation;
  try {
    const v = object(input, ['accessRef', 'eventId', 'shownAt']);
    report = { accessRef: v.accessRef, eventId: v.eventId, shownAt: utc(v.shownAt) };
  } catch { throw invalid(); }
  if (typeof report.accessRef !== 'string' || !UUID4.test(report.accessRef) || typeof report.eventId !== 'string' ||
      !UUID4.test(report.eventId) || report.eventId === report.accessRef) throw invalid();
  return report;
}

/** A stored local-read event, or null for an entry of any other branch or version (never a display reference); an
 * unreadable local-read entry is an integrity error, not an absence. */
function localRead(stored: unknown): Readonly<LocalReadAccessEventV2> | null {
  const raw = stored as { formatVersion?: unknown; branch?: unknown } | null;
  if (!raw || typeof raw !== 'object' || raw.formatVersion !== 2 || raw.branch !== 'local-read') return null;
  return parseLocalReadEvent(stored);
}

const sameMember = (event: Readonly<LocalReadAccessEventV2>, facts: RequestFacts) =>
  event.userId.status === 'known' && event.userId.value.id === facts.actor.id &&
  event.userId.value.issuer === facts.actor.issuer && event.userId.value.subject === facts.actor.subject &&
  event.actingInstitution.status === 'known' && event.actingInstitution.value === facts.institution &&
  isDeepStrictEqual({ ...event.session }, { ...facts.binding });

/**
 * MODULE_A A4: `POST studies/:uid/view-observations`. The browser reports that it displayed a report version (or a
 * version's evidence) this member was provided. The record is the provision's own `client-shown` follow-up: the stored
 * target, surface and managing institution come from the provide-prepared entry B2 read back, never from the body.
 *
 * The event's `occurredAt` is the display time the client reported (as `displayReported` and the offline branch
 * use the device's time); B2 records its own commit time, the receipt's `durableAt`, answered as `receivedAt`.
 * It is a report, not proof that the person read the text.
 */
@Injectable()
export class ReportObservationService {
  private access?: { pacs: PacsAccess; studies: StudyAccessService };
  constructor(@Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource,
    private readonly modules: ModuleRef) {}

  async observe(uid: string, input: unknown, caller: Caller, request: IncomingMessage) {
    const report = observation(input);
    await this.admit(uid, caller);
    try {
      return await this.requests.withWork(request, async ({ facts, work }) => {
        const prepared = await this.prepared(work, report, uid, facts);
        const shown = await this.shown(work, prepared, facts, report);
        return { eventId: shown.event.eventId, accessRef: prepared.eventId, shownAt: shown.event.occurredAt,
          receivedAt: shown.receipt.durableAt };
      });
    } catch (error) {
      // Refusals keep their answer; recording that is closed, unreachable or unknown is the viewing 503, never an ACK.
      if (error instanceof HttpException) throw error;
      throw unavailable();
    }
  }

  /** The new request's existing report-history access decision, the gates GET studies/:uid/report/versions applies. */
  private async admit(uid: string, c: Caller) {
    // EmrViewingModule is composed by AppModule.withLedger; these two are AppModule's own singletons.
    this.access ??= (() => {
      const studies = this.modules.get(StudyAccessService, { strict: false });
      return { pacs: new PacsAccess(this.modules.get(PrismaService, { strict: false }), studies), studies };
    })();
    const { pacs, studies } = this.access;
    await studies.prepareSourceIdentity(c, [uid]);
    const state = await pacs.gate(uid, c);
    if (!state) throw new NotFoundException('검사를 찾을 수 없습니다');
    studies.assertUnsplitSource(c, uid);
    if (!canReadPreliminary(state, c))
      throw new ForbiddenException(`예비 판독(RS: P) 중입니다. ${state?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
  }

  /** The original provide-prepared, read back from B2 and bound to this member, institution, session and study. */
  private async prepared(work: EmrRecordWork, report: Observation, uid: string, facts: RequestFacts) {
    const stored = await readBack(work, report.accessRef);
    const event = stored === null ? null : localRead(stored);
    if (!event || event.action !== 'provide-prepared' || event.targets.length !== 1 || !REPORT_KINDS.includes(event.targets[0].kind) ||
        event.targets[0].studyId.status !== 'known' || event.targets[0].studyId.value !== uid || !sameMember(event, facts))
      throw unknownReference();
    return event;
  }

  /**
   * One display event per client event ID. A resend of the same report (lost ACK, restart) replays the first accepted
   * entry through B2, which answers its original receipt; a different report under that ID is refused.
   */
  private async shown(work: EmrRecordWork, prepared: Readonly<LocalReadAccessEventV2>, facts: RequestFacts, report: Observation) {
    const replay = async () => {
      const stored = await readBack(work, report.eventId);
      if (stored === null) return null;
      const event = localRead(stored);
      if (!event || event.action !== 'client-shown' || event.relatedEventId !== prepared.eventId || event.occurredAt !== report.shownAt ||
          event.surface !== prepared.surface || !isDeepStrictEqual(event.targets, prepared.targets) || !sameMember(event, facts))
        throw conflict();
      return { event, receipt: await durable(work, event) };
    };
    const first = await replay();
    if (first) return first;
    const event = parseLocalReadEvent({ formatVersion: 2, branch: 'local-read', surface: prepared.surface,
      eventId: report.eventId, userId: { status: 'known', value: facts.actor }, rolesAtTime: { status: 'known', value: facts.roles },
      rightsVersion: facts.rightsVersion, actingInstitution: { status: 'known', value: facts.institution },
      managingInstitution: prepared.managingInstitution, occurredAt: report.shownAt, trustedProxyIp: facts.ingress,
      session: facts.binding,
      // A display is a person's view even of a prefetched body; a prefetch's own context is not the display's.
      cause: 'user-view', context: prepared.cause === 'user-view' ? prepared.context : null, executor: 'member',
      targets: prepared.targets, action: 'client-shown', result: 'reported', requestId: facts.requestId,
      auditLinkId: newAuditLinkId(), relatedEventId: prepared.eventId });
    try { return { event, receipt: await durable(work, event) }; }
    catch (error) {
      // A concurrent first report of the same ID may have won; its committed entry is the fact. Pending stays unknown.
      const winner = await replay();
      if (winner) return winner;
      throw error;
    }
  }
}

/** One viewing-stream entry by event ID; only B2's precise absence is null (lost, failed or unparseable reads are not). */
async function readBack(work: EmrRecordWork, eventId: string): Promise<unknown | null> {
  const scope = transactionScope();
  try {
    const snapshot = await work.transactionWithRecords(tx => work.snapshot(tx, scope, { accessEventIds: [eventId] }));
    return snapshot.accessEvents.get(eventId) ?? null;
  } catch (error) {
    if (error instanceof ContractError && error.code === 'AccessRecordRequired') return null;
    throw error;
  }
}

/** A1's append discipline: a lost COMMIT reply is resolved only through this operation's stored result. */
async function durable(work: EmrRecordWork, event: Readonly<LocalReadAccessEventV2>): Promise<DurableAccessReceipt> {
  const keys = { operationId: randomUUID(), attemptId: randomUUID() };
  let receipt;
  try { receipt = await work.append(event, undefined, keys); }
  catch (error) {
    const result = await work.lookup(keys.operationId);
    if (!result || result.outcome !== 'committed' || result.eventId !== event.eventId) throw error;
    receipt = await work.confirm({ provisional: true, operationId: keys.operationId, eventId: event.eventId });
  }
  if (!isDurableReceipt(receipt) || receipt.eventId !== event.eventId) throw unavailable();
  return receipt;
}
