-- S7-U5 (U5S-REQ-14, U5S-REQ-18, U5S-REQ-09): the stored draft boundary and the login entry proof. Additive only:
-- no row is deleted and no existing column changes.
--
-- ReportDraft.revision / present: every existing draft is a present draft at its first revision (the column defaults).
--   A cleared, discarded or committed draft keeps its row with present = false and empty content, so its revision
--   survives; the CHECK keeps such a row empty whatever writes it.
-- StudyState."draftEpoch": gen_random_uuid() is volatile, so adding the column rewrites the table and gives every
--   existing state its own value; every later row gets a new one from the same default. No extension is needed
--   (PostgreSQL 13+ has it built in).
-- AuthSession entry proof: nullable, no backfill - a session that existed before this migration has no pending proof.
-- AuditLog is not touched, so its append-only guard (20260930120000) is not involved.
BEGIN;
ALTER TABLE "ReportDraft" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ReportDraft" ADD COLUMN "present" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ReportDraft" ADD CONSTRAINT "ReportDraft_revision_check" CHECK ("revision" >= 1);
ALTER TABLE "ReportDraft" ADD CONSTRAINT "ReportDraft_absent_check" CHECK ("present" OR (
  "findings" = '' AND "conclusion" = '' AND "recommendation" = '' AND "baseVersion" = 0
  AND "citations" IS NULL AND "structured" IS NULL));
ALTER TABLE "StudyState" ADD COLUMN "draftEpoch" UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "AuthSession" ADD COLUMN "entryProofHash" TEXT;
ALTER TABLE "AuthSession" ADD COLUMN "entryProofExpiresAt" TIMESTAMP(3);
COMMIT;
