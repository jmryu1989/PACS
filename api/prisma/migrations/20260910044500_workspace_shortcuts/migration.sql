CREATE TABLE "WorkspaceShortcuts" (
  "institution" VARCHAR(256) NOT NULL,
  "subject" VARCHAR(256) NOT NULL,
  "revision" INTEGER NOT NULL,
  "bindings" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceShortcuts_pkey" PRIMARY KEY ("institution", "subject")
);
