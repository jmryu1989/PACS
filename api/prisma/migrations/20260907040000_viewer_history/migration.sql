-- Additive only: older applications can run while the display history remains protected.
BEGIN;
CREATE TABLE "ViewerItem" (
  "id" UUID NOT NULL,
  "studyUid" TEXT NOT NULL,
  "authorSub" TEXT NOT NULL,
  "authorActor" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ViewerItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ViewerItem_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "ViewerItem_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'object' AND octet_length(convert_to("snapshot"::text, 'UTF8')) <= 8192)
);
CREATE TABLE "ViewerRevision" (
  "itemId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "payloadBytes" INTEGER NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ViewerRevision_pkey" PRIMARY KEY ("itemId", "revision"),
  CONSTRAINT "ViewerRevision_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "ViewerRevision_payload_check" CHECK ("payloadBytes" BETWEEN 1 AND 8192 AND "payloadBytes" = octet_length(convert_to("snapshot"::text, 'UTF8'))),
  CONSTRAINT "ViewerRevision_action_check" CHECK ("action" IN ('create','edit','hide','restore'))
);
CREATE TABLE "ViewerStorageBudget" (
  "studyUid" TEXT NOT NULL,
  "itemCount" INTEGER NOT NULL,
  "revisionCount" INTEGER NOT NULL,
  "payloadBytes" INTEGER NOT NULL,
  CONSTRAINT "ViewerStorageBudget_pkey" PRIMARY KEY ("studyUid"),
  CONSTRAINT "ViewerStorageBudget_limit_check" CHECK ("itemCount" BETWEEN 0 AND 512 AND "revisionCount" BETWEEN 0 AND 4096 AND "payloadBytes" BETWEEN 0 AND 16777216)
);
CREATE TABLE "ViewerRequest" (
  "authorSub" TEXT NOT NULL,
  "requestId" UUID NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "itemId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  CONSTRAINT "ViewerRequest_pkey" PRIMARY KEY ("authorSub", "requestId")
);
CREATE INDEX "ViewerItem_studyUid_id_idx" ON "ViewerItem"("studyUid", "id");
CREATE INDEX "ViewerRequest_itemId_revision_idx" ON "ViewerRequest"("itemId", "revision");
ALTER TABLE "ViewerItem" ADD CONSTRAINT "ViewerItem_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ViewerRevision" ADD CONSTRAINT "ViewerRevision_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ViewerItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ViewerStorageBudget" ADD CONSTRAINT "ViewerStorageBudget_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ViewerRequest" ADD CONSTRAINT "ViewerRequest_itemId_revision_fkey" FOREIGN KEY ("itemId", "revision") REFERENCES "ViewerRevision"("itemId", "revision") ON DELETE RESTRICT ON UPDATE RESTRICT;
COMMIT;
