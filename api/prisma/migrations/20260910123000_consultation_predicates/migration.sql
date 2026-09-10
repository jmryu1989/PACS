BEGIN;
-- Explicit text operands retain the same predicate after pg_dump/pg_restore.
-- Keep the original migration checksum and the existing validation/uniqueness.
ALTER TABLE "StudyConsultation" DROP CONSTRAINT "StudyConsultation_state_check";
ALTER TABLE "StudyConsultation" ADD CONSTRAINT "StudyConsultation_state_check"
  CHECK ("state"::text = ANY (ARRAY['Requested'::text,'Accepted'::text,'Completed'::text,'Cancelled'::text]));
DROP INDEX "StudyConsultation_active_recipient_key";
CREATE UNIQUE INDEX "StudyConsultation_active_recipient_key"
  ON "StudyConsultation"("studyUid","recipientSub")
  WHERE "state"::text = ANY (ARRAY['Requested'::text,'Accepted'::text]);
COMMIT;
