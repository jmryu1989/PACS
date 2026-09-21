-- Additive only, and for the same reason the citations columns were: the row that already holds the
-- sentence gains the typed values that produced it, so a sentence and its structured evidence are
-- written by one statement and can never drift apart. No mirror on "Report" and no linking table -
-- the institution, preliminary, RS and append-only guarantees of these two rows are the ones we want.
-- NULL is the old behaviour (no structured entry) and stays legal forever: an application that never
-- writes the column keeps working, and a row created before this migration is not rewritten. The
-- service never writes an empty array - it omits the column - so "no entries" has exactly one shape.
-- The bound is the canonical PostgreSQL jsonb text form measured in UTF-8 bytes - the same measure the
-- service asks the database for before it writes, never a shorter JS serialization, otherwise the
-- service would accept what this CHECK refuses and the refusal would surface as a 500.
BEGIN;
ALTER TABLE "ReportDraft" ADD COLUMN "structured" JSONB;
ALTER TABLE "ReportVersion" ADD COLUMN "structured" JSONB;
-- A CHECK accepts UNKNOWN, so allowing NULL has to be said out loud; the CASE measures only a proven
-- array (a scalar never raises in place of a check violation) and IS TRUE demands a definite true.
ALTER TABLE "ReportDraft" ADD CONSTRAINT "ReportDraft_structured_check" CHECK ("structured" IS NULL OR (CASE WHEN jsonb_typeof("structured") = 'array' THEN jsonb_array_length("structured") <= 64 AND octet_length(convert_to("structured"::text, 'UTF8')) <= 65536 ELSE false END) IS TRUE);
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_structured_check" CHECK ("structured" IS NULL OR (CASE WHEN jsonb_typeof("structured") = 'array' THEN jsonb_array_length("structured") <= 64 AND octet_length(convert_to("structured"::text, 'UTF8')) <= 65536 ELSE false END) IS TRUE);
COMMIT;
