CREATE TABLE "FavoriteWorkspace" (
  "institution" VARCHAR(256) NOT NULL,
  "subject" VARCHAR(256) NOT NULL,
  "revision" INTEGER NOT NULL,
  "value" TEXT NOT NULL,
  "lastRequest" UUID,
  "lastFingerprint" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FavoriteWorkspace_pkey" PRIMARY KEY ("institution", "subject")
);
