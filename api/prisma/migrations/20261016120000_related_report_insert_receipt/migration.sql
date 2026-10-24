-- W5-API (O4 R1, D1423/D1460): the durable receipt of one explicit Related Report insertion (PUT /api/studies/:uid/report
-- with relatedInsert). One row per globally unique insertRequestId. Additive only: no existing table, row or migration changes.
--   refused    the server checked under the Target lock that this fixed request was not applied and refused it for a business
--              reason; the same ID may be retried at the original boundary (refused -> applied) or discarded (-> discarded).
--              A changed refusal reason is refused -> refused with receiptRevision + 1.
--   applied    written in the same transaction as the draft write (revision expectedRevision + 1) and its report.draft audit.
--   discarded  the tombstone of a cancelled insertion; a late retry of the same ID inserts nothing.
-- applied and discarded are terminal. The row holds no report text, patient name or inserted text: only the SHA-256 of the
-- request and of the proposed draft (lowercase hex) and the identity/boundary values the server compares.
-- No foreign key: deleting the study, clearing, discarding, committing or force-discarding the draft, or a new draft epoch never
-- removes a receipt. No TTL or clean-up job here (no new statutory retention decision); a later migration that has to remove or
-- change receipts must state how it handles the guard below.
BEGIN;
CREATE TABLE "ReportDraftInsertReceipt" (
    "insertRequestId" UUID NOT NULL,
    "targetUid" TEXT NOT NULL,
    "ownerInstitution" TEXT NOT NULL,
    "ownerSub" TEXT NOT NULL,
    "ownerAuthor" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "proposalHash" CHAR(64) NOT NULL,
    "expectedEpoch" UUID NOT NULL,
    "expectedRevision" INTEGER NOT NULL,
    "sourceUid" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "targetBaseVersion" INTEGER NOT NULL,
    "section" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "appliedRevision" INTEGER,
    "reason" TEXT,
    "receiptRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportDraftInsertReceipt_pkey" PRIMARY KEY ("insertRequestId"),
    -- A CHECK passes when its expression is NULL, so every clause reads only NOT NULL columns or tests IS NULL / IS NOT NULL
    -- first, and the whole expression is COALESCEd to false: a NULL never makes a clause unknown. expectedRevision stops one
    -- below the Int maximum so that appliedRevision = expectedRevision + 1 never overflows.
    CONSTRAINT "ReportDraftInsertReceipt_values_check" CHECK (COALESCE(
        length("targetUid") > 0 AND length("sourceUid") > 0
        AND length("ownerInstitution") > 0 AND length("ownerSub") > 0 AND length("ownerAuthor") > 0
        AND "requestHash" ~ '^[0-9a-f]{64}$' AND "proposalHash" ~ '^[0-9a-f]{64}$'
        AND "expectedRevision" >= 0 AND "expectedRevision" <= 2147483646
        AND "sourceVersion" >= 1 AND "targetBaseVersion" >= 0 AND "receiptRevision" >= 1
        AND "section" IN ('findings', 'conclusion'),
        false)),
    -- applied: the draft revision it wrote and no reason; refused/discarded: no revision and one closed reason code.
    CONSTRAINT "ReportDraftInsertReceipt_state_check" CHECK (COALESCE(
        ("state" = 'applied' AND "appliedRevision" IS NOT NULL AND "appliedRevision" = "expectedRevision" + 1
            AND "reason" IS NULL)
        OR ("state" = 'refused' AND "appliedRevision" IS NULL AND "reason" IS NOT NULL
            AND "reason" IN ('DRAFT_CONFLICT', 'TARGET_UNVERIFIED', 'TARGET_HELD', 'SOURCE_UNAVAILABLE', 'SOURCE_CHANGED',
                             'SEED_CHANGED'))
        OR ("state" = 'discarded' AND "appliedRevision" IS NULL AND "reason" IS NOT NULL AND "reason" = 'INSERT_DISCARDED'),
        false))
);

-- The Check and the owner's view of one Target read by these four values.
CREATE INDEX "ReportDraftInsertReceipt_targetUid_ownerInstitution_ownerSu_idx" ON "ReportDraftInsertReceipt"("targetUid", "ownerInstitution", "ownerSub", "ownerAuthor");

-- The terminal guard (pattern of 20260930120000_audit_log_append_only): the runtime role is the table owner or holds DML through
-- the EMR-B1 default privileges, so a privilege cannot take UPDATE, DELETE or TRUNCATE away; a trigger refuses them for every
-- role instead and, being a schema object, travels with every backup and product transfer restore (their --no-privileges drops
-- GRANTs). SQLSTATE 42501 (insufficient_privilege) like that guard. There is no INSERT trigger: a restore copies terminal rows
-- in as they are, and the CHECKs above already close every inserted row's shape. Allowed UPDATE: a refused row only, to
-- refused/applied/discarded, receiptRevision exactly + 1, every identity, binding, hash and createdAt column unchanged.
CREATE FUNCTION "report_draft_insert_receipt_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."state" IS DISTINCT FROM 'refused' THEN
      RAISE EXCEPTION 'ReportDraftInsertReceipt is terminal once %: UPDATE refused', OLD."state" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."receiptRevision" IS DISTINCT FROM OLD."receiptRevision" + 1
       OR (NEW."insertRequestId", NEW."targetUid", NEW."ownerInstitution", NEW."ownerSub", NEW."ownerAuthor", NEW."requestHash",
           NEW."proposalHash", NEW."expectedEpoch", NEW."expectedRevision", NEW."sourceUid", NEW."sourceVersion",
           NEW."targetBaseVersion", NEW."section", NEW."createdAt")
          IS DISTINCT FROM
          (OLD."insertRequestId", OLD."targetUid", OLD."ownerInstitution", OLD."ownerSub", OLD."ownerAuthor", OLD."requestHash",
           OLD."proposalHash", OLD."expectedEpoch", OLD."expectedRevision", OLD."sourceUid", OLD."sourceVersion",
           OLD."targetBaseVersion", OLD."section", OLD."createdAt") THEN
      RAISE EXCEPTION 'ReportDraftInsertReceipt keeps its binding and moves one receipt revision at a time: UPDATE refused'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ReportDraftInsertReceipt is never removed: % refused', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER "ReportDraftInsertReceipt_guard_row" BEFORE UPDATE OR DELETE ON "ReportDraftInsertReceipt"
  FOR EACH ROW EXECUTE FUNCTION "report_draft_insert_receipt_guard"();
CREATE TRIGGER "ReportDraftInsertReceipt_guard_truncate" BEFORE TRUNCATE ON "ReportDraftInsertReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION "report_draft_insert_receipt_guard"();
COMMIT;
