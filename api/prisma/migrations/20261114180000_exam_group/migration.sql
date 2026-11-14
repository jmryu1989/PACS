-- Merge Exam / Split: a record groups original studies into one logical exam (merge) or one study's series into two
-- (split). No DICOM object or UID changes. Two new tables and one nullable column on each of Report, ReportVersion and
-- ReportDraft (the group a report or draft was written on); no backfill: every existing report and draft is of its study
-- alone. The runtime role's table rights come from the EMR-B1 default privileges of schema public.
BEGIN;
CREATE TABLE "StudyGroup" (
    "id" UUID NOT NULL,
    "institutionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "baseUid" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdBySub" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dissolvedAt" TIMESTAMP(3),
    "dissolvedBy" TEXT,
    "dissolvedBySub" TEXT,
    CONSTRAINT "StudyGroup_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StudyGroup_kind_check" CHECK ("kind" IN ('merge', 'split')),
    CONSTRAINT "StudyGroup_dissolved_check" CHECK (("dissolvedAt" IS NULL) = ("dissolvedBy" IS NULL)
        AND ("dissolvedAt" IS NULL) = ("dissolvedBySub" IS NULL))
);
CREATE INDEX "StudyGroup_institutionId_dissolvedAt_idx" ON "StudyGroup"("institutionId", "dissolvedAt");
CREATE TABLE "StudyGroupMember" (
    "groupId" UUID NOT NULL,
    "logicalUid" TEXT NOT NULL,
    "studyUid" TEXT NOT NULL,
    "part" INTEGER NOT NULL,
    "seriesUids" TEXT[] NOT NULL,
    CONSTRAINT "StudyGroupMember_pkey" PRIMARY KEY ("groupId", "logicalUid"),
    CONSTRAINT "StudyGroupMember_part_check" CHECK ("part" >= 0)
);
CREATE INDEX "StudyGroupMember_studyUid_idx" ON "StudyGroupMember"("studyUid");
CREATE INDEX "StudyGroupMember_logicalUid_idx" ON "StudyGroupMember"("logicalUid");
ALTER TABLE "StudyGroupMember" ADD CONSTRAINT "StudyGroupMember_groupId_fkey" FOREIGN KEY ("groupId")
    REFERENCES "StudyGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Report" ADD COLUMN "groupId" UUID;
ALTER TABLE "ReportVersion" ADD COLUMN "groupId" UUID;
ALTER TABLE "ReportDraft" ADD COLUMN "groupId" UUID;
COMMIT;
