// EMR-B2 (d) TEST-B2R-06 fixture: a typed consumer that reaches, through the record port, what the port must not carry.
// Every line marked `// refused` must be refused by the compiler (property does not exist); the case asserts exactly
// those lines. A cast to `any` or a bracket access is not a typed consumer and is not covered here: the runtime objects
// have no such property either (the case's runtime part). This file is outside the product tree and never compiled
// into it.
import type { EmrRecordPort, EmrRecordWork } from '../../../../api/src/emr-runtime/record-port';

export async function reach(port: EmrRecordPort, work: EmrRecordWork): Promise<void> {
  await port.seal.recoverAtStart(); // refused
  port.journal.coordinator.call('compact'); // refused
  await port.db.$disconnect(); // refused
  port.sql.withWriterFence(async () => undefined); // refused
  port.store.append; // refused
  port.ledger; // refused
  port.client; // refused
  await port.close(); // refused
  await port.start(); // refused
  port.interrupt(); // refused
  port.recover(); // refused
  port.compose(); // refused
  port.requireResources(); // refused
  await work.seal.recoverAtStart(); // refused
  work.journal.coordinator.call('compact'); // refused
  await work.db.$disconnect(); // refused
  work.sql.withWriterFence(async () => undefined); // refused
  work.store; // refused
  await work.close(); // refused
  await work.start(); // refused
  work.recoverAtStart(); // refused
  work.withWriterFence(async () => undefined); // refused
  work.recordOrderFact; // refused
  work.recordHold; // refused
  work.recordProjection; // refused
  work.enterWriter; // refused
  work.bindCommit; // refused
  work.appendRow; // refused
  port.begin().coordinator; // refused
}
