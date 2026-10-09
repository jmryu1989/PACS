import { createHash, randomUUID } from 'node:crypto';
import { RecordKind, ResolvedRecord, verifiedRecord } from '../emr-contract/classification';
import { AccessEvent, AccessTarget, AppendOnlyAccessStore, DurableAccessReceipt, ImmutableIdentity, identity, parseAccessEvent,
  patientLink, provideAfterDurableEvent } from '../emr-contract/access-event';
import { AttachmentReference, VersionReference, versionReference } from '../emr-contract/signature';
import { ContractError, choice, freeze, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';
import { AUTHORITY_FIELDS, ActorFacts, CLINICAL_SURFACES, ClinicalRecord, ClinicalUnit, ClinicalVersion, EntryClass, MANUAL_SR_PREPARATION_MS,
  READ_ROUTES, READ_SCOPES, SignatureEvidence, SigningRequest, StudyFacts, SurfaceKey, SurfacePath, SurfaceSpec, TextRule, WorkContext,
  WriteReceipt, accessAction, entryClass, holds, resolvePath, signatureAction, versionAct } from './contract';

/**
 * Pure plans for EMR unit D (see contract.ts). Every write appends exactly one immutable version; the stored row is a
 * projection that always equals the fold of its versions, and every permission-deciding party comes from the opening
 * version, never from the projection. A clinical entry is only ever committed together with a signature C verified for
 * that exact version and author; a failed or unverifiable signature commits nothing.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const ref = (v: Pick<ClinicalVersion, 'recordId' | 'versionId' | 'sha256'>): VersionReference => ({ recordId: v.recordId, versionId: v.versionId, sha256: v.sha256 });
const sameRef = (a: VersionReference | null, b: VersionReference | null) =>
  a === b || (!!a && !!b && a.recordId === b.recordId && a.versionId === b.versionId && a.sha256 === b.sha256);
const sameIdentity = (a: ImmutableIdentity, b: ImmutableIdentity) => a.id === b.id && a.issuer === b.issuer && a.subject === b.subject;
/** Deterministic JSON: object keys sorted at every depth, arrays in order, strings exact (no trimming or normalisation). */
const canonical = (value: unknown) => JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

// ---------- server facts ----------

function actorFacts(input: unknown): Readonly<ActorFacts> {
  const a = object(input, ['identity', 'kind', 'roles', 'institutionId', 'signingRegistrationId']);
  if (!Array.isArray(a.roles) || new Set(a.roles).size !== a.roles.length) refuse('ActorFactsRequired');
  return { identity: identity(a.identity), kind: choice(a.kind, ['member', 'service']), roles: a.roles.map(r => string(r)),
    institutionId: string(a.institutionId), signingRegistrationId: a.signingRegistrationId === null ? null : string(a.signingRegistrationId) };
}
function studyFacts(input: unknown): Readonly<StudyFacts> {
  const s = object(input, ['studyId', 'managingInstitutionId', 'patient']);
  return { studyId: string(s.studyId), managingInstitutionId: string(s.managingInstitutionId), patient: patientLink(s.patient) };
}
function workContext(input: unknown): Readonly<WorkContext> | null {
  if (input === null) return null;
  const c = object(input, ['kind', 'studyId', 'referenceId']);
  return { kind: choice(c.kind, ['reading', 'acquisition']), studyId: string(c.studyId), referenceId: string(c.referenceId) };
}

/** One institution boundary for reads and writes: only the record's managing institution (see StudyFacts, LR-20/D-4). */
export function institutionAdmits(institutionId: string, managing: string): boolean {
  return institutionId === managing;
}

// ---------- versions and the projection ----------

function versionDigest(v: Omit<ClinicalVersion, 'sha256'>): string {
  // Fixed field order is the format; JSON keeps the exact UTF-8 text (no normalization or trimming).
  return hex(JSON.stringify([v.formatVersion, v.record, v.recordId, v.versionId, v.sequence, v.previousVersion, v.surface, v.entry, v.capacity,
    v.kind, v.act, v.author, v.actingInstitutionId, v.text, v.contentSha256, v.reason, v.reasonSource, v.attachments, v.navigation, v.state,
    v.readerId, v.recipientId, v.studyId, v.managingInstitutionId, v.patient, v.at]));
}

export interface UnitProjection {
  state: string; revision: number; head: VersionReference | null; clinicalEntry: boolean;
  parties: { authorId: string; recipientId: string | null };
}
/**
 * Re-derives the projection from the append-only history and refuses a unit whose stored projection, chain links or
 * digests disagree with it. A dropped, reordered or rewritten earlier version is detected, not silently projected.
 * The author and recipient are those of the opening version: a rewritten `parties` projection is refused.
 */
export function projectUnit(unit: ClinicalUnit): Readonly<UnitProjection> {
  const u = object(unit, ['record', 'recordId', 'studyId', 'managingInstitutionId', 'patient', 'parties', 'state', 'revision',
    'head', 'clinicalEntry', 'versions']) as ClinicalUnit;
  if (!Array.isArray(u.versions) || !u.versions.length) refuse('UnitHistoryBroken');
  let previous: ClinicalVersion | null = null, marked = false;
  // Any malformed stored version is the same finding as a tampered one: the history cannot be trusted.
  try {
    u.versions.forEach((v, index) => {
      if (!v || typeof v !== 'object' || typeof v.surface !== 'string' || !own(CLINICAL_SURFACES, v.surface)) refuse('UnitHistoryBroken');
      const { sha256: digest, ...rest } = v;
      if (v.formatVersion !== 'emr-clinical/1' || v.record !== u.record || v.recordId !== u.recordId || v.sequence !== index + 1 ||
          v.studyId !== u.studyId || v.managingInstitutionId !== u.managingInstitutionId || canonical(v.patient) !== canonical(u.patient) ||
          versionDigest(rest) !== sha256(digest) || (index > 0 && v.recipientId !== null) ||
          !sameRef(v.previousVersion, previous ? ref(previous) : null) || v.state.from !== (previous ? previous.state.to : null) ||
          (previous && utc(v.at) < previous.at)) refuse('UnitHistoryBroken');
      if (v.entry === 'clinical-entry' && (CLINICAL_SURFACES[v.surface] as SurfaceSpec).marksClinicalEntry) marked = true;
      previous = v;
    });
  } catch { refuse('UnitHistoryBroken'); }
  const first = u.versions[0];
  const parties = { authorId: first.author.id, recipientId: first.recipientId };
  const projection = { state: previous.state.to, revision: u.versions.length, head: ref(previous), clinicalEntry: marked, parties };
  if (u.state !== projection.state || u.revision !== projection.revision || !sameRef(u.head, projection.head) || u.clinicalEntry !== projection.clinicalEntry ||
      !u.parties || u.parties.authorId !== parties.authorId || u.parties.recipientId !== parties.recipientId) refuse('UnitHistoryBroken');
  return freeze(projection);
}

// ---------- write planning ----------

export interface WriteInput {
  surface: string;
  actor: ActorFacts;
  study: StudyFacts;
  unit: ClinicalUnit | null;
  /** The client JSON body exactly as received; its request ID keys the receipt and every other field is its meaning. */
  body: unknown;
  /** Server-built text for 'server' surfaces (the finding's canonical snapshot); null elsewhere. */
  content: string | null;
  /** A-resolved stored records the body named for incorporation, in body order. */
  attachments: readonly ResolvedRecord[];
  /** Comparison study IDs linked for navigation only; never incorporated components. */
  navigation: readonly string[];
  /** Server-resolved party identities: the consultation recipient, the assigned reader. */
  recipientId: string | null;
  readerId: string | null;
  /** Server fact: the author's current reading of this study, or null. Binds a correction reason (D-18). */
  workContext: WorkContext | null;
  ids: { recordId: string; versionId: string };
  at: string;
}
export interface ClinicalWritePlan {
  surface: SurfaceKey; record: ClinicalRecord; opening: boolean; requestId: string; fingerprint: string;
  receiptKey: { record: ClinicalRecord; actorId: string; requestId: string };
  entry: EntryClass; version: ClinicalVersion;
  projection: { state: string; revision: number; head: VersionReference; clinicalEntry: boolean };
  parties: ClinicalUnit['parties'];
  signing: SigningRequest | null;
  access: { route: string; action: 'write' | 'additional-entry' | 'modify' | 'cancel'; target: AccessTarget };
  receipt: WriteReceipt;
}

function normalized(spec: SurfaceSpec, key: string, value: unknown) {
  const rule = spec.normalize?.[key];
  return typeof value !== 'string' ? value : rule === 'trim' ? value.trim() : rule === 'lower' ? value.toLowerCase() : value;
}

function clientBody(spec: SurfaceSpec, input: unknown, actor: ActorFacts) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('RequestShapeRefused');
  // A claimed server fact is refused by name before any shape check, whatever else the body says.
  if (Object.keys(input).some(key => AUTHORITY_FIELDS.includes(key) && !spec.client.includes(key))) refuse('AuthorityFieldRefused');
  const optional = (spec.optional ?? []).filter(key => own(input, key));
  let b: Record<string, any> = null;
  try { b = object(input, [...spec.client, ...optional]); } catch { refuse('RequestShapeRefused'); }
  const idField = spec.requestField ?? 'requestId';
  const requestId = b[idField];
  if (typeof requestId !== 'string' || !UUID.test(requestId)) refuse('RequestShapeRefused');
  if (spec.ownerField && JSON.stringify(b.expectedOwner) !== JSON.stringify([actor.institutionId, actor.identity.subject])) refuse('OwnerChanged');
  if (spec.action !== undefined && b.action !== spec.action) refuse('RequestShapeRefused');
  let revision: number | null = null;
  if (spec.revisionField) {
    // Units that open on their first write count revisions from 0 (no row yet), as the services do.
    try { revision = integer(b[spec.revisionField], spec.opens === 'if-absent' ? 0 : 1); } catch { refuse('RequestShapeRefused'); }
  }
  // Every field but the request ID and the owner assertion gives the request its meaning; an empty optional field is absent.
  const meaning = Object.fromEntries(Object.keys(b)
    .filter(key => key !== idField && key !== 'expectedOwner')
    .filter(key => !((spec.optional ?? []).includes(key) && b[key] === ''))
    .map(key => [key, normalized(spec, key, b[key])]));
  return { requestId: requestId.toLowerCase(), revision, b, meaning };
}

type Text = { text: string | null; reason: string | null; reasonSource: 'stated' | 'work-context' | null };
function textFor(rule: TextRule, b: Record<string, any>, spec: SurfaceSpec, content: string | null, opening: boolean,
  context: Readonly<WorkContext> | null): Text {
  const field = spec.textField === null ? undefined : b[spec.textField];
  const stated = (text: string | null): Text => spec.cancel && text !== null ? { text, reason: text, reasonSource: 'stated' } : { text, reason: null, reasonSource: null };
  switch (rule) {
    case 'replace': {
      // pacs.service.ts:1190/1208/1209: the first version needs text; a NEW later one (including clearing) needs a reason, which
      // inside the author's own work context the server binds (D-18/D734); only an out-of-context amendment asks for one.
      const reason = b[spec.reasonField];
      if (typeof field !== 'string' || typeof reason !== 'string' || content !== null) refuse('RequestShapeRefused');
      string(field, true); string(reason, true);
      if (opening && !field.trim()) refuse('TextRequired');
      if (opening || reason.trim()) return { text: field, reason: reason.trim() || null, reasonSource: reason.trim() ? 'stated' : null };
      if (context) return { text: field, reason: `work-context:${context.kind}:${context.referenceId}`, reasonSource: 'work-context' };
      return refuse('ReasonRequired');
    }
    case 'none': if (content !== null) refuse('TextRefused'); return stated(null);
    case 'empty': if (field !== '' || content !== null) refuse('TextRefused'); return stated(null);
    case 'optional': if (typeof field !== 'string' || content !== null) refuse('TextRequired'); string(field, true);
      return stated(field === '' ? null : field);
    case 'required': if (typeof field !== 'string' || !field.trim() || content !== null) refuse('TextRequired'); string(field);
      return stated(field);
    case 'server': {
      if (typeof content !== 'string' || !content.trim()) refuse('TextRequired');
      string(content);
      const given = own(b, 'reason') ? b.reason : '';
      if (typeof given !== 'string') refuse('RequestShapeRefused');
      string(given, true);
      if (!spec.contextReason) {
        if (given !== '') refuse('TextRefused');
        return { text: content, reason: null, reasonSource: null };
      }
      if (given.trim()) return { text: content, reason: given, reasonSource: 'stated' };
      // D-18: inside the author's reading of this study the server binds the reason; no typed line in the normal flow.
      if (context) return { text: content, reason: `work-context:${context.kind}:${context.referenceId}`, reasonSource: 'work-context' };
      return refuse('ReasonRequired');
    }
  }
  return refuse('TextRefused');
}

function attachmentsFor(spec: SurfaceSpec, resolved: readonly ResolvedRecord[]): AttachmentReference[] {
  if (!Array.isArray(resolved)) refuse('AttachmentRefused');
  const refs = resolved.map(input => {
    // Kind and hash come from the A resolver's stored facts; an object that was not resolved there is refused.
    const r = verifiedRecord(input);
    const kind = r.kinds.find(k => spec.attachments.includes(k));
    if (!kind) refuse('AttachmentRefused');
    return { kind, recordId: r.recordId, versionId: r.event.versionId, sha256: r.event.sha256 };
  });
  if (new Set(refs.map(a => `${a.recordId}\0${a.versionId}`)).size !== refs.length) refuse('AttachmentRefused');
  return refs;
}

/**
 * What a replay must already satisfy: the surface, a trustworthy stored history, the actor's institution and path, and
 * the body's shape. The fingerprint is the canonical request alone (surface, route target, actor, institution and the
 * body's meaning), so the first send and its replay match even when the stored unit has moved on since. Every rule
 * that depends on the current unit (revision, state, reasons for a new amendment) runs only after the replay check.
 */
function admit(input: WriteInput) {
  const w = object(input, ['surface', 'actor', 'study', 'unit', 'body', 'content', 'attachments', 'navigation', 'recipientId', 'readerId',
    'workContext', 'ids', 'at']);
  if (typeof w.surface !== 'string' || !own(CLINICAL_SURFACES, w.surface)) refuse('ClinicalSurfaceUnknown');
  const surface = w.surface as SurfaceKey, spec: SurfaceSpec = CLINICAL_SURFACES[surface];
  const actor = actorFacts(w.actor), study = studyFacts(w.study), unit: ClinicalUnit | null = w.unit;
  const ids = object(w.ids, ['recordId', 'versionId']), recordId = string(ids.recordId);
  let projection: Readonly<UnitProjection> | null = null;
  if (unit !== null) {
    projection = projectUnit(unit);
    if (unit.record !== spec.record || unit.studyId !== study.studyId || unit.recordId !== recordId) refuse('NotFound');
  }
  if (spec.opens === false && unit === null) refuse('NotFound');
  // The institution boundary is checked before anything about the record is revealed by a later, more specific refusal.
  const managing = unit?.managingInstitutionId ?? study.managingInstitutionId;
  if (!institutionAdmits(actor.institutionId, managing)) refuse('NotFound');
  const { requestId, revision, b, meaning } = clientBody(spec, w.body, actor);
  const path: SurfacePath = resolvePath(surface, actor, projection ? { parties: projection.parties } : null);
  // The route target, not the stored unit: a write that opens a unit and its replay name the same study.
  const target = [study.studyId, spec.route.includes(':id') ? recordId : null];
  const fingerprint = hex(canonical([surface, target, actor.identity.id, actor.institutionId, meaning]));
  const receiptKey = { record: spec.record, actorId: actor.identity.id, requestId };
  return { w, surface, spec, actor, study, unit, projection, recordId, versionId: ids.versionId, managing, requestId, revision, b, path,
    fingerprint, receiptKey };
}

/** The idempotency identity of a write, available before revision/state checks so that a replay can be answered first. */
export function prepareClinicalWrite(input: WriteInput) {
  const a = admit(input);
  return freeze({ requestId: a.requestId, fingerprint: a.fingerprint, receiptKey: a.receiptKey });
}

export function planClinicalWrite(input: WriteInput): Readonly<ClinicalWritePlan> {
  const { w, surface, spec, actor, study, unit, projection, recordId, managing, requestId, revision, b, path, fingerprint, receiptKey } = admit(input);
  const opening = unit === null, at = utc(w.at), versionId = string(w.ids.versionId);
  if (spec.opens === true && unit !== null) refuse('UnitExists');
  const context = workContext(w.workContext);
  const { text, reason, reasonSource } = textFor(path.text ?? spec.text, b, spec, w.content, opening,
    context && context.studyId === study.studyId && (spec.contextReason ?? []).includes(context.kind) ? context : null);
  const entry = entryClass(spec, path, text);
  if (spec.revisionField && revision !== (unit?.revision ?? 0)) refuse('StaleRevision');
  const from = unit?.state ?? null;
  if (!spec.from.includes(from)) refuse('StateTransitionRefused');
  let readerId: string | null = null;
  if (spec.record === 'assignment') {
    if ((b.readerSub === null) !== (w.readerId === null)) refuse('RequestShapeRefused');
    readerId = w.readerId === null ? null : string(w.readerId);
  } else if (w.readerId !== null) refuse('RequestShapeRefused');
  const to = path.to ?? (spec.to === 'same' ? from : spec.to === 'reader' ? (readerId ? 'Assigned' : 'Unassigned') : spec.to);
  const attachments = attachmentsFor(spec, w.attachments);
  if (!Array.isArray(w.navigation) || (!spec.navigation && w.navigation.length) ||
      new Set(w.navigation).size !== w.navigation.length || w.navigation.some(id => string(id) === study.studyId)) refuse('NavigationRefused');
  const navigation: string[] = [...w.navigation];
  const recipientId = spec.record === 'consultation' && opening ? string(w.recipientId) : (w.recipientId === null ? null : refuse('RequestShapeRefused'));
  if (entry === 'clinical-entry' && actor.signingRegistrationId === null) refuse('SigningIdentityRequired');
  if (unit?.versions.some(v => v.versionId === versionId)) refuse('VersionIdReused');
  if (unit && at < unit.versions[unit.versions.length - 1].at) refuse('ServerTimeRegressed');

  const act = versionAct(spec, entry, opening);
  const previousVersion = unit?.head ? versionReference(unit.head) : null;
  const patient = unit ? patientLink(unit.patient) : study.patient;
  const draft: Omit<ClinicalVersion, 'sha256'> = {
    formatVersion: 'emr-clinical/1', record: spec.record, recordId, versionId, sequence: (unit?.versions.length ?? 0) + 1, previousVersion,
    surface, entry, capacity: path.capacity, kind: path.kind, act, author: actor.identity, actingInstitutionId: actor.institutionId,
    text, contentSha256: text === null ? null : hex(Buffer.from(text, 'utf8')), reason, reasonSource, attachments, navigation,
    state: { from, to }, readerId, recipientId, studyId: study.studyId, managingInstitutionId: managing, patient, at,
  };
  const version: ClinicalVersion = { ...draft, sha256: versionDigest(draft) };
  const head = ref(version);
  const clinicalEntry = (projection?.clinicalEntry ?? false) || (entry === 'clinical-entry' && spec.marksClinicalEntry === true);
  const signing: SigningRequest | null = entry !== 'clinical-entry' ? null : {
    recordKind: path.kind, recordId, versionId, versionSha256: version.sha256,
    content: { kind: 'text', body: text, sha256: version.contentSha256 },
    patient, studyId: study.studyId, managingInstitutionId: managing, actingInstitutionId: actor.institutionId,
    // No proxy signing: the signer is always the author of the entry.
    author: actor.identity, signer: actor.identity, identityRegistrationId: actor.signingRegistrationId,
    action: signatureAction(spec, act), previousVersion, attachments, reason,
  };
  const target: AccessTarget = { kind: path.kind, patientLinkSnapshot: { status: 'known', value: patient },
    studyId: { status: 'known', value: study.studyId }, recordId: { status: 'known', value: recordId }, versionId: { status: 'known', value: versionId } };
  return freeze(structuredClone({
    surface, record: spec.record, opening, requestId, fingerprint, receiptKey,
    entry, version, projection: { state: to, revision: version.sequence, head, clinicalEntry },
    parties: projection ? projection.parties : { authorId: actor.identity.id, recipientId },
    signing, access: { route: spec.route, action: accessAction(spec, entry, act, opening), target },
    // The receipt is what replays, lists and conflicts may return: identifiers and state, never clinical text.
    receipt: { requestId, fingerprint, recordId, versionId, versionSha256: version.sha256, revision: version.sequence, state: to, at },
  }));
}

/** Pure append: prior versions are carried unchanged and the new one must extend the current head. */
export function applyPlan(unit: ClinicalUnit | null, plan: ClinicalWritePlan): Readonly<ClinicalUnit> {
  if (unit !== null) projectUnit(unit);
  if (!sameRef(plan.version.previousVersion, unit?.head ?? null) || plan.version.sequence !== (unit?.versions.length ?? 0) + 1) refuse('StaleRevision');
  const study = unit ?? { studyId: plan.version.studyId, managingInstitutionId: plan.version.managingInstitutionId, patient: plan.version.patient };
  const next: ClinicalUnit = {
    record: plan.record, recordId: plan.version.recordId, studyId: study.studyId, managingInstitutionId: study.managingInstitutionId,
    patient: study.patient, parties: plan.parties,
    state: plan.projection.state, revision: plan.projection.revision, head: plan.projection.head, clinicalEntry: plan.projection.clinicalEntry,
    versions: [...(unit?.versions ?? []), plan.version],
  };
  const result = freeze(structuredClone(next));
  projectUnit(result);
  return result;
}

// ---------- signature acceptance and the single commit ----------

/** Accepts only C's complete verification of this exact version by its own author's registered identity. */
export function acceptSignature(plan: ClinicalWritePlan, evidence: unknown): Readonly<SignatureEvidence> {
  const s = plan.signing;
  if (!s) refuse('SignatureNotExpected');
  let e: Record<string, any>, v: Record<string, any>;
  try {
    e = object(evidence, ['recordId', 'versionId', 'versionSha256', 'signer', 'identityRegistrationId', 'verification']);
    v = object(e.verification, ['integrity', 'registeredIdentity', 'keyAtSigningTime', 'compromise']);
  } catch { refuse('SignatureNotVerified'); }
  if (v.integrity !== 'valid' || v.registeredIdentity !== 'matched' || v.keyAtSigningTime !== 'active' || v.compromise !== 'not-known')
    refuse('SignatureNotVerified');
  if (e.recordId !== s.recordId || e.versionId !== s.versionId || e.versionSha256 !== s.versionSha256) refuse('SignatureBindingRefused');
  let signer: ImmutableIdentity;
  try { signer = identity(e.signer); } catch { refuse('SignatureNotVerified'); }
  if (!sameIdentity(signer, s.author) || e.identityRegistrationId !== s.identityRegistrationId) refuse('ProxySignatureRefused');
  return freeze(structuredClone(e) as SignatureEvidence);
}

export interface SignaturePort {
  /** C must reconcile this operation ID after a lost answer; recovery signs only the fixed original author/payload. */
  sign(request: Readonly<SigningRequest>, operation?: { originalId: string }): Promise<unknown>;
  verify(envelope: unknown, request: Readonly<SigningRequest>): Promise<unknown>;
}
export interface UnitOfWork {
  plan: Readonly<ClinicalWritePlan>;
  signature: { envelope: unknown; evidence: Readonly<SignatureEvidence> } | null;
}
export interface RequestIdentity { receiptKey: ClinicalWritePlan['receiptKey']; fingerprint: string }
export interface OriginalIdentity extends RequestIdentity { originalId: string }
/** Adapter-issued capability, never decoded from an HTTP body. The DB must also enforce the epoch under its K lock. */
declare const originalPermit: unique symbol;
export interface OriginalPermit { readonly original: OriginalIdentity; readonly epoch: number; readonly [originalPermit]: true }
export type OriginalPhase = 'admitted' | 'prepared' | 'signed' | 'commit-dispatched';
export interface OriginalCheckpoint {
  phase: Exclude<OriginalPhase, 'admitted'>; work: Readonly<UnitOfWork>;
  /** Preserved before verification so recovery can reuse a returned envelope without another sign operation. */
  envelope?: unknown;
}
export interface OriginalExecution {
  permit: OriginalPermit;
  /** B1 persists the exact input/facts, with protected references re-resolved as A capabilities on recovery. */
  seed: Readonly<WriteInput>;
  checkpoint: Readonly<OriginalCheckpoint> | null;
}
export interface CommittedProof {
  original: OriginalIdentity; epoch: number; transactionId: string; changeId: string;
  receipt: WriteReceipt; version: VersionReference; signature: SignatureEvidence | null;
}
export interface RejectedProof {
  original: OriginalIdentity; epoch: number; rejectionId: string; code: string;
  fencedThrough: number; noClinicalEffects: true;
}
export type RequestObservation =
  | { state: 'absent' }
  | { state: 'unavailable' }
  | { state: 'pending'; original: OriginalIdentity; epoch: number; phase: OriginalPhase }
  | { state: 'committed'; original: OriginalIdentity; epoch: number; binding: Readonly<UnitOfWork>; proof: CommittedProof }
  | { state: 'rejected'; original: OriginalIdentity; epoch: number; proof: RejectedProof };
export type OriginalAdmission = { kind: 'owner'; execution: OriginalExecution } | { kind: 'observer'; observation: RequestObservation };
export interface OriginalRollbackProof { original: OriginalIdentity; epoch: number; transactionId: string; noClinicalEffects: true }
/** A bare exception is an attempt error, NOT durable rejection evidence. Only B1 can attest its own transaction. */
export class CommitRolledBack extends Error {
  constructor(message = 'Clinical write rolled back', readonly proof: OriginalRollbackProof | null = null) {
    super(message); this.name = 'CommitRolledBack';
  }
}
export type RejectionEvidence = { code: string; cause: 'not-dispatched' } |
  { code: 'StorageFailed'; cause: 'rollback'; rollback: OriginalRollbackProof };
export interface RequestAttemptEvent {
  attemptId: string; request: RequestIdentity | null; originalId: string | null; code: string;
}
/**
 * B1/B2 handover, NOT an in-process lock implementation. All writers use one durable K/F/O register:
 * - admission serializes K, fixes F/seed/O, and gives only the first call an original permit. Existing R/C absorb retries.
 * - observations are authoritative. Existing-key lookups record service-job O, never clinical H or body-delivery L.
 * - checkpoints must be durable before the next external effect. False fences an old/terminal permit without effects.
 * - commit checks epoch and commit-dispatched under the same lock, atomically saving V/S/projection/H/receipt/C.
 * - sealing proves no commit was dispatched OR attests the ORIGINAL rollback, fences every prior epoch, saves R/J.
 *   The original rejection cause survives a failed seal for recovery; a lost seal answer is reconciled by observe.
 * - recovery is server-only: fence prior owners under that lock, resume fixed admitted/prepared/signed intent. For
 *   dispatched work, wait for its transaction; return C/R or seal StorageFailed only with zero-effects/fence proof.
 *   Elapsed time/lease/absent receipt alone never permits recovery commit or rejection.
 * - pending/terminal keys are not TTL-deleted/reused. Legacy writers must drain/reconcile before absent means new.
 * B1 must provide restart scanning as well as wakeRecovery. This interface/types do not prove actual DB durability.
 */
export interface ClinicalStorePort {
  admitOrObserve(request: RequestIdentity, seed: Readonly<WriteInput>, attemptId: string): Promise<OriginalAdmission>;
  observe(request: RequestIdentity, attemptId: string, external: boolean): Promise<RequestObservation>;
  checkpoint(permit: OriginalPermit, value: Readonly<OriginalCheckpoint>): Promise<boolean>;
  commitOriginal(permit: OriginalPermit, work: Readonly<UnitOfWork>): Promise<RequestObservation>;
  sealRejected(permit: OriginalPermit, evidence: RejectionEvidence, attemptId: string): Promise<RequestObservation>;
  recoverOriginal(request: RequestIdentity, attemptId: string): Promise<OriginalAdmission>;
  wakeRecovery(request: RequestIdentity): Promise<void>;
  /** J only, deduplicated by attemptId/code. No clinical body in this journal. */
  noteAttempt(event: RequestAttemptEvent): Promise<void>;
}
export type CommitOutcome =
  | Readonly<{ status: 'committed' | 'replayed'; receipt: WriteReceipt }>
  | Readonly<{ status: 'failed' | 'unknown'; code: string; retry: 'same-request' }>;

const failed = (code: string): CommitOutcome => freeze({ status: 'failed' as const, code, retry: 'same-request' as const });
const unknownOutcome = (): CommitOutcome => freeze({ status: 'unknown' as const, code: 'OutcomeUnknown', retry: 'same-request' as const });
const codeOf = (error: unknown) => error instanceof ContractError ? error.code : 'SignatureNotVerified';
const sameRequest = (a: RequestIdentity, b: RequestIdentity) => !!a && !!b && a.fingerprint === b.fingerprint &&
  canonical(a.receiptKey) === canonical(b.receiptKey);
const sameOriginal = (a: OriginalIdentity, b: OriginalIdentity) => sameRequest(a, b) && !!a.originalId && a.originalId === b.originalId;

/** The sole request-outcome decision. Throws/refusals belong to a call; only matching Ec/Er terminates the original. */
export function decideRequestOutcome(request: RequestIdentity, observation: RequestObservation, role: 'owner' | 'observer'): CommitOutcome {
  if (observation.state === 'unavailable') return unknownOutcome();
  if (observation.state === 'absent' || observation.state === 'pending') return unknownOutcome();
  try {
    const o = observation, p = o.proof;
    if (!sameRequest(request, o.original) || !sameOriginal(o.original, p.original) || p.epoch !== o.epoch || integer(o.epoch, 1) < 1)
      return unknownOutcome();
    if (o.state === 'rejected') {
      const er = o.proof;
      if (!er.noClinicalEffects || er.fencedThrough < o.epoch || !string(er.rejectionId) || !string(er.code)) return unknownOutcome();
      return failed(er.code);
    }
    const ec = o.proof, plan = o.binding.plan;
    if (!sameRequest(request, plan) || canonical(ec.receipt) !== canonical(plan.receipt) ||
        !sameRef(ec.version, ref(plan.version)) || !sameRef(ec.version, { recordId: ec.receipt.recordId,
          versionId: ec.receipt.versionId, sha256: ec.receipt.versionSha256 }) || !string(ec.transactionId) || !string(ec.changeId)) return unknownOutcome();
    if (plan.signing) {
      acceptSignature(plan, ec.signature);
      if (canonical(ec.signature) !== canonical(o.binding.signature?.evidence)) return unknownOutcome();
    } else if (ec.signature !== null || o.binding.signature !== null) return unknownOutcome();
    // Explicit receipt projection prevents an adapter accidentally exposing its stored intent or clinical text.
    const r = ec.receipt;
    return freeze({ status: role === 'owner' ? 'committed' : 'replayed', receipt: {
      requestId: r.requestId, fingerprint: r.fingerprint, recordId: r.recordId, versionId: r.versionId,
      versionSha256: r.versionSha256, revision: r.revision, state: r.state, at: r.at,
    } });
  } catch { return unknownOutcome(); }
}

type WritePorts = { store: ClinicalStorePort; signature: SignaturePort };
const unavailable = (): RequestObservation => ({ state: 'unavailable' });
async function note(store: ClinicalStorePort, request: RequestIdentity | null, attemptId: string, code: string, originalId: string | null = null) {
  try { await store.noteAttempt({ attemptId, request, originalId, code }); } catch { /* No terminal is inferred from journal availability. */ }
}
async function observe(store: ClinicalStorePort, request: RequestIdentity, attemptId: string, external = false): Promise<RequestObservation> {
  try { return await store.observe(request, attemptId, external); }
  catch (error) {
    if (error instanceof ContractError && error.code === 'RequestIdReused') throw error;
    await note(store, request, attemptId, 'ObservationUnavailable'); return unavailable();
  }
}
async function outcome(store: ClinicalStorePort, request: RequestIdentity, observed: RequestObservation, role: 'owner' | 'observer', attemptId: string) {
  const result = decideRequestOutcome(request, observed, role);
  if (result.status === 'unknown') {
    if (observed.state === 'committed' || observed.state === 'rejected') await note(store, request, attemptId, 'InvalidOutcomeEvidence');
    try { await store.wakeRecovery(request); } catch { await note(store, request, attemptId, 'RecoveryUnavailable'); }
  }
  return result;
}
async function seal(store: ClinicalStorePort, execution: OriginalExecution, evidence: RejectionEvidence, attemptId: string) {
  const request = execution.permit.original;
  try { return await store.sealRejected(execution.permit, evidence, attemptId); }
  catch { await note(store, request, attemptId, 'RejectionUnavailable', request.originalId); return observe(store, request, attemptId); }
}

/** Only admission/recovery's capability reaches this path. Every callback checkpoints before another external effect. */
async function executeOriginal(ports: WritePorts, execution: OriginalExecution, attemptId: string): Promise<RequestObservation> {
  const { store, signature } = ports, { permit } = execution, request = permit.original;
  let work = execution.checkpoint?.work;
  if (execution.checkpoint?.phase === 'commit-dispatched') return observe(store, request, attemptId);
  if (!work) {
    try { work = { plan: planClinicalWrite(execution.seed), signature: null }; }
    catch (error) { return seal(store, execution, { cause: 'not-dispatched', code: error instanceof ContractError ? error.code : 'RequestShapeRefused' }, attemptId); }
  }
  try {
    const plan = work.plan;
    if (!sameRequest(request, plan)) return unavailable();
    if (!(await store.checkpoint(permit, { phase: work.signature ? 'signed' : 'prepared', work }))) return observe(store, request, attemptId);
    if (plan.signing && !work.signature) {
      let envelope = execution.checkpoint?.envelope, evidence: unknown;
      try { if (envelope === undefined) envelope = await signature.sign(plan.signing, { originalId: request.originalId }); }
      catch { return seal(store, execution, { cause: 'not-dispatched', code: 'SignatureFailed' }, attemptId); }
      if (!(await store.checkpoint(permit, { phase: 'prepared', work, envelope }))) return observe(store, request, attemptId);
      try { evidence = await signature.verify(envelope, plan.signing); }
      catch { return seal(store, execution, { cause: 'not-dispatched', code: 'SignatureFailed' }, attemptId); }
      let accepted: SignatureEvidence;
      try { accepted = acceptSignature(plan, evidence); }
      catch (error) { return seal(store, execution, { cause: 'not-dispatched', code: codeOf(error) }, attemptId); }
      work = { plan, signature: { envelope, evidence: accepted } };
      if (!(await store.checkpoint(permit, { phase: 'signed', work }))) return observe(store, request, attemptId);
    }
    if (!(await store.checkpoint(permit, { phase: 'commit-dispatched', work }))) return observe(store, request, attemptId);
    try { return await store.commitOriginal(permit, work); }
    catch (error) {
      const rollback = error instanceof CommitRolledBack ? error.proof : null;
      if (rollback && sameOriginal(rollback.original, request) && rollback.epoch === permit.epoch && rollback.noClinicalEffects && rollback.transactionId)
        return seal(store, execution, { cause: 'rollback', code: 'StorageFailed', rollback }, attemptId);
      await note(store, request, attemptId, 'CommitOutcomeUnknown', request.originalId);
      return observe(store, request, attemptId);
    }
  } catch { await note(store, request, attemptId, 'CheckpointUnavailable', request.originalId); return observe(store, request, attemptId); }
}

async function checkedRequest(store: ClinicalStorePort, input: WriteInput, attemptId: string) {
  try { return prepareClinicalWrite(input); }
  catch (error) { await note(store, null, attemptId, error instanceof ContractError ? error.code : 'RequestShapeRefused'); throw error; }
}
/** retry=same-request means result lookup, including after R. Corrected content needs a NEW request ID. */
export async function commitClinicalWrite(ports: WritePorts, input: WriteInput,
  options: { waitExpired?: Promise<void>; attemptId?: string } = {}): Promise<CommitOutcome> {
  const attemptId = options.attemptId ?? randomUUID();
  const admitted = await checkedRequest(ports.store, input, attemptId);
  let admission: OriginalAdmission;
  try { admission = await ports.store.admitOrObserve(admitted, input, attemptId); }
  catch (error) {
    if (error instanceof ContractError && error.code === 'RequestIdReused') throw error;
    await note(ports.store, admitted, attemptId, 'AdmissionUnavailable');
    return outcome(ports.store, admitted, unavailable(), 'observer', attemptId);
  }
  if (admission.kind === 'observer') return outcome(ports.store, admitted, admission.observation, 'observer', attemptId);
  const execution = executeOriginal(ports, admission.execution, attemptId);
  // Expiring the HTTP wait never cancels/fails the original execution. Its late effects still require the same permit.
  const result = options.waitExpired ? await Promise.race([
    execution.then(observation => ({ observation })), options.waitExpired.then(() => ({ observation: null })),
  ]) : { observation: await execution };
  if (result.observation) return outcome(ports.store, admitted, result.observation, 'owner', attemptId);
  await note(ports.store, admitted, attemptId, 'WaitExpired', admission.execution.permit.original.originalId);
  return outcome(ports.store, admitted, await observe(ports.store, admitted, attemptId), 'owner', attemptId);
}

/** A lookup can wake the recovery worker but cannot receive its permit, plan, sign or commit. Access is checked afresh. */
export async function lookupClinicalWrite(store: ClinicalStorePort, input: WriteInput): Promise<CommitOutcome> {
  const attemptId = randomUUID(), request = await checkedRequest(store, input, attemptId);
  return outcome(store, request, await observe(store, request, attemptId, true), 'observer', attemptId);
}
/** Server worker entry, not an HTTP retry route. B1 must enumerate pending originals on restart/reconnect. */
export async function recoverClinicalWrite(ports: WritePorts, request: RequestIdentity): Promise<CommitOutcome> {
  const attemptId = randomUUID();
  let admission: OriginalAdmission;
  try { admission = await ports.store.recoverOriginal(request, attemptId); }
  catch { return outcome(ports.store, request, unavailable(), 'observer', attemptId); }
  const observed = admission.kind === 'owner' ? await executeOriginal(ports, admission.execution, attemptId) : admission.observation;
  return outcome(ports.store, request, observed, 'observer', attemptId);
}
/** Request-local reconciliation state; it is neither a durable store nor authority to execute a mutation. */
export function retainRequestOutcome(previous: CommitOutcome | null, next: CommitOutcome): CommitOutcome {
  return previous && previous.status !== 'unknown' ? previous : next;
}
/**
 * Automatic lookup contract consumed by R2's existing Save flow. The scheduler owns delay/cancellation; current returns
 * null on view/account invalidation. R2 still guards UID+sequence/account generation at publish and preserves newer edits.
 * No new request ID or user action is introduced here. Re-admission is atomic: existing originals are observations
 * only; if the first admission never reached storage, only its authoritative first claim can start that original.
 * Store outages keep this loop pending. The input provider must retain the original request body, not newer edits.
 */
export async function followClinicalWrite(ports: WritePorts, current: () => WriteInput | null,
  waitNext: () => Promise<void>, publish: (result: CommitOutcome) => void): Promise<void> {
  let previous: CommitOutcome | null = null;
  const initial = current();
  if (!initial) return;
  const request = prepareClinicalWrite(initial);
  do {
    await waitNext();
    const input = current();
    if (!input || !sameRequest(request, prepareClinicalWrite(input))) return;
    const next = await commitClinicalWrite(ports, input);
    const active = current();
    if (!active || active !== input) return;
    previous = retainRequestOutcome(previous, next);
    publish(previous);
  } while (previous.status === 'unknown');
}

// ---------- reads ----------

export interface ReadPlan {
  route: string; record: ClinicalRecord; recordId: string; actorId: string; actingInstitutionId: string; managingInstitutionId: string;
  versions: readonly (VersionReference & { kind: RecordKind })[];
  targets: readonly AccessTarget[];
}
export interface ClinicalBody {
  versionId: string; sequence: number; entry: EntryClass; kind: RecordKind; author: ImmutableIdentity; at: string;
  text: string | null; reason: string | null; state: { from: string | null; to: string }; attachments: readonly AttachmentReference[];
}
// Bodies stay out of the plan object itself, so nothing can hand them out before the access event is durable.
const planBodies = new WeakMap<object, readonly ClinicalBody[]>();

export function planClinicalRead(input: { actor: ActorFacts; unit: ClinicalUnit; scope: 'current' | 'history' }): Readonly<ReadPlan> {
  const r = object(input, ['actor', 'unit', 'scope']);
  const actor = actorFacts(r.actor), unit: ClinicalUnit = r.unit, scope = choice(r.scope, ['current', 'history']);
  const { parties } = projectUnit(unit);
  if (actor.kind !== 'member' || !institutionAdmits(actor.institutionId, unit.managingInstitutionId))
    refuse('NotFound');
  const isAuthor = parties.authorId === actor.identity.id;
  const isParty = isAuthor || parties.recipientId === actor.identity.id;
  const permitted = (READ_SCOPES[unit.record] as readonly { role: string; relation: string }[]).some(s => holds(actor, s.role) &&
    (s.relation === 'any' || (s.relation === 'author' && isAuthor) || (s.relation === 'party' && isParty)));
  // Same answer as an absent record: a refused reader learns nothing about another person's thread or another institution.
  if (!permitted) refuse('NotFound');
  const served = scope === 'current' ? [unit.versions[unit.versions.length - 1]] : [...unit.versions];
  const plan = freeze(structuredClone({
    route: READ_ROUTES[unit.record], record: unit.record, recordId: unit.recordId, actorId: actor.identity.id, actingInstitutionId: actor.institutionId,
    managingInstitutionId: unit.managingInstitutionId,
    versions: served.map(v => ({ ...ref(v), kind: v.kind })),
    targets: served.map(v => ({ kind: v.kind, patientLinkSnapshot: { status: 'known', value: v.patient }, studyId: { status: 'known', value: v.studyId },
      recordId: { status: 'known', value: v.recordId }, versionId: { status: 'known', value: v.versionId } })),
  })) as Readonly<ReadPlan>;
  planBodies.set(plan, freeze(structuredClone(served.map(v => ({ versionId: v.versionId, sequence: v.sequence, entry: v.entry, kind: v.kind,
    author: v.author, at: v.at, text: v.text, reason: v.reason, state: v.state, attachments: v.attachments })))));
  return plan;
}

/**
 * Hands the bodies to `send` only after A's provide-prepared event for exactly these versions is durable
 * (provideAfterDurableEvent). A failed or mismatched ledger answer sends nothing.
 */
export async function provideClinicalRead<T>(store: AppendOnlyAccessStore, event: AccessEvent, plan: ReadPlan,
  send: (bodies: readonly ClinicalBody[], receipt: DurableAccessReceipt) => Promise<T>): Promise<T> {
  const bodies = planBodies.get(plan);
  if (!bodies) refuse('ReadPlanRequired');
  const e = parseAccessEvent(event);
  const match = (t: AccessTarget, p: AccessTarget) => t.kind === p.kind && JSON.stringify([t.patientLinkSnapshot, t.studyId, t.recordId, t.versionId]) ===
    JSON.stringify([p.patientLinkSnapshot, p.studyId, p.recordId, p.versionId]);
  if (e.surface !== plan.route || e.action !== 'provide-prepared' || e.targets.length !== plan.targets.length ||
      e.targets.some((t, i) => !match(t, plan.targets[i])) || e.userId.status !== 'known' || e.userId.value.id !== plan.actorId ||
      e.actingInstitution.status !== 'known' || e.actingInstitution.value !== plan.actingInstitutionId ||
      e.managingInstitution.status !== 'known' || e.managingInstitution.value !== plan.managingInstitutionId) refuse('AccessTargetMismatch');
  return provideAfterDurableEvent(store, event, receipt => send(bodies, receipt));
}

/** List and summary rows: identifiers and state only, no clinical text, reason or attachment. */
export function summarizeUnit(unit: ClinicalUnit) {
  const p = projectUnit(unit);
  return freeze({ record: unit.record, recordId: unit.recordId, studyId: unit.studyId, state: p.state, revision: p.revision,
    createdAt: unit.versions[0].at, updatedAt: unit.versions[unit.versions.length - 1].at });
}

// ---------- manual SR ----------

export interface PreparedSr {
  id: string; studyId: string; authorId: string; createdAt: string; attemptedAt: string | null; storedAt: string | null;
  bytesSha256: string; sopInstanceUid: string;
  /** The signed D adoption of these bytes, once committed. */
  adoptedVersion: VersionReference | null;
  /** Retained records that incorporate or cite this SR (complete list from the reference index, R2). */
  referencedBy: readonly VersionReference[];
  holdIds: readonly string[];
  /** Orthanc lookup of this SOP instance when the plan is made. */
  orthanc: 'absent' | 'present' | 'unknown';
}
type KeepReason = 'adopted' | 'store-attempted' | 'referenced' | 'held' | 'within-window' | 'orthanc-unconfirmed';

function preparedSr(input: unknown): PreparedSr {
  const s = object(input, ['id', 'studyId', 'authorId', 'createdAt', 'attemptedAt', 'storedAt', 'bytesSha256', 'sopInstanceUid', 'adoptedVersion',
    'referencedBy', 'holdIds', 'orthanc']);
  if (!Array.isArray(s.referencedBy) || !Array.isArray(s.holdIds)) refuse('ManualSrFactsRequired');
  return { id: string(s.id), studyId: string(s.studyId), authorId: string(s.authorId), createdAt: utc(s.createdAt),
    attemptedAt: s.attemptedAt === null ? null : utc(s.attemptedAt), storedAt: s.storedAt === null ? null : utc(s.storedAt),
    bytesSha256: sha256(s.bytesSha256), sopInstanceUid: string(s.sopInstanceUid),
    adoptedVersion: s.adoptedVersion === null ? null : versionReference(s.adoptedVersion),
    referencedBy: s.referencedBy.map(versionReference), holdIds: s.holdIds.map(h => string(h)), orthanc: choice(s.orthanc, ['absent', 'present', 'unknown']) };
}

/**
 * The 24-hour preparation window may end only an unattempted, unadopted, unreferenced, unheld working copy that Orthanc
 * confirms it does not hold. Everything else is kept with its reason. The plan names candidates; H's purpose-end
 * destruction executes them (R2), so nothing here nulls bytes.
 */
export function planManualSrCleanup(rows: readonly unknown[], at: string) {
  const now = Date.parse(utc(at));
  if (!Array.isArray(rows)) refuse('ManualSrFactsRequired');
  const clear: { id: string; bytesSha256: string; purposeEnd: 'preparation-window-ended' }[] = [], keep: { id: string; reason: KeepReason }[] = [];
  for (const input of rows) {
    const row = preparedSr(input);
    const reason: KeepReason | null =
      row.storedAt !== null || row.adoptedVersion !== null ? 'adopted' :
      row.attemptedAt !== null ? 'store-attempted' :
      row.referencedBy.length ? 'referenced' :
      row.holdIds.length ? 'held' :
      now - Date.parse(row.createdAt) <= MANUAL_SR_PREPARATION_MS ? 'within-window' :
      row.orthanc !== 'absent' ? 'orthanc-unconfirmed' : null;
    if (reason) keep.push({ id: row.id, reason });
    else clear.push({ id: row.id, bytesSha256: row.bytesSha256, purposeEnd: 'preparation-window-ended' });
  }
  return freeze({ clear, keep });
}

export type OrthancObservation = { status: 'present'; sopInstanceUid: string; sha256: string } | { status: 'absent' } | { status: 'unknown' };
/**
 * Matches Orthanc's stored instance against the bytes this server authorized. An observation that contradicts the
 * authorized bytes (another hash, another SOP, or an adopted original that is gone) is a conflict even after adoption;
 * it is never adopted or reported as adopted.
 */
export function reconcileManualSr(input: unknown, observation: unknown) {
  const row = preparedSr(input);
  const o = observation && typeof observation === 'object' ? (observation as any) : refuse('ManualSrFactsRequired');
  const status = choice(o.status, ['present', 'absent', 'unknown']);
  let outcome: 'already-adopted' | 'adopt' | 'conflict' | 'retry-store' | 'not-attempted' | 'keep-pending';
  if (status === 'unknown') { object(o, ['status']); outcome = row.storedAt !== null ? 'already-adopted' : 'keep-pending'; }
  else if (status === 'absent') { object(o, ['status']); outcome = row.storedAt !== null ? 'conflict' : row.attemptedAt !== null ? 'retry-store' : 'not-attempted'; }
  else {
    const p = object(o, ['status', 'sopInstanceUid', 'sha256']);
    const same = string(p.sopInstanceUid) === row.sopInstanceUid && sha256(p.sha256) === row.bytesSha256;
    // Present without this server's committed attempt, or with other bytes, is someone else's instance: never adopt it.
    outcome = !same || row.attemptedAt === null ? 'conflict' : row.storedAt !== null ? 'already-adopted' : 'adopt';
  }
  return freeze({ id: row.id, bytesSha256: row.bytesSha256, outcome });
}

/** The author's store intent is the clinical entry of a manual SR: one signature over the exact DICOM bytes and SOP. */
export function planManualSrAdoption(input: { actor: ActorFacts; study: StudyFacts; sr: unknown; versionId: string; at: string }) {
  const i = object(input, ['actor', 'study', 'sr', 'versionId', 'at']);
  const actor = actorFacts(i.actor), study = studyFacts(i.study), sr = preparedSr(i.sr), at = utc(i.at), versionId = string(i.versionId);
  // manual-sr.service.ts:14 access(): radiologist of the owning institution, author only.
  if (actor.kind !== 'member' || actor.institutionId !== study.managingInstitutionId || sr.studyId !== study.studyId) refuse('NotFound');
  if (!holds(actor, 'radiologist') || sr.authorId !== actor.identity.id) refuse('ActorPathRefused');
  if (sr.storedAt !== null || sr.adoptedVersion !== null || sr.attemptedAt !== null) refuse('StateTransitionRefused');
  if (Date.parse(at) - Date.parse(sr.createdAt) > MANUAL_SR_PREPARATION_MS) refuse('PreparationExpired');
  if (actor.signingRegistrationId === null) refuse('SigningIdentityRequired');
  const adoption = { recordId: sr.id, versionId, sopInstanceUid: sr.sopInstanceUid, bytesSha256: sr.bytesSha256, author: actor.identity,
    studyId: study.studyId, managingInstitutionId: study.managingInstitutionId, patient: study.patient, at };
  const digest = hex(JSON.stringify(['emr-clinical-sr/1', adoption.recordId, adoption.versionId, adoption.sopInstanceUid, adoption.bytesSha256,
    adoption.author, adoption.studyId, adoption.managingInstitutionId, adoption.patient, adoption.at]));
  const signing: SigningRequest = { recordKind: 'manual-sr', recordId: sr.id, versionId, versionSha256: digest,
    content: { kind: 'dicom', sopInstanceUid: sr.sopInstanceUid, sha256: sr.bytesSha256 }, patient: study.patient, studyId: study.studyId,
    managingInstitutionId: study.managingInstitutionId, actingInstitutionId: actor.institutionId, author: actor.identity, signer: actor.identity,
    identityRegistrationId: actor.signingRegistrationId, action: 'record', previousVersion: null, attachments: [], reason: null };
  return freeze(structuredClone({ adoption: { ...adoption, sha256: digest }, signing,
    access: { route: 'POST studies/:uid/manual-sr/:id/store', action: 'write' as const } }));
}
