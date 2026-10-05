import { VersionReference, versionReference } from './signature';
import { choice, freeze, integer, object, string, utc } from './validation';

export type ReportState = 'Unread' | 'In Progress' | 'Preliminary' | 'On Hold' | 'Approved' | 'Finalized' | 'Cancelled';
export interface ReportFacts {
  recordId: string;
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
}
export interface LifecycleOutcome {
  facts: Readonly<ReportFacts>;
  effects: readonly ('preserve-private-drafts' | 'preserve-subsequent-input' | 'append-private-revision' | 'append-signed-version' | 'publish-immediately' | 'notify-draft-presence-only' | 'append-cancellation' | 'append-finalization')[];
}
const DAY_MS = 24 * 60 * 60 * 1000;

export function newReportFacts(recordId: string): Readonly<ReportFacts> {
  return freeze({ recordId: string(recordId), state: 'Unread', firstApprovedAt: null, originalSignerId: null, amendUntil: null,
    publishedVersion: null, bodyVersion: null, addenda: [], claimantId: null, claimGeneration: 0, preliminary: null, cancellation: null, finalized: null });
}

export function validateReportFacts(input: ReportFacts): void {
  const f = object(input, ['recordId', 'state', 'firstApprovedAt', 'originalSignerId', 'amendUntil', 'publishedVersion', 'bodyVersion',
    'addenda', 'claimantId', 'claimGeneration', 'preliminary', 'cancellation', 'finalized']) as unknown as ReportFacts;
  string(f.recordId); choice(f.state, Object.keys(REPORT_TRANSITIONS) as ReportState[]); integer(f.claimGeneration);
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
      next.preliminary = null; releaseClaim(); effects.push('publish-immediately'); break;
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
  validateReportFacts(next);
  return freeze({ facts: next, effects });
}
