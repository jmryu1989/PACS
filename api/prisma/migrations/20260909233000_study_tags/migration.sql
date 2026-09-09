CREATE TABLE "StudyTagCatalog" (
    "institution" VARCHAR(256) NOT NULL,
    "ownerSub" VARCHAR(256) NOT NULL,
    "revision" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    "lastRequest" UUID,
    "lastFingerprint" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StudyTagCatalog_pkey" PRIMARY KEY ("institution", "ownerSub")
);
