-- The initial additive migration has already been applied in local validation;
-- retain its checksum and evolve it without resetting existing data.
ALTER TABLE "ManualSr" ALTER COLUMN "dataset" DROP NOT NULL;
ALTER TABLE "ManualSr" ALTER COLUMN "dicom" DROP NOT NULL;
ALTER TABLE "ManualSr" ADD COLUMN "attemptedAt" TIMESTAMP(3);
ALTER TABLE "ManualSr" ADD COLUMN "nextCheckAt" TIMESTAMP(3);
ALTER TABLE "ManualSr" ADD CONSTRAINT "ManualSr_expired_body"
  CHECK (("dataset" IS NULL) = ("dicom" IS NULL) AND ("attemptedAt" IS NULL OR "dicom" IS NOT NULL));
