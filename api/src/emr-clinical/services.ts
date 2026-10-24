import { OnlineSigningStore } from '../emr-report/online-store';
import type { RequestIdentityPort, WrappingSecrets } from '../emr-signature/server-contract';
import { pgSigningLedger } from '../emr-signature/pg-ledger';
import { ServerKeys } from '../emr-signature/server-keys';
import { ServerSigning } from '../emr-signature/server-signing';
import { verifyRegisteredServerEnvelope } from '../emr-signature/server-verification';
import { ClinicalRuntimeParts, composeClinicalRuntime } from './runtime';
import { onlineClinicalSigner } from './signing';

/** D consumes C2's custody/crypto and B2's transaction owner. The request and
 * source adapters are supplied by the real service owner, never browser JSON. */
export function createOnlineClinicalServices(parts: Omit<ClinicalRuntimeParts, 'signer'> & {
  identity: RequestIdentityPort; secrets: WrappingSecrets;
}) {
  const keys = new ServerKeys(pgSigningLedger(parts.records), parts.identity, new OnlineSigningStore(), parts.secrets);
  const signer = onlineClinicalSigner({ identity: parts.identity, keys,
    signing: new ServerSigning(keys), verifyRegisteredServerEnvelope });
  return { runtime: composeClinicalRuntime({ ...parts, signer }),
    keys: { manage: keys.manage.bind(keys) } };
}
