CREATE TABLE "ReadingPreferences" (
  "institution" VARCHAR(256) NOT NULL,
  "subject" VARCHAR(256) NOT NULL,
  "revision" INTEGER NOT NULL,
  "autoNote" BOOLEAN NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReadingPreferences_pkey" PRIMARY KEY ("institution", "subject")
);
