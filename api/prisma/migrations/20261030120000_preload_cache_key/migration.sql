CREATE TABLE "PreloadCacheKey" (
    "id" UUID NOT NULL,
    "institution" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "key" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastIssuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),
    CONSTRAINT "PreloadCacheKey_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PreloadCacheKey_key_state" CHECK (
      ("retiredAt" IS NULL AND "key" IS NOT NULL AND octet_length("key") = 32)
      OR ("retiredAt" IS NOT NULL AND "key" IS NULL))
);
CREATE UNIQUE INDEX "PreloadCacheKey_active_owner" ON "PreloadCacheKey" ("institution", "sub") WHERE "retiredAt" IS NULL;
CREATE INDEX "PreloadCacheKey_lastIssuedAt_idx" ON "PreloadCacheKey" ("lastIssuedAt");
