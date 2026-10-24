import { OnlineApproval } from '../emr-report/online-approval';
import type { OnlineReportBoundary } from '../emr-report/current-study';
import { OnlineSigningStore } from '../emr-report/online-store';
import type { LedgerPort, RequestIdentityPort, WrappingSecrets } from './server-contract';
import { ServerKeys } from './server-keys';
import { ServerSigning } from './server-signing';

/** Explicit composition only: no fallback ledger/identity, route, secret or background signer. */
export function createServerSigning(dependencies: {
  ledger: LedgerPort; identity: RequestIdentityPort; reports: OnlineReportBoundary; secrets: WrappingSecrets;
}) {
  const store = new OnlineSigningStore();
  const keys = new ServerKeys(dependencies.ledger, dependencies.identity, store, dependencies.secrets);
  const signing = new ServerSigning(keys);
  // The administrative facade has no decrypt/sign capability; the approval service retains custody.
  return { keys: { manage: keys.manage.bind(keys) },
    approval: new OnlineApproval(dependencies.ledger, dependencies.identity, dependencies.reports, store, keys, signing) };
}
