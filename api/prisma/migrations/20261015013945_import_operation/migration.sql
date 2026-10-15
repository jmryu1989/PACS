-- S9-U4b (contract S9-U4p 4.4, 5.2, 7): one table for the self-institution DICOM import and original download operations
-- and for the member import gate's internal Study/SOP reservations. Additive only: no existing table, row or migration changes.
--   import       a member's import operation: results = per-file UIDs/hash/outcome with append-only attempts, studyUid NULL
--                (one operation may carry files of several studies), no manifest, no claim.
--   download     a member's original download: the immutable target study, the stored canonical manifest text in download
--                with its SHA-256, the download attempts; results stay empty.
--   study-claim  the gate's reservation of one Study UID (claimKey 'study:<uid>'), owned by the gate, never a member's.
--   sop-claim    the gate's reservation of one SOP Instance UID (claimKey 'sop:<uid>'), studyUid = the SOP's study.
-- The kind/required-null combinations below are closed here; the JSON inside is validated by the server. A claim row holds
-- patient identity values; it is deleted only by the study's original-disposal hook (disposeImportClaims), never by time.
CREATE TABLE "ImportOperation" (
    "id" UUID NOT NULL,
    "institutionId" VARCHAR(256) NOT NULL,
    "ownerIssuer" VARCHAR(1024) NOT NULL,
    "ownerSubject" VARCHAR(256) NOT NULL,
    "actor" VARCHAR(256) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "studyUid" VARCHAR(64),
    "status" VARCHAR(16) NOT NULL,
    "results" JSONB NOT NULL DEFAULT '[]',
    "manifestSha256" VARCHAR(64),
    "download" JSONB,
    "claimKey" TEXT,
    "claim" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportOperation_pkey" PRIMARY KEY ("id"),
    -- Owner fields are never empty; only the gate's own reservations carry the internal owner, and a member row never can.
    CONSTRAINT "ImportOperation_owner_check" CHECK (
        length("institutionId") > 0 AND length("ownerIssuer") > 0 AND length("ownerSubject") > 0 AND length("actor") > 0
        AND (("kind" IN ('study-claim', 'sop-claim'))
             = ("ownerIssuer" = 'kin-internal' AND "ownerSubject" = 'dicom-import-gate' AND "actor" = 'dicom-import-gate'))
        AND ("studyUid" IS NULL OR ("studyUid" ~ '^[0-9]+(\.[0-9]+)*$' AND length("studyUid") <= 64))),
    -- One closed shape per kind (contract 4.4 table): status values, which columns are required and which stay NULL.
    -- A CHECK passes when its expression is NULL, so every required column is tested IS NOT NULL before its value (a NULL
    -- manifest, download, claim key or claim makes its branch false, never unknown), and the whole expression is COALESCEd
    -- to false as well. SQL NULL and JSON null stay distinct: a required-NULL column holding JSON null is not NULL, and a
    -- JSON null where an object is required is not an object.
    CONSTRAINT "ImportOperation_kind_check" CHECK (COALESCE(
        ("kind" = 'import' AND "status" IN ('open', 'settled') AND "studyUid" IS NULL
            AND CASE WHEN jsonb_typeof("results") = 'array' THEN jsonb_array_length("results") <= 100 ELSE false END
            AND "manifestSha256" IS NULL AND "download" IS NULL AND "claimKey" IS NULL AND "claim" IS NULL)
        OR ("kind" = 'download' AND "status" IN ('prepared', 'sending', 'sent', 'incomplete', 'unconfirmed')
            AND "studyUid" IS NOT NULL AND "results" = '[]'::jsonb
            AND "manifestSha256" IS NOT NULL AND "manifestSha256" ~ '^[0-9a-f]{64}$'
            AND "download" IS NOT NULL AND jsonb_typeof("download") = 'object'
            AND "claimKey" IS NULL AND "claim" IS NULL)
        OR ("kind" = 'study-claim' AND "status" = 'reserved' AND "studyUid" IS NOT NULL AND "results" = '[]'::jsonb
            AND "manifestSha256" IS NULL AND "download" IS NULL
            AND "claimKey" IS NOT NULL AND "claimKey" = ('study:' || "studyUid")
            AND "claim" IS NOT NULL AND jsonb_typeof("claim") = 'object')
        OR ("kind" = 'sop-claim' AND "status" = 'reserved' AND "studyUid" IS NOT NULL AND "results" = '[]'::jsonb
            AND "manifestSha256" IS NULL AND "download" IS NULL
            AND "claimKey" IS NOT NULL AND "claimKey" ~ '^sop:[0-9]+(\.[0-9]+)*$' AND length("claimKey") <= 68
            AND "claim" IS NOT NULL AND jsonb_typeof("claim") = 'object'),
        false))
);

-- NULL for every member operation (any number of them); one row per exact reservation text, refused by the database.
CREATE UNIQUE INDEX "ImportOperation_claimKey_key" ON "ImportOperation"("claimKey");
CREATE INDEX "ImportOperation_kind_status_idx" ON "ImportOperation"("kind", "status");
CREATE INDEX "ImportOperation_kind_studyUid_idx" ON "ImportOperation"("kind", "studyUid");

-- Readiness (contract 4.5, fact 1): member import routes answer only after this migration finished and was not rolled back.
-- The runtime role of EMR-B1 has no right on the migration history; it gets SELECT on exactly the three columns that fact
-- reads (no checksum, no log), so the check works for the role production runs as. Guarded like EMR-B1's revoke: a restore
-- rehearsal that applies the migration files without Prisma has no history table, and a database without the EMR roles
-- (before EMR-B1 provisioning) has no runtime role.
DO $$ BEGIN
  IF pg_catalog.to_regclass('public._prisma_migrations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kin_runtime') THEN
    EXECUTE 'GRANT SELECT (migration_name, finished_at, rolled_back_at) ON public._prisma_migrations TO kin_runtime';
  END IF;
END $$;
