import { OnlineSigningStore } from '../emr-report/online-store';
import type { RequestIdentityPort, WrappingSecrets } from '../emr-signature/server-contract';
import { pgSigningLedger } from '../emr-signature/pg-ledger';
import { ServerKeys } from '../emr-signature/server-keys';
import { ServerSigning } from '../emr-signature/server-signing';
import { verifyRegisteredServerEnvelope } from '../emr-signature/server-verification';
import { ClinicalRuntimeParts, composeClinicalRuntime } from './runtime';
import { onlineClinicalSigner } from './signing';
import { ClinicalRoutes, ClinicalRouteSources, EMR_CLINICAL_ROUTES } from './routes';
import { clinicalRouteSources } from './sources';
import { NativeReportSigning, EMR_NATIVE_REPORT_SIGNING } from '../emr-report/native-signing';

/** D consumes C2's custody/crypto and B2's transaction owner. The request and
 * source adapters are supplied by the real service owner, never browser JSON. */
export function createOnlineClinicalServices(parts: Omit<ClinicalRuntimeParts, 'signer'> & {
  identity: RequestIdentityPort; secrets: WrappingSecrets; sources?: ClinicalRouteSources;
}) {
  const keys = new ServerKeys(pgSigningLedger(parts.records), parts.identity, new OnlineSigningStore(), parts.secrets);
  const signer = onlineClinicalSigner({ identity: parts.identity, keys,
    signing: new ServerSigning(keys), verifyRegisteredServerEnvelope });
  const composed = { ...parts, signer };
  return { runtime: composeClinicalRuntime(composed),
    routes: new ClinicalRoutes(composed, parts.sources ?? clinicalRouteSources(parts.identity, parts.records)),
    nativeReportSigning: new NativeReportSigning(parts),
    keys: { manage: keys.manage.bind(keys) } };
}

/** The startup owner supplies A's readers/identity and C2's wrapping-secret
 * location, then installs these providers in the module with the real routes. */
export function onlineClinicalProviders(services: ReturnType<typeof createOnlineClinicalServices>) {
  return [
    { provide: EMR_CLINICAL_ROUTES, useValue: services.routes },
    { provide: EMR_NATIVE_REPORT_SIGNING, useValue: services.nativeReportSigning },
  ];
}
