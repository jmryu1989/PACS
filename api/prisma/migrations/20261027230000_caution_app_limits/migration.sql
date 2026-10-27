-- Remove lifetime quotas without deleting heads, revisions, receipts or access records.
BEGIN;
ALTER TABLE "ViewerStorageBudget" DROP CONSTRAINT "ViewerStorageBudget_limit_check";
ALTER TABLE "ViewerStorageBudget" ADD CONSTRAINT "ViewerStorageBudget_limit_check"
  CHECK ("itemCount" >= 0 AND "revisionCount" >= 0 AND "payloadBytes" >= 0);
ALTER TABLE "Finding" DROP CONSTRAINT "Finding_revision_check";
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_revision_check" CHECK ("revision" > 0);
ALTER TABLE "FindingRevision" DROP CONSTRAINT "FindingRevision_revision_check";
ALTER TABLE "FindingRevision" ADD CONSTRAINT "FindingRevision_revision_check" CHECK ("revision" > 0);
ALTER TABLE "Finding" DROP CONSTRAINT "Finding_snapshot_check";
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_snapshot_check" CHECK ((CASE
  WHEN jsonb_typeof("snapshot") = 'object' AND jsonb_typeof("snapshot"->'sources') = 'array'
  THEN jsonb_array_length("snapshot"->'sources') >= 1 AND octet_length(convert_to("snapshot"::text, 'UTF8')) <= 65536
  ELSE false END) IS TRUE);
ALTER TABLE "FindingRevision" DROP CONSTRAINT "FindingRevision_snapshot_check";
ALTER TABLE "FindingRevision" ADD CONSTRAINT "FindingRevision_snapshot_check" CHECK ((CASE
  WHEN jsonb_typeof("snapshot") = 'object' AND jsonb_typeof("snapshot"->'sources') = 'array'
  THEN jsonb_array_length("snapshot"->'sources') >= 1 ELSE false END) IS TRUE);
ALTER TABLE "ViewerJob" DROP CONSTRAINT "ViewerJob_bounds";
ALTER TABLE "ViewerJob" ADD CONSTRAINT "ViewerJob_bounds" CHECK (
  cardinality("studies") BETWEEN 1 AND 2 AND array_position("studies", NULL) IS NULL
  AND "studies"[1] = "studyUid" AND (cardinality("studies") = 1 OR "studies"[1] <> "studies"[2])
  AND "revision" > 0 AND octet_length("snapshot"::text) <= 20000);
ALTER TABLE "ViewerJobRevision" DROP CONSTRAINT "ViewerJobRevision_bounds";
ALTER TABLE "ViewerJobRevision" ADD CONSTRAINT "ViewerJobRevision_bounds" CHECK ("revision" > 0);
ALTER TABLE "StudyQuestion" DROP CONSTRAINT "StudyQuestion_revision_check";
ALTER TABLE "StudyQuestion" ADD CONSTRAINT "StudyQuestion_revision_check"
  CHECK ("revision" > 0 AND "entryCount" >= 1 AND "revision" = "entryCount");
ALTER TABLE "StudyQuestionEntry" DROP CONSTRAINT "StudyQuestionEntry_seq_check";
ALTER TABLE "StudyQuestionEntry" ADD CONSTRAINT "StudyQuestionEntry_seq_check" CHECK (
  "seq" >= 1 AND "appliedRevision" = "seq" AND ("kind"::text = 'question'::text) = ("seq" = 1)
  AND ("seq" = 1) = ("id" = "questionId"));
ALTER TABLE "StudyImageRequest" DROP CONSTRAINT "StudyImageRequest_text_check";
ALTER TABLE "StudyImageRequest" ADD CONSTRAINT "StudyImageRequest_text_check" CHECK (
  length("counterpartyText") > 0 AND length("reason") > 0
  AND ("note" IS NULL OR length("note") > 0 OR "state"::text = 'Cancelled'::text));
ALTER TABLE "TechNoteRevision" ALTER COLUMN "text" TYPE TEXT;
ALTER TABLE "StudyConsultation" ALTER COLUMN "reason" TYPE TEXT,
  ALTER COLUMN "reply" TYPE TEXT, ALTER COLUMN "cancelReason" TYPE TEXT;
ALTER TABLE "StudyQuestionEntry" ALTER COLUMN "body" TYPE TEXT;
COMMIT;
