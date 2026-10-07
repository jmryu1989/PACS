-- S7-U5 member isolation as our own recorded fact. An administrator's isolation of a member (suspend, approval change,
-- approval cancel) first writes this row and only then does the provider work (list the member's provider sessions,
-- mark them, disable, list again, mark, log out). The login callback and the refresh refuse a member that has a row -
-- they never ask the provider's admin API. "providerDoneAt" IS NULL = the provider work is still owed and the end
-- retry cycle resumes it from "nextAttemptAt". The row is removed only by a re-activation that has finished.
-- Additive only: no existing table or row changes; empty after this migration. AuditLog is not touched.
BEGIN;
CREATE TABLE "MemberIsolation" (
    "sub" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "providerDoneAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberIsolation_pkey" PRIMARY KEY ("sub")
);
CREATE INDEX "MemberIsolation_providerDoneAt_nextAttemptAt_idx" ON "MemberIsolation"("providerDoneAt", "nextAttemptAt");
COMMIT;
