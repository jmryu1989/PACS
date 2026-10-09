import { RecordKind, RECORD_CLASSIFICATION } from '../emr-contract/classification';
import type { ImmutableIdentity, PatientLinkSnapshot } from '../emr-contract/access-event';
import { routeContract } from '../emr-contract/routes';
import type { AttachmentReference, SignatureAction, VersionReference } from '../emr-contract/signature';
import { freeze, refuse } from '../emr-contract/validation';

/**
 * EMR unit D: clinical attached records (questions, consultations, findings, image requests, reader assignment,
 * manual SR) bound to their originals, signatures and versions. This file is the immutable record specification;
 * records.ts holds the pure version, read, signature-acceptance and manual SR plans built on it.
 *
 * Authority comes from server facts only. The surface key is chosen by the server route handler (plus the
 * body action the existing service already validates), the actor is the verified auth context (B2), the unit is
 * the stored history (D store, R2), and attached records are A-resolved stored records. The client body supplies
 * the request ID and the request's own meaning (expected revision, text and the fields the service validated), all of
 * which the idempotency fingerprint covers; a body that names an author, kind, signature verdict or institution is
 * refused, never consulted.
 *
 * Round 1 wires nothing: no route, SQL, signer or ledger. C signs and verifies; B co-commits the version, the
 * signature, the access event and the receipt; H executes destruction.
 */

export type ClinicalRecord = 'question' | 'consultation' | 'finding' | 'image-request' | 'assignment' | 'tech-note';
/**
 * clinical-author: the person writing a record entry in their own professional role, who signs it themselves (a
 * physician, or a radiographer for their own Tech Note: legal register LR-49 / delta D-3). operational-staff: an
 * administrator or a technician acting on someone else's record while processing it; never a signer of that record.
 */
export type Capacity = 'clinical-author' | 'operational-staff';
/**
 * clinical-entry: the medical author's own text, signed by that author (의료법 제22조①·제23조①).
 * operational-note: text a staff member records while processing; never presented or signed as a clinical entry.
 * state-change: no text, the workflow state moves; recorded as its own event, no signature.
 * assignment: reader allocation only; carries no text at all (purpose record, not a clinical entry channel).
 */
export type EntryClass = 'clinical-entry' | 'operational-note' | 'state-change' | 'assignment';
export type Relation = 'any' | 'author' | 'other' | 'recipient';
/** replace: the field is the whole new content (empty clears it) and every later version needs the author's reason. */
export type TextRule = 'required' | 'optional' | 'empty' | 'none' | 'server' | 'replace';
export type VersionAct = 'entry' | 'additional-entry' | 'correction' | 'bookkeeping' | 'creation';

export interface SurfacePath { relation: Relation; role: string; capacity: Capacity; kind: RecordKind; text?: TextRule; to?: string }
export interface SurfaceSpec {
  record: ClinicalRecord;
  /** A MODEL_CLASSIFICATION model of the stored projection row. */
  model: string;
  /** A ROUTE_CONTRACTS key; every kind a path can produce must belong to it. */
  route: string;
  opens: boolean | 'if-absent';
  /** Exact client body keys, taken from the existing service validation. */
  client: readonly string[];
  optional?: readonly string[];
  /** The idempotency key field (default requestId). */
  requestField?: string;
  /** Normalisation of meaning fields before the request fingerprint, as the service normalises them. */
  normalize?: Readonly<Record<string, 'trim' | 'lower'>>;
  textField: string | null;
  text: TextRule;
  reasonField?: string;
  revisionField: string | null;
  /** The body action the server already validated; it selects the surface, it never grants authority. */
  action?: string;
  ownerField: boolean;
  paths: readonly SurfacePath[];
  /** Act of a clinical entry on an existing unit; an opening entry is always 'entry'. */
  act: 'additional-entry' | 'correction';
  cancel?: true;
  from: readonly (string | null)[];
  to: string;
  attachments: readonly RecordKind[];
  navigation: boolean;
  /**
   * A clinical entry here marks the unit as carrying signed clinical text. It does not add the chart class by itself:
   * the 10-year class needs a recorded chart-incorporation fact (legal register D-19).
   */
  marksClinicalEntry?: true;
  /**
   * The correction's reason is bound by the server from the work context when the author gives none; a request outside
   * that context needs one stated line (legal register D-18, D727 Q4).
   */
  contextReason?: readonly WorkContext['kind'][];
}

const C: Capacity = 'clinical-author', S: Capacity = 'operational-staff';
const THREAD = ['Open', 'Answered'], PENDING = ['Requested', 'Accepted'];
const reply = ['requestId', 'expectedOwner', 'revision', 'action', 'note'];
const FINDING_SOURCES: readonly RecordKind[] = ['measurement', 'key-image', 'comparison-layout', 'comparison-description'];
const base = { optional: [], attachments: [], navigation: false, ownerField: true } as const;

/** Surface table. Rows cite the service validation they mirror (base 04e50ab). */
export const CLINICAL_SURFACES = freeze({
  // clinician-question.service.ts:266 create, :292 reply, :320 close
  'question.create': { ...base, record: 'question', model: 'StudyQuestion', route: 'POST studies/:uid/questions', opens: true,
    client: ['requestId', 'expectedOwner', 'body'], textField: 'body', text: 'required', revisionField: null, act: 'additional-entry',
    paths: [{ relation: 'any', role: 'clinician', capacity: C, kind: 'clinical-question' }], from: [null], to: 'Open' },
  'question.reply': { ...base, record: 'question', model: 'StudyQuestionEntry', route: 'POST questions/:id/entries', opens: false,
    client: ['requestId', 'expectedOwner', 'revision', 'body'], textField: 'body', text: 'required', revisionField: 'revision', act: 'additional-entry',
    paths: [{ relation: 'author', role: 'clinician', capacity: C, kind: 'clinical-question', to: 'Open' },
      { relation: 'other', role: 'radiologist', capacity: C, kind: 'clinical-answer', to: 'Answered' }], from: THREAD, to: 'Open' },
  'question.close': { ...base, record: 'question', model: 'StudyQuestionEntry', route: 'POST questions/:id/close', opens: false,
    client: ['requestId', 'expectedOwner', 'revision', 'note'], textField: 'note', text: 'optional', revisionField: 'revision', act: 'additional-entry',
    paths: [{ relation: 'author', role: 'clinician', capacity: C, kind: 'clinical-question' },
      { relation: 'other', role: 'radiologist', capacity: C, kind: 'clinical-answer', text: 'required' },
      { relation: 'other', role: 'admin', capacity: S, kind: 'clinical-question', text: 'required' }], from: THREAD, to: 'Closed' },
  // consultation.service.ts:97 create, :128 change
  'consultation.create': { ...base, record: 'consultation', model: 'StudyConsultation', route: 'POST studies/:uid/consultations', opens: true,
    client: ['requestId', 'expectedOwner', 'recipientSub', 'reason'], textField: 'reason', text: 'required', revisionField: null, act: 'additional-entry',
    paths: [{ relation: 'any', role: 'radiologist', capacity: C, kind: 'consultation' }, { relation: 'any', role: 'admin', capacity: S, kind: 'consultation' }],
    from: [null], to: 'Requested' },
  'consultation.accept': { ...base, record: 'consultation', model: 'StudyConsultation', route: 'POST consultations/:id', opens: false, client: reply,
    textField: 'note', text: 'empty', revisionField: 'revision', action: 'accept', act: 'additional-entry',
    paths: [{ relation: 'recipient', role: 'radiologist', capacity: C, kind: 'consultation' }], from: ['Requested'], to: 'Accepted' },
  'consultation.complete': { ...base, record: 'consultation', model: 'StudyConsultation', route: 'POST consultations/:id', opens: false, client: reply,
    textField: 'note', text: 'required', revisionField: 'revision', action: 'complete', act: 'additional-entry',
    paths: [{ relation: 'recipient', role: 'radiologist', capacity: C, kind: 'consultation' }], from: PENDING, to: 'Completed' },
  'consultation.cancel': { ...base, record: 'consultation', model: 'StudyConsultation', route: 'POST consultations/:id', opens: false, client: reply,
    textField: 'note', text: 'required', revisionField: 'revision', action: 'cancel', act: 'additional-entry', cancel: true,
    paths: [{ relation: 'author', role: 'radiologist', capacity: C, kind: 'consultation' }, { relation: 'any', role: 'admin', capacity: S, kind: 'consultation' }],
    from: PENDING, to: 'Cancelled' },
  // image-request.service.ts:282 create, :325 change. The request stays in the patient register (5 years); the requesting
  // clinician's own text is treated as a clinical instruction/opinion and signed. No automatic chart class (D-19).
  'image-request.create': { ...base, record: 'image-request', model: 'StudyImageRequest', route: 'POST studies/:uid/image-requests', opens: true,
    client: ['requestId', 'expectedOwner', 'kind', 'counterparty', 'counterpartyInstitutionId', 'reason'], textField: 'reason', text: 'required',
    revisionField: null, act: 'additional-entry', marksClinicalEntry: true,
    paths: [{ relation: 'any', role: 'clinician', capacity: C, kind: 'image-request' }], from: [null], to: 'Requested' },
  'image-request.accept': { ...base, record: 'image-request', model: 'StudyImageRequest', route: 'POST image-requests/:id', opens: false, client: reply,
    textField: 'note', text: 'empty', revisionField: 'revision', action: 'accept', act: 'additional-entry',
    paths: [{ relation: 'any', role: 'technician', capacity: S, kind: 'image-request' }, { relation: 'any', role: 'admin', capacity: S, kind: 'image-request' }],
    from: ['Requested'], to: 'Accepted' },
  'image-request.close': { ...base, record: 'image-request', model: 'StudyImageRequest', route: 'POST image-requests/:id', opens: false, client: reply,
    textField: 'note', text: 'required', revisionField: 'revision', action: 'close', act: 'additional-entry',
    paths: [{ relation: 'any', role: 'technician', capacity: S, kind: 'image-request' }, { relation: 'any', role: 'admin', capacity: S, kind: 'image-request' }],
    from: PENDING, to: 'Closed' },
  'image-request.decline': { ...base, record: 'image-request', model: 'StudyImageRequest', route: 'POST image-requests/:id', opens: false, client: reply,
    textField: 'note', text: 'required', revisionField: 'revision', action: 'decline', act: 'additional-entry',
    paths: [{ relation: 'any', role: 'technician', capacity: S, kind: 'image-request' }, { relation: 'any', role: 'admin', capacity: S, kind: 'image-request' }],
    from: PENDING, to: 'Declined' },
  'image-request.cancel': { ...base, record: 'image-request', model: 'StudyImageRequest', route: 'POST image-requests/:id', opens: false, client: reply,
    textField: 'note', text: 'required', revisionField: 'revision', action: 'cancel', act: 'additional-entry', cancel: true, marksClinicalEntry: true,
    paths: [{ relation: 'author', role: 'clinician', capacity: C, kind: 'image-request' }, { relation: 'any', role: 'admin', capacity: S, kind: 'image-request' }],
    from: PENDING, to: 'Cancelled' },
  // finding.service.ts:364 write; finding-input.ts:74 command keys. The recorded text is the server's canonical
  // snapshot (frozen source copies included), never the client item. Hide/restore need no typed reason inside the
  // author's reading context (R2 drops the required reason in finding-input.ts:80).
  'finding.create': { ...base, record: 'finding', model: 'Finding', route: 'POST studies/:uid/findings', opens: true, ownerField: false,
    client: ['requestId', 'item'], textField: null, text: 'server', revisionField: null, act: 'correction', attachments: FINDING_SOURCES, navigation: true,
    paths: [{ relation: 'any', role: 'radiologist', capacity: C, kind: 'finding' }], from: [null], to: 'Visible' },
  'finding.edit': { ...base, record: 'finding', model: 'FindingRevision', route: 'POST studies/:uid/findings/:id/revisions', opens: false, ownerField: false,
    client: ['requestId', 'expectedRevision', 'action', 'item'], optional: ['reason'], textField: null, text: 'server', revisionField: 'expectedRevision',
    action: 'edit', act: 'correction', attachments: FINDING_SOURCES, navigation: true,
    paths: [{ relation: 'author', role: 'radiologist', capacity: C, kind: 'finding' }], from: ['Visible', 'Hidden'], to: 'same' },
  'finding.hide': { ...base, record: 'finding', model: 'FindingRevision', route: 'POST studies/:uid/findings/:id/revisions', opens: false, ownerField: false,
    client: ['requestId', 'expectedRevision', 'action', 'item'], optional: ['reason'], textField: null, text: 'server', revisionField: 'expectedRevision',
    action: 'hide', act: 'correction', attachments: FINDING_SOURCES, navigation: true, contextReason: ['reading'],
    paths: [{ relation: 'author', role: 'radiologist', capacity: C, kind: 'finding' }], from: ['Visible'], to: 'Hidden' },
  'finding.restore': { ...base, record: 'finding', model: 'FindingRevision', route: 'POST studies/:uid/findings/:id/revisions', opens: false, ownerField: false,
    client: ['requestId', 'expectedRevision', 'action', 'item'], optional: ['reason'], textField: null, text: 'server', revisionField: 'expectedRevision',
    action: 'restore', act: 'correction', attachments: FINDING_SOURCES, navigation: true, contextReason: ['reading'],
    paths: [{ relation: 'author', role: 'radiologist', capacity: C, kind: 'finding' }], from: ['Hidden'], to: 'Visible' },
  // reader-assignment.service.ts:79 write: allocation only, no free text exists to smuggle a clinical entry through.
  'assignment.write': { ...base, record: 'assignment', model: 'ReaderAssignment', route: 'POST studies/:uid/reader-assignment', opens: 'if-absent',
    client: ['requestId', 'expectedOwner', 'revision', 'readerSub'], normalize: { readerSub: 'lower' }, textField: null, text: 'none', revisionField: 'revision', act: 'additional-entry',
    paths: ['admin', 'technician', 'radiologist'].map(role => ({ relation: 'any' as const, role, capacity: S, kind: 'assignment' as const })),
    from: [null, 'Assigned', 'Unassigned'], to: 'reader' },
  // pacs.service.ts:1181 saveTechNote (base version, whole text, trimmed reason, attempt ID). The radiographer signs their
  // own note (LR-49 / D-3); an administrator's write is recorded as theirs but never signed in the radiographer's place.
  // Round 2 wires this through the pacs.* owner; the screen always sends the attempt ID after release.
  'tech-note.write': { ...base, record: 'tech-note', model: 'TechNoteRevision', route: 'POST studies/:uid/tech-note', opens: 'if-absent', ownerField: false,
    client: ['baseVersion', 'text', 'reason', 'attemptId'], requestField: 'attemptId', normalize: { reason: 'trim' }, textField: 'text', text: 'replace', reasonField: 'reason',
    revisionField: 'baseVersion', act: 'correction', contextReason: ['acquisition'],
    paths: [{ relation: 'any', role: 'technician', capacity: C, kind: 'tech-note' }, { relation: 'any', role: 'admin', capacity: S, kind: 'tech-note' }],
    from: [null, 'Recorded'], to: 'Recorded' },
} satisfies Record<string, SurfaceSpec>);
export type SurfaceKey = keyof typeof CLINICAL_SURFACES;

/** Body keys that would claim a server fact. Refused by name so a caller learns the boundary, not a shape guess. */
export const AUTHORITY_FIELDS = freeze(['author', 'authorId', 'authorSub', 'actor', 'signer', 'signerId', 'signed', 'signature',
  'verified', 'verification', 'clinicalEntry', 'recordKind', 'recordKinds', 'kinds', 'capacity', 'entry', 'institution', 'institutionId',
  'managingInstitutionId', 'actingInstitutionId', 'patient', 'patientId', 'role', 'roles', 'serverTime', 'at', 'versionId',
  'previousVersion', 'sha256', 'identityRegistrationId']);


/** Who may receive a body, mirroring each service's read scope; an institution boundary always applies first. */
export const READ_SCOPES = freeze({
  question: [{ role: 'clinician', relation: 'author' }, { role: 'radiologist', relation: 'any' }, { role: 'admin', relation: 'any' }],
  consultation: [{ role: 'radiologist', relation: 'party' }, { role: 'admin', relation: 'any' }],
  'image-request': [{ role: 'clinician', relation: 'author' }, { role: 'radiologist', relation: 'any' }, { role: 'technician', relation: 'any' }, { role: 'admin', relation: 'any' }],
  finding: [{ role: '*', relation: 'any' }],
  assignment: [{ role: 'admin', relation: 'any' }, { role: 'technician', relation: 'any' }, { role: 'radiologist', relation: 'any' }],
  'tech-note': [{ role: 'technician', relation: 'any' }, { role: 'radiologist', relation: 'any' }, { role: 'admin', relation: 'any' }],
} satisfies Record<ClinicalRecord, readonly { role: string; relation: 'any' | 'author' | 'party' }[]>);
export const READ_ROUTES = freeze({
  question: 'GET questions/:id', consultation: 'GET consultations/:id', 'image-request': 'GET image-requests/:id',
  finding: 'GET studies/:uid/findings/:id/revisions', assignment: 'GET studies/:uid/reader-assignment', 'tech-note': 'GET studies/:uid/tech-note/history',
} satisfies Record<ClinicalRecord, string>);

/** Product decision, not a statutory period: an unattempted prepared SR file is a working copy for 24 hours (manual-sr.service.ts:116). */
export const MANUAL_SR_PREPARATION_MS = 86_400_000;

// ---------- facts supplied by server adapters (R2 binds B2 context, D store, A resolver, C signer) ----------

export interface ActorFacts {
  identity: ImmutableIdentity;
  kind: 'member' | 'service';
  roles: readonly string[];
  institutionId: string;
  /** C: the registered signer identity of this person, or null when no signing registration exists. */
  signingRegistrationId: string | null;
}
/**
 * Part 1 is one institution: every D record is written and read only by its managing institution. Another institution
 * (including a tele reading one) needs a recorded 의료법 제21조의2 transfer basis and the Part 2 activation of
 * inter-institution reading (legal register 2026-10-09 LR-20 / delta D-4, LR-51), which D does not provide.
 */
export interface StudyFacts {
  studyId: string; managingInstitutionId: string; patient: PatientLinkSnapshot;
}
export interface ClinicalVersion {
  formatVersion: 'emr-clinical/1';
  record: ClinicalRecord; recordId: string; versionId: string; sequence: number;
  previousVersion: VersionReference | null;
  surface: SurfaceKey; entry: EntryClass; capacity: Capacity; kind: RecordKind; act: VersionAct;
  author: ImmutableIdentity; actingInstitutionId: string;
  text: string | null; contentSha256: string | null;
  /** stated: typed by the author; work-context: bound by the server from the author's work context (D-18). */
  reason: string | null; reasonSource: 'stated' | 'work-context' | null;
  attachments: readonly AttachmentReference[]; navigation: readonly string[];
  state: { from: string | null; to: string };
  readerId: string | null;
  /** Permission-deciding party fixed by the opening version (the consultation recipient); null elsewhere. */
  recipientId: string | null;
  studyId: string; managingInstitutionId: string; patient: PatientLinkSnapshot;
  at: string;
  /** SHA-256 of every field above in this order (UTF-8 JSON); the version's identity for signatures and incorporation. */
  sha256: string;
}
export interface ClinicalUnit {
  record: ClinicalRecord; recordId: string;
  studyId: string; managingInstitutionId: string; patient: PatientLinkSnapshot;
  /** Projection of the opening version's author and recipient; never trusted on its own. */
  parties: { authorId: string; recipientId: string | null };
  /** Projection; always equal to the fold of `versions`. */
  state: string; revision: number; head: VersionReference | null; clinicalEntry: boolean;
  versions: readonly ClinicalVersion[];
}
/** Server fact: the author's current work on this study (a radiologist's reading, a radiographer's acquisition), from which a correction reason is bound. */
export interface WorkContext { kind: 'reading' | 'acquisition'; studyId: string; referenceId: string }
export interface SigningRequest {
  recordKind: RecordKind; recordId: string; versionId: string; versionSha256: string;
  content: { kind: 'text'; body: string; sha256: string } | { kind: 'dicom'; sopInstanceUid: string; sha256: string };
  patient: PatientLinkSnapshot; studyId: string; managingInstitutionId: string; actingInstitutionId: string;
  author: ImmutableIdentity; signer: ImmutableIdentity; identityRegistrationId: string;
  action: SignatureAction; previousVersion: VersionReference | null; attachments: readonly AttachmentReference[]; reason: string | null;
}
/** What D needs back from C's verifier. D never builds one of these for itself. */
export interface SignatureEvidence {
  recordId: string; versionId: string; versionSha256: string; signer: ImmutableIdentity; identityRegistrationId: string;
  verification: { integrity: string; registeredIdentity: string; keyAtSigningTime: string; compromise: string };
}
export interface WriteReceipt {
  requestId: string; fingerprint: string; recordId: string; versionId: string; versionSha256: string; revision: number; state: string; at: string;
}

/** Roles that author and sign their own record entries; an administrator never signs a record entry. */
const AUTHOR_ROLES = freeze(['radiologist', 'clinician', 'technician']);
export function holds(actor: Pick<ActorFacts, 'roles'>, role: string): boolean {
  return Array.isArray(actor.roles) && (role === '*' ? actor.roles.length > 0 : actor.roles.includes(role));
}

/** The first matching path wins; clinical paths come first, so a mixed-role person acting clinically signs as a clinician. */
export function resolvePath(surface: SurfaceKey, actor: ActorFacts, unit: Pick<ClinicalUnit, 'parties'> | null): SurfacePath {
  const spec: SurfaceSpec = CLINICAL_SURFACES[surface];
  if (actor.kind !== 'member') refuse('ServiceActorRefused');
  const ordered = [...spec.paths].sort((a, b) => (a.capacity === C ? 0 : 1) - (b.capacity === C ? 0 : 1));
  for (const path of ordered) {
    if (!holds(actor, path.role)) continue;
    if (path.capacity === C && !AUTHOR_ROLES.includes(path.role)) continue;
    const authorId = unit?.parties.authorId ?? null, recipientId = unit?.parties.recipientId ?? null;
    const ok = path.relation === 'any' ? true : path.relation === 'author' ? authorId === actor.identity.id :
      path.relation === 'other' ? authorId !== null && authorId !== actor.identity.id : recipientId === actor.identity.id;
    if (ok) return path;
  }
  return refuse('ActorPathRefused');
}

/** Clinical text by a medical author is a clinical entry; staff text is an operational note; no text moves state only. */
export function entryClass(spec: SurfaceSpec, path: SurfacePath, text: string | null): EntryClass {
  if (spec.record === 'assignment') return 'assignment';
  // A replaced content is content even when it becomes empty: clearing a note is a correction, not a state change.
  if (text === null || (text === '' && spec.text !== 'replace')) return 'state-change';
  return path.capacity === C ? 'clinical-entry' : 'operational-note';
}

export function versionAct(spec: SurfaceSpec, entry: EntryClass, opening: boolean): VersionAct {
  if (entry === 'assignment') return 'creation';
  if (entry === 'state-change') return 'bookkeeping';
  if (entry === 'operational-note') return 'additional-entry';
  return opening ? 'entry' : spec.act;
}

/** 의료법 제23조④ act of the write for the access ledger (A STATUTORY_ACT maps it to 기재/추가기재/수정). */
export function accessAction(spec: SurfaceSpec, entry: EntryClass, act: VersionAct, opening: boolean): 'write' | 'additional-entry' | 'modify' | 'cancel' {
  if (spec.cancel) return 'cancel';
  if (entry === 'assignment') return opening ? 'write' : 'modify';
  if (act === 'entry') return 'write';
  if (act === 'additional-entry') return 'additional-entry';
  return 'modify';
}

export function signatureAction(spec: SurfaceSpec, act: VersionAct): SignatureAction {
  if (spec.cancel) return 'cancel';
  return act === 'entry' ? 'record' : act === 'additional-entry' ? 'addendum' : 'amend';
}

// A misrouted table entry must not ship: every surface and read route must exist in A's route contract with the right
// operation, and every kind a path can produce must be one that route declares.
for (const [key, spec] of Object.entries(CLINICAL_SURFACES) as [string, SurfaceSpec][]) {
  const contract = routeContract(spec.route);
  if (contract.operation !== 'write' || spec.paths.some(p => !contract.kinds.includes(p.kind) || !RECORD_CLASSIFICATION[p.kind]) ||
      spec.attachments.some(k => !RECORD_CLASSIFICATION[k])) throw new Error(`Clinical surface does not match the route contract: ${key}`);
}
for (const [record, route] of Object.entries(READ_ROUTES)) {
  const contract = routeContract(route);
  const kinds = Object.values(CLINICAL_SURFACES).filter(s => s.record === record).flatMap(s => (s as SurfaceSpec).paths.map(p => p.kind));
  if (contract.operation !== 'read' || kinds.some(k => !contract.kinds.includes(k))) throw new Error(`Clinical read route does not match: ${record}`);
}
