import { freeze, object, refuse, string } from '../emr-contract/validation';
import { inspectEnvelopeV2 } from '../emr-signature/canonical-v2';
import type { SignatureEnvelopeV2, SignaturePayloadV2 } from '../emr-signature/contract';
import { SignatureVerificationPorts, verifySignatureV2 } from '../emr-signature/verify';
import type { SignatureEvidence, SigningRequest } from './contract';
import type { SignaturePort } from './records';

/**
 * EMR-D round 2: records.ts SignaturePort bound to C's landed v2 verification (api/src/emr-signature). The server holds
 * no signing key and signs nothing: a clinical entry is signed on the author's registered device (D603) and its exact
 * envelope reaches the server with the write. sign() hands that carried envelope to the plan and verify() accepts it
 * only when C verifies integrity, the registered key and identity, a verified signing time and an active key, and the
 * signed payload is exactly this planned version - its record, version, text, patient, study, institutions, author =
 * signer, registration, action, reason, previous version, attachments and the write's own request ID. Anything else is
 * refused and nothing is committed (records.ts seals the original). There is no proxy and no service-account signature.
 */

/** What the write carried and sign() returns: the device's exact JWS, the OS user its runtime reported, the request ID. */
export interface SignedEnvelope { jws: SignatureEnvelopeV2; osUserId: string; eventId: string }

/** The signed text of a manual SR adoption: the exact SOP and the SHA-256 of the exact DICOM bytes, as canonical JSON. */
export function srAdoptionText(content: { sopInstanceUid: string; sha256: string }): string {
  return JSON.stringify({ sha256: string(content.sha256), sopInstanceUid: string(content.sopInstanceUid) });
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameIdentity = (a: { id: string; issuer: string; subject: string }, b: { id: string; issuer: string; subject: string }) =>
  !!a && !!b && a.id === b.id && a.issuer === b.issuer && a.subject === b.subject;
const canonicalRefs = (refs: readonly unknown[]) => JSON.stringify(refs.map(r => {
  const x = r as Record<string, unknown>;
  return [x.kind, x.recordId, x.versionId, x.sha256];
}));

/** Every planned fact against the signed payload; the first difference refuses with one closed code. */
export function bindSignedVersion(p: Readonly<SignaturePayloadV2>, request: Readonly<SigningRequest>, eventId: string): void {
  const body = request.content.kind === 'text' ? request.content.body : srAdoptionText(request.content);
  const checks: readonly boolean[] = [
    p.recordKind === request.recordKind, p.recordId === request.recordId, p.versionId === request.versionId,
    p.text.kind === 'clinical-entry' && (p.text as { body: string }).body === body,
    same(p.patient, request.patient), p.studyId === request.studyId, p.managingInstitutionId === request.managingInstitutionId,
    p.actingInstitutionId === request.actingInstitutionId, sameIdentity(p.author, request.author), sameIdentity(p.signer, request.signer),
    sameIdentity(p.signer, p.author), p.identityRegistrationId === request.identityRegistrationId, p.action === request.action,
    p.reason === request.reason, same(p.previousVersion, request.previousVersion), canonicalRefs(p.attachments) === canonicalRefs(request.attachments),
    p.eventId === eventId, p.grant === null, p.claimGeneration === 0, p.draftRevision === null, p.predecessorEventId === null,
  ];
  if (checks.some(ok => !ok)) refuse('SignatureBindingRefused');
}

/**
 * The port one write (or its recovery) uses. `carried(originalId)` returns the signature fixed with that original at its
 * admission (the register keeps it for recovery), or null when the request carried none.
 */
export function deviceSignaturePort(ports: SignatureVerificationPorts, carried: (originalId: string) => SignedEnvelope | null): SignaturePort {
  return {
    async sign(request, operation) {
      const signed = operation?.originalId ? carried(operation.originalId) : null;
      if (!signed) refuse('SignatureRequired');
      // Structure only here; verify() below is the cryptographic and binding decision.
      const envelope = inspectEnvelopeV2(signed.jws);
      if (envelope.payload.versionId !== request.versionId || envelope.payload.recordId !== request.recordId) refuse('SignatureBindingRefused');
      return freeze({ jws: { ...signed.jws }, osUserId: string(signed.osUserId), eventId: string(signed.eventId) });
    },
    async verify(input, request): Promise<SignatureEvidence> {
      let signed: Record<string, any>;
      try { signed = object(input, ['jws', 'osUserId', 'eventId']); } catch { refuse('SignatureNotVerified'); }
      const verified = verifySignatureV2(signed.jws, ports, { osUserId: signed.osUserId });
      if (verified.time.status !== 'verified') refuse('SignatureTimeUnverified');
      if (verified.keyAtSigningTime !== 'active') refuse('SigningKeyInactive');
      bindSignedVersion(verified.payload, request, signed.eventId);
      // C keeps no separate compromise register yet; 'not-known' states exactly that no compromise is known to it.
      return freeze({ recordId: request.recordId, versionId: request.versionId, versionSha256: request.versionSha256,
        signer: { ...verified.payload.signer }, identityRegistrationId: verified.payload.identityRegistrationId,
        verification: { integrity: verified.integrity, registeredIdentity: verified.registeredIdentity, keyAtSigningTime: verified.keyAtSigningTime,
          compromise: 'not-known' } });
    },
  };
}
