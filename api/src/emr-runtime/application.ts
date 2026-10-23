import { createBackgroundWorkRegistry } from './background-work';
import { composeEmrAdapters } from '../emr-contract/composition';
import { EmrLedgerClient } from './client';
import { runtimeAdapters } from './context';
import { FailureJournal, FailureSpool } from './failure-journal';
import { verifyRuntimeConnection } from './manifest';
import { createRecordPort, EmrRecordPort, EmrRecordPortControl } from './record-port';
import { AccessLedgerStore } from './store';

/** Ordinary PostgreSQL connection/start/stop ownership. No external state owner,
 * IPC session, seal, checkpoint, or second outcome authority. */
export class EmrRuntime {
  readonly background = createBackgroundWorkRegistry();
  readonly port: EmrRecordPort;
  readonly control: EmrRecordPortControl;
  private readonly db: EmrLedgerClient;
  private readonly journal: FailureJournal;
  private readonly ledger: AccessLedgerStore;
  private ready = false;
  constructor(url: string, failureDirectory: string) {
    this.db = new EmrLedgerClient(url);
    this.journal = new FailureJournal(this.db, new FailureSpool(failureDirectory));
    this.ledger = new AccessLedgerStore(this.db, this.journal);
    ({ port: this.port, control: this.control } = createRecordPort(this.ledger));
  }
  async start(): Promise<void> {
    if (this.ready) return;
    try {
      await this.db.$connect();
      await verifyRuntimeConnection(this.db);
      await this.ledger.recoverPending();
      await this.journal.replay();
      composeEmrAdapters(runtimeAdapters);
      this.ready = true;
    } catch (error) {
      const cleanup = await Promise.allSettled([this.journal.close(), this.db.$disconnect()]);
      if (cleanup.some(r => r.status === 'rejected')) console.error('[EMR] Startup cleanup failed.');
      throw error;
    }
  }
  isReady(): boolean { return this.ready; }
  /** Launcher supplies its one existing shutdown deadline. Cleanup errors are
   * returned to that owner rather than hidden as a successful process exit. */
  async stop(deadline: number): Promise<void> {
    this.background.quiesce(); this.control.close(); this.ready = false;
    let timer: ReturnType<typeof setTimeout>;
    const stop = async () => {
      await Promise.all([this.background.drained(), this.control.drained()]);
      const results = await Promise.allSettled([this.journal.close(), this.db.$disconnect()]);
      if (results.some(r => r.status === 'rejected')) throw new Error('EmrCleanupFailed');
    };
    try {
      await Promise.race([stop(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('EmrShutdownDeadline')), Math.max(0, deadline-Date.now()));
      })]);
    } finally { clearTimeout(timer); }
  }
}
