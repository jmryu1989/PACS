import { canonicalPayload } from '../emr-contract/signature';
import { refuse } from '../emr-contract/validation';
import type { RequestIdentity, ServerKeyRegistration, ServerSigningContent, SigningTransaction } from './server-contract';
import { clinicalIdentity, ServerKeys } from './server-keys';
import { signServerPayload } from './server-crypto';
import { verifyServerEnvelope } from './server-verification';

/** Only the online approval transaction owns this service. It does not commit or publish by itself. */
export class ServerSigning {
  constructor(private readonly keys: ServerKeys) {}

  async sign(tx: SigningTransaction, current: RequestIdentity, key: ServerKeyRegistration, content: ServerSigningContent) {
    const { actor } = clinicalIdentity(current);
    if (key.status !== 'active' || key.doctor.institutionId !== actor.institutionId || key.doctor.identity.id !== actor.identity.id ||
        content.actingInstitutionId !== actor.institutionId || content.identityRegistrationId !== actor.identityRegistrationId ||
        content.identityRegistrationId !== key.doctor.identityRegistrationId ||
        JSON.stringify(content.signer) !== JSON.stringify(actor.identity)) refuse('ServerSigningIdentityMismatch');
    if (!['approve-sign', 'amend', 'addendum', 'cancel'].includes(content.action)) refuse('ExplicitApprovalRequired');
    // Validate the finalized snapshot before decrypting the key; the actual timestamp is observed below.
    canonicalPayload({ ...content, serverTime: new Date().toISOString() });
    const privateKey = await this.keys.privateFor(tx, key);
    const result = signServerPayload(content, key.kid, privateKey);
    verifyServerEnvelope(result.envelope, { kid: key.kid, publicKey: key.publicKey }, { ...content, serverTime: result.signedAt });
    return result;
  }
}
