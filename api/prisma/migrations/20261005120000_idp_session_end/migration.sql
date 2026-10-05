-- S7-U5 session end (R1): a product session remembers the provider (Keycloak) session it was born from, and a provider
-- session the product decided to end is recorded so that it can never produce a product session again. Additive only:
-- no row is deleted and no existing column changes.
--
-- AuthSession."idpSid": nullable, no backfill. A session that existed before this migration keeps NULL; when the
--   product ends such a row it reads the provider session id from the row's stored access token instead (the token was
--   verified before it was stored), and a refresh of the row fills the column.
-- IdpSessionEnd: one row per provider session the product decided to end - the mark the login callback and the Bearer
--   path check, and the queue of the provider end request ("confirmedAt" IS NULL = not yet confirmed, retried from
--   "nextAttemptAt"). The first "cause"/"decidedAt" are never overwritten. Empty after this migration.
-- AuditLog is not touched, so its append-only guard (20260930120000) is not involved.
BEGIN;
ALTER TABLE "AuthSession" ADD COLUMN "idpSid" TEXT;
CREATE INDEX "AuthSession_idpSid_idx" ON "AuthSession"("idpSid");
CREATE TABLE "IdpSessionEnd" (
    "idpSid" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdpSessionEnd_pkey" PRIMARY KEY ("idpSid")
);
CREATE INDEX "IdpSessionEnd_confirmedAt_nextAttemptAt_idx" ON "IdpSessionEnd"("confirmedAt", "nextAttemptAt");
COMMIT;
