-- Scope references never relabel existing reports, drafts or signed ReportVersion rows.
BEGIN;
ALTER TABLE "ReportDraftPurposeEnd" ADD COLUMN "groupId" UUID;
ALTER TABLE "StudyGroupMember" ADD COLUMN "sourcePatientId" TEXT;
ALTER TABLE "StudyGroupMember" ADD COLUMN "sourceInstitution" TEXT;

-- Members may be inserted only while the group is active. Ending changes only its end marker.
CREATE FUNCTION exam_group_members_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Exam membership is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "StudyGroup" WHERE id = NEW."groupId"
      AND "dissolvedAt" IS NULL) THEN
    RAISE EXCEPTION 'Exam membership requires an active group' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exam_group_members_fixed BEFORE INSERT OR UPDATE OR DELETE ON "StudyGroupMember"
  FOR EACH ROW EXECUTE FUNCTION exam_group_members_fixed();
CREATE FUNCTION exam_group_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Exam groups are preserved' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['dissolvedAt','dissolvedBy','dissolvedBySub']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['dissolvedAt','dissolvedBy','dissolvedBySub']) OR OLD."dissolvedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Only an active exam group may be ended' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exam_group_fixed BEFORE UPDATE OR DELETE ON "StudyGroup"
  FOR EACH ROW EXECUTE FUNCTION exam_group_fixed();
COMMIT;
