-- CD-09-D: the destruction of a native report whose statutory retention ended. Additive except that a later destruction
-- deletes rows; no existing value changes here.
--
-- StudyState.reportUnit: the opaque disposal unit of the study's report (the only identifier the external report
--   retention ledger carries). Every study row gets its own now, and a new row gets one from the default, so every
--   backup taken after this migration maps each report to the unit a ledger may name. The destruction sets rs = 'D' and
--   empties the unit in the same transaction that deletes the report: the mapping goes with the content. A backup taken
--   before this migration has no unit; this migration run again on it draws new ones (and a new anchor ID below), so it
--   can never be matched with a ledger written after it - the runbook keeps such a backup out of restore.
-- ReportLedgerAnchor: the database's position in the external report retention ledger (the CD-09-P anchor's shape):
--   one row, its ID drawn here, seq 0, not initialized. The server's first start after this migration writes the ledger
--   header under this ID and sets initialized; from then on a copy of this database does not open without that ledger.
-- emr_signing.destroy_report_signatures: the runtime has no DELETE on the signing tables (20261023200000). This one
--   function deletes a report's signature and signing-operation rows, and only inside a destruction that already marked
--   the study destroyed and deleted its report and versions; otherwise it refuses and the transaction rolls back.
-- emr_signing.report_order_referenced: whether any stored order fact names the study (the runtime reads order facts only
--   by their own record ID). A referenced report is kept.
BEGIN;
ALTER TABLE "StudyState" ADD COLUMN "reportUnit" TEXT DEFAULT ('disposal:'::text || (gen_random_uuid())::text);
UPDATE "StudyState" SET "reportUnit" = 'disposal:' || gen_random_uuid()::text WHERE "reportUnit" IS NULL;
ALTER TABLE "StudyState" ADD CONSTRAINT "StudyState_reportUnit_check" CHECK ("reportUnit" IS NULL OR
  "reportUnit" ~ '^disposal:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
-- Only a destroyed report has no unit, and a destroyed report never gets one back.
ALTER TABLE "StudyState" ADD CONSTRAINT "StudyState_reportUnit_destroyed_check" CHECK (("rs" = 'D') = ("reportUnit" IS NULL));
CREATE UNIQUE INDEX "StudyState_reportUnit_key" ON "StudyState"("reportUnit");

CREATE TABLE "ReportLedgerAnchor" (
  "id" INTEGER NOT NULL,
  "ledgerId" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "initialized" BOOLEAN NOT NULL DEFAULT false,
  "lastCompletedUnit" TEXT,
  "lastCompletedAt" TIMESTAMP(3),
  CONSTRAINT "ReportLedgerAnchor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReportLedgerAnchor_one_check" CHECK ("id" = 1),
  CONSTRAINT "ReportLedgerAnchor_seq_check" CHECK ("seq" >= 0),
  CONSTRAINT "ReportLedgerAnchor_completion_check" CHECK (("lastCompletedUnit" IS NULL) = ("lastCompletedAt" IS NULL)
    AND ("lastCompletedUnit" IS NULL OR ("seq" > 0 AND "initialized"
      AND "lastCompletedUnit" ~ '^disposal:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')))
);
INSERT INTO "ReportLedgerAnchor" ("id", "ledgerId", "seq") VALUES (1, gen_random_uuid(), 0);

CREATE FUNCTION emr_signing.destroy_report_signatures(p_uid text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE removed integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."StudyState" WHERE uid = p_uid AND rs = 'D' AND "reportUnit" IS NULL)
     OR EXISTS (SELECT 1 FROM public."Report" WHERE uid = p_uid)
     OR EXISTS (SELECT 1 FROM public."ReportVersion" WHERE uid = p_uid) THEN
    RAISE EXCEPTION 'ReportNotDestroyed' USING ERRCODE = 'KD001';
  END IF;
  DELETE FROM emr_signing.operation WHERE outcome ->> 'recordId' = p_uid;
  DELETE FROM emr_signing.signed_version WHERE record_id = p_uid;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
CREATE FUNCTION emr_signing.report_order_referenced(p_uid text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM emr_access.order_fact WHERE strpos(body, '"' || p_uid || '"') > 0)
$$;
REVOKE ALL ON FUNCTION emr_signing.destroy_report_signatures(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION emr_signing.report_order_referenced(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emr_signing.destroy_report_signatures(text) TO kin_runtime;
GRANT EXECUTE ON FUNCTION emr_signing.report_order_referenced(text) TO kin_runtime;
COMMIT;
