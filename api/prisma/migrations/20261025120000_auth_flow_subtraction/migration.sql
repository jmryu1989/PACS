-- The login event and session binding remain; entry proof and provider retry marks are retired.
ALTER TABLE "AuthSession" DROP COLUMN "entryProofHash", DROP COLUMN "entryProofExpiresAt";
DROP TABLE "IdpSessionEnd";
