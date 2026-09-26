-- S5-U4a: clinician questions to the owning institution's radiology pool (contract S5-U4p §12.1). Additive only:
-- two new tables, no default on an existing table, no backfill, and nothing existing changes. A question is not a
-- consultation (StudyConsultation stays as it is) and carries no report text.
-- Every applied request appends exactly one StudyQuestionEntry row, and that row is the request's receipt: its id
-- is the requestId, and it keeps the fingerprint, the revision it produced and the result it answered, so any
-- applied requestId can be replayed for as long as the question exists. Rows are never updated or deleted by the
-- product; both foreign keys RESTRICT, and the study delete refuses a study that has questions (409
-- STUDY_HAS_QUESTIONS) instead of cascading them away.
-- Explicit text operands, as in 20260910123000_consultation_predicates and GatewayReceipt_phase_check: an IN-list on
-- a character varying column comes back from pg_restore with another definition. Every CHECK here is non-NULL for
-- any row (the nullable columns are tested with IS NULL / IS NOT NULL first), so none passes on UNKNOWN.
BEGIN;
CREATE TABLE "StudyQuestion" (
  "id" UUID NOT NULL,
  "studyUid" TEXT NOT NULL,
  "institutionId" VARCHAR(256) NOT NULL,
  "authorSub" VARCHAR(256) NOT NULL,
  "authorActor" VARCHAR(256) NOT NULL,
  "authorName" VARCHAR(256) NOT NULL,
  "state" VARCHAR(16) NOT NULL,
  "revision" INTEGER NOT NULL,
  "entryCount" INTEGER NOT NULL,
  "closedAt" TIMESTAMP(3),
  "closedByActor" VARCHAR(256),
  "closedByName" VARCHAR(256),
  "closedByRole" VARCHAR(16),
  "changedBy" VARCHAR(256) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudyQuestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StudyQuestion_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "StudyQuestion_state_check" CHECK ("state"::text = ANY (ARRAY['Open'::text,'Answered'::text,'Closed'::text])),
  -- Every applied request adds one entry and one revision, so the two move together (at most 100 entries).
  CONSTRAINT "StudyQuestion_revision_check" CHECK ("revision" > 0 AND "entryCount" BETWEEN 1 AND 100 AND "revision" = "entryCount"),
  -- Closed and the four closing columns are set together and only together.
  CONSTRAINT "StudyQuestion_closed_check" CHECK (("state"::text = 'Closed'::text) = ("closedAt" IS NOT NULL)
    AND ("closedAt" IS NULL) = ("closedByActor" IS NULL) AND ("closedAt" IS NULL) = ("closedByName" IS NULL)
    AND ("closedAt" IS NULL) = ("closedByRole" IS NULL)
    AND ("closedByRole" IS NULL OR "closedByRole"::text = ANY (ARRAY['clinician'::text,'radiologist'::text,'admin'::text])))
);
CREATE TABLE "StudyQuestionEntry" (
  "id" UUID NOT NULL,
  "questionId" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "body" VARCHAR(2000) NOT NULL,
  "authorSub" VARCHAR(256) NOT NULL,
  "authorActor" VARCHAR(256) NOT NULL,
  "authorName" VARCHAR(256) NOT NULL,
  "authorRole" VARCHAR(16) NOT NULL,
  "reportRs" VARCHAR(4) NOT NULL,
  "reportVersion" INTEGER,
  "fingerprint" TEXT NOT NULL,
  "appliedRevision" INTEGER NOT NULL,
  "result" JSONB NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudyQuestionEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StudyQuestionEntry_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "StudyQuestion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "StudyQuestionEntry_kind_check" CHECK ("kind"::text = ANY (ARRAY['question'::text,'followup'::text,'answer'::text,'close'::text])),
  CONSTRAINT "StudyQuestionEntry_authorRole_check" CHECK ("authorRole"::text = ANY (ARRAY['clinician'::text,'radiologist'::text,'admin'::text])),
  -- The receipt's revision is its sequence number; only the creating entry is seq 1, is a 'question', and has the
  -- question's own id as its requestId.
  CONSTRAINT "StudyQuestionEntry_seq_check" CHECK ("seq" BETWEEN 1 AND 100 AND "appliedRevision" = "seq"
    AND ("kind"::text = 'question'::text) = ("seq" = 1) AND ("seq" = 1) = ("id" = "questionId")),
  -- Only a close may carry an empty body (the author's note is optional).
  CONSTRAINT "StudyQuestionEntry_body_check" CHECK ("kind"::text = 'close'::text OR length("body") > 0),
  CONSTRAINT "StudyQuestionEntry_reportVersion_check" CHECK ("reportVersion" IS NULL OR "reportVersion" > 0),
  CONSTRAINT "StudyQuestionEntry_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "StudyQuestionEntry_result_check" CHECK (jsonb_typeof("result") = 'object')
);
CREATE INDEX "StudyQuestion_institutionId_authorSub_createdAt_id_idx" ON "StudyQuestion"("institutionId", "authorSub", "createdAt", "id");
CREATE INDEX "StudyQuestion_institutionId_state_createdAt_id_idx" ON "StudyQuestion"("institutionId", "state", "createdAt", "id");
CREATE INDEX "StudyQuestion_studyUid_idx" ON "StudyQuestion"("studyUid");
CREATE UNIQUE INDEX "StudyQuestionEntry_questionId_seq_key" ON "StudyQuestionEntry"("questionId", "seq");
CREATE UNIQUE INDEX "StudyQuestionEntry_questionId_appliedRevision_key" ON "StudyQuestionEntry"("questionId", "appliedRevision");
COMMIT;
