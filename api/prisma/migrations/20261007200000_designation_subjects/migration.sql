-- Preserve the designated people across changes to email or username; legacy rows bind during realm-v1 import.
ALTER TABLE "StudyState" ADD COLUMN "preDocSub" TEXT, ADD COLUMN "preReviewerSub" TEXT;
