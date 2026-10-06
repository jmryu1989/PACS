-- S7-U5 (D600) every change call the product sends to the provider (disable, enable, the end of one provider session) is
-- written BEFORE it is sent, with its own number, the sender's generation, its target and its state, and only that call's
-- own answer settles it ("done" or "void"); a lost answer stays "unknown" - never cleared by time, a lease, a re-read or
-- another call's answer. A member with an unknown change is not re-activated; a provider session with an unknown end is
-- not confirmed ended. This replaces the in-flight marker of 20261006120000_member_isolation_call (one call per member,
-- trusted until a lease ran out): its three columns held only a transient marker and are dropped.
-- No other table or row changes; AuditLog is not touched.
BEGIN;
ALTER TABLE "MemberIsolation" DROP COLUMN "callAttempt",
    DROP COLUMN "call",
    DROP COLUMN "callStartedAt";
CREATE TABLE "ProviderChange" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "sub" TEXT,
    "generation" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "ProviderChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProviderChange_kind_target_state_idx" ON "ProviderChange"("kind", "target", "state");
CREATE INDEX "ProviderChange_sub_state_idx" ON "ProviderChange"("sub", "state");
COMMIT;
