-- S7-U5 member isolation: the provider call in flight. The side doing an isolation's owed provider work writes its attempt
-- number, the call and its start in its own commit BEFORE each provider call and clears them in its own commit after the
-- call returns. A re-activation that takes the owed work over waits until no call of an earlier attempt is in flight (or
-- that call's bound has passed) before it finishes the work and enables the member - an earlier disable or whole-user
-- logout already sent cannot land after the enable. All three NULL = no call in flight.
-- Additive only: three nullable columns, every existing row NULL in them. No other table or row changes; AuditLog is not touched.
BEGIN;
ALTER TABLE "MemberIsolation" ADD COLUMN "callAttempt" INTEGER,
    ADD COLUMN "call" TEXT,
    ADD COLUMN "callStartedAt" TIMESTAMP(3);
COMMIT;
