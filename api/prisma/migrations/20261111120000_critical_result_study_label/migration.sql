-- C-R02-110 (A3 fix unit 7): a received critical result names the patient and the study date but not which study
-- (Modality, Description). The record keeps two more original-tag copies beside the four of 20260928120000_critical_result
-- (contract S7-U1p section 3.2), taken from the same Orthanc read when the record is made: ModalitiesInStudy (0008,0061)
-- and StudyDescription (0008,1030). Additive only: two columns with an empty default, no backfill - a record made before
-- this migration keeps '' and the screen leaves its study line out. No CHECK, index, key or grant changes (the runtime's
-- table grants cover new columns).
BEGIN;
ALTER TABLE "CriticalResult"
  ADD COLUMN "origModality" VARCHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN "origStudyDesc" VARCHAR(256) NOT NULL DEFAULT '';
COMMIT;
