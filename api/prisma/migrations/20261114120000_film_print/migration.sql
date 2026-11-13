-- Film / DICOM Print: a registered peer gets a kind (`store`: another PACS or modality, as before; `printer`: a DICOM
-- film printer, never searched or pulled from) and a printer's film sizes; every existing peer stays `store`. One new
-- table, no backfill: each film printed or layout image sent is one job row, written before anything is sent (the
-- output record) and ended with the answer of the other side. The runtime role's table rights come from the EMR-B1
-- default privileges of schema public.
BEGIN;
ALTER TABLE "DicomPeer" ADD COLUMN "kind" VARCHAR(16) NOT NULL DEFAULT 'store';
ALTER TABLE "DicomPeer" ADD COLUMN "filmSizes" VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE "DicomPeer" ADD CONSTRAINT "DicomPeer_kind_check" CHECK ("kind" IN ('store', 'printer'));
CREATE TABLE "FilmPrintJob" (
    "id" UUID NOT NULL,
    "institutionId" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "createdBySub" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "studyUid" TEXT NOT NULL,
    "seriesUid" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "peerId" UUID NOT NULL,
    "peerName" VARCHAR(64) NOT NULL,
    "peerAet" VARCHAR(16) NOT NULL,
    "layout" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'sending',
    "events" JSONB NOT NULL,
    "reason" TEXT,
    "warnings" JSONB NOT NULL,
    "printJobUid" VARCHAR(64),
    "outputSeriesUid" VARCHAR(64),
    "outputSopUid" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    CONSTRAINT "FilmPrintJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FilmPrintJob_destination_check" CHECK ("destination" IN ('printer', 'device')),
    CONSTRAINT "FilmPrintJob_state_check" CHECK ("state" IN ('sending', 'sent', 'printed', 'sent-unreported', 'no-answer', 'failed', 'stored'))
);
CREATE UNIQUE INDEX "FilmPrintJob_createdBySub_requestId_key" ON "FilmPrintJob"("createdBySub", "requestId");
CREATE INDEX "FilmPrintJob_institutionId_createdAt_idx" ON "FilmPrintJob"("institutionId", "createdAt");
CREATE INDEX "FilmPrintJob_studyUid_idx" ON "FilmPrintJob"("studyUid");
COMMIT;
