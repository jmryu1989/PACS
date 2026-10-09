import { choice, freeze, integer, object, refuse, string, utc } from '../emr-contract/validation';
import type { TimeBasis, TimeEvaluation } from './contract';

/**
 * The reviewed time uncertainty. There is deliberately no default: a missing or unreviewed value refuses rather than
 * silently becoming 0 or "unlimited" (D603: Q/J/H/epsilon are measured on real devices before activation).
 */
export interface TimePolicy { epsilonMs: number; reviewRef: string }
export function requireTimePolicy(input: unknown): Readonly<TimePolicy> {
  let p: Record<string, any>;
  try { p = object(input, ['epsilonMs', 'reviewRef']); string(p.reviewRef); integer(p.epsilonMs); }
  catch { refuse('TimePolicyRequired'); }
  return freeze({ epsilonMs: p.epsilonMs, reviewRef: p.reviewRef });
}

/** Server-issued anchor as the server stored it when the device asked for one. */
export interface StoredAnchor { anchorId: string; deviceId: string; bootId: string; serverTime: string; validUntil: string }
export interface AnchorReader { load(anchorId: string): unknown }

export function parseTimeBasis(input: unknown): Readonly<TimeBasis> {
  const v = object(input, ['anchorId', 'anchorServerTime', 'anchorValidUntil', 'anchorBootId', 'anchorTickMs', 'signBootId', 'signTickMs',
    'wallClockEvents', 'interval']);
  if (!Array.isArray(v.wallClockEvents)) throw new Error('Wall-clock events required');
  const events = v.wallClockEvents.map(e => {
    const x = object(e, ['kind', 'tickMs']);
    return { kind: choice(x.kind, ['set', 'rollback', 'zone']), tickMs: integer(x.tickMs) };
  });
  const i = object(v.interval, ['earliest', 'latest']);
  const basis = {
    anchorId: string(v.anchorId), anchorServerTime: utc(v.anchorServerTime), anchorValidUntil: utc(v.anchorValidUntil),
    anchorBootId: string(v.anchorBootId), anchorTickMs: integer(v.anchorTickMs), signBootId: string(v.signBootId), signTickMs: integer(v.signTickMs),
    wallClockEvents: events, interval: { earliest: utc(i.earliest), latest: utc(i.latest) },
  };
  if (basis.interval.earliest > basis.interval.latest || basis.anchorValidUntil <= basis.anchorServerTime) throw new Error('Invalid time basis');
  return freeze(basis);
}

const at = (ms: number) => new Date(ms).toISOString();
type HeldReason = 'boot-discontinuity' | 'wall-clock-changed' | 'anchor-expired' | 'anchor-unverified';
const held = (signedAt: string, reason: HeldReason): TimeEvaluation => freeze({ status: 'held' as const, signedAt, reason });

/**
 * Decide whether the claimed signing time is supported by its evidence. Inconsistent evidence (a claim that is not
 * anchor + elapsed ticks, a forged anchor, an interval other than the reviewed epsilon) is refused as tampering.
 * Evidence that is honest but broken (reboot, wall-clock change, expired or unknown anchor) is held: the original is
 * kept, but no window, grant or approval decision is made on that time.
 */
export function evaluateTimeBasis(input: TimeBasis, signedAt: string, deviceId: string, anchors: AnchorReader, policyInput: TimePolicy): TimeEvaluation {
  const basis = parseTimeBasis(input), policy = requireTimePolicy(policyInput);
  utc(signedAt); string(deviceId);
  // The claim must be exactly what the ticks say; a wall-clock reading in signedAt is not evidence.
  const elapsed = basis.signTickMs - basis.anchorTickMs;
  if (elapsed < 0 || at(Date.parse(basis.anchorServerTime) + elapsed) !== signedAt) refuse('TimeBasisMismatch');
  if (basis.interval.earliest !== at(Date.parse(signedAt) - policy.epsilonMs) || basis.interval.latest !== at(Date.parse(signedAt) + policy.epsilonMs))
    refuse('TimeBasisMismatch');
  let stored: StoredAnchor | null = null;
  try {
    const s = object(anchors.load(basis.anchorId), ['anchorId', 'deviceId', 'bootId', 'serverTime', 'validUntil']);
    stored = { anchorId: string(s.anchorId), deviceId: string(s.deviceId), bootId: string(s.bootId), serverTime: utc(s.serverTime), validUntil: utc(s.validUntil) };
  } catch { stored = null; }
  if (!stored) return held(signedAt, 'anchor-unverified');
  if (stored.anchorId !== basis.anchorId || stored.deviceId !== deviceId || stored.bootId !== basis.anchorBootId ||
      stored.serverTime !== basis.anchorServerTime || stored.validUntil !== basis.anchorValidUntil) refuse('TimeBasisMismatch');
  if (basis.signBootId !== basis.anchorBootId) return held(signedAt, 'boot-discontinuity');
  if (basis.wallClockEvents.some(e => e.tickMs >= basis.anchorTickMs && e.tickMs <= basis.signTickMs))
    return held(signedAt, 'wall-clock-changed');
  // The whole uncertainty interval must lie inside the anchor's validity, not only the claimed instant.
  if (basis.interval.latest > basis.anchorValidUntil) return held(signedAt, 'anchor-expired');
  return freeze({ status: 'verified', signedAt, interval: { ...basis.interval } });
}

/** Where the whole uncertainty interval lies relative to a boundary instant (e.g. amendUntil, grant expiry). */
export function boundaryPosition(interval: { earliest: string; latest: string }, boundary: string): 'before' | 'at-or-after' | 'straddles' {
  utc(boundary);
  if (interval.latest < boundary) return 'before';
  if (interval.earliest >= boundary) return 'at-or-after';
  return 'straddles';
}
