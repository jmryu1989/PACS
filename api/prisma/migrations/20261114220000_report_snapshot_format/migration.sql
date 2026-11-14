-- Existing signatures retain their pre-scope row bytes. Only newly appended versions use the scoped format.
ALTER TABLE "ReportVersion" ADD COLUMN "snapshotFormat" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ReportVersion" ALTER COLUMN "snapshotFormat" SET DEFAULT 2;
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_snapshotFormat_check" CHECK ("snapshotFormat" IN (1, 2));
