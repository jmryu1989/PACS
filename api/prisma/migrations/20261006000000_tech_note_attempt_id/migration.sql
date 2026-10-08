-- S8-CTX Tech Note save attempts (REQ-S8-CTX-NOTE). A screen names every save attempt with a UUID bound to the immutable
-- request (study, author, institution, base version, text, normalised reason). The revision written by that attempt
-- keeps the id, so a lost answer is resolved by finding this id (and the same id resent returns the same revision
-- instead of a second one). Additive only: one nullable column and its unique index. Existing revisions keep NULL - a
-- revision without an id is never evidence of anyone's attempt - and no existing row is rewritten.
BEGIN;
ALTER TABLE "TechNoteRevision" ADD COLUMN "attemptId" UUID;
CREATE UNIQUE INDEX "TechNoteRevision_attemptId_key" ON "TechNoteRevision"("attemptId");
COMMIT;
