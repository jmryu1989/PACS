import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { Caller } from './pacs.service';
import { inst, need } from './pacs/access';
import { randomUUID } from 'node:crypto';
import type { RequestWorkContext } from './emr-runtime/request-context';
import type { AccessEventV1 } from './emr-contract/access-event';

// Reuse the existing Admin audit page size; this is presentation, not a review threshold.
const PAGE_SIZE = 25;
type Cursor = { top: string; before: string; from: string; until: string; downloads: boolean; institution: string };
type Row = { entry_id: string; sequence: bigint; snapshot_top: bigint; event_id: string; occurred_at: Date; recorded_at: Date;
  statutory_act: string; payload: string };

function queryOptions(query: any, institution: string) {
  const invalid = () => new BadRequestException('조회 기간과 이어보기 조건을 확인하세요.');
  if (!query || Object.keys(query).some(k => !['report', 'from', 'until', 'downloads', 'after'].includes(k)) ||
      query.report !== 'access' || !['all', 'files'].includes(query.downloads)) throw invalid();
  const timestamp = (value: unknown) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid();
    return value;
  };
  const from = timestamp(query.from), until = timestamp(query.until), downloads = query.downloads === 'files';
  if (from >= until) throw invalid();
  let cursor: Cursor | null = null;
  if (query.after !== undefined) {
    try {
      if (typeof query.after !== 'string') throw invalid();
      cursor = JSON.parse(Buffer.from(query.after, 'base64url').toString('utf8'));
      const sequence = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v) && BigInt(v) <= BigInt('9223372036854775807');
      if (!cursor || !sequence(cursor.top) || !sequence(cursor.before) || BigInt(cursor.before) > BigInt(cursor.top) ||
          cursor.from !== from || cursor.until !== until || cursor.downloads !== downloads || cursor.institution !== institution) throw invalid();
    } catch { throw invalid(); }
  }
  return { from, until, downloads, cursor };
}

@Injectable()
export class AdminAccessReview {
  constructor(private readonly db: PrismaService, private readonly access: StudyAccessService) {}

  async read(query: unknown, caller: Caller, request: RequestWorkContext) {
    need(caller.roles, 'admin', '접속기록 점검');
    const institution = inst(caller);
    if (caller.kind !== 'member') throw new ForbiddenException('관리자 회원 계정이 필요합니다.');
    const { from, until, downloads, cursor } = queryOptions(query, institution);
    await request.requireCurrent();
    const access = await this.access.snapshot(caller);
    if (access.policy.restricted) throw new ForbiddenException('검사 접근 범위가 제한된 계정은 접속기록을 조회할 수 없습니다.');
    let rows: Row[], top: string;
    try {
      rows = await this.db.$queryRaw<Row[]>`
        SELECT * FROM emr_access.review_entries(${institution}::text, ${from}::timestamptz, ${until}::timestamptz,
          ${downloads}::boolean, ${cursor?.top ?? null}::bigint, ${cursor?.before ?? null}::bigint, ${PAGE_SIZE + 1}::integer)`;
      top = cursor?.top ?? String(rows[0]?.snapshot_top ?? 0);
    } catch {
      throw new ServiceUnavailableException('접속기록을 조회하지 못했습니다. 다시 조회하세요.');
    }
    const page = rows.slice(0, PAGE_SIZE);
    const result = page.map(row => {
      const event = JSON.parse(row.payload);
      return { eventId: row.event_id, occurredAt: row.occurred_at.toISOString(), recordedAt: row.recorded_at.toISOString(),
        statutoryAct: row.statutory_act, userId: event.userId, rolesAtTime: event.rolesAtTime,
        actingInstitution: event.actingInstitution, managingInstitution: event.managingInstitution,
        trustedProxyIp: event.trustedProxyIp, executor: event.executor, targets: event.targets,
        surface: event.surface, action: event.action, result: event.result, cause: event.cause, context: event.context,
        requestId: event.requestId, auditLinkId: event.auditLinkId, relatedEventId: event.relatedEventId,
        affectedIdentity: event.affectedIdentity ?? null, auth: event.auth ?? null, rightsVersion: event.rightsVersion ?? null };
    });
    await this.access.unchanged(caller, access);
    await request.requireCurrent();
    const known = <T>(value: T) => ({ status: 'known' as const, value });
    const na = { status: 'not-applicable' as const, reason: 'non-record-target' as const };
    const event: AccessEventV1 = {
      formatVersion: 1, eventId: randomUUID(), surface: request.facts.surface,
      userId: known(request.facts.actor), rolesAtTime: known([...request.facts.roles]),
      actingInstitution: known(request.facts.institution), managingInstitution: known(institution),
      occurredAt: new Date().toISOString(), trustedProxyIp: request.facts.ingress,
      executor: 'member', cause: 'user-view',
      context: { basis: 'out-of-context', studyId: null, relatedStudyId: null, reason: null },
      // The target is the immutable audit row, including patientless authentication
      // rows. Do not invent a patient or expose the unserved look-ahead row.
      targets: page.map(row => ({ kind: 'access-audit', patientLinkSnapshot: na, studyId: na,
        recordId: known(row.entry_id), versionId: na })),
      action: 'provide-prepared', result: 'prepared', requestId: request.facts.requestId,
      auditLinkId: `audit:${randomUUID()}`, relatedEventId: null,
    };
    try { await request.work.append(event); }
    catch { throw new ServiceUnavailableException('접속기록 열람을 기록하지 못했습니다. 다시 조회하세요.'); }
    await this.access.unchanged(caller, access);
    await request.requireCurrent();
    const next: Cursor | null = rows.length > PAGE_SIZE ? { top, before: String(page[page.length - 1].sequence),
      from, until, downloads, institution } : null;
    return { institutionId: institution, from, until, observedAt: new Date().toISOString(), rows: result,
      next: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null };
  }
}
