import type { SignatureEnvelope, SignaturePayload } from '../emr-contract/signature';
import type { Prisma } from '@prisma/client';
import type { ImmutableIdentity, PatientLinkSnapshot } from '../emr-contract/access-event';
import type { IngressContext, VerifiedActor } from '../emr-report/contract';

/** Server custody reuses v1; device enrollment and offline time evidence do not apply. */
export interface ServerPublicKey {
  kid: string;
  publicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}

/** The crypto operation supplies serverTime after the caller has acquired its transaction locks. */
export type ServerSigningContent = Omit<SignaturePayload, 'serverTime'>;

export interface ServerSignedEnvelope {
  envelope: Readonly<SignatureEnvelope>;
  /** Existing v1 convention: SHA-256 of the exact canonical payload bytes. */
  versionSha256: string;
  signedAt: string;
}

/** Integrity only: registry identity, authority, historical status and referenced content need stored evidence. */
export interface VerifiedServerEnvelope extends ServerSignedEnvelope {
  kid: string;
  payload: Readonly<SignaturePayload>;
  integrity: 'valid';
}

/** AES-256-GCM parameters are algorithm requirements, not a hospital rotation or capacity policy. */
export interface WrappedServerPrivateKey {
  algorithm: 'aes-256-gcm';
  wrappingKeyId: string;
  kid: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export type SigningTransaction = Prisma.TransactionClient;
export interface BusinessReference { kind: string; id: string; version: string | null }

/** Law-level facts for B2's record callback; never contains report text or private material. */
export interface SigningEvent {
  eventId: string;
  operationId: string;
  actor: ImmutableIdentity;
  institutionId: string;
  at: string;
  ingress: IngressContext;
  task: 'key-grant' | 'key-suspend' | 'key-revoke' | 'key-replace' | 'approve-sign' | 'amend' | 'addendum' | 'cancel' | 'view';
  result: 'succeeded';
  doctorId: string;
  kid: string;
  patient: PatientLinkSnapshot | null;
  studyId: string | null;
  recordId: string | null;
  versionId: string | null;
}
export type SigningRecordMutation = (event: SigningEvent,
  effect: () => Promise<BusinessReference | null>) => Promise<BusinessReference | null>;

/**
 * Same transaction/callback shape as B2 EmrRecordWork.transactionWithRecords and RecordMutation.
 * TODO after B2 merges: adapt SigningEvent to its accepted AccessEvent/permission contracts and
 * required streams, retaining B2 admission/unknown-result handling. No production ledger adapter
 * is installed here. A callback result is provisional until this outer promise commits.
 */
export interface LedgerPort {
  transactionWithRecords<T>(work: (tx: SigningTransaction, record: SigningRecordMutation) => Promise<T>): Promise<T>;
}

export interface RequestIdentity {
  actor: VerifiedActor;
  ingress: IngressContext;
  capacity: 'clinical' | 'operator' | 'support' | 'service';
  online: boolean;
}
export interface DoctorRegistration {
  identity: ImmutableIdentity;
  identityRegistrationId: string;
  institutionId: string;
  canSign: boolean;
}
/** Context is the real server request/session, never JSON facts supplied by a browser.
 * Implementations re-read and lock current membership/session rights until transaction end.
 * Doctor lookup verifies institutional registration; key administration is separately authorized.
 */
export interface RequestIdentityPort {
  resolve(tx: SigningTransaction, request: object): Promise<RequestIdentity>;
  authorizeKeyManagement(tx: SigningTransaction, request: object, institutionId: string): Promise<RequestIdentity>;
  doctor(tx: SigningTransaction, institutionId: string, doctorId: string): Promise<DoctorRegistration>;
}

export interface ServerKeyRegistration extends ServerPublicKey {
  doctor: DoctorRegistration;
  status: 'active' | 'suspended' | 'revoked';
  registeredAt: string;
  endedAt: string | null;
}
export interface WrappingSecrets {
  currentId: string;
  /** Return an owned buffer; the signing service clears it after use. */
  read(id: string): Promise<Buffer>;
}
