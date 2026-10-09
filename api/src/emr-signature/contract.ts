import type { ImmutableIdentity, PatientLinkSnapshot } from '../emr-contract/access-event';
import type { RecordKind } from '../emr-contract/classification';
import type { AttachmentReference, SignedText, VersionReference } from '../emr-contract/signature';
import { freeze } from '../emr-contract/validation';

/**
 * Signature v2 (EMR-C1). v1 (`emr-signature/1`, server time) stays byte-compatible in the A contract; v2 signs the
 * device's actual signing time with its evidence, the device key, the offline grant and the event identity, so an
 * approval made while disconnected is signed when it happens instead of being signed later and back-dated.
 * Nothing here is wired to a route, a database or an OS key; C2/C-NATIVE bind it.
 */
export const SIGNATURE_V2_FORMAT = 'emr-signature/2' as const;
/** Different `typ` from v1 (`emr-signature+jws`): a v1 envelope can never carry a v2 payload and vice versa. */
export const SIGNATURE_V2_TYPE = 'emr-signature-v2+jws' as const;
/** `record` is a first non-report entry (e.g. a radiographer's Tech Note); report flows never use it. */
export const SIGNATURE_V2_ACTIONS = freeze(['record', 'preliminary', 'approve-sign', 'amend', 'addendum', 'cancel'] as const);
export type SignatureActionV2 = typeof SIGNATURE_V2_ACTIONS[number];

/**
 * Evidence for the signing time, captured by the native runtime. `signedAt` must equal anchorServerTime plus the
 * monotonic ticks elapsed since the server anchor on the same boot. A reboot or a recorded wall-clock change breaks
 * that chain: the original is kept and its time is held unverified rather than trusted or rewritten.
 */
export interface TimeBasis {
  anchorId: string;
  anchorServerTime: string;
  anchorValidUntil: string;
  anchorBootId: string;
  anchorTickMs: number;
  signBootId: string;
  signTickMs: number;
  wallClockEvents: readonly { kind: 'set' | 'rollback' | 'zone'; tickMs: number }[];
  interval: { earliest: string; latest: string };
}
export interface GrantReference { grantId: string; digest: string }

/** Field order below is format v2; bytes are preserved exactly (no trim, newline or Unicode normalisation). */
export interface SignaturePayloadV2 {
  formatVersion: typeof SIGNATURE_V2_FORMAT;
  text: SignedText;
  patient: PatientLinkSnapshot;
  managingInstitutionId: string;
  actingInstitutionId: string;
  studyId: string;
  recordKind: RecordKind;
  recordId: string;
  versionId: string;
  previousVersion: VersionReference | null;
  attachments: readonly AttachmentReference[];
  author: ImmutableIdentity;
  signer: ImmutableIdentity;
  identityRegistrationId: string;
  action: SignatureActionV2;
  reason: string | null;
  eventId: string;
  deviceId: string;
  kid: string;
  /** null only for a connected (online) signature; every offline signature names the server grant it relied on. */
  grant: GrantReference | null;
  claimGeneration: number;
  draftRevision: string | null;
  deviceSequence: number;
  predecessorEventId: string | null;
  signedAt: string;
  timeBasis: TimeBasis;
}
export const SIGNATURE_V2_FIELDS = freeze(['formatVersion', 'text', 'patient', 'managingInstitutionId', 'actingInstitutionId', 'studyId',
  'recordKind', 'recordId', 'versionId', 'previousVersion', 'attachments', 'author', 'signer', 'identityRegistrationId', 'action', 'reason',
  'eventId', 'deviceId', 'kid', 'grant', 'claimGeneration', 'draftRevision', 'deviceSequence', 'predecessorEventId', 'signedAt', 'timeBasis'] as const);

/** Flattened JWS with the exact base64url bytes; the protected header is fixed per format. */
export interface SignatureEnvelopeV2 { protected: string; payload: string; signature: string }

export type TimeEvaluation = Readonly<
  { status: 'verified'; signedAt: string; interval: { earliest: string; latest: string } } |
  { status: 'held'; signedAt: string; reason: 'boot-discontinuity' | 'wall-clock-changed' | 'anchor-expired' | 'anchor-unverified' }
>;

/** Server acceptance facts. receivedAt/committedAt/publishedAt are separate server facts, never written into the payload. */
export interface VerifiedSignatureV2 {
  kid: string;
  payload: Readonly<SignaturePayloadV2>;
  /** The exact envelope that was verified (base64url text, frozen); only these bytes may be stored or published. */
  envelope: SignatureEnvelopeV2;
  /** SHA-256 of the exact signed payload bytes: the content hash of this version. */
  versionSha256: string;
  integrity: 'valid';
  registeredIdentity: 'matched';
  keyAtSigningTime: 'active' | 'inactive' | 'unverifiable';
  time: TimeEvaluation;
  /** The OS user the runtime reported for this signature, compared with the key's registered user. */
  osUserId: string;
}

export const SIGNATURE_V2_CONTRACT = freeze({
  compatibility: 'v1 payloads/envelopes verify unchanged through the A contract; v2 is a separate typ and formatVersion',
  authority: 'signer identity, identityRegistrationId, recordKind and institutions are compared with server-stored facts, never request flags',
  time: 'signedAt is derived from a server anchor and same-boot monotonic ticks; broken evidence is held, never reset to receipt time',
  epsilon: 'the reviewed uncertainty only widens the interval; a decision boundary must not intersect it, epsilon never extends a window',
  keys: 'device-bound non-exportable key per clinician and device; test keys are accepted only by an explicit test key policy',
  noOracle: 'native signing accepts a complete approval request and stores it atomically; there is no raw-bytes signing call',
});
