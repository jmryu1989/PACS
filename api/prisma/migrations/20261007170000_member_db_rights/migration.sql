-- D621/D623: retained authority, forward-only. Realm import is an explicit offline deployment step.
BEGIN;
CREATE TABLE "MemberRights" (
  "sub" TEXT PRIMARY KEY, "username" TEXT NOT NULL, "email" TEXT NOT NULL,
  "name" TEXT NOT NULL, "emailVerified" BOOLEAN NOT NULL,
  "approved" BOOLEAN NOT NULL DEFAULT false, "suspended" BOOLEAN NOT NULL DEFAULT false,
  "institution" TEXT, "roles" TEXT[] NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "newAuthAfter" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MemberRights_valid" CHECK ("version" > 0 AND
    (NOT "approved" OR ("institution" IS NOT NULL AND cardinality("roles") > 0)))
);
CREATE TABLE "MemberRightsImport" ("id" TEXT PRIMARY KEY, "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE "AuthSession" ADD COLUMN "rightsVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "institution" TEXT;
-- Cancellation never deletes the credential boundary. Even an accidental DELETE cannot forget it.
CREATE FUNCTION member_rights_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Member rights history must be retained'; END IF;
  IF NEW."version" < OLD."version" THEN RAISE EXCEPTION 'Member rights version cannot go backwards'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "MemberRights_retained" BEFORE DELETE OR UPDATE ON "MemberRights"
FOR EACH ROW EXECUTE FUNCTION member_rights_retained();
COMMIT;
