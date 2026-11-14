-- Image Report: drawings on a breast or thyroid diagram or on a saved key image, attached to the report. Additive only:
-- one new table of immutable drawing rows and a nullable id list on the private draft, the report version and the ended
-- draft work. No backfill: NULL means no drawing, so every existing row reads as before. The runtime role's table rights
-- come from the EMR-B1 default privileges of schema public.
BEGIN;
CREATE TABLE "ReportDrawing" (
    "id" UUID NOT NULL,
    "studyUid" TEXT NOT NULL,
    "authorSub" TEXT NOT NULL,
    "authorActor" TEXT NOT NULL,
    "background" TEXT NOT NULL,
    "source" JSONB,
    "strokes" JSONB NOT NULL,
    "png" BYTEA NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReportDrawing_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReportDrawing_background_check" CHECK ("background" IN ('breast', 'thyroid', 'image')),
    CONSTRAINT "ReportDrawing_source_check" CHECK (("background" = 'image') = ("source" IS NOT NULL)),
    CONSTRAINT "ReportDrawing_size_check" CHECK ("width" BETWEEN 1 AND 1200 AND "height" BETWEEN 1 AND 900
        AND octet_length("png") BETWEEN 1 AND 1200000 AND octet_length("strokes"::text) <= 262144)
);
CREATE INDEX "ReportDrawing_studyUid_idx" ON "ReportDrawing"("studyUid");
ALTER TABLE "ReportDraft" ADD COLUMN "drawings" JSONB;
ALTER TABLE "ReportVersion" ADD COLUMN "drawings" JSONB;
ALTER TABLE "ReportDraftPurposeEnd" ADD COLUMN "drawings" JSONB;
COMMIT;
