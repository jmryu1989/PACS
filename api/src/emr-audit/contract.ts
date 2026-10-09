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
  identified: readonly { patient: { patientId: string; assigningAuthority: string }; eventIds: readonly string[]; firstAt: string; lastAt: string }[];
  /** False when the people affected cannot be identified: the possible-leak notice of 제34조② (시행령 제39조의2①1) applies. */
  subjectsIdentifiable: boolean;
  reasons: readonly ({ kind: 'ledger-unreadable'; code: string } | { kind: IncidentDetermination['kind']; note: string; by: ImmutableIdentity })[];
}
/** Every matching event of an export plan (period, patient, actor, address, event types). Refused and failed requests
 * provided nothing and name no one. A ledger read or integrity failure is itself the fact that the subjects cannot be
 * identified, and is reported as such — never as "nobody affected". */
export async function incidentScope(authority: AuditAuthority, plan: InvestigationPlan, ledger: InvestigationLedger,
  determinations: readonly IncidentDetermination[] = []): Promise<Readonly<IncidentScope>> {
  requireScope(authority, 'investigate');
  if (!plans.has(plan) || plan.mode !== 'export') refuse('IncidentScopeNeedsCompleteRead');
  if (plan.institutionId !== authority.institutionId) refuse('AuditScopeNotGranted');
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
  return freeze({ institutionId: plan.institutionId, filters: plan.filters, top: page?.top ?? null, identified,
    subjectsIdentifiable: reasons.length === 0, reasons });
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
  formatVersion: 'emr-disclosure/1'; requestId: string; receivedAt: string; institutionId: string; patient: PatientLinkSnapshot;
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
    formatVersion: 'emr-disclosure/1', requestId: request.requestId, receivedAt: request.receivedAt, institutionId: approval.institutionId,
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
  for (const record of issuance.manifest.records) {
    const l = now.find(x => x.recordId === record.recordId), head = l?.versions[l.versions.length - 1];
    if (!l || l.revision !== record.revision || head.versionId !== record.head.versionId || head.sha256 !== record.head.sha256) refuse('RecordHeadChanged');
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
  requestId: string; kind: RightsRequestKind; receivedAt: string; decidedBy: ImmutableIdentity; decidedAt: string;
  records: readonly { recordId: string; disposition: ReturnType<typeof retentionDisposition>; outcome: RightsOutcome; basis: readonly string[] }[];
  notice: { content: 'action-taken' | 'refusal-with-reason-and-objection-method'; dueBy: string };
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
  return freeze({ requestId: r.requestId, kind: r.kind, receivedAt: r.receivedAt, decidedBy: authority.subject, decidedAt: r.at, records: decided,
    notice: { content: refusedAny ? 'refusal-with-reason-and-objection-method' : 'action-taken', dueBy } });
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
  const v = object(e, ['kind', 'at', ...keys]); utc(v.at);
  if (kind === 'report-generated') {
    if (v.generator !== 'system') throw new Error('Reports are generated by the system');
    sha256(v.reportSha256); integer(v.eventCount); uniqueStrings(v.downloadEventIds, true);
  } else identity(v.by);
  if (kind === 'reviewed') choice(v.conclusion, ['no-anomaly', 'anomaly-found']);
  if (kind === 'download-reason') { string(v.eventId); string(v.reason); choice(v.outcome, ['legitimate', 'investigate']); }
  if (kind === 'investigation-opened') { string(v.investigationId); uniqueStrings(v.eventIds); string(v.summary); }
  if (kind === 'action-recorded') { string(v.investigationId); string(v.action); }
  if (kind === 'rechecked') { string(v.investigationId); choice(v.result, ['resolved', 'not-resolved']); }
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
    for (const e of events) {
      if ((e.kind === 'action-recorded' || e.kind === 'rechecked') && !investigations.has(e.investigationId)) throw new Error('Unknown investigation');
      if (e.kind === 'download-reason' && !report.downloadEventIds.includes(e.eventId)) throw new Error('Not a download of this month');
    }
    const missingDownloadReasons = report ? report.downloadEventIds.filter(id => !reasons.has(id)) : [];
    const covered = new Set([...investigations.values()].flatMap(i => i.eventIds));
    const uninvestigated = [...reasons.values()].filter(r => r.outcome === 'investigate' && !covered.has(r.eventId)).map(r => r.eventId);
    const openInvestigations = [...investigations.keys()].filter(id => {
      const acted = events.some(e => e.kind === 'action-recorded' && e.investigationId === id);
      const recheck = events.filter(e => e.kind === 'rechecked' && e.investigationId === id).pop();
      return !acted || recheck?.result !== 'resolved';
    });
    const anomalyOpen = review?.conclusion === 'anomaly-found' && investigations.size === 0;
    const open: InspectionState = !report ? 'awaiting-report' : !review ? 'report-only' :
      missingDownloadReasons.length || uninvestigated.length || openInvestigations.length || anomalyOpen ? 'in-follow-up' : 'ready-to-close';
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
  if (step?.kind === 'report-generated' || (step && Object.prototype.hasOwnProperty.call(step, 'by'))) refuse('InspectionStepRefused');
  if (before.state === 'awaiting-report') refuse('InspectionReportRequired');
  const next = { ...cycle, events: [...cycle.events, { ...step, by: authority.subject }] };
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
      if (resolution.at < receivedAt) throw new Error('Resolution before receipt');
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
    string(h.holdId); string(h.recordId); utc(h.at);
    choice(h.basis?.type, ['pending-access-request', 'statutory-duty']);
    object(h.basis.validity, ['from', 'until', 'condition']); utc(h.basis.validity.until);
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
  if (hold.release !== null) return freeze({ preserve: false, state: 'released', dueAt: due });
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
