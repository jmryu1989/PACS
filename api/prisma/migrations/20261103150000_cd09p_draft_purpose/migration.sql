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

-- initialized: the ledger file exists for this database. It is set (with the file written first) before the first work
--   unit this database hands out through the server, or at the first start that finds works this migration numbered. A
--   copy with initialized=true and no ledger beside it is a copy whose later destructions are unknown: the server stays
--   closed. A copy with initialized=false never held a work the ledger could have destroyed.
-- lastCompletedUnit / lastCompletedAt: the destruction whose committed deletion moved seq to its value, and when it
--   completed. The ledger's completed record is written only after that commit; if the process stops between the two,
--   the next start writes it from these facts (the original completion time, never a new one).
CREATE TABLE "PurposeLedgerAnchor" (
  "id" INTEGER NOT NULL,
  "ledgerId" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "initialized" BOOLEAN NOT NULL DEFAULT false,
  "lastCompletedUnit" TEXT,
  "lastCompletedAt" TIMESTAMP(3),
  CONSTRAINT "PurposeLedgerAnchor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurposeLedgerAnchor_one_check" CHECK ("id" = 1),
  CONSTRAINT "PurposeLedgerAnchor_seq_check" CHECK ("seq" >= 0),
  CONSTRAINT "PurposeLedgerAnchor_completion_check" CHECK (("lastCompletedUnit" IS NULL) = ("lastCompletedAt" IS NULL)
    AND ("lastCompletedUnit" IS NULL OR ("seq" > 0 AND "initialized"
      AND "lastCompletedUnit" ~ '^disposal:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')))
);
INSERT INTO "PurposeLedgerAnchor" ("id", "ledgerId", "seq") VALUES (1, gen_random_uuid(), 0);

-- A hold placed on a record and the destruction of that record's ended private draft work take the same per-record
-- transaction lock: the destruction reads the record's holds only after any placement in flight has committed, and a
-- placement that starts after the destruction read them waits for its commit. Same body as EMR-B's place_hold plus
-- that lock; the grants on the function stay as they were.
CREATE OR REPLACE FUNCTION emr_access.place_hold(p_hold_id text, p_record_id text, p_body text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE doc json := emr_access.append_fact_checked(p_body, ARRAY['holdId', 'recordId', 'basis', 'actorId', 'at', 'release']); existing text;
BEGIN
  PERFORM emr_access.require_placement();
  PERFORM pg_advisory_xact_lock(hashtextextended('kin-hold:' || p_record_id, 0));
  IF doc ->> 'holdId' IS DISTINCT FROM p_hold_id OR doc ->> 'recordId' IS DISTINCT FROM p_record_id OR json_typeof(doc -> 'release') <> 'null' THEN
    RAISE EXCEPTION 'DutyFactInvalid' USING ERRCODE = 'EB003';
  END IF;
  SELECT body INTO existing FROM emr_access.legal_hold_event WHERE hold_id = p_hold_id AND phase = 'placed';
  IF FOUND THEN
    IF existing = p_body THEN RETURN; END IF;
    RAISE EXCEPTION 'HoldConflict' USING ERRCODE = 'EB002';
  END IF;
  INSERT INTO emr_access.legal_hold_event (hold_id, phase, record_id, body, recorded_at) VALUES (p_hold_id, 'placed', p_record_id, p_body, clock_timestamp());
END
$$;
COMMIT;
