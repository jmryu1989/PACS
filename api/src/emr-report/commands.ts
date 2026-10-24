import type { ReportFacts } from '../emr-contract/report-lifecycle';
import type { VersionReference } from '../emr-contract/signature';

/** The retained predecessor signed by the online approval command. */
export function expectedPreviousVersion(facts: ReportFacts, action: 'approve' | 'amend' | 'addendum' | 'cancel'): VersionReference | null {
  if (action === 'amend') return facts.bodyVersion;
  if (action === 'addendum' || action === 'cancel') return facts.publishedVersion;
  const last = facts.contentHistory[facts.contentHistory.length - 1];
  return last ? last.version : null;
}
