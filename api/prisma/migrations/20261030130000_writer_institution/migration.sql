-- A tele study's owner is not necessarily the writer's institution. Legacy holds
-- stay anonymous to colleagues until an authenticated heartbeat supplies it.
ALTER TABLE "StudyState" ADD COLUMN "holderInstitutionId" TEXT;
