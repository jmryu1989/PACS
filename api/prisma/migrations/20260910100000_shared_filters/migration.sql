CREATE TABLE "SharedFilterLibrary" (
    "institution" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "folders" JSONB NOT NULL DEFAULT '[]',
    "filters" JSONB NOT NULL DEFAULT '[]',
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SharedFilterLibrary_pkey" PRIMARY KEY ("institution")
);
