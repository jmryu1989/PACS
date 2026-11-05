import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IncomingMessage } from 'node:http';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { identity, newAuditLinkId, patientLink } from '../emr-contract/access-event';
import type { AccessTarget, AccessEventV1 } from '../emr-contract/access-event';
import { clauseVersionAt, HOLD_CLAUSE_VERSIONS } from '../emr-contract/legal-basis';
import type { LegalHold } from '../emr-contract/lawful-defaults';
import { choice, object, refuse, string, utc } from '../emr-contract/validation';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource, RequestWorkContext } from '../emr-runtime/request-context';
import type { RecordMutation } from '../emr-runtime/store';
import { lockFixedRecords } from '../emr-runtime/fixed-record-lock';
import * as F from './contract';
import { loadFixedVersions, requireRecordKind } from './fixed-versions';
import { fixedOriginals, onlineFixedListing } from './fixed-listing';
import { fixedContentType, fixedDocument } from './fixed-document';
import { rightsRecords } from './rights-records';
import { RightsIntake, RightsState, rightsView } from './rights-state';
import { IncidentState, IncidentStep, INCIDENT_FORMS, incidentDraft } from './incident-state';

type Tx = Prisma.TransactionClient;
type HeldRequest = { kind: 'access-request'; request: F.DisclosureRequest; facts: F.RequestDeadlineFacts; holds: LegalHold[]; issuanceId: string | null };
const known = <T>(value: T) => ({ status: 'known' as const, value });
const none = { status: 'not-applicable' as const, reason: 'non-record-target' as const };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
function requestValue<T>(parse: () => T): T {
  try { return parse(); } catch { return refuse('AuditRequestInvalid'); }
}
const requestBody = (input: unknown, keys: readonly string[]) => requestValue(() => object(input, keys));
type InspectionSnapshot = {
  summary: { institutionId: string; month: string; from: string; to: string; top: string; eventCount: number;
    byAction: Record<string, number>; ledgerSha256: string };
  downloads: AccessEventV1[];
  cycle: F.InspectionCycle | null;
  status: ReturnType<typeof F.inspectionStatus> | null;
};

/** RequestContextSource owns current session/member facts. F adds only its
 * designated-auditor roster; the general admin role is not an audit grant. */
@Injectable()
export class EmrAuditService {
  constructor(private readonly db: PrismaService,
    @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource) {}

  private async lock(tx: Tx, key: string): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`;
  }
  private async authority(tx: Tx, context: RequestWorkContext): Promise<F.AuditAuthority> {
    const f = context.facts;
    const roster = JSON.stringify(['emr-f-roster', f.institution]);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${roster},0))::text`;
    const rows = await tx.$queryRaw<{ body: F.RosterGrant }[]>`SELECT DISTINCT ON(grant_id) body
      FROM emr_audit.roster_event WHERE subject_id=${f.actor.id} ORDER BY grant_id,sequence DESC`;
    return F.resolveAuditAuthority({ listGrants: () => ({ subject: f.actor, complete: true, grants: rows.map(r => r.body) }) },
      { identity: f.actor, institutionId: f.institution, roles: f.roles }, now());
  }
  private async run<T>(request: IncomingMessage, task: (tx: Tx, ctx: RequestWorkContext, record: RecordMutation) => Promise<T>): Promise<T> {
    return this.requests.withWork(request, async ctx => {
      const result = await ctx.work.transactionWithRecords(async (tx, record) => {
        await ctx.requireCurrent(tx);
        return task(tx, ctx, record);
      });
      await ctx.requireCurrent(); ctx.assertActive();
      return result;
    });
  }
  private async recorded(record: RecordMutation, ctx: RequestWorkContext, action: AccessEventV1['action'],
    targets: readonly F.InvestigationAuditTarget[], reference: string, surface = ctx.facts.surface): Promise<void> {
    const f = ctx.facts;
    const event: AccessEventV1 = { formatVersion: 1, surface, eventId: randomUUID(),
      userId: known(f.actor), rolesAtTime: known(f.roles), actingInstitution: known(f.institution), managingInstitution: known(f.institution),
      occurredAt: now(), trustedProxyIp: f.ingress, cause: 'user-view',
      context: { basis: 'out-of-context', studyId: null, relatedStudyId: null, reason: null }, executor: 'member',
      targets, action, result: action === 'provide-prepared' ? 'prepared' : 'succeeded',
      requestId: f.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null };
    // B1's admit_operation/storage contract caps the canonical UTF-8 payload at 65,536 bytes.
    // Partition by bytes, keeping every target and the request correlation in the same transaction.
    const cap = 65_536, overhead = Buffer.byteLength(JSON.stringify({ ...event, targets: [] }));
    let chunk: F.InvestigationAuditTarget[] = [], bytes = overhead;
    const append = async () => {
      // B1 validates each complete chunk at admission; avoid parsing the unbounded export first.
      await record({ ...event, eventId: randomUUID(), auditLinkId: newAuditLinkId(), targets: chunk },
        async () => ({ kind: 'emr-audit', id: reference, version: null }));
    };
    for (const target of event.targets) {
      const size = Buffer.byteLength(JSON.stringify(target));
      if (overhead + size > cap) refuse('AccessPayloadInvalid');
      if (chunk.length && bytes + size + 1 > cap) { await append(); chunk = []; bytes = overhead; }
      bytes += size + (chunk.length ? 1 : 0); chunk.push(target);
    }
    if (chunk.length || !event.targets.length) await append();
  }

  private async rosterSubject(tx: Tx, input: unknown) {
    const subject = requestValue(() => {
      const v = object(input, ['issuer','subject']);
      return { issuer: string(v.issuer), subject: string(v.subject) };
    });
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT
      emr_access.existing_member_identity(${subject.issuer},${subject.subject})::text AS id`;
    if (!row?.id) refuse('AuditIdentityUnknown');
    return identity({ ...subject, id: row.id });
  }

  async changeRoster(request: IncomingMessage, grantId: string, input: unknown) {
    return this.run(request, async (tx, ctx, record) => {
      string(grantId);
      await this.lock(tx, JSON.stringify(['emr-f-roster', ctx.facts.institution]));
      await this.lock(tx, JSON.stringify(['emr-f-grant', grantId]));
      const [grantor] = await tx.$queryRaw<{ capacity: F.GrantorCapacity; basis_document_id: string }[]>`
        SELECT capacity,basis_document_id FROM emr_audit.grantor
        WHERE institution_id=${ctx.facts.institution} AND subject_id=${ctx.facts.actor.id}`;
      if (!grantor) refuse('AuditorDesignationAuthorityRequired');
      const [previous] = await tx.$queryRaw<{ body: F.RosterGrant }[]>`SELECT body FROM emr_audit.roster_event
        WHERE grant_id=${grantId} ORDER BY sequence DESC LIMIT 1`;
      if (previous && previous.body.institutionId !== ctx.facts.institution) refuse('AuditScopeNotGranted');
      const kind = requestValue(() => choice((input as any)?.kind, ['granted','changed','revoked']));
      const body = requestBody(input, kind === 'granted' ? ['kind','subject','scopes','validFrom','validUntil'] :
        kind === 'changed' ? ['kind','scopes','validUntil'] : ['kind','reason']);
      const event: Record<string, any> = { ...body, eventId: randomUUID(), at: now(), by: ctx.facts.actor,
        capacity: grantor.capacity, basisDocumentId: grantor.basis_document_id };
      delete event.subject;
      const grant: F.RosterGrant = previous ? { ...previous.body, events: [...previous.body.events, event as F.RosterEvent] } :
        { grantId, subject: await this.rosterSubject(tx, body.subject), institutionId: ctx.facts.institution, events: [event as F.RosterEvent] };
      F.grantStateAt(grant, now());
      await tx.$executeRaw`INSERT INTO emr_audit.roster_event(grant_id,institution_id,subject_id,body)
        VALUES(${grantId},${grant.institutionId},${grant.subject.id},${JSON.stringify(grant)}::json)`;
      await this.recorded(record, ctx, 'modify', [{ kind: 'identity-access', patientLinkSnapshot: none,
        studyId: none, recordId: known(grant.subject.id), versionId: known(event.eventId) }], grantId);
      return grant;
    });
  }

  async investigate(request: IncomingMessage, input: unknown, mode: 'view' | 'export' = 'view') {
    try { return await this.run(request, async (tx, ctx, record) => {
      const authority = await this.authority(tx, ctx);
      const { changesAfter, viewsAfter, changesDone, viewsDone, ...query } = requestBody(input, Object.keys(input ?? {}));
      if ([changesDone, viewsDone].some(value => value !== undefined && typeof value !== 'boolean') ||
          (changesDone && viewsDone) || (changesDone && changesAfter) || (viewsDone && viewsAfter) ||
          (mode === 'export' && (changesDone || viewsDone))) refuse('InvestigationQueryRefused');
      if ('after' in query) refuse('InvestigationQueryRefused');
      const changes = F.planInvestigation(authority, { ...query, ...(changesAfter ? { after: changesAfter } : {}) }, mode);
      const views = F.planInvestigation(authority, { ...query, ...(viewsAfter ? { after: viewsAfter } : {}) }, mode);
      const fetch = async (stream: 'history' | 'viewing', top: number | null, below: number | null, take: number,
        filters: object = changes.filters) => tx.$queryRaw<{
        sequence: bigint; payload: string; recorded_at: Date; snapshot_top: bigint }[]>`
        SELECT * FROM emr_access.investigation_entries(${stream},${changes.institutionId},${changes.filters.from}::timestamptz,
          ${changes.filters.to}::timestamptz,${top}::bigint,${below}::bigint,${take}::integer,${JSON.stringify(filters)}::jsonb)`;
      // Changed events occur in both streams. Decode once; the replay boundary validates each row.
      const parsed = new Map<string, unknown>();
      const eventOf = (payload: string) => {
        let event = parsed.get(payload);
        if (!event) { event = JSON.parse(payload); parsed.set(payload, event); }
        return event;
      };
      // An explicitly unrequested stream must not query storage or generate access targets.
      // Keep the contract's stream-bound cursors; expose omitted streams as null below.
      const source = (stream: 'history' | 'viewing'): F.InvestigationLedger =>
        (stream === 'history' ? changesDone : viewsDone) ? { top: async () => 0, count: async () => 0, rows: async () => [] } : ({
        // The ceiling is the stream's highest in-window entry, matching or not. A filtered read returns no row when
        // nothing matches, which would report "nothing found up to sequence 0" instead of up to the ceiling.
        top: async () => Number((await fetch(stream, null, null, 1, {}))[0]?.snapshot_top ?? 0),
        count: async (top, filters) => Number((await tx.$queryRaw<{ total: bigint }[]>`
          SELECT emr_access.investigation_count(${stream},${changes.institutionId},${filters.from}::timestamptz,
            ${filters.to}::timestamptz,${top}::bigint,${JSON.stringify(filters)}::jsonb) AS total`)[0].total),
        rows: async (top, below, take) => (await fetch(stream, top, below, take)).map(r => ({
          entry: { sequence: Number(r.sequence), payload: { kind: 'access', event: eventOf(r.payload) } },
          durableAt: r.recorded_at.toISOString(), served: null })),
      });
      const page = await F.readInvestigationStreams({ changes, views }, { changes: source('history'), views: source('viewing') });
      const ids = [...new Set([...page.changes.rows, ...page.views.rows].flatMap(r => [r.eventId, ...(r.relatedEventId ? [r.relatedEventId] : [])]))];
      // E's primary/index keys are UUIDs; other B1 event IDs have no E facts.
      const imageIds = ids.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
      // E keeps one copy of each study-manifest body and a preparation names it (source_manifest_body); earlier rows
      // hold their own copy (source_manifest). The page carries each named body once, by its digest: joined onto every
      // preparation, a 200-response CT page repeated the whole-study body 200 times (R244-GPT-04).
      // A study delivery's one ledger event covers every response row that names it (delivery_event_id); a row written
      // before study deliveries is its own ledger event.
      const prepared = imageIds.length ? await tx.$queryRaw<any[]>`SELECT p.event_id::text,p.delivery_event_id::text,p.request_id,
        p.source_manifest,p.source_manifest_body,p.response_manifest,p.staging_copies FROM emr_image.preparation p
        WHERE p.event_id=ANY(${imageIds}::uuid[]) OR p.delivery_event_id=ANY(${imageIds}::uuid[])` : [];
      const named = [...new Set(prepared.map(p => p.source_manifest_body).filter((sha): sha is string => typeof sha === 'string'))];
      const sourceManifests: Record<string, unknown> = {};
      if (named.length) for (const row of await tx.$queryRaw<{ body_sha256: string; body: unknown }[]>`SELECT body_sha256,body
        FROM emr_image.source_manifest WHERE body_sha256=ANY(${named}::text[])`) sourceManifests[row.body_sha256] = row.body;
      const responseIds = [...new Set([...imageIds, ...prepared.map(p => p.event_id)])];
      // An observation names its delivery record itself (since 20261027150000): a response whose preparation failed
      // has no preparation row, and its copy observation is found from the record all the same.
      const observations = responseIds.length ? await tx.$queryRaw<any[]>`SELECT event_id::text,delivery_event_id::text,request_id,
        sequence::text,kind,body,retained_after FROM emr_image.observation
        WHERE event_id=ANY(${responseIds}::uuid[]) OR delivery_event_id=ANY(${imageIds}::uuid[]) ORDER BY sequence` : [];
      const joined = new Map<string, { eventId: string; deliveryEventId: string | null; preparation: any; observations: any[] }>();
      for (const { delivery_event_id, ...p } of prepared)
        joined.set(p.event_id, { eventId: p.event_id, deliveryEventId: delivery_event_id ?? null, preparation: p, observations: [] });
      for (const { event_id, delivery_event_id, ...observation } of observations) {
        if (!joined.has(event_id)) joined.set(event_id, { eventId: event_id, deliveryEventId: delivery_event_id ?? null, preparation: null, observations: [] });
        joined.get(event_id).observations.push(observation);
      }
      const images = [...joined.values()];
      const event = F.investigationLedgerEvent(page.changes), viewEvent = F.investigationLedgerEvent(page.views);
      const targets = [...new Map([...event.targets, ...viewEvent.targets].map(t => [JSON.stringify(t), t])).values()];
      await this.recorded(record, ctx, event.action, targets, changes.planId);
      return { ...page, changes: changesDone ? null : page.changes, views: viewsDone ? null : page.views,
        totalEntries: changesDone || viewsDone ? null : page.totalEntries, images, sourceManifests };
    }); } catch (error) {
      if (error?.code === 'P2028' || error?.meta?.code === '57014') F.ledgerReadFailure(error);
      throw error;
    }
  }

  private inspectionKey(institution: string) { return JSON.stringify(['emr-f-inspection', institution]); }
  private inspectionWindow(month: string, at: string) {
    // Reuse the contract's month validator and ended-month rule, including Seoul boundaries.
    F.newInspectionCycle('validation', month);
    if (month >= F.inspectionMonth(at)) refuse('InspectionMonthNotEnded');
    const from = new Date(`${month}-01T00:00:00+09:00`);
    // from is the preceding UTC date; derive the next local calendar first explicitly.
    const [year, part] = month.split('-').map(Number);
    return { from: from.toISOString(), to: new Date(Date.UTC(year, part, 1) - 9 * 3600_000).toISOString() };
  }
  private async savedInspection(tx: Tx, institution: string, month: string): Promise<InspectionSnapshot | null> {
    const where = { target: this.inspectionKey(institution), action: `inspection:${month}` };
    const report = await tx.auditLog.findFirst({ where, orderBy: { id: 'asc' } });
    if (!report) return null;
    // The first row owns the immutable report; subsequent rows carry only the latest cycle.
    const latest = await tx.auditLog.findFirst({ where, orderBy: { id: 'desc' } });
    const saved: InspectionSnapshot = JSON.parse(report.detail), { cycle } = JSON.parse(latest.detail);
    if (saved.cycle?.institutionId !== institution || saved.cycle.month !== month ||
        cycle?.cycleId !== saved.cycle.cycleId || cycle?.institutionId !== institution || cycle.month !== month) refuse('InspectionCycleRefused');
    return { ...saved, cycle, status: F.inspectionStatus(cycle) };
  }
  private async inspectionSnapshot(tx: Tx, institutionId: string, month: string, at: string): Promise<InspectionSnapshot> {
    const window = this.inspectionWindow(month, at), digest = createHash('sha256');
    let top: string | null = null, below: string | null = null, eventCount = 0;
    const byAction: Record<string, number> = Object.create(null), downloads: AccessEventV1[] = [];
    // The viewing stream also contains changes: scanning it once avoids counting them twice.
    // Pin its ceiling for the whole scan, and fail the transaction rather than store a partial report.
    for (;;) {
      const rows: { sequence: bigint; payload: string; snapshot_top: bigint }[] = await tx.$queryRaw`
        SELECT * FROM emr_access.investigation_entries(${'viewing'},${institutionId},${window.from}::timestamptz,
          ${window.to}::timestamptz,${top}::bigint,${below}::bigint,${500}::integer,${'{}'}::jsonb)`;
      if (top === null) top = String(rows[0]?.snapshot_top ?? 0);
      for (const row of rows) {
        const event: AccessEventV1 = JSON.parse(row.payload);
        digest.update(`${row.sequence}:${Buffer.byteLength(row.payload)}:`).update(row.payload);
        eventCount++; byAction[event.action] = (byAction[event.action] || 0) + 1;
        if ((F.DOWNLOAD_ACTIONS as readonly string[]).includes(event.action)) downloads.push(event);
      }
      if (rows.length < 500) break;
      below = String(rows[rows.length - 1].sequence);
    }
    return { summary: { institutionId, month, ...window, top, eventCount,
      byAction: Object.fromEntries(Object.entries(byAction).sort(([a], [b]) => a.localeCompare(b))), ledgerSha256: digest.digest('hex') },
      downloads, cycle: null, status: null };
  }
  private async saveInspection(tx: Tx, ctx: RequestWorkContext, snapshot: InspectionSnapshot | { cycle: F.InspectionCycle }) {
    await tx.auditLog.create({ data: { actor: ctx.facts.actor.id, action: `inspection:${snapshot.cycle.month}`,
      target: this.inspectionKey(ctx.facts.institution), detail: JSON.stringify(snapshot) } });
  }
  private inspectionTarget(month: string): F.InvestigationAuditTarget {
    return { kind: 'access-audit', patientLinkSnapshot: none, studyId: none, recordId: known(`inspection:${month}`), versionId: none };
  }
  private inspectionDownloadTargets(events: readonly AccessEventV1[]): F.InvestigationAuditTarget[] {
    const targets: F.InvestigationAuditTarget[] = [];
    for (const event of events) {
      const shown = new Map<string, F.InvestigationAuditTarget>();
      for (const target of event.targets) {
        const reference = { kind: 'access-audit' as const, studyId: target.studyId,
          recordId: known(event.eventId), versionId: known(event.eventId) };
        let viewed: F.InvestigationAuditTarget, key: string;
        if ('sourcePatientId' in target) {
          viewed = { ...reference, sourcePatientId: target.sourcePatientId, sourceInstitution: target.sourceInstitution };
          key = JSON.stringify(['local', target.sourcePatientId, target.sourceInstitution, target.studyId]);
        } else if (target.patientLinkSnapshot.status === 'known') {
          viewed = { ...reference, patientLinkSnapshot: target.patientLinkSnapshot };
          key = JSON.stringify([target.patientLinkSnapshot.value.patientId, target.patientLinkSnapshot.value.assigningAuthority, target.studyId]);
        } else continue;
        if (!shown.has(key)) shown.set(key, viewed);
      }
      // A patient-less event is still shown; local observations never become formal links.
      targets.push(...(shown.size ? shown.values() : [{ kind: 'access-audit' as const, patientLinkSnapshot: none,
        studyId: none, recordId: known(event.eventId), versionId: known(event.eventId) }]));
    }
    return targets;
  }
  async inspectionMonths(request: IncomingMessage) {
    try { return await this.run(request, async (tx, ctx, record) => {
      const authority = F.requireScope(await this.authority(tx, ctx), 'inspection'), at = now();
      const institution = await tx.institution.findUnique({ where: { id: authority.institutionId }, select: { createdAt: true } });
      if (!institution) refuse('AuditRequestInvalid');
      // Include empty months from institution registration; report generation alone is not human inspection.
      const first = F.inspectionMonth(institution.createdAt.toISOString()), months = [];
      for (const month of F.inspectionMonthsDue(first, at)) {
        const saved = await this.savedInspection(tx, authority.institutionId, month);
        if (!saved || !['ready-to-close', 'closed'].includes(saved.status.state)) months.push({ month, state: saved?.status.state ?? 'awaiting-report' });
      }
      await this.recorded(record, ctx, 'provide-prepared', months.map(m => this.inspectionTarget(m.month)), this.inspectionKey(authority.institutionId));
      return { period: F.INSPECTION_PERIOD, firstMonth: first, months };
    }); } catch (error) {
      if (error?.code === 'P2028' || error?.code === '57014' || error?.meta?.code === '57014') F.ledgerReadFailure(error);
      throw error;
    }
  }
  async inspection(request: IncomingMessage, month: string, start = false) {
    try { return await this.run(request, async (tx, ctx, record) => {
      const authority = F.requireScope(await this.authority(tx, ctx), 'inspection'), at = now();
      this.inspectionWindow(month, at);
      await this.lock(tx, JSON.stringify(['emr-f-inspection', authority.institutionId, month]));
      let snapshot = await this.savedInspection(tx, authority.institutionId, month);
      if (!snapshot) {
        snapshot = await this.inspectionSnapshot(tx, authority.institutionId, month, at);
        if (start) {
          const cycle = F.recordInspectionReport(F.newInspectionCycle(authority.institutionId, month), {
            reportSha256: hash(Buffer.from(JSON.stringify(snapshot.summary))), eventCount: snapshot.summary.eventCount,
            downloadEventIds: snapshot.downloads.map(e => e.eventId) }, at);
          snapshot = { ...snapshot, cycle, status: F.inspectionStatus(cycle) };
          await this.saveInspection(tx, ctx, snapshot);
        }
      }
      await this.recorded(record, ctx, 'provide-prepared', [this.inspectionTarget(month),
        ...this.inspectionDownloadTargets(snapshot.downloads)], `inspection:${month}`);
      return snapshot;
    }); } catch (error) {
      if (error?.code === 'P2028' || error?.code === '57014' || error?.meta?.code === '57014') F.ledgerReadFailure(error);
      throw error;
    }
  }
  // 감사자 화면의 모든 응답은 보여주는 만큼만 기록하고, 기록하지 않는 응답은 환자 식별자를 담지 않는다.
  async inspectionStep(request: IncomingMessage, month: string, input: unknown) {
    try { return await this.run(request, async (tx, ctx, record) => {
      const authority = F.requireScope(await this.authority(tx, ctx), 'inspection');
      this.inspectionWindow(month, now());
      await this.lock(tx, JSON.stringify(['emr-f-inspection', authority.institutionId, month]));
      const snapshot = await this.savedInspection(tx, authority.institutionId, month);
      if (!snapshot) refuse('InspectionReportRequired');
      const at = now();
      const kind = requestValue(() => choice((input as any)?.kind, ['download-check', 'reviewed', 'action-recorded', 'rechecked']));
      let cycle = snapshot.cycle;
      if (kind === 'download-check') {
        const v = requestBody(input, ['kind', 'eventId', 'reason', 'outcome', 'followUp']);
        const followUp = requestValue(() => string(v.followUp)), reason = requestValue(() => string(v.reason));
        cycle = F.recordInspectionStep(authority, cycle, { kind: 'download-reason', at, eventId: v.eventId,
          reason: `${reason}\n후속조치: ${followUp}`, outcome: v.outcome });
        if (v.outcome === 'investigate') cycle = F.recordInspectionStep(authority, cycle, {
          kind: 'action-recorded', at, investigationId: (cycle.events[cycle.events.length - 1] as any).investigationId, action: followUp });
      } else {
        const v = requestBody(input, kind === 'reviewed' ? ['kind', 'conclusion', 'note'] :
          kind === 'action-recorded' ? ['kind', 'investigationId', 'action'] : ['kind', 'investigationId', 'result', 'note']);
        cycle = F.recordInspectionStep(authority, cycle, { ...v, at });
      }
      const next = { cycle, status: F.inspectionStatus(cycle) };
      await this.saveInspection(tx, ctx, { cycle });
      await this.recorded(record, ctx, 'write', [this.inspectionTarget(month)], cycle.cycleId);
      return next;
    }); } catch (error) {
      if (error?.code === 'P2028' || error?.code === '57014' || error?.meta?.code === '57014') F.ledgerReadFailure(error);
      throw error;
    }
  }

  private async issuance(tx: Tx, id: string, institution: string): Promise<F.Issuance> {
    await this.lock(tx, JSON.stringify(['emr-f-issuance', id]));
    const [row] = await tx.$queryRaw<{ body: F.Issuance }[]>`SELECT body FROM emr_audit.issuance_event
      WHERE issuance_id=${id} AND institution_id=${institution} ORDER BY sequence DESC LIMIT 1`;
    if (!row) refuse('IssuanceNotFound');
    F.issuanceState(row.body); return row.body;
  }

  private async incidentAuthority(tx: Tx, ctx: RequestWorkContext, step?: IncidentStep) {
    if (!step) {
      const authority = await this.authority(tx, ctx);
      F.requireScope(authority, 'investigate'); return F.requireScope(authority, 'export');
    }
    // Reconstruct the authority at acceptance, so reopening never attributes an old finding to today's reader.
    const rows = await tx.$queryRaw<{ body: F.RosterGrant }[]>`SELECT DISTINCT ON(grant_id) body
      FROM emr_audit.roster_event WHERE subject_id=${step.by.id} ORDER BY grant_id,sequence DESC`;
    return F.resolveAuditAuthority({ listGrants: () => ({ subject: step.by, complete: true, grants: rows.map(r => r.body) }) },
      { identity: step.by, institutionId: ctx.facts.institution, roles: step.roles }, step.at);
  }
  private async savedIncident(tx: Tx, id: string, institution: string): Promise<IncidentState | null> {
    await this.lock(tx, JSON.stringify(['emr-f-request', id]));
    const [row] = await tx.$queryRaw<{ body: IncidentState; institution_id: string }[]>`SELECT body,institution_id
      FROM emr_audit.request_event WHERE request_id=${id} ORDER BY sequence DESC LIMIT 1`;
    if (row && row.institution_id !== institution) refuse('IncidentNotFound');
    if (row && row.body.kind !== 'incident') refuse('IncidentConflict');
    return row?.body ?? null;
  }
  private async saveIncident(tx: Tx, state: IncidentState) {
    await tx.$executeRaw`INSERT INTO emr_audit.request_event(request_id,institution_id,body)
      VALUES(${state.incidentId},${state.institutionId},${JSON.stringify(state)}::json)`;
  }
  private async incidentFacts(tx: Tx, ctx: RequestWorkContext, input: unknown, id: string, at: string) {
    const facts = requestValue(() => ({ ...object(input, Object.keys(input ?? {})), incidentId: id, recordedAt: at })) as F.IncidentResponseFacts;
    if (facts.ispIncident) {
      facts.ispIncident = structuredClone(facts.ispIncident);
      if (facts.ispIncident.verification) facts.ispIncident.verification.by = ctx.facts.actor;
      // An auditor assignment is not a privacy-officer designation. Bind the special decision maker to the installer fact.
      for (const item of [facts.ispIncident.userNoticeDecision, facts.ispIncident.userImpact]) if (item) {
        const [grantor] = await tx.$queryRaw<{ capacity: F.GrantorCapacity; basis_document_id: string }[]>`SELECT capacity,basis_document_id
          FROM emr_audit.grantor WHERE institution_id=${ctx.facts.institution} AND subject_id=${ctx.facts.actor.id}`;
        if (!grantor) refuse('AuditorDesignationAuthorityRequired');
        item.decider = { ...item.decider, by: ctx.facts.actor, ownerId: ctx.facts.institution,
          status: grantor.capacity === 'institution-representative' ? 'representative' : 'verified-privacy-officer',
          evidenceId: grantor.basis_document_id };
      }
    }
    return facts;
  }
  private async incidentProjection(tx: Tx, ctx: RequestWorkContext, state: IncidentState, at: string) {
    let plan: Readonly<F.IncidentResponsePlan>;
    const originalAuthority = await this.incidentAuthority(tx, ctx, state.steps[0]);
    const source: F.InvestigationLedger = {
      top: async () => { if (state.snapshot.failure) refuse(state.snapshot.failure); return state.snapshot.top; },
      rows: async (top, below, take) => state.snapshot.rows.filter(r => {
        const sequence = (r.entry as { sequence: number }).sequence; return sequence <= top && (below === null || sequence < below);
      }).slice(0, take),
    };
    // The scope determination belongs to registration, even when another auditor later records a notice.
    const scope = await F.incidentScope(originalAuthority, F.planInvestigation(originalAuthority, state.query, 'export'), source, state.determinations);
    for (const step of state.steps) {
      const authority = await this.incidentAuthority(tx, ctx, step);
      plan = F.planIncidentResponse(authority, scope, step.facts, { previous: plan, notices: step.notices,
        decisions: step.decisions, delays: step.delays, asOf: step.at });
    }
    const authority = await this.incidentAuthority(tx, ctx);
    plan = F.planIncidentResponse(authority, scope, state.steps.at(-1).facts, { previous: plan, asOf: at });
    return { scope, plan };
  }
  private incidentTargets(state: IncidentState, scope?: F.IncidentScope): F.InvestigationAuditTarget[] {
    // A complete scope retains its contract-produced patient and local-source targets, even on a draft download.
    return [{ kind: 'access-audit', patientLinkSnapshot: none, studyId: none,
      recordId: known(state.incidentId), versionId: none }, ...(scope?.auditEvent.targets ?? [])];
  }
  async registerIncident(request: IncomingMessage, input: unknown) {
    return this.run(request, async (tx, ctx, record) => {
      const authority = await this.incidentAuthority(tx, ctx), at = now();
      const v = requestBody(input, ['incidentId', 'incidentType', 'query', 'determinations', 'facts']);
      const id = requestValue(() => string(v.incidentId));
      let state = await this.savedIncident(tx, id, authority.institutionId), changed = false;
      if (state && !isDeepStrictEqual(state.intake, input)) refuse('IncidentConflict');
      if (!state) {
        const plan = F.planInvestigation(authority, v.query, 'export');
        const rows: F.LedgerRow[] = [];
        let top: number | null = null;
        const source: F.InvestigationLedger = {
          top: async () => {
            const found = await tx.$queryRaw<{ snapshot_top: bigint }[]>`SELECT * FROM emr_access.investigation_entries(
              ${'viewing'},${authority.institutionId},${plan.filters.from}::timestamptz,${plan.filters.to}::timestamptz,
              ${null}::bigint,${null}::bigint,${1}::integer,${'{}'}::jsonb)`;
            top = Number(found[0]?.snapshot_top ?? 0); return top;
          },
          rows: async (ceiling, below, take) => {
            const found = await tx.$queryRaw<{ sequence: bigint; payload: string; recorded_at: Date }[]>`SELECT * FROM emr_access.investigation_entries(
              ${'viewing'},${authority.institutionId},${plan.filters.from}::timestamptz,${plan.filters.to}::timestamptz,
              ${ceiling}::bigint,${below}::bigint,${take}::integer,${JSON.stringify(plan.filters)}::jsonb)`;
            const page = found.map(r => ({ entry: { sequence: Number(r.sequence), payload: { kind: 'access', event: JSON.parse(r.payload) } },
              durableAt: r.recorded_at.toISOString(), served: null })); rows.push(...page); return page;
          },
        };
        const scope = await F.incidentScope(authority, plan, source, v.determinations);
        const facts = await this.incidentFacts(tx, ctx, v.facts, id, at);
        F.planIncidentResponse(authority, scope, facts, { asOf: at });
        state = { kind: 'incident', institutionId: authority.institutionId, incidentId: id,
          incidentType: requestValue(() => choice(v.incidentType, ['other', 'cvr-misdelivery'])), intake: input,
          query: v.query, determinations: v.determinations,
          snapshot: { top: top ?? 0, rows, failure: scope.reasons.find(r => r.kind === 'ledger-unreadable')?.['code'] ?? null },
          steps: [{ operationId: 'registration', input, facts, notices: [], by: ctx.facts.actor, roles: ctx.facts.roles, at }], closed: null };
        changed = true;
      }
      const projection = await this.incidentProjection(tx, ctx, state, at);
      if (changed) await this.saveIncident(tx, state);
      await this.recorded(record, ctx, changed ? 'write' : 'provide-prepared', this.incidentTargets(state, projection.scope), id);
      return this.incidentView(state, projection);
    });
  }
  private incidentView(state: IncidentState, projection: { scope: F.IncidentScope; plan: F.IncidentResponsePlan }) {
    return { incidentId: state.incidentId, incidentType: state.incidentType, status: state.closed ? 'Closed' : 'Open',
      closed: state.closed, ...projection, history: state.steps.map(s => ({ operationId: s.operationId, facts: s.facts,
        notices: s.notices, decisions: s.decisions ?? [], delays: s.delays ?? [], by: s.by, at: s.at })), cloud: '조건부 (#69)' };
  }
  async listIncidents(request: IncomingMessage) {
    return this.run(request, async (tx, ctx, record) => {
      const authority = await this.incidentAuthority(tx, ctx);
      const rows = await tx.$queryRaw<{ body: IncidentState }[]>`SELECT DISTINCT ON(request_id) body FROM emr_audit.request_event
        WHERE institution_id=${authority.institutionId} AND body->>'kind'='incident' ORDER BY request_id,sequence DESC`;
      const incidents = [];
      for (const { body: s } of rows) {
        const { plan } = await this.incidentProjection(tx, ctx, s, now());
        incidents.push({ incidentId: s.incidentId, incidentType: s.incidentType,
          status: s.closed ? 'Closed' : 'Open', supersededBy: s.closed?.supersededBy ?? null, verdict: plan.verdict, awarenessAt: plan.awarenessAt });
      }
      incidents.sort((a, b) => a.awarenessAt.localeCompare(b.awarenessAt) || a.incidentId.localeCompare(b.incidentId));
      await this.recorded(record, ctx, 'provide-prepared', rows.flatMap(r => this.incidentTargets(r.body)), 'incidents');
      return { incidents };
    });
  }
  async incidentAction(request: IncomingMessage, id: string, action: 'read' | 'finding' | 'notice' | 'close' | 'draft', input?: unknown) {
    return this.run(request, async (tx, ctx, record) => {
      await this.incidentAuthority(tx, ctx);
      const closure = action === 'close' ? requestValue(() => {
        const v = object(input, ['evidenceId', ...(Object.prototype.hasOwnProperty.call(input, 'supersededBy') ? ['supersededBy'] : [])]);
        return { evidenceId: string(v.evidenceId), ...(v.supersededBy !== undefined ? { supersededBy: string(v.supersededBy) } : {}) };
      }) : null;
      if (closure?.supersededBy) {
        if (closure.supersededBy === id) refuse('IncidentConflict');
        // Lock both request IDs in one order before reading either state; opposite replacements cannot race into a cycle.
        for (const key of [id, closure.supersededBy].sort()) await this.lock(tx, JSON.stringify(['emr-f-request', key]));
      }
      const at = now(), state = await this.savedIncident(tx, requestValue(() => string(id)), ctx.facts.institution);
      if (!state) refuse('IncidentNotFound');
      let changed = false;
      if (action === 'finding' || action === 'notice') {
        const kind = action === 'notice' ? 'notice' : requestValue(() => {
          const keys = ['facts', 'decision', 'delay'].filter(k => Object.prototype.hasOwnProperty.call(input, k));
          if (keys.length !== 1) refuse('AuditRequestInvalid'); return keys[0];
        });
        const v = requestBody(input, ['operationId', kind]);
        if (action === 'notice') requestValue(() => {
          const n = object(v.notice, ['kind', 'triggeredAt', 'noticeId', 'sentAt', 'triggerEventId', 'recipientScopeRef',
            'coversAll', 'evidenceId', 'coveredFields', 'channel', ...('posting' in (v.notice ?? {}) ? ['posting'] : [])]);
          string(n.evidenceId); string(n.noticeId); string(n.recipientScopeRef);
          if (typeof n.coversAll !== 'boolean') refuse('AuditRequestInvalid');
        });
        const operationId = requestValue(() => string(v.operationId));
        const previous = state.steps.find(s => s.operationId === operationId);
        if (previous) { if (!isDeepStrictEqual(previous.input, input)) refuse('IncidentConflict'); }
        else {
          if (state.closed) refuse('IncidentClosed');
          const facts = kind === 'facts' ? await this.incidentFacts(tx, ctx, v.facts, id, at) : state.steps.at(-1).facts;
          if (facts.awarenessAt !== state.steps[0].facts.awarenessAt) refuse('IncidentConflict');
          let evidence: F.IncidentDecision | F.IncidentDelay;
          if (kind === 'decision' || kind === 'delay') {
            evidence = { ...requestValue(() => object(v[kind], Object.keys(v[kind] ?? {}))), by: ctx.facts.actor, recordedAt: at } as typeof evidence;
            if (kind === 'decision' || (evidence as F.IncidentDelay).accepted || evidence.decider) {
              const [grantor] = await tx.$queryRaw<{ capacity: F.GrantorCapacity; basis_document_id: string }[]>`SELECT capacity,basis_document_id
                FROM emr_audit.grantor WHERE institution_id=${ctx.facts.institution} AND subject_id=${ctx.facts.actor.id}`;
              if (!grantor) refuse('AuditorDesignationAuthorityRequired');
              evidence.decider = { ...evidence.decider, by: ctx.facts.actor, ownerId: ctx.facts.institution,
                status: grantor.capacity === 'institution-representative' ? 'representative' : 'verified-privacy-officer',
                evidenceId: grantor.basis_document_id };
            }
          }
          state.steps.push({ operationId, input, facts, notices: action === 'notice' ? [{ ...v.notice,
            institutionId: state.institutionId, incidentId: id, recordedAt: at }] : [],
            ...(kind === 'decision' ? { decisions: [evidence as F.IncidentDecision] } : {}),
            ...(kind === 'delay' ? { delays: [evidence as F.IncidentDelay] } : {}), by: ctx.facts.actor, roles: ctx.facts.roles, at });
          changed = true;
        }
      }
      const projection = await this.incidentProjection(tx, ctx, state, at);
      if (action === 'close') {
        if (state.closed) {
          if (state.closed.evidenceId !== closure.evidenceId || state.closed.supersededBy !== closure.supersededBy) refuse('IncidentConflict');
        }
        else {
          if (closure.supersededBy) {
            const replacement = await this.savedIncident(tx, closure.supersededBy, ctx.facts.institution);
            if (!replacement) refuse('IncidentNotFound');
            if (replacement.closed) refuse('IncidentClosed');
          }
          // A possible finding is still an investigation. Closing never erases late or unverified duties.
          else if (projection.plan.verdict === 'possible' || projection.plan.obligations.some(o => o.stillOwed) ||
              projection.plan.ispAssessments.some(a => a.userNotice.applicability.includes('required') || a.initialReport.applicability === 'unverified'))
            refuse('IncidentDutiesOpen');
          state.closed = { ...closure, by: ctx.facts.actor, at }; changed = true;
        }
      }
      const form = action === 'draft' ? requestValue(() => choice(input, Object.keys(INCIDENT_FORMS) as (keyof typeof INCIDENT_FORMS)[])) : null;
      if (changed) await this.saveIncident(tx, state);
      await this.recorded(record, ctx, action === 'draft' ? 'download' : changed ? 'write' : 'provide-prepared',
        this.incidentTargets(state, projection.scope), id);
      return form ? incidentDraft(form, state, projection.scope, projection.plan) : this.incidentView(state, projection);
    });
  }
  private async saveIssuance(tx: Tx, issuance: F.Issuance) {
    await tx.$executeRaw`INSERT INTO emr_audit.issuance_event(issuance_id,institution_id,body)
      VALUES(${issuance.issuanceId},${issuance.manifest.institutionId},${JSON.stringify(issuance)}::json)`;
  }
  private async held(tx: Tx, requestId: string, institution: string): Promise<HeldRequest | null> {
    await this.lock(tx, JSON.stringify(['emr-f-request', requestId]));
    const [row] = await tx.$queryRaw<{ body: HeldRequest; institution_id: string }[]>`SELECT body,institution_id
      FROM emr_audit.request_event WHERE request_id=${requestId} ORDER BY sequence DESC LIMIT 1`;
    if (row && row.institution_id !== institution) refuse('AuditScopeNotGranted');
    if (row && row.body.kind !== 'access-request') refuse('DisclosureRequestConflict');
    return row?.body ?? null;
  }
  private async saveHeld(tx: Tx, institution: string, state: HeldRequest) {
    await tx.$executeRaw`INSERT INTO emr_audit.request_event(request_id,institution_id,body)
      VALUES(${state.facts.requestId},${institution},${JSON.stringify(state)}::json)`;
  }
  /** The complete record set is taken in one sorted pass, after request and issuance: every F path uses
   * roster → request → issuance → fixed records, and nothing after the fixed set but its own rows and the
   * retention trigger (77104,2). The selector names the store; the lock key stays the record ID. */
  private async fixed(tx: Tx, items: readonly { recordId: string; recordKind?: F.RecordKind }[]) {
    await lockFixedRecords(tx, items.map(i => i.recordId));
    const listings: object[] = [];
    for (const i of items) listings.push(await loadFixedVersions(tx, i.recordId, i.recordKind));
    return listings;
  }

  private async rightsAuthority(tx: Tx, ctx: RequestWorkContext) {
    return F.requireScope(await this.authority(tx, ctx), 'disclosure');
  }
  private async savedRights(tx: Tx, id: string, institution: string): Promise<RightsState | null> {
    await this.lock(tx, JSON.stringify(['emr-f-request', id]));
    const [row] = await tx.$queryRaw<{ body: RightsState; institution_id: string }[]>`SELECT body,institution_id
      FROM emr_audit.request_event WHERE request_id=${id} ORDER BY sequence DESC LIMIT 1`;
    if (row && row.institution_id !== institution) refuse('RequestNotFound');
    if (row && row.body.kind !== 'rights-request') refuse('RightsRequestConflict');
    return row?.body ?? null;
  }
  private async saveRights(tx: Tx, state: RightsState) {
    await tx.$executeRaw`INSERT INTO emr_audit.request_event(request_id,institution_id,body)
      VALUES(${state.request.requestId},${state.institutionId},${JSON.stringify(state)}::json)`;
  }
  private rightsTargets(state: RightsState): F.InvestigationAuditTarget[] {
    return state.request.recordIds.map(id => ({ kind: 'disclosure', patientLinkSnapshot: known(state.request.patient),
      studyId: { status: 'unresolved', reason: 'not-resolved' }, recordId: known(id),
      versionId: { status: 'unresolved', reason: 'not-resolved' } }));
  }
  async receiveRights(request: IncomingMessage, input: unknown) {
    return this.run(request, async (tx, ctx, record) => {
      const authority = await this.rightsAuthority(tx, ctx), at = now();
      const value: RightsIntake = requestValue(() => {
        const v = object(input, ['requestId', 'kind', 'receivedAt', 'patient', 'recordIds', 'statement']);
        if (!Array.isArray(v.recordIds) || !v.recordIds.length) refuse('RightsRequestRefused');
        // A record ID may name its store ({recordId, recordKind}); the stored request keeps the plain IDs.
        const recordKinds: Record<string, F.RecordKind> = {};
        const recordIds = v.recordIds.map(item => {
          if (typeof item === 'string') return string(item);
          const x = object(item, ['recordId', 'recordKind']), id = string(x.recordId);
          recordKinds[id] = choice(x.recordKind, ['report', 'clinical']);
          return id;
        });
        if (new Set(recordIds).size !== recordIds.length) refuse('RightsRequestRefused');
        return { requestId: string(v.requestId), kind: choice(v.kind, ['correction', 'deletion', 'processing-suspension']),
          receivedAt: utc(v.receivedAt), patient: patientLink(v.patient), recordIds, statement: string(v.statement),
          ...(Object.keys(recordKinds).length ? { recordKinds } : {}) };
      });
      let state = await this.savedRights(tx, value.requestId, authority.institutionId);
      if (state && !isDeepStrictEqual(state.request, value)) refuse('RightsRequestConflict');
      if (!state) {
        // The intake preview supplies the contract's deadline and validates stored subject facts.
        // It is not a recorded decision; the explicit decision reloads originals under the same locks.
        const preview = F.decideRightsRequest(authority, value, await rightsRecords(tx, value.recordIds, value.recordKinds), at);
        state = { kind: 'rights-request', institutionId: authority.institutionId, request: value,
          receivedBy: ctx.facts.actor, recordedAt: at, dueBy: preview.notice.dueBy, decision: null, notification: null };
        await tx.$queryRaw`SELECT emr_access.record_duty_request('correction-request',${value.requestId},'received',
          ${JSON.stringify({ requestId: value.requestId, recordIds: value.recordIds, receivedAt: value.receivedAt,
            responseDueAt: state.dueBy, resolution: null })})::text`;
        await this.saveRights(tx, state);
        await this.recorded(record, ctx, 'write', this.rightsTargets(state), value.requestId);
      } else await this.recorded(record, ctx, 'provide-prepared', this.rightsTargets(state), value.requestId);
      return rightsView(state, at);
    });
  }
  async listRights(request: IncomingMessage) {
    return this.run(request, async (tx, ctx, record) => {
      const authority = await this.rightsAuthority(tx, ctx), at = now();
      const rows = await tx.$queryRaw<{ body: RightsState }[]>`SELECT DISTINCT ON(request_id) body
        FROM emr_audit.request_event WHERE institution_id=${authority.institutionId} AND body->>'kind'='rights-request'
        ORDER BY request_id,sequence DESC`;
      // The list exposes request identifiers/status only. Patient/record details are recorded on detail reads.
      const requests = rows.map(({ body }) => { const v = rightsView(body, at); return {
        requestId: body.request.requestId, kind: body.request.kind, receivedAt: body.request.receivedAt,
        dueBy: body.dueBy, status: v.status, overdue: v.overdue,
      }; }).sort((a, b) => a.dueBy.localeCompare(b.dueBy) || a.requestId.localeCompare(b.requestId));
      await this.recorded(record, ctx, 'provide-prepared', requests.map(r => ({ kind: 'disclosure',
        patientLinkSnapshot: none, studyId: none, recordId: known(r.requestId), versionId: none })), 'rights-requests');
      return { requests };
    });
  }
  async rightsAction(request: IncomingMessage, id: string, action: 'read' | 'decide' | 'notify', input?: unknown) {
    return this.run(request, async (tx, ctx, record) => {
      const authority = await this.rightsAuthority(tx, ctx), at = now();
      const state = await this.savedRights(tx, requestValue(() => string(id)), authority.institutionId);
      if (!state) refuse('RequestNotFound');
      let changed = false;
      const withdrawing = action === 'notify' && input !== null && typeof input === 'object' &&
        (input as { outcome?: unknown }).outcome === 'withdrawn';
      if (state.withdrawal && (action === 'decide' || (action === 'notify' && !withdrawing))) refuse('RightsRequestWithdrawn');
      if (withdrawing) {
        const withdrawal = requestValue(() => {
          const v = object(input, ['outcome', 'evidenceId']);
          return { evidenceId: string(v.evidenceId) };
        });
        if (state.notification || (state.withdrawal && state.withdrawal.evidenceId !== withdrawal.evidenceId)) refuse('RightsRequestConflict');
        if (!state.withdrawal) {
          // Withdrawal closes the received duty even when originals can no longer be decided.
          // Preserve the prior request/decision and append only the evidenced ending fact.
          state.withdrawal = { ...withdrawal, recordedBy: ctx.facts.actor, recordedAt: at }; changed = true;
          await tx.$queryRaw`SELECT emr_access.record_duty_request('correction-request',${id},'resolved',
            ${JSON.stringify({ requestId: id, recordIds: state.request.recordIds, receivedAt: state.request.receivedAt,
              responseDueAt: state.dueBy, resolution: { at, eventId: withdrawal.evidenceId, outcome: 'withdrawn' } })})::text`;
        }
      }
      if (action === 'decide' && !state.decision) {
        state.decision = F.decideRightsRequest(authority, state.request, await rightsRecords(tx, state.request.recordIds, state.request.recordKinds), at);
        changed = true;
      }
      if (action === 'notify' && !withdrawing) {
        if (!state.decision) refuse('RightsDecisionRequired');
        const notice = requestValue(() => {
          const v = object(input, ['notifiedAt', 'recipient', 'method', 'evidenceId', 'content']);
          return { notifiedAt: utc(v.notifiedAt), recipient: string(v.recipient), method: string(v.method),
            evidenceId: string(v.evidenceId), content: string(v.content) };
        });
        if (notice.notifiedAt < state.decision.decidedAt || notice.notifiedAt > at) refuse('RightsNoticeTimeInvalid');
        if (state.notification) {
          const { recordedBy, recordedAt, ...previous } = state.notification;
          if (!isDeepStrictEqual(previous, notice)) refuse('RightsRequestConflict');
        } else {
          state.notification = { ...notice, recordedBy: ctx.facts.actor, recordedAt: at }; changed = true;
          // The shipped decision contract has no closure event. CD-07 binds closure
          // to evidenced notification; execution of correction/destruction remains separate.
          await tx.$queryRaw`SELECT emr_access.record_duty_request('correction-request',${id},'resolved',
            ${JSON.stringify({ requestId: id, recordIds: state.request.recordIds, receivedAt: state.request.receivedAt,
              responseDueAt: state.dueBy, resolution: { at: notice.notifiedAt, eventId: notice.evidenceId,
                outcome: state.decision.records.every(r => r.outcome.startsWith('refused-')) ? 'lawfully-refused' : 'fulfilled' } })})::text`;
        }
      }
      if (changed) await this.saveRights(tx, state);
      await this.recorded(record, ctx, changed ? 'write' : 'provide-prepared', this.rightsTargets(state), id);
      return rightsView(state, at);
    });
  }

  private requestTargets(state: HeldRequest): readonly AccessTarget[] {
    return state.request.scope.map(s => ({ kind: 'disclosure', patientLinkSnapshot: known(state.request.patient),
      studyId: { status: 'unresolved', reason: 'not-resolved' }, recordId: known(s.recordId),
      versionId: { status: 'unresolved', reason: 'not-resolved' } }));
  }

  async register(request: IncomingMessage, input: unknown) {
    return this.run(request, async (tx, ctx, record) => {
      const v = requestBody(input, ['request','dueAt']), dueAt = requestValue(() => utc(v.dueAt));
      const authority = await this.authority(tx, ctx), at = now();
      const approval = F.approveDisclosure(authority, v.request, at);
      const previous = await this.held(tx, approval.request.requestId, authority.institutionId);
      if (previous) {
        if (!isDeepStrictEqual(previous.request, approval.request) || previous.facts.initialDueAt !== dueAt)
          refuse('DisclosureRequestConflict');
        await this.recorded(record, ctx, 'provide-prepared', this.requestTargets(previous), previous.facts.requestId);
        return previous;
      }
      const ids = approval.request.scope.map(s => s.recordId);
      await lockFixedRecords(tx, ids);
      // An unselected Study UID holding both its report and its Tech Note is not a request F can answer.
      for (const s of approval.request.scope) await requireRecordKind(tx, s.recordId, s.recordKind);
      const facts: F.RequestDeadlineFacts = { requestId: approval.request.requestId, recordIds: ids,
        receivedAt: approval.request.receivedAt, initialDueAt: dueAt, extensions: [], resolution: null };
      // 개인정보 보호법 제35조③: retain the request while access is pending.
      // A owns the publication effective on the placement date (including 21910 from 2027-03-09 KST).
      const publication = clauseVersionAt(HOLD_CLAUSE_VERSIONS['privacy:35.3'], at).publication;
      const holds: LegalHold[] = ids.map(recordId => ({ holdId: randomUUID(), recordId, basis: {
        type: 'pending-access-request', clause: { law: 'privacy', article: '35.3', version: publication }, clauseId: 'privacy:35.3',
        requestId: facts.requestId, authorityId: authority.institutionId, authorityKind: 'personal-information-controller',
        managingInstitutionId: authority.institutionId, scope: ids, verified: true,
        validity: { from: facts.receivedAt, until: facts.initialDueAt, condition: 'request-pending' } },
        actorId: authority.subject.id, at, release: null }));
      for (const hold of holds) F.requestHoldState(facts, hold, at);
      await tx.$queryRaw`SELECT emr_access.record_duty_request('access-request',${facts.requestId},'received',
        ${JSON.stringify({ requestId: facts.requestId, recordIds: ids, receivedAt: facts.receivedAt, responseDueAt: facts.initialDueAt, resolution: null })})::text`;
      for (const hold of holds) await tx.$queryRaw`SELECT emr_access.place_hold(${hold.holdId},${hold.recordId},${JSON.stringify(hold)})::text`;
      const state: HeldRequest = { kind: 'access-request', request: approval.request, facts, holds, issuanceId: null };
      await this.saveHeld(tx, authority.institutionId, state);
      await this.recorded(record, ctx, 'legal-hold', this.requestTargets(state), facts.requestId);
      return state;
    });
  }

  async prepare(request: IncomingMessage, input: unknown) {
    // Intake commits first: an unavailable original must not erase the request or its hold.
    const registered = await this.register(request, input);
    return this.run(request, async (tx, ctx, record) => {
      const authority = await this.authority(tx, ctx), at = now();
      const state = await this.held(tx, registered.facts.requestId, authority.institutionId);
      const approval = F.approveDisclosure(authority, state.request, at);
      if (state.facts.resolution) refuse('RequestAlreadyResolved');
      const saved = state.issuanceId ? await this.issuance(tx, state.issuanceId, authority.institutionId) : null;
      let issuance = saved;
      if (!saved || F.issuanceState(saved).state === 'Prepared') {
        const listings = await this.fixed(tx, state.request.scope);
        const changed = !saved || listings.some(l => {
          const fixed = onlineFixedListing(l), prior = saved.manifest.records.find(r => r.recordId === fixed.recordId);
          // A manifest prepared before the store was recorded is prepared again with the store it reads now.
          return !prior || prior.revision !== fixed.revision || prior.recordKind !== fixed.recordKind;
        });
        if (changed) {
          issuance = F.prepareDisclosurePackage(authority, approval, listings, at,
            process.env.KIN_EMR_ENVIRONMENT === 'synthetic-test' ? 'synthetic-test' : 'operational');
          if (saved) await this.saveIssuance(tx, F.abortIssuance(authority, saved, { reason: '기록이 변경되어 고정판을 다시 준비함', at }));
          await this.saveIssuance(tx, issuance);
          await this.saveHeld(tx, authority.institutionId, { ...state, issuanceId: issuance.issuanceId });
        }
      }
      await this.recorded(record, ctx, 'provide-prepared', F.disclosureLedgerTargets(issuance), issuance.issuanceId);
      return issuance;
    });
  }

  async readIssuance(request: IncomingMessage, issuanceId: string) {
    return this.run(request, async (tx, ctx, record) => {
      const authority = F.requireScope(await this.authority(tx, ctx), 'disclosure');
      const issuance = await this.issuance(tx, issuanceId, authority.institutionId), status = F.issuanceState(issuance);
      const [copy] = await tx.$queryRaw<{ body: Buffer; sha256: string }[]>`SELECT body,sha256 FROM emr_audit.fixed_copy WHERE issuance_id=${issuanceId}`;
      // Reopening must neither issue a prepared package nor reconstruct missing issued bytes.
      if (copy ? hash(copy.body) !== copy.sha256 || copy.sha256 !== status.issuedArtifactSha256 : status.issuedArtifactSha256 !== null)
        refuse('FixedCopyIntegrityMismatch');
      await this.recorded(record, ctx, 'provide-prepared', F.disclosureLedgerTargets(issuance), issuanceId);
      return { issuance, status, artifact: copy ? copy.body.toString('base64') : null,
        sha256: copy?.sha256 ?? null, contentType: fixedContentType(issuance.manifest) };
    });
  }

  async issue(request: IncomingMessage, issuanceId: string) {
    return this.run(request, async (tx, ctx, record) => {
      const authority = await this.authority(tx, ctx); F.requireScope(authority, 'disclosure');
      // The issuance names its request. Read it unlocked within the institution, then take request → issuance
      // like prepare and resolve, so a resolution and an issue of the same request never wait on each other in reverse.
      const [found] = await tx.$queryRaw<{ body: F.Issuance }[]>`SELECT body FROM emr_audit.issuance_event
        WHERE issuance_id=${issuanceId} AND institution_id=${authority.institutionId} ORDER BY sequence DESC LIMIT 1`;
      if (!found) refuse('IssuanceNotFound');
      const state = await this.held(tx, found.body.manifest.requestId, authority.institutionId);
      const issuance = await this.issuance(tx, issuanceId, authority.institutionId);
      if (!state || state.facts.requestId !== issuance.manifest.requestId) refuse('IssuanceRecordRefused');
      const [existing] = await tx.$queryRaw<{ body: Buffer; sha256: string }[]>`SELECT body,sha256 FROM emr_audit.fixed_copy WHERE issuance_id=${issuanceId}`;
      if (existing) {
        const actual = hash(existing.body);
        if (actual !== existing.sha256 || actual !== F.issuanceState(issuance).issuedArtifactSha256)
          refuse('FixedCopyIntegrityMismatch');
        await this.recorded(record, ctx, 'disclosure', F.disclosureLedgerTargets(issuance), issuanceId);
        return { issuance, artifact: existing.body.toString('base64'), sha256: existing.sha256, contentType: fixedContentType(issuance.manifest) };
      }
      // Stored bytes above stay available; an ended request generates no new copy.
      if (state.facts.resolution) refuse('RequestAlreadyResolved');
      // CD-09-D: no new copy of a report destroyed at the end of its retention; a copy already issued is returned above.
      if ((await tx.$queryRaw<unknown[]>`SELECT 1 FROM "StudyState" WHERE uid = ANY(${issuance.manifest.records.map(r => r.recordId)}::text[]) AND rs = 'D'`).length) refuse('RecordDestroyed');
      const listings = await this.fixed(tx, issuance.manifest.records);
      const originals = listings.flatMap(l => {
        const item = issuance.manifest.records.find(r => r.recordId === onlineFixedListing(l).recordId);
        return fixedOriginals(l, item.versions.map(v => v.versionId));
      });
      const bytes = fixedDocument(issuance.manifest, originals);
      const sha256 = hash(bytes), next = F.issueDisclosure(authority, issuance, { at: now(), listings,
        artifact: { sha256, byteLength: bytes.length, format: issuance.manifest.delivery.format,
          generator: 'server', manifestSha256: issuance.manifestSha256 } });
      await tx.$executeRaw`INSERT INTO emr_audit.fixed_copy(issuance_id,body,sha256) VALUES(${issuanceId},${bytes},${sha256})`;
      await this.saveIssuance(tx, next);
      await this.recorded(record, ctx, 'disclosure', F.disclosureLedgerTargets(next), issuanceId);
      return { issuance: next, artifact: bytes.toString('base64'), sha256, contentType: fixedContentType(next.manifest) };
    });
  }

  async delivery(request: IncomingMessage, issuanceId: string, input: unknown) {
    return this.run(request, async (tx, ctx, record) => {
      const authority = await this.authority(tx, ctx), issuance = await this.issuance(tx, issuanceId, authority.institutionId);
      const v = requestBody(input, ['outcome','evidence','note']);
      requestValue(() => {
        choice(v.outcome, ['delivered','failed','unknown']);
        if (v.note !== null) string(v.note);
        if (v.evidence !== null) {
          const e = object(v.evidence, ['kind','evidenceId']); string(e.kind); string(e.evidenceId);
        }
      });
      const next = F.recordDelivery(authority, issuance, { outcome: v.outcome, evidence: v.evidence, note: v.note, at: now() });
      await this.saveIssuance(tx, next);
      await this.recorded(record, ctx, 'disclosure', F.disclosureLedgerTargets(next), issuanceId);
      return next;
    });
  }

  async requestState(request: IncomingMessage, requestId: string) {
    return this.run(request, async (tx, ctx, record) => {
      const a = await this.authority(tx, ctx); F.requireScope(a, 'disclosure');
      const value = await this.held(tx, requestId, a.institutionId);
      if (!value) refuse('RequestNotFound');
      await this.recorded(record, ctx, 'provide-prepared', this.requestTargets(value), requestId);
      return { ...value, states: value.holds.map(h => F.requestHoldState(value.facts, h, now())) };
    });
  }
  async extend(request: IncomingMessage, requestId: string, input: unknown) {
    return this.run(request, async (tx, ctx, record) => {
      const a = await this.authority(tx, ctx); F.requireScope(a, 'disclosure');
      const v = requestBody(input, ['extensionId','previousDueAt','dueAt','basis','evidenceId']);
      requestValue(() => {
        string(v.extensionId); utc(v.previousDueAt); utc(v.dueAt); string(v.evidenceId);
        const basis = object(v.basis, ['clauseId','version']); string(basis.clauseId); string(basis.version);
      });
      const state = await this.held(tx, requestId, a.institutionId);
      if (!state) refuse('RequestNotFound');
      await lockFixedRecords(tx, state.facts.recordIds);
      const prior = state.facts.extensions.find(e => e.extensionId === v.extensionId);
      if (prior) {
        if (['previousDueAt','dueAt','basis','evidenceId'].some(k => !isDeepStrictEqual(prior[k], v[k]))) refuse('DeadlineExtensionConflict');
        await this.recorded(record, ctx, 'provide-prepared', this.requestTargets(state), requestId);
        return state;
      }
      if (state.holds.some(h => v.basis?.clauseId !== h.basis.clauseId || v.basis?.version !== h.basis.clause.version)) refuse('DeadlineExtensionRefused');
      const extension = { ...v, at: now(), actorId: a.subject.id };
      const extended = state.holds.map(h => F.extendRequestHold(state.facts, h, extension));
      const next = { ...state, facts: extended[0].facts, holds: extended.map(e => e.hold) };
      await this.saveHeld(tx, a.institutionId, next);
      await this.recorded(record, ctx, 'legal-hold', this.requestTargets(state), requestId);
      return next;
    });
  }
  async resolve(request: IncomingMessage, requestId: string, input: unknown) {
    return this.run(request, async (tx, ctx, record) => {
      const a = await this.authority(tx, ctx); F.requireScope(a, 'disclosure');
      const v = requestBody(input, ['outcome','evidenceId']);
      requestValue(() => { choice(v.outcome, ['fulfilled','withdrawn','lawfully-refused']); string(v.evidenceId); });
      const state = await this.held(tx, requestId, a.institutionId);
      if (!state) refuse('RequestNotFound');
      // Issuance before the record set, as in prepare and issue.
      const current = state.issuanceId ? await this.issuance(tx, state.issuanceId, a.institutionId) : null;
      await lockFixedRecords(tx, state.facts.recordIds);
      if (state.facts.resolution) {
        if (state.facts.resolution.eventId !== v.evidenceId || state.facts.resolution.outcome !== v.outcome) refuse('RequestAlreadyResolved');
        await this.recorded(record, ctx, 'provide-prepared', this.requestTargets(state), requestId);
        return state;
      }
      const at = now(), facts = { ...state.facts, resolution: { at, eventId: requestValue(() => string(v.evidenceId)), outcome: v.outcome } };
      const issued = current && F.issuanceState(current).state;
      if (v.outcome === 'fulfilled' && issued !== 'Delivered') refuse('DeliveryEvidenceRequired');
      // Withdrawal or a lawful refusal ends the request: a prepared copy is stopped in the same transaction.
      // A copy already issued keeps its bytes and history.
      if (v.outcome !== 'fulfilled' && issued === 'Prepared')
        await this.saveIssuance(tx, F.abortIssuance(a, current, { reason: '요구가 종결되어 발급을 중단함', at }));
      const holds = state.holds.map(h => ({ ...h, release: F.planRequestHoldRelease(a, facts, h,
        { reason: 'effect-ended', evidenceId: v.evidenceId, endingFact: { kind: 'request-resolved', at, eventId: v.evidenceId } }, at) }));
      const next = { ...state, facts, holds };
      await tx.$queryRaw`SELECT emr_access.record_duty_request('access-request',${requestId},'resolved',
        ${JSON.stringify({ requestId, recordIds: facts.recordIds, receivedAt: facts.receivedAt, responseDueAt: F.effectiveDue(facts), resolution: facts.resolution })})::text`;
      for (const hold of holds) await tx.$queryRaw`SELECT emr_access.release_hold(${hold.holdId},${JSON.stringify(hold)})::text`;
      await this.saveHeld(tx, a.institutionId, next);
      await this.recorded(record, ctx, 'lift-legal-hold', this.requestTargets(state), requestId);
      return next;
    });
  }
}
