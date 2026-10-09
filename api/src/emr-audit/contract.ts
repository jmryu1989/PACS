import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { ACCESS_ACTIONS, identity, parseAccessEvent, patientLink, sealAccessEvent, STATUTORY_ACT } from '../emr-contract/access-event';
import type { AccessAction, AccessEvent, AccessTarget, EvidenceFact, ImmutableIdentity, PatientLinkSnapshot } from '../emr-contract/access-event';
import { retentionDisposition, verifiedRecord } from '../emr-contract/classification';
import type { ResolvedRecord } from '../emr-contract/classification';
import { civilPeriodEnd } from '../emr-contract/lawful-defaults';
import type { LegalHold } from '../emr-contract/lawful-defaults';
import { inspectSignatureEnvelope } from '../emr-contract/signature';
import type { SignatureEnvelope } from '../emr-contract/signature';
import { choice, ContractError, freeze, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';

/**
 * EMR unit F, round 1 (module-first): pure contracts for the designated-auditor roster, the patient-level replay of the
 * access ledger, incident scoping, lawful copies and legal submissions (의료법 제21조), correction/deletion/suspension
 * requests (개인정보 보호법 제36조·제37조), the monthly inspection follow-up, and the request hold that a lawful deadline
 * extension keeps alive (A ledger L5-06). The legal register of 2026-10-09 (deltas D-7, D-8, D-9, D-15) is applied.
 *
 * Nothing here opens a database, a route, a page, a signer or a delivery channel. Round 2 binds the ports declared
 * below: RosterReader and the roster history to B1 storage, VerifiedCaller to the B2 session context, the ledger to B1's
 * access store, VersionListing to C's fixed signed versions, and the L5-06 decision into A's lawful-defaults gate.
 *
 * Authority is never read from a request. A designated auditor is a roster grant for an immutable identity in one
 * institution; the general admin role grants nothing. Every refusal is a ContractError code, produces no plan, row,
 * package, release or state change, and leaves its inputs untouched.
 */

function guarded<T>(code: string, run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof ContractError) throw error;
    return refuse(code);
  }
}
function sameIdentity(a: ImmutableIdentity, b: ImmutableIdentity): boolean {
  return a.id === b.id && a.issuer === b.issuer && a.subject === b.subject;
}
/** The patient is the assigning authority's identifier; a link ID names one matching, not the person. */
function samePatient(a: { patientId: string; assigningAuthority: string }, b: { patientId: string; assigningAuthority: string }): boolean {
  return a.patientId === b.patientId && a.assigningAuthority === b.assigningAuthority;
}
function uniqueStrings(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new Error('Expected a list');
  const items = value.map(item => string(item));
  if (new Set(items).size !== items.length) throw new Error('Duplicate entry');
  return items;
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
const KST_OFFSET_MS = 9 * 3_600_000;
function seoulDay(at: string): string { return new Date(Date.parse(at) + KST_OFFSET_MS).toISOString().slice(0, 10); }
function seoulMonth(at: string): string { return seoulDay(at).slice(0, 7); }
function monthKey(value: unknown): string {
  const month = string(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Expected YYYY-MM');
  return month;
}
function followingMonth(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
}
/** First instant of a Seoul calendar month, in UTC. */
function monthStart(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1, 1) - KST_OFFSET_MS).toISOString();
}

// ---------------------------------------------------------------------------------------------------------------------
// Designated auditor roster (REQ-EMR-15·19, RISK-F-01)

export const ROSTER_SCOPES = freeze(['investigate', 'export', 'disclosure', 'inspection'] as const);
export type RosterScope = typeof ROSTER_SCOPES[number];
/** Who may designate: the institution's privacy officer or its representative, as the server records them. A role name
 * (admin or any other) is not a capacity. */
export const GRANTOR_CAPACITIES = freeze(['privacy-officer', 'institution-representative'] as const);
export type GrantorCapacity = typeof GRANTOR_CAPACITIES[number];

interface RosterChange { eventId: string; at: string; by: ImmutableIdentity; capacity: GrantorCapacity; basisDocumentId: string }
export type RosterEvent =
  (RosterChange & { kind: 'granted'; scopes: readonly RosterScope[]; validFrom: string; validUntil: string | null }) |
  (RosterChange & { kind: 'changed'; scopes: readonly RosterScope[]; validUntil: string | null }) |
  (RosterChange & { kind: 'revoked'; reason: string });
export interface RosterGrant { grantId: string; subject: ImmutableIdentity; institutionId: string; events: readonly RosterEvent[] }
/** B1 in round 2: every grant of this identity in every institution with its whole append-only history, complete:true. */
export interface RosterReader { listGrants(subject: ImmutableIdentity): unknown }
/** B2's verified session context in round 2 (identity, current institution, roles); never a request body. */
export interface VerifiedCaller { identity: ImmutableIdentity; institutionId: string | null; roles: readonly string[] }
export interface AuditAuthority {
  subject: ImmutableIdentity; institutionId: string; scopes: readonly RosterScope[]; grantIds: readonly string[];
  at: string; rolesAtTime: readonly string[];
}

function parseRosterEvent(input: unknown): Readonly<RosterEvent> {
  return guarded('RosterHistoryRefused', () => {
    const kind = choice((input as any)?.kind, ['granted', 'changed', 'revoked']);
    const keys = ['kind', 'eventId', 'at', 'by', 'capacity', 'basisDocumentId',
      ...(kind === 'granted' ? ['scopes', 'validFrom', 'validUntil'] : kind === 'changed' ? ['scopes', 'validUntil'] : ['reason'])];
    const v = object(input, keys);
    const base = { eventId: string(v.eventId), at: utc(v.at), by: identity(v.by), capacity: choice(v.capacity, GRANTOR_CAPACITIES),
      basisDocumentId: string(v.basisDocumentId) };
    if (kind === 'revoked') return freeze({ kind, ...base, reason: string(v.reason) });
    const scopes = uniqueStrings(v.scopes).map(s => choice(s, ROSTER_SCOPES));
    const validUntil = v.validUntil === null ? null : utc(v.validUntil);
    if (kind === 'changed') return freeze({ kind, ...base, scopes, validUntil });
    const validFrom = utc(v.validFrom);
    if (validUntil !== null && validUntil <= validFrom) throw new Error('Empty validity');
    return freeze({ kind, ...base, scopes, validFrom, validUntil });
  });
}
/** The grant as its history stood at `at`. History is append-only and ordered; a revocation is final (re-grant = new ID). */
export function grantStateAt(input: unknown, at: string): Readonly<{
  grantId: string; subject: ImmutableIdentity; institutionId: string; active: boolean; scopes: readonly RosterScope[];
  validFrom: string | null; validUntil: string | null; revokedAt: string | null;
}> {
  const g = guarded('RosterHistoryRefused', () => object(input, ['grantId', 'subject', 'institutionId', 'events']));
  const grantId = guarded('RosterHistoryRefused', () => string(g.grantId)), subject = guarded('RosterHistoryRefused', () => identity(g.subject));
  const institutionId = guarded('RosterHistoryRefused', () => string(g.institutionId));
  guarded('RosterHistoryRefused', () => utc(at));
  if (!Array.isArray(g.events) || !g.events.length) refuse('RosterHistoryRefused');
  const events = g.events.map(parseRosterEvent);
  if (events[0].kind !== 'granted' || new Set(events.map(e => e.eventId)).size !== events.length ||
      events.some((e, i) => (i && e.kind === 'granted') || (i && e.at < events[i - 1].at)) ||
      events.slice(0, -1).some(e => e.kind === 'revoked')) refuse('RosterHistoryRefused');
  let scopes: readonly RosterScope[] = [], validFrom: string | null = null, validUntil: string | null = null, revokedAt: string | null = null;
  for (const e of events.filter(e => e.at <= at)) {
    if (e.kind === 'granted') { scopes = e.scopes; validFrom = e.validFrom; validUntil = e.validUntil; }
    else if (e.kind === 'changed') {
      if (e.validUntil !== null && e.validUntil <= validFrom) refuse('RosterHistoryRefused');
      scopes = e.scopes; validUntil = e.validUntil;
    } else revokedAt = e.at;
  }
  const active = validFrom !== null && revokedAt === null && validFrom <= at && (validUntil === null || at < validUntil);
  return freeze({ grantId, subject, institutionId, active, scopes: active ? scopes : [], validFrom, validUntil, revokedAt });
}

/** 안전성 확보조치 기준 제5조③ (legal register LR-12, delta D-8): each grant/change/revocation record is kept at least three
 * years on its own clock — separate from the access ledger, whose events follow A/D-1. */
export const RIGHTS_HISTORY_MINIMUM = freeze({ clauseId: 'access-safety:5.3', years: 3, basis: '개인정보의 안전성 확보조치 기준 제5조③' });
export function rightsHistoryKeptUntil(event: unknown): string {
  return civilPeriodEnd(parseRosterEvent(event).at, RIGHTS_HISTORY_MINIMUM.years);
}

const authorities = new WeakSet<object>();
/** The only way to obtain audit authority: the server's caller context and the stored roster. Roles are recorded for the
 * ledger, never consulted. */
export function resolveAuditAuthority(reader: RosterReader, caller: VerifiedCaller, at: string): Readonly<AuditAuthority> {
  const c = guarded('VerifiedCallerRequired', () => {
    const v = object(caller, ['identity', 'institutionId', 'roles']);
    return { identity: identity(v.identity), institutionId: v.institutionId === null ? null : string(v.institutionId),
      roles: uniqueStrings(v.roles, true) };
  });
  guarded('VerifiedCallerRequired', () => utc(at));
  if (c.institutionId === null) refuse('AuditorNotDesignated');
  let listing: Record<string, any>;
  try { listing = object(reader.listGrants(c.identity), ['subject', 'complete', 'grants']); } catch { refuse('RosterUnavailable'); }
  // A failed or partial read is not "no grants": the caller sees an error, never an empty authority.
  if (listing.complete !== true || !Array.isArray(listing.grants) || !guarded('RosterUnavailable', () => sameIdentity(identity(listing.subject), c.identity)))
    refuse('RosterUnavailable');
  const states = listing.grants.map(grant => grantStateAt(grant, at));
  if (states.some(s => !sameIdentity(s.subject, c.identity)) || new Set(states.map(s => s.grantId)).size !== states.length) refuse('RosterUnavailable');
  const active = states.filter(s => s.active && s.institutionId === c.institutionId);
  const scopes: RosterScope[] = [...new Set(active.flatMap(s => s.scopes))].sort();
  if (!scopes.length) refuse('AuditorNotDesignated');
  const authority = freeze({ subject: c.identity, institutionId: c.institutionId, scopes, grantIds: active.map(s => s.grantId).sort(),
    at, rolesAtTime: c.roles });
  authorities.add(authority);
  return authority;
}
function requireScope(authority: AuditAuthority, scope: RosterScope): Readonly<AuditAuthority> {
  if (!authorities.has(authority)) refuse('AuditAuthorityRequired');
  if (!authority.scopes.includes(scope)) refuse('AuditScopeNotGranted');
  return authority;
}

// ---------------------------------------------------------------------------------------------------------------------
// Investigation query and plan (REQ-EMR-15, RISK-F-01·02)

/** Keys a client might send to claim authority or another institution's scope. They are refused, not ignored. */
const CLIENT_AUTHORITY_KEYS = freeze(['auditor', 'admin', 'role', 'roles', 'scope', 'scopes', 'grant', 'grantId', 'institution',
  'institutionId', 'managingInstitution', 'actingInstitution']);
const QUERY_KEYS = freeze(['patient', 'studyId', 'recordId', 'versionId', 'actorId', 'address', 'from', 'to', 'actions', 'results', 'limit', 'after']);
const ALL_ACTIONS = Object.values(ACCESS_ACTIONS).flat() as readonly AccessAction[];
export const EVENT_RESULTS = freeze(['prepared', 'succeeded', 'aborted', 'refused', 'failed', 'reported'] as const);
export type EventResult = typeof EVENT_RESULTS[number];
export const PAGE_LIMIT = freeze({ default: 50, max: 500 });

export interface InvestigationFilters {
  patient: { patientId: string; assigningAuthority: string } | null;
  studyId: string | null; recordId: string | null; versionId: string | null; actorId: string | null;
  /** The trusted-proxy address the event recorded (incident scoping, 안전성 기준 제6조①2). */
  address: string | null;
  from: string; to: string; actions: readonly AccessAction[] | null; results: readonly EventResult[] | null;
}
export interface InvestigationPlan {
  planId: string; mode: 'view' | 'export'; institutionId: string; auditor: ImmutableIdentity;
  filters: InvestigationFilters; limit: number | null; cursor: string | null;
}

function parseInvestigationQuery(input: unknown, mode: 'view' | 'export'): { filters: InvestigationFilters; limit: number | null; cursor: string | null } {
  if (input && typeof input === 'object' && !Array.isArray(input) &&
      Reflect.ownKeys(input).some(key => typeof key === 'string' && CLIENT_AUTHORITY_KEYS.includes(key))) refuse('ClientAuthorityClaimRefused');
  return guarded('InvestigationQueryRefused', () => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
      throw new Error('Expected a plain object');
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string' || !QUERY_KEYS.includes(key)) || !keys.includes('from') || !keys.includes('to'))
      throw new Error('Unknown or missing query field');
    const v = input as Record<string, any>;
    const optional = (key: string) => Object.prototype.hasOwnProperty.call(v, key) ? string(v[key]) : null;
    let patient = null;
    if (Object.prototype.hasOwnProperty.call(v, 'patient')) {
      const p = object(v.patient, ['patientId', 'assigningAuthority']);
      patient = { patientId: string(p.patientId), assigningAuthority: string(p.assigningAuthority) };
    }
    const from = utc(v.from), to = utc(v.to);
    if (from >= to) throw new Error('Empty period');
    const actions = Object.prototype.hasOwnProperty.call(v, 'actions') ? uniqueStrings(v.actions).map(a => choice(a, ALL_ACTIONS)) : null;
    const results = Object.prototype.hasOwnProperty.call(v, 'results') ? uniqueStrings(v.results).map(r => choice(r, EVENT_RESULTS)) : null;
    let limit: number | null = null, cursor: string | null = null;
    if (mode === 'view') {
      limit = Object.prototype.hasOwnProperty.call(v, 'limit') ? integer(v.limit, 1) : PAGE_LIMIT.default;
      if (limit > PAGE_LIMIT.max) throw new Error('Page too large');
      cursor = optional('after');
    } else if (Object.prototype.hasOwnProperty.call(v, 'limit') || Object.prototype.hasOwnProperty.call(v, 'after')) {
      throw new Error('An export has no page');
    }
    const address = optional('address');
    if (address !== null && isIP(address) === 0) throw new Error('Expected an IP address');
    return { filters: { patient, studyId: optional('studyId'), recordId: optional('recordId'), versionId: optional('versionId'),
      actorId: optional('actorId'), address, from, to, actions, results }, limit, cursor };
  });
}

const plans = new WeakSet<object>();
/** The plan's institution is the grant's; the query only narrows inside it. An export needs the export scope. */
export function planInvestigation(authority: AuditAuthority, query: unknown, mode: 'view' | 'export' = 'view'): Readonly<InvestigationPlan> {
  mode = guarded('InvestigationQueryRefused', () => choice(mode, ['view', 'export']));
  requireScope(authority, mode === 'export' ? 'export' : 'investigate');
  const q = parseInvestigationQuery(query, mode);
  const planId = digest({ mode, institutionId: authority.institutionId, auditor: authority.subject, filters: q.filters, limit: q.limit });
  const plan = freeze({ planId, mode, institutionId: authority.institutionId, auditor: authority.subject, filters: q.filters,
    limit: q.limit, cursor: q.cursor });
  plans.add(plan);
  return plan;
}

/** Record-time attribution: the institution written into the event, never today's owner of the study. */
function inInstitutionScope(plan: InvestigationPlan, event: Readonly<AccessEvent>): boolean {
  if (event.managingInstitution.status === 'known') return event.managingInstitution.value === plan.institutionId;
  return event.actingInstitution.status === 'known' && event.actingInstitution.value === plan.institutionId;
}
function targetMatches(f: InvestigationFilters, t: AccessTarget): boolean {
  if (f.patient && !(t.patientLinkSnapshot.status === 'known' && samePatient(t.patientLinkSnapshot.value, f.patient))) return false;
  if (f.studyId !== null && !(t.studyId.status === 'known' && t.studyId.value === f.studyId)) return false;
  if (f.recordId !== null && !(t.recordId.status === 'known' && t.recordId.value === f.recordId)) return false;
  if (f.versionId !== null && !(t.versionId.status === 'known' && t.versionId.value === f.versionId)) return false;
  return true;
}
/** The matched targets (only the investigated ones when a target filter is set), or null. */
function eventMatches(plan: InvestigationPlan, event: Readonly<AccessEvent>): readonly AccessTarget[] | null {
  const f = plan.filters;
  if (event.occurredAt < f.from || event.occurredAt >= f.to) return null;
  if (f.actorId !== null && !(event.userId.status === 'known' && event.userId.value.id === f.actorId)) return null;
  if (f.address !== null && !(event.trustedProxyIp.status === 'known' && event.trustedProxyIp.value.address === f.address)) return null;
  if (f.actions && !f.actions.includes(event.action)) return null;
  if (f.results && !f.results.includes(event.result)) return null;
  if (!f.patient && f.studyId === null && f.recordId === null && f.versionId === null) return event.targets;
  const hit = event.targets.filter(t => targetMatches(f, t));
  return hit.length ? hit : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ledger rows, patient replay and page boundaries (REQ-EMR-07·15, RISK-F-02)

/** One stored ledger entry as B1 reads it: the chain entry A sealed, B's durable receipt time, and for a mixed surface the
 * server-verified row manifest A needs to re-parse it (otherwise null). */
export interface LedgerRow { entry: unknown; durableAt: string; served: readonly ResolvedRecord[] | null }
export interface InvestigationLedger {
  /** Highest committed sequence when a first page is read; later pages keep that snapshot through the cursor. */
  top(): Promise<number>;
  /** Rows with sequence ≤ top and < below (when not null), strictly descending, at most `take`; may be broader than the
   * plan (candidate rows). Fewer than `take` means the end. */
  rows(top: number, below: number | null, take: number): Promise<readonly LedgerRow[]>;
}
/** C/B patient matching facts in round 2: the study's patient link today. Display only. */
export type CurrentPatientLink = (studyId: string) => PatientLinkSnapshot | null;

export interface ReplayTarget {
  kind: AccessTarget['kind']; patient: EvidenceFact<PatientLinkSnapshot>; studyId: EvidenceFact<string>;
  recordId: EvidenceFact<string>; versionId: EvidenceFact<string>; currentLink: PatientLinkSnapshot | null; rematched: boolean;
}
export interface ReplayEntry {
  sequence: number; eventId: string; occurredAt: string; committedAt: string; surface: string;
  action: AccessAction; statutoryAct: string; result: AccessEvent['result']; cause: AccessEvent['cause']; executor: AccessEvent['executor'];
  channel: 'online' | 'in-process-service' | 'unresolved';
  actor: AccessEvent['userId']; rolesAtTime: AccessEvent['rolesAtTime'];
  actingInstitution: AccessEvent['actingInstitution']; managingInstitution: AccessEvent['managingInstitution'];
  targets: readonly ReplayTarget[]; requestId: string; relatedEventId: string | null;
}
export interface InvestigationPage { rows: readonly ReplayEntry[]; total: number; top: number; nextCursor: string | null }

/** A row whose recomputed chain hash differs (a rewritten patient, version or institution) is refused, never shown. */
function verifiedRow(input: unknown, top: number, previous: number): { sequence: number; event: Readonly<AccessEvent>; durableAt: string } {
  return guarded('LedgerRowIntegrityRefused', () => {
    const row = object(input, ['entry', 'durableAt', 'served']);
    const entry = object(row.entry, ['sequence', 'previousHash', 'payload', 'hash']);
    integer(entry.sequence, 1); sha256(entry.previousHash); sha256(entry.hash);
    if (entry.sequence > top || entry.sequence >= previous) refuse('LedgerSourceOrderRefused');
    const payload = object(entry.payload, ['kind', 'event']);
    if (payload.kind !== 'access') throw new Error('Not an access event');
    const event = parseAccessEvent(payload.event, row.served === null ? undefined : row.served);
    const sealed = sealAccessEvent({ sequence: entry.sequence - 1, hash: entry.previousHash }, event);
    if (sealed.hash !== entry.hash) throw new Error('Chain hash mismatch');
    return { sequence: entry.sequence, event, durableAt: utc(row.durableAt) };
  });
}
function currentPatient(currentLink: CurrentPatientLink | undefined, target: AccessTarget): PatientLinkSnapshot | null {
  if (!currentLink || target.studyId.status !== 'known') return null;
  const studyId = target.studyId.value;
  return guarded('CurrentLinkUnavailable', () => {
    const link = currentLink(studyId);
    return link === null ? null : patientLink(link);
  });
}
function replayTarget(target: AccessTarget, currentLink: CurrentPatientLink | undefined): ReplayTarget {
  const recorded = target.patientLinkSnapshot, current = currentPatient(currentLink, target);
  return {
    kind: target.kind,
    // The event's own snapshot is the attribution. A later re-match is shown beside it, never in its place.
    patient: recorded,
    studyId: target.studyId, recordId: target.recordId, versionId: target.versionId, currentLink: current,
    rematched: current !== null && recorded.status === 'known' && !samePatient(current, recorded.value),
  };
}
function replayEntry(sequence: number, committedAt: string, event: Readonly<AccessEvent>, targets: readonly AccessTarget[],
  currentLink: CurrentPatientLink | undefined): ReplayEntry {
  return {
    sequence, eventId: event.eventId, occurredAt: event.occurredAt, committedAt, surface: event.surface,
    action: event.action, statutoryAct: STATUTORY_ACT[event.action], result: event.result, cause: event.cause, executor: event.executor,
    channel: event.trustedProxyIp.status === 'known' ? 'online' : event.trustedProxyIp.status === 'not-applicable' ? 'in-process-service' : 'unresolved',
    actor: event.userId, rolesAtTime: event.rolesAtTime, actingInstitution: event.actingInstitution, managingInstitution: event.managingInstitution,
    targets: targets.map(t => replayTarget(t, currentLink)), requestId: event.requestId, relatedEventId: event.relatedEventId,
  };
}

// Restarting the server ends open cursors (same as the existing admin audit console); the auditor starts again.
const CURSOR_KEY = randomBytes(32);
function sealCursor(plan: InvestigationPlan, top: number, after: number): string {
  const body = Buffer.from(JSON.stringify({ planId: plan.planId, top, after }), 'utf8').toString('base64url');
  return `${body}.${createHmac('sha256', CURSOR_KEY).update(body).digest('base64url')}`;
}
function openCursor(plan: InvestigationPlan, cursor: string): { top: number; after: number } {
  return guarded('InvestigationCursorRefused', () => {
    const parts = cursor.split('.');
    if (parts.length !== 2) throw new Error('Cursor shape');
    const expected = createHmac('sha256', CURSOR_KEY).update(parts[0]).digest(), given = Buffer.from(parts[1], 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('Cursor seal');
    const v = object(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')), ['planId', 'top', 'after']);
    if (v.planId !== plan.planId) throw new Error('Cursor of another plan');
    return { top: integer(v.top), after: integer(v.after, 1) };
  });
}

const pages = new WeakMap<object, InvestigationPlan>();
/**
 * One page (or, for an export plan, every matching row). Scope and filters are applied to each row before the page is
 * cut, so the total, the page boundary and an export count only this institution's matching events. A source failure,
 * a misordered or out-of-snapshot row and an integrity failure are errors, never an empty or shorter answer.
 */
export async function readInvestigationPage(plan: InvestigationPlan, ledger: InvestigationLedger,
  options: { currentLink?: CurrentPatientLink; batch?: number } = {}): Promise<Readonly<InvestigationPage>> {
  if (!plans.has(plan)) refuse('InvestigationPlanRequired');
  const batch = options.batch ?? 500;
  guarded('InvestigationQueryRefused', () => integer(batch, 1));
  let top: number, after: number | null = null;
  if (plan.cursor !== null) ({ top, after } = openCursor(plan, plan.cursor));
  else {
    let read: unknown;
    try { read = await ledger.top(); } catch { refuse('LedgerReadFailed'); }
    top = guarded('LedgerReadFailed', () => integer(read));
  }
  const limit = plan.mode === 'export' ? Infinity : plan.limit;
  const rows: ReplayEntry[] = [];
  let below: number | null = null, previous = top + 1, total = 0, last: number | null = null, more = false;
  for (;;) {
    let chunk: readonly LedgerRow[];
    try { chunk = await ledger.rows(top, below, batch); } catch { refuse('LedgerReadFailed'); }
    if (!Array.isArray(chunk) || chunk.length > batch) refuse('LedgerReadFailed');
    for (const input of chunk) {
      const { sequence, event, durableAt } = verifiedRow(input, top, previous);
      previous = sequence;
      if (!inInstitutionScope(plan, event)) continue;
      const targets = eventMatches(plan, event);
      if (!targets) continue;
      total++;
      if (after !== null && sequence >= after) continue;
      if (rows.length < limit) { rows.push(replayEntry(sequence, durableAt, event, targets, options.currentLink)); last = sequence; }
      else more = true;
    }
    if (chunk.length < batch) break;
    below = previous;
  }
  const page = freeze({ rows, total, top, nextCursor: more ? sealCursor(plan, top, last) : null });
  pages.set(page, plan);
  return page;
}

/** D-1 revised: the record-change and view streams have independent sequence spaces, snapshots and retention.
 * F reads both explicitly; it never applies a common expiry or treats a missing stream as an empty one. B's actual
 * storage/seal interface is a round-2 adapter, not a SQL layout defined here. Pages stay labelled by their stream. */
export async function readInvestigationStreams(
  selection: { changes: InvestigationPlan; views: InvestigationPlan },
  sources: { changes: InvestigationLedger; views: InvestigationLedger },
): Promise<Readonly<{ changes: InvestigationPage; views: InvestigationPage; totalEntries: number }>> {
  const { changes, views } = selection ?? {};
  if (!plans.has(changes) || !plans.has(views)) refuse('InvestigationPlanRequired');
  if (changes.planId !== views.planId) refuse('InvestigationStreamSelectionMismatch');
  const read = async (stream: 'changes' | 'views') => {
    const original = selection[stream];
    // A view-stream cursor must never skip a change-stream entry with the same sequence number.
    const bound = freeze({ ...original, planId: digest({ planId: original.planId, stream }) });
    plans.add(bound);
    return readInvestigationPage(bound, sources?.[stream]);
  };
  const changePage = await read('changes'), viewPage = await read('views');
  return freeze({ changes: changePage, views: viewPage, totalEntries: changePage.total + viewPage.total });
}

/** The investigation is itself an access to the shown events (B ledger, 제23조④ 열람): one access-audit target per shown
 * event and patient, and an export is a download. Events without a resolved patient target carry no patient record. */
export function investigationLedgerEvent(page: InvestigationPage): Readonly<{ action: 'provide-prepared' | 'download'; targets: readonly AccessTarget[] }> {
  const plan = pages.get(page);
  if (!plan) refuse('InvestigationPageRequired');
  const targets: AccessTarget[] = [], seen = new Set<string>();
  for (const row of page.rows) for (const t of row.targets) {
    if (t.patient.status !== 'known' || t.studyId.status !== 'known') continue;
    const key = JSON.stringify([row.eventId, t.patient.value.patientId, t.patient.value.assigningAuthority, t.studyId.value]);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ kind: 'access-audit', patientLinkSnapshot: t.patient, studyId: t.studyId,
      recordId: { status: 'known', value: row.eventId }, versionId: { status: 'known', value: row.eventId } });
  }
  return freeze({ action: plan.mode === 'export' ? 'download' : 'provide-prepared', targets });
}

// ---------------------------------------------------------------------------------------------------------------------
// Incident scoping (legal register LR-26/LR-55, delta D-15; 개인정보 보호법 제34조①②, 시행령 제39조·제39조의2·제39조의3·
// 제40조, 의료법 제23조의3①). F answers who was affected, or that this cannot be told; the notices and reports are I's.

/** A designated person's recorded finding that the ledger cannot name everyone affected (access that bypassed the
 * product, a copied backup, records that cannot be attributed). Recorded, never inferred. */
export interface IncidentDetermination { kind: 'access-outside-ledger' | 'records-not-attributable'; note: string }
export interface IncidentScope {
  institutionId: string; filters: InvestigationFilters; top: number | null;
  auditEvent: { action: 'provide-prepared' | 'download'; targets: readonly AccessTarget[] };
  identified: readonly { patient: { patientId: string; assigningAuthority: string }; eventIds: readonly string[]; firstAt: string; lastAt: string }[];
  /** False when the people affected cannot be identified: the possible-leak notice of 제34조② (시행령 제39조의2①1) applies. */
  subjectsIdentifiable: boolean;
  reasons: readonly ({ kind: 'ledger-unreadable'; code: string } | { kind: IncidentDetermination['kind']; note: string; by: ImmutableIdentity })[];
}
const incidentScopes = new WeakSet<object>();
/** Every matching event of an export plan (period, patient, actor, address, event types). Refused and failed requests
 * provided nothing and name no one. A ledger read or integrity failure is itself the fact that the subjects cannot be
 * identified, and is reported as such — never as "nobody affected". */
export async function incidentScope(authority: AuditAuthority, plan: InvestigationPlan, ledger: InvestigationLedger,
  determinations: readonly IncidentDetermination[] = []): Promise<Readonly<IncidentScope>> {
  requireScope(authority, 'investigate');
  if (!plans.has(plan) || plan.mode !== 'export') refuse('IncidentScopeNeedsCompleteRead');
  if (plan.institutionId !== authority.institutionId || !sameIdentity(plan.auditor, authority.subject)) refuse('AuditScopeNotGranted');
  const recorded = guarded('IncidentDeterminationRefused', () => {
    if (!Array.isArray(determinations)) throw new Error('Expected a list');
    return determinations.map(d => {
      const v = object(d, ['kind', 'note']);
      return { kind: choice(v.kind, ['access-outside-ledger', 'records-not-attributable']), note: string(v.note), by: authority.subject };
    });
  });
  const reasons: IncidentScope['reasons'][number][] = [];
  let page: Readonly<InvestigationPage> | null = null;
  try { page = await readInvestigationPage(plan, ledger); } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    reasons.push({ kind: 'ledger-unreadable', code: error.code });
  }
  const groups = new Map<string, { patient: { patientId: string; assigningAuthority: string }; eventIds: string[]; firstAt: string; lastAt: string }>();
  for (const row of page?.rows ?? []) {
    if (row.result === 'refused' || row.result === 'failed') continue;
    for (const t of row.targets) {
      if (t.patient.status !== 'known') continue;
      const p = { patientId: t.patient.value.patientId, assigningAuthority: t.patient.value.assigningAuthority };
      const key = JSON.stringify([p.patientId, p.assigningAuthority]), g = groups.get(key);
      if (!g) { groups.set(key, { patient: p, eventIds: [row.eventId], firstAt: row.occurredAt, lastAt: row.occurredAt }); continue; }
      if (!g.eventIds.includes(row.eventId)) g.eventIds.push(row.eventId);
      if (row.occurredAt < g.firstAt) g.firstAt = row.occurredAt;
      if (row.occurredAt > g.lastAt) g.lastAt = row.occurredAt;
    }
  }
  reasons.push(...recorded);
  const identified = [...groups.values()].sort((a, b) => a.patient.patientId.localeCompare(b.patient.patientId) ||
    a.patient.assigningAuthority.localeCompare(b.patient.assigningAuthority));
  const scope = freeze({ institutionId: plan.institutionId, filters: plan.filters, top: page?.top ?? null, identified,
    subjectsIdentifiable: reasons.length === 0, reasons,
    auditEvent: page ? investigationLedgerEvent(page) : { action: 'download' as const, targets: [] } });
  incidentScopes.add(scope);
  return scope;
}

/** Investigator findings and delivery evidence are supplied by the trusted server boundary. R2 must authenticate and
 * persist these references; this pure projection does not certify a delivery, a legal decision or a signature. */
export interface IncidentResponseFacts {
  incidentId: string; awarenessAt: string; determinationAt: string;
  status: 'possible' | 'confirmed' | 'not-a-leak';
  possibleGround: 'illegal-access-unidentifiable' | 'other-subjects-at-risk' | null;
  priorPossibleNotice?: { noticeId: string; sentAt: string } | null;
  detailsComplete: boolean; newlyConfirmedAt: string | null;
  reportTriggers: readonly ('1000-subjects' | 'sensitive-or-unique' | 'external-illegal-access')[];
  medicalIncident: { occurredAt: string; discoveredAt: string } | null;
  evidenceId: string;
  verdictId?: string; supersedes?: string; possibilityEventId?: string; additionalEventId?: string;
  reportEventId?: string; reportKnownAt?: string; recipientScopeRef?: string; recordedAt?: string;
}
type DutyKind = 'possible-leak' | 'confirmed-leak' | 'confirmed-priority' | 'confirmed-additional' | 'not-a-leak' |
  'pipc-kisa-report' | 'pipc-kisa-priority' | 'pipc-kisa-additional' | 'mohw-notice';
type DutyFamily = 'possibility' | 'confirmed' | 'additional-notice' | 'no-leak' | 'report' | 'additional-report' | 'medical';
export interface IncidentNoticeEvidence {
  kind: DutyKind; triggeredAt: string; noticeId: string; sentAt: string;
  institutionId?: string; incidentId?: string; triggerEventId?: string;
  /** A scope reference names an immutable recipient set, never a query hit count. A partial set cannot fulfill all. */
  recipientScopeRef?: string; coversAll?: boolean; evidenceId?: string; recordedAt?: string;
}
interface BoundNotice extends IncidentNoticeEvidence {
  institutionId: string; incidentId: string; triggerEventId: string; recipientScopeRef: string;
  coversAll: boolean; evidenceId: string; recordedAt: string;
}
interface BoundFinding {
  findingId: string; institutionId: string; incidentId: string; by: ImmutableIdentity; recordedAt: string;
  facts: Omit<IncidentResponseFacts, 'priorPossibleNotice' | 'recordedAt'>;
}
export interface IncidentDelay {
  delayId: string; obligationKey: string; clause: string; version: string; reason: string; evidenceId: string;
  by: ImmutableIdentity; recordedAt: string; startedAt: string; clearedAt: string | null;
  accepted: boolean; decisionId: string | null; supersedes: string | null;
}
export interface IncidentDecision {
  decisionId: string; obligationKey: string; at: string; recordedAt: string; by: ImmutableIdentity;
  authorityEvidenceId: string; evidenceId: string; reason: string; basis: string;
  effect: 'timeliness-overdue' | 'final-breach' | 'extinguished'; stillOwed: boolean;
}
export interface IncidentObligation {
  obligationKey: string; family: DutyFamily; triggerEventId: string; recipientScopeRef: string;
  kind: DutyKind;
  recipient: 'all-possibly-affected-subjects' | 'affected-subjects' | 'previously-notified-subjects' | 'PIPC-or-KISA' | 'MOHW';
  dueAt: string | null; originalDueAt: string | null;
  timing: 'without-delay-within-72-hours' | 'immediate' | 'deferred-until-cause-cleared';
  triggeredAt: string; discoveredAt: string | null; requiredFields: readonly string[]; basis: readonly string[];
  status: 'pending' | 'met' | 'overdue' | 'missed' | 'moot'; stillOwed: boolean; actionRequiredNow: boolean;
  notice: { noticeId: string; sentAt: string } | null; noticeRefs: readonly string[]; causeRefs: readonly string[];
  elapsedMs: number; lateByMs: number | null; sinceDiscoveryMs: number | null; sinceClearanceMs: number | null;
  timeliness: 'requires-review' | 'delay-accepted' | 'overdue-determined' | 'final-breach';
  delayRefs: readonly string[]; decisionRefs: readonly string[]; replacedBy: string | null;
  observations: readonly { asOf: string; status: IncidentObligation['status']; noticeRefs: readonly string[] }[];
  corrections: readonly { observedAt: string; revisedAt: string; reason: 'evidence-replayed'; evidenceRefs: readonly string[] }[];
}
export interface IncidentResponsePlan {
  incidentId: string; institutionId: string; recordedBy: ImmutableIdentity; subjectsIdentifiable: boolean;
  awarenessAt: string; verdict: IncidentResponseFacts['status']; determinationAt: string; asOf: string;
  hasNotifiedPossible: boolean;
  ledger: { findings: readonly BoundFinding[]; notices: readonly BoundNotice[]; delays: readonly IncidentDelay[]; decisions: readonly IncidentDecision[] };
  obligations: readonly IncidentObligation[]; status: 'planned';
}
export interface IncidentResponseHistory {
  previous?: Readonly<IncidentResponsePlan>; notices?: readonly IncidentNoticeEvidence[]; asOf?: string;
  findings?: readonly IncidentResponseFacts[]; delays?: readonly IncidentDelay[]; decisions?: readonly IncidentDecision[];
}
const incidentResponses = new WeakSet<object>();
const LEAK_NOTICE_FIELDS = freeze(['data-items', 'occurrence-and-circumstances', 'subject-protective-actions',
  'controller-response-and-remedies', 'contact-department', 'legal-rights-and-exercise']);
const DUTY_FAMILY: Readonly<Record<DutyKind, DutyFamily>> = freeze({
  'possible-leak': 'possibility', 'confirmed-leak': 'confirmed', 'confirmed-priority': 'confirmed',
  'confirmed-additional': 'additional-notice', 'not-a-leak': 'no-leak', 'pipc-kisa-report': 'report',
  'pipc-kisa-priority': 'report', 'pipc-kisa-additional': 'additional-report', 'mohw-notice': 'medical',
});
// LQ-01: no numeric legal deadline is invented for "immediate"; elapsed time is not a legal verdict.
const IMMEDIATE_TIMING_RULE = freeze({ dueAt: null as string | null, status: 'pending' as const, timeliness: 'requires-review' as const });
// LQ-02: each exception belongs to its own provision; a documented acceptance preserves the original clock and
// clearance requires immediate action. A pending claim never disables the statutory clock.
const DELAY_RULE = freeze({ clauses: { possibility: 'privacy-decree:39-3.1', confirmed: 'privacy-decree:39.1', report: 'privacy-decree:40.1' },
  clearedDueAt: (_at: string): string | null => null });
// LQ-03: only a pre-deadline no-leak finding moots an unnotified numeric duty. A final breach decision alone still owes performance.
const NO_LEAK_CLOSURE_RULE = freeze({ canMoot: (at: string, due: string | null) => due !== null && at < due, finalBreachStillOwed: true });
// LQ-04: preserve occurrence as legal cause and expose time since discovery separately.
const MEDICAL_TRIGGER_RULE = (incident: NonNullable<IncidentResponseFacts['medicalIncident']>) => incident.occurredAt;
// LQ-05: confirmation at the original boundary still substitutes, with the earlier limit and any accepted delay retained.
const CONFIRMATION_REPLACEMENT_RULE = freeze({ within: (at: string, due: string, acceptedDelay: boolean) => at <= due || acceptedDelay,
  due: (possibleDue: string, confirmedDue: string) => possibleDue < confirmedDue ? possibleDue : confirmedDue });
// LQ-06: both actual events must exist; late receipt does not move their trigger to the receipt time.
const NO_LEAK_FOLLOWUP_RULE = (sentAt: string, confirmedAt: string) => sentAt > confirmedAt ? sentAt : confirmedAt;
const hours72 = (at: string) => new Date(Date.parse(at) + 72 * 3_600_000).toISOString();
const elapsed = (start: string, end: string) => Math.max(0, Date.parse(end) - Date.parse(start));
function optionalObject(input: unknown, required: readonly string[], optional: readonly string[]): Record<string, any> {
  const keys = Object.keys(input ?? {});
  return object(input, [...required, ...optional.filter(k => keys.includes(k))]);
}
function incidentFacts(input: unknown, scope: IncidentScope): IncidentResponseFacts {
  const v = optionalObject(input, ['incidentId', 'awarenessAt', 'determinationAt', 'status', 'possibleGround',
    'detailsComplete', 'newlyConfirmedAt', 'reportTriggers', 'medicalIncident', 'evidenceId'],
    ['priorPossibleNotice', 'verdictId', 'supersedes', 'possibilityEventId', 'additionalEventId', 'reportEventId', 'reportKnownAt', 'recipientScopeRef', 'recordedAt']);
  string(v.incidentId); utc(v.awarenessAt); utc(v.determinationAt); string(v.evidenceId);
  choice(v.status, ['possible', 'confirmed', 'not-a-leak']);
  if (v.determinationAt < v.awarenessAt || typeof v.detailsComplete !== 'boolean') throw new Error('Invalid finding');
  if (v.possibleGround !== null) choice(v.possibleGround, ['illegal-access-unidentifiable', 'other-subjects-at-risk']);
  if (v.status === 'possible' && (v.possibleGround === null ||
      (v.possibleGround === 'illegal-access-unidentifiable' && scope.subjectsIdentifiable))) throw new Error('Possible-leak ground required');
  if (v.priorPossibleNotice !== undefined && v.priorPossibleNotice !== null) {
    const n = object(v.priorPossibleNotice, ['noticeId', 'sentAt']); string(n.noticeId); utc(n.sentAt);
  }
  if (v.newlyConfirmedAt !== null && (utc(v.newlyConfirmedAt) < v.determinationAt || v.status !== 'confirmed')) throw new Error('Invalid additional finding');
  uniqueStrings(v.reportTriggers, true).forEach(t => choice(t, ['1000-subjects', 'sensitive-or-unique', 'external-illegal-access']));
  if (v.medicalIncident !== null) {
    const m = object(v.medicalIncident, ['occurredAt', 'discoveredAt']); utc(m.occurredAt); utc(m.discoveredAt);
    if (m.occurredAt > m.discoveredAt) throw new Error('Discovery before occurrence');
  }
  for (const k of ['verdictId', 'supersedes', 'possibilityEventId', 'additionalEventId', 'reportEventId', 'recipientScopeRef'])
    if (v[k] !== undefined) string(v[k]);
  for (const k of ['reportKnownAt', 'recordedAt']) if (v[k] !== undefined) utc(v[k]);
  if (v.reportKnownAt !== undefined && (v.status !== 'confirmed' || v.reportKnownAt < v.determinationAt))
    throw new Error('Invalid report trigger');
  return v as IncidentResponseFacts;
}
/** Exactly one ordered projection: bind the complete evidence snapshot, derive facts, construct duties, then calculate
 * their current state. Neither the preceding status nor an optional assertion can create or remove notice facts. */
export function planIncidentResponse(authority: AuditAuthority, scope: IncidentScope, input: unknown,
  history: IncidentResponseHistory = {}): Readonly<IncidentResponsePlan> {
  requireScope(authority, 'investigate');
  if (!incidentScopes.has(scope)) refuse('IncidentScopeRequired');
  if (scope.institutionId !== authority.institutionId) refuse('AuditScopeNotGranted');
  return guarded('IncidentResponseRefused', () => {
    optionalObject(history, [], ['previous', 'notices', 'asOf', 'findings', 'delays', 'decisions']);
    const f = incidentFacts(input, scope), asOf = utc(history.asOf ?? f.newlyConfirmedAt ?? f.determinationAt), previous = history.previous;
    if (previous && (!incidentResponses.has(previous) || previous.incidentId !== f.incidentId || previous.institutionId !== authority.institutionId ||
        previous.awarenessAt !== f.awarenessAt || previous.asOf > asOf)) throw new Error('Unbound history');
    const key = (family: DutyFamily, eventId: string, recipients: string) => JSON.stringify([authority.institutionId, f.incidentId, family, eventId, recipients]);
    const list = <T>(value: readonly T[] | undefined): readonly T[] => { if (value !== undefined && !Array.isArray(value)) throw new Error('Expected list'); return value ?? []; };
    const merge = <T>(items: readonly T[], id: (item: T) => string, content: (item: T) => unknown = x => x): T[] => {
      const result = new Map<string, T>();
      for (const item of items) {
        const old = result.get(id(item));
        if (old && digest(content(old)) !== digest(content(item))) throw new Error('Conflicting evidence ID');
        if (!old) result.set(id(item), item);
      }
      return [...result.values()].sort((a, b) => id(a).localeCompare(id(b)));
    };
    // 1. Bind immutable findings, including actual event times and receipt provenance. Compatibility IDs are stable
    // within this incident; independent same-time facts supply their distinct source IDs explicitly.
    const incoming = [...list(history.findings), f].map(value => {
      const v = incidentFacts(value, scope);
      if (v.incidentId !== f.incidentId || v.awarenessAt !== f.awarenessAt) throw new Error('Other incident');
      const recordedAt = v.recordedAt ?? asOf;
      if (recordedAt > asOf || recordedAt < v.determinationAt || (v.newlyConfirmedAt !== null && v.newlyConfirmedAt > recordedAt) ||
          (v.reportKnownAt && v.reportKnownAt > recordedAt) || (v.medicalIncident && v.medicalIncident.discoveredAt > recordedAt)) throw new Error('Future finding');
      const facts: BoundFinding['facts'] = {
        incidentId: v.incidentId, awarenessAt: v.awarenessAt, determinationAt: v.determinationAt, status: v.status,
        possibleGround: v.possibleGround, detailsComplete: v.detailsComplete, newlyConfirmedAt: v.newlyConfirmedAt,
        reportTriggers: [...v.reportTriggers].sort(), medicalIncident: v.medicalIncident ? { ...v.medicalIncident } : null, evidenceId: v.evidenceId,
        verdictId: v.verdictId ?? `verdict:${v.status}:${v.determinationAt}`, ...(v.supersedes ? { supersedes: v.supersedes } : {}),
        possibilityEventId: v.possibilityEventId ?? `possibility:${v.awarenessAt}`, additionalEventId: v.additionalEventId ?? `additional:${v.newlyConfirmedAt}`,
        reportEventId: v.reportEventId ?? `report:${v.reportKnownAt ?? v.determinationAt}`,
        ...(v.reportKnownAt !== undefined || v.reportTriggers.length ? { reportKnownAt: v.reportKnownAt ?? v.determinationAt } : {}),
        recipientScopeRef: v.recipientScopeRef ?? 'incident-subjects',
      };
      return { findingId: digest(facts), institutionId: authority.institutionId, incidentId: f.incidentId,
        facts, by: { ...authority.subject }, recordedAt };
    });
    const findings = merge([...(previous?.ledger.findings ?? []), ...incoming], x => x.findingId, x => x.facts);
    const facts = findings.map(x => x.facts).sort((a, b) => a.determinationAt.localeCompare(b.determinationAt) || a.verdictId.localeCompare(b.verdictId));
    const verdicts = merge(facts.map(v => ({ id: v.verdictId, at: v.determinationAt, status: v.status, supersedes: v.supersedes ?? null })), x => x.id);
    for (const v of verdicts) if (v.supersedes) {
      const old = verdicts.find(x => x.id === v.supersedes);
      if (!old || old.id === v.id || old.at > v.at || verdicts.some(x => x.id !== v.id && x.supersedes === old.id)) throw new Error('Invalid verdict correction');
      const visited = new Set([v.id]); let parent = old;
      while (parent) { if (visited.has(parent.id)) throw new Error('Cyclic correction'); visited.add(parent.id); parent = verdicts.find(x => x.id === parent.supersedes); }
    }
    const effective = verdicts.filter(v => !verdicts.some(x => x.supersedes === v.id)).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    for (let i = 1; i < effective.length; i++) if (effective[i].at === effective[i - 1].at && effective[i].status !== effective[i - 1].status)
      throw new Error('Ambiguous simultaneous verdicts');
    type Cause = { family: DutyFamily; eventId: string; at: string; recipients: string; fact: BoundFinding['facts']; discoveredAt?: string };
    const causes: Cause[] = [];
    for (const v of facts) {
      if (v.possibleGround !== null) causes.push({ family: 'possibility', eventId: v.possibilityEventId, at: v.awarenessAt, recipients: v.recipientScopeRef, fact: v });
      if (v.status === 'confirmed') {
        causes.push({ family: 'confirmed', eventId: v.verdictId, at: v.determinationAt, recipients: v.recipientScopeRef, fact: v });
        if (v.reportTriggers.length) causes.push({ family: 'report', eventId: v.reportEventId, at: v.reportKnownAt, recipients: 'PIPC-or-KISA', fact: v });
        if (v.newlyConfirmedAt !== null) {
          causes.push({ family: 'additional-notice', eventId: v.additionalEventId, at: v.newlyConfirmedAt, recipients: v.recipientScopeRef, fact: v });
          if (v.reportTriggers.length) causes.push({ family: 'additional-report', eventId: v.additionalEventId, at: v.newlyConfirmedAt, recipients: 'PIPC-or-KISA', fact: v });
        }
      }
      if (v.medicalIncident) causes.push({ family: 'medical', eventId: `medical:${v.medicalIncident.occurredAt}`, at: MEDICAL_TRIGGER_RULE(v.medicalIncident),
        discoveredAt: v.medicalIncident.discoveredAt, recipients: 'MOHW', fact: v });
    }
    const sources = merge(causes, c => key(c.family, c.eventId, c.recipients), c => [c.family, c.eventId, c.at, c.recipients, c.discoveredAt ?? null]);
    // Initial confirmation/report clocks belong to the first cause for that recipient scope. Completeness is a mode,
    // not a fresh duty. Other confirmation findings remain in the ledger and additional facts keep distinct IDs.
    const initial = (c: Cause) => !['confirmed', 'report'].includes(c.family) || !sources.some(x => x.family === c.family && x.recipients === c.recipients &&
      (x.at < c.at || (x.at === c.at && x.eventId < c.eventId)));
    const dutySources = sources.filter(initial);
    const rawNotices = [...(previous?.ledger.notices ?? []), ...list(history.notices)];
    const parsedNotices = rawNotices.map(value => {
      const n = optionalObject(value, ['kind', 'triggeredAt', 'noticeId', 'sentAt'], ['institutionId', 'incidentId', 'triggerEventId', 'recipientScopeRef', 'coversAll', 'evidenceId', 'recordedAt']);
      choice(n.kind, Object.keys(DUTY_FAMILY) as DutyKind[]); string(n.noticeId); utc(n.triggeredAt); utc(n.sentAt);
      const family = DUTY_FAMILY[n.kind], recordedAt = utc(n.recordedAt ?? asOf);
      if (n.sentAt < n.triggeredAt || n.sentAt > recordedAt || recordedAt > asOf ||
          (n.institutionId !== undefined && n.institutionId !== authority.institutionId) || (n.incidentId !== undefined && n.incidentId !== f.incidentId)) throw new Error('Unbound notice');
      const matches = family === 'no-leak' ? verdicts.filter(v => v.status === 'not-a-leak' && v.at <= n.triggeredAt && (!n.triggerEventId || v.id === n.triggerEventId))
        .map(v => ({ eventId: v.id, recipients: 'incident-subjects' })) : dutySources.filter(c => c.family === family && c.at === n.triggeredAt && (!n.triggerEventId || c.eventId === n.triggerEventId));
      if (matches.length !== 1) throw new Error('Unknown or ambiguous notice trigger');
      if (n.coversAll !== undefined && typeof n.coversAll !== 'boolean') throw new Error('Coverage evidence required');
      return { kind: n.kind as DutyKind, triggeredAt: n.triggeredAt, noticeId: n.noticeId, sentAt: n.sentAt,
        institutionId: authority.institutionId, incidentId: f.incidentId, triggerEventId: matches[0].eventId,
        recipientScopeRef: string(n.recipientScopeRef ?? matches[0].recipients), coversAll: n.coversAll ?? true,
        evidenceId: string(n.evidenceId ?? n.noticeId), recordedAt };
    });
    const notices = merge(parsedNotices, n => n.noticeId, n => { const { recordedAt, ...bound } = n; return bound; });
    const delays = merge([...(previous?.ledger.delays ?? []), ...list(history.delays)].map(value => {
      const d = object(value, ['delayId', 'obligationKey', 'clause', 'version', 'reason', 'evidenceId', 'by', 'recordedAt', 'startedAt', 'clearedAt', 'accepted', 'decisionId', 'supersedes']);
      for (const k of ['delayId', 'obligationKey', 'clause', 'version', 'reason', 'evidenceId']) string(d[k]);
      identity(d.by); utc(d.recordedAt); utc(d.startedAt); if (d.clearedAt !== null) utc(d.clearedAt);
      if (typeof d.accepted !== 'boolean' || (d.accepted && !d.decisionId)) throw new Error('Delay acceptance required');
      if (d.decisionId !== null) string(d.decisionId); if (d.supersedes !== null) string(d.supersedes);
      if (d.recordedAt > asOf || d.startedAt > d.recordedAt || (d.clearedAt !== null && (d.clearedAt < d.startedAt || d.clearedAt > d.recordedAt))) throw new Error('Invalid delay time');
      return { ...d, by: { ...d.by } } as IncidentDelay;
    }), d => d.delayId);
    const decisions = merge([...(previous?.ledger.decisions ?? []), ...list(history.decisions)].map(value => {
      const d = object(value, ['decisionId', 'obligationKey', 'at', 'recordedAt', 'by', 'authorityEvidenceId', 'evidenceId', 'reason', 'basis', 'effect', 'stillOwed']);
      for (const k of ['decisionId', 'obligationKey', 'authorityEvidenceId', 'evidenceId', 'reason', 'basis']) string(d[k]);
      identity(d.by); utc(d.at); utc(d.recordedAt); choice(d.effect, ['timeliness-overdue', 'final-breach', 'extinguished']);
      if (d.at > d.recordedAt || d.recordedAt > asOf || typeof d.stillOwed !== 'boolean' ||
          (d.effect === 'final-breach' && d.stillOwed !== NO_LEAK_CLOSURE_RULE.finalBreachStillOwed) ||
          (d.effect === 'extinguished' ? d.stillOwed : !d.stillOwed)) throw new Error('Invalid decision');
      return { ...d, by: { ...d.by } } as IncidentDecision;
    }), d => d.decisionId);
    // 2. Derive notice facts only after ALL evidence is bound. Assertions never act as evidence.
    const possibleNotices = notices.filter(n => n.kind === 'possible-leak');
    if (f.priorPossibleNotice !== undefined && (f.priorPossibleNotice === null ? possibleNotices.length > 0 :
        !possibleNotices.some(n => n.noticeId === f.priorPossibleNotice.noticeId && n.sentAt === f.priorPossibleNotice.sentAt))) throw new Error('Contradictory notice assertion');
    const followups: Cause[] = [];
    for (const v of verdicts.filter(v => v.status === 'not-a-leak')) for (const n of possibleNotices) {
      // A later different verdict can supersede the no-leak result before a reverse-order delivery; retain that
      // delivery but do not tell its recipients a result that was already replaced at the actual send time.
      if (effective.some(x => x.at > v.at && x.at <= n.sentAt && x.status !== 'not-a-leak')) continue;
      if (verdicts.some(x => x.supersedes === v.id && x.at <= NO_LEAK_FOLLOWUP_RULE(n.sentAt, v.at))) continue;
      followups.push({ family: 'no-leak', eventId: v.id, at: NO_LEAK_FOLLOWUP_RULE(n.sentAt, v.at), recipients: n.recipientScopeRef,
        fact: facts.find(x => x.verdictId === v.id) });
    }
    const followupMap = new Map<string, Cause>();
    for (const c of followups) { const k = key(c.family, c.eventId, c.recipients), old = followupMap.get(k); if (!old || c.at < old.at) followupMap.set(k, c); }
    // 3. Build duties by cause, never by a previous presentation status.
    const obligations: IncidentObligation[] = [];
    const familyOrder: DutyFamily[] = ['possibility', 'confirmed', 'additional-notice', 'report', 'additional-report', 'no-leak', 'medical'];
    const ordered = [...dutySources, ...followupMap.values()].sort((a, b) => familyOrder.indexOf(a.family) - familyOrder.indexOf(b.family) || a.at.localeCompare(b.at) ||
      key(a.family, a.eventId, a.recipients).localeCompare(key(b.family, b.eventId, b.recipients)));
    for (const c of ordered) {
      const mode = facts.filter(v => v.status === 'confirmed' && v.determinationAt === c.fact.determinationAt).some(v => v.detailsComplete);
      const kind: DutyKind = ({ possibility: 'possible-leak', confirmed: mode ? 'confirmed-leak' : 'confirmed-priority',
        'additional-notice': 'confirmed-additional', 'no-leak': 'not-a-leak', report: mode ? 'pipc-kisa-report' : 'pipc-kisa-priority',
        'additional-report': 'pipc-kisa-additional', medical: 'mohw-notice' } as const)[c.family];
      const recipient = ({ possibility: 'all-possibly-affected-subjects', confirmed: 'affected-subjects', 'additional-notice': 'affected-subjects',
        'no-leak': 'previously-notified-subjects', report: 'PIPC-or-KISA', 'additional-report': 'PIPC-or-KISA', medical: 'MOHW' } as const)[c.family];
      const numeric = ['possibility', 'confirmed', 'report'].includes(c.family);
      let originalDueAt = numeric ? hours72(c.at) : IMMEDIATE_TIMING_RULE.dueAt;
      const replaces = c.family === 'confirmed' ? dutySources.find(x => x.family === 'possibility' && x.recipients === c.recipients &&
        CONFIRMATION_REPLACEMENT_RULE.within(c.at, hours72(x.at), delays.some(d => d.obligationKey === key(x.family, x.eventId, x.recipients) &&
          d.accepted && !delays.some(next => next.supersedes === d.delayId) && d.startedAt <= c.at && (d.clearedAt === null || c.at <= d.clearedAt)))) : undefined;
      if (replaces) originalDueAt = CONFIRMATION_REPLACEMENT_RULE.due(hours72(replaces.at), originalDueAt);
      const requiredFields = c.family === 'possibility' ? ['possible-data-items', 'suspected-time-and-circumstances', ...LEAK_NOTICE_FIELDS.slice(2, 5), 'further-notice-on-determination'] :
        c.family === 'no-leak' ? ['no-leak-confirmed', 'prior-possible-notice-reference'] : c.family === 'medical' ? ['institution-name', 'incident-time', 'damage-details', 'technical-support-request'] :
        c.family === 'additional-notice' ? ['newly-confirmed-facts', 'legal-rights-and-exercise'] : c.family === 'additional-report' ? ['newly-confirmed-facts'] :
        mode ? LEAK_NOTICE_FIELDS : ['leak-confirmed', 'facts-known-so-far', ...LEAK_NOTICE_FIELDS.slice(2, c.family === 'report' ? 5 : undefined)];
      const basis = ({ possibility: ['privacy:34.2', 'privacy-decree:39-2', 'privacy-decree:39-3.1'], confirmed: ['privacy:34.1', 'privacy-decree:39.1', 'privacy-decree:39.2'],
        'additional-notice': ['privacy-decree:39.2'], 'no-leak': ['privacy-decree:39-3.3'], report: ['privacy:34.4', 'privacy-decree:40.1', 'privacy-decree:40.2'],
        'additional-report': ['privacy-decree:40.2'], medical: ['medical:23-3.1', 'medical-rules:16-2.1'] })[c.family];
      obligations.push({ obligationKey: key(c.family, c.eventId, c.recipients), family: c.family, triggerEventId: c.eventId, recipientScopeRef: c.recipients,
        kind, recipient, triggeredAt: c.at, discoveredAt: c.discoveredAt ?? null, originalDueAt, dueAt: originalDueAt,
        timing: numeric ? 'without-delay-within-72-hours' : 'immediate', requiredFields, basis,
        status: 'pending', stillOwed: true, actionRequiredNow: !numeric, notice: null, noticeRefs: [],
        causeRefs: [c.eventId, c.fact.evidenceId, ...(c.fact.supersedes ? [c.fact.supersedes] : []), ...(replaces ? [replaces.eventId] : []),
          ...(c.family === 'no-leak' ? possibleNotices.filter(n => n.recipientScopeRef === c.recipients).map(n => n.noticeId) : [])],
        elapsedMs: 0, lateByMs: null, sinceDiscoveryMs: null, sinceClearanceMs: null, timeliness: IMMEDIATE_TIMING_RULE.timeliness,
        delayRefs: [], decisionRefs: [], replacedBy: null, observations: [], corrections: [] });
    }
    // Every piece of evidence must have a unique destination; reject the whole snapshot if a reference is unusable.
    const belongs = (n: BoundNotice, o: IncidentObligation) => DUTY_FAMILY[n.kind] === o.family && n.triggerEventId === o.triggerEventId && n.triggeredAt === o.triggeredAt &&
      (n.recipientScopeRef === o.recipientScopeRef || (!n.coversAll && o.family === 'possibility'));
    for (const n of notices) if (obligations.filter(o => belongs(n, o)).length !== 1) throw new Error('Unbound notice scope');
    for (const d of delays) {
      const o = obligations.find(o => o.obligationKey === d.obligationKey);
      if (!o || d.clause !== DELAY_RULE.clauses[o.family] || d.startedAt < o.triggeredAt) throw new Error('Wrong delay provision');
      if (d.supersedes) { const old = delays.find(x => x.delayId === d.supersedes);
        if (!old || old.obligationKey !== d.obligationKey || old.recordedAt > d.recordedAt || old.startedAt !== d.startedAt ||
            old.clause !== d.clause || old.version !== d.version || old.delayId === d.delayId || delays.some(x => x.delayId !== d.delayId && x.supersedes === old.delayId)) throw new Error('Invalid delay correction'); }
      const visited = new Set([d.delayId]); let parent = delays.find(x => x.delayId === d.supersedes);
      while (parent) { if (visited.has(parent.delayId)) throw new Error('Cyclic delay correction'); visited.add(parent.delayId); parent = delays.find(x => x.delayId === parent.supersedes); }
    }
    for (const d of decisions) if (!obligations.some(o => o.obligationKey === d.obligationKey && o.triggeredAt <= d.at)) throw new Error('Unbound decision');
    // 4. Calculate performance separately from timing and final judgments. A late delivery can fulfill the duty.
    for (const o of obligations) {
      const matching = notices.filter(n => belongs(n, o)).sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.noticeId.localeCompare(b.noticeId));
      const fulfilled = matching.find(n => n.coversAll && n.recipientScopeRef === o.recipientScopeRef);
      o.noticeRefs = matching.map(n => n.noticeId).sort();
      if (fulfilled) o.notice = { noticeId: fulfilled.noticeId, sentAt: fulfilled.sentAt };
      const replacementSource = o.family === 'confirmed' ? obligations.find(x => x.family === 'possibility' && x.recipientScopeRef === o.recipientScopeRef && o.causeRefs.includes(x.triggerEventId)) : undefined;
      const applicableDelays = delays.filter(d => d.obligationKey === o.obligationKey || (replacementSource && d.obligationKey === replacementSource.obligationKey));
      const activeDelays = applicableDelays.filter(d => d.accepted && !delays.some(x => x.supersedes === d.delayId));
      if (activeDelays.length > 1) throw new Error('Ambiguous accepted delays');
      const delay = activeDelays[0];
      o.delayRefs = applicableDelays.map(d => d.delayId).sort();
      if (delay) { o.dueAt = delay.clearedAt === null ? null : DELAY_RULE.clearedDueAt(delay.clearedAt);
        o.timing = delay.clearedAt === null ? 'deferred-until-cause-cleared' : 'immediate'; o.timeliness = 'delay-accepted'; }
      const boundDecisions = decisions.filter(d => d.obligationKey === o.obligationKey);
      o.decisionRefs = boundDecisions.map(d => d.decisionId).sort();
      const final = boundDecisions.find(d => d.effect === 'final-breach' || d.effect === 'extinguished');
      const changed = effective.find(v => v.at >= o.triggeredAt && v.status === 'not-a-leak' && NO_LEAK_CLOSURE_RULE.canMoot(v.at, o.originalDueAt));
      const replacing = o.family === 'possibility' ? obligations.find(x => x.family === 'confirmed' && x.causeRefs.includes(o.triggerEventId) && x.recipientScopeRef === o.recipientScopeRef) : undefined;
      o.replacedBy = replacing?.obligationKey ?? null;
      if (fulfilled) o.status = 'met';
      else if (final) o.status = 'missed';
      else if (!matching.length && ((!delay && changed) || replacing) && ['possibility', 'confirmed', 'report'].includes(o.family)) {
        o.status = 'moot'; if (changed) o.causeRefs = [...o.causeRefs, changed.id];
      } else if ((o.dueAt !== null && asOf > o.dueAt) || boundDecisions.some(d => d.effect === 'timeliness-overdue')) o.status = 'overdue';
      else o.status = IMMEDIATE_TIMING_RULE.status;
      if (final) o.timeliness = 'final-breach';
      else if (boundDecisions.some(d => d.effect === 'timeliness-overdue')) o.timeliness = 'overdue-determined';
      o.stillOwed = !['met', 'moot'].includes(o.status) && !boundDecisions.some(d => d.effect === 'extinguished');
      o.actionRequiredNow = o.stillOwed && o.timing !== 'deferred-until-cause-cleared';
      const end = fulfilled?.sentAt ?? asOf;
      o.elapsedMs = elapsed(o.triggeredAt, end);
      o.lateByMs = o.originalDueAt === null ? null : elapsed(o.originalDueAt, end);
      o.sinceDiscoveryMs = o.discoveredAt === null ? null : elapsed(o.discoveredAt, end);
      o.sinceClearanceMs = delay?.clearedAt ? elapsed(delay.clearedAt, end) : null;
      const old = previous?.obligations.find(x => x.obligationKey === o.obligationKey);
      o.observations = [...(old?.observations ?? []), { asOf, status: o.status, noticeRefs: [...o.noticeRefs] }];
      o.corrections = [...(old?.corrections ?? [])];
      if (old && (old.status !== o.status || digest(old.noticeRefs) !== digest(o.noticeRefs))) o.corrections = [...o.corrections,
        { observedAt: old.observations[old.observations.length - 1].asOf, revisedAt: asOf, reason: 'evidence-replayed', evidenceRefs: [...o.noticeRefs, ...o.decisionRefs, ...o.delayRefs, ...o.causeRefs] }];
    }
    const currentVerdict = effective[effective.length - 1];
    const result = freeze({ incidentId: f.incidentId, institutionId: authority.institutionId, recordedBy: { ...authority.subject },
      awarenessAt: f.awarenessAt, verdict: currentVerdict.status, determinationAt: currentVerdict.at, asOf,
      subjectsIdentifiable: scope.subjectsIdentifiable, hasNotifiedPossible: possibleNotices.length > 0,
      ledger: { findings, notices, delays, decisions }, obligations, status: 'planned' as const });
    incidentResponses.add(result);
    return result;
  });
}


// ---------------------------------------------------------------------------------------------------------------------
// Lawful copies and legal submissions (REQ-EMR-16, RISK-F-03·04; 의료법 제21조, legal register LR-18·LR-19, delta D-7)

/**
 * Each clause's in-force wording by the promulgation that gave it (law-evidence.json blobs): 21524 (in force 2026-04-07)
 * added ③20; 21490 (in force 2026-10-02) did not amend 제21조; 21776 (in force 2026-12-10) widened ③10 to 확인신체검사
 * (병역법 제77조의2). A request is judged by the wording in force on its Seoul receipt day. Earlier days are unknown here
 * and refused; add reviewed entries, never remove one.
 */
export const DISCLOSURE_CLAUSE_VERSIONS = freeze([
  { law: 'medical', publication: '21524', publishedAt: '2026-04-07', effectiveAt: '2026-04-07' },
  { law: 'medical', publication: '21776', publishedAt: '2026-06-09', effectiveAt: '2026-12-10' },
]);
export type RequesterKind = 'patient' | 'family' | 'designated-agent' | 'statutory-authority';
export type QualificationEvidence = 'identity-check' | 'patient-consent' | 'relationship-proof' | 'agency-proof' | 'consent-impossible' | 'official-request';
interface DisclosureBasis { article: string; requester: RequesterKind; evidence: readonly QualificationEvidence[]; purposes?: Readonly<Record<string, readonly string[]>> }
const statutoryBasis = (article: string): DisclosureBasis => ({ article, requester: 'statutory-authority', evidence: ['official-request'] });
export const DISCLOSURE_BASES: Readonly<Record<string, DisclosureBasis>> = freeze({
  'medical:21.1': { article: '21.1', requester: 'patient', evidence: ['identity-check'] },
  'medical:21.3.1': { article: '21.3.1', requester: 'family', evidence: ['identity-check', 'patient-consent', 'relationship-proof'] },
  'medical:21.3.2': { article: '21.3.2', requester: 'designated-agent', evidence: ['identity-check', 'patient-consent', 'agency-proof'] },
  'medical:21.3.3': { article: '21.3.3', requester: 'family', evidence: ['identity-check', 'relationship-proof', 'consent-impossible'] },
  ...Object.fromEntries(['4', '5', '6', '6-2', '7', '8', '9', '11', '12', '13', '14', '14-2', '14-3', '14-4', '15', '16', '17', '18', '19', '20']
    .map(n => [`medical:21.3.${n}`, statutoryBasis(`21.3.${n}`)])),
  'medical:21.3.10': { ...statutoryBasis('21.3.10'), purposes: {
    '21524': ['conscription-examination', 'military-register'],
    '21776': ['conscription-examination', 'confirmation-examination', 'military-register'],
  } },
});
function clauseVersionInForce(at: string): Readonly<{ law: string; publication: string; publishedAt: string; effectiveAt: string }> {
  const day = seoulDay(at);
  const inForce = DISCLOSURE_CLAUSE_VERSIONS.filter(v => v.effectiveAt <= day);
  if (!inForce.length) refuse('DisclosureBasisVersionUnknown');
  return [...inForce].sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt))[inForce.length - 1];
}

export type DeliveryMethod = 'in-person' | 'postal' | 'electronic';
export type CopyFormat = 'paper-print' | 'signed-electronic';
export interface DisclosureRequest {
  requestId: string; receivedAt: string; patient: PatientLinkSnapshot;
  basis: { clauseId: string; purpose: string };
  requester: { kind: RequesterKind; name: string; organization: string | null };
  evidence: readonly { kind: QualificationEvidence; documentId: string; checkedBy: ImmutableIdentity; checkedAt: string }[];
  scope: readonly { recordId: string; versions: 'all' | readonly string[] }[];
  delivery: { recipient: string; method: DeliveryMethod; format: CopyFormat };
}
export interface DisclosureApproval {
  request: DisclosureRequest; institutionId: string;
  basis: { clauseId: string; law: string; article: string; publication: string; effectiveAt: string };
  approvedBy: ImmutableIdentity; approvedAt: string;
}
function parseDisclosureRequest(input: unknown): DisclosureRequest {
  return guarded('DisclosureRequestRefused', () => {
    const v = object(input, ['requestId', 'receivedAt', 'patient', 'basis', 'requester', 'evidence', 'scope', 'delivery']);
    const basis = object(v.basis, ['clauseId', 'purpose']), requester = object(v.requester, ['kind', 'name', 'organization']);
    const delivery = object(v.delivery, ['recipient', 'method', 'format']);
    if (!Array.isArray(v.evidence) || !Array.isArray(v.scope) || !v.scope.length) throw new Error('Evidence and scope required');
    const evidence = v.evidence.map(e => {
      const x = object(e, ['kind', 'documentId', 'checkedBy', 'checkedAt']);
      return { kind: choice(x.kind, ['identity-check', 'patient-consent', 'relationship-proof', 'agency-proof', 'consent-impossible', 'official-request']),
        documentId: string(x.documentId), checkedBy: identity(x.checkedBy), checkedAt: utc(x.checkedAt) };
    });
    const scope = v.scope.map(s => {
      const x = object(s, ['recordId', 'versions']);
      return { recordId: string(x.recordId), versions: x.versions === 'all' ? 'all' as const : uniqueStrings(x.versions) };
    });
    if (new Set(scope.map(s => s.recordId)).size !== scope.length || new Set(evidence.map(e => e.kind)).size !== evidence.length)
      throw new Error('Duplicate scope or evidence');
    return {
      requestId: string(v.requestId), receivedAt: utc(v.receivedAt), patient: patientLink(v.patient),
      basis: { clauseId: string(basis.clauseId), purpose: string(basis.purpose) },
      requester: { kind: choice(requester.kind, ['patient', 'family', 'designated-agent', 'statutory-authority']), name: string(requester.name),
        organization: requester.organization === null ? null : string(requester.organization) },
      evidence, scope,
      delivery: { recipient: string(delivery.recipient), method: choice(delivery.method, ['in-person', 'postal', 'electronic']),
        format: choice(delivery.format, ['paper-print', 'signed-electronic']) },
    };
  });
}

const approvals = new WeakSet<object>();
/** The approval binds requester qualification, the clause wording in force when the request arrived, purpose, the exact
 * scope, the approver and the delivery terms. Nothing is prepared or sent here. */
export function approveDisclosure(authority: AuditAuthority, input: unknown, at: string): Readonly<DisclosureApproval> {
  requireScope(authority, 'disclosure');
  const request = parseDisclosureRequest(input);
  guarded('DisclosureRequestRefused', () => utc(at));
  if (at < request.receivedAt) refuse('DisclosureRequestRefused');
  const basis = Object.prototype.hasOwnProperty.call(DISCLOSURE_BASES, request.basis.clauseId) ? DISCLOSURE_BASES[request.basis.clauseId] : null;
  if (!basis) refuse('DisclosureBasisUnknown');
  const version = clauseVersionInForce(request.receivedAt);
  if (basis.purposes && !(basis.purposes[version.publication] ?? []).includes(request.basis.purpose)) refuse('DisclosurePurposeNotInForce');
  if (request.requester.kind !== basis.requester) refuse('RequesterNotQualified');
  if (basis.requester === 'statutory-authority' && request.requester.organization === null) refuse('RequesterNotQualified');
  const kinds = request.evidence.map(e => e.kind);
  if (basis.evidence.some(kind => !kinds.includes(kind)) ||
      request.evidence.some(e => e.checkedAt < request.receivedAt || e.checkedAt > at)) refuse('QualificationEvidenceMissing');
  // 제21조⑤: an electronic copy is a document carrying the electronic signature, never a bare file.
  if ((request.delivery.method === 'electronic') !== (request.delivery.format === 'signed-electronic')) refuse('SignedElectronicDocumentRequired');
  const approval = freeze({ request, institutionId: authority.institutionId,
    basis: { clauseId: request.basis.clauseId, law: version.law, article: basis.article, publication: version.publication, effectiveAt: version.effectiveAt },
    approvedBy: authority.subject, approvedAt: at });
  approvals.add(approval);
  return approval;
}

/** C's fixed versions in round 2: every stored version oldest first, each resolved by the bound A reader, and the
 * verification material of each signed version. */
export interface SignatureEvidence { versionId: string; envelope: SignatureEnvelope; publicKeyEvidenceId: string; identityEvidenceId: string }
export interface VersionListing {
  recordId: string; complete: true; revision: string;
  subject: { patient: PatientLinkSnapshot; studyId: string; managingInstitutionId: string };
  versions: readonly ResolvedRecord[]; signatures: readonly SignatureEvidence[];
}
export interface PackageVersion {
  versionId: string; at: string; act: string; sha256: string; contentSha256: string; predecessor: { versionId: string; sha256: string } | null;
  signature: { keyId: string; envelopeSha256: string; publicKeyEvidenceId: string; identityEvidenceId: string } | null;
}
export interface PackageRecord {
  recordId: string; studyId: string; revision: string; head: { versionId: string; sha256: string };
  selection: 'all-versions' | 'requester-specified'; versions: readonly PackageVersion[];
}
export interface DisclosureManifest {
  formatVersion: 'emr-disclosure/1'; environment: Environment; requestId: string; receivedAt: string; institutionId: string; patient: PatientLinkSnapshot;
  basis: DisclosureApproval['basis']; purpose: string; requester: DisclosureRequest['requester'];
  qualification: readonly { kind: QualificationEvidence; documentId: string }[];
  approvedBy: ImmutableIdentity; approvedAt: string; preparedBy: ImmutableIdentity; preparedAt: string;
  delivery: DisclosureRequest['delivery']; records: readonly PackageRecord[];
}

function verifiedListing(input: unknown): { recordId: string; revision: string; subject: VersionListing['subject']; versions: PackageVersion[] } {
  return guarded('VersionListingRefused', () => {
    const l = object(input, ['recordId', 'complete', 'revision', 'subject', 'versions', 'signatures']);
    if (l.complete !== true) refuse('VersionListingIncomplete');
    const recordId = string(l.recordId), revision = string(l.revision);
    const s = object(l.subject, ['patient', 'studyId', 'managingInstitutionId']);
    const subject = { patient: patientLink(s.patient), studyId: string(s.studyId), managingInstitutionId: string(s.managingInstitutionId) };
    if (!Array.isArray(l.versions) || !l.versions.length || !Array.isArray(l.signatures)) refuse('VersionListingIncomplete');
    const records = l.versions.map(v => verifiedRecord(v));
    const evidence = new Map<string, Record<string, any>>();
    for (const item of l.signatures) {
      const x = object(item, ['versionId', 'envelope', 'publicKeyEvidenceId', 'identityEvidenceId']);
      if (evidence.has(string(x.versionId))) refuse('SignatureEvidenceMismatch');
      evidence.set(x.versionId, x);
    }
    const versions = records.map((r, i) => {
      const e = r.event, previous = i ? records[i - 1].event : null;
      if (r.recordId !== recordId || (previous && e.at < previous.at)) refuse('VersionListingRefused');
      // Original and every later version form one unbroken chain; a missing or reordered version is not a copy.
      if (previous ? !e.predecessor || e.predecessor.recordId !== recordId || e.predecessor.partId !== previous.versionId ||
          e.predecessor.sha256 !== previous.sha256 : e.predecessor !== null) refuse('VersionListingIncomplete');
      let signature: PackageVersion['signature'] = null;
      if (e.signature !== null) {
        const x = evidence.get(e.versionId);
        if (!x) refuse('SignatureEvidenceRequired');
        const { keyId, payloadBytes } = inspectSignatureEnvelope(x.envelope);
        const payload = JSON.parse(payloadBytes.toString('utf8'));
        if (payload.recordId !== recordId || payload.versionId !== e.versionId || payload.studyId !== subject.studyId ||
            payload.managingInstitutionId !== subject.managingInstitutionId || !samePatient(payload.patient, subject.patient))
          refuse('SignatureEvidenceMismatch');
        // A's canonical payload fixes text field order and UTF-8 spelling; content excludes signing metadata.
        if (digest(payload.text) !== e.contentSha256 || payload.serverTime !== e.signature.signedAt ||
            payload.serverTime !== e.at || (e.predecessor === null ? payload.previousVersion !== null :
              payload.previousVersion === null || payload.previousVersion.recordId !== e.predecessor.recordId ||
              payload.previousVersion.versionId !== e.predecessor.partId || payload.previousVersion.sha256 !== e.predecessor.sha256))
          refuse('SignatureEvidenceMismatch');
        signature = { keyId, envelopeSha256: digest(x.envelope), publicKeyEvidenceId: string(x.publicKeyEvidenceId),
          identityEvidenceId: string(x.identityEvidenceId) };
        evidence.delete(e.versionId);
      }
      return { versionId: e.versionId, at: e.at, act: e.act, sha256: e.sha256, contentSha256: e.contentSha256,
        predecessor: previous ? { versionId: previous.versionId, sha256: previous.sha256 } : null, signature };
    });
    if (evidence.size || new Set(versions.map(v => v.versionId)).size !== versions.length) refuse('SignatureEvidenceMismatch');
    return { recordId, revision, subject, versions };
  });
}

export type IssuanceState = 'Prepared' | 'Issued' | 'Delivered' | 'ReceiptUnknown' | 'DeliveryFailed' | 'Closed' | 'Aborted';
export type Environment = 'operational' | 'synthetic-test';
export interface Issuance { issuanceId: string; manifest: DisclosureManifest; manifestSha256: string; environment: Environment; events: readonly unknown[] }

/** The fixed-version package: every version of each requested record (original and all modified versions, D-7), or
 * exactly the versions the requester named, with the signature verification material of each signed version. */
export function prepareDisclosurePackage(authority: AuditAuthority, approval: DisclosureApproval, listings: readonly unknown[],
  at: string, environment: Environment = 'operational'): Readonly<Issuance> {
  requireScope(authority, 'disclosure');
  if (!approvals.has(approval)) refuse('DisclosureApprovalRequired');
  if (approval.institutionId !== authority.institutionId) refuse('AuditScopeNotGranted');
  guarded('VersionListingRefused', () => { utc(at); choice(environment, ['operational', 'synthetic-test']); });
  if (at < approval.approvedAt || !Array.isArray(listings)) refuse('VersionListingRefused');
  const read = listings.map(verifiedListing);
  const request = approval.request;
  if (read.length !== request.scope.length || request.scope.some(s => read.filter(l => l.recordId === s.recordId).length !== 1))
    refuse('VersionListingRefused');
  const records = request.scope.map(s => {
    const l = read.find(x => x.recordId === s.recordId);
    if (!samePatient(l.subject.patient, request.patient) || l.subject.managingInstitutionId !== approval.institutionId) refuse('DisclosureSubjectMismatch');
    const versions = s.versions === 'all' ? l.versions : s.versions.map(id => l.versions.find(v => v.versionId === id) ?? refuse('VersionListingRefused'));
    const head = l.versions[l.versions.length - 1];
    return { recordId: l.recordId, studyId: l.subject.studyId, revision: l.revision, head: { versionId: head.versionId, sha256: head.sha256 },
      selection: s.versions === 'all' ? 'all-versions' as const : 'requester-specified' as const, versions };
  });
  const manifest: DisclosureManifest = {
    formatVersion: 'emr-disclosure/1', environment, requestId: request.requestId, receivedAt: request.receivedAt, institutionId: approval.institutionId,
    patient: request.patient, basis: approval.basis, purpose: request.basis.purpose, requester: request.requester,
    qualification: request.evidence.map(e => ({ kind: e.kind, documentId: e.documentId })),
    approvedBy: approval.approvedBy, approvedAt: approval.approvedAt, preparedBy: authority.subject, preparedAt: at,
    delivery: request.delivery, records,
  };
  const manifestSha256 = digest(manifest);
  return freeze({ issuanceId: `issuance:${randomUUID()}`, manifest, manifestSha256, environment,
    events: [{ kind: 'prepared', at, by: authority.subject, manifestSha256 }] });
}

const TERMINAL: readonly IssuanceState[] = ['Closed', 'Aborted'];
const DELIVERED_EVIDENCE = freeze({ 'recipient-signed-receipt': ['in-person', 'postal'], 'staff-attested-handover': ['in-person'], 'electronic-receipt': ['electronic'] });
const FAILED_EVIDENCE = freeze({ 'returned-mail': ['postal'], 'recipient-declined': ['in-person', 'postal', 'electronic'], 'electronic-failure': ['electronic'] });
/** Folds the append-only issuance history. A stored issuance is re-validated the same way when it is reloaded. */
export function issuanceState(input: unknown): Readonly<{
  state: IssuanceState; environment: Environment; issuedArtifactSha256: string | null;
  delivery: { outcome: 'delivered' | 'failed' | 'unknown'; detection: 'staff-attested' | 'recorded-evidence' | null } | null;
}> {
  return guarded('IssuanceRecordRefused', () => {
    const v = object(input, ['issuanceId', 'manifest', 'manifestSha256', 'environment', 'events']);
    string(v.issuanceId); const environment = choice(v.environment, ['operational', 'synthetic-test']);
    if (sha256(v.manifestSha256) !== digest(v.manifest)) refuse('IssuanceManifestMismatch');
    if (environment !== v.manifest.environment) refuse('IssuanceEnvironmentMismatch');
    if (!Array.isArray(v.events) || !v.events.length) throw new Error('History required');
    const method = v.manifest.delivery.method;
    let state: IssuanceState | null = null, artifact: string | null = null, delivery = null, previousAt = '';
    for (const e of v.events) {
      const at = utc(e?.at);
      if (at < previousAt) refuse('IssuanceTransitionRefused');
      previousAt = at;
      switch (choice(e.kind, ['prepared', 'client-observation', 'issued', 'delivery', 'closed', 'aborted'])) {
        case 'prepared':
          object(e, ['kind', 'at', 'by', 'manifestSha256']); identity(e.by);
          if (state !== null || e.manifestSha256 !== v.manifestSha256) refuse('IssuanceTransitionRefused');
          state = 'Prepared';
          break;
        case 'client-observation':
          object(e, ['kind', 'at', 'observation', 'eventId']); string(e.eventId);
          choice(e.observation, ['print-opened', 'print-done', 'pdf-reported', 'copy-reported']);
          // A print window, a print-done report or a client PDF proves neither issued bytes nor a handover (A exports invariant).
          if (state === null || TERMINAL.includes(state)) refuse('IssuanceTransitionRefused');
          break;
        case 'issued': {
          object(e, ['kind', 'at', 'by', 'artifact', 'method']); identity(e.by);
          const a = object(e.artifact, ['sha256', 'byteLength', 'format', 'generator', 'manifestSha256']);
          if (state !== 'Prepared') refuse('IssuanceTransitionRefused');
          if (a.generator !== 'server' || a.manifestSha256 !== v.manifestSha256 || a.format !== v.manifest.delivery.format ||
              e.method !== method) refuse('IssuedArtifactRequired');
          sha256(a.sha256); integer(a.byteLength, 1);
          artifact = a.sha256; state = 'Issued';
          break;
        }
        case 'delivery': {
          object(e, ['kind', 'at', 'by', 'outcome', 'evidence', 'detection', 'note']); identity(e.by);
          if (!['Issued', 'ReceiptUnknown', 'DeliveryFailed'].includes(state)) refuse('IssuedRequired');
          const outcome = choice(e.outcome, ['delivered', 'failed', 'unknown']);
          if (outcome === 'unknown') {
            if (e.evidence !== null || e.detection !== null || typeof e.note !== 'string' || !e.note.trim()) refuse('DeliveryEvidenceRequired');
            state = 'ReceiptUnknown';
          } else {
            const table = outcome === 'delivered' ? DELIVERED_EVIDENCE : FAILED_EVIDENCE;
            const x = guarded('DeliveryEvidenceRequired', () => object(e.evidence, ['kind', 'evidenceId']));
            if (!Object.prototype.hasOwnProperty.call(table, x.kind) || !table[x.kind].includes(method) || typeof x.evidenceId !== 'string' || !x.evidenceId.trim())
              refuse('DeliveryEvidenceRequired');
            // A paper handover outside the product is the staff member's attestation; nothing here detects it.
            if (e.detection !== (x.kind === 'staff-attested-handover' ? 'staff-attested' : 'recorded-evidence')) refuse('DeliveryEvidenceRequired');
            state = outcome === 'delivered' ? 'Delivered' : 'DeliveryFailed';
          }
          delivery = { outcome, detection: e.detection };
          break;
        }
        case 'closed':
          object(e, ['kind', 'at', 'by', 'reason']); identity(e.by);
          if (!['Delivered', 'ReceiptUnknown', 'DeliveryFailed'].includes(state)) refuse('IssuanceTransitionRefused');
          if (state !== 'Delivered' && (typeof e.reason !== 'string' || !e.reason.trim())) refuse('ClosingReasonRequired');
          state = 'Closed';
          break;
        case 'aborted':
          object(e, ['kind', 'at', 'by', 'reason']); identity(e.by);
          if (state !== 'Prepared') refuse('IssuanceTransitionRefused');
          string(e.reason);
          state = 'Aborted';
          break;
      }
    }
    return freeze({ state, environment, issuedArtifactSha256: artifact, delivery });
  });
}
function appended(issuance: Issuance, event: Record<string, unknown>): Readonly<Issuance> {
  const next = { ...issuance, events: [...issuance.events, event] };
  issuanceState(next);
  return freeze(next);
}
function ownIssuance(authority: AuditAuthority, issuance: Issuance): Issuance {
  requireScope(authority, 'disclosure');
  issuanceState(issuance);
  if (issuance.manifest.institutionId !== authority.institutionId) refuse('AuditScopeNotGranted');
  return issuance;
}
/** Issued = the server generated these bytes from this manifest and a designated issuer released them for delivery. A
 * record whose head moved since preparation is refused: re-prepare so the copy is the record as it now stands. */
export function issueDisclosure(authority: AuditAuthority, issuance: Issuance, input: {
  artifact: { sha256: string; byteLength: number; format: CopyFormat; generator: 'server'; manifestSha256: string };
  listings: readonly unknown[]; at: string;
}): Readonly<Issuance> {
  ownIssuance(authority, issuance);
  if (!Array.isArray(input?.listings)) refuse('VersionListingRefused');
  const now = input.listings.map(verifiedListing);
  if (now.length !== issuance.manifest.records.length || new Set(now.map(l => l.recordId)).size !== now.length)
    refuse('VersionListingRefused');
  for (const record of issuance.manifest.records) {
    const l = now.find(x => x.recordId === record.recordId), head = l?.versions[l.versions.length - 1];
    if (l && (l.subject.managingInstitutionId !== authority.institutionId ||
        !samePatient(l.subject.patient, issuance.manifest.patient) || l.subject.studyId !== record.studyId)) refuse('DisclosureSubjectMismatch');
    if (!l || l.revision !== record.revision || head.versionId !== record.head.versionId || head.sha256 !== record.head.sha256) refuse('RecordHeadChanged');
    const currentVersions = record.selection === 'all-versions' ? l.versions : record.versions.map(v => l.versions.find(x => x.versionId === v.versionId));
    if (currentVersions.length !== record.versions.length || currentVersions.some((v, i) => !v || digest(v) !== digest(record.versions[i])))
      refuse('DisclosurePackageChanged');
  }
  return appended(issuance, { kind: 'issued', at: input.at, by: authority.subject, artifact: input.artifact, method: issuance.manifest.delivery.method });
}
export function recordDelivery(authority: AuditAuthority, issuance: Issuance, input: {
  outcome: 'delivered' | 'failed' | 'unknown'; evidence: { kind: string; evidenceId: string } | null; note: string | null; at: string;
}): Readonly<Issuance> {
  ownIssuance(authority, issuance);
  const detection = input?.outcome === 'unknown' ? null : input?.evidence?.kind === 'staff-attested-handover' ? 'staff-attested' : 'recorded-evidence';
  return appended(issuance, { kind: 'delivery', at: input?.at, by: authority.subject, outcome: input?.outcome, evidence: input?.evidence ?? null,
    detection, note: input?.note ?? null });
}
/** The ledger's client report (print window, print done, PDF or copy) is kept beside the issuance and changes nothing. */
export function recordClientObservation(issuance: Issuance, input: { observation: 'print-opened' | 'print-done' | 'pdf-reported' | 'copy-reported'; eventId: string; at: string }): Readonly<Issuance> {
  return appended(issuance, { kind: 'client-observation', at: input?.at, observation: input?.observation, eventId: input?.eventId });
}
export function closeIssuance(authority: AuditAuthority, issuance: Issuance, input: { reason: string | null; at: string }): Readonly<Issuance> {
  ownIssuance(authority, issuance);
  return appended(issuance, { kind: 'closed', at: input?.at, by: authority.subject, reason: input?.reason ?? null });
}
export function abortIssuance(authority: AuditAuthority, issuance: Issuance, input: { reason: string; at: string }): Readonly<Issuance> {
  ownIssuance(authority, issuance);
  return appended(issuance, { kind: 'aborted', at: input?.at, by: authority.subject, reason: input?.reason });
}
/** Synthetic-recipient tests and real issuances are counted apart; a synthetic delivery is never operational evidence. */
export function issuanceSummary(issuances: readonly Issuance[]): Readonly<Record<Environment, Readonly<Record<IssuanceState, number>>>> {
  const empty = (): Record<IssuanceState, number> => ({ Prepared: 0, Issued: 0, Delivered: 0, ReceiptUnknown: 0, DeliveryFailed: 0, Closed: 0, Aborted: 0 });
  const summary = { operational: empty(), 'synthetic-test': empty() };
  for (const issuance of issuances) { const s = issuanceState(issuance); summary[s.environment][s.state]++; }
  return freeze(summary);
}
/** The disclosure access event (A surface 'authorized-disclosure', action 'disclosure'): one target per version handed out. */
export function disclosureLedgerTargets(issuance: Issuance): readonly AccessTarget[] {
  issuanceState(issuance);
  const m = issuance.manifest;
  return freeze(m.records.flatMap(r => r.versions.map(v => ({ kind: 'disclosure' as const,
    patientLinkSnapshot: { status: 'known' as const, value: m.patient }, studyId: { status: 'known' as const, value: r.studyId },
    recordId: { status: 'known' as const, value: r.recordId }, versionId: { status: 'known' as const, value: v.versionId } }))));
}

// ---------------------------------------------------------------------------------------------------------------------
// Correction, deletion and processing-suspension requests (legal register LR-18, delta D-7; 개인정보 보호법 제36조·제37조,
// 시행령 제43조③·제44조②). The 의료법 copy procedure above does not replace them.

export type RightsRequestKind = 'correction' | 'deletion' | 'processing-suspension';
export type RightsOutcome = 'correct-by-new-signed-version' | 'correct' | 'append-correction-note' | 'refused-retained-by-law' |
  'delete-irreversibly' | 'refused-legal-duty' | 'suspend-processing';
/** One requested record as the server resolved it, with the subject facts B/C hold for it. */
export interface RightsRecord { record: ResolvedRecord; subject: { patient: PatientLinkSnapshot; managingInstitutionId: string } }
export interface RightsDecision {
  status: 'planned';
  requestId: string; kind: RightsRequestKind; receivedAt: string; decidedBy: ImmutableIdentity; decidedAt: string;
  records: readonly { recordId: string; disposition: ReturnType<typeof retentionDisposition>; outcome: RightsOutcome; basis: readonly string[] }[];
  notice: { content: 'action-result-required' | 'refusal-with-reason-and-objection-method'; dueBy: string };
}
const KEPT_BY_LAW: Readonly<Record<string, readonly string[]>> = freeze({
  statutory: ['medical:22.2', 'medical-rules:15.1'], 'source-record': ['medical:22.2', 'source-record-follows-original'],
  'access-event': ['medical:23.4', 'access-safety:8.1'],
});
/**
 * Per record, from A's classification of the stored record. A record the law requires to be kept is neither deleted nor
 * suspended on request (제36조① 단서, 제37조②1); the person is told the fact, the reason and how to object. A clinical
 * record is corrected by a new signed version that keeps the original (의료법 제22조②③); an access event is never edited.
 * The notice is due within ten days of receipt, counted with the receipt day as the first day (the earlier reading).
 */
export function decideRightsRequest(authority: AuditAuthority, input: unknown, records: readonly RightsRecord[], at: string): Readonly<RightsDecision> {
  requireScope(authority, 'disclosure');
  const r = guarded('RightsRequestRefused', () => {
    const v = object(input, ['requestId', 'receivedAt', 'kind', 'patient', 'recordIds', 'statement']);
    return { requestId: string(v.requestId), receivedAt: utc(v.receivedAt), kind: choice(v.kind, ['correction', 'deletion', 'processing-suspension']),
      patient: patientLink(v.patient), recordIds: uniqueStrings(v.recordIds), statement: string(v.statement), at: utc(at) };
  });
  if (r.at < r.receivedAt || !Array.isArray(records) || records.length !== r.recordIds.length) refuse('RightsRequestRefused');
  const decided = r.recordIds.map(id => {
    const item = records.find(x => x?.record?.recordId === id);
    if (!item) refuse('RightsRequestRefused');
    const subject = guarded('RightsRequestRefused', () => object(item.subject, ['patient', 'managingInstitutionId']));
    if (!guarded('RightsRequestRefused', () => samePatient(patientLink(subject.patient), r.patient)) || subject.managingInstitutionId !== authority.institutionId)
      refuse('DisclosureSubjectMismatch');
    const disposition = retentionDisposition(verifiedRecord(item.record));
    const kept = disposition !== 'purpose';
    const outcome: RightsOutcome = r.kind === 'deletion' ? (kept ? 'refused-retained-by-law' : 'delete-irreversibly') :
      r.kind === 'processing-suspension' ? (kept ? 'refused-legal-duty' : 'suspend-processing') :
      disposition === 'access-event' ? 'append-correction-note' : kept ? 'correct-by-new-signed-version' : 'correct';
    const basis = outcome === 'refused-retained-by-law' ? ['privacy:36.1-proviso', ...KEPT_BY_LAW[disposition]] :
      outcome === 'refused-legal-duty' ? ['privacy:37.2.1', ...KEPT_BY_LAW[disposition]] :
      outcome === 'delete-irreversibly' ? ['privacy:36.3'] : outcome === 'correct-by-new-signed-version' ? ['medical:22.2', 'medical:22.3'] : [];
    return { recordId: id, disposition, outcome, basis };
  });
  const [year, month, day] = seoulDay(r.receivedAt).split('-').map(Number);
  const dueBy = new Date(Date.UTC(year, month - 1, day + 10) - KST_OFFSET_MS).toISOString();
  const refusedAny = decided.some(d => d.outcome === 'refused-retained-by-law' || d.outcome === 'refused-legal-duty');
  return freeze({ status: 'planned' as const, requestId: r.requestId, kind: r.kind, receivedAt: r.receivedAt, decidedBy: authority.subject, decidedAt: r.at, records: decided,
    notice: { content: refusedAny ? 'refusal-with-reason-and-objection-method' : 'action-result-required', dueBy } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Monthly inspection and follow-up (REQ-EMR-15·19, RISK-F-05; 안전성 기준 제8조②, legal register LR-13, delta D-9)

/** Every Seoul calendar month is inspected, before and after the 2026-11-01 wording change of 제8조② (legal register LR-44,
 * D-9: the stricter monthly default stays; there is no setting that lengthens it). */
export const INSPECTION_PERIOD = freeze({ unit: 'calendar-month', timeZone: 'Asia/Seoul' });
/** Downloads whose reason the inspection must confirm (file outputs and copies handed out). */
export const DOWNLOAD_ACTIONS = freeze(['download', 'pdf', 'copy', 'disclosure'] as const);
export interface InspectionCycle { cycleId: string; institutionId: string; month: string; events: readonly unknown[] }
export type InspectionState = 'awaiting-report' | 'report-only' | 'in-follow-up' | 'ready-to-close' | 'closed';

export function inspectionMonth(at: string): string { return seoulMonth(utc(at)); }
/** The ended months from `first` up to the month before `at`, each owing one inspection. */
export function inspectionMonthsDue(first: string, at: string): readonly string[] {
  const end = inspectionMonth(at), months: string[] = [];
  for (let m = guarded('InspectionCycleRefused', () => monthKey(first)); m < end; m = followingMonth(m)) months.push(m);
  return freeze(months);
}
export function newInspectionCycle(institutionId: string, month: string): Readonly<InspectionCycle> {
  return guarded('InspectionCycleRefused', () => freeze({ cycleId: `inspection:${randomUUID()}`, institutionId: string(institutionId), month: monthKey(month), events: [] }));
}
function parseInspectionEvent(e: any): any {
  const kind = choice(e?.kind, ['report-generated', 'reviewed', 'download-reason', 'investigation-opened', 'action-recorded', 'rechecked', 'closed']);
  const keys = {
    'report-generated': ['generator', 'reportSha256', 'eventCount', 'downloadEventIds'], reviewed: ['by', 'conclusion', 'note'],
    'download-reason': ['by', 'eventId', 'reason', 'outcome'], 'investigation-opened': ['by', 'investigationId', 'eventIds', 'summary'],
    'action-recorded': ['by', 'investigationId', 'action'], rechecked: ['by', 'investigationId', 'result', 'note'], closed: ['by'],
  }[kind];
  const finding = (kind === 'reviewed' && e.conclusion === 'anomaly-found') ||
    (kind === 'download-reason' && e.outcome === 'investigate');
  const v = object(e, ['kind', 'at', ...keys, ...(finding ? ['investigationId'] : [])]); utc(v.at);
  if (finding) string(v.investigationId);
  if (kind === 'report-generated') {
    if (v.generator !== 'system') throw new Error('Reports are generated by the system');
    sha256(v.reportSha256); integer(v.eventCount); uniqueStrings(v.downloadEventIds, true);
  } else identity(v.by);
  if (kind === 'reviewed') choice(v.conclusion, ['no-anomaly', 'anomaly-found']);
  if (kind === 'download-reason') { string(v.eventId); string(v.reason); choice(v.outcome, ['legitimate', 'investigate']); }
  if (kind === 'investigation-opened') { string(v.investigationId); uniqueStrings(v.eventIds, true); string(v.summary); }
  if (kind === 'action-recorded') { string(v.investigationId); string(v.action); }
  if (kind === 'rechecked') { string(v.investigationId); choice(v.result, ['resolved', 'not-resolved']); string(v.note); }
  return v;
}
/** What the month still owes. An automatically generated report is not an inspection; a designated person reviews it. */
export function inspectionStatus(input: unknown): Readonly<{
  state: InspectionState; missingDownloadReasons: readonly string[]; uninvestigated: readonly string[]; openInvestigations: readonly string[];
}> {
  return guarded('InspectionCycleRefused', () => {
    const c = object(input, ['cycleId', 'institutionId', 'month', 'events']); string(c.cycleId); string(c.institutionId); monthKey(c.month);
    if (!Array.isArray(c.events)) throw new Error('History required');
    const all = c.events.map(parseInspectionEvent);
    if (all.some((e, i) => i && e.at < all[i - 1].at)) throw new Error('History out of order');
    const closings = all.filter(e => e.kind === 'closed').length;
    if (closings > 1 || (closings && all[all.length - 1].kind !== 'closed')) throw new Error('Nothing follows the closing');
    // The closing itself is judged against everything before it, also when a stored cycle is reloaded.
    const events = closings ? all.slice(0, -1) : all;
    const reports = events.filter(e => e.kind === 'report-generated');
    if (reports.length > 1 || (events.length && events[0].kind !== 'report-generated')) throw new Error('One report starts the month');
    const report = reports[0] ?? null;
    const review = events.filter(e => e.kind === 'reviewed').pop() ?? null;
    const reasons = new Map(events.filter(e => e.kind === 'download-reason').map(e => [e.eventId, e]));
    const investigations = new Map(events.filter(e => e.kind === 'investigation-opened').map(e => [e.investigationId, e]));
    if (investigations.size !== events.filter(e => e.kind === 'investigation-opened').length) throw new Error('Repeated investigation');
    const findings = events.filter(e => (e.kind === 'reviewed' && e.conclusion === 'anomaly-found') ||
      (e.kind === 'download-reason' && e.outcome === 'investigate'));
    for (const e of events) {
      if ((e.kind === 'action-recorded' || e.kind === 'rechecked' || findings.includes(e)) &&
          (!investigations.has(e.investigationId) || events.indexOf(investigations.get(e.investigationId)) >= events.indexOf(e)))
        throw new Error('Investigation must precede its follow-up');
      if (e.kind === 'download-reason' && !report.downloadEventIds.includes(e.eventId)) throw new Error('Not a download of this month');
      if (findings.includes(e)) {
        const prior = events.slice(0, events.indexOf(e)).filter(p => p.investigationId === e.investigationId);
        const action = prior.filter(p => p.kind === 'action-recorded').pop();
        const recheck = prior.filter(p => p.kind === 'rechecked').pop();
        const finding = prior.filter(p => findings.includes(p)).pop();
        if (action && recheck?.result === 'resolved' && prior.indexOf(recheck) > prior.indexOf(action) &&
            (!finding || prior.indexOf(action) > prior.indexOf(finding))) throw new Error('Resolved investigation cannot absorb a new finding');
      }
    }
    const missingDownloadReasons = report ? report.downloadEventIds.filter(id => !reasons.has(id)) : [];
    const uninvestigated = findings.filter(f => !events.some(e => e.kind === 'action-recorded' &&
      e.investigationId === f.investigationId && events.indexOf(e) > events.indexOf(f)))
      .filter(f => f.kind === 'download-reason').map(f => f.eventId);
    const openInvestigations = [...investigations.keys()].filter(id => {
      const action = events.filter(e => e.kind === 'action-recorded' && e.investigationId === id).pop();
      const recheck = events.filter(e => e.kind === 'rechecked' && e.investigationId === id).pop();
      const latestFinding = findings.filter(e => e.investigationId === id).pop();
      if (latestFinding && (!action || events.indexOf(action) <= events.indexOf(latestFinding))) return true;
      // A new action invalidates an older recheck, including steps sharing the same clock tick.
      return !action || recheck?.result !== 'resolved' || events.indexOf(recheck) <= events.indexOf(action);
    });
    const open: InspectionState = !report ? 'awaiting-report' : !review ? 'report-only' :
      missingDownloadReasons.length || uninvestigated.length || openInvestigations.length ? 'in-follow-up' : 'ready-to-close';
    if (closings && open !== 'ready-to-close') refuse(open === 'report-only' ? 'HumanReviewRequired' : 'InspectionFollowUpOpen');
    return freeze({ state: closings ? 'closed' as const : open, missingDownloadReasons, uninvestigated, openInvestigations });
  });
}
/** The system records the month's generated report once the month has ended. */
export function recordInspectionReport(cycle: InspectionCycle, report: { reportSha256: string; eventCount: number; downloadEventIds: readonly string[] },
  at: string): Readonly<InspectionCycle> {
  const status = inspectionStatus(cycle);
  if (status.state !== 'awaiting-report') refuse('InspectionReportExists');
  if (guarded('InspectionCycleRefused', () => utc(at)) < monthStart(followingMonth(cycle.month))) refuse('InspectionMonthNotEnded');
  const next = { ...cycle, events: [...cycle.events, { kind: 'report-generated', at, generator: 'system', reportSha256: report?.reportSha256,
    eventCount: report?.eventCount, downloadEventIds: report?.downloadEventIds }] };
  inspectionStatus(next);
  return freeze(next);
}
/** A designated person's step (review, download reason, investigation, action, recheck, closing). The actor is the
 * authority, never a field of the input. */
export function recordInspectionStep(authority: AuditAuthority, cycle: InspectionCycle, step: Record<string, unknown>): Readonly<InspectionCycle> {
  requireScope(authority, 'inspection');
  if (cycle?.institutionId !== authority.institutionId) refuse('AuditScopeNotGranted');
  const before = inspectionStatus(cycle);
  if (before.state === 'closed') refuse('InspectionClosed');
  guarded('InspectionStepRefused', () => object(step, Object.keys(step ?? {})));
  if (step?.kind === 'report-generated' || (step && Object.prototype.hasOwnProperty.call(step, 'by'))) refuse('InspectionStepRefused');
  if (before.state === 'awaiting-report') refuse('InspectionReportRequired');
  const events = [...cycle.events];
  let recorded: Record<string, unknown> = { ...step, by: authority.subject };
  if ((step.kind === 'reviewed' && step.conclusion === 'anomaly-found') ||
      (step.kind === 'download-reason' && step.outcome === 'investigate')) {
    // Only an explicitly named open investigation may absorb a finding. Resolved/unknown/unnamed creates a new one.
    const named = step.investigationId;
    if (named !== undefined) guarded('InspectionStepRefused', () => string(named));
    const investigationId = typeof named === 'string' && before.openInvestigations.includes(named)
      ? named : `investigation:${randomUUID()}`;
    if (investigationId !== named) events.push({ kind: 'investigation-opened', at: step.at, by: authority.subject,
      investigationId, eventIds: step.kind === 'download-reason' ? [step.eventId] : [], summary: step.note ?? step.reason });
    recorded = { ...recorded, investigationId };
  }
  const next = { ...cycle, events: [...events, recorded] };
  try { inspectionStatus(next); } catch (error) {
    if (error instanceof ContractError && error.code === 'InspectionCycleRefused') refuse('InspectionStepRefused');
    throw error;
  }
  return freeze(next);
}

// ---------------------------------------------------------------------------------------------------------------------
// Request deadline extension and the request hold (REQ-EMR-17, RISK-F-06; A ledger L5-06)

/** The adapter (B/I in round 2) verifies the lawful ground and length of each extension; this contract never invents a
 * statutory period. Extensions are appended, never rewritten. */
export interface DeadlineExtension {
  extensionId: string; at: string; previousDueAt: string; dueAt: string; basis: { clauseId: string; version: string }; actorId: string; evidenceId: string;
}
export interface RequestDeadlineFacts {
  requestId: string; recordIds: readonly string[]; receivedAt: string; initialDueAt: string; extensions: readonly DeadlineExtension[];
  resolution: { eventId: string; at: string; outcome: 'fulfilled' | 'withdrawn' | 'lawfully-refused' } | null;
}
function parseDeadline(input: unknown): Readonly<RequestDeadlineFacts> {
  return guarded('RequestDeadlineRefused', () => {
    const v = object(input, ['requestId', 'recordIds', 'receivedAt', 'initialDueAt', 'extensions', 'resolution']);
    const receivedAt = utc(v.receivedAt), initialDueAt = utc(v.initialDueAt);
    if (initialDueAt <= receivedAt || !Array.isArray(v.extensions)) throw new Error('Due after receipt required');
    let due = initialDueAt;
    const extensions = v.extensions.map(input => {
      const e = object(input, ['extensionId', 'at', 'previousDueAt', 'dueAt', 'basis', 'actorId', 'evidenceId']);
      const b = object(e.basis, ['clauseId', 'version']);
      // A due date is always finite: a lapsed or removed due is never turned into a permanent hold.
      const ext = { extensionId: string(e.extensionId), at: utc(e.at), previousDueAt: utc(e.previousDueAt), dueAt: utc(e.dueAt),
        basis: { clauseId: string(b.clauseId), version: string(b.version) }, actorId: string(e.actorId), evidenceId: string(e.evidenceId) };
      if (ext.previousDueAt !== due || ext.at < receivedAt || ext.at >= due || ext.dueAt <= due) refuse('DeadlineExtensionRefused');
      due = ext.dueAt;
      return ext;
    });
    if (new Set(extensions.map(e => e.extensionId)).size !== extensions.length || extensions.some((e, i) => i && e.at < extensions[i - 1].at))
      refuse('DeadlineExtensionRefused');
    let resolution = null;
    if (v.resolution !== null) {
      const r = object(v.resolution, ['eventId', 'at', 'outcome']);
      resolution = { eventId: string(r.eventId), at: utc(r.at), outcome: choice(r.outcome, ['fulfilled', 'withdrawn', 'lawfully-refused']) };
      if (resolution.at < receivedAt || extensions.some(e => e.at > resolution.at)) throw new Error('Resolution before request history');
    }
    return freeze({ requestId: string(v.requestId), recordIds: uniqueStrings(v.recordIds), receivedAt, initialDueAt, extensions, resolution });
  });
}
export function effectiveDue(input: unknown): string {
  const facts = parseDeadline(input);
  return facts.extensions.length ? facts.extensions[facts.extensions.length - 1].dueAt : facts.initialDueAt;
}
function requestHold(input: unknown, facts: RequestDeadlineFacts): Readonly<LegalHold> {
  const hold = guarded('RequestHoldRefused', () => {
    const h = object(input, ['holdId', 'recordId', 'basis', 'actorId', 'at', 'release']);
    string(h.holdId); string(h.recordId); string(h.actorId); utc(h.at);
    choice(h.basis?.type, ['pending-access-request', 'statutory-duty']);
    const b = h.basis;
    string(b.managingInstitutionId);
    if (b.verified !== true || b.authorityId !== b.managingInstitutionId || b.authorityKind !== 'personal-information-controller' ||
        !uniqueStrings(b.scope).includes(h.recordId)) throw new Error('Verified request scope required');
    object(b.validity, ['from', 'until', 'condition']); utc(b.validity.until); utc(b.validity.from);
    if (b.validity.from > h.at || h.at < facts.receivedAt || b.validity.until <= h.at ||
        b.validity.condition !== (b.type === 'pending-access-request' ? 'request-pending' : 'duty-active')) throw new Error('Invalid hold validity');
    return h as LegalHold;
  });
  if (hold.basis.requestId !== facts.requestId || !facts.recordIds.includes(hold.recordId)) refuse('HoldRequestBindingRefused');
  return hold;
}
/** One decision for one lock/transaction (B/A in round 2): the request's new due and the hold's validity move together;
 * the hold's earlier validity is returned as history to append, never overwritten in place. */
export function extendRequestHold(factsInput: unknown, holdInput: unknown, extension: unknown): Readonly<{
  facts: RequestDeadlineFacts; hold: LegalHold; superseded: { holdId: string; until: string; supersededBy: string };
}> {
  const facts = parseDeadline(factsInput), hold = requestHold(holdInput, facts);
  if (facts.resolution !== null) refuse('RequestAlreadyResolved');
  if (hold.release !== null) refuse('HoldAlreadyReleased');
  if (hold.basis.validity.until !== effectiveDue(facts)) refuse('HoldValidityOutOfSync');
  const next = parseDeadline({ ...facts, extensions: [...facts.extensions, extension] });
  const added = next.extensions[next.extensions.length - 1];
  const extended = structuredClone(hold) as LegalHold;
  extended.basis.validity.until = added.dueAt;
  return freeze({ facts: next, hold: extended, superseded: { holdId: hold.holdId, until: hold.basis.validity.until, supersededBy: added.extensionId } });
}
/** Whether the request hold still stops destruction. An unresolved request keeps it, however late its due; a resolved
 * request keeps it until its release is recorded; a hold out of step with the request is preserved and reported. */
export function requestHoldState(factsInput: unknown, holdInput: unknown, at: string): Readonly<{
  preserve: boolean; state: 'pending' | 'pending-overdue' | 'release-required' | 'hold-out-of-sync' | 'released'; dueAt: string;
}> {
  const facts = parseDeadline(factsInput), hold = requestHold(holdInput, facts);
  guarded('RequestDeadlineRefused', () => utc(at));
  const due = effectiveDue(facts);
  if (hold.release !== null) {
    const release = guarded('HoldReleaseBindingRefused', () => {
      const r = object(hold.release, ['holdId', 'actorId', 'at', 'evidenceId', 'authorityVerified', 'reason',
        ...(hold.release.reason === 'effect-ended' ? ['endingFact'] : [])]);
      string(r.actorId); utc(r.at);
      const end = facts.resolution;
      if (!end || r.holdId !== hold.holdId || r.authorityVerified !== true || r.evidenceId !== end.eventId ||
          r.at < end.at || r.at < hold.at) refuse('HoldReleaseBindingRefused');
      if (r.reason === 'effect-ended') {
        const f = object(r.endingFact, ['kind', 'at', 'eventId']);
        if (f.kind !== 'request-resolved' || f.at !== end.at || f.eventId !== end.eventId) refuse('HoldReleaseBindingRefused');
      } else if (r.reason !== ({ fulfilled: hold.basis.type === 'statutory-duty' ? 'duty-ended' : 'request-fulfilled',
        withdrawn: 'request-withdrawn', 'lawfully-refused': 'request-refused' })[end.outcome]) refuse('HoldReleaseBindingRefused');
      return r;
    });
    if (release.at <= at) return freeze({ preserve: false, state: 'released', dueAt: due });
  }
  if (hold.basis.validity.until !== due) return freeze({ preserve: true, state: 'hold-out-of-sync', dueAt: due });
  if (facts.resolution !== null && facts.resolution.at <= at) return freeze({ preserve: true, state: 'release-required', dueAt: due });
  if (at >= due) return freeze({ preserve: true, state: 'pending-overdue', dueAt: due });
  return freeze({ preserve: true, state: 'pending', dueAt: due });
}
/** The A-shaped release of a request hold, bound to the same request's verified resolution. The passing of any until
 * (original or extended) never ends a request hold. */
export function planRequestHoldRelease(authority: AuditAuthority, factsInput: unknown, holdInput: unknown,
  proposal: { reason: string; evidenceId: string; endingFact?: unknown }, at: string): Readonly<LegalHold['release']> {
  requireScope(authority, 'disclosure');
  const facts = parseDeadline(factsInput), hold = requestHold(holdInput, facts);
  guarded('RequestDeadlineRefused', () => utc(at));
  if (hold.basis.managingInstitutionId !== authority.institutionId) refuse('AuditScopeNotGranted');
  if (hold.release !== null) refuse('HoldAlreadyReleased');
  const end = facts.resolution;
  if (end === null || end.at > at) refuse('PendingRequestHoldCannotEnd');
  const p = guarded('HoldReleaseBindingRefused', () => object(proposal, ['reason', 'evidenceId', ...(proposal?.endingFact !== undefined ? ['endingFact'] : [])]));
  const expected = { fulfilled: hold.basis.type === 'statutory-duty' ? 'duty-ended' : 'request-fulfilled', withdrawn: 'request-withdrawn',
    'lawfully-refused': 'request-refused' }[end.outcome];
  if (p.evidenceId !== end.eventId) refuse('HoldReleaseBindingRefused');
  if (p.reason === 'effect-ended') {
    const f = guarded('HoldReleaseBindingRefused', () => object(p.endingFact, p.endingFact?.kind === 'request-resolved' ? ['kind', 'at', 'eventId'] : ['kind', 'at']));
    if (f.kind !== 'request-resolved') refuse('RequestHoldNeedsResolution');
    if (f.at !== end.at || f.eventId !== end.eventId) refuse('HoldReleaseBindingRefused');
    return freeze({ holdId: hold.holdId, actorId: authority.subject.id, at, evidenceId: end.eventId, authorityVerified: true as const,
      reason: 'effect-ended' as const, endingFact: { kind: 'request-resolved' as const, at: end.at, eventId: end.eventId } });
  }
  if (p.reason !== expected || p.endingFact !== undefined) refuse('HoldReleaseBindingRefused');
  return freeze({ holdId: hold.holdId, actorId: authority.subject.id, at, evidenceId: end.eventId, authorityVerified: true as const,
    reason: expected as 'request-fulfilled' | 'request-withdrawn' | 'request-refused' | 'duty-ended' });
}
