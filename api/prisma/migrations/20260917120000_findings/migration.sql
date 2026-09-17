-- Additive only: a finding freezes copies of saved display items; older applications keep running.
-- Storage bound per study (enforced by the service under the StudyState write lock, like the viewer budget):
-- 256 findings, 4096 lifetime revisions and 16777216 bytes of revision snapshots per study, 1000 revisions
-- per finding and 65536 bytes per snapshot. Worst case per study is min(4096 x 65536, 16777216) = 16 MiB.
BEGIN;
CREATE TABLE "Finding" (
  "id" UUID NOT NULL,
  "studyUid" TEXT NOT NULL,
  "authorSub" TEXT NOT NULL,
  "authorActor" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Finding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Finding_revision_check" CHECK ("revision" BETWEEN 1 AND 1000),
  CONSTRAINT "Finding_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'object' AND jsonb_typeof("snapshot"->'sources') = 'array' AND jsonb_array_length("snapshot"->'sources') BETWEEN 1 AND 8 AND octet_length(convert_to("snapshot"::text, 'UTF8')) <= 65536)
);
CREATE TABLE "FindingRevision" (
  "findingId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "actor" TEXT NOT NULL,
  "authorSub" TEXT NOT NULL,
  "requestId" UUID NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "payloadBytes" INTEGER NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FindingRevision_pkey" PRIMARY KEY ("findingId", "revision"),
  CONSTRAINT "FindingRevision_revision_check" CHECK ("revision" BETWEEN 1 AND 1000),
  CONSTRAINT "FindingRevision_payload_check" CHECK ("payloadBytes" BETWEEN 1 AND 65536 AND "payloadBytes" = octet_length(convert_to("snapshot"::text, 'UTF8'))),
  -- Explicit text operands, as in 20260910123000_consultation_predicates: an IN-list on a
  -- character varying column is deparsed differently after pg_dump/pg_restore.
  CONSTRAINT "FindingRevision_action_check" CHECK ("action"::text = ANY (ARRAY['create'::text,'edit'::text,'hide'::text,'restore'::text])),
  CONSTRAINT "FindingRevision_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "Finding_studyUid_id_idx" ON "Finding"("studyUid", "id");
CREATE UNIQUE INDEX "FindingRevision_authorSub_requestId_key" ON "FindingRevision"("authorSub", "requestId");
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "FindingRevision" ADD CONSTRAINT "FindingRevision_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
COMMIT;
