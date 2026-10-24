import type { ImmutableIdentity } from '../emr-contract/access-event';
import type { AttachmentReference } from '../emr-contract/signature';
import type { LifecycleCommand, ReportFacts } from '../emr-contract/report-lifecycle';
import type { SigningTransaction, RequestIdentity } from '../emr-signature/server-contract';
import type { StudyFacts } from './contract';
import type { StoredApproval } from './online-store';

export interface CurrentReport {
  study: StudyFacts;
  facts: ReportFacts;
  author: ImmutableIdentity;
  attachments: readonly AttachmentReference[];
}

/** Existing report/retention owner supplies this boundary, using the supplied transaction.
 * No second editor, report-state engine, patient-link registry or test storage exists in C2.
 */
export interface OnlineReportBoundary {
  /** Lock report, current patient link, assignment and retention basis; authorize current read access. */
  lock(tx: SigningTransaction, identity: RequestIdentity, recordId: string): Promise<CurrentReport>;
  /** Existing A lifecycle + retained-source checks (signedTransition) and source references. */
  validate(tx: SigningTransaction, current: CurrentReport, command: LifecycleCommand, approval: StoredApproval): Promise<void>;
  /** Append immutable version, update publication and clear only the submitted draft revision. */
  publish(tx: SigningTransaction, current: CurrentReport, command: LifecycleCommand, approval: StoredApproval,
    submittedDraftRevision: string | null): Promise<void>;
  /** Existing retained-read policy; result lookup must not escape current permissions or retention. */
  authorizeResult(tx: SigningTransaction, identity: RequestIdentity, approval: StoredApproval): Promise<void>;
}
