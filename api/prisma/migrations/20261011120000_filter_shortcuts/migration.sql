-- Personal ordered shortcuts share the filter collection's owner/revision lock.
-- Missing search targets remain stored so a revoked/deleted target is unavailable.
ALTER TABLE "UserFilterCollection" ADD COLUMN "shortcuts" JSONB NOT NULL DEFAULT '[]';
