import type { Prisma } from '@prisma/client';
import type { ImmutableIdentity } from '../emr-contract/access-event';
import { canonicalPayload, SignatureEnvelope, SignaturePayload } from '../emr-contract/signature';
import { freeze, refuse } from '../emr-contract/validation';
import type { SigningRequest } from './contract';

/** The public part of C2's retained registration. D never opens a private key. */
export interface ClinicalSigningKey {
  kid: string;
  publicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  doctor: { identity: ImmutableIdentity; identityRegistrationId: string; institutionId: string; canSign: boolean };
  status: 'active' | 'suspended' | 'revoked';
  registeredAt: string;
  endedAt: string | null;
}
export interface ClinicalSignature {
  envelope: Readonly<SignatureEnvelope>;
  registration: ClinicalSigningKey;
  signedAt: string;
  payloadSha256: string;
}
type Content = Omit<SignaturePayload, 'serverTime'>;
type Signed = { envelope: Readonly<SignatureEnvelope>; versionSha256: string; signedAt: string };
type Verified = Signed & { payload: Readonly<SignaturePayload>; integrity: 'valid'; registeredIdentity: 'matched'; keyAtSigningTime: 'active' };

/** C2's server-contract/server-keys/server-signing/server-verification methods,
 * consumed structurally so this B2-based branch does not copy C2-owned files.
 * The composition writer supplies the real instances after the C2 dependency lands. */
export interface ClinicalSigningDependencies<Current> {
  identity: { resolve(tx: Prisma.TransactionClient, request: object): Promise<Current> };
  keys: { forApproval(tx: Prisma.TransactionClient, current: Current): Promise<ClinicalSigningKey> };
  signing: { sign(tx: Prisma.TransactionClient, current: Current, key: ClinicalSigningKey, content: Content): Promise<Signed> };
  verifyRegisteredServerEnvelope(envelope: unknown, registration: ClinicalSigningKey): Readonly<Verified>;
}
export interface ClinicalSigner {
  sign(tx: Prisma.TransactionClient, request: object, version: SigningRequest): Promise<Readonly<ClinicalSignature>>;
  verify(signature: ClinicalSignature, version: SigningRequest): void;
}

export function clinicalSigningContent(version: SigningRequest): Content {
  return {
    formatVersion: 'emr-signature/1',
    // The payload binds the exact version as well as its text/SOP bytes. State,
    // references and patient identity must not detach from the approved entry.
    text: { kind: 'clinical-entry', body: JSON.stringify({ versionSha256: version.versionSha256, content: version.content }) },
    patient: version.patient, studyId: version.studyId,
    managingInstitutionId: version.managingInstitutionId, actingInstitutionId: version.actingInstitutionId,
    recordKind: version.recordKind, recordId: version.recordId, versionId: version.versionId,
    author: version.author, signer: version.signer, identityRegistrationId: version.identityRegistrationId,
    action: version.action === 'record' ? 'approve-sign' : version.action,
    previousVersion: version.previousVersion, attachments: version.attachments, reason: version.reason,
  };
}

export function onlineClinicalSigner<Current>(ports: ClinicalSigningDependencies<Current>): ClinicalSigner {
  const verify = (signature: ClinicalSignature, version: SigningRequest) => {
    const verified = ports.verifyRegisteredServerEnvelope(signature.envelope, signature.registration);
    const expected = canonicalPayload({ ...clinicalSigningContent(version), serverTime: signature.signedAt });
    if (!canonicalPayload(verified.payload).equals(expected) || verified.signedAt !== signature.signedAt ||
        verified.versionSha256 !== signature.payloadSha256 || verified.integrity !== 'valid' ||
        verified.registeredIdentity !== 'matched' || verified.keyAtSigningTime !== 'active') refuse('SignatureBindingRefused');
  };
  return {
    async sign(tx, request, version) {
      const current = await ports.identity.resolve(tx, request);
      const key = await ports.keys.forApproval(tx, current);
      const signed = await ports.signing.sign(tx, current, key, clinicalSigningContent(version));
      const signature = freeze(structuredClone({ envelope: signed.envelope, registration: key,
        signedAt: signed.signedAt, payloadSha256: signed.versionSha256 }));
      verify(signature, version);
      return signature;
    },
    verify,
  };
}
