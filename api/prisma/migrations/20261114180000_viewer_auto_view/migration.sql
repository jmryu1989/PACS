-- Auto Save View: a reader's own last view of a study, saved automatically while the account setting is on and put back
-- when the study is opened again. Additive only: one new table, no backfill. One row per reader and study (written over
-- by each save; Discard Saved View empties it and the row keeps the order of the saves: each viewer's last count in
-- writers, the time of the last Discard in discardedAt). It is not a Job and is never listed with the Jobs. The view is
-- kept as JSON text so its numbers read back exactly as written. The runtime role's table rights come from the EMR-B1
-- default privileges of schema public.
BEGIN;
CREATE TABLE "ViewerAutoView" (
    "id" UUID NOT NULL,
    "studyUid" TEXT NOT NULL,
    "authorSub" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "studies" TEXT[] NOT NULL,
    "snapshot" TEXT,
    "writers" JSONB NOT NULL,
    "discardedAt" BIGINT,
    "revision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ViewerAutoView_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ViewerAutoView_bounds" CHECK (cardinality("studies") BETWEEN 1 AND 8 AND array_position("studies", NULL) IS NULL
        AND "studies"[1] = "studyUid" AND "revision" >= 1 AND octet_length("snapshot") <= 32768
        AND ("snapshot" IS NOT NULL OR "discardedAt" IS NOT NULL) AND jsonb_typeof("writers") = 'array' AND jsonb_array_length("writers") <= 32)
);
CREATE UNIQUE INDEX "ViewerAutoView_authorSub_studyUid_key" ON "ViewerAutoView"("authorSub", "studyUid");
CREATE INDEX "ViewerAutoView_studyUid_idx" ON "ViewerAutoView"("studyUid");
COMMIT;
