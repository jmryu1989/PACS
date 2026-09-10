-- Check whether a principal has access settings from a previous institution
-- without scanning every institution's policies on a default-scope request.
CREATE INDEX "StudyAccessPolicy_subject_idx" ON "StudyAccessPolicy"(subject);
