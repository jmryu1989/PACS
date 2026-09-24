-- S4-U3: the last accepted Gateway transmission receipt per study (axis C). Additive only: one new
-- table, no default and no backfill - a study without a row is "no Gateway report", which is normal
-- (device-direct, pre-receipt agent, not installed), never a failure. Counts are BIGINT so the API's
-- safe-integer bound is the only bound; the CHECKs repeat the API rules as a fail-closed backstop.
-- The row goes with its StudyState: it is transport state, not a human record, and the existing study
-- delete and fixture cleanup delete StudyState rows directly.
BEGIN;
CREATE TABLE "GatewayReceipt" (
  "studyUid" TEXT NOT NULL,
  "institutionId" VARCHAR(256) NOT NULL,
  "epoch" UUID NOT NULL,
  "seq" BIGINT NOT NULL,
  "phase" VARCHAR(16) NOT NULL,
  "attempt" BIGINT NOT NULL,
  "successCount" BIGINT NOT NULL,
  "localCount" BIGINT NOT NULL,
  "errorCode" VARCHAR(40),
  "receivedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GatewayReceipt_pkey" PRIMARY KEY ("studyUid"),
  CONSTRAINT "GatewayReceipt_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "GatewayReceipt_phase_check" CHECK ("phase" IN ('pending','announcing','sending','retry','failed','complete')),
  CONSTRAINT "GatewayReceipt_counts_check" CHECK ("seq" BETWEEN 0 AND 9007199254740991 AND "attempt" BETWEEN 0 AND 9007199254740991
    AND "successCount" >= 0 AND "successCount" <= "localCount" AND "localCount" <= 9007199254740991
    AND ("phase" <> 'complete' OR "successCount" = "localCount")),
  CONSTRAINT "GatewayReceipt_error_check" CHECK (("errorCode" IS NOT NULL) = ("phase" IN ('retry','failed'))
    AND ("errorCode" IS NULL OR "errorCode" ~ '^[a-z][a-z_]{0,39}$'))
);
COMMIT;
