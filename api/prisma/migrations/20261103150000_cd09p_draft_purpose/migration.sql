-- CD-09-P: a private draft work's identity, the end of its purpose, and the database's reference to the external
-- destruction ledger. Additive: no row is deleted and no existing value changes.
--
-- ReportDraft.workUnit / workSince / workIntent: the live work a present row holds. A present draft that exists when this
--   migration runs gets its own unit now; its true start is unknown, so workSince is the time this migration first
--   observed the work, never a value derived from updatedAt. Its intent is the result its next commit can make of the
--   study's current report (an Addendum to an approved report, otherwise an approval). A present=false row holds no work.
-- ReportDraftPurposeEnd: the exact payload of an ended work until its destruction transaction deletes the row. Its
--   disposalUnitId is the only identifier the external ledger carries.
-- PurposeLedgerAnchor: one row naming the external ledger this database belongs to, drawn here (seq 0: nothing
--   destroyed yet) and moved forward by each completed destruction. The ledger file adopts this ID when it is first
--   written. A copy restored from before this migration gets a new ID from this statement, so it can never be taken for
--   the copy an existing ledger belongs to: its drafts carry no unit the ledger names.
BEGIN;
ALTER TABLE "ReportDraft" ADD COLUMN "workUnit" TEXT;
ALTER TABLE "ReportDraft" ADD COLUMN "workSince" TIMESTAMP(3);
ALTER TABLE "ReportDraft" ADD COLUMN "workIntent" TEXT;
UPDATE "ReportDraft" d SET "workUnit" = 'disposal:' || gen_random_uuid()::text,
  "workSince" = (now() AT TIME ZONE 'UTC'),
  "workIntent" = CASE WHEN EXISTS (SELECT 1 FROM "StudyState" s WHERE s.uid = d.uid AND s.rs = 'A') THEN 'addendum' ELSE 'approve' END
  WHERE d."present";
ALTER TABLE "ReportDraft" ADD CONSTRAINT "ReportDraft_work_check" CHECK (
  ("present" AND "workUnit" IS NOT NULL AND "workSince" IS NOT NULL AND "workIntent" IN ('approve', 'addendum'))
  OR (NOT "present" AND "workUnit" IS NULL AND "workSince" IS NULL AND "workIntent" IS NULL));
ALTER TABLE "ReportDraft" ADD CONSTRAINT "ReportDraft_workUnit_check" CHECK ("workUnit" IS NULL OR
  "workUnit" ~ '^disposal:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
CREATE UNIQUE INDEX "ReportDraft_workUnit_key" ON "ReportDraft"("workUnit");

CREATE TABLE "ReportDraftPurposeEnd" (
  "disposalUnitId" TEXT NOT NULL,
  "uid" TEXT NOT NULL,
  "author" TEXT NOT NULL,
  "workSince" TIMESTAMP(3) NOT NULL,
  "workIntent" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "eventId" UUID NOT NULL,
  "actorId" TEXT NOT NULL,
  "endedAt" TIMESTAMP(3) NOT NULL,
  "signedRecordId" TEXT,
  "signedVersionId" TEXT,
  "findings" TEXT NOT NULL,
  "conclusion" TEXT NOT NULL,
  "recommendation" TEXT NOT NULL,
  "baseVersion" INTEGER NOT NULL,
  "citations" JSONB,
  "structured" JSONB,
  "deliverySettled" BOOLEAN NOT NULL DEFAULT false,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastRefusal" TEXT,
  CONSTRAINT "ReportDraftPurposeEnd_pkey" PRIMARY KEY ("disposalUnitId"),
  CONSTRAINT "ReportDraftPurposeEnd_unit_check" CHECK (
    "disposalUnitId" ~ '^disposal:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "ReportDraftPurposeEnd_intent_check" CHECK ("workIntent" IN ('approve', 'addendum')),
  -- Only the author's own discard and a result version signed from the work end its purpose here. A signed end names
  -- the exact signed version; an explicit discard names none.
  CONSTRAINT "ReportDraftPurposeEnd_trigger_check" CHECK (
    ("trigger" = 'result-version-signed' AND "signedRecordId" IS NOT NULL AND "signedVersionId" IS NOT NULL AND "actorId" = "author")
    OR ("trigger" = 'explicit-discard' AND "signedRecordId" IS NULL AND "signedVersionId" IS NULL AND "actorId" = "author")),
  CONSTRAINT "ReportDraftPurposeEnd_order_check" CHECK ("endedAt" > "workSince"),
  CONSTRAINT "ReportDraftPurposeEnd_attempts_check" CHECK ("attempts" >= 0)
);
CREATE INDEX "ReportDraftPurposeEnd_uid_author_idx" ON "ReportDraftPurposeEnd"("uid", "author");

CREATE TABLE "PurposeLedgerAnchor" (
  "id" INTEGER NOT NULL,
  "ledgerId" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  CONSTRAINT "PurposeLedgerAnchor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurposeLedgerAnchor_one_check" CHECK ("id" = 1),
  CONSTRAINT "PurposeLedgerAnchor_seq_check" CHECK ("seq" >= 0)
);
INSERT INTO "PurposeLedgerAnchor" ("id", "ledgerId", "seq") VALUES (1, gen_random_uuid(), 0);
COMMIT;
