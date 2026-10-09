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
  medicalIncident: { occurredAt: string; discoveredAt: string; electronicIntrusion: boolean;
    type: 'theft-leak' | 'destruction-damage-concealment-loss' | 'system-disruption' } | null;
  evidenceId: string;
  verdictId?: string; supersedes?: string; possibilityEventId?: string; additionalEventId?: string;
  reportEventId?: string; reportKnownAt?: string; recipientScopeRef?: string; recordedAt?: string;
  verdictScopeRef?: string; possibilityKnownAt?: string;
  hospitalKnownAt?: string; firstDetectionEvidenceAt?: string; processorKnownAt?: string; operatorKnownAt?: string; notifiedHospitalAt?: string;
  knowledgeAttributionEvidenceId?: string; healthDataActualLeak?: boolean;
  obligationOwner?: { kind: 'hospital' | 'processor' | 'operator'; id: string };
  ispIncident?: { eventId: string; attackCaused: boolean; status: boolean | 'unknown';
    verification?: { by: ImmutableIdentity; at: string; evidenceId: string;
      types: { telecomBusiness: boolean; forProfitTelecomInformation: boolean }; nonApplicabilityBasis?: string };
    deploymentModel?: 'hosted' | 'managed' | 'on-prem';
    occurrence?: { occurredAt: string | null; endedAt: string | null; evidenceId: string;
      correction?: { supersedes: string; at: string; reason: string; evidenceId: string } };
    userNoticeDecision?: { decisionId: string; applies: boolean; at: string; reason: string; basis: string; evidenceId: string; decider: IncidentDecider };
    userImpact?: { kind: 'outage' | 'user-information' | 'comparable-serious-impact'; outageMinutes?: number;
      confirmedAt: string; recipientScopeRef: string; evidenceId: string; decider: IncidentDecider; detailsComplete?: boolean };
    additionalFacts?: readonly { eventId: string; confirmedAt: string; evidenceId: string }[] };
}
type DutyKind = 'possible-leak' | 'confirmed-leak' | 'confirmed-priority' | 'confirmed-additional' | 'not-a-leak' |
  'pipc-kisa-report' | 'pipc-kisa-priority' | 'pipc-kisa-additional' | 'mohw-notice' |
  'isp-incident-report' | 'isp-incident-report-supplement' | 'isp-user-notice' | 'isp-user-additional';
type DutyFamily = 'possibility' | 'confirmed' | 'additional-notice' | 'no-leak' | 'report' | 'additional-report' | 'medical' |
  'isp-report' | 'isp-supplement' | 'isp-user' | 'isp-user-additional';
export interface IncidentDecider {
  status: 'verified-privacy-officer' | 'representative' | 'designationUnverified';
  by: ImmutableIdentity; ownerId: string; evidenceId: string; verifiedAt: string; exemptionEvidenceId?: string;
  designation?: { categoryBasis: 'privacy-decree:32.2.1' | 'privacy-decree:32.2.2'; categoryEvidenceId: string;
    qualificationRequired: boolean; qualificationAssessmentEvidenceId: string; qualificationEvidenceId?: string };
}
export interface IncidentNoticeEvidence {
  kind: DutyKind; triggeredAt: string; noticeId: string; sentAt: string;
  institutionId?: string; incidentId?: string; triggerEventId?: string;
  /** A scope reference names an immutable recipient set, never a query hit count. A partial set cannot fulfill all. */
  recipientScopeRef?: string; coversAll?: boolean; evidenceId?: string; recordedAt?: string;
  coveredFields?: readonly string[]; channel?: 'MOHW-official' | 'MOHW-delegated' | 'PIPC' | 'KISA' | 'MSIT' | 'affected-users';
  posting?: { justCause: string; evidenceId: string; maintainedThrough: string; maintenanceEvidenceId: string };
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
  category?: 'urgent-containment' | 'force-majeure'; decider?: IncidentDecider;
  causalReview?: { evidenceId: string; reviewedAt: string; relatesToTime: string; createdAt: string; receivedAt: string; reason: string };
}
export interface IncidentDecision {
  decisionId: string; obligationKey: string; at: string; recordedAt: string; by: ImmutableIdentity;
  authorityEvidenceId: string; evidenceId: string; reason: string; basis: string;
  effect: 'timeliness-overdue' | 'final-breach' | 'report-exemption'; stillOwed: boolean;
  decider?: IncidentDecider; category?: 'risk-substantially-reduced';
}
export interface IncidentObligation {
  obligationKey: string; family: DutyFamily; triggerEventId: string; recipientScopeRef: string;
  kind: DutyKind;
  recipient: 'all-possibly-affected-subjects' | 'affected-subjects' | 'previously-notified-subjects' | 'PIPC-or-KISA' | 'MOHW' | 'MSIT-or-KISA' | 'affected-users';
  dueAt: string | null; originalDueAt: string | null;
  timing: 'without-delay-within-72-hours' | 'within-24-hours' | 'immediate' | 'deferred-until-cause-cleared';
  triggeredAt: string; discoveredAt: string | null; requiredFields: readonly string[]; basis: readonly string[];
  status: 'pending' | 'met' | 'overdue' | 'missed' | 'moot' | 'exempt' | 'unverified-pending'; stillOwed: boolean; actionRequiredNow: boolean;
  notice: { noticeId: string; sentAt: string } | null; noticeRefs: readonly string[]; causeRefs: readonly string[];
  elapsedMs: number; lateByMs: number | null; sinceDiscoveryMs: number | null; sinceClearanceMs: number | null;
  timeliness: 'requires-review' | 'delay-accepted' | 'overdue-determined' | 'final-breach';
  delayRefs: readonly string[]; decisionRefs: readonly string[]; replacedBy: string | null;
  reasonCode: 'occurrence-evidence-contradicts-decision' | null;
  verdictRefs: readonly string[]; warnings: readonly string[]; designationUnverified: boolean;
  obligationOwner: { kind: 'hospital' | 'processor' | 'operator'; id: string }; sinceHospitalKnowledgeMs: number | null;
  applicability: 'verified' | 'unverified'; audience: 'privacy-officer'; provisionalResponseDueAt: string | null;
  provisionalDeadlinePassed: boolean; closureGround: 'actual-notice' | 'posting' | 'confirmed-notice-substitution' | 'report-exemption' | 'verdict-replaced' | 'applicability-redecided' | 'occurrence-corrected' | null;
  observations: readonly { asOf: string; status: IncidentObligation['status']; noticeRefs: readonly string[] }[];
  corrections: readonly { observedAt: string; revisedAt: string; reason: 'evidence-replayed'; evidenceRefs: readonly string[] }[];
}
export interface IncidentResponsePlan {
  incidentId: string; institutionId: string; recordedBy: ImmutableIdentity; subjectsIdentifiable: boolean;
  awarenessAt: string; verdict: IncidentResponseFacts['status']; determinationAt: string; asOf: string;
  hasNotifiedPossible: boolean;
  obligationOwner: { kind: 'hospital' | 'processor' | 'operator'; id: string };
  ispAssessments: readonly { eventId: string; knowledgeAt: string; initialReport: {
    dueAt: string | null; dueRule: string; displayedBasis: string; taskPolicy: 'display-only' | 'track'; automaticExemption: false;
    applicability: 'verified' | 'unverified' | 'not-applicable'; provisionalResponseDueAt: string | null };
    userNotice: { applicability: 'applicable' | 'not-applicable' | 'decision-required' | 're-decision-required'; decisionRefs: readonly string[];
      occurrenceEvidenceRefs: readonly string[]; effectiveOccurrenceEvidenceRefs: readonly string[];
      reasonCode: 'occurrence-evidence-contradicts-decision' | null; reason: string | null } }[];
  recipientScopes: readonly { scopeRef: string; recipientIds: readonly string[] }[];
  ledger: { findings: readonly BoundFinding[]; notices: readonly BoundNotice[]; delays: readonly IncidentDelay[]; decisions: readonly IncidentDecision[] };
  obligations: readonly IncidentObligation[]; status: 'planned';
}
export interface IncidentResponseHistory {
  previous?: Readonly<IncidentResponsePlan>; notices?: readonly IncidentNoticeEvidence[]; asOf?: string;
  findings?: readonly IncidentResponseFacts[]; delays?: readonly IncidentDelay[]; decisions?: readonly IncidentDecision[];
  recipientScopes?: readonly { scopeRef: string; recipientIds: readonly string[] }[];
}
const incidentResponses = new WeakSet<object>();
const LEAK_NOTICE_FIELDS = freeze(['data-items', 'occurrence-and-circumstances', 'subject-protective-actions',
  'controller-response-and-remedies', 'contact-department', 'legal-rights-and-exercise']);
const DUTY_FAMILY: Readonly<Record<DutyKind, DutyFamily>> = freeze({
  'possible-leak': 'possibility', 'confirmed-leak': 'confirmed', 'confirmed-priority': 'confirmed',
  'confirmed-additional': 'additional-notice', 'not-a-leak': 'no-leak', 'pipc-kisa-report': 'report',
  'pipc-kisa-priority': 'report', 'pipc-kisa-additional': 'additional-report', 'mohw-notice': 'medical',
  'isp-incident-report': 'isp-report', 'isp-incident-report-supplement': 'isp-supplement',
  'isp-user-notice': 'isp-user', 'isp-user-additional': 'isp-user-additional',
});
// D-25 v5 (LQ-01 unchanged from v3): no numeric deadline for "immediate"; elapsed time is not a legal verdict.
const IMMEDIATE_TIMING_RULE = freeze({ dueAt: null as string | null, status: 'pending' as const, timeliness: 'requires-review' as const,
  ispHours: 24, ispReportFields: ['incident-time-cause-damage', 'response-status', 'contact-department'],
  ispUserFields: ['incident-time-and-circumstances', 'user-damage', 'provider-response', 'user-protective-actions', 'contact-department'] });
// D-25 v5 (LQ-02 unchanged from v3): each exception belongs to its own provision; a documented acceptance preserves the original clock and
// clearance requires immediate action. A pending claim never disables the statutory clock.
const DELAY_RULE = freeze({ clauses: { possibility: 'privacy-decree:39-3.1', confirmed: 'privacy-decree:39.1', report: 'privacy-decree:40.1' },
  version: '2026-09-11',
  categories: { possibility: ['force-majeure'], confirmed: ['urgent-containment', 'force-majeure'], report: ['force-majeure'] },
  decider: (d: IncidentDecider | undefined, ownerId: string) => !!d && d.ownerId === ownerId &&
    (d.status === 'verified-privacy-officer' || (d.status === 'representative' && !!d.exemptionEvidenceId)),
  clearedDueAt: (_at: string): string | null => null });
// D-25 v5 LQ-03: only a pre-deadline no-leak finding moots an unnotified numeric duty. A final breach still owes performance.
const NO_LEAK_CLOSURE_RULE = freeze({ canMoot: (at: string, due: string | null) => due !== null && at < due, finalBreachStillOwed: true,
  postingFamilies: ['possibility', 'confirmed', 'additional-notice', 'no-leak', 'isp-user', 'isp-user-additional'],
  supplementDeemed: { policy: 'not-until-legal-basis-bound', kinds: [] as readonly string[] },
  deemedReportKinds: ['mohw-notice', 'pipc-kisa-report', 'pipc-kisa-priority'],
  deemedUserKinds: ['possible-leak', 'confirmed-leak', 'confirmed-priority', 'confirmed-additional'],
  postingDays: 30, reportExemptionBasis: 'privacy-decree:40.1:last-sentence' });
// D-25 v5 (LQ-04 unchanged from v2): preserve occurrence as legal cause and expose discovery time separately.
const MEDICAL_TRIGGER_RULE = freeze({ at: (incident: NonNullable<IncidentResponseFacts['medicalIncident']>) => incident.occurredAt,
  types: ['theft-leak', 'destruction-damage-concealment-loss', 'system-disruption'], channels: ['MOHW-official', 'MOHW-delegated'] });
// D-25 v5 (LQ-05 unchanged from v3): the boundary still substitutes, with the earlier limit and accepted delay retained.
const CONFIRMATION_REPLACEMENT_RULE = freeze({ within: (at: string, due: string, acceptedDelay: boolean) => at <= due || acceptedDelay,
  due: (possibleDue: string, confirmedDue: string) => possibleDue < confirmedDue ? possibleDue : confirmedDue });
// D-25 v5 (LQ-06 unchanged from v2): both actual events must exist; receipt never replaces the event time.
const NO_LEAK_FOLLOWUP_RULE = freeze({ at: (sentAt: string, confirmedAt: string) => sentAt > confirmedAt ? sentAt : confirmedAt,
  warnOnPostVerdictSend: true });
// D-25 v5 COMMON; independent owner clocks also apply to the operator's verified ISP duties.
const INCIDENT_COMMON_RULE = freeze({ possibilityEffectiveFrom: '2026-09-10T15:00:00.000Z',
  healthLeakReportTrigger: 'sensitive-or-unique' as const });
// D-25 v5 INSTALL-FACTS: I verifies the two alternative statutory types, not a deployment label.
const INSTALL_FACTS_RULE = freeze({
  ispApplies: (types: { telecomBusiness: boolean; forProfitTelecomInformation: boolean }) =>
    types.telecomBusiness || types.forProfitTelecomInformation,
  privacyOfficerQualified: (d: IncidentDecider['designation']) => !!d &&
    (!d.qualificationRequired || !!d.qualificationEvidenceId),
});
// D-25 v5 ISP-DUTIES / D25V4-N1: the numeric deadline predates its incorporation into the statute.
// This map is the reviewed emr-f-constants shape; select by original knowledge, never release or verification.
export const ISP = freeze({
  initialReport: { legalBasisByKnowledgeDate: {
    selectBy: 'hospitalKnownAt', timeZone: 'Asia/Seoul', bands: [
      { fromInclusive: null, toExclusive: '2024-08-14T00:00:00+09:00',
        dueRule: 'resolve from the law in force at hospitalKnownAt; do not assign a blanket +24h or a blanket no-deadline',
        displayedBasis: '확인된 당시 시행 법령·기한을 표시. 확인 전에는 당시 법령 확인 필요로 표시.',
        taskPolicy: 'display-only; no task creation for this historical band', automaticExemption: false },
      { fromInclusive: '2024-08-14T00:00:00+09:00', toExclusive: '2026-10-01T00:00:00+09:00',
        dueRule: 'hospitalKnownAt + PT24H (continuous elapsed hours)',
        displayedBasis: '구 정보통신망법 제48조의3제1항 전단(즉시) + 구 시행령 제58조의2제1항(알게 된 때부터 24시간 이내)',
        relatedBasis: { supplement: '구 시행령 제58조의2제2항', methods: '구 시행령 제58조의2제3항' },
        sourcePin: '대통령령 제36502호 스냅샷; 부칙 제34821호 2024-08-14 시행' },
      { fromInclusive: '2026-10-01T00:00:00+09:00', toExclusive: null,
        dueRule: 'hospitalKnownAt + PT24H (continuous elapsed hours)',
        displayedBasis: '정보통신망법 제48조의3제1항 전단(알게 된 때부터 24시간 이내) + 시행령 제58조의8제1항·제3항(신고사항·방법)',
        relatedBasis: { supplement: '시행령 제58조의8제2항', methods: '시행령 제58조의8제3항' },
        sourcePin: '법률 제21500호 2026-10-01 시행; 시행령 제36735호 스냅샷' },
    ],
    replay: { preserve: ['original hospitalKnownAt', 'applicable law at each duty event', 'actual performance fact', 'actual performance time', 'elapsed time'],
      restartAtVerification: false, restartAtRelease: false },
    userNoticeCutover: 'separate rule: occurredAt >= 2026-10-01T00:00:00+09:00; never select it using this initial-report map',
  } },
  userNoticeAppliesFrom: '2026-10-01T00:00:00+09:00',
});
function ispLawAt(at: string) {
  return ISP.initialReport.legalBasisByKnowledgeDate.bands.find(b =>
    (b.fromInclusive === null || Date.parse(at) >= Date.parse(b.fromInclusive)) &&
    (b.toExclusive === null || Date.parse(at) < Date.parse(b.toExclusive)));
}
const hours72 = (at: string) => new Date(Date.parse(at) + 72 * 3_600_000).toISOString();
const elapsed = (start: string, end: string) => Math.max(0, Date.parse(end) - Date.parse(start));
function optionalObject(input: unknown, required: readonly string[], optional: readonly string[]): Record<string, any> {
  const keys = Object.keys(input ?? {});
  return object(input, [...required, ...optional.filter(k => keys.includes(k))]);
}
function incidentDecider(input: unknown, at: string): IncidentDecider {
  const d = optionalObject(input, ['status', 'by', 'ownerId', 'evidenceId', 'verifiedAt'], ['exemptionEvidenceId', 'designation']);
  choice(d.status, ['verified-privacy-officer', 'representative', 'designationUnverified']); identity(d.by);
  string(d.ownerId); string(d.evidenceId); utc(d.verifiedAt);
  if (d.verifiedAt > at) throw new Error('Future authority verification');
  if (d.exemptionEvidenceId !== undefined) string(d.exemptionEvidenceId);
  if (d.designation) {
    const q = optionalObject(d.designation, ['categoryBasis', 'categoryEvidenceId', 'qualificationRequired', 'qualificationAssessmentEvidenceId'], ['qualificationEvidenceId']);
    choice(q.categoryBasis, ['privacy-decree:32.2.1', 'privacy-decree:32.2.2']); string(q.categoryEvidenceId); string(q.qualificationAssessmentEvidenceId);
    if (typeof q.qualificationRequired !== 'boolean') throw new Error('Qualification assessment required');
    if (q.qualificationEvidenceId !== undefined) string(q.qualificationEvidenceId);
  }
  if (d.status === 'verified-privacy-officer' && !INSTALL_FACTS_RULE.privacyOfficerQualified(d.designation)) throw new Error('Lawful designation and qualification required');
  return { ...d, by: { ...d.by } } as IncidentDecider;
}
function incidentFacts(input: unknown, scope: IncidentScope): IncidentResponseFacts {
  const v = optionalObject(input, ['incidentId', 'awarenessAt', 'determinationAt', 'status', 'possibleGround',
    'detailsComplete', 'newlyConfirmedAt', 'reportTriggers', 'medicalIncident', 'evidenceId'],
    ['priorPossibleNotice', 'verdictId', 'supersedes', 'possibilityEventId', 'additionalEventId', 'reportEventId', 'reportKnownAt', 'recipientScopeRef', 'recordedAt',
      'verdictScopeRef', 'possibilityKnownAt', 'hospitalKnownAt', 'firstDetectionEvidenceAt', 'processorKnownAt', 'operatorKnownAt', 'notifiedHospitalAt',
      'knowledgeAttributionEvidenceId', 'healthDataActualLeak', 'obligationOwner', 'ispIncident']);
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
    const m = object(v.medicalIncident, ['occurredAt', 'discoveredAt', 'electronicIntrusion', 'type']); utc(m.occurredAt); utc(m.discoveredAt);
    if (m.occurredAt > m.discoveredAt) throw new Error('Discovery before occurrence');
    choice(m.type, MEDICAL_TRIGGER_RULE.types); if (typeof m.electronicIntrusion !== 'boolean') throw new Error('Intrusion element required');
  }
  for (const k of ['verdictId', 'supersedes', 'possibilityEventId', 'additionalEventId', 'reportEventId', 'recipientScopeRef', 'verdictScopeRef', 'knowledgeAttributionEvidenceId'])
    if (v[k] !== undefined) string(v[k]);
  for (const k of ['reportKnownAt', 'recordedAt']) if (v[k] !== undefined) utc(v[k]);
  if (v.reportKnownAt !== undefined && (v.status !== 'confirmed' || v.reportKnownAt < v.determinationAt))
    throw new Error('Invalid report trigger');
  for (const k of ['possibilityKnownAt', 'hospitalKnownAt', 'firstDetectionEvidenceAt', 'processorKnownAt', 'operatorKnownAt', 'notifiedHospitalAt']) if (v[k] !== undefined) utc(v[k]);
  if (v.obligationOwner !== undefined) {
    const owner = object(v.obligationOwner, ['kind', 'id']); choice(owner.kind, ['hospital', 'processor', 'operator']); string(owner.id);
    if (owner.kind === 'hospital' && owner.id !== scope.institutionId) throw new Error('Foreign controller');
    if (owner.kind === 'processor' && !v.processorKnownAt) throw new Error('Processor knowledge required');
    if (owner.kind === 'operator' && !v.operatorKnownAt) throw new Error('Operator knowledge required');
  }
  const ownKnownAt = v.obligationOwner?.kind === 'operator' ? v.operatorKnownAt :
    v.obligationOwner?.kind === 'processor' ? v.processorKnownAt : (v.hospitalKnownAt ?? v.awarenessAt);
  if (ownKnownAt !== v.awarenessAt || (v.hospitalKnownAt !== undefined && !v.knowledgeAttributionEvidenceId) ||
      (v.possibilityKnownAt !== undefined && (v.possibilityKnownAt < ownKnownAt || v.possibilityKnownAt > v.determinationAt))) throw new Error('Knowledge attribution required');
  if (v.healthDataActualLeak !== undefined && (typeof v.healthDataActualLeak !== 'boolean' || (v.healthDataActualLeak && v.status !== 'confirmed'))) throw new Error('Actual health leak requires confirmation');
  if (v.ispIncident !== undefined) {
    const isp = optionalObject(v.ispIncident, ['eventId', 'attackCaused', 'status'], ['verification', 'userImpact', 'additionalFacts', 'deploymentModel', 'occurrence', 'userNoticeDecision']);
    string(isp.eventId); if (typeof isp.attackCaused !== 'boolean' || ![true, false, 'unknown'].includes(isp.status)) throw new Error('Invalid ISP finding');
    if (isp.status !== 'unknown' && !isp.verification) throw new Error('ISP verification required');
    if (isp.verification) {
      const x = optionalObject(isp.verification, ['by', 'at', 'evidenceId', 'types'], ['nonApplicabilityBasis']); identity(x.by); utc(x.at); string(x.evidenceId);
      const types = object(x.types, ['telecomBusiness', 'forProfitTelecomInformation']);
      if (Object.values(types).some(t => typeof t !== 'boolean')) throw new Error('ISP type findings required');
      if (isp.status === 'unknown' || isp.status !== INSTALL_FACTS_RULE.ispApplies(x.types)) throw new Error('ISP status contradicts verified types');
      if (isp.status === false) string(x.nonApplicabilityBasis);
    }
    if (isp.deploymentModel !== undefined) choice(isp.deploymentModel, ['hosted', 'managed', 'on-prem']);
    if (isp.occurrence) {
      const o = optionalObject(isp.occurrence, ['occurredAt', 'endedAt', 'evidenceId'], ['correction']); string(o.evidenceId);
      if (o.occurredAt !== null && utc(o.occurredAt) > ownKnownAt) throw new Error('Occurrence after knowledge');
      if (o.endedAt !== null && (utc(o.endedAt) < o.occurredAt)) throw new Error('Invalid occurrence interval');
      if (o.correction !== undefined) {
        const c = object(o.correction, ['supersedes', 'at', 'reason', 'evidenceId']);
        string(c.supersedes); string(c.reason); string(c.evidenceId);
        if (utc(c.at) < ownKnownAt) throw new Error('Correction before incident knowledge');
      }
    }
    if (isp.userNoticeDecision) {
      const d = object(isp.userNoticeDecision, ['decisionId', 'applies', 'at', 'reason', 'basis', 'evidenceId', 'decider']);
      for (const k of ['decisionId', 'reason', 'basis', 'evidenceId']) string(d[k]); utc(d.at);
      if (typeof d.applies !== 'boolean' || d.at < ownKnownAt) throw new Error('Occurrence applicability decision required');
      const decider = incidentDecider(d.decider, d.at);
      if (decider.ownerId !== (v.obligationOwner?.id ?? scope.institutionId)) throw new Error('Other occurrence decision owner');
    }
    if (isp.userImpact) {
      const u = optionalObject(isp.userImpact, ['kind', 'confirmedAt', 'recipientScopeRef', 'evidenceId', 'decider'], ['outageMinutes', 'detailsComplete']);
      choice(u.kind, ['outage', 'user-information', 'comparable-serious-impact']); utc(u.confirmedAt); string(u.recipientScopeRef); string(u.evidenceId);
      if (u.confirmedAt < ownKnownAt || (u.kind === 'outage' && (!Number.isFinite(u.outageMinutes) || u.outageMinutes < 120))) throw new Error('User impact threshold not met');
      if (u.detailsComplete !== undefined && typeof u.detailsComplete !== 'boolean') throw new Error('ISP completeness required');
      const d = incidentDecider(u.decider, u.confirmedAt);
      if (d.ownerId !== (v.obligationOwner?.id ?? scope.institutionId)) throw new Error('User scope decision authority required');
    }
    if (isp.additionalFacts !== undefined) {
      if (!Array.isArray(isp.additionalFacts)) throw new Error('Additional facts required');
      for (const item of isp.additionalFacts) { const x = object(item, ['eventId', 'confirmedAt', 'evidenceId']); string(x.eventId); utc(x.confirmedAt); string(x.evidenceId);
        if (x.confirmedAt < ownKnownAt) throw new Error('Invalid additional ISP fact'); }
    }
  }
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
    optionalObject(history, [], ['previous', 'notices', 'asOf', 'findings', 'delays', 'decisions', 'recipientScopes']);
    const f = incidentFacts(input, scope), asOf = utc(history.asOf ?? f.newlyConfirmedAt ?? f.determinationAt), previous = history.previous;
    if (previous && (!incidentResponses.has(previous) || previous.incidentId !== f.incidentId || previous.institutionId !== authority.institutionId ||
        previous.awarenessAt !== f.awarenessAt || previous.asOf > asOf)) throw new Error('Unbound history');
    const owner = f.obligationOwner ?? { kind: 'hospital' as const, id: authority.institutionId };
    if (previous && digest(previous.obligationOwner) !== digest(owner)) throw new Error('Other obligation owner');
    const key = (family: DutyFamily, eventId: string, recipients: string) => JSON.stringify([authority.institutionId, f.incidentId, owner.kind, owner.id, family, eventId, recipients]);
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
    const recipientScopes = merge([...(previous?.recipientScopes ?? []), ...list(history.recipientScopes)].map(value => {
      const s = object(value, ['scopeRef', 'recipientIds']); string(s.scopeRef);
      if (s.scopeRef.startsWith('recipient:')) throw new Error('Reserved recipient scope');
      return { scopeRef: s.scopeRef, recipientIds: uniqueStrings(s.recipientIds).sort() };
    }), s => s.scopeRef);
    const members = (ref: string): readonly string[] | undefined => ref.startsWith('recipient:') ? [ref.slice(10)] : recipientScopes.find(s => s.scopeRef === ref)?.recipientIds;
    const covers = (whole: string, part: string): boolean => whole === part ||
      (!!members(whole) && !!members(part) && members(part).every(id => members(whole).includes(id)));
    // A whole-incident verdict reaches its notified subsets. Delivery coverage across different legal populations
    // (data subjects versus service users) still needs explicit recipient-set evidence.
    const verdictCovers = (whole: string, part: string) => (whole === 'incident-subjects' && !members(whole)) || covers(whole, part);
    const intersection = (a: string, b: string): string[] => {
      const left = members(a), right = members(b);
      if (left && right) return left.filter(id => right.includes(id)).map(id => `recipient:${id}`);
      if (verdictCovers(b, a)) return left ? left.map(id => `recipient:${id}`) : [a];
      if (covers(a, b)) return right ? right.map(id => `recipient:${id}`) : [b];
      throw new Error('Recipient intersection evidence required');
    };
    // 1. Bind immutable findings, including actual event times and receipt provenance. Compatibility IDs are stable
    // within this incident; independent same-time facts supply their distinct source IDs explicitly.
    const incoming = [...list(history.findings), f].map(value => {
      const v = incidentFacts(value, scope);
      if (v.incidentId !== f.incidentId || v.awarenessAt !== f.awarenessAt) throw new Error('Other incident');
      if (digest(v.obligationOwner ?? { kind: 'hospital', id: authority.institutionId }) !== digest(owner)) throw new Error('Other obligation owner');
      const recordedAt = v.recordedAt ?? asOf;
      if (recordedAt > asOf || recordedAt < v.determinationAt || (v.newlyConfirmedAt !== null && v.newlyConfirmedAt > recordedAt) ||
          (v.reportKnownAt && v.reportKnownAt > recordedAt) || (v.medicalIncident && v.medicalIncident.discoveredAt > recordedAt)) throw new Error('Future finding');
      if (['hospitalKnownAt', 'firstDetectionEvidenceAt', 'processorKnownAt', 'operatorKnownAt', 'notifiedHospitalAt'].some(k => v[k] && v[k] > recordedAt) ||
          (v.ispIncident?.verification && v.ispIncident.verification.at > recordedAt) ||
          (v.ispIncident?.occurrence?.endedAt && v.ispIncident.occurrence.endedAt > recordedAt) ||
          (v.ispIncident?.occurrence?.correction && v.ispIncident.occurrence.correction.at > recordedAt) ||
          (v.ispIncident?.userNoticeDecision && v.ispIncident.userNoticeDecision.at > recordedAt) ||
          (v.ispIncident?.userImpact && v.ispIncident.userImpact.confirmedAt > recordedAt) ||
          v.ispIncident?.additionalFacts?.some(x => x.confirmedAt > recordedAt)) throw new Error('Future incident evidence');
      const facts: BoundFinding['facts'] = {
        ...Object.fromEntries(['hospitalKnownAt', 'firstDetectionEvidenceAt', 'processorKnownAt', 'operatorKnownAt', 'notifiedHospitalAt', 'knowledgeAttributionEvidenceId',
          'healthDataActualLeak', 'obligationOwner', 'ispIncident', 'possibilityKnownAt'].filter(k => v[k] !== undefined).map(k => [k, structuredClone(v[k])])),
        incidentId: v.incidentId, awarenessAt: v.awarenessAt, determinationAt: v.determinationAt, status: v.status,
        possibleGround: v.possibleGround, detailsComplete: v.detailsComplete, newlyConfirmedAt: v.newlyConfirmedAt,
        reportTriggers: [...new Set([...v.reportTriggers, ...(v.healthDataActualLeak ? [INCIDENT_COMMON_RULE.healthLeakReportTrigger] : [])])].sort(), medicalIncident: v.medicalIncident ? { ...v.medicalIncident } : null, evidenceId: v.evidenceId,
        verdictId: v.verdictId ?? `verdict:${v.status}:${v.determinationAt}`, ...(v.supersedes ? { supersedes: v.supersedes } : {}),
        possibilityEventId: v.possibilityEventId ?? `possibility:${v.awarenessAt}`, additionalEventId: v.additionalEventId ?? `additional:${v.newlyConfirmedAt}`,
        reportEventId: v.reportEventId ?? `report:${v.reportKnownAt ?? v.determinationAt}`,
        ...(v.reportKnownAt !== undefined || v.reportTriggers.length || v.healthDataActualLeak ? { reportKnownAt: v.reportKnownAt ?? v.determinationAt } : {}),
        recipientScopeRef: v.recipientScopeRef ?? 'incident-subjects',
        verdictScopeRef: v.verdictScopeRef ?? v.recipientScopeRef ?? 'incident-subjects',
      };
      return { findingId: digest(facts), institutionId: authority.institutionId, incidentId: f.incidentId,
        facts, by: { ...authority.subject }, recordedAt };
    });
    const findings = merge([...(previous?.ledger.findings ?? []), ...incoming], x => x.findingId, x => x.facts);
    const facts = findings.map(x => x.facts).sort((a, b) => a.determinationAt.localeCompare(b.determinationAt) || a.verdictId.localeCompare(b.verdictId));
    const verdicts = merge(facts.map(v => ({ id: v.verdictId, at: v.determinationAt, status: v.status,
      scope: v.verdictScopeRef, supersedes: v.supersedes ?? null })), x => x.id);
    for (const v of verdicts) if (v.supersedes) {
      const old = verdicts.find(x => x.id === v.supersedes);
      if (!old || old.id === v.id || old.at > v.at || old.scope !== v.scope || verdicts.some(x => x.id !== v.id && x.supersedes === old.id)) throw new Error('Invalid verdict correction');
      const visited = new Set([v.id]); let parent = old;
      while (parent) { if (visited.has(parent.id)) throw new Error('Cyclic correction'); visited.add(parent.id); parent = verdicts.find(x => x.id === parent.supersedes); }
    }
    const effective = verdicts.filter(v => !verdicts.some(x => x.supersedes === v.id)).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const overlaps = (a: string, b: string) => verdictCovers(a, b) || verdictCovers(b, a) || (!!members(a) && !!members(b) && members(a).some(id => members(b).includes(id)));
    for (const a of effective) for (const b of effective) if (a.id !== b.id && a.at === b.at && a.status !== b.status && overlaps(a.scope, b.scope))
      throw new Error('Ambiguous simultaneous verdicts');
    // A correction takes effect at its own time. It does not delete the historical verdict interval.
    const timeline = (recipients: string, at: string) => verdicts.filter(v => v.at <= at && verdictCovers(v.scope, recipients) &&
      !verdicts.some(next => next.supersedes === v.id && next.at <= at)).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const currentFor = (recipients: string, at = asOf) => timeline(recipients, at).slice(-1)[0];
    const consecutiveRoot = (v: typeof verdicts[number], recipients: string) => {
      const ordered = verdicts.filter(x => verdictCovers(x.scope, recipients) && x.at <= v.at).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      let root = v;
      for (let i = ordered.findIndex(x => x.id === v.id) - 1; i >= 0 && ordered[i].status === v.status; i--) root = ordered[i];
      return root;
    };
    const ispStatus = (eventId: string) => {
      const candidates = findings.filter(x => x.facts.ispIncident?.eventId === eventId).sort((a, b) =>
        (a.facts.ispIncident.verification?.at ?? '').localeCompare(b.facts.ispIncident.verification?.at ?? '') || a.recordedAt.localeCompare(b.recordedAt));
      const latest = candidates.slice(-1)[0]?.facts.ispIncident;
      if (latest && candidates.some(x => x.facts.ispIncident.verification?.at === latest.verification?.at && x.facts.ispIncident.status !== latest.status)) throw new Error('Conflicting ISP verification');
      return latest?.status ?? 'unknown';
    };
    const ispAssessments: IncidentResponsePlan['ispAssessments'][number][] = [];
    type Occurrence = NonNullable<IncidentResponseFacts['ispIncident']['occurrence']>;
    const ispUserRules = new Map<string, { applicable: boolean; decisions: NonNullable<IncidentResponseFacts['ispIncident']['userNoticeDecision']>[];
      occurrences: Occurrence[]; retirement: { ref: string; ground: IncidentObligation['closureGround'] } | null }>();
    for (const eventId of [...new Set(facts.filter(v => v.ispIncident?.attackCaused).map(v => v.ispIncident.eventId))].sort()) {
      const eventFacts = facts.filter(v => v.ispIncident?.eventId === eventId);
      const knowledgeAt = eventFacts[0].awarenessAt, law = ispLawAt(knowledgeAt);
      const occurrences = merge(eventFacts.map(v => v.ispIncident.occurrence).filter(Boolean), o => o.evidenceId);
      for (const o of occurrences) if (o.correction) {
        const old = occurrences.find(x => x.evidenceId === o.correction.supersedes);
        if (!old || old.evidenceId === o.evidenceId || (old.correction && old.correction.at > o.correction.at) ||
            occurrences.some(x => x.evidenceId !== o.evidenceId && x.correction?.supersedes === old.evidenceId)) throw new Error('Invalid occurrence correction');
        const visited = new Set([o.evidenceId]); let parent = old;
        while (parent) {
          if (visited.has(parent.evidenceId)) throw new Error('Cyclic occurrence correction');
          visited.add(parent.evidenceId); parent = occurrences.find(x => x.evidenceId === parent.correction?.supersedes);
        }
      }
      // Retain the forensic record while allowing an explicit correction to replace its factual conclusion.
      const effectiveOccurrences = occurrences.filter(o => !occurrences.some(x => x.correction?.supersedes === o.evidenceId));
      const starts = [...new Set(effectiveOccurrences.map(o => o.occurredAt).filter(Boolean))];
      const ends = [...new Set(effectiveOccurrences.map(o => o.endedAt).filter(Boolean))];
      if (starts.length > 1 || ends.length > 1) throw new Error('Conflicting occurrence evidence');
      const occurredAt = starts[0], endedAt = ends[0], cutover = Date.parse(ISP.userNoticeAppliesFrom);
      const uncertain = !occurredAt || (Date.parse(occurredAt) < cutover && (!endedAt || Date.parse(endedAt) >= cutover));
      const decisions = merge(eventFacts.map(v => v.ispIncident.userNoticeDecision).filter(Boolean), d => d.decisionId);
      const latest = [...decisions].sort((a, b) => a.at.localeCompare(b.at)).slice(-1)[0];
      if (latest && decisions.some(d => d.at === latest.at && d.applies !== latest.applies)) throw new Error('Conflicting occurrence decisions');
      const definite = !!occurredAt && Date.parse(occurredAt) >= cutover;
      // Evidence intake must not depend on an officer making a replacement decision in the same call.
      const needsRedecision = !uncertain && !!latest && latest.applies !== definite;
      const applicability = needsRedecision ? 're-decision-required' : uncertain ? latest ? latest.applies ? 'applicable' : 'not-applicable' : 'decision-required' : definite ? 'applicable' : 'not-applicable';
      const correction = effectiveOccurrences.filter(o => o.correction).sort((a, b) =>
        a.correction.at.localeCompare(b.correction.at) || a.evidenceId.localeCompare(b.evidenceId)).slice(-1)[0];
      const retirement = correction && (!latest || correction.correction.at >= latest.at)
        ? { ref: correction.evidenceId, ground: 'occurrence-corrected' as const }
        : latest ? { ref: latest.decisionId, ground: 'applicability-redecided' as const } : null;
      // A pending re-decision cannot suppress either independently sufficient source of an owed duty.
      ispUserRules.set(eventId, { applicable: definite || !!latest?.applies,
        occurrences, retirement,
        decisions: [...decisions].sort((a, b) => a.at.localeCompare(b.at) || a.decisionId.localeCompare(b.decisionId)) });
      const status = ispStatus(eventId), reportDueAt = law.taskPolicy ? null : new Date(Date.parse(knowledgeAt) + IMMEDIATE_TIMING_RULE.ispHours * 3600000).toISOString();
      ispAssessments.push({ eventId, knowledgeAt, initialReport: { dueAt: status === true ? reportDueAt : null,
        dueRule: law.dueRule, displayedBasis: law.displayedBasis, taskPolicy: law.taskPolicy ? 'display-only' : 'track', automaticExemption: false,
        applicability: status === true ? 'verified' : status === false ? 'not-applicable' : 'unverified',
        provisionalResponseDueAt: status === 'unknown' ? reportDueAt : null },
        userNotice: { applicability, decisionRefs: decisions.map(d => d.decisionId),
          occurrenceEvidenceRefs: occurrences.map(o => o.evidenceId), effectiveOccurrenceEvidenceRefs: effectiveOccurrences.map(o => o.evidenceId),
          reasonCode: needsRedecision ? 'occurrence-evidence-contradicts-decision' : null,
          reason: needsRedecision ? '확인된 사고 발생 시각이 기존 이용자 통지 적용 결정과 달라 재판정이 필요합니다.' : null } });
    }
    const ispUserApplicable = (eventId: string) => ispUserRules.get(eventId)?.applicable === true;
    // Replay the effective decision intervals, including a duty first recognized after its original trigger.
    // A new cause after a negative re-decision does not belong to the earlier applicable interval.
    const ispUserPreviouslyApplicable = (eventId: string, at: string) => {
      const rule = ispUserRules.get(eventId);
      return rule?.decisions.some((d, i, all) => d.applies && (!all[i + 1] || all[i + 1].at > at)) === true ||
        rule?.occurrences.some(o => o.occurredAt !== null && Date.parse(o.occurredAt) >= Date.parse(ISP.userNoticeAppliesFrom) &&
          rule.occurrences.some(next => next.correction?.supersedes === o.evidenceId && next.correction.at > at)) === true;
    };
    type Cause = { family: DutyFamily; eventId: string; at: string; recipients: string; fact: BoundFinding['facts']; discoveredAt?: string; evidenceAt?: string; verdictRefs?: string[] };
    const causes: Cause[] = [];
    for (const v of facts) {
      // Other-law causes bind actual deliveries even when this owner has no duty under that law.
      {
        const possibleAt = v.possibilityKnownAt ?? v.awarenessAt;
        if (v.possibleGround !== null && possibleAt >= INCIDENT_COMMON_RULE.possibilityEffectiveFrom) causes.push({ family: 'possibility', eventId: v.possibilityEventId,
          at: possibleAt, evidenceAt: v.status === 'possible' ? v.determinationAt : possibleAt, recipients: v.recipientScopeRef, fact: v });
        if (v.status === 'confirmed') {
          causes.push({ family: 'confirmed', eventId: v.verdictId, at: v.determinationAt, recipients: v.recipientScopeRef, fact: v });
          if (v.reportTriggers.length) causes.push({ family: 'report', eventId: v.reportEventId, at: v.reportKnownAt, recipients: 'PIPC-or-KISA', fact: v });
          if (v.newlyConfirmedAt !== null) {
            causes.push({ family: 'additional-notice', eventId: v.additionalEventId, at: v.newlyConfirmedAt, recipients: v.recipientScopeRef, fact: v });
            if (v.reportTriggers.length) causes.push({ family: 'additional-report', eventId: v.additionalEventId, at: v.newlyConfirmedAt, recipients: 'PIPC-or-KISA', fact: v });
          }
        }
      }
      if (owner.kind !== 'processor' && v.medicalIncident?.electronicIntrusion) causes.push({ family: 'medical', eventId: `medical:${v.medicalIncident.occurredAt}`, at: MEDICAL_TRIGGER_RULE.at(v.medicalIncident),
        discoveredAt: v.medicalIncident.discoveredAt, recipients: 'MOHW', fact: v });
      const isp = v.ispIncident;
      if (isp?.attackCaused) {
        causes.push({ family: 'isp-report', eventId: isp.eventId, at: v.awarenessAt, recipients: 'MSIT-or-KISA', fact: v });
        if (isp.userImpact) causes.push({ family: 'isp-user', eventId: isp.eventId, at: isp.userImpact.confirmedAt, recipients: isp.userImpact.recipientScopeRef, fact: v });
        for (const additional of isp.additionalFacts ?? []) {
          causes.push({ family: 'isp-supplement', eventId: additional.eventId, at: additional.confirmedAt, recipients: 'MSIT-or-KISA', fact: v });
          if (isp.userImpact) causes.push({ family: 'isp-user-additional', eventId: additional.eventId, at: additional.confirmedAt, recipients: isp.userImpact.recipientScopeRef, fact: v });
        }
      }
    }
    const sources = merge(causes, c => key(c.family, c.eventId, c.recipients), c => [c.family, c.eventId, c.at, c.recipients, c.discoveredAt ?? null]);
    // Initial confirmation/report clocks belong to the first cause for that recipient scope. Completeness is a mode,
    // not a fresh duty. Other confirmation findings remain in the ledger and additional facts keep distinct IDs.
    const initial = (c: Cause) => !['confirmed', 'report'].includes(c.family) || !sources.some(x => x.family === c.family && x.recipients === c.recipients &&
      (x.at < c.at || (x.at === c.at && x.eventId < c.eventId)));
    const dutySources = sources.filter(initial);
    const userNoticeFields = (fact: BoundFinding['facts']) => fact.ispIncident.userImpact?.detailsComplete === false ?
      IMMEDIATE_TIMING_RULE.ispUserFields.slice(1) : IMMEDIATE_TIMING_RULE.ispUserFields;
    const rawNotices = [...(previous?.ledger.notices ?? []), ...list(history.notices)];
    const parsedNotices = rawNotices.map(value => {
      const n = optionalObject(value, ['kind', 'triggeredAt', 'noticeId', 'sentAt'], ['institutionId', 'incidentId', 'triggerEventId', 'recipientScopeRef', 'coversAll', 'evidenceId', 'recordedAt', 'coveredFields', 'channel', 'posting']);
      choice(n.kind, Object.keys(DUTY_FAMILY) as DutyKind[]); string(n.noticeId); utc(n.triggeredAt); utc(n.sentAt);
      const family = DUTY_FAMILY[n.kind], recordedAt = utc(n.recordedAt ?? asOf);
      if (n.sentAt < n.triggeredAt || n.sentAt > recordedAt || recordedAt > asOf ||
          (n.institutionId !== undefined && n.institutionId !== authority.institutionId) || (n.incidentId !== undefined && n.incidentId !== f.incidentId)) throw new Error('Unbound notice');
      const matches = family === 'no-leak' ? merge(verdicts.filter(v => v.status === 'not-a-leak' && v.at <= n.triggeredAt && (!n.triggerEventId || v.id === n.triggerEventId))
        .map(v => ({ eventId: consecutiveRoot(v, n.recipientScopeRef ?? v.scope).id, recipients: n.recipientScopeRef ?? v.scope })), x => x.eventId)
        : dutySources.filter(c => c.family === family && c.at === n.triggeredAt && (!n.triggerEventId || c.eventId === n.triggerEventId));
      if (matches.length !== 1) throw new Error('Unknown or ambiguous notice trigger');
      if (n.coversAll !== undefined && typeof n.coversAll !== 'boolean') throw new Error('Coverage evidence required');
      if (n.coveredFields !== undefined) uniqueStrings(n.coveredFields);
      if (n.channel !== undefined) choice(n.channel, ['MOHW-official', 'MOHW-delegated', 'PIPC', 'KISA', 'MSIT', 'affected-users']);
      if (n.posting) { const p = object(n.posting, ['justCause', 'evidenceId', 'maintainedThrough', 'maintenanceEvidenceId']);
        string(p.justCause); string(p.evidenceId); string(p.maintenanceEvidenceId); utc(p.maintainedThrough);
        if (!NO_LEAK_CLOSURE_RULE.postingFamilies.includes(family) || !n.coveredFields || p.maintainedThrough < n.sentAt || p.maintainedThrough > recordedAt) throw new Error('Invalid posting evidence'); }
      if (family === 'medical' && (!MEDICAL_TRIGGER_RULE.channels.includes(n.channel) || !['institution-name', 'incident-time', 'damage-details', 'technical-support-request'].every(k => n.coveredFields?.includes(k)))) throw new Error('MOHW official channel and content required');
      if (['isp-report', 'isp-supplement'].includes(family) && (!['MSIT', 'KISA'].includes(n.channel) ||
          !(family === 'isp-report' ? IMMEDIATE_TIMING_RULE.ispReportFields : ['newly-confirmed-facts']).every(k => n.coveredFields?.includes(k)))) throw new Error('ISP report channel and content required');
      if (['isp-user', 'isp-user-additional'].includes(family) && (!n.posting && n.channel !== 'affected-users' ||
          !(family === 'isp-user' ? userNoticeFields((matches[0] as Cause).fact) : ['newly-confirmed-facts']).every(k => n.coveredFields?.includes(k)))) throw new Error('ISP user content required');
      return { kind: n.kind as DutyKind, triggeredAt: n.triggeredAt, noticeId: n.noticeId, sentAt: n.sentAt,
        institutionId: authority.institutionId, incidentId: f.incidentId, triggerEventId: matches[0].eventId,
        recipientScopeRef: string(n.recipientScopeRef ?? matches[0].recipients), coversAll: n.coversAll ?? true,
        evidenceId: string(n.evidenceId ?? n.noticeId), recordedAt,
        ...(n.coveredFields ? { coveredFields: [...n.coveredFields].sort() } : {}), ...(n.channel ? { channel: n.channel } : {}), ...(n.posting ? { posting: { ...n.posting } } : {}) };
    });
    const notices = merge(parsedNotices, n => n.noticeId, n => { const { recordedAt, ...bound } = n; return bound; });
    const delays = merge([...(previous?.ledger.delays ?? []), ...list(history.delays)].map(value => {
      const d = structuredClone(optionalObject(value, ['delayId', 'obligationKey', 'clause', 'version', 'reason', 'evidenceId', 'by', 'recordedAt', 'startedAt', 'clearedAt', 'accepted', 'decisionId', 'supersedes'], ['category', 'decider', 'causalReview']));
      for (const k of ['delayId', 'obligationKey', 'clause', 'version', 'reason', 'evidenceId']) string(d[k]);
      identity(d.by); utc(d.recordedAt); utc(d.startedAt); if (d.clearedAt !== null) utc(d.clearedAt);
      if (typeof d.accepted !== 'boolean' || (d.accepted && !d.decisionId)) throw new Error('Delay acceptance required');
      if (d.decisionId !== null) string(d.decisionId); if (d.supersedes !== null) string(d.supersedes);
      if (d.recordedAt > asOf || d.startedAt > d.recordedAt || (d.clearedAt !== null && (d.clearedAt < d.startedAt || d.clearedAt > d.recordedAt))) throw new Error('Invalid delay time');
      if (d.category !== undefined) choice(d.category, ['urgent-containment', 'force-majeure']);
      if (d.decider) { d.decider = incidentDecider(d.decider, d.recordedAt); if (!sameIdentity(d.decider.by, d.by)) throw new Error('Decider identity mismatch'); }
      if (d.causalReview) { const c = object(d.causalReview, ['evidenceId', 'reviewedAt', 'relatesToTime', 'createdAt', 'receivedAt', 'reason']);
        string(c.evidenceId); string(c.reason); for (const k of ['reviewedAt', 'relatesToTime', 'createdAt', 'receivedAt']) utc(c[k]);
        if (c.relatesToTime !== d.startedAt || c.createdAt > c.receivedAt || c.receivedAt > c.reviewedAt || c.reviewedAt > d.recordedAt) throw new Error('Invalid causal review'); }
      if (d.accepted && (!d.category || !d.causalReview || !d.decider)) throw new Error('Delay acceptance evidence required');
      return { ...d, by: { ...d.by } } as IncidentDelay;
    }), d => d.delayId);
    const decisions = merge([...(previous?.ledger.decisions ?? []), ...list(history.decisions)].map(value => {
      const d = structuredClone(optionalObject(value, ['decisionId', 'obligationKey', 'at', 'recordedAt', 'by', 'authorityEvidenceId', 'evidenceId', 'reason', 'basis', 'effect', 'stillOwed'], ['decider', 'category']));
      for (const k of ['decisionId', 'obligationKey', 'authorityEvidenceId', 'evidenceId', 'reason', 'basis']) string(d[k]);
      identity(d.by); utc(d.at); utc(d.recordedAt); choice(d.effect, ['timeliness-overdue', 'final-breach', 'report-exemption']);
      if (d.at > d.recordedAt || d.recordedAt > asOf || typeof d.stillOwed !== 'boolean' ||
          (d.effect === 'final-breach' && d.stillOwed !== NO_LEAK_CLOSURE_RULE.finalBreachStillOwed) ||
          (d.effect === 'report-exemption' ? d.stillOwed : !d.stillOwed)) throw new Error('Invalid decision');
      if (d.decider) { d.decider = incidentDecider(d.decider, d.at); if (!sameIdentity(d.decider.by, d.by)) throw new Error('Decider identity mismatch'); }
      if (d.effect === 'report-exemption' && (d.category !== 'risk-substantially-reduced' || d.basis !== NO_LEAK_CLOSURE_RULE.reportExemptionBasis || !d.decider)) throw new Error('Report exemption basis required');
      return { ...d, by: { ...d.by } } as IncidentDecision;
    }), d => d.decisionId);
    // 2. Derive notice facts only after ALL evidence is bound. Assertions never act as evidence.
    const possibleNotices = notices.filter(n => n.kind === 'possible-leak');
    const postingReady = (n: BoundNotice) => !n.posting || elapsed(n.sentAt, n.posting.maintainedThrough) >= NO_LEAK_CLOSURE_RULE.postingDays * 86400000;
    const performedAt = (n: BoundNotice) => n.posting ? new Date(Date.parse(n.sentAt) + NO_LEAK_CLOSURE_RULE.postingDays * 86400000).toISOString() : n.sentAt;
    const possibleFields = ['possible-data-items', 'suspected-time-and-circumstances', ...LEAK_NOTICE_FIELDS.slice(2, 5), 'further-notice-on-determination'];
    const noticeCovers = (n: BoundNotice, recipients: string) => (n.coversAll && covers(n.recipientScopeRef, recipients)) ||
      (!!members(n.recipientScopeRef) && !!members(recipients) && covers(n.recipientScopeRef, recipients));
    const completion = (candidates: readonly BoundNotice[], recipients: string) => {
      const reached = new Set<string>(), required = members(recipients);
      for (const n of [...candidates].sort((a, b) => performedAt(a).localeCompare(performedAt(b)) || a.noticeId.localeCompare(b.noticeId))) {
        if (noticeCovers(n, recipients)) return n;
        for (const id of members(n.recipientScopeRef) ?? []) reached.add(id);
        if (required?.length && required.every(id => reached.has(id))) return n;
      }
      return undefined;
    };
    const validPossibleNotice = (n: BoundNotice) => postingReady(n) && (!n.posting || possibleFields.every(k => n.coveredFields?.includes(k)));
    const satisfiesPossible = (c: Cause, at: string) => !!completion(possibleNotices.filter(n => n.triggerEventId === c.eventId &&
      validPossibleNotice(n) && performedAt(n) <= at), c.recipients);
    if (f.priorPossibleNotice !== undefined && (f.priorPossibleNotice === null ? possibleNotices.length > 0 :
        !possibleNotices.some(n => n.noticeId === f.priorPossibleNotice.noticeId && n.sentAt === f.priorPossibleNotice.sentAt))) throw new Error('Contradictory notice assertion');
    const followups: Cause[] = [];
    for (const v of verdicts.filter(v => v.status === 'not-a-leak')) for (const n of possibleNotices) {
      if (!validPossibleNotice(n)) continue;
      // A later different verdict can supersede the no-leak result before a reverse-order delivery; retain that
      // delivery but do not tell its recipients a result that was already replaced at the actual send time.
      for (const recipients of intersection(n.recipientScopeRef, v.scope)) {
        const at = NO_LEAK_FOLLOWUP_RULE.at(performedAt(n), v.at);
        if (currentFor(recipients, at)?.status !== 'not-a-leak') continue;
        const root = consecutiveRoot(v, recipients);
        followups.push({ family: 'no-leak', eventId: root.id, at: NO_LEAK_FOLLOWUP_RULE.at(performedAt(n), root.at), recipients,
          verdictRefs: [v.id, root.id], fact: facts.find(x => x.verdictId === root.id) });
      }
    }
    const followupMap = new Map<string, Cause>();
    for (const c of followups) { const k = key(c.family, c.eventId, c.recipients), old = followupMap.get(k);
      if (!old) followupMap.set(k, c);
      else { old.at = old.at < c.at ? old.at : c.at; old.verdictRefs = [...new Set([...old.verdictRefs, ...c.verdictRefs])].sort(); }
    }
    // 3. Build duties by cause, never by a previous presentation status.
    const obligations: IncidentObligation[] = [];
    const familyOrder: DutyFamily[] = ['possibility', 'confirmed', 'additional-notice', 'report', 'additional-report', 'no-leak', 'medical', 'isp-report', 'isp-supplement', 'isp-user', 'isp-user-additional'];
    const ordered = [...dutySources, ...followupMap.values()].sort((a, b) => familyOrder.indexOf(a.family) - familyOrder.indexOf(b.family) || a.at.localeCompare(b.at) ||
      key(a.family, a.eventId, a.recipients).localeCompare(key(b.family, b.eventId, b.recipients)));
    for (const c of ordered) {
      const isIsp = c.family.startsWith('isp-'), applicability = isIsp ? ispStatus(c.fact.ispIncident.eventId) : true;
      if (owner.kind === 'operator' && !isIsp) continue;
      if (applicability === false) continue;
      const reportLaw = ['isp-report', 'isp-supplement'].includes(c.family) ? ispLawAt(c.at) : null;
      if (reportLaw?.taskPolicy) continue;
      if (['isp-user', 'isp-user-additional'].includes(c.family) && !ispUserApplicable(c.fact.ispIncident.eventId) &&
          !ispUserPreviouslyApplicable(c.fact.ispIncident.eventId, c.at)) continue;
      if (['isp-supplement', 'isp-user-additional'].includes(c.family)) {
        const prior = notices.some(n => postingReady(n) && performedAt(n) <= c.at && (c.family === 'isp-supplement'
          ? ((n.kind === 'isp-incident-report' && n.triggerEventId === c.fact.ispIncident.eventId) ||
            (owner.kind !== 'operator' && NO_LEAK_CLOSURE_RULE.deemedReportKinds.includes(n.kind) && n.sentAt >= c.fact.awarenessAt && ['MOHW-official', 'MOHW-delegated', 'PIPC', 'KISA'].includes(n.channel) && IMMEDIATE_TIMING_RULE.ispReportFields.every(k => n.coveredFields?.includes(k))))
          : ((n.kind === 'isp-user-notice' || (owner.kind !== 'operator' && ['possible-leak', 'confirmed-leak', 'confirmed-priority'].includes(n.kind))) && noticeCovers(n, c.recipients) && userNoticeFields(c.fact).every(k => n.coveredFields?.includes(k)))));
        if (!prior) continue;
      }
      const mode = facts.filter(v => v.status === 'confirmed' && v.determinationAt === c.fact.determinationAt).some(v => v.detailsComplete);
      const kind: DutyKind = ({ possibility: 'possible-leak', confirmed: mode ? 'confirmed-leak' : 'confirmed-priority',
        'additional-notice': 'confirmed-additional', 'no-leak': 'not-a-leak', report: mode ? 'pipc-kisa-report' : 'pipc-kisa-priority',
        'additional-report': 'pipc-kisa-additional', medical: 'mohw-notice', 'isp-report': 'isp-incident-report',
        'isp-supplement': 'isp-incident-report-supplement', 'isp-user': 'isp-user-notice', 'isp-user-additional': 'isp-user-additional' } as const)[c.family];
      const recipient = ({ possibility: 'all-possibly-affected-subjects', confirmed: 'affected-subjects', 'additional-notice': 'affected-subjects',
        'no-leak': 'previously-notified-subjects', report: 'PIPC-or-KISA', 'additional-report': 'PIPC-or-KISA', medical: 'MOHW',
        'isp-report': 'MSIT-or-KISA', 'isp-supplement': 'MSIT-or-KISA', 'isp-user': 'affected-users', 'isp-user-additional': 'affected-users' } as const)[c.family];
      const numericIsp = ['isp-report', 'isp-supplement'].includes(c.family), numeric = ['possibility', 'confirmed', 'report'].includes(c.family) || numericIsp;
      let originalDueAt = numericIsp ? new Date(Date.parse(c.at) + IMMEDIATE_TIMING_RULE.ispHours * 3600000).toISOString() : numeric ? hours72(c.at) : IMMEDIATE_TIMING_RULE.dueAt;
      const replaces = c.family === 'confirmed' ? dutySources.filter(x => x.family === 'possibility' && covers(c.recipients, x.recipients) &&
        !satisfiesPossible(x, c.at) &&
        CONFIRMATION_REPLACEMENT_RULE.within(c.at, hours72(x.at), delays.some(d => d.obligationKey === key(x.family, x.eventId, x.recipients) &&
          d.accepted && DELAY_RULE.decider(d.decider, owner.id) && !!d.causalReview && d.category === 'force-majeure' && d.startedAt <= hours72(x.at) &&
          !delays.some(next => next.supersedes === d.delayId) && d.startedAt <= c.at && (d.clearedAt === null || c.at <= d.clearedAt)))) : [];
      for (const replaced of replaces) originalDueAt = CONFIRMATION_REPLACEMENT_RULE.due(hours72(replaced.at), originalDueAt);
      const requiredFields = c.family === 'isp-report' ? IMMEDIATE_TIMING_RULE.ispReportFields : c.family === 'isp-user' ? userNoticeFields(c.fact) :
        ['isp-supplement', 'isp-user-additional'].includes(c.family) ? ['newly-confirmed-facts'] : c.family === 'possibility' ? possibleFields :
        c.family === 'no-leak' ? ['no-leak-confirmed', 'prior-possible-notice-reference'] : c.family === 'medical' ? ['institution-name', 'incident-time', 'damage-details', 'technical-support-request'] :
        c.family === 'additional-notice' ? ['newly-confirmed-facts', 'legal-rights-and-exercise'] : c.family === 'additional-report' ? ['newly-confirmed-facts'] :
        mode ? LEAK_NOTICE_FIELDS : ['leak-confirmed', 'facts-known-so-far', ...LEAK_NOTICE_FIELDS.slice(2, c.family === 'report' ? 5 : undefined)];
      const basis = ({ possibility: ['privacy:34.2', 'privacy-decree:39-2', 'privacy-decree:39-3.1'], confirmed: ['privacy:34.1', 'privacy-decree:39.1', 'privacy-decree:39.2'],
        'additional-notice': ['privacy-decree:39.2'], 'no-leak': ['privacy-decree:39-3.3'], report: ['privacy:34.4', 'privacy-decree:40.1', 'privacy-decree:40.2'],
        'additional-report': ['privacy-decree:40.2'], medical: ['medical:23-3.1', 'medical-rules:16-2.1'],
        'isp-report': reportLaw ? [reportLaw.displayedBasis, reportLaw.relatedBasis.methods] : [],
        'isp-supplement': reportLaw ? [reportLaw.relatedBasis.supplement] : [],
        'isp-user': ['network:48-3.4', 'network-decree:58-9'], 'isp-user-additional': ['network-decree:58-9.3'] })[c.family];
      if (replaces.length) basis.push('privacy-decree:39-3.2');
      obligations.push({ obligationKey: key(c.family, c.eventId, c.recipients), family: c.family, triggerEventId: c.eventId, recipientScopeRef: c.recipients,
        kind, recipient, triggeredAt: c.at, discoveredAt: c.discoveredAt ?? null, originalDueAt, dueAt: originalDueAt,
        timing: numericIsp ? 'within-24-hours' : numeric ? 'without-delay-within-72-hours' : 'immediate', requiredFields, basis,
        status: 'pending', stillOwed: true, actionRequiredNow: !numeric, notice: null, noticeRefs: [],
        causeRefs: [c.eventId, c.fact.evidenceId, ...(c.fact.supersedes ? [c.fact.supersedes] : []), ...replaces.map(x => x.eventId).sort(),
          ...(c.family === 'no-leak' ? possibleNotices.filter(n => covers(n.recipientScopeRef, c.recipients)).map(n => n.noticeId) : [])],
        elapsedMs: 0, lateByMs: null, sinceDiscoveryMs: null, sinceClearanceMs: null, timeliness: IMMEDIATE_TIMING_RULE.timeliness,
        delayRefs: [], decisionRefs: [], replacedBy: null, reasonCode: null, observations: [], corrections: [],
        verdictRefs: [...new Set(c.verdictRefs ?? [c.fact.verdictId])].sort(), warnings: [], designationUnverified: false,
        obligationOwner: { ...owner }, sinceHospitalKnowledgeMs: null, applicability: applicability === 'unknown' ? 'unverified' : 'verified', audience: 'privacy-officer',
        provisionalResponseDueAt: applicability === 'unknown' ? originalDueAt : null, provisionalDeadlinePassed: false, closureGround: null });
    }
    // Every piece of evidence must have a unique destination; reject the whole snapshot if a reference is unusable.
    const belongs = (n: BoundNotice, o: IncidentObligation) => DUTY_FAMILY[n.kind] === o.family && n.triggerEventId === o.triggerEventId &&
      (n.triggeredAt === o.triggeredAt || (o.family === 'no-leak' && n.triggeredAt >= o.triggeredAt)) &&
      (n.recipientScopeRef === o.recipientScopeRef || (o.family === 'no-leak' && covers(n.recipientScopeRef, o.recipientScopeRef)) || (!n.coversAll && o.family === 'possibility'));
    const operatorEvidence = (n: BoundNotice) => owner.kind === 'operator' && [...dutySources, ...followupMap.values()].some(c => !c.family.startsWith('isp-') &&
      c.family === DUTY_FAMILY[n.kind] && c.eventId === n.triggerEventId && (c.at === n.triggeredAt || (c.family === 'no-leak' && c.at <= n.triggeredAt)) &&
      (c.recipients === n.recipientScopeRef || covers(c.recipients, n.recipientScopeRef)));
    for (const n of notices) if (!obligations.some(o => belongs(n, o)) && !operatorEvidence(n) && !dutySources.some(c => c.family === DUTY_FAMILY[n.kind] &&
      c.family.startsWith('isp-') && c.eventId === n.triggerEventId && (ispStatus(c.fact.ispIncident.eventId) === false ||
        (['isp-report', 'isp-supplement'].includes(c.family) && ispLawAt(c.at).taskPolicy) ||
        (['isp-user', 'isp-user-additional'].includes(c.family) && !ispUserApplicable(c.fact.ispIncident.eventId))))) throw new Error('Unbound notice scope');
    for (const d of delays) {
      const o = obligations.find(o => o.obligationKey === d.obligationKey);
      if (!o || d.clause !== DELAY_RULE.clauses[o.family] || d.startedAt < o.triggeredAt) throw new Error('Wrong delay provision');
      if (d.accepted && (d.version !== DELAY_RULE.version || !DELAY_RULE.categories[o.family]?.includes(d.category) || (o.originalDueAt && d.startedAt > o.originalDueAt))) throw new Error('Delay category or onset does not qualify');
      if (d.supersedes) { const old = delays.find(x => x.delayId === d.supersedes);
        if (!old || old.obligationKey !== d.obligationKey || old.recordedAt > d.recordedAt || old.startedAt !== d.startedAt ||
            old.clause !== d.clause || old.version !== d.version || old.delayId === d.delayId || delays.some(x => x.delayId !== d.delayId && x.supersedes === old.delayId)) throw new Error('Invalid delay correction'); }
      const visited = new Set([d.delayId]); let parent = delays.find(x => x.delayId === d.supersedes);
      while (parent) { if (visited.has(parent.delayId)) throw new Error('Cyclic delay correction'); visited.add(parent.delayId); parent = delays.find(x => x.delayId === parent.supersedes); }
    }
    for (const d of decisions) if (!obligations.some(o => o.obligationKey === d.obligationKey && o.triggeredAt <= d.at &&
      (d.effect !== 'report-exemption' || o.family === 'report'))) throw new Error('Unbound decision');
    // 4. Calculate performance separately from timing and final judgments. A late delivery can fulfill the duty.
    for (const o of obligations) {
      const matching = notices.filter(n => belongs(n, o)).sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.noticeId.localeCompare(b.noticeId));
      const direct = completion(matching.filter(n => postingReady(n) && (!n.posting || o.requiredFields.every(k => n.coveredFields.includes(k)))), o.recipientScopeRef);
      // D839: attached other-law evidence does not establish the operator's own ISP performance.
      const deemed = notices.filter(n => owner.kind !== 'operator' && postingReady(n) && performedAt(n) >= o.triggeredAt && (
        o.family === 'isp-report' ? NO_LEAK_CLOSURE_RULE.deemedReportKinds.includes(n.kind) &&
          ['MOHW-official', 'MOHW-delegated', 'PIPC', 'KISA'].includes(n.channel) && o.requiredFields.every(k => n.coveredFields?.includes(k)) :
        o.family === 'isp-supplement' ? NO_LEAK_CLOSURE_RULE.supplementDeemed.kinds.includes(n.kind) &&
          ['MSIT', 'KISA'].includes(n.channel) && o.requiredFields.every(k => n.coveredFields?.includes(k)) :
        ['isp-user', 'isp-user-additional'].includes(o.family) ? NO_LEAK_CLOSURE_RULE.deemedUserKinds.includes(n.kind) &&
          noticeCovers(n, o.recipientScopeRef) && o.requiredFields.every(k => n.coveredFields?.includes(k)) : false
      )).sort((a, b) => performedAt(a).localeCompare(performedAt(b)))[0];
      const residual = o.family === 'possibility' ? notices.find(n => ['confirmed-leak', 'confirmed-priority'].includes(n.kind) &&
        n.triggeredAt > o.originalDueAt && postingReady(n) && noticeCovers(n, o.recipientScopeRef) && possibleFields.every(k => n.coveredFields?.includes(k))) : undefined;
      const fulfilled = [direct, deemed, residual].filter(Boolean).sort((a, b) => performedAt(a).localeCompare(performedAt(b)))[0];
      o.noticeRefs = matching.map(n => n.noticeId).sort();
      if (deemed && !o.noticeRefs.includes(deemed.noticeId)) o.noticeRefs = [...o.noticeRefs, deemed.noticeId].sort();
      if (residual && !o.noticeRefs.includes(residual.noticeId)) o.noticeRefs = [...o.noticeRefs, residual.noticeId].sort();
      if (fulfilled) o.notice = { noticeId: fulfilled.noticeId, sentAt: fulfilled.sentAt };
      const replacementSources = o.family === 'confirmed' ? obligations.filter(x => x.family === 'possibility' && covers(o.recipientScopeRef, x.recipientScopeRef) && o.causeRefs.includes(x.triggerEventId)) : [];
      const applicableDelays = delays.filter(d => d.obligationKey === o.obligationKey);
      const activeDelays = applicableDelays.filter(d => d.accepted && DELAY_RULE.decider(d.decider, owner.id) && !delays.some(x => x.supersedes === d.delayId));
      // Independent causal reasons keep their clearance times; every accepted cause must have cleared before action resumes.
      const delay = activeDelays.length ? { clearedAt: activeDelays.some(d => d.clearedAt === null) ? null : activeDelays.map(d => d.clearedAt).sort().slice(-1)[0] } : undefined;
      o.delayRefs = applicableDelays.map(d => d.delayId).sort();
      const inheritedDelays = delays.filter(d => replacementSources.some(x => d.obligationKey === x.obligationKey) && d.accepted &&
        DELAY_RULE.decider(d.decider, owner.id) && !delays.some(x => x.supersedes === d.delayId));
      if (inheritedDelays.length) {
        o.delayRefs = [...o.delayRefs, ...inheritedDelays.map(d => d.delayId)].sort();
        // The possibility delay does not grant a separate exemption from the confirmed-notice provision.
        o.dueAt = null; o.timing = 'immediate';
      }
      if (delay) { o.dueAt = delay.clearedAt === null ? null : DELAY_RULE.clearedDueAt(delay.clearedAt);
        o.timing = delay.clearedAt === null ? 'deferred-until-cause-cleared' : 'immediate'; o.timeliness = 'delay-accepted'; }
      const boundDecisions = decisions.filter(d => d.obligationKey === o.obligationKey);
      o.decisionRefs = boundDecisions.map(d => d.decisionId).sort();
      o.designationUnverified = [...applicableDelays, ...boundDecisions].some(d => !DELAY_RULE.decider(d.decider, owner.id));
      let retiredUserDuty = false;
      let userRetirementGround: IncidentObligation['closureGround'] = null;
      if (['isp-user', 'isp-user-additional'].includes(o.family)) {
        const event = dutySources.find(c => c.family === o.family && c.eventId === o.triggerEventId).fact.ispIncident;
        const assessment = ispAssessments.find(x => x.eventId === event.eventId);
        o.decisionRefs = [...o.decisionRefs, ...assessment.userNotice.decisionRefs];
        o.reasonCode = assessment.userNotice.reasonCode;
        retiredUserDuty = !ispUserApplicable(event.eventId) && assessment.userNotice.applicability === 'not-applicable';
        const rule = ispUserRules.get(event.eventId);
        if (retiredUserDuty) { o.replacedBy = rule.retirement.ref; userRetirementGround = rule.retirement.ground; }
        if (rule.occurrences.some(x => x.correction)) o.causeRefs = [...new Set([...o.causeRefs,
          ...rule.occurrences.flatMap(x => [x.evidenceId, ...(x.correction ? [x.correction.supersedes, x.correction.evidenceId] : [])])])].sort();
        o.designationUnverified ||= !DELAY_RULE.decider(event.userImpact.decider, owner.id) ||
          facts.some(v => v.ispIncident?.eventId === event.eventId && v.ispIncident.userNoticeDecision && !DELAY_RULE.decider(v.ispIncident.userNoticeDecision.decider, owner.id));
      }
      const final = boundDecisions.find(d => d.effect === 'final-breach');
      const exemption = boundDecisions.find(d => d.effect === 'report-exemption' && DELAY_RULE.decider(d.decider, owner.id));
      const current = currentFor(o.recipientScopeRef);
      if (o.family !== 'no-leak') o.verdictRefs = current ? [current.id] : [];
      const causeEvidenceAt = Math.max(...causes.filter(c => c.family === o.family && c.eventId === o.triggerEventId).map(c => Date.parse(c.evidenceAt ?? c.at)));
      const changed = current && current.at >= o.triggeredAt && Date.parse(current.at) > causeEvidenceAt && current.status === 'not-a-leak' &&
        NO_LEAK_CLOSURE_RULE.canMoot(current.at, o.originalDueAt) ? current : undefined;
      const replacing = o.family === 'possibility' ? obligations.find(x => x.family === 'confirmed' && x.causeRefs.includes(o.triggerEventId) && covers(x.recipientScopeRef, o.recipientScopeRef)) : undefined;
      const substitution = replacing ? notices.find(n => belongs(n, replacing) && postingReady(n) && noticeCovers(n, o.recipientScopeRef) &&
        possibleFields.every(k => n.coveredFields?.includes(k))) : undefined;
      const retiredFollowup = o.family === 'no-leak' && current && (current.status !== 'not-a-leak' || consecutiveRoot(current, o.recipientScopeRef).id !== o.triggerEventId) ? current : undefined;
      o.replacedBy = substitution ? replacing.obligationKey : retiredFollowup?.id ?? o.replacedBy;
      if (retiredFollowup) { o.verdictRefs = [...new Set([...o.verdictRefs, retiredFollowup.id])].sort(); o.causeRefs = [...new Set([...o.causeRefs, retiredFollowup.id])]; }
      if (o.family === 'no-leak' && NO_LEAK_FOLLOWUP_RULE.warnOnPostVerdictSend && possibleNotices.some(n => covers(n.recipientScopeRef, o.recipientScopeRef) &&
          n.sentAt > verdicts.find(v => v.id === o.triggerEventId).at)) o.warnings = ['possibility-notice-sent-after-no-breach-verdict'];
      if (fulfilled) o.status = 'met';
      else if (retiredUserDuty) o.status = 'moot';
      else if (exemption) o.status = 'exempt';
      else if (retiredFollowup) o.status = 'moot';
      else if (substitution) o.status = 'met';
      else if (final) o.status = 'missed';
      else if (!matching.length && !delay && changed && ['possibility', 'confirmed', 'report'].includes(o.family)) {
        o.status = 'moot'; if (changed) o.causeRefs = [...o.causeRefs, changed.id];
      } else if ((o.dueAt !== null && asOf > o.dueAt) || boundDecisions.some(d => d.effect === 'timeliness-overdue')) o.status = 'overdue';
      else o.status = IMMEDIATE_TIMING_RULE.status;
      if (substitution && !fulfilled) { o.noticeRefs = [...new Set([...o.noticeRefs, substitution.noticeId])].sort(); o.notice = { noticeId: substitution.noticeId, sentAt: substitution.sentAt }; }
      o.closureGround = fulfilled ? fulfilled.posting ? 'posting' : 'actual-notice' : retiredUserDuty ? userRetirementGround : exemption ? 'report-exemption' : retiredFollowup ? 'verdict-replaced' : substitution ? 'confirmed-notice-substitution' : null;
      if (final) o.timeliness = 'final-breach';
      else if (boundDecisions.some(d => d.effect === 'timeliness-overdue')) o.timeliness = 'overdue-determined';
      if (o.applicability === 'unverified' && !retiredUserDuty) { o.status = 'unverified-pending'; o.dueAt = null; o.closureGround = null;
        o.timeliness = 'requires-review';
        o.provisionalDeadlinePassed = o.provisionalResponseDueAt !== null && asOf > o.provisionalResponseDueAt && !fulfilled; }
      o.stillOwed = o.applicability === 'unverified' && !retiredUserDuty ? !fulfilled : !['met', 'moot', 'exempt'].includes(o.status);
      o.actionRequiredNow = o.stillOwed && o.timing !== 'deferred-until-cause-cleared';
      const end = fulfilled ? performedAt(fulfilled) : substitution ? performedAt(substitution) : asOf;
      o.elapsedMs = elapsed(o.triggeredAt, end);
      o.lateByMs = o.applicability === 'unverified' || o.originalDueAt === null ? null : elapsed(o.originalDueAt, end);
      o.sinceDiscoveryMs = o.discoveredAt === null ? null : elapsed(o.discoveredAt, end);
      o.sinceHospitalKnowledgeMs = owner.kind === 'hospital' ? elapsed(f.hospitalKnownAt ?? f.awarenessAt, end) : f.hospitalKnownAt ? elapsed(f.hospitalKnownAt, end) : null;
      const clearedAt = delay?.clearedAt ?? (inheritedDelays.length && inheritedDelays.every(d => d.clearedAt) ? inheritedDelays.map(d => d.clearedAt).sort().slice(-1)[0] : null);
      o.sinceClearanceMs = clearedAt ? elapsed(clearedAt, end) : null;
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
      obligationOwner: { ...owner }, ispAssessments, recipientScopes, ledger: { findings, notices, delays, decisions }, obligations, status: 'planned' as const });
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
