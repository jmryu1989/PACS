-- S7-U1a: critical result delivery with explicit acknowledgement (contract S7-U1p section 3.2, 5, 7, 12). Additive
-- only: three new tables, no default on an existing table, no backfill, and nothing existing changes (ReportVersion and
-- StudyState only gain the incoming foreign keys below).
-- A record is one sender -> one recipient, one study, one pinned ReportVersion row and one message. The pin is the
-- composite foreign key ("studyUid", "sourceVersion") -> ReportVersion(uid, version), so the pinned row cannot go away;
-- the body is never copied here and is read from that row. There is no source-kind column: a ReportVersion row is the
-- only possible source (personal drafts stay out, D-S7-DRAFT-SOURCE unresolved).
-- CriticalResultEvent and CriticalResultReceipt are append-only: every applied request adds rows and nothing in the
-- product updates or deletes them. The unique keys and CHECKs below bound their shape: a record has the created event
-- (seq 1) and at most one terminal event (seq 2), and at most one receipt per applied revision. Every foreign key
-- RESTRICTs, and the study delete refuses a study that has records (409 STUDY_HAS_CRITICAL_RESULTS) instead of
-- cascading them away.
-- At most one created (pending) record per (studyUid, senderSub, recipientSub): the partial unique index below.
-- senderInstitutionId equals institutionId in S7-U1a; the service keeps that and no CHECK binds it (S7-U1c branch A).
-- Explicit text operands, as in 20260926130000_study_image_requests: an IN-list on a character varying column comes
-- back from pg_restore with another definition. Every CHECK here is non-NULL for any row (the nullable columns are
-- tested with IS NULL / IS NOT NULL first), so none passes on UNKNOWN.
BEGIN;
CREATE TABLE "CriticalResult" (
  "id" UUID NOT NULL,
  "studyUid" TEXT NOT NULL,
  "institutionId" VARCHAR(256) NOT NULL,
  "senderInstitutionId" VARCHAR(256) NOT NULL,
  "senderSub" VARCHAR(256) NOT NULL,
  "senderActor" VARCHAR(256) NOT NULL,
  "senderName" VARCHAR(256) NOT NULL,
  "recipientSub" VARCHAR(256) NOT NULL,
  "recipientActor" VARCHAR(256) NOT NULL,
  "recipientName" VARCHAR(256) NOT NULL,
  "recipientRole" VARCHAR(16) NOT NULL,
  "sourceVersion" INTEGER NOT NULL,
  "sourceAction" VARCHAR(16) NOT NULL,
  "sourceAuthor" TEXT NOT NULL,
  "sourceAt" TIMESTAMP(3) NOT NULL,
  "origName" VARCHAR(256) NOT NULL,
  "origPatientId" VARCHAR(256) NOT NULL,
  "origBirth" VARCHAR(64) NOT NULL,
  "origStudyDate" VARCHAR(64) NOT NULL,
  "message" VARCHAR(2000) NOT NULL,
  "state" VARCHAR(16) NOT NULL,
  "revision" INTEGER NOT NULL,
  "supersedesId" UUID,
  "acknowledgedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "cancelReason" VARCHAR(2000),
  "supersededAt" TIMESTAMP(3),
  "changedBy" VARCHAR(256) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CriticalResult_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CriticalResult_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CriticalResult_studyUid_sourceVersion_fkey" FOREIGN KEY ("studyUid", "sourceVersion") REFERENCES "ReportVersion"("uid", "version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CriticalResult_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "CriticalResult"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CriticalResult_state_check" CHECK ("state"::text = ANY (ARRAY['created'::text,'acknowledged'::text,'cancelled'::text,'superseded'::text])),
  -- created is revision 1 and every terminal state is revision 2: one transition leaves created.
  CONSTRAINT "CriticalResult_revision_check" CHECK (("revision" = 1 OR "revision" = 2) AND ("state"::text = 'created'::text) = ("revision" = 1)),
  -- Each terminal state carries its own time (and the cancel its reason), and only that state does.
  CONSTRAINT "CriticalResult_terminal_check" CHECK (("state"::text = 'acknowledged'::text) = ("acknowledgedAt" IS NOT NULL)
    AND ("state"::text = 'cancelled'::text) = ("cancelledAt" IS NOT NULL)
    AND ("state"::text = 'cancelled'::text) = ("cancelReason" IS NOT NULL)
    AND ("state"::text = 'superseded'::text) = ("supersededAt" IS NOT NULL)),
  CONSTRAINT "CriticalResult_role_check" CHECK ("recipientRole"::text = ANY (ARRAY['clinician'::text,'radiologist'::text])),
  -- reset and discarded rows are never pinned, and a clinician-class record only pins a final (approve/addendum) row;
  -- the service refuses both first (409), this is the last line.
  CONSTRAINT "CriticalResult_source_check" CHECK ("sourceVersion" > 0
    AND "sourceAction"::text = ANY (ARRAY['save'::text,'approve'::text,'addendum'::text,'preliminary'::text,'defer'::text])
    AND ("recipientRole"::text <> 'clinician'::text OR "sourceAction"::text = ANY (ARRAY['approve'::text,'addendum'::text]))),
  CONSTRAINT "CriticalResult_party_check" CHECK ("recipientSub"::text <> "senderSub"::text AND ("supersedesId" IS NULL OR "supersedesId" <> "id")),
  -- Free text is never empty; the service trims and bounds it before it gets here.
  CONSTRAINT "CriticalResult_text_check" CHECK (length("message") > 0 AND ("cancelReason" IS NULL OR length("cancelReason") > 0))
);
CREATE TABLE "CriticalResultEvent" (
  "id" UUID NOT NULL,
  "recordId" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "event" VARCHAR(16) NOT NULL,
  "revision" INTEGER NOT NULL,
  "actorSub" VARCHAR(256) NOT NULL,
  "actorActor" VARCHAR(256) NOT NULL,
  "actorName" VARCHAR(256) NOT NULL,
  "actorRole" VARCHAR(16) NOT NULL,
  "requestId" UUID NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CriticalResultEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CriticalResultEvent_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "CriticalResult"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CriticalResultEvent_event_check" CHECK ("event"::text = ANY (ARRAY['created'::text,'acknowledged'::text,'cancelled'::text,'superseded'::text])),
  -- seq 1 is the created event, seq 2 the one terminal event, and the revision after the event equals seq.
  CONSTRAINT "CriticalResultEvent_seq_check" CHECK (("seq" = 1 OR "seq" = 2) AND ("event"::text = 'created'::text) = ("seq" = 1) AND "revision" = "seq"),
  CONSTRAINT "CriticalResultEvent_role_check" CHECK ("actorRole"::text = ANY (ARRAY['radiologist'::text,'clinician'::text]))
);
CREATE TABLE "CriticalResultReceipt" (
  "requestId" UUID NOT NULL,
  "recordId" UUID NOT NULL,
  "subjectSub" VARCHAR(256) NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "appliedRevision" INTEGER NOT NULL,
  "result" JSONB NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CriticalResultReceipt_pkey" PRIMARY KEY ("requestId"),
  CONSTRAINT "CriticalResultReceipt_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "CriticalResult"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CriticalResultReceipt_action_check" CHECK ("action"::text = ANY (ARRAY['create'::text,'ack'::text,'cancel'::text,'supersede'::text])),
  -- Only the creating receipt is revision 1, and its requestId is the record's own id. A supersede receipt names the
  -- old record (revision 2) while its requestId is the new record's id.
  CONSTRAINT "CriticalResultReceipt_revision_check" CHECK (("appliedRevision" = 1 OR "appliedRevision" = 2)
    AND ("action"::text = 'create'::text) = ("requestId" = "recordId")
    AND ("action"::text = 'create'::text) = ("appliedRevision" = 1)),
  CONSTRAINT "CriticalResultReceipt_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CriticalResultReceipt_result_check" CHECK (jsonb_typeof("result") = 'object')
);
CREATE UNIQUE INDEX "CriticalResult_supersedesId_key" ON "CriticalResult"("supersedesId");
CREATE INDEX "CriticalResult_institutionId_recipientSub_createdAt_id_idx" ON "CriticalResult"("institutionId", "recipientSub", "createdAt", "id");
CREATE INDEX "CriticalResult_institutionId_senderSub_createdAt_id_idx" ON "CriticalResult"("institutionId", "senderSub", "createdAt", "id");
CREATE INDEX "CriticalResult_studyUid_sourceVersion_idx" ON "CriticalResult"("studyUid", "sourceVersion");
CREATE UNIQUE INDEX "CriticalResult_pending_key" ON "CriticalResult"("studyUid", "senderSub", "recipientSub")
  WHERE "state"::text = 'created'::text;
CREATE UNIQUE INDEX "CriticalResultEvent_recordId_seq_key" ON "CriticalResultEvent"("recordId", "seq");
CREATE UNIQUE INDEX "CriticalResultEvent_recordId_event_key" ON "CriticalResultEvent"("recordId", "event");
CREATE INDEX "CriticalResultEvent_requestId_idx" ON "CriticalResultEvent"("requestId");
CREATE UNIQUE INDEX "CriticalResultReceipt_recordId_appliedRevision_key" ON "CriticalResultReceipt"("recordId", "appliedRevision");
COMMIT;
