-- Additive only: the report row that already holds the text gains the citations that attest it, so a
-- sentence and its attestation are written by one statement and can never drift apart. No mirror on
-- "Report" and no linking table: the institution, preliminary, RS and append-only guarantees of these
-- two rows are the ones we want, and a new table would have to redefine every one of them.
-- NULL is the old behaviour (no citations) and stays legal forever: an application that never writes
-- the column keeps working, and a row created before this migration is not rewritten.
-- The bound is the canonical PostgreSQL jsonb text form measured in UTF-8 bytes - the same measure the
-- service asks the database for before it writes (finding.service.ts), never a shorter JS serialization,
-- otherwise the service would accept what this CHECK refuses and the refusal would surface as a 500.
BEGIN;
ALTER TABLE "ReportDraft" ADD COLUMN "citations" JSONB;
ALTER TABLE "ReportVersion" ADD COLUMN "citations" JSONB;
-- A CHECK accepts UNKNOWN, so allowing NULL has to be said out loud; the CASE measures only a proven
-- array (a scalar never raises in place of a check violation) and IS TRUE demands a definite true.
ALTER TABLE "ReportDraft" ADD CONSTRAINT "ReportDraft_citations_check" CHECK ("citations" IS NULL OR (CASE WHEN jsonb_typeof("citations") = 'array' THEN jsonb_array_length("citations") <= 64 AND octet_length(convert_to("citations"::text, 'UTF8')) <= 65536 ELSE false END) IS TRUE);
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_citations_check" CHECK ("citations" IS NULL OR (CASE WHEN jsonb_typeof("citations") = 'array' THEN jsonb_array_length("citations") <= 64 AND octet_length(convert_to("citations"::text, 'UTF8')) <= 65536 ELSE false END) IS TRUE);
COMMIT;
