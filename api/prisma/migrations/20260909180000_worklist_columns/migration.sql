-- Separate from monitor/panel layout; reset retains its revision against stale writes.
CREATE TABLE "WorklistColumns" (
    "institution" VARCHAR(256) NOT NULL,
    "subject" VARCHAR(256) NOT NULL,
    "revision" INTEGER NOT NULL,
    "value" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorklistColumns_pkey" PRIMARY KEY ("institution", "subject"),
    CONSTRAINT "WorklistColumns_revision_check" CHECK ("revision" > 0),
    CONSTRAINT "WorklistColumns_value_check" CHECK ("value" IS NULL OR octet_length("value") <= 8192)
);
