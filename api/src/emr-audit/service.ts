import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IncomingMessage } from 'node:http';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { identity, newAuditLinkId, parseAccessEvent } from '../emr-contract/access-event';
import type { AccessTarget } from '../emr-contract/access-event';
import type { LegalHold } from '../emr-contract/lawful-defaults';
import { object, refuse, string, utc } from '../emr-contract/validation';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource, RequestWorkContext } from '../emr-runtime/request-context';
import type { RecordMutation } from '../emr-runtime/store';
import { lockFixedRecord } from '../emr-runtime/fixed-record-lock';
import * as F from './contract';
import { loadFixedVersions } from './fixed-versions';
import { fixedOriginals, onlineFixedListing } from './fixed-listing';
import { fixedContentType, fixedDocument } from './fixed-document';

type Tx = Prisma.TransactionClient;
type HeldRequest = { kind: 'access-request'; request: F.DisclosureRequest; facts: F.RequestDeadlineFacts; holds: LegalHold[]; issuanceId: string };
const known = <T>(value: T) => ({ status: 'known' as const, value });
const none = { status: 'not-applicable' as const, reason: 'non-record-target' as const };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
function requestValue<T>(parse: () => T): T {
  try { return parse(); } catch { return refuse('AuditRequestInvalid'); }
}
const requestBody = (input: unknown, keys: readonly string[]) => requestValue(() => object(input, keys));

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
    await this.lock(tx, JSON.stringify(['emr-f-roster', f.institution]));
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
  private async recorded(record: RecordMutation, ctx: RequestWorkContext, action: string,
    targets: readonly AccessTarget[], reference: string, surface = ctx.facts.surface): Promise<void> {
    const f = ctx.facts;
    const event = parseAccessEvent({ formatVersion: 1, surface, eventId: randomUUID(),
      userId: known(f.actor), rolesAtTime: known(f.roles), actingInstitution: known(f.institution), managingInstitution: known(f.institution),
      occurredAt: now(), trustedProxyIp: f.ingress, cause: 'user-view',
      context: { basis: 'out-of-context', studyId: null, relatedStudyId: null, reason: null }, executor: 'member',
      targets, action, result: action === 'provide-prepared' ? 'prepared' : 'succeeded',
      requestId: f.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null });
    await record(event, async () => ({ kind: 'emr-audit', id: reference, version: null }));
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
      const kind = (input as any)?.kind;
      const body = requestBody(input, kind === 'granted' ? ['kind','subject','scopes','validFrom','validUntil'] :
        kind === 'changed' ? ['kind','scopes','validUntil'] : ['kind','reason']);
      const event: Record<string, any> = { ...body, eventId: randomUUID(), at: now(), by: ctx.facts.actor,
        capacity: grantor.capacity, basisDocumentId: grantor.basis_document_id };
      delete event.subject;
      const grant: F.RosterGrant = previous ? { ...previous.body, events: [...previous.body.events, event as F.RosterEvent] } :
        { grantId, subject: requestValue(() => identity(body.subject)), institutionId: ctx.facts.institution, events: [event as F.RosterEvent] };
      F.grantStateAt(grant, now());
      await tx.$executeRaw`INSERT INTO emr_audit.roster_event(grant_id,institution_id,subject_id,body)
        VALUES(${grantId},${grant.institutionId},${grant.subject.id},${JSON.stringify(grant)}::json)`;
      await this.recorded(record, ctx, 'modify', [{ kind: 'identity-access', patientLinkSnapshot: none,
        studyId: none, recordId: known(grant.subject.id), versionId: known(event.eventId) }], grantId);
      return grant;
    });
  }

  async investigate(request: IncomingMessage, input: unknown, mode: 'view' | 'export' = 'view') {
    return this.run(request, async (tx, ctx, record) => {
      const authority = await this.authority(tx, ctx);
      const { changesAfter, viewsAfter, ...query } = requestBody(input, Object.keys(input ?? {}));
      if ('after' in query) refuse('InvestigationQueryRefused');
      const changes = F.planInvestigation(authority, { ...query, ...(changesAfter ? { after: changesAfter } : {}) }, mode);
      const views = F.planInvestigation(authority, { ...query, ...(viewsAfter ? { after: viewsAfter } : {}) }, mode);
      const fetch = async (stream: 'history' | 'viewing', top: number | null, below: number | null, take: number) => tx.$queryRaw<{
        sequence: bigint; payload: string; recorded_at: Date; snapshot_top: bigint }[]>`
        SELECT * FROM emr_access.investigation_entries(${stream},${changes.institutionId},${changes.filters.from}::timestamptz,
          ${changes.filters.to}::timestamptz,${top}::bigint,${below}::bigint,${take}::integer)`;
      const source = (stream: 'history' | 'viewing'): F.InvestigationLedger => ({
        top: async () => Number((await fetch(stream, null, null, 1))[0]?.snapshot_top ?? 0),
        rows: async (top, below, take) => (await fetch(stream, top, below, take)).map(r => ({
          entry: { sequence: Number(r.sequence), payload: { kind: 'access', event: JSON.parse(r.payload) } },
          durableAt: r.recorded_at.toISOString(), served: null })),
      });
      const page = await F.readInvestigationStreams({ changes, views }, { changes: source('history'), views: source('viewing') });
      const ids = [...new Set([...page.changes.rows, ...page.views.rows].flatMap(r => [r.eventId, ...(r.relatedEventId ? [r.relatedEventId] : [])]))];
      const images = [];
      for (const id of ids) {
        // Audit events can have non-UUID IDs. E owns UUID preparation keys.
        const prepared = await tx.$queryRaw<any[]>`SELECT event_id::text,source_manifest,response_manifest,staging_copies
          FROM emr_image.preparation WHERE event_id::text=${id}`;
        const observations = await tx.$queryRaw<any[]>`SELECT sequence::text,kind,body FROM emr_image.observation
          WHERE event_id::text=${id} ORDER BY sequence`;
        if (prepared.length || observations.length) images.push({ eventId: id, preparation: prepared[0] ?? null, observations });
      }
      const event = F.investigationLedgerEvent(page.changes), viewEvent = F.investigationLedgerEvent(page.views);
      const targets = [...new Map([...event.targets, ...viewEvent.targets].map(t => [JSON.stringify(t), t])).values()];
      await this.recorded(record, ctx, event.action, targets, changes.planId);
      return { ...page, images };
    });
  }

  private async issuance(tx: Tx, id: string, institution: string): Promise<F.Issuance> {
    await this.lock(tx, JSON.stringify(['emr-f-issuance', id]));
    const [row] = await tx.$queryRaw<{ body: F.Issuance }[]>`SELECT body FROM emr_audit.issuance_event
      WHERE issuance_id=${id} AND institution_id=${institution} ORDER BY sequence DESC LIMIT 1`;
    if (!row) refuse('IssuanceNotFound');
    F.issuanceState(row.body); return row.body;
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
    return row?.body ?? null;
  }
  private async saveHeld(tx: Tx, institution: string, state: HeldRequest) {
    await tx.$executeRaw`INSERT INTO emr_audit.request_event(request_id,institution_id,body)
      VALUES(${state.facts.requestId},${institution},${JSON.stringify(state)}::json)`;
  }
  private async fixed(tx: Tx, ids: readonly string[]) {
    for (const id of [...ids].sort()) await lockFixedRecord(tx, id);
    return Promise.all(ids.map(id => loadFixedVersions(tx, id)));
  }

  async prepare(request: IncomingMessage, input: unknown) {
    return this.run(request, async (tx, ctx, record) => {
      const v = requestBody(input, ['request','dueAt']);
      const dueAt = requestValue(() => utc(v.dueAt));
      const authority = await this.authority(tx, ctx), at = now();
      const approval = F.approveDisclosure(authority, v.request, at);
      const previous = await this.held(tx, approval.request.requestId, authority.institutionId);
      if (previous) {
        const saved = await this.issuance(tx, previous.issuanceId, authority.institutionId);
        if (!isDeepStrictEqual(previous.request, approval.request) || previous.facts.initialDueAt !== dueAt)
          refuse('DisclosureRequestConflict');
        if (F.issuanceState(saved).state === 'Prepared') {
          const listings = await this.fixed(tx, previous.facts.recordIds);
          const changed = listings.some(l => {
            const fixed = onlineFixedListing(l), prior = saved.manifest.records.find(r => r.recordId === fixed.recordId);
            return !prior || prior.revision !== fixed.revision;
          });
          if (changed) {
            const refreshed = F.prepareDisclosurePackage(authority, approval, listings, at, saved.environment);
            await this.saveIssuance(tx, F.abortIssuance(authority, saved, { reason: '기록이 변경되어 고정판을 다시 준비함', at }));
            await this.saveIssuance(tx, refreshed);
            await this.saveHeld(tx, authority.institutionId, { ...previous, issuanceId: refreshed.issuanceId });
            await this.recorded(record, ctx, 'provide-prepared', F.disclosureLedgerTargets(refreshed), refreshed.issuanceId);
            return refreshed;
          }
        }
        await this.recorded(record, ctx, 'provide-prepared', F.disclosureLedgerTargets(saved), saved.issuanceId);
        return saved;
      }
      const ids = approval.request.scope.map(s => s.recordId), listings = await this.fixed(tx, ids);
      const issuance = F.prepareDisclosurePackage(authority, approval, listings, at,
        process.env.KIN_EMR_ENVIRONMENT === 'synthetic-test' ? 'synthetic-test' : 'operational');
      const facts: F.RequestDeadlineFacts = { requestId: approval.request.requestId, recordIds: ids,
        receivedAt: approval.request.receivedAt, initialDueAt: dueAt, extensions: [], resolution: null };
      const holds: LegalHold[] = ids.map(recordId => ({ holdId: randomUUID(), recordId, basis: {
        type: 'pending-access-request', clause: { law: 'privacy', article: '35.3', version: '21445' }, clauseId: 'privacy:35.3',
        requestId: facts.requestId, authorityId: authority.institutionId, authorityKind: 'personal-information-controller',
        managingInstitutionId: authority.institutionId, scope: ids, verified: true,
        validity: { from: facts.receivedAt, until: facts.initialDueAt, condition: 'request-pending' } },
        actorId: authority.subject.id, at, release: null }));
      for (const hold of holds) F.requestHoldState(facts, hold, at);
      await tx.$queryRaw`SELECT emr_access.record_duty_request('access-request',${facts.requestId},'received',
        ${JSON.stringify({ requestId: facts.requestId, recordIds: ids, receivedAt: facts.receivedAt, responseDueAt: facts.initialDueAt, resolution: null })})::text`;
      for (const hold of holds) await tx.$queryRaw`SELECT emr_access.place_hold(${hold.holdId},${hold.recordId},${JSON.stringify(hold)})::text`;
      await this.saveHeld(tx, authority.institutionId, { kind: 'access-request', request: approval.request, facts, holds, issuanceId: issuance.issuanceId });
      await this.saveIssuance(tx, issuance);
      await this.recorded(record, ctx, 'legal-hold', F.disclosureLedgerTargets(issuance), issuance.issuanceId);
      return issuance;
    });
  }

  async issue(request: IncomingMessage, issuanceId: string) {
    return this.run(request, async (tx, ctx, record) => {
      const authority = await this.authority(tx, ctx); F.requireScope(authority, 'disclosure');
      const issuance = await this.issuance(tx, issuanceId, authority.institutionId);
      const [existing] = await tx.$queryRaw<{ body: Buffer; sha256: string }[]>`SELECT body,sha256 FROM emr_audit.fixed_copy WHERE issuance_id=${issuanceId}`;
      if (existing) {
        await this.recorded(record, ctx, 'disclosure', F.disclosureLedgerTargets(issuance), issuanceId);
        return { issuance, artifact: existing.body.toString('base64'), sha256: existing.sha256, contentType: fixedContentType(issuance.manifest) };
      }
      const listings = await this.fixed(tx, issuance.manifest.records.map(r => r.recordId));
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
      const issuance = await this.issuance(tx, value.issuanceId, a.institutionId);
      await this.recorded(record, ctx, 'provide-prepared', F.disclosureLedgerTargets(issuance), requestId);
      return { ...value, states: value.holds.map(h => F.requestHoldState(value.facts, h, now())) };
    });
  }
  async extend(request: IncomingMessage, requestId: string, input: unknown) {
    return this.run(request, async (tx, ctx, record) => {
      const a = await this.authority(tx, ctx); F.requireScope(a, 'disclosure');
      const v = requestBody(input, ['extensionId','previousDueAt','dueAt','basis','evidenceId']);
      const state = await this.held(tx, requestId, a.institutionId);
      if (!state) refuse('RequestNotFound');
      await this.fixed(tx, state.facts.recordIds);
      const issuance = await this.issuance(tx, state.issuanceId, a.institutionId);
      const prior = state.facts.extensions.find(e => e.extensionId === v.extensionId);
      if (prior) {
        if (['previousDueAt','dueAt','basis','evidenceId'].some(k => !isDeepStrictEqual(prior[k], v[k]))) refuse('DeadlineExtensionConflict');
        await this.recorded(record, ctx, 'provide-prepared', F.disclosureLedgerTargets(issuance), requestId);
        return state;
      }
      if (state.holds.some(h => v.basis?.clauseId !== h.basis.clauseId || v.basis?.version !== h.basis.clause.version)) refuse('DeadlineExtensionRefused');
      const extension = { ...v, at: now(), actorId: a.subject.id };
      const extended = state.holds.map(h => F.extendRequestHold(state.facts, h, extension));
      const next = { ...state, facts: extended[0].facts, holds: extended.map(e => e.hold) };
      await this.saveHeld(tx, a.institutionId, next);
      await this.recorded(record, ctx, 'legal-hold', F.disclosureLedgerTargets(issuance), requestId);
      return next;
    });
  }
  async resolve(request: IncomingMessage, requestId: string, input: unknown) {
    return this.run(request, async (tx, ctx, record) => {
      const a = await this.authority(tx, ctx); F.requireScope(a, 'disclosure');
      const v = requestBody(input, ['outcome','evidenceId']);
      const state = await this.held(tx, requestId, a.institutionId);
      if (!state) refuse('RequestNotFound');
      await this.fixed(tx, state.facts.recordIds);
      const issuance = await this.issuance(tx, state.issuanceId, a.institutionId);
      if (state.facts.resolution) {
        if (state.facts.resolution.eventId !== v.evidenceId || state.facts.resolution.outcome !== v.outcome) refuse('RequestAlreadyResolved');
        await this.recorded(record, ctx, 'provide-prepared', F.disclosureLedgerTargets(issuance), requestId);
        return state;
      }
      const at = now(), facts = { ...state.facts, resolution: { at, eventId: requestValue(() => string(v.evidenceId)), outcome: v.outcome } };
      if (v.outcome === 'fulfilled' && F.issuanceState(issuance).state !== 'Delivered') refuse('DeliveryEvidenceRequired');
      const holds = state.holds.map(h => ({ ...h, release: F.planRequestHoldRelease(a, facts, h,
        { reason: 'effect-ended', evidenceId: v.evidenceId, endingFact: { kind: 'request-resolved', at, eventId: v.evidenceId } }, at) }));
      const next = { ...state, facts, holds };
      await tx.$queryRaw`SELECT emr_access.record_duty_request('access-request',${requestId},'resolved',
        ${JSON.stringify({ requestId, recordIds: facts.recordIds, receivedAt: facts.receivedAt, responseDueAt: F.effectiveDue(facts), resolution: facts.resolution })})::text`;
      for (const hold of holds) await tx.$queryRaw`SELECT emr_access.release_hold(${hold.holdId},${JSON.stringify(hold)})::text`;
      await this.saveHeld(tx, a.institutionId, next);
      await this.recorded(record, ctx, 'lift-legal-hold', F.disclosureLedgerTargets(issuance), requestId);
      return next;
    });
  }
}
