-- Additive only. The prepared file is retained if an Orthanc write has an
-- uncertain result, so its exact SOP and bytes can be safely retried.
CREATE TABLE "ManualSr" (
  "id" UUID NOT NULL,
  "studyUid" TEXT NOT NULL,
  "authorSub" TEXT NOT NULL,
  "authorActor" TEXT NOT NULL,
  "requestId" UUID NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "selection" JSONB NOT NULL,
  "dataset" JSONB NOT NULL,
  "dicom" BYTEA NOT NULL,
  "sha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "storedAt" TIMESTAMP(3),
  "orthancId" TEXT,
  CONSTRAINT "ManualSr_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManualSr_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ManualSr_file_limit" CHECK (octet_length("dicom") BETWEEN 132 AND 524288),
  CONSTRAINT "ManualSr_selection_limit" CHECK (jsonb_typeof("selection") = 'array' AND jsonb_array_length("selection") BETWEEN 1 AND 16),
  CONSTRAINT "ManualSr_receipt_pair" CHECK (("storedAt" IS NULL) = ("orthancId" IS NULL))
);
CREATE UNIQUE INDEX "ManualSr_authorSub_requestId_key" ON "ManualSr"("authorSub", "requestId");
CREATE INDEX "ManualSr_studyUid_id_idx" ON "ManualSr"("studyUid", "id");
