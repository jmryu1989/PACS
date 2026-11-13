-- Worklist request columns (ReqDate, ReqDept, Pt Class): the request time, the requesting department and the patient class
-- (O / I / E / ICU) of an order. Additive only: three nullable columns, no default and no backfill. Until an authoritative
-- order source is connected only test orders carry them, and a missing value stays blank on the worklist.
BEGIN;
ALTER TABLE "Order"
  ADD COLUMN "reqAt" TIMESTAMP(3),
  ADD COLUMN "reqDept" TEXT,
  ADD COLUMN "ptClass" TEXT;
COMMIT;
