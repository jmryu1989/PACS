-- Delete Order on the Technician Order List: an order is taken off this list (never deleted) with who, when and why.
-- Additive only: four nullable columns, no default and no backfill. Undo clears them; the audit log keeps the history.
BEGIN;
ALTER TABLE "Order"
  ADD COLUMN "removedAt" TIMESTAMP(3),
  ADD COLUMN "removedBySub" TEXT,
  ADD COLUMN "removedBy" TEXT,
  ADD COLUMN "removeReason" TEXT;
COMMIT;
