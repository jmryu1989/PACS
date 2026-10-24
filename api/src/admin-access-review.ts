import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { Caller } from './pacs.service';
import { inst, need } from './pacs/access';

// Reuse the existing Admin audit page size; this is presentation, not a review threshold.
const PAGE_SIZE = 25;
type Cursor = { top: string; before: string; from: string; until: string; downloads: boolean; institution: string };
type Row = { entry_id: string; sequence: bigint; event_id: string; occurred_at: Date; recorded_at: Date;
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

  async read(query: unknown, caller: Caller) {
    need(caller.roles, 'admin', '접속기록 점검');
    const institution = inst(caller);
    if (caller.kind !== 'member') throw new ForbiddenException('관리자 회원 계정이 필요합니다.');
    const { from, until, downloads, cursor } = queryOptions(query, institution);
    const access = await this.access.snapshot(caller);
    if (access.policy.restricted) throw new ForbiddenException('검사 접근 범위가 제한된 계정은 접속기록을 조회할 수 없습니다.');
    let rows: Row[], top: string;
    try {
      top = cursor?.top ?? String((await this.db.$queryRaw<{ top: bigint }[]>`
        SELECT COALESCE(max(sequence), 0) AS top FROM emr_access.access_entry`)[0].top);
      // Filter recorded managing institution before pagination. Keep historical rows
      // without a viewing copy, but count a viewing/history pair as one event.
      rows = await this.db.$queryRaw<Row[]>`
        WITH scoped AS (
          SELECT *, payload::jsonb AS event FROM emr_access.access_entry
          WHERE sequence <= ${top}::bigint AND occurred_at >= ${from}::timestamptz AND occurred_at < ${until}::timestamptz
            AND payload::jsonb #>> '{managingInstitution,status}' = 'known'
            AND payload::jsonb #>> '{managingInstitution,value}' = ${institution}
        ), events AS (
          SELECT DISTINCT ON (event_id) * FROM scoped
          WHERE NOT ${downloads}::boolean OR event->>'action' IN ('download','pdf','copy','disclosure')
            OR event->>'surface' LIKE '%original-downloads%'
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(event->'targets') target
                       WHERE target->>'kind' IN ('download','pdf','copy','disclosure'))
          ORDER BY event_id, sequence
        )
        SELECT entry_id::text, sequence, event_id, occurred_at, recorded_at, statutory_act, payload FROM events
        WHERE (${cursor?.before ?? null}::bigint IS NULL OR sequence < ${cursor?.before ?? null}::bigint)
        ORDER BY sequence DESC LIMIT ${PAGE_SIZE + 1}`;
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
    const next: Cursor | null = rows.length > PAGE_SIZE ? { top, before: String(page[page.length - 1].sequence),
      from, until, downloads, institution } : null;
    return { institutionId: institution, from, until, observedAt: new Date().toISOString(), rows: result,
      next: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null };
  }
}
