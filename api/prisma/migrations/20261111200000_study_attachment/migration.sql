-- FC-076 Attach Document: a scanned document or PC picture (JPG, PNG, PDF) a member attaches to a study, stored by the
-- server in Orthanc as one new series of one instance (Secondary Capture or Encapsulated PDF). Additive only: one new
-- table, no backfill. The row is written before the Orthanc write (pending) with the SOP and series UIDs it will create,
-- so a lost answer or a failed database step is recovered by looking those UIDs up. A withdrawn attachment keeps its
-- original and history and is no longer served. The runtime role's table rights come from the EMR-B1 default privileges
-- of schema public.
BEGIN;
CREATE TABLE "StudyAttachment" (
    "id" UUID NOT NULL,
    "uid" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "createdBySub" TEXT NOT NULL,
    "sopInstanceUid" VARCHAR(64) NOT NULL,
    "seriesInstanceUid" VARCHAR(64) NOT NULL,
    "orthancId" TEXT,
    "objectStudyUid" TEXT,
    "objectSeriesUid" TEXT,
    "objectAt" TIMESTAMP(3),
    "kind" TEXT NOT NULL,
    "fileName" VARCHAR(255) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "failReason" TEXT,
    "access" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnBy" TEXT,
    "withdrawReason" VARCHAR(500),
    CONSTRAINT "StudyAttachment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StudyAttachment_kind_check" CHECK ("kind" IN ('image', 'pdf')),
    CONSTRAINT "StudyAttachment_state_check" CHECK ("state" IN ('pending', 'stored', 'failed', 'withdrawn')),
    CONSTRAINT "StudyAttachment_bytes_check" CHECK ("bytes" BETWEEN 1 AND 20971520),
    CONSTRAINT "StudyAttachment_withdrawn_check" CHECK (("state" = 'withdrawn') = ("withdrawnAt" IS NOT NULL
        AND "withdrawnBy" IS NOT NULL AND "withdrawReason" IS NOT NULL))
);
CREATE UNIQUE INDEX "StudyAttachment_sopInstanceUid_key" ON "StudyAttachment"("sopInstanceUid");
CREATE UNIQUE INDEX "StudyAttachment_seriesInstanceUid_key" ON "StudyAttachment"("seriesInstanceUid");
CREATE UNIQUE INDEX "StudyAttachment_createdBySub_requestId_key" ON "StudyAttachment"("createdBySub", "requestId");
CREATE INDEX "StudyAttachment_uid_idx" ON "StudyAttachment"("uid");
CREATE INDEX "StudyAttachment_objectStudyUid_idx" ON "StudyAttachment"("objectStudyUid");
COMMIT;
