-- Additive defaults retain every existing personal search and its criteria.
ALTER TABLE "UserFilter"
  ADD COLUMN "folder" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "ordinal" INTEGER NOT NULL DEFAULT 0;
