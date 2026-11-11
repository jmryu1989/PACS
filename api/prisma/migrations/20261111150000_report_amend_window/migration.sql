-- FC-034 (A1, receiving side): the 24-hour amend window after an approval. The current approval round's facts as columns
-- of StudyState, written in the same transaction as the report version they come from (report-commit.ts): when it was
-- approved and by whom (the approver's fixed subject), when it was last amended, and when an Addendum was first attached
-- after it. The signed versions and their history stay the record; these four are the lookup values of the current round.
-- Finalized is not stored: it is read as approvedAt + 24 hours.
--
-- Backfill, approved (rs 'A') rows only. The round's approval is the uid's latest 'approve' version; approvedBySub is the
-- subject of the doctor key that signed that version (emr_signing.signed_version), NULL when it cannot be read there;
-- addendumAt is the latest 'addendum' version after that approval. amendedAt stays NULL (no amend existed before this).
-- A value that cannot be confirmed stays NULL - an approved report without approvedAt is never called Finalized and is
-- amended only by an Addendum.
--
-- A signed amend ends its author's draft purpose with that action, so the purpose-end intent also accepts 'amend' (the
-- purpose contract already names it: emr-contract/lawful-defaults.ts). A live draft's own intent is unchanged.
BEGIN;
ALTER TABLE "StudyState"
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "approvedBySub" TEXT,
  ADD COLUMN "amendedAt" TIMESTAMP(3),
  ADD COLUMN "addendumAt" TIMESTAMP(3);

WITH approval AS (
  SELECT DISTINCT ON (v.uid) v.uid, v.version, v.at
  FROM "ReportVersion" v JOIN "StudyState" s ON s.uid = v.uid
  WHERE s.rs = 'A' AND v.action = 'approve'
  ORDER BY v.uid, v.version DESC)
UPDATE "StudyState" s SET
  "approvedAt" = a.at,
  "approvedBySub" = (SELECT NULLIF(sv.outcome->'keyAtSigning'->'doctor'->'identity'->>'subject', '')
    FROM emr_signing.signed_version sv WHERE sv.record_id = a.uid AND sv.version_id = a.version::text),
  "addendumAt" = (SELECT max(d.at) FROM "ReportVersion" d
    WHERE d.uid = a.uid AND d.action = 'addendum' AND d.version > a.version)
FROM approval a
WHERE s.uid = a.uid AND s.rs = 'A';

ALTER TABLE "ReportDraftPurposeEnd" DROP CONSTRAINT "ReportDraftPurposeEnd_intent_check";
ALTER TABLE "ReportDraftPurposeEnd" ADD CONSTRAINT "ReportDraftPurposeEnd_intent_check"
  CHECK ("workIntent" IN ('approve', 'addendum', 'amend'));
COMMIT;
