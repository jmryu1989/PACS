-- FA-090 EMR Link: one institution setting, the hospital EMR's web address template the worklist's Open EMR fills with the
-- row's patient ID, accession number or Study Instance UID. The administrator of that institution sets or clears it
-- (PUT /api/admin/emr-link). Additive only: one nullable column, no backfill (NULL = not set). No CHECK, index, key or grant
-- changes (the runtime's table grants cover new columns).
BEGIN;
ALTER TABLE "Institution" ADD COLUMN "emrLinkTemplate" VARCHAR(2000);
COMMIT;
