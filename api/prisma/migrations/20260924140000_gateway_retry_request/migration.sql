-- S4-U4: Now Retry requests. Additive only: one new table, no default and no backfill, and nothing in
-- GatewayReceipt changes. A row binds one person's request to the stored `retry` receipt state it was
-- made against (epoch, seq); once the Gateway reports a newer state the row is simply no longer
-- delivered. The product never rewrites or removes a row - it goes only with its receipt, and so with
-- its StudyState. The requester is in AuditLog and the institution in GatewayReceipt/StudyState.
-- The seq CHECK repeats the API's safe-integer bound in the restore-stable form GatewayReceipt uses.
BEGIN;
CREATE TABLE "GatewayRetryRequest" (
  "studyUid" TEXT NOT NULL,
  "epoch" UUID NOT NULL,
  "seq" BIGINT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GatewayRetryRequest_pkey" PRIMARY KEY ("studyUid","epoch","seq"),
  CONSTRAINT "GatewayRetryRequest_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "GatewayReceipt"("studyUid") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "GatewayRetryRequest_seq_check" CHECK ("seq" BETWEEN 0 AND 9007199254740991)
);
COMMIT;
