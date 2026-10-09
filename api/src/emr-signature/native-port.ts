import { createHash } from 'node:crypto';
import { identity, patientLink, ImmutableIdentity, PatientLinkSnapshot } from '../emr-contract/access-event';
import { choice, freeze, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';
import type { SignatureEnvelopeV2, SignaturePayloadV2, TimeBasis } from './contract';
import { canonicalPayloadV2, inspectEnvelopeV2 } from './canonical-v2';
import { parseTimeBasis } from './time-basis';

/**
 * Data contract between the page and the managed Windows native runtime (C-NATIVE). This repository implements no
 * native code: the runtime, its TPM use, encrypted storage and durable queue are a separate deliverable that must
 * implement exactly these messages. A mock of this port proves nothing about real durability or key custody.
 */
export const NATIVE_PROTOCOL = 'kin-native/1' as const;

/**
 * The closed operation set. There is intentionally no "sign these bytes" operation: the runtime only signs a complete
 * approval it has fixed itself and stores the original, its access event and the queue entry in the same atomic write.
 */
export const NATIVE_OPERATIONS = freeze(['registration-proof', 'install-grant', 'time-snapshot', 'sign-approval', 'list-queue',
  'record-receipt', 'lock', 'recover-queue', 'manifest-status'] as const);
export type NativeOperation = typeof NATIVE_OPERATIONS[number];

/** Every call is bound to the product origin, the document that asked, and the OS user the key belongs to. */
export interface NativeCallContext { protocol: typeof NATIVE_PROTOCOL; origin: string; documentId: string; osUserId: string }
export function requireNativeCall(input: unknown, allowed: { origins: readonly string[]; osUserId: string }): Readonly<{ operation: NativeOperation; context: NativeCallContext }> {
  const v = object(input, ['operation', 'context']);
  if (!(NATIVE_OPERATIONS as readonly string[]).includes(v.operation)) refuse('NativeOperationRefused');
  const c = object(v.context, ['protocol', 'origin', 'documentId', 'osUserId']);
  if (c.protocol !== NATIVE_PROTOCOL) refuse('NativeProtocolRefused');
  if (!allowed.origins.includes(string(c.origin)) || string(c.osUserId) !== allowed.osUserId) refuse('NativeBindingRefused');
  string(c.documentId);
  return freeze({ operation: v.operation, context: { protocol: NATIVE_PROTOCOL, origin: c.origin, documentId: c.documentId, osUserId: c.osUserId } });
}

/**
 * An access fact observed on the device while offline. No proxy saw the request, so the IP is "not observed" and stays
 * so; the reconnect IP belongs to the separate server receipt event (B's offline v2 branch will verify this shape).
 */
export interface OfflineAccessObservation {
  formatVersion: 'emr-offline-access/1';
  eventId: string;
  relatedEventId: string | null;
  deviceId: string;
  deviceSequence: number;
  kid: string;
  identity: ImmutableIdentity;
  actingInstitutionId: string;
  managingInstitutionId: string;
  action: 'approve-sign' | 'amend' | 'addendum' | 'cancel' | 'client-shown' | 'print-opened' | 'print-done';
  target: { patient: PatientLinkSnapshot; studyId: string; recordId: string; versionId: string };
  occurredAt: string;
  timeBasis: TimeBasis;
  ip: { status: 'unresolved'; reason: 'not-observed' };
  network: 'offline';
  physicalOutput: 'not-observed' | null;
}
export function parseOfflineObservation(input: unknown): Readonly<OfflineAccessObservation> {
  const v = object(input, ['formatVersion', 'eventId', 'relatedEventId', 'deviceId', 'deviceSequence', 'kid', 'identity', 'actingInstitutionId',
    'managingInstitutionId', 'action', 'target', 'occurredAt', 'timeBasis', 'ip', 'network', 'physicalOutput']);
  if (v.formatVersion !== 'emr-offline-access/1') throw new Error('Unknown offline access format');
  // A filled-in address here would be invented: nothing observed it while the device was disconnected.
  const ip = v.ip as { status?: unknown; reason?: unknown } | null;
  if (!ip || typeof ip !== 'object' || Object.keys(ip).length !== 2 || ip.status !== 'unresolved' || ip.reason !== 'not-observed' || v.network !== 'offline')
    refuse('OfflineAddressRefused');
  const action = choice(v.action, ['approve-sign', 'amend', 'addendum', 'cancel', 'client-shown', 'print-opened', 'print-done']);
  const t = object(v.target, ['patient', 'studyId', 'recordId', 'versionId']);
  const relatedEventId = v.relatedEventId === null ? null : string(v.relatedEventId);
  if (action === 'print-done' && relatedEventId === null) throw new Error('Preceding print event required');
  // print-done is a client report that the dialog returned, never evidence that paper came out.
  if ((action === 'print-done') !== (v.physicalOutput === 'not-observed') || (action !== 'print-done' && v.physicalOutput !== null))
    refuse('PrintCompletionRefused');
  return freeze({ formatVersion: 'emr-offline-access/1' as const, eventId: string(v.eventId), relatedEventId, deviceId: string(v.deviceId),
    deviceSequence: integer(v.deviceSequence, 1), kid: string(v.kid), identity: identity(v.identity), actingInstitutionId: string(v.actingInstitutionId),
    managingInstitutionId: string(v.managingInstitutionId), action,
    target: { patient: patientLink(t.patient), studyId: string(t.studyId), recordId: string(t.recordId), versionId: string(t.versionId) },
    occurredAt: utc(v.occurredAt), timeBasis: parseTimeBasis(v.timeBasis), ip: { status: 'unresolved' as const, reason: 'not-observed' as const },
    network: 'offline' as const, physicalOutput: v.physicalOutput });
}

export interface QueueOwner { issuer: string; subject: string; institutionId: string; deviceId: string; osUserId: string }
export function parseQueueOwner(input: unknown): Readonly<QueueOwner> {
  const v = object(input, ['issuer', 'subject', 'institutionId', 'deviceId', 'osUserId']);
  return freeze({ issuer: string(v.issuer), subject: string(v.subject), institutionId: string(v.institutionId), deviceId: string(v.deviceId), osUserId: string(v.osUserId) });
}
export const sameOwner = (a: QueueOwner, b: QueueOwner) =>
  a.issuer === b.issuer && a.subject === b.subject && a.institutionId === b.institutionId && a.deviceId === b.deviceId && a.osUserId === b.osUserId;

/** The stored unit: signed original, its access observation, owner and order. Digest covers all of it. */
export interface QueueEntry {
  formatVersion: 'emr-offline-queue/1';
  eventId: string;
  owner: QueueOwner;
  deviceSequence: number;
  predecessorEventId: string | null;
  envelope: SignatureEnvelopeV2;
  access: OfflineAccessObservation;
  baseVersionId: string | null;
}
export function parseQueueEntry(input: unknown): Readonly<QueueEntry> {
  const v = object(input, ['formatVersion', 'eventId', 'owner', 'deviceSequence', 'predecessorEventId', 'envelope', 'access', 'baseVersionId']);
  if (v.formatVersion !== 'emr-offline-queue/1') throw new Error('Unknown queue format');
  const env = inspectEnvelopeV2(v.envelope), access = parseOfflineObservation(v.access), owner = parseQueueOwner(v.owner);
  const p = env.payload;
  // The queue row, the signed payload and the observation describe one event; any disagreement is corruption.
  if (v.eventId !== p.eventId || access.eventId !== p.eventId || v.deviceSequence !== p.deviceSequence || access.deviceSequence !== p.deviceSequence ||
      access.action !== p.action || v.predecessorEventId !== p.predecessorEventId || owner.deviceId !== p.deviceId || access.deviceId !== p.deviceId || owner.subject !== p.signer.subject ||
      owner.issuer !== p.signer.issuer || access.kid !== p.kid || access.occurredAt !== p.signedAt || access.target.versionId !== p.versionId ||
      access.target.recordId !== p.recordId || (v.baseVersionId ?? null) !== (p.previousVersion?.versionId ?? null)) refuse('QueueEntryInconsistent');
  return freeze({ formatVersion: 'emr-offline-queue/1' as const, eventId: p.eventId, owner, deviceSequence: p.deviceSequence,
    predecessorEventId: p.predecessorEventId, envelope: { protected: v.envelope.protected, payload: v.envelope.payload, signature: v.envelope.signature },
    access, baseVersionId: v.baseVersionId ?? null });
}
export function queueEntryDigest(entry: QueueEntry): string {
  const e = parseQueueEntry(entry);
  return createHash('sha256').update(JSON.stringify(e)).digest('hex');
}

export interface SignApprovalRequest { payload: SignaturePayloadV2; access: OfflineAccessObservation; owner: QueueOwner; baseVersionId: string | null }
export interface DurableReceipt { eventId: string; entryId: string; digest: string; durableAt: string }
export interface SignApprovalResult { protocol: typeof NATIVE_PROTOCOL; entry: QueueEntry; durable: DurableReceipt }

/**
 * Accept the runtime's answer only when it signed exactly the requested payload and reports a durable write of the
 * same entry. A signature without a durable receipt is not a pending approval.
 */
export function parseSignApprovalResult(result: unknown, request: SignApprovalRequest): Readonly<{ entry: QueueEntry; durable: DurableReceipt; digest: string }> {
  const r = object(result, ['protocol', 'entry', 'durable']);
  if (r.protocol !== NATIVE_PROTOCOL) refuse('NativeProtocolRefused');
  const entry = parseQueueEntry(r.entry);
  if (!Buffer.from(entry.envelope.payload, 'base64url').equals(canonicalPayloadV2(request.payload))) refuse('NativeSignedOtherContent');
  const d = object(r.durable, ['eventId', 'entryId', 'digest', 'durableAt']);
  const digest = queueEntryDigest(entry);
  if (d.eventId !== entry.eventId || sha256(d.digest) !== digest) refuse('DurableReceiptRequired');
  string(d.entryId); utc(d.durableAt);
  return freeze({ entry, durable: { eventId: d.eventId, entryId: d.entryId, digest: d.digest, durableAt: d.durableAt }, digest });
}

export const NATIVE_REQUIREMENTS = freeze({
  platform: 'managed Windows 11 x64; support table fixed by C-NATIVE measurements (TPM algorithm support is not assumed)',
  key: 'per clinician and device, non-exportable, bound to the registered OS user; no private key or master key reaches the browser',
  store: 'encrypted with OS ACL; atomic write+flush of original, access event and queue entry; space reserved before image loading',
  retention: 'unsent signed originals survive cache eviction, logout and grant expiry; removed only after a verified server retention receipt',
  time: 'server anchor + monotonic ticks + boot id; app restart and OS reboot are distinguished; broken evidence is never invented',
  friction: 'the normal Approve adds no key prompt, extra click or forced login',
});
