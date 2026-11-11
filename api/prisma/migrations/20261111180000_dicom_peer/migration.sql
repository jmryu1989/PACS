-- FC-070 Query/Retrieve: the other PACS or modalities an institution's administrator registers (name, AE Title, host,
-- port) so its members can search them (C-FIND) and pull a study into this archive (C-MOVE). Additive only: one new
-- table, no backfill (an institution starts with no peer). One AE Title once per institution. The runtime role's table
-- rights come from the EMR-B1 default privileges of schema public.
BEGIN;
CREATE TABLE "DicomPeer" (
    "id" UUID NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "aet" VARCHAR(16) NOT NULL,
    "host" VARCHAR(253) NOT NULL,
    "port" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DicomPeer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DicomPeer_port_range" CHECK ("port" BETWEEN 1 AND 65535)
);
CREATE UNIQUE INDEX "DicomPeer_institutionId_aet_key" ON "DicomPeer"("institutionId", "aet");
COMMIT;
