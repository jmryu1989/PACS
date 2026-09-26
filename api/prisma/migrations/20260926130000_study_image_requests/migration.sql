-- S5-U4c: external-image and image-transfer requests (contract S5-U4p section 12.2). Additive only: two new tables,
-- no default on an existing table, no backfill, and nothing existing changes. A request is a record, not a transfer:
-- no column or foreign key reaches Transfer, TransferBasis or ProcessingAgreement, and Closed does not claim that
-- images were sent or imported. The counterparty institution is an optional reference that gives that institution
-- no visibility of the row.
-- Every applied request appends exactly one StudyImageRequestReceipt row, the creating one included: its requestId,
-- fingerprint, the revision it produced and the result it answered, so any applied requestId can be replayed for as
-- long as the request exists. Rows are never deleted by the product; every foreign key RESTRICTs, and the study delete
-- refuses a study that has requests (409 STUDY_HAS_IMAGE_REQUESTS) instead of cascading them away.
-- At most one active (Requested/Accepted) request per (studyUid, kind, requesterSub): the partial unique index below.
-- Explicit text operands, as in 20260910123000_consultation_predicates and 20260926120000_study_questions: an IN-list
-- on a character varying column comes back from pg_restore with another definition. Every CHECK here is non-NULL for
-- any row (the nullable columns are tested with IS NULL / IS NOT NULL first), so none passes on UNKNOWN.
BEGIN;
CREATE TABLE "StudyImageRequest" (
  "id" UUID NOT NULL,
  "studyUid" TEXT NOT NULL,
  "institutionId" VARCHAR(256) NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "requesterSub" VARCHAR(256) NOT NULL,
  "requesterActor" VARCHAR(256) NOT NULL,
  "requesterName" VARCHAR(256) NOT NULL,
  "counterpartyText" VARCHAR(256) NOT NULL,
  "counterpartyInstitutionId" TEXT,
  "reason" VARCHAR(2000) NOT NULL,
  "state" VARCHAR(16) NOT NULL,
  "revision" INTEGER NOT NULL,
  "handlerActor" VARCHAR(256),
  "handlerName" VARCHAR(256),
  "note" VARCHAR(2000),
  "changedBy" VARCHAR(256) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudyImageRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StudyImageRequest_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "StudyImageRequest_counterpartyInstitutionId_fkey" FOREIGN KEY ("counterpartyInstitutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "StudyImageRequest_kind_check" CHECK ("kind"::text = ANY (ARRAY['external-image'::text,'image-transfer'::text])),
  CONSTRAINT "StudyImageRequest_state_check" CHECK ("state"::text = ANY (ARRAY['Requested'::text,'Accepted'::text,'Closed'::text,'Declined'::text,'Cancelled'::text])),
  CONSTRAINT "StudyImageRequest_revision_check" CHECK ("revision" > 0),
  -- The counterparty is another institution; a request to itself is refused by the service (400) and here.
  CONSTRAINT "StudyImageRequest_counterparty_check" CHECK ("counterpartyInstitutionId" IS NULL OR "counterpartyInstitutionId" <> "institutionId"::text),
  -- Free text is never empty; the service trims and bounds it before it gets here.
  CONSTRAINT "StudyImageRequest_text_check" CHECK (length("counterpartyText") > 0 AND length("reason") > 0 AND ("note" IS NULL OR length("note") > 0)),
  -- A terminal state carries its note (processing record, decline reason or cancel reason) and only a terminal state does.
  CONSTRAINT "StudyImageRequest_note_check" CHECK (("state"::text = ANY (ARRAY['Closed'::text,'Declined'::text,'Cancelled'::text])) = ("note" IS NOT NULL)),
  -- The handler is the staff member who last changed the processing state: none while Requested, always once Accepted,
  -- Closed or Declined; a requester's own cancel keeps whatever handler the request had.
  CONSTRAINT "StudyImageRequest_handler_check" CHECK (("handlerActor" IS NULL) = ("handlerName" IS NULL)
    AND (("handlerActor" IS NULL) = ("state"::text = 'Requested'::text) OR "state"::text = 'Cancelled'::text))
);
CREATE TABLE "StudyImageRequestReceipt" (
  "requestId" UUID NOT NULL,
  "imageRequestId" UUID NOT NULL,
  "subjectSub" VARCHAR(256) NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "appliedRevision" INTEGER NOT NULL,
  "result" JSONB NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudyImageRequestReceipt_pkey" PRIMARY KEY ("requestId"),
  CONSTRAINT "StudyImageRequestReceipt_imageRequestId_fkey" FOREIGN KEY ("imageRequestId") REFERENCES "StudyImageRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "StudyImageRequestReceipt_action_check" CHECK ("action"::text = ANY (ARRAY['create'::text,'accept'::text,'close'::text,'decline'::text,'cancel'::text])),
  -- Only the creating receipt is revision 1, and its requestId is the request's own id.
  CONSTRAINT "StudyImageRequestReceipt_revision_check" CHECK ("appliedRevision" > 0
    AND ("action"::text = 'create'::text) = ("requestId" = "imageRequestId")
    AND ("action"::text = 'create'::text) = ("appliedRevision" = 1)),
  CONSTRAINT "StudyImageRequestReceipt_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "StudyImageRequestReceipt_result_check" CHECK (jsonb_typeof("result") = 'object')
);
CREATE INDEX "StudyImageRequest_institutionId_requesterSub_createdAt_id_idx" ON "StudyImageRequest"("institutionId", "requesterSub", "createdAt", "id");
CREATE INDEX "StudyImageRequest_institutionId_state_createdAt_id_idx" ON "StudyImageRequest"("institutionId", "state", "createdAt", "id");
CREATE INDEX "StudyImageRequest_studyUid_idx" ON "StudyImageRequest"("studyUid");
CREATE UNIQUE INDEX "StudyImageRequest_active_key" ON "StudyImageRequest"("studyUid", "kind", "requesterSub")
  WHERE "state"::text = ANY (ARRAY['Requested'::text,'Accepted'::text]);
CREATE UNIQUE INDEX "StudyImageRequestReceipt_imageRequestId_appliedRevision_key" ON "StudyImageRequestReceipt"("imageRequestId", "appliedRevision");
COMMIT;
