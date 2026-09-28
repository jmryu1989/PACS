-- S7-U3a (D-S7-09 a): a tele receiving institution keeps its own advisory reader assignment beside the owner's, so the
-- row key becomes (studyUid, institutionId). Every existing row was written by its study's owner, the only institution
-- the service let assign, and keeps its key values, institution, revision and reader: nothing is backfilled, rewritten
-- or deleted, and the old key (studyUid) was unique, so the new one is too.
-- closedRevision / closedAt: the service closes a receiver's row in the transaction that takes its tele channel away and
-- never deletes it. closedAt is set while the row is closed; closedRevision is the revision the last close gave the row
-- and stays after the receiver writes again, as the floor of the history the row shows. Both stay NULL on every
-- existing row. The CHECK is non-NULL for any row (each nullable column is tested with IS NULL first), so it never
-- passes on UNKNOWN.
BEGIN;
ALTER TABLE "ReaderAssignment" ADD COLUMN "closedRevision" INTEGER, ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "ReaderAssignment" DROP CONSTRAINT "ReaderAssignment_pkey";
ALTER TABLE "ReaderAssignment" ADD CONSTRAINT "ReaderAssignment_pkey" PRIMARY KEY ("studyUid", "institutionId");
-- A close revision is one the row has reached; a closed row carries exactly that revision and names no reader.
ALTER TABLE "ReaderAssignment" ADD CONSTRAINT "ReaderAssignment_closed_check" CHECK (
  ("closedRevision" IS NULL OR ("closedRevision" > 0 AND "closedRevision" <= "revision"))
  AND ("closedAt" IS NULL OR ("closedRevision" IS NOT NULL AND "closedRevision" = "revision"
    AND "readerSub" IS NULL AND "readerActor" IS NULL AND "readerName" IS NULL)));
COMMIT;
