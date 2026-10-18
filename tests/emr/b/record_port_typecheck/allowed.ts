// EMR-B2 (d) TEST-B2R-06 fixture: a typed consumer that uses exactly what the record port carries. It must compile
// without a diagnostic (the case asserts none). This file is outside the product tree and never compiled into it.
import type { AccessEvent, DurableAccessReceipt } from '../../../../api/src/emr-contract/access-event';
import type { EmrRecordPort, EmrRecordWork, EmrRecordTransaction } from '../../../../api/src/emr-runtime/record-port';
import type { EmrSnapshot } from '../../../../api/src/emr-runtime/context';

/** One request's recording lifetime: a provision before its body, a change with its fact in one transaction, the
 * snapshot an A decision reads, the identity of the verified member, the end after the last record. */
export async function record(port: EmrRecordPort, provision: AccessEvent, change: AccessEvent, business: (tx: EmrRecordTransaction) => Promise<void>): Promise<DurableAccessReceipt> {
  const work: EmrRecordWork = port.begin();
  try {
    const prepared: DurableAccessReceipt = await work.append(provision);
    let transaction: EmrRecordTransaction | null = null;
    let callbackFailed = false;
    try {
      const appended = await work.transaction(async tx => {
        transaction = tx;
        await business(tx);
        try { return await work.appendInTransaction(tx, change); }
        catch (error) { callbackFailed = true; throw error; }
      });
      await work.confirm(appended);
    } catch (error) {
      if (transaction) await work.settleTransaction(transaction, change, error, callbackFailed);
      else await work.settle(change, error);
      throw error;
    }
    const facts: EmrSnapshot = await work.transaction(tx => work.snapshot(tx, Object.freeze({}), { accessEventIds: [provision.eventId] }));
    const memberId: string = await work.transaction(tx => work.resolveIdentity(tx, 'https://identity.example.test', 'subject'));
    return facts.accessEvents.has(provision.eventId) && memberId ? prepared : prepared;
  } finally { work.end(); }
}
