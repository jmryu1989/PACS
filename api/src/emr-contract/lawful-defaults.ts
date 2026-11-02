import { emrAdapters, isEmrReader } from './composition';
import { randomUUID } from 'node:crypto';
import { RECORD_CLASSIFICATION, RecordKind, PurposeEnd, ResolvedRecord, verifiedRecord, resolveStoredRecord,
  OrderFacts, parseOrderFacts, parseOrderProcedure } from './classification';
import { STATUTORY_MINIMUM, HOLD_DUTY_CLAUSES, HOLD_CLAUSE_VERSIONS, ClauseVersion, clauseVersionAt } from './legal-basis';
import { choice, freeze, object, string, utc, refuse } from './validation';

export interface RecordPolicy { retentionYears: number; accessYears: number; requireSignature: boolean }
export type ProductConfiguration = Readonly<Record<RecordKind, Readonly<RecordPolicy>>>;
export type Tightening = Partial<Record<RecordKind, { requireSignature?: boolean }>>;
const kinds = Object.keys(RECORD_CLASSIFICATION) as RecordKind[];
const validated = new WeakSet<object>();

export const PRODUCT_DEFAULTS = freeze({
  keepEveryVersion: true, recordAuthorTimeHash: true, logEveryAccess: true, automaticDestruction: true,
  retentionStart: 'each-content-part-own-start; unit-latest-part-expiry; Asia/Seoul-civil-calendar',
  linkedEvidence: 'complete-direct-components; own-deadlines-only; no-inherited-deadline-repropagation; navigation-excluded',
  disposal: 'operational-store-deletion-at-expiry; recovery-only-backups-supervised-and-reapplied-on-restore; no-personal-data-in-destruction-record',
  extension: 'continuing-treatment-only; once-per-record; at-most-its-statutory-period',
  retentionOnly: 'explicit-purpose-end-with-stored-lifecycle-event; separate-storage-and-restricted-access',
  clinicalContentInOperationalRecord: 'add-clinical-classification-before-saving',
  unknownRecordKind: 'reject',
});

export const DEFAULT_CONFIGURATION: ProductConfiguration = freeze(Object.fromEntries(kinds.map(kind => {
  const row = RECORD_CLASSIFICATION[kind];
  return [kind, { retentionYears: row.retention.years,
    accessYears: STATUTORY_MINIMUM.access.years,
    requireSignature: row.signature.rule === 'required' }];
})) as Record<RecordKind, RecordPolicy>);
validated.add(DEFAULT_CONFIGURATION);

function config(value: ProductConfiguration): ProductConfiguration {
  if (!validated.has(value)) throw new Error('Use tightenConfiguration to resolve and validate persisted settings');
  return value;
}
function fields(input: unknown, allowed: readonly string[]): Record<string, any> {
  const keys = input && typeof input === 'object' ? Object.keys(input) : [];
  const v = object(input, keys);
  if (keys.some(key => !allowed.includes(key))) throw new Error('Unknown configuration field');
  return v;
}

/** Persisted sparse settings resolve into a complete immutable policy. Explicit undefined is invalid. */
export function tightenConfiguration(input: unknown = {}, current: ProductConfiguration = DEFAULT_CONFIGURATION): ProductConfiguration {
  config(current);
  const overrides = fields(input, kinds);
  const result = Object.fromEntries(kinds.map(kind => {
    const base = current[kind];
    const v = Object.hasOwnProperty.call(overrides, kind) ? fields(overrides[kind], ['requireSignature']) : {};
    const requireSignature = Object.hasOwnProperty.call(v, 'requireSignature') ? v.requireSignature : base.requireSignature;
    if (typeof requireSignature !== 'boolean' || (base.requireSignature && !requireSignature)) throw new Error('Signature protection cannot be reduced');
    if (requireSignature && !['required', 'clinical-entry-only'].includes(RECORD_CLASSIFICATION[kind].signature.rule))
      throw new Error('Only human clinical authors can receive additional signature duties');
    return [kind, { retentionYears: base.retentionYears, accessYears: base.accessYears, requireSignature }];
  })) as Record<RecordKind, RecordPolicy>;
  const resolved = freeze(result);
  validated.add(resolved);
  return resolved;
}

/** Only actual classes of ONE record contribute. Call separately for linked records and access events. */
export function retentionFor(recordKinds: readonly RecordKind[], settings: ProductConfiguration = DEFAULT_CONFIGURATION): Readonly<RecordPolicy> {
  config(settings);
  if (!Array.isArray(recordKinds) || !recordKinds.length) throw new Error('At least one classified record required');
  const rows = recordKinds.map(kind => settings[choice(kind, kinds)]);
  return freeze({ retentionYears: Math.max(...rows.map(row => row.retentionYears)),
    accessYears: Math.max(...rows.map(row => row.accessYears)), requireSignature: rows.some(row => row.requireSignature) });
}

/** The default is the kind's described content. Clinical use of working material always invokes the statutory signature rule. */
export function signatureRequired(kind: RecordKind, use: 'described-content' | 'clinical-entry' = 'described-content',
  settings: ProductConfiguration = DEFAULT_CONFIGURATION): boolean {
  config(settings); choice(kind, kinds); choice(use, ['described-content', 'clinical-entry']);
  return settings[kind].requireSignature || use === 'clinical-entry';
}

export type StatutoryClass = keyof typeof STATUTORY_MINIMUM;
const DAY_MS = 86_400_000;
const SEOUL_MS = 9 * 3_600_000;

/**
 * Exclusive boundary of a statutory period counted from `startedAt` (Asia/Seoul civil days): the last civil day has fully
 * ended at this instant. D-21 (legal register §5-46): a period during which a duty imposed by law continues counts its
 * first day - the civil day of the starting event, whatever its time (행정기본법 제6조②1, not the Civil Act 157 rule) - and
 * ends at the end of the day before the corresponding day of the last year (민법 제159조·제160조①②), on a Saturday or
 * holiday too (행정기본법 제6조②2: no business-day shift). A 29 February start without one in the last year ends at the
 * end of 28 February (민법 제160조③), so the boundary is 1 March 00:00.
 */
export function civilPeriodEnd(startedAt: string, years: number): string {
  if (!Number.isSafeInteger(years) || years < 1) throw new Error('Whole positive calendar years required');
  const local = new Date(Date.parse(utc(startedAt)) + SEOUL_MS);
  const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  start.setUTCFullYear(start.getUTCFullYear() + years); // Feb 29 -> Mar 1 boundary (160(3)).
  if (!Number.isFinite(start.getTime()) || start.getUTCFullYear() > 9999) throw new Error('Unsupported period');
  return new Date(start.getTime() - SEOUL_MS).toISOString();
}
export function statutoryClasses(recordKinds: readonly RecordKind[]): readonly StatutoryClass[] {
  if (!Array.isArray(recordKinds) || !recordKinds.length || new Set(recordKinds).size !== recordKinds.length)
    throw new Error('Distinct classified record kinds required');
  const classes = new Set<StatutoryClass>();
  for (const kind of recordKinds) {
    const row = RECORD_CLASSIFICATION[choice(kind, kinds)];
    if (recordKinds.length > 1 && ['order', 'received-order'].includes(kind)) continue;
    if (row.retention.mode !== 'statutory') refuse('IndependentStatutoryClockRefused');
    for (const minimum of row.retention.statutoryMinimum) {
      classes.add((Object.keys(STATUTORY_MINIMUM) as StatutoryClass[]).find(key => STATUTORY_MINIMUM[key].clauseId === minimum.clauseId)!);
    }
  }
  if (classes.has('access') && classes.size > 1) refuse('AccessUnitMixed');
  return freeze([...classes].sort());
}
export interface ContinuingTreatmentExtension {
  cause: 'continuing-treatment'; actorId: string; reason: string; at: string; until: string;
}
export interface RetentionPart { partId: string; startedAt: string; evidence: ResolvedRecord }
export interface LegalHold {
  holdId: string; recordId: string; basis: {
    type: 'court-order' | 'investigative-order' | 'supervisory-order' | 'statutory-duty' | 'pending-access-request';
    clause: { law: string; article: string; version: string }; clauseId: string;
    requestId: string; authorityId: string; authorityKind: string; managingInstitutionId: string;
    scope: readonly string[]; verified: true;
    validity: { from: string; until: string | null; condition: 'order-in-force' | 'duty-active' | 'request-pending' };
  };
  actorId: string; at: string;
  release: { holdId: string; actorId: string; at: string; evidenceId: string; authorityVerified: true } & (
    { reason: 'order-ended' | 'request-fulfilled' | 'request-withdrawn' | 'request-refused' | 'duty-ended' } |
    { reason: 'effect-ended'; endingFact: { kind: 'validity-expired'; at: string } | { kind: 'request-resolved'; at: string; eventId: string } }
  ) | null;
}
export interface AccessRequestFacts {
  requestId: string; recordIds: readonly string[]; receivedAt: string; responseDueAt: string;
  resolution: { eventId: string; at: string; outcome: 'fulfilled' | 'withdrawn' | 'lawfully-refused' } | null;
}
export interface LegalDutyReader {
  load(holdId: string): unknown;
  listHolds(recordId: string): unknown;
  loadAccessRequest?(requestId: string): unknown;
  loadCorrectionRequest?(requestId: string): unknown;
  loadStatutoryDuty?(requestId: string): unknown;
  /** I's verified history supplies dates before the first built-in version, or external order grounds. */
  loadClauseVersions?(clauseId: string): readonly ClauseVersion[];
}
const dutySources = new WeakMap<object, LegalDutyReader>();
const verifiedDuties = new WeakSet<object>();
export interface RetentionRecord {
  recordId: string; disposalUnitId: string; kinds: readonly RecordKind[]; parts: readonly RetentionPart[];
  extension: ContinuingTreatmentExtension | null; holds: readonly LegalHold[]; destroyedAt: string | null;
}
function opaqueUnit(value: unknown): string {
  const id = string(value);
  if (!/^disposal:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('Opaque disposal unit required');
  return id;
}
function yearsFor(recordKinds: readonly RecordKind[]): number {
  const classes = statutoryClasses(recordKinds);
  return classes.length ? Math.max(...classes.map(c => STATUTORY_MINIMUM[c].years)) : retentionFor(recordKinds).retentionYears;
}
function partDeadline(record: Pick<RetentionRecord, 'kinds' | 'parts'>): string {
  return record.parts.map(p => {
    const s = p.evidence;
    if (s.model === 'Order' || s.model === 'emr_access.order_fact') {
      const ends = orderRetentionDuties(s).map(d => civilPeriodEnd(d.startedAt, d.years));
      if (!ends.length) refuse('IndependentStatutoryClockRefused');
      return ends.sort().slice(-1)[0];
    }
    return civilPeriodEnd(p.startedAt, yearsFor(record.kinds));
  }).sort().slice(-1)[0];
}

/** Each obligation keeps its own origin. A received copy can carry all three feed roles at once. */
export function orderRetentionDuties(source: ResolvedRecord): readonly { kind: RecordKind; startedAt: string; years: number }[] {
  const s = verifiedRecord(source), r = parseOrderFacts(s.row);
  const duty = (kind: RecordKind, startedAt: string) => ({ kind, startedAt: utc(startedAt), years: RECORD_CLASSIFICATION[kind].retention.years });
  if (r.objectKind === 'order-indication') return freeze([duty('order-indication', s.event.at)]);
  if (r.objectKind === 'exam-clinical-info') return freeze([duty('exam-clinical-info', s.event.at)]);
  const result = r.inherited.map(d => duty(d.kind, d.startedAt));
  if (r.fulfilment) result.push(duty('order-exam-component', r.objectKind === 'received-order' ? r.firstReceivedAt! : r.fulfilment.at), duty('patient-match', r.fulfilment.at));
  if (r.chartIncorporation) result.push(duty('chart-incorporation', r.chartIncorporation.at));
  return freeze(result);
}

/** D-24 §2: time passing never establishes a classification or removes a duty; only the recorded decision clears a review. */
export function orderProcedureState(input: OrderFacts, at: string): 'clear' | 'pending' | 'duty-continues' {
  const r = parseOrderFacts(input); utc(at);
  if (!r.procedure) return 'clear';
  const d = r.procedure.decision;
  if (!d || d.at > at) return 'pending';
  // A continued duty past its review date is open again, never a silent indefinite authorization.
  if (d.route === 'duty-continues') return at >= d.reviewAt! ? 'pending' : 'duty-continues';
  return 'clear';
}

/** Checked under the order's storage lock. A review is never dropped; only a continued duty's later review replaces its decision. */
export function validateOrderTransition(previous: OrderFacts, next: OrderFacts): void {
  const before = parseOrderFacts(previous), after = parseOrderFacts(next);
  if (before.objectKind !== after.objectKind || before.origin !== after.origin || before.authorId !== after.authorId ||
      before.authorRole !== after.authorRole || before.directionSourceRef && JSON.stringify(before.directionSourceRef) !== JSON.stringify(after.directionSourceRef) ||
      before.source && JSON.stringify(before.source) !== JSON.stringify(after.source) || before.firstReceivedAt !== after.firstReceivedAt ||
      before.firstReceiptEventId !== after.firstReceiptEventId) refuse('NoShorteningOfEstablishedDuty');
  if (before.inherited.some(d => !after.inherited.some(n => JSON.stringify(d) === JSON.stringify(n))) ||
      (before.fulfilment && JSON.stringify(before.fulfilment) !== JSON.stringify(after.fulfilment)) ||
      (before.chartIncorporation && JSON.stringify(before.chartIncorporation) !== JSON.stringify(after.chartIncorporation)))
    refuse('NoShorteningOfEstablishedDuty');
  if (before.feed?.roles.some(role => role !== 'worklist-copy' && !after.feed?.roles.includes(role))) refuse('NoShorteningOfEstablishedDuty');
  if (after.statusEvent.at < before.statusEvent.at) refuse('OrderEventSequenceRefused');
  if (before.scheduledAt !== after.scheduledAt && (!after.scheduleChangeEvidenceId || after.scheduleChangeEvidenceId === before.scheduleChangeEvidenceId))
    refuse('OrderExtensionEvidenceRequired');
  if (before.procedure) {
    const p = before.procedure, n = after.procedure;
    if (!n) refuse('OrderProcedureRequired');
    if (p.decision && JSON.stringify(p.decision) !== JSON.stringify(n.decision) &&
        (p.decision.route !== 'duty-continues' || !n.decision || n.decision.at <= p.decision.at ||
         n.decision.evidenceId === p.decision.evidenceId)) refuse('OrderDecisionBindingRefused');
  }
}
/**
 * D-21 starting events (legal register §5-46, pinned): the event each statutory period of a part counts from. A part's
 * startedAt is the time of one of its row's acts - for a signed act that time is the signature's signedAt
 * (resolveStoredRecord binds the two) - and the first day of the period is that event's civil day (civilPeriodEnd).
 */
export const PERIOD_START = freeze({
  signed: { acts: ['entry', 'additional-entry', 'correction'], from: 'the signed version (report, Addendum, every signed clinical entry): its signedAt' },
  'received-order': { acts: ['receipt'], from: 'the first verified local-version receipt of an adopted component; duplicate reception never starts a new part' },
  inherited: { acts: ['receipt'], from: 'each entrusted source record and version: its verified original start, never the local receipt' },
  'critical-result-ack': { acts: ['handoff-ack'], from: 'the acknowledgment' },
  'access-audit': { acts: ['access'], from: 'the access event time' },
  'delivery-receipt': { acts: ['delivery'], from: 'the delivery event time' },
  acquired: { acts: ['acquisition', 'correction'], from: 'the image or its metadata: acquisition or receipt (a correction is its own part)' },
  other: { acts: ['creation', 'entry', 'additional-entry', 'correction'], from: 'the stored creation or entry (Tech Note, measurement, roster link event, chart incorporation)' },
  extension: { acts: [], from: 'the continuing-treatment decision, made before the base expiry (extendRetention)' },
  hold: { acts: [], from: 'the hold basis validity, from..until (placeLegalHold)' },
} as const);
export type PeriodStartRow = keyof typeof PERIOD_START;
/** Which PERIOD_START row a stored part's kinds select. */
export function periodStartRow(source: ResolvedRecord): PeriodStartRow {
  const s = verifiedRecord(source);
  if ((s.model === 'Order' || s.model === 'emr_access.order_fact') && s.row.objectKind === 'received-order')
    return s.row.inherited.length ? 'inherited' : 'received-order';
  if (s.kinds.some(k => RECORD_CLASSIFICATION[k].signature.rule === 'required') || s.row.clinicalEntry === true) return 'signed';
  for (const kind of ['received-order', 'critical-result-ack', 'access-audit', 'delivery-receipt'] as const) if (s.kinds.includes(kind)) return kind;
  return s.kinds.some(k => ['image', 'external-sr-seg', 'study-metadata'].includes(k)) ? 'acquired' : 'other';
}
function lawfulPart(source: ResolvedRecord): RetentionPart {
  const s = verifiedRecord(source), e = s.event;
  if (s.kinds.includes('order-indication') && s.row.objectKind === 'order-indication' && e.act === 'creation' && e.signature === null)
    return { partId: e.versionId, startedAt: e.at, evidence: s }; // A missing signature is a defect, never a zero-year record.
  const row = periodStartRow(s), signature = row === 'signed';
  const allowed: readonly string[] = PERIOD_START[row].acts;
  if (!signature && ['receipt', 'acquisition', 'handoff-ack', 'access', 'delivery'].includes(e.act) && e.signature !== null) refuse('ProductSignatureRefused');
  if (!allowed.includes(e.act) || (signature && !e.signature)) refuse('NewLawfulRecordEventRequired');
  return { partId: e.versionId, startedAt: e.at, evidence: s };
}
export function newRetentionRecord(source: ResolvedRecord, graph?: RetentionGraph): Readonly<RetentionRecord> {
  const s = verifiedRecord(source);
  if (s.kinds.some(k => ['access-audit', 'delivery-receipt'].includes(k))) refuse('AccessRetentionConstructorRequired');
  if (s.kinds.includes('critical-result-ack')) refuse('CvrParentRequired');
  if (s.kinds.includes('study-correction')) refuse('CorrectionSourceRequired');
  validateNewComponents(s, graph);
  return createRetentionRecord(s);
}
/** Only the parsed access/delivery event adapter may provide this stored evidence. */
export function newAccessRetentionRecord(source: ResolvedRecord): Readonly<RetentionRecord> {
  const s = verifiedRecord(source);
  if (s.kinds.length !== 1 || !['access-audit', 'delivery-receipt'].includes(s.kinds[0])) refuse('AccessRecordRequired');
  return createRetentionRecord(s);
}
function createRetentionRecord(s: ResolvedRecord): Readonly<RetentionRecord> {
  return parseRetentionRecord({ recordId: s.recordId, disposalUnitId: `disposal:${randomUUID()}`, kinds: s.kinds,
    parts: [lawfulPart(s)], extension: null, holds: reloadLegalHolds(s.recordId), destroyedAt: null });
}
function readLegalDuty(reader: LegalDutyReader, holdId: string): Readonly<LegalHold> {
  if (!isEmrReader('legal', reader)) refuse('VerifiedHoldBasisRequired');
  const h = object(reader.load(string(holdId)), ['holdId', 'recordId', 'basis', 'actorId', 'at', 'release']);
  const b = object(h.basis, ['type', 'clause', 'clauseId', 'requestId', 'authorityId', 'authorityKind', 'managingInstitutionId', 'scope', 'verified', 'validity']);
  choice(b.type, ['court-order', 'investigative-order', 'supervisory-order', 'statutory-duty', 'pending-access-request']);
  let c: Record<string, any>;
  try { c = object(b.clause, ['law', 'article', 'version']); string(c.law); string(c.article); string(c.version); }
  catch { refuse('HoldClauseRequired'); }
  string(b.requestId); string(b.authorityId); string(h.actorId); string(h.recordId); utc(h.at);
  string(b.managingInstitutionId);
  if (b.type === 'statutory-duty') {
    const clause = Object.prototype.hasOwnProperty.call(HOLD_DUTY_CLAUSES, b.clauseId) ? HOLD_DUTY_CLAUSES[b.clauseId] : null;
    if (!clause || c.law !== clause.law || c.article !== clause.article) refuse('HoldClauseRequired');
    if (b.authorityKind !== clause.authority || b.authorityId !== b.managingInstitutionId) refuse('HoldAuthorityRefused');
  } else if (b.type === 'pending-access-request') {
    if (b.clauseId !== 'privacy:35.3' || c.law !== 'privacy' || c.article !== '35.3') refuse('HoldClauseRequired');
    if (b.authorityKind !== 'personal-information-controller' || b.authorityId !== b.managingInstitutionId) refuse('HoldAuthorityRefused');
  } else if (b.authorityKind !== ({ 'court-order': 'court', 'investigative-order': 'investigative-authority', 'supervisory-order': 'supervisory-authority' })[b.type]) refuse('HoldAuthorityRefused');
  if (typeof b.clauseId !== 'string' || !b.clauseId.trim()) refuse('HoldClauseRequired');
  const builtIn = Object.prototype.hasOwnProperty.call(HOLD_CLAUSE_VERSIONS, b.clauseId) ? HOLD_CLAUSE_VERSIONS[b.clauseId] : null;
  const beforeBuiltIn = builtIn && seoulDay(h.at) < builtIn.map(v => v.effectiveAt).sort()[0];
  const versions = !builtIn || beforeBuiltIn ? reader.loadClauseVersions?.(b.clauseId) : builtIn;
  const registeredClause = clauseVersionAt(versions, h.at);
  if (c.law !== registeredClause.law || c.article !== registeredClause.article || c.version !== registeredClause.publication) refuse('HoldClauseRequired');
  if (h.holdId !== holdId || b.verified !== true || !Array.isArray(b.scope) || !b.scope.includes(h.recordId) || new Set(b.scope).size !== b.scope.length)
    refuse('VerifiedHoldBasisRequired');
  b.scope.forEach(x => string(x));
  const v = object(b.validity, ['from', 'until', 'condition']); utc(v.from);
  const condition = b.type === 'pending-access-request' ? 'request-pending' : b.type === 'statutory-duty' ? 'duty-active' : 'order-in-force';
  if (v.condition !== condition || v.from > h.at || (v.until !== null && utc(v.until) <= h.at)) refuse('HoldValidityRefused');
  if (requestBasedHold(h as LegalHold)) {
    const request = readAccessRequest(reader, h as LegalHold);
    if (v.until === null || v.until > request.responseDueAt || h.at < request.receivedAt) refuse('HoldValidityRefused');
  }
  const claim = b.type === 'statutory-duty' && b.clauseId === 'nhi:96-4.1' ? claimDuty(reader, h as LegalHold) : null;
  if (claim && v.until !== null && claim.endedAt !== v.until) refuse('HoldValidityRefused');
  if (h.release !== null) {
    if (claim && (claim.endedAt === null || h.release.reason !== 'duty-ended' || h.release.evidenceId !== claim.endingEventId || h.release.at < claim.endedAt)) refuse('HoldReleaseBindingRefused');
    const r = object(h.release, ['holdId', 'actorId', 'at', 'evidenceId', 'authorityVerified', 'reason',
      ...(h.release.reason === 'effect-ended' ? ['endingFact'] : [])]);
    string(r.actorId); string(r.evidenceId);
    try { choice(r.reason, ['order-ended', 'request-fulfilled', 'request-withdrawn', 'request-refused', 'duty-ended', 'effect-ended']); }
    catch { refuse('HoldReleaseReasonRefused'); }
    if (r.holdId !== h.holdId || r.authorityVerified !== true || utc(r.at) < h.at) refuse('HoldReleaseBindingRefused');
    if (r.reason === 'effect-ended') {
      // Expiry confirms only this hold's validity, never the completion of an unresolved request.
      const end = object(r.endingFact, r.endingFact?.kind === 'request-resolved' ? ['kind', 'at', 'eventId'] : ['kind', 'at']);
      if (utc(end.at) > r.at) refuse('HoldReleaseBindingRefused');
      if (end.kind === 'validity-expired') {
        if (v.until === null || end.at !== v.until) refuse('HoldReleaseBindingRefused');
      } else if (end.kind === 'request-resolved' && requestBasedHold(h as LegalHold)) {
        const resolution = readAccessRequest(reader, h as LegalHold).resolution;
        if (!resolution || end.at !== resolution.at || end.eventId !== resolution.eventId || r.evidenceId !== resolution.eventId)
          refuse('HoldReleaseBindingRefused');
      } else refuse('HoldReleaseBindingRefused');
    } else if (requestBasedHold(h as LegalHold)) {
      const request = readAccessRequest(reader, h as LegalHold), end = request.resolution;
      const reasons = { fulfilled: b.type === 'statutory-duty' ? 'duty-ended' : 'request-fulfilled', withdrawn: 'request-withdrawn', 'lawfully-refused': 'request-refused' };
      if (!end || r.evidenceId !== end.eventId || r.at < end.at || r.reason !== reasons[end.outcome]) refuse('HoldReleaseBindingRefused');
    }
  }
  const hold = freeze(structuredClone(h)) as Readonly<LegalHold>;
  verifiedDuties.add(hold); dutySources.set(hold, reader); return hold;
}
function requestBasedHold(hold: LegalHold): boolean {
  return hold.basis.type === 'pending-access-request' || (hold.basis.type === 'statutory-duty' && hold.basis.clauseId === 'privacy:36.2');
}
function claimDuty(reader: LegalDutyReader, hold: LegalHold): { endedAt: string | null; endingEventId: string | null } {
  if (typeof reader.loadStatutoryDuty !== 'function') refuse('StatutoryDutyEvidenceRequired');
  const d = object(reader.loadStatutoryDuty(hold.basis.requestId), ['requestId', 'recordIds', 'startedAt', 'endedAt', 'endingEventId', 'basisId', 'procedure']);
  if (d.requestId !== hold.basis.requestId || !Array.isArray(d.recordIds) || hold.basis.scope.some(id => !d.recordIds.includes(id)) || utc(d.startedAt) > hold.at)
    refuse('StatutoryDutyEvidenceRequired');
  string(d.basisId);
  if (d.endedAt === null) {
    if (d.endingEventId !== null) refuse('StatutoryDutyEvidenceRequired');
    const p = parseOrderProcedure(d.procedure);
    if (p.state !== 'claim-duty-end-unconfirmed' || (p.decision && !['duty-continues', 'lawful-return'].includes(p.decision.route)))
      refuse('StatutoryDutyEvidenceRequired');
  } else {
    if (utc(d.endedAt) < d.startedAt) refuse('StatutoryDutyEvidenceRequired');
    string(d.endingEventId);
  }
  return { endedAt: d.endedAt, endingEventId: d.endingEventId };
}
function readAccessRequest(reader: LegalDutyReader, hold: LegalHold): AccessRequestFacts {
  const load = hold.basis.type === 'statutory-duty' ? reader.loadCorrectionRequest : reader.loadAccessRequest;
  const code = hold.basis.type === 'statutory-duty' ? 'CorrectionRequestBindingRefused' : 'AccessRequestBindingRefused';
  if (typeof load !== 'function') refuse(code);
  let value: unknown;
  try { value = load(hold.basis.requestId); } catch { refuse(code); }
  if (!value) refuse(code);
  const r = object(value, ['requestId', 'recordIds', 'receivedAt', 'responseDueAt', 'resolution']);
  if (r.requestId !== hold.basis.requestId || !Array.isArray(r.recordIds) || hold.basis.scope.some(id => !r.recordIds.includes(id)) ||
      utc(r.responseDueAt) <= utc(r.receivedAt)) refuse(code);
  if (r.resolution !== null) {
    const end = object(r.resolution, ['eventId', 'at', 'outcome']); string(end.eventId);
    choice(end.outcome, ['fulfilled', 'withdrawn', 'lawfully-refused']);
    if (utc(end.at) < r.receivedAt) refuse(code);
  }
  return r as AccessRequestFacts;
}
function holdEnded(hold: LegalHold, at: string): boolean {
  if (hold.basis.clauseId === 'nhi:96-4.1') {
    const d = claimDuty(dutySources.get(hold)!, hold);
    return d.endedAt !== null && d.endedAt <= at;
  }
  if (hold.basis.validity.until !== null && hold.basis.validity.until <= at) return true;
  if (requestBasedHold(hold)) {
    const request = readAccessRequest(dutySources.get(hold)!, hold);
    if (request.resolution && request.resolution.at <= at) return true;
  }
  return false;
}
function holdActive(hold: LegalHold, at?: string): boolean {
  return at ? hold.at <= at && (!hold.release || hold.release.at > at) && !holdEnded(hold, at) : !hold.release;
}
function checkHoldEnd(hold: LegalHold, at: string): void {
  if (!hold.release && holdEnded(hold, at)) refuse('HoldReleaseRequired');
}
const loadedHoldSets = new WeakMap<object, string>();
function holdSet(recordId: string, holds: readonly LegalHold[]): readonly LegalHold[] {
  const result = freeze([...holds]); loadedHoldSets.set(result, recordId); return result;
}
export function reloadLegalHold(recordId: string, holdId: string): Readonly<LegalHold> {
  const hold = readLegalDuty(emrAdapters().legal, holdId);
  if (hold.recordId !== string(recordId)) refuse('VerifiedHoldBasisRequired');
  return hold;
}
/** Complete storage enumeration includes active, ended and released holds, without re-registering them. */
export function reloadLegalHolds(recordId: string): readonly LegalHold[] {
  let listing: Record<string, any>;
  try { listing = object(emrAdapters().legal.listHolds(string(recordId)), ['recordId', 'holdIds', 'complete']); }
  catch { refuse('HoldSetIncomplete'); }
  if (listing.recordId !== recordId || listing.complete !== true || !Array.isArray(listing.holdIds) ||
      new Set(listing.holdIds).size !== listing.holdIds.length) refuse('HoldSetIncomplete');
  return holdSet(recordId, listing.holdIds.map(id => reloadLegalHold(recordId, string(id))));
}
function requireStoredHolds(record: { recordId: string; holds: readonly LegalHold[] }): void {
  const stored = reloadLegalHolds(record.recordId);
  if (stored.length !== record.holds.length || stored.some(h => !record.holds.some(r => JSON.stringify(r) === JSON.stringify(h))))
    refuse('HoldSetIncomplete');
}
export function reloadRetentionRecord(input: RetentionRecord): Readonly<RetentionRecord> {
  return parseRetentionRecord({ ...input, holds: reloadLegalHolds(input.recordId), parts: input.parts.map(p => ({ ...p,
    evidence: resolveStoredRecord(emrAdapters().stored, input.recordId, p.evidence.event.eventId) })) });
}
export function reloadPurposeRecord(input: PurposeRecord): Readonly<PurposeRecord> {
  return parsePurposeRecord({ ...input, holds: reloadLegalHolds(input.recordId),
    source: resolveStoredRecord(emrAdapters().stored, input.recordId, input.source.event.eventId) });
}
function parseLegalHolds(input: unknown, recordId: string, startedAt: string): readonly LegalHold[] {
  if (!Array.isArray(input) || loadedHoldSets.get(input) !== recordId) refuse('HoldSetIncomplete');
  const holds = input.map(h => {
    if (!verifiedDuties.has(h) || h.recordId !== recordId || h.at < startedAt) refuse('VerifiedHoldBasisRequired');
    return h as LegalHold;
  });
  if (new Set(holds.map(h => h.holdId)).size !== holds.length) throw new Error('Duplicate hold');
  return input as readonly LegalHold[];
}
export function parseRetentionRecord(input: unknown): Readonly<RetentionRecord> {
  const v = object(input, ['recordId', 'disposalUnitId', 'kinds', 'parts', 'extension', 'holds', 'destroyedAt']);
  const recordId = string(v.recordId); statutoryClasses(v.kinds);
  if (!Array.isArray(v.parts) || !v.parts.length) throw new Error('All content parts required');
  const parts = v.parts.map(p => {
    object(p, ['partId', 'startedAt', 'evidence']);
    const part = lawfulPart(p.evidence);
    if (part.partId !== p.partId || part.startedAt !== p.startedAt || part.evidence.recordId !== recordId) refuse('RecordEventBindingRefused');
    return part;
  });
  const derived = [...new Set(parts.flatMap(p => p.evidence.kinds))].sort();
  if (JSON.stringify([...v.kinds].sort()) !== JSON.stringify(derived)) refuse('RecordKindBindingRefused');
  if (new Set(parts.map(p => p.partId)).size !== parts.length || parts.some((p, i) => i && p.startedAt < parts[i - 1].startedAt))
    throw new Error('Distinct chronological parts required');
  if (new Set(parts.map(p => p.evidence.event.contentSha256)).size !== parts.length) refuse('UnchangedContentRefused');
  for (let i = 1; i < parts.length; i++) {
    const previous = parts[i - 1], e = parts[i].evidence.event, p = e.predecessor;
    if (!p || p.recordId !== recordId || p.partId !== previous.partId || p.sha256 !== previous.evidence.event.sha256) refuse('PredecessorBindingRefused');
  }
  let extension: ContinuingTreatmentExtension | null = null;
  if (v.extension !== null) {
    const e = object(v.extension, ['cause', 'actorId', 'reason', 'at', 'until']);
    extension = { cause: choice(e.cause, ['continuing-treatment']), actorId: string(e.actorId), reason: string(e.reason), at: utc(e.at), until: utc(e.until) };
    const atDecision = parts.filter(p => p.startedAt <= extension!.at);
    const baseExpiry = atDecision.length ? partDeadline({ kinds: v.kinds, parts: atDecision }) : '';
    if (statutoryClasses(v.kinds).includes('access') || !baseExpiry || extension.at >= baseExpiry ||
        extension.until <= baseExpiry || extension.until > civilPeriodEnd(baseExpiry, yearsFor(v.kinds)))
      throw new Error('Only one timely continuing-treatment extension within the statutory period is allowed');
  }
  const holds = parseLegalHolds(v.holds, recordId, parts[0].startedAt);
  const destroyedAt = v.destroyedAt === null ? null : utc(v.destroyedAt);
  if (destroyedAt !== null && destroyedAt < parts[parts.length - 1].startedAt) refuse('RecordDestructionBindingRefused');
  return freeze({ recordId, disposalUnitId: opaqueUnit(v.disposalUnitId), kinds: [...v.kinds], parts, extension, holds, destroyedAt });
}
/** Only a new lawful event can change the part maximum; a hold never supplies clinical processing authority. */
export function recordVersionAdded(input: RetentionRecord, source: ResolvedRecord, graph: RetentionGraph,
  retentionOnly = false): Readonly<RetentionRecord> {
  const record = parseRetentionRecord(input);
  if (verifiedRecord(source).recordId !== record.recordId) refuse('RecordEventBindingRefused');
  requireCurrentGraph(record, graph, source.event.at);
  if (statutoryClasses(record.kinds).includes('access')) throw new Error('Each access event has its own unit');
  retainingUnits(record, graph, false).forEach(requireStoredHolds);
  const part = lawfulPart(source), state = retentionState(record, graph, part.startedAt, false);
  const activeHolds = retainingUnits(record, graph, false).flatMap(r => r.holds.filter(h => holdActive(h, part.startedAt)));
  if (activeHolds.length) {
    const p = source.event.processing;
    if (!p?.authorized || !p.preservesOriginals || ((retentionOnly || part.startedAt >= state.deadline) && !p.separateManagement) ||
        activeHolds.some(h => !p.permittedHoldIds.includes(h.holdId))) refuse('HeldCorrectionAuthorityRequired');
  } else if (part.startedAt >= state.deadline) refuse('ExpiredUnitCannotResume');
  validateNewComponents(source, graph);
  return parseRetentionRecord({ ...record, kinds: [...new Set([...record.kinds, ...source.kinds])], parts: [...record.parts, part] });
}
export function extendRetention(input: RetentionRecord, extension: ContinuingTreatmentExtension): Readonly<RetentionRecord> {
  const record = parseRetentionRecord(input);
  if (record.extension !== null || extension === null) throw new Error('Extension already used or missing');
  return parseRetentionRecord({ ...record, extension });
}
/** Refresh only lifecycle facts of the same fixed clinical version, from B's current locked snapshot. No new clock. */
export function refreshOrderLifecycle(input: RetentionRecord, source: ResolvedRecord): Readonly<RetentionRecord> {
  const record = parseRetentionRecord(input), s = verifiedRecord(source);
  const previous = record.parts.find(p => p.partId === s.event.versionId);
  if (!previous || s.recordId !== record.recordId || !['Order', 'emr_access.order_fact'].includes(s.model) ||
      JSON.stringify(previous.evidence.event) !== JSON.stringify(s.event) ||
      JSON.stringify(previous.evidence.kinds) !== JSON.stringify(s.kinds)) refuse('OrderLifecycleBindingRefused');
  validateOrderTransition(previous.evidence.row as OrderFacts, s.row as OrderFacts);
  return parseRetentionRecord({ ...record, parts: record.parts.map(p => p === previous ? { ...p, evidence: s } : p) });
}
export function placeLegalHold(input: RetentionRecord, reader: LegalDutyReader, holdId: string, graph: RetentionGraph): Readonly<RetentionRecord> {
  const record = parseRetentionRecord(input);
  const hold = readLegalDuty(reader, holdId);
  requireCurrentGraph(record, graph, hold.at);
  if (hold.release !== null) refuse('HoldReleaseBindingRefused');
  checkHoldEnd(hold, hold.at);
  return parseRetentionRecord({ ...record, holds: holdSet(record.recordId, [...record.holds, hold]) });
}
export function liftLegalHold(input: RetentionRecord, holdId: string, reader: LegalDutyReader): Readonly<RetentionRecord> {
  const record = parseRetentionRecord(input), held = record.holds.find(h => h.holdId === holdId);
  const released = readLegalDuty(reader, holdId);
  if (!held || held.release || !released.release || JSON.stringify({ ...released, release: null }) !== JSON.stringify(held)) refuse('HoldReleaseBindingRefused');
  return parseRetentionRecord({ ...record, holds: holdSet(record.recordId, record.holds.map(h => h === held ? released : h)) });
}
export interface RecordReference {
  fromRecordId: string; fromPartId: string; toRecordId: string; toPartId: string; relation: 'incorporation' | 'navigation';
}
/** B/H storage reads manifests and the reverse index under the same lock as append/hold/disposal. */
export interface RetentionGraph {
  records: readonly RetentionRecord[]; references: readonly RecordReference[];
  complete: true; revision: string; checkedAt: string;
}
function requireCurrentGraph(record: RetentionRecord, graph: RetentionGraph, at: string): void {
  if (!graph) refuse('ReferenceSnapshotRequired');
  graphRecords(record, graph);
  if (graph.checkedAt !== at) refuse('ReferenceSnapshotStale');
  if (record.destroyedAt !== null) refuse('RecordDestroyed');
}
/** Validate before fixing the referencing bytes. The new record cannot provide its own retention basis. */
function validateNewComponents(source: ResolvedRecord, graph?: RetentionGraph): void {
  if (!source.event.components.length) return;
  if (!graph) refuse('ReferenceSnapshotRequired');
  if (graph.complete !== true || !Array.isArray(graph.records) || !graph.records.length) refuse('ReferenceSnapshotIncomplete');
  if (graph.checkedAt !== source.event.at) refuse('ReferenceSnapshotStale');
  const records = graph.records.map(parseRetentionRecord), byId = new Map(records.map(r => [r.recordId, r]));
  graphRecords(records[0], graph);
  if (byId.get(source.recordId)?.parts.some(p => p.partId === source.event.versionId)) refuse('ComponentAdmissionSnapshotRefused');
  validateComponents(source, byId);
  for (const c of source.event.components) {
    const unit = byId.get(c.recordId)!;
    if (unit.destroyedAt !== null) refuse('ComponentDestroyed');
    if (unit.parts.find(p => p.partId === c.partId)!.startedAt > source.event.at) refuse('ComponentNotYetCreated');
    retainingUnits(unit, graph).forEach(requireStoredHolds);
    const state = retentionState(unit, graph, source.event.at);
    if (state.state !== 'legal-hold' && source.event.at >= state.deadline) refuse('ComponentExpired');
    const activeHolds = retainingUnits(unit, graph).flatMap(r => r.holds.filter(h => holdActive(h, source.event.at)));
    if (source.event.at >= state.deadline) {
      const p = source.event.processing;
      if (!p?.authorized || !p.preservesOriginals || !p.componentRecordIds?.includes(unit.recordId) ||
          activeHolds.some(h => !p.permittedHoldIds.includes(h.holdId))) refuse('ComponentProcessingBasisRequired');
    }
  }
}
function validateComponents(source: ResolvedRecord, byId: ReadonlyMap<string, RetentionRecord>): void {
  const components = source.event.components;
  for (const component of components) {
    const target = byId.get(component.recordId)?.parts.find(p => p.partId === component.partId);
    if (!target || target.evidence.event.sha256 !== component.sha256) refuse('ComponentMissing');
    if (byId.get(component.recordId)!.destroyedAt !== null) refuse('ComponentDestroyed');
    // Every nested byte dependency is directly bound in the referencing signed/created manifest.
    if (target.evidence.event.components.some(c => !(c.recordId === source.recordId && c.partId === source.event.versionId) &&
        !components.some(d => d.recordId === c.recordId && d.partId === c.partId && d.sha256 === c.sha256))) refuse('ComponentManifestIncomplete');
  }
}
function graphRecords(record: RetentionRecord, graph: RetentionGraph): ReadonlyMap<string, RetentionRecord> {
  try { object(graph, ['records', 'references', 'complete', 'revision', 'checkedAt']); } catch { refuse('ReferenceSnapshotRequired'); }
  if (graph.complete !== true || !Array.isArray(graph.records) || !Array.isArray(graph.references)) refuse('ReferenceSnapshotIncomplete');
  string(graph.revision); utc(graph.checkedAt);
  const byId = new Map(graph.records.map(r => [r.recordId, r]));
  if (byId.size !== graph.records.length || JSON.stringify(byId.get(record.recordId)) !== JSON.stringify(record)) refuse('ReferenceSnapshotStale');
  return byId;
}
function retainingUnits(input: RetentionRecord, graph?: RetentionGraph, validate = true): readonly RetentionRecord[] {
  const record = parseRetentionRecord(input);
  if (graph === undefined) return [record]; // Own-unit scheduling only; destruction requires a snapshot.
  const raw = graphRecords(record, graph), byId = new Map([...raw].map(([id, r]) => [id, parseRetentionRecord(r)]));
  const live = [...byId.values()].filter(r => r.destroyedAt === null && r.recordId !== record.recordId);
  // Discover through both index and manifests: a missing direct edge cannot hide a nested retaining source.
  const incoming = (unit: RetentionRecord, ids: ReadonlySet<string>) =>
    unit.parts.some(p => p.evidence.event.components.some(c => ids.has(c.recordId))) ||
    graph.references.some(r => r.relation === 'incorporation' && r.fromRecordId === unit.recordId && ids.has(r.toRecordId));
  const direct = live.filter(unit => incoming(unit, new Set([record.recordId])));
  if (validate) {
    const ancestors = new Set([record.recordId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const unit of live) if (!ancestors.has(unit.recordId) && incoming(unit, ancestors)) { ancestors.add(unit.recordId); changed = true; }
    }
    for (const unit of live.filter(r => ancestors.has(r.recordId))) for (const part of unit.parts) {
      const components = part.evidence.event.components;
      const edges = graph.references.filter(r => r.relation === 'incorporation' && r.fromRecordId === unit.recordId && r.fromPartId === part.partId);
      if (edges.length !== components.length || components.some(c => !edges.some(e => e.toRecordId === c.recordId && e.toPartId === c.partId))) refuse('ComponentManifestIncomplete');
      validateComponents(part.evidence, byId);
    }
    for (const ref of graph.references.filter(r => r.toRecordId === record.recordId)) {
      object(ref, ['fromRecordId', 'fromPartId', 'toRecordId', 'toPartId', 'relation']); choice(ref.relation, ['incorporation', 'navigation']);
      if (ref.relation === 'incorporation' && !byId.get(ref.fromRecordId)?.parts.some(p => p.partId === ref.fromPartId)) refuse('ComponentMissing');
    }
  }
  return [record, ...direct];
}
export function retentionDeadline(input: RetentionRecord, graph?: RetentionGraph): string {
  return retainingUnits(input, graph).flatMap(r => [partDeadline(r), ...(r.extension ? [r.extension.until] : [])]).sort().slice(-1)[0];
}
export function retentionState(input: RetentionRecord, graph?: RetentionGraph, at?: string, validate = true): Readonly<{
  state: 'retained' | 'legal-hold' | 'order-review'; deadline: string; destroyNotBefore: string | null; releaseNotRecorded: readonly string[];
}> {
  const units = retainingUnits(input, graph, validate), deadline = units.flatMap(r => [partDeadline(r), ...(r.extension ? [r.extension.until] : [])]).sort().slice(-1)[0];
  const holds = units.flatMap(r => r.holds), held = holds.some(h => holdActive(h, at));
  const releaseNotRecorded = at ? holds.filter(h => !h.release && holdEnded(h, at)).map(h => h.holdId) : [];
  const releases = holds.flatMap(h => h.release ? [h.release.at] : []);
  const review = units.some(r => r.parts.some(p => ['Order', 'emr_access.order_fact'].includes(p.evidence.model) &&
    orderProcedureState(p.evidence.row as OrderFacts, at ?? p.startedAt) !== 'clear'));
  return freeze({ state: held ? 'legal-hold' : review ? 'order-review' : 'retained', deadline, releaseNotRecorded,
    destroyNotBefore: held || review || releaseNotRecorded.length ? null : [deadline, ...releases].sort().slice(-1)[0] });
}
/** An actual operational reason without patient data. Recording one is a fact, not a software verdict that the delay was lawful. */
export interface JustifiedDelay { reason: string; recordedAt: string }
export interface DisposalRequest {
  record: RetentionRecord; versionIds: readonly string[]; requestedAt: string; graph: RetentionGraph;
  justifiedDelay: Readonly<JustifiedDelay> | null;
}
/** disposalUnitId is random, never a source ID/hash; its source mapping must be erased with the unit.
 * Format 2 (CD-09): completion means operational-store deletion. Recovery-only backups are supervised separately
 * (backup-generation-expired, restore-reapplied) and are not a completion condition. Format 1 is never reinterpreted. */
export interface DestructionRecord {
  formatVersion: 2; kind: 'operational-deletion';
  /** 1 for the original fact; only a later delay-reason supplement adds a revision, never a change of the deletion. */
  revision: number; operationId: string; phase: 'started' | 'completed' | 'failed';
  occurredAt: string; day: string;
  disposalUnitId: string; classes: readonly StatutoryClass[]; clauseIds: readonly string[]; partCount: number;
  expiryDay: string; extensionUsed: boolean; dueDay: string; timeliness: 'within-five-days' | 'overdue';
  method: 'operational-store-deletion';
  justifiedDelay: Readonly<JustifiedDelay> | null; delayReasonStatus: 'not-required' | 'recorded' | 'missing';
  basis: 'privacy-act-21-and-decree-16-1-1';
}
export interface DisposalAuditStore {
  append(event: Readonly<DestructionRecord>): Promise<{ durableAt: string }>;
  /** Hold the lock through journal, deletion and completion. No request-provided callback/flags. */
  withRetentionLock<T>(recordId: string, at: string, work: (current: RetentionGraph) => Promise<T>): Promise<T>;
  /** The store's current time; a failure is recorded when it happened, not at the request time. */
  now(): string;
  /** Durably records the execution set (the `deleting` state) for exactly these units and binds its operation ID. */
  beginSet(disposalUnitIds: readonly string[]): Promise<{ operationId: string }>;
  /** All completions of one execution in one durable write; never a partial set. */
  appendCompletedSet(events: readonly Readonly<DestructionRecord>[]): Promise<{ durableAt: string }>;
}
/** Supervision metadata bound to a destruction; not an event kind. Python reads the generation count from its definition. */
export interface BackupSupervisionPlan {
  policySource: 'scripts/ops_backup.py:DAILY_GENERATIONS'; observedAt: string; generations: number;
  expectedExpiredAt: string | null; state: 'scheduled' | 'exception' | 'unverified';
}
/** Supervision record: the last recovery-only generation holding the unit was confirmed gone. Not a completion condition. */
export interface BackupGenerationExpired {
  formatVersion: 2; kind: 'backup-generation-expired'; disposalUnitId: string; operationId: string;
  occurredAt: string; expectedExpiredAt: string | null; policySource: 'scripts/ops_backup.py:DAILY_GENERATIONS';
  generations: number; observationId: string;
}
/** Supervision record: every completed destruction after the restored backup point was reapplied before service resumed. */
export interface RestoreReapplied {
  formatVersion: 2; kind: 'restore-reapplied'; restoreId: string; installationId: string; snapshotId: string;
  backupPointAt: string; ledgerThrough: string; operationIds: readonly string[];
  appliedUnits: number; alreadyAbsentUnits: number; completedAt: string; serviceResumeAllowed: true;
}
export type RetentionJournalEvent = DestructionRecord | BackupGenerationExpired | RestoreReapplied;
/** B commits the returned decision while this same lock is held; a concurrent hold/append cannot be lost. */
export async function withRetentionChange<T>(store: Pick<DisposalAuditStore, 'withRetentionLock'>, record: RetentionRecord,
  graph: RetentionGraph, at: string, changeAndPersist: (current: RetentionGraph) => Promise<T>): Promise<T> {
  requireCurrentGraph(record, graph, utc(at));
  if (typeof store.withRetentionLock !== 'function') refuse('RetentionLockRequired');
  return store.withRetentionLock(record.recordId, at, async current => {
    requireCurrentGraph(record, current, at);
    if (JSON.stringify(current) !== JSON.stringify(graph)) refuse('ReferenceSnapshotStale');
    requireStoredHolds(record);
    return changeAndPersist(current);
  });
}
/** H's proof that the operational stores of exactly this execution's units no longer hold them. */
export interface DestructionReceipt {
  formatVersion: 2; kind: 'operational-deletion'; method: 'operational-store-deletion';
  operationId: string; disposalUnitIds: readonly string[]; completedAt: string;
}
function seoulDay(at: string): string { return new Date(Date.parse(utc(at)) + SEOUL_MS).toISOString().slice(0, 10); }
function dueBy(at: string): string {
  const local = new Date(Date.parse(utc(at)) + SEOUL_MS);
  // The five-day outside bound is no grace period: the job is due immediately. D-21: the duty's first day is the civil day
  // the record became destructible, whatever the time (행정기본법 제6조②1); the window ends with its fifth day.
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 5) - SEOUL_MS).toISOString();
}
type DestructionDetails = Pick<DestructionRecord, 'disposalUnitId' | 'classes' | 'clauseIds' | 'partCount' | 'expiryDay' | 'extensionUsed'>;
function parseJustifiedDelay(input: unknown): Readonly<JustifiedDelay> | null {
  if (input === null) return null;
  let v: Record<string, any>;
  try { v = object(input, ['reason', 'recordedAt']); string(v.reason); utc(v.recordedAt); } catch { refuse('JustifiedDelayInvalid'); }
  if (v.reason.length > 1000) refuse('JustifiedDelayInvalid');
  return freeze({ reason: v.reason, recordedAt: v.recordedAt });
}
/** One unit's journal inside one execution. occurredAt, day and timeliness come from each event's own time; the
 * deadline rules (dueBy, civilPeriodEnd) are unchanged. A missing reason past the boundary is recorded, never a stop. */
function destructionJournal(store: Pick<DisposalAuditStore, 'append'>, eligibleAt: string, details: DestructionDetails,
  operationId: string, justifiedDelay: Readonly<JustifiedDelay> | null) {
  const due = dueBy(eligibleAt);
  const make = (phase: DestructionRecord['phase'], at: string): Readonly<DestructionRecord> => {
    const timeliness = at < due ? 'within-five-days' as const : 'overdue' as const;
    return freeze({ formatVersion: 2 as const, kind: 'operational-deletion' as const, revision: 1, operationId, phase,
      occurredAt: at, day: seoulDay(at), ...details, dueDay: seoulDay(new Date(Date.parse(due) - 1).toISOString()), timeliness,
      method: 'operational-store-deletion' as const, justifiedDelay,
      delayReasonStatus: timeliness === 'within-five-days' ? 'not-required' as const : justifiedDelay ? 'recorded' as const : 'missing' as const,
      basis: 'privacy-act-21-and-decree-16-1-1' as const });
  };
  const append = async (phase: 'started' | 'failed', at: string) => {
    const event = make(phase, at);
    let receipt: Record<string, any>;
    try { receipt = object(await store.append(event), ['durableAt']); }
    catch { refuse('DestructionJournalUnavailable'); }
    if (utc(receipt.durableAt) < at) refuse('DestructionJournalReceiptInvalid');
    return event;
  };
  return { make, append };
}
interface ExecutionEntry { details: DestructionDetails; eligibleAt: string; justifiedDelay: Readonly<JustifiedDelay> | null }
function requireExecutionStore(store: Partial<DisposalAuditStore>): void {
  if (typeof store?.append !== 'function' || typeof store.now !== 'function' || typeof store.beginSet !== 'function' ||
      typeof store.appendCompletedSet !== 'function') refuse('RetentionExecutionRequired');
}
function receiptCompletedAt(value: unknown, operationId: string, unitIds: readonly string[], requestedAt: string): string {
  let r: Record<string, any>;
  try { r = object(value, ['formatVersion', 'kind', 'method', 'operationId', 'disposalUnitIds', 'completedAt']); utc(r.completedAt); }
  catch { refuse('DestructionReceiptInvalid'); }
  // A format-1 "permanent deletion" receipt or another execution's units is never accepted as this one's completion.
  if (r.formatVersion !== 2 || r.kind !== 'operational-deletion' || r.method !== 'operational-store-deletion' || r.operationId !== operationId ||
      !Array.isArray(r.disposalUnitIds) || JSON.stringify([...r.disposalUnitIds].sort()) !== JSON.stringify([...unitIds].sort()) ||
      r.completedAt < requestedAt) refuse('DestructionReceiptInvalid');
  return r.completedAt;
}
const DESTRUCTION_KEYS = ['formatVersion', 'kind', 'revision', 'operationId', 'phase', 'occurredAt', 'day', 'disposalUnitId', 'classes',
  'clauseIds', 'partCount', 'expiryDay', 'extensionUsed', 'dueDay', 'timeliness', 'method', 'justifiedDelay', 'delayReasonStatus', 'basis'];
/** H's reconciliation when the deletion committed but its completion write was lost: the same execution's started
 * record, completed at the durable deletion confirmation. Timeliness comes from the stored due day, so a late
 * confirmation stays late; the unit, classes and delay reason are the started record's own. */
export function completedFromStarted(input: unknown, completedAt: string): Readonly<DestructionRecord> {
  let s: Record<string, any>;
  try {
    s = object(input, DESTRUCTION_KEYS); string(s.operationId); opaqueUnit(s.disposalUnitId); utc(s.occurredAt); utc(completedAt);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.dueDay)) throw new Error('due day');
  } catch { refuse('StartedDestructionRequired'); }
  if (s.formatVersion !== 2 || s.kind !== 'operational-deletion' || s.phase !== 'started' || s.revision !== 1 ||
      s.method !== 'operational-store-deletion' || completedAt < s.occurredAt) refuse('StartedDestructionRequired');
  const [y, m, d] = s.dueDay.split('-').map(Number);
  const due = new Date(Date.UTC(y, m - 1, d + 1) - SEOUL_MS).toISOString();
  const timeliness = completedAt < due ? 'within-five-days' as const : 'overdue' as const;
  const justifiedDelay = s.justifiedDelay === null ? null : parseJustifiedDelay(s.justifiedDelay);
  return freeze({ ...structuredClone(s), phase: 'completed' as const, occurredAt: completedAt, day: seoulDay(completedAt), timeliness,
    delayReasonStatus: timeliness === 'within-five-days' ? 'not-required' as const : justifiedDelay ? 'recorded' as const : 'missing' as const,
  }) as Readonly<DestructionRecord>;
}
/** One execution (a unit or a whole SCC): durable execution set → started for every unit → operational deletion →
 * every completion in one write. A failure records `failed` at its actual time for every unit it can and stops. */
async function executeSet<T>(store: DisposalAuditStore | BatchDisposalAuditStore, entries: readonly ExecutionEntry[], requestedAt: string,
  request: T, destroy: (request: T) => Promise<DestructionReceipt>): Promise<readonly Readonly<DestructionRecord>[]> {
  const unitIds = entries.map(e => e.details.disposalUnitId);
  let begun: Record<string, any>;
  try { begun = object(await store.beginSet(freeze([...unitIds])), ['operationId']); string(begun.operationId); }
  catch { refuse('RetentionExecutionUnavailable'); }
  const journals = entries.map(e => destructionJournal(store, e.eligibleAt, e.details, begun.operationId, e.justifiedDelay));
  for (const journal of journals) await journal.append('started', requestedAt);
  let completedAt: string;
  try {
    completedAt = receiptCompletedAt(await destroy(request), begun.operationId, unitIds, requestedAt);
  } catch (error) {
    let failedAt: string;
    try { failedAt = utc(store.now()); } catch { failedAt = requestedAt; }
    if (failedAt < requestedAt) failedAt = requestedAt; // A store clock behind the request cannot predate the start.
    const journalErrors: unknown[] = [];
    for (const journal of journals) {
      try { await journal.append('failed', failedAt); } catch (journalError) { journalErrors.push(journalError); }
    }
    if (journalErrors.length) throw new AggregateError([error, ...journalErrors], 'DestructionFailureJournalIncomplete');
    throw error;
  }
  const completed = freeze(journals.map(j => j.make('completed', completedAt)));
  let receipt: Record<string, any>;
  try { receipt = object(await store.appendCompletedSet(completed), ['durableAt']); }
  catch { refuse('DestructionJournalUnavailable'); }
  if (utc(receipt.durableAt) < completedAt) refuse('DestructionJournalReceiptInvalid');
  return completed;
}
/** Operational stores of the unit, against the reference/hold snapshot. Recovery-only backups are supervised separately;
 * a partial deletion has no success receipt. */
export async function destroyAtExpiry(store: DisposalAuditStore, input: DisposalRequest,
  destroy: (request: Readonly<DisposalRequest>) => Promise<DestructionReceipt>): Promise<Readonly<DestructionRecord>> {
  let v: Record<string, any>;
  try { v = object(input, ['record', 'versionIds', 'requestedAt', 'graph', 'justifiedDelay']); } catch { refuse('DisposalRequestInvalid'); }
  const justifiedDelay = parseJustifiedDelay(v.justifiedDelay);
  const record = parseRetentionRecord(v.record), requestedAt = utc(v.requestedAt);
  if (record.destroyedAt !== null) refuse('RecordDestroyed');
  if (!Array.isArray(v.versionIds) || new Set(v.versionIds).size !== v.versionIds.length ||
      v.versionIds.length !== record.parts.length || record.parts.some(p => !v.versionIds.includes(p.partId))) refuse('CompleteVersionSetRequired');
  if (v.graph === undefined || v.graph === null) refuse('ReferenceSnapshotRequired');
  retainingUnits(record, v.graph);
  if (typeof store.withRetentionLock !== 'function') refuse('RetentionLockRequired');
  requireExecutionStore(store);
  return store.withRetentionLock(record.recordId, requestedAt, async current => {
  retainingUnits(record, current);
  if (!current || current.checkedAt !== requestedAt || JSON.stringify(current) !== JSON.stringify(v.graph)) refuse('ReferenceSnapshotStale');
  retainingUnits(record, current).forEach(requireStoredHolds);
  const state = retentionState(record, v.graph, requestedAt);
  if (state.releaseNotRecorded.length) refuse('HoldReleaseRequired');
  if (state.destroyNotBefore === null) refuse('LegalHoldActive');
  if (requestedAt < state.destroyNotBefore) refuse('RetentionNotElapsed');
  // Order units that are due together. A later inherited period for other bytes cannot re-propagate here.
  if (retainingUnits(record, current).some(r => r.recordId !== record.recordId && r.destroyedAt === null &&
      retentionDeadline(r, current) <= requestedAt)) refuse('IncorporatorStillPresent');
  const request = freeze({ record, versionIds: [...v.versionIds], requestedAt, graph: v.graph, justifiedDelay }) as Readonly<DisposalRequest>;
  const classes = statutoryClasses(record.kinds);
  const [completed] = await executeSet(store, [{ eligibleAt: state.destroyNotBefore, justifiedDelay, details: {
    disposalUnitId: record.disposalUnitId, classes, clauseIds: classes.map(c => STATUTORY_MINIMUM[c].clauseId), partCount: record.parts.length,
    expiryDay: seoulDay(new Date(Date.parse(state.deadline) - 1).toISOString()), extensionUsed: retainingUnits(record, v.graph).some(r => r.extension !== null),
  } }], requestedAt, request, destroy);
  return completed;
  });
}
export interface BatchDisposalRequest {
  units: readonly { record: RetentionRecord; versionIds: readonly string[]; justifiedDelay: Readonly<JustifiedDelay> | null }[];
  requestedAt: string; graph: RetentionGraph;
}
export interface BatchDisposalAuditStore extends Pick<DisposalAuditStore, 'append' | 'now' | 'beginSet' | 'appendCompletedSet'> {
  /** One lock covers every member, reverse reference, hold, journal and deletion through completion. */
  withRetentionBatchLock<T>(recordIds: readonly string[], at: string, work: (current: RetentionGraph) => Promise<T>): Promise<T>;
}
/** The SCC order destroyBatchAtExpiry executes, so H fixes one plan per set under the same batch lock. */
export function disposalSets(recordIds: readonly string[], graph: RetentionGraph): readonly (readonly string[])[] {
  const ids = [...recordIds].sort(), incoming = new Map<string, string[]>();
  for (const id of ids) {
    const record = graph.records.find(r => r?.recordId === id);
    if (!record) refuse('ReferenceSnapshotStale');
    incoming.set(id, retainingUnits(record, graph).filter(r => r.recordId !== id).map(r => r.recordId));
  }
  return freeze(orderedDisposalSets(ids, incoming));
}
/** Tarjan SCCs keep lawful older-version incorporation intact; the condensation is ordered incorporator-first. */
function orderedDisposalSets(ids: readonly string[], incoming: ReadonlyMap<string, readonly string[]>): string[][] {
  const edges = new Map(ids.map(id => [id, ids.filter(target => incoming.get(target)!.includes(id))]));
  const indices = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], active = new Set<string>();
  const sets: string[][] = [];
  function visit(id: string): void {
    indices.set(id, indices.size); low.set(id, indices.get(id)!); stack.push(id); active.add(id);
    for (const target of edges.get(id)!) {
      if (!indices.has(target)) { visit(target); low.set(id, Math.min(low.get(id)!, low.get(target)!)); }
      else if (active.has(target)) low.set(id, Math.min(low.get(id)!, indices.get(target)!));
    }
    if (low.get(id) === indices.get(id)) {
      const members: string[] = []; let member: string;
      do { member = stack.pop()!; active.delete(member); members.push(member); } while (member !== id);
      sets.push(members.sort());
    }
  }
  ids.forEach(id => { if (!indices.has(id)) visit(id); });
  const pending = [...sets], ordered: string[][] = [], removed = new Set<string>();
  while (pending.length) {
    const index = pending.findIndex(set => set.every(id => incoming.get(id)!.every(from => set.includes(from) || removed.has(from))));
    if (index < 0) refuse('IncorporatorStillPresent');
    const [set] = pending.splice(index, 1); ordered.push(set); set.forEach(id => removed.add(id));
  }
  return ordered;
}
/** H's callback deletes the entire supplied SCC from the operational stores and confirms the remainder; the final
 * PostgreSQL change is one commit for the set. External stores resume from the durable execution set; a partial
 * deletion is never returned as success. A remaining recovery-only backup is not a reason to refuse it.
 */
export async function destroyBatchAtExpiry(store: BatchDisposalAuditStore, input: BatchDisposalRequest,
  destroySet: (requests: readonly Readonly<DisposalRequest>[]) => Promise<DestructionReceipt>): Promise<readonly Readonly<DestructionRecord>[]> {
  const v = object(input, ['units', 'requestedAt', 'graph']), requestedAt = utc(v.requestedAt);
  if (!Array.isArray(v.units) || !v.units.length) refuse('DisposalRequestInvalid');
  const units = v.units.map(unit => {
    try { object(unit, ['record', 'versionIds', 'justifiedDelay']); } catch { refuse('DisposalRequestInvalid'); }
    const justifiedDelay = parseJustifiedDelay(unit.justifiedDelay);
    const record = parseRetentionRecord(unit.record);
    requireCurrentGraph(record, v.graph, requestedAt);
    if (!Array.isArray(unit.versionIds) || new Set(unit.versionIds).size !== unit.versionIds.length ||
        unit.versionIds.length !== record.parts.length || record.parts.some(p => !unit.versionIds.includes(p.partId))) refuse('CompleteVersionSetRequired');
    return { record, versionIds: [...unit.versionIds], justifiedDelay };
  });
  const ids: string[] = units.map(u => u.record.recordId).sort();
  if (new Set(ids).size !== ids.length) refuse('DisposalRequestInvalid');
  if (typeof store.withRetentionBatchLock !== 'function') refuse('RetentionLockRequired');
  requireExecutionStore(store as Partial<DisposalAuditStore>);
  return store.withRetentionBatchLock(ids, requestedAt, async current => {
    if (JSON.stringify(current) !== JSON.stringify(v.graph)) refuse('ReferenceSnapshotStale');
    const incoming = new Map<string, string[]>(), requests = new Map<string, Readonly<DisposalRequest>>();
    const entries = new Map<string, ExecutionEntry>();
    // Validate the entire batch before any execution set, started record or destructive callback.
    for (const { record, versionIds, justifiedDelay } of units) {
      requireCurrentGraph(record, current, requestedAt);
      const retainers = retainingUnits(record, current); retainers.forEach(requireStoredHolds);
      const state = retentionState(record, current, requestedAt);
      if (state.releaseNotRecorded.length) refuse('HoldReleaseRequired');
      if (state.destroyNotBefore === null) refuse('LegalHoldActive');
      if (requestedAt < state.destroyNotBefore) refuse('RetentionNotElapsed');
      incoming.set(record.recordId, retainers.filter(r => r.recordId !== record.recordId).map(r => r.recordId));
      requests.set(record.recordId, freeze({ record, versionIds, requestedAt, graph: current, justifiedDelay }));
      const classes = statutoryClasses(record.kinds);
      entries.set(record.recordId, { eligibleAt: state.destroyNotBefore, justifiedDelay, details: {
        disposalUnitId: record.disposalUnitId, classes, clauseIds: classes.map(c => STATUTORY_MINIMUM[c].clauseId), partCount: record.parts.length,
        expiryDay: seoulDay(new Date(Date.parse(state.deadline) - 1).toISOString()), extensionUsed: retainers.some(r => r.extension !== null),
      } });
    }
    const sets = orderedDisposalSets(ids, incoming), completed: Readonly<DestructionRecord>[] = [];
    // A failed SCC (deletion, receipt or completion journal) throws here: the next SCC is never started.
    for (const set of sets) completed.push(...await executeSet(store, set.map(id => entries.get(id)!), requestedAt,
      freeze(set.map(id => requests.get(id)!)), destroySet));
    return freeze(completed);
  });
}
export interface PurposeRecord {
  recordId: string; disposalUnitId: string; kind: RecordKind; ownerId: string; createdAt: string;
  partIds: readonly string[]; holds: readonly LegalHold[]; source: ResolvedRecord; destroyedAt: string | null;
}
export interface PurposeEndEvent {
  eventId: string; recordId: string; trigger: PurposeEnd; actorId: string; at: string;
  result: { draftId: string; intentId: string; recordId: string; versionId: string; signedAt: string; action: 'approve' | 'addendum' | 'amend'; verified: true } | null;
  superseded: IntentEndingFact | null;
}
export type IntentEndingFact =
  { eventId: string; reportId: string; at: string; action: 'approve'; authorId: string; draftId: string; versionId: string } |
  { eventId: string; reportId: string; at: string; action: 'cancel'; versionId: string; reason: string } |
  { eventId: string; reportId: string; at: string; action: 'amend-window-closed'; firstApprovedAt: string; amendUntil: string };
export interface PurposeEndReader {
  load(eventId: string): unknown;
  loadSignedResult(recordId: string, versionId: string): unknown;
  loadIntentEndingFact?(eventId: string): unknown;
}
const verifiedEnds = new WeakSet<object>();
export function resolvePurposeEnd(reader: PurposeEndReader, eventId: string): Readonly<PurposeEndEvent> {
  if (!isEmrReader('purpose', reader)) refuse('PurposeReaderRequired');
  const e = object(reader.load(string(eventId)), ['eventId', 'recordId', 'trigger', 'actorId', 'at', 'result', 'superseded']);
  string(e.recordId); string(e.actorId); utc(e.at);
  if (e.eventId !== eventId) refuse('PurposeBindingRefused');
  if (e.result !== null) {
    const r = object(e.result, ['draftId', 'intentId', 'recordId', 'versionId', 'signedAt', 'action', 'verified']);
    for (const k of ['draftId', 'intentId', 'recordId', 'versionId']) string(r[k]);
    choice(r.action, ['approve', 'addendum', 'amend']);
    if (r.verified !== true || utc(r.signedAt) !== e.at) refuse('PurposeBindingRefused');
    if (typeof reader.loadSignedResult !== 'function') refuse('PurposeBindingRefused');
    const signed = object(reader.loadSignedResult(r.recordId, r.versionId), ['draftId', 'intentId', 'recordId', 'versionId', 'signedAt', 'action', 'verified']);
    if (Object.keys(r).some(k => signed[k] !== r[k])) refuse('PurposeBindingRefused');
  }
  if (e.superseded !== null) {
    const f = e.superseded as IntentEndingFact;
    const extra = f.action === 'approve' ? ['authorId', 'draftId', 'versionId'] : f.action === 'cancel' ? ['versionId', 'reason'] : ['firstApprovedAt', 'amendUntil'];
    object(f, ['eventId', 'reportId', 'at', 'action', ...extra]);
    choice(f.action, ['approve', 'cancel', 'amend-window-closed']); string(f.eventId); string(f.reportId);
    extra.forEach(k => string(f[k]));
    if (e.trigger !== 'intent-superseded' || e.result !== null || utc(f.at) !== e.at || typeof reader.loadIntentEndingFact !== 'function') refuse('PurposeBindingRefused');
    const stored = reader.loadIntentEndingFact(f.eventId);
    if (JSON.stringify(stored) !== JSON.stringify(f)) refuse('PurposeBindingRefused');
    if (f.action === 'amend-window-closed' && (utc(f.amendUntil) !== f.at || Date.parse(f.amendUntil) - Date.parse(utc(f.firstApprovedAt)) !== DAY_MS)) refuse('PurposeBindingRefused');
  }
  const result = freeze(structuredClone(e)) as Readonly<PurposeEndEvent>;
  verifiedEnds.add(result); return result;
}
export function newPurposeRecord(source: ResolvedRecord, partIds: readonly string[]): Readonly<PurposeRecord> {
  return buildPurposeRecord(source, partIds, reloadLegalHolds(verifiedRecord(source).recordId));
}
function buildPurposeRecord(source: ResolvedRecord, partIds: readonly string[], holds: readonly LegalHold[]): Readonly<PurposeRecord> {
  const s = verifiedRecord(source);
  if (s.kinds.length !== 1) refuse('PurposeKindRequired');
  const kind = s.kinds[0], row = RECORD_CLASSIFICATION[kind];
  if (row.retention.mode !== 'purpose' || !row.retention.purposeEnds.length || !Array.isArray(partIds) || !partIds.length || new Set(partIds).size !== partIds.length)
    throw new Error('Purpose kind and complete revisions required');
  if (['private-draft', 'dictation'].includes(kind)) {
    const b = object(s.row.draftBinding, ['reportId', 'intentId', 'action']);
    string(b.reportId); string(b.intentId); choice(b.action, ['approve', 'addendum', 'amend']);
  }
  return freeze({ recordId: s.recordId, disposalUnitId: `disposal:${randomUUID()}`, kind, ownerId: string(['order', 'received-order'].includes(kind) ? s.row.authorId : s.row.ownerId),
    createdAt: s.event.at, partIds: partIds.map(id => string(id)), holds, source: s, destroyedAt: null });
}
function parsePurposeRecord(record: PurposeRecord): Readonly<PurposeRecord> {
  object(record, ['recordId', 'disposalUnitId', 'kind', 'ownerId', 'createdAt', 'partIds', 'holds', 'source', 'destroyedAt']);
  const parsed = buildPurposeRecord(record.source, record.partIds, record.holds);
  if (['recordId', 'kind', 'ownerId', 'createdAt'].some(k => parsed[k] !== record[k])) refuse('PurposeBindingRefused');
  const destroyedAt = record.destroyedAt === null ? null : utc(record.destroyedAt);
  if (destroyedAt !== null && destroyedAt < parsed.createdAt) refuse('RecordDestructionBindingRefused');
  return freeze({ ...parsed, disposalUnitId: opaqueUnit(record.disposalUnitId), holds: parseLegalHolds(record.holds, record.recordId, record.createdAt), destroyedAt });
}
export function placePurposeLegalHold(input: PurposeRecord, reader: LegalDutyReader, holdId: string): Readonly<PurposeRecord> {
  const record = parsePurposeRecord(input), hold = readLegalDuty(reader, holdId);
  if (record.destroyedAt !== null) refuse('RecordDestroyed');
  if (hold.release !== null) refuse('HoldReleaseBindingRefused');
  checkHoldEnd(hold, hold.at);
  return parsePurposeRecord({ ...record, holds: holdSet(record.recordId, [...record.holds, hold]) });
}
export function liftPurposeLegalHold(input: PurposeRecord, holdId: string, reader: LegalDutyReader): Readonly<PurposeRecord> {
  const record = parsePurposeRecord(input), held = record.holds.find(h => h.holdId === holdId);
  const released = readLegalDuty(reader, holdId);
  if (!held || held.release || !released.release || JSON.stringify({ ...released, release: null }) !== JSON.stringify(held)) refuse('HoldReleaseBindingRefused');
  return parsePurposeRecord({ ...record, holds: holdSet(record.recordId, record.holds.map(h => h === held ? released : h)) });
}
export interface PurposeDisposalStore extends DisposalAuditStore {
  withPurposeLock<T>(recordId: string, at: string, work: (current: PurposeRecord) => Promise<T>): Promise<T>;
}
/** Purpose hold registration uses the same current-row lock as purpose destruction. */
export async function withPurposeChange<T>(store: Pick<PurposeDisposalStore, 'withPurposeLock'>, input: PurposeRecord, at: string,
  changeAndPersist: (current: PurposeRecord) => Promise<T>): Promise<T> {
  const record = parsePurposeRecord(input);
  if (record.destroyedAt !== null) refuse('RecordDestroyed');
  if (typeof store.withPurposeLock !== 'function') refuse('RetentionLockRequired');
  return store.withPurposeLock(record.recordId, utc(at), async current => {
    if (JSON.stringify(parsePurposeRecord(current)) !== JSON.stringify(record)) refuse('PurposeSnapshotStale');
    requireStoredHolds(record);
    return changeAndPersist(current);
  });
}
/** The stored end identifies THIS draft's result, not an earlier approval of its parent. */
export async function destroyAtPurposeEnd(store: PurposeDisposalStore, record: PurposeRecord, event: PurposeEndEvent, requestedAt: string,
  destroy: (record: Readonly<PurposeRecord>) => Promise<DestructionReceipt>, justifiedDelay: Readonly<JustifiedDelay> | null): Promise<Readonly<DestructionRecord>> {
  const delay = parseJustifiedDelay(justifiedDelay);
  const parsed = parsePurposeRecord(record);
  if (parsed.destroyedAt !== null) refuse('RecordDestroyed');
  const e = event;
  if (!verifiedEnds.has(e) || !RECORD_CLASSIFICATION[parsed.kind].retention.purposeEnds.includes(e.trigger) ||
      e.recordId !== parsed.recordId || e.at <= parsed.createdAt) refuse('PurposeBindingRefused');
  if (['explicit-discard', 'owner-deleted'].includes(e.trigger) && e.actorId !== parsed.ownerId) refuse('PurposeOwnerRefused');
  if (['order', 'received-order'].includes(parsed.kind)) {
    const facts = parseOrderFacts(parsed.source.row), decision = facts.procedure?.decision;
    if (orderProcedureState(facts, requestedAt) !== 'clear') refuse('OrderReviewRequired');
    if (decision && (decision.at !== e.at || decision.actorId !== e.actorId || !decision.scope.includes(parsed.recordId) ||
        !['lawful-return', 'unnecessary-operations'].includes(decision.route) || e.trigger !== decision.route)) refuse('OrderDecisionBindingRefused');
    if (!decision && (e.trigger !== 'order-purpose-ended' || !['closed', 'cancelled', 'superseded'].includes(facts.status) ||
        facts.statusEvent.at !== e.at || facts.statusEvent.actorId !== e.actorId)) refuse('OrderDecisionBindingRefused');
  }
  if (e.trigger === 'result-version-signed') {
    const b = parsed.source.row.draftBinding, r = e.result;
    if (!b || !r || r.draftId !== parsed.recordId || r.intentId !== b.intentId || r.recordId !== b.reportId ||
        r.action !== b.action || r.signedAt !== e.at) refuse('PurposeBindingRefused');
  } else if (e.result !== null) refuse('PurposeBindingRefused');
  if (e.trigger === 'intent-superseded') {
    const b = parsed.source.row.draftBinding, f = e.superseded;
    if (!b || !f || f.reportId !== b.reportId || f.at !== e.at ||
        (f.action === 'approve' && (b.action !== 'approve' || f.authorId === parsed.ownerId || f.draftId === parsed.recordId)) ||
        (f.action === 'amend-window-closed' && b.action !== 'amend')) refuse('PurposeBindingRefused');
  } else if (e.superseded !== null) refuse('PurposeBindingRefused');
  if (typeof store.withPurposeLock !== 'function') refuse('RetentionLockRequired');
  requireExecutionStore(store);
  return store.withPurposeLock(parsed.recordId, utc(requestedAt), async current => {
  if (JSON.stringify(parsePurposeRecord(current)) !== JSON.stringify(parsed)) refuse('PurposeSnapshotStale');
  requireStoredHolds(parsed);
  if (parsed.holds.some(h => !h.release && h.basis.validity.until !== null && h.basis.validity.until <= requestedAt)) refuse('HoldReleaseRequired');
  parsed.holds.forEach(h => checkHoldEnd(h, requestedAt));
  if (parsed.holds.some(h => !h.release)) refuse('LegalHoldActive');
  const eligibleAt = [e.at, ...parsed.holds.map(h => h.release!.at)].sort().slice(-1)[0];
  if (utc(requestedAt) < eligibleAt) refuse('RetentionNotElapsed');
  const [completed] = await executeSet(store, [{ eligibleAt, justifiedDelay: delay, details: { disposalUnitId: parsed.disposalUnitId,
    classes: [], clauseIds: ['privacy:21.1'], partCount: parsed.partIds.length, expiryDay: seoulDay(e.at), extensionUsed: false } }],
    utc(requestedAt), freeze(parsed), destroy);
  return completed;
  });
}
export interface DestructionConfirmation {
  action: 'destruction-confirmed'; batchId: string; disposalUnitIds: readonly string[]; officerId: string; role: 'privacy-officer'; at: string;
}
export function confirmDestruction(batchId: string, completed: readonly DestructionRecord[], officerId: string, at: string): Readonly<DestructionConfirmation> {
  // Only operational-deletion completions; a supervision record or a format-1 receipt is not a completed destruction.
  if (!completed.length || completed.some(e => e.formatVersion !== 2 || e.kind !== 'operational-deletion' || e.phase !== 'completed' ||
      e.day > seoulDay(at))) throw new Error('Completed batch required');
  return freeze({ action: 'destruction-confirmed', batchId: string(batchId), disposalUnitIds: completed.map(e => opaqueUnit(e.disposalUnitId)),
    officerId: string(officerId), role: 'privacy-officer', at: utc(at) });
}

export const KEY_MANAGEMENT = freeze({
  operator: 'product', scope: 'per-doctor', sharedPrivateKey: false,
  privateKeyStore: 'protected-key-volume', wrappingSecret: 'separate-secret-outside-key-volume-and-database',
  identityRegistration: 'product-verifies-immutable-identity-and-medical-signing-authority-before-activation',
  custody: 'encrypted-private-keys; signer-bound-authenticated-use; no-private-key-export-to-browser-or-audit',
  recovery: 'verify-identity-and-authority; two-distinct-authorized-operators; encrypted-backup-and-separate-secret; issue-new-kid',
  recoveryFailure: 'block-signing-preserve-drafts-and-all-previous-signatures',
  revocation: 'immediate-on-loss-compromise-or-offboarding; append-reason-and-effective-time; block-new-signatures',
  verificationEvidence: 'person-linked-key-registration-and-revocation-evidence-follow-each-source-record-expiry',
  basis: '의료법 제23조①②; 시행규칙 제16조①1·2·3·5·6; 보관 방식과 복구 절차는 제품 보호 기본값',
});

export type KeyStatus = 'active' | 'suspended' | 'revoked' | 'retired';
export function transitionSigningKey(status: KeyStatus, action: 'suspend' | 'revoke' | 'retire' | 'recover'): KeyStatus {
  choice(status, ['active', 'suspended', 'revoked', 'retired']); choice(action, ['suspend', 'revoke', 'retire', 'recover']);
  if (action === 'revoke') return 'revoked';
  if (status === 'revoked' || status === 'retired') throw new Error('Terminal key cannot be reactivated; register a new key');
  return action === 'suspend' ? 'suspended' : 'retired'; // Recovery retires the old key, never silently re-enables it.
}
