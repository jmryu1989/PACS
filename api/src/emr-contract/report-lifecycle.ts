import { VersionReference, versionReference } from './signature';
import { choice, freeze, integer, object, string, utc, refuse } from './validation';
import { ResolvedRecord, verifiedRecord } from './classification';

export type ReportState = 'Unread' | 'In Progress' | 'Preliminary' | 'On Hold' | 'Approved' | 'Finalized' | 'Cancelled';
export interface ReportFacts {
  recordId: string;
  studyId: string;
  previousCancelledRecordId: string | null;
  contentHistory: readonly { version: VersionReference; at: string; action: 'preliminary' | 'approve' | 'amend' | 'addendum' | 'cancel'; use: 'clinical' | 'preservation-correction' }[];
  state: ReportState;
  firstApprovedAt: string | null;
  originalSignerId: string | null;
  amendUntil: string | null;
  publishedVersion: VersionReference | null;
  bodyVersion: VersionReference | null;
  addenda: readonly { version: VersionReference; authorId: string }[];
  claimantId: string | null;
  claimGeneration: number;
  preliminary: { authorId: string; reviewerId: string } | null;
  cancellation: { eventId: string; actorId: string; at: string; reason: string; version: VersionReference } | null;
  finalized: { effectiveAt: string; processedAt: string } | null;
}
export type LifecycleAction = 'start' | 'renew-claim' | 'save' | 'release' | 'preliminary' | 'cancel-preliminary' | 'defer' | 'approve' | 'amend' | 'addendum' | 'cancel' | 'finalize';
export const REPORT_TRANSITIONS: Readonly<Record<ReportState, readonly LifecycleAction[]>> = freeze({
  Unread: ['start', 'defer'],
  'In Progress': ['renew-claim', 'save', 'release', 'preliminary', 'defer', 'approve'],
  Preliminary: ['save', 'approve', 'cancel-preliminary'],
  'On Hold': ['start', 'defer'],
  Approved: ['amend', 'addendum', 'cancel', 'finalize'],
  Finalized: ['addendum', 'cancel'],
  Cancelled: [],
});
export interface LifecycleActor {
  id: string;
  kind: 'member' | 'service';
  roles: readonly string[];
  canReadStudy: boolean;
  canSign: boolean;
  canCancel: boolean;
}
export interface LifecycleCommand {
  action: LifecycleAction;
  actor: LifecycleActor;
  at: string;
  expectedClaimGeneration: number;
  expectedPublishedVersionId: string | null;
  version?: VersionReference;
  reason?: string;
  eventId?: string;
  reviewerId?: string;
  preservationCorrection?: ResolvedRecord;
}
export interface LifecycleOutcome {
  facts: Readonly<ReportFacts>;
  effects: readonly ('preserve-private-drafts' | 'preserve-subsequent-input' | 'append-private-revision' | 'append-signed-version' | 'publish-immediately' | 'notify-draft-presence-only' | 'append-cancellation' | 'append-finalization' | 'end-private-draft-purpose')[];
}
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionOnlyEvent {
  action: 'archive'; purpose: 'clinical-purpose-ended'; recordId: string; version: VersionReference;
  finalizedAt: string; at: string; actorId: string; reason: string;
}
export interface ArchiveCommand {
  actor: LifecycleActor; at: string; reason: string; purpose: 'clinical-purpose-ended'; expectedPublishedVersionId: string;
}

/** Finalized alone is a timed report state, not evidence that treatment has ended. Archive is an explicit declaration. */
export function archiveFinalizedReport(facts: ReportFacts, command: ArchiveCommand): Readonly<RetentionOnlyEvent> {
  validateReportFacts(facts);
  const c = object(command, ['actor', 'at', 'reason', 'purpose', 'expectedPublishedVersionId']);
  if (facts.state !== 'Finalized' || !facts.finalized || !c.actor.canReadStudy || c.actor.kind !== 'member' ||
      !c.actor.roles.includes('radiologist') || c.expectedPublishedVersionId !== facts.publishedVersion.versionId ||
      utc(c.at) < facts.finalized.processedAt) throw new Error('Explicit archive of the current finalized report required');
  return freeze({ action: 'archive', purpose: choice(c.purpose, ['clinical-purpose-ended']), recordId: facts.recordId,
    version: versionReference(facts.publishedVersion), finalizedAt: facts.finalized.effectiveAt,
    at: c.at, actorId: string(c.actor.id), reason: string(c.reason) });
}

export interface ResumeClinicalUseEvent {
  action: 'resume-clinical-use'; recordId: string; archiveAt: string; at: string; actorId: string;
  basis: 'new-study-same-patient'; evidence: { studyId: string; patientId: string; assigningAuthority: string; createdAt: string };
}
export interface ClinicalStudyReader {
  loadStudy(studyId: string): unknown;
  loadReportPatient(recordId: string): unknown;
}
const verifiedResumptions = new WeakSet<object>();
function validateArchive(facts: ReportFacts, event: RetentionOnlyEvent): void {
  const e = object(event, ['action', 'purpose', 'recordId', 'version', 'finalizedAt', 'at', 'actorId', 'reason']);
  const version = versionReference(e.version);
  choice(e.action, ['archive']); choice(e.purpose, ['clinical-purpose-ended']); string(e.actorId); string(e.reason);
  const entry = facts.contentHistory.find(h => h.version.versionId === version.versionId);
  if (!facts.finalized || e.recordId !== facts.recordId || version.recordId !== facts.recordId || !entry ||
      version.sha256 !== entry.version.sha256 || entry.at > utc(e.at) ||
      utc(e.finalizedAt) !== facts.finalized.effectiveAt || utc(e.at) < facts.finalized.processedAt)
    throw new Error('Archive must match retained signed content and stored finalization');
}
/** G supplies stored patient/study facts; a preservation order never creates clinical access. */
export function resumeClinicalUse(facts: ReportFacts, archive: RetentionOnlyEvent,
  command: { actor: LifecycleActor; at: string; basis: ResumeClinicalUseEvent['basis']; studyId: string }, reader: ClinicalStudyReader): Readonly<ResumeClinicalUseEvent> {
  validateReportFacts(facts); validateArchive(facts, archive);
  const c = object(command, ['actor', 'at', 'basis', 'studyId']);
  if (!c.actor.canReadStudy || c.actor.kind !== 'member' || !c.actor.roles.includes('radiologist') || utc(c.at) < archive.at)
    refuse('ClinicalResumeAuthorityRefused');
  if (c.basis !== 'new-study-same-patient' || !reader || typeof reader.loadStudy !== 'function') refuse('ClinicalResumeBasisRefused');
  const study = object(reader.loadStudy(string(c.studyId)), ['studyId', 'patientId', 'assigningAuthority', 'createdAt']);
  const patient = object(reader.loadReportPatient(facts.recordId), ['recordId', 'patientId', 'assigningAuthority']);
  string(patient.patientId); string(patient.assigningAuthority);
  if (patient.recordId !== facts.recordId || study.studyId !== c.studyId || study.studyId === facts.studyId ||
      study.patientId !== patient.patientId || study.assigningAuthority !== patient.assigningAuthority ||
      utc(study.createdAt) < archive.at || study.createdAt > c.at) refuse('ClinicalResumePatientBindingRefused');
  const result = freeze({ action: 'resume-clinical-use' as const, recordId: facts.recordId, archiveAt: archive.at, at: c.at, actorId: string(c.actor.id),
    basis: 'new-study-same-patient' as const, evidence: { studyId: study.studyId, patientId: study.patientId, assigningAuthority: study.assigningAuthority, createdAt: study.createdAt } });
  verifiedResumptions.add(result); return result;
}
export function reportRetentionAccess(facts: ReportFacts, event: RetentionOnlyEvent | null,
  resume: ResumeClinicalUseEvent | null = null): Readonly<{
  state: 'normal-retention' | 'retention-only'; ordinaryClinicalAccess: boolean; separateStorage: boolean;
}> {
  validateReportFacts(facts);
  let archived = event !== null;
  if (event) {
    validateArchive(facts, event);
    const archivedIndex = facts.contentHistory.findIndex(h => h.version.versionId === event.version.versionId);
    if (facts.contentHistory.slice(archivedIndex + 1).some(h => ['addendum', 'amend'].includes(h.action) && h.use === 'clinical' && h.at >= event.at)) archived = false;
  }
  if (resume !== null) {
    if (!verifiedResumptions.has(resume)) refuse('ClinicalResumeBasisRefused');
    const r = resume;
    if (!event || r.recordId !== facts.recordId || r.archiveAt !== event.at || utc(r.at) < event.at) throw new Error('Resumption does not match archive');
    archived = false;
  }
  return freeze({ state: archived ? 'retention-only' : 'normal-retention', ordinaryClinicalAccess: !archived, separateStorage: archived });
}
export function newReportFacts(recordId: string, studyId: string): Readonly<ReportFacts> {
  return freeze({ recordId: string(recordId), studyId: string(studyId), previousCancelledRecordId: null, contentHistory: [],
    state: 'Unread', firstApprovedAt: null, originalSignerId: null, amendUntil: null,
    publishedVersion: null, bodyVersion: null, addenda: [], claimantId: null, claimGeneration: 0, preliminary: null, cancellation: null, finalized: null });
}
/** Cancellation closes one unit. B creates the successor and its predecessor link atomically, retaining both units. */
export function newReportAfterCancellation(cancelled: ReportFacts, recordId: string, actor: LifecycleActor, at: string): Readonly<ReportFacts> {
  validateReportFacts(cancelled);
  if (cancelled.state !== 'Cancelled' || recordId === cancelled.recordId || utc(at) < cancelled.cancellation!.at ||
      actor.kind !== 'member' || !actor.roles.includes('radiologist') || !actor.canReadStudy) throw new Error('Authorized successor of cancelled report required');
  string(actor.id);
  return freeze({ ...newReportFacts(recordId, cancelled.studyId), previousCancelledRecordId: cancelled.recordId });
}

export function validateReportFacts(input: ReportFacts): void {
  const f = object(input, ['recordId', 'studyId', 'previousCancelledRecordId', 'contentHistory', 'state', 'firstApprovedAt', 'originalSignerId', 'amendUntil', 'publishedVersion', 'bodyVersion',
    'addenda', 'claimantId', 'claimGeneration', 'preliminary', 'cancellation', 'finalized']) as unknown as ReportFacts;
  string(f.recordId); string(f.studyId);
  if (f.previousCancelledRecordId !== null && string(f.previousCancelledRecordId) === f.recordId) throw new Error('Self predecessor');
  if (!Array.isArray(f.contentHistory)) throw new Error('Content history required');
  f.contentHistory.forEach((h, i) => {
    object(h, ['version', 'at', 'action', 'use']); choice(h.use, ['clinical', 'preservation-correction']);
    if (versionReference(h.version).recordId !== f.recordId || (i && utc(h.at) < f.contentHistory[i - 1].at)) throw new Error('Invalid content history');
    utc(h.at); choice(h.action, ['preliminary', 'approve', 'amend', 'addendum', 'cancel']);
  });
  if (new Set(f.contentHistory.map(h => h.version.versionId)).size !== f.contentHistory.length) throw new Error('Reused content version');
  choice(f.state, Object.keys(REPORT_TRANSITIONS) as ReportState[]); integer(f.claimGeneration);
  if (f.claimantId !== null) string(f.claimantId);
  if (f.firstApprovedAt === null) {
    if ([f.originalSignerId, f.amendUntil, f.publishedVersion, f.bodyVersion, f.cancellation, f.finalized].some(v => v !== null) ||
        ['Approved', 'Finalized', 'Cancelled'].includes(f.state)) throw new Error('Approval facts must be stored together');
  } else {
    utc(f.firstApprovedAt); utc(f.amendUntil); string(f.originalSignerId);
    if (Date.parse(f.amendUntil) - Date.parse(f.firstApprovedAt) !== DAY_MS ||
        !['Approved', 'Finalized', 'Cancelled'].includes(f.state)) throw new Error('Approval window cannot be reset');
    versionReference(f.publishedVersion); versionReference(f.bodyVersion);
  }
  if (!Array.isArray(f.addenda)) throw new Error('Addendum references missing');
  const refs = f.addenda.map(a => { object(a, ['version', 'authorId']); string(a.authorId); return versionReference(a.version); });
  for (const ref of [f.publishedVersion, f.bodyVersion, ...refs]) if (ref && ref.recordId !== f.recordId) throw new Error('Wrong report reference');
  if (new Set(refs.map(ref => ref.versionId)).size !== refs.length || (f.firstApprovedAt === null && refs.length)) throw new Error('Invalid addenda');
  if (f.publishedVersion && ![f.bodyVersion, ...refs].some(ref =>
    ref.versionId === f.publishedVersion.versionId && ref.sha256 === f.publishedVersion.sha256)) throw new Error('Publication must reference retained content');
  if ((f.state === 'In Progress') !== (f.claimantId !== null)) throw new Error('Claim/state mismatch');
  if (f.state === 'Preliminary') {
    const p = object(f.preliminary, ['authorId', 'reviewerId']); string(p.authorId); string(p.reviewerId);
    if (p.authorId === p.reviewerId) throw new Error('Self review forbidden');
  } else if (f.preliminary !== null) throw new Error('Unexpected preliminary facts');
  if (f.state === 'Cancelled') {
    const c = object(f.cancellation, ['eventId', 'actorId', 'at', 'reason', 'version']);
    string(c.eventId); string(c.actorId); utc(c.at); string(c.reason);
    if (versionReference(c.version).recordId !== f.recordId) throw new Error('Wrong cancellation record');
  } else if (f.cancellation !== null) throw new Error('Unexpected cancellation');
  if (f.finalized !== null) {
    const e = object(f.finalized, ['effectiveAt', 'processedAt']); utc(e.effectiveAt); utc(e.processedAt);
    if (e.effectiveAt !== f.amendUntil || Date.parse(e.processedAt) < Date.parse(e.effectiveAt) ||
        !['Finalized', 'Cancelled'].includes(f.state)) throw new Error('Invalid finalization');
  } else if (f.state === 'Finalized') throw new Error('Stored finalization required');
}

/** Pure decision only. I commits facts, immutable signed versions and events atomically after C verifies signatures. */
export function transitionReport(facts: ReportFacts, command: LifecycleCommand): LifecycleOutcome {
  validateReportFacts(facts);
  const { action, actor } = command;
  const at = utc(command.at);
  if (!REPORT_TRANSITIONS[facts.state].includes(action)) throw new Error('Forbidden report transition');
  if (integer(command.expectedClaimGeneration) !== facts.claimGeneration || command.expectedPublishedVersionId !== (facts.publishedVersion?.versionId ?? null))
    throw new Error('Stale claim or published version');
  string(actor.id);
  if (!actor.canReadStudy) throw new Error('Study access required');
  if (action === 'finalize') {
    if (actor.kind !== 'service') throw new Error('Finalization requires a service actor');
  } else if (actor.kind !== 'member' || !actor.roles.includes('radiologist')) throw new Error('Clinical reader role required');
  if (facts.firstApprovedAt !== null && Date.parse(at) < Date.parse(facts.firstApprovedAt)) throw new Error('Server time precedes approval');
  // Freeze only owned output; sharing nested references would freeze the caller's input.
  const next: ReportFacts = structuredClone(facts);
  const effects: LifecycleOutcome['effects'][number][] = ['preserve-private-drafts', 'preserve-subsequent-input'];
  const releaseClaim = () => { next.claimantId = null; next.claimGeneration = integer(next.claimGeneration + 1); };
  const requireClaim = () => { if (facts.claimantId !== actor.id) throw new Error('Claim belongs to another reader'); };
  const signedVersion = () => {
    if (!actor.canSign) throw new Error('Registered signing authority required');
    const ref = versionReference(command.version);
    if (ref.recordId !== facts.recordId || [facts.publishedVersion, facts.bodyVersion, ...facts.addenda.map(a => a.version)]
      .some(v => v?.versionId === ref.versionId)) throw new Error('New version required');
    if (facts.contentHistory.some(h => h.version.versionId === ref.versionId) || facts.contentHistory.some(h => h.at > at)) throw new Error('New chronological content required');
    if (command.preservationCorrection) {
      const e = verifiedRecord(command.preservationCorrection).event;
      if (!['amend', 'addendum'].includes(action) || e.act !== 'correction' || e.recordId !== facts.recordId || e.versionId !== ref.versionId ||
          e.sha256 !== ref.sha256 || e.at !== at || !e.signature || !e.processing?.authorized || !e.processing.preservesOriginals || !e.processing.separateManagement)
        refuse('HeldCorrectionAuthorityRequired');
    }
    next.contentHistory = [...next.contentHistory, { version: ref, at, action: action as 'preliminary' | 'approve' | 'amend' | 'addendum' | 'cancel',
      use: command.preservationCorrection ? 'preservation-correction' : 'clinical' }];
    effects.push('append-signed-version'); return ref;
  };
  switch (action) {
    case 'start':
      next.state = 'In Progress'; next.claimantId = actor.id; next.claimGeneration = integer(next.claimGeneration + 1); break;
    case 'renew-claim': requireClaim(); break;
    case 'save':
      if (facts.state === 'Preliminary') {
        if (![facts.preliminary.authorId, facts.preliminary.reviewerId].includes(actor.id)) throw new Error('Preliminary private boundary');
      } else requireClaim();
      effects.push('append-private-revision'); break;
    case 'release':
      next.state = 'Unread'; releaseClaim(); effects.push('notify-draft-presence-only'); break;
    case 'defer':
      if (facts.state === 'In Progress') requireClaim();
      string(command.reason); next.state = 'On Hold'; releaseClaim(); break;
    case 'preliminary':
      requireClaim(); string(command.reviewerId);
      if (command.reviewerId === actor.id) throw new Error('Self review forbidden');
      signedVersion(); next.state = 'Preliminary'; next.preliminary = { authorId: actor.id, reviewerId: command.reviewerId }; releaseClaim(); break;
    case 'cancel-preliminary':
      if (![facts.preliminary.authorId, facts.preliminary.reviewerId].includes(actor.id)) throw new Error('Preliminary private boundary');
      string(command.reason); string(command.eventId); next.state = 'Unread'; next.preliminary = null; releaseClaim(); effects.push('append-cancellation'); break;
    case 'approve': {
      if (facts.firstApprovedAt !== null) throw new Error('Cannot approve again to reset the clock');
      if (facts.state === 'Preliminary') {
        if (facts.preliminary.reviewerId !== actor.id || facts.preliminary.authorId === actor.id) throw new Error('Designated independent reviewer required');
      } else requireClaim();
      const version = signedVersion();
      next.state = 'Approved'; next.firstApprovedAt = at; next.originalSignerId = actor.id;
      next.amendUntil = new Date(Date.parse(at) + DAY_MS).toISOString(); next.publishedVersion = version; next.bodyVersion = version;
      next.preliminary = null; releaseClaim(); effects.splice(effects.indexOf('preserve-private-drafts'), 1);
      effects.push('publish-immediately', 'end-private-draft-purpose'); break;
    }
    case 'amend':
      if (actor.id !== facts.originalSignerId || Date.parse(at) >= Date.parse(facts.amendUntil)) throw new Error('Amendment signer or window refused');
      next.bodyVersion = signedVersion(); next.publishedVersion = next.bodyVersion; effects.push('publish-immediately'); break;
    case 'addendum': {
      const version = signedVersion();
      next.addenda = [...next.addenda, { version, authorId: actor.id }]; next.publishedVersion = version; effects.push('publish-immediately'); break;
    }
    case 'cancel': {
      if (!actor.canCancel) throw new Error('Hospital cancellation authority required');
      const reason = string(command.reason), eventId = string(command.eventId), version = signedVersion();
      next.state = 'Cancelled'; next.cancellation = { eventId, actorId: actor.id, at, reason, version };
      releaseClaim(); effects.push('append-cancellation'); break;
    }
    case 'finalize':
      if (Date.parse(at) < Date.parse(facts.amendUntil)) throw new Error('Not yet finalizable');
      next.state = 'Finalized'; next.finalized = { effectiveAt: facts.amendUntil, processedAt: at }; effects.push('append-finalization'); break;
  }
  if (['addendum', 'amend'].includes(action)) {
    effects.splice(effects.indexOf('preserve-private-drafts'), 1); effects.push('end-private-draft-purpose');
    if (command.preservationCorrection) effects.splice(effects.indexOf('publish-immediately'), 1);
  }
  validateReportFacts(next);
  return freeze({ facts: next, effects });
}
