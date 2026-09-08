-- Additive: previous applications can keep reading/writing their existing tables.
CREATE TABLE "ViewerJob" (
  "id" UUID PRIMARY KEY, "studyUid" TEXT NOT NULL, "authorSub" TEXT NOT NULL, "authorActor" TEXT NOT NULL,
  "studies" TEXT[] NOT NULL, "fingerprint" TEXT NOT NULL, "snapshot" JSONB NOT NULL,
  "title" VARCHAR(120) NOT NULL, "description" VARCHAR(2000) NOT NULL, "hidden" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ViewerJob_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ViewerJob_bounds" CHECK (cardinality("studies") BETWEEN 1 AND 2 AND array_position("studies", NULL) IS NULL AND "studies"[1] = "studyUid" AND (cardinality("studies") = 1 OR "studies"[1] <> "studies"[2]) AND "revision" BETWEEN 1 AND 1000 AND octet_length("snapshot"::text) <= 20000)
);
CREATE INDEX "ViewerJob_studyUid_createdAt_id_idx" ON "ViewerJob"("studyUid", "createdAt", "id");
CREATE TABLE "ViewerJobRevision" (
  "jobId" UUID NOT NULL, "revision" INTEGER NOT NULL, "title" VARCHAR(120) NOT NULL, "description" VARCHAR(2000) NOT NULL,
  "hidden" BOOLEAN NOT NULL, "reason" VARCHAR(1000) NOT NULL, "actor" TEXT NOT NULL, "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ViewerJobRevision_pkey" PRIMARY KEY ("jobId", "revision"),
  CONSTRAINT "ViewerJobRevision_bounds" CHECK ("revision" BETWEEN 1 AND 1000),
  CONSTRAINT "ViewerJobRevision_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ViewerJob"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
