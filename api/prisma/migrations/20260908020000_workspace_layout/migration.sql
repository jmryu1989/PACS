CREATE TABLE "WorkspaceLayout" (
    "institution" VARCHAR(256) NOT NULL,
    "subject" VARCHAR(256) NOT NULL,
    "revision" INTEGER NOT NULL CHECK ("revision" > 0),
    "value" TEXT CHECK ("value" IS NULL OR octet_length("value") <= 2048),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkspaceLayout_pkey" PRIMARY KEY ("institution", "subject")
);
