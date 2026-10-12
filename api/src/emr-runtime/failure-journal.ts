import { StateCoordinator } from './coordinator';
import { JournalKind, JournalRecord, JournalUnavailable } from './journal-file';
export { JOURNAL_MAX_BYTES, JOURNAL_KINDS, JOURNAL_CAUSES, JournalKind, JournalRecord, JournalUnavailable,
  protectedDirectory, syncDirectory } from './journal-file';

/** A failure observation as parseAuthFailureObservation returns it (stored verbatim; eventId and at are its keys). */
export type AuthenticationObservation = Readonly<Record<string, any>>;

/** The same fenced external writer owns journal and seal IO, including torn-tail recovery. */
export class FailureJournal {
  readonly coordinator: StateCoordinator;
  readonly tornBytes: number;
  /** Retention is always a client of the API's lifetime fence. If the API is
   * absent, construction fails after bounded retries; the job defers without
   * acquiring ownership or starting its deleting transaction. */
  static retention(directory: string): FailureJournal {
    return new FailureJournal(directory, new StateCoordinator(directory, undefined, 'retention'));
  }
  constructor(directory: string | undefined, coordinator?: StateCoordinator) {
    this.coordinator = coordinator ?? new StateCoordinator(directory);
    this.tornBytes = this.invoke('journal-load').tornBytes;
  }
  private static mapped(error: any): any {
    if (String(error?.code).startsWith('FailureJournal'))
      return Object.assign(new JournalUnavailable(error.code), error.detail ? { detail: error.detail } : {});
    return error;
  }
  private invoke(operation: string, value?: any): any {
    try { return this.coordinator.call(operation, value); }
    catch (error: any) { throw FailureJournal.mapped(error); }
  }
  private async invokeAsync(operation: string, value?: any): Promise<any> {
    try { return await this.coordinator.callAsync(operation, value); }
    catch (error: any) { throw FailureJournal.mapped(error); }
  }
  record(id: string, kind: JournalKind, body: Record<string, string | number>, at = new Date().toISOString()): Readonly<JournalRecord> {
    return this.invoke('journal-record', { id, kind, body, at });
  }
  all(): readonly Readonly<JournalRecord>[] { return this.invoke('journal-load').records; }
  find(id: string): Readonly<JournalRecord> | undefined { return this.invoke('journal-find', id); }

  // ── failed sign-ins (B2R2-01): the authentication spools, never this journal's lifetime capacity ──
  /** Durable when it resolves. The spool is chosen by the observation's verified identity (none: anonymous). */
  observeAuthenticationFailure(observation: AuthenticationObservation): Promise<Readonly<JournalRecord>> {
    return this.invokeAsync('auth-failure-observe', { id: `auth-failure:${observation.eventId}`,
      body: { observation: JSON.stringify(observation) }, at: observation.at });
  }
  /** After the event's durable receipt: completes the observation where it is stored. */
  completeAuthenticationFailure(eventId: string): Promise<Readonly<JournalRecord> | null> {
    return this.invokeAsync('auth-failure-complete', { eventId });
  }
  findAuthenticationRecord(id: string): Readonly<JournalRecord> | undefined { return this.invoke('auth-failure-find', id); }
  pendingAuthentication(): readonly Readonly<JournalRecord>[] { return this.invoke('auth-failure-pending'); }
  hasAuthenticationObservation(eventId: string): boolean { return !!this.findAuthenticationRecord(`auth-failure:${eventId}`); }
}
