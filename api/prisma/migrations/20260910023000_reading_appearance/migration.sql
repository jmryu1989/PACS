CREATE TABLE "ReadingAppearance" (
  "institution" VARCHAR(256) NOT NULL,
  "subject" VARCHAR(256) NOT NULL,
  "revision" INTEGER NOT NULL,
  "sizes" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReadingAppearance_pkey" PRIMARY KEY ("institution", "subject")
);
