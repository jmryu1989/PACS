import { StateCoordinator } from './coordinator';
import { JournalKind, JournalRecord, JournalUnavailable } from './journal-file';
export { JOURNAL_MAX_BYTES, JOURNAL_KINDS, JOURNAL_CAUSES, JournalKind, JournalRecord, JournalUnavailable,
  protectedDirectory, syncDirectory } from './journal-file';

/** The same fenced external writer owns journal and seal IO, including torn-tail recovery. */
export class FailureJournal {
  readonly coordinator: StateCoordinator;
  readonly tornBytes: number;
  constructor(directory: string | undefined, coordinator?: StateCoordinator) {
    this.coordinator = coordinator ?? new StateCoordinator(directory);
    this.tornBytes = this.invoke('journal-load').tornBytes;
  }
  private invoke(operation: string, value?: any): any {
    try { return this.coordinator.call(operation, value); }
    catch (error: any) {
      if (String(error.code).startsWith('FailureJournal')) throw new JournalUnavailable(error.code);
      throw error;
    }
  }
  record(id: string, kind: JournalKind, body: Record<string, string | number>, at = new Date().toISOString()): Readonly<JournalRecord> {
    return this.invoke('journal-record', { id, kind, body, at });
  }
  all(): readonly Readonly<JournalRecord>[] { return this.invoke('journal-load').records; }
  find(id: string): Readonly<JournalRecord> | undefined { return this.invoke('journal-find', id); }
}
