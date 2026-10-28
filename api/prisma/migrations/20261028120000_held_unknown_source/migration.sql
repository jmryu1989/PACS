-- D1882: sending devices (calling AE titles) an administrator registered for the institution after confirming them
-- with the hospital. Existing rows start with none; nothing is backfilled.
ALTER TABLE "Institution" ADD COLUMN "dicomAets" TEXT NOT NULL DEFAULT '';
