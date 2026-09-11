CREATE TABLE "HangingProtocolPreference" (
  "institution" VARCHAR(256) NOT NULL,
  "subject" VARCHAR(256) NOT NULL,
  "revision" INTEGER NOT NULL,
  "value" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HangingProtocolPreference_pkey" PRIMARY KEY ("institution", "subject"),
  CONSTRAINT "HangingProtocolPreference_revision_check" CHECK ("revision" > 0)
);
