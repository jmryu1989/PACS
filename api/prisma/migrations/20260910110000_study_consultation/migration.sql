CREATE TABLE "StudyConsultation" (
  "id" UUID NOT NULL,
  "studyUid" TEXT NOT NULL,
  "institutionId" VARCHAR(256) NOT NULL,
  "requesterSub" VARCHAR(256) NOT NULL,
  "requesterActor" VARCHAR(256) NOT NULL,
  "recipientSub" VARCHAR(256) NOT NULL,
  "recipientActor" VARCHAR(256) NOT NULL,
  "recipientName" VARCHAR(256) NOT NULL,
  "reason" VARCHAR(2000) NOT NULL,
  "reply" VARCHAR(2000),
  "cancelReason" VARCHAR(2000),
  "state" VARCHAR(16) NOT NULL,
  "revision" INTEGER NOT NULL,
  "changedBy" VARCHAR(256) NOT NULL,
  "creationFingerprint" TEXT NOT NULL,
  "lastRequest" UUID NOT NULL,
  "lastFingerprint" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudyConsultation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StudyConsultation_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "StudyConsultation_state_check" CHECK ("state" IN ('Requested','Accepted','Completed','Cancelled')),
  CONSTRAINT "StudyConsultation_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "StudyConsultation_participants_check" CHECK ("requesterSub" <> "recipientSub")
);
CREATE INDEX "StudyConsultation_institutionId_recipientSub_createdAt_id_idx" ON "StudyConsultation"("institutionId","recipientSub","createdAt","id");
CREATE INDEX "StudyConsultation_institutionId_requesterSub_createdAt_id_idx" ON "StudyConsultation"("institutionId","requesterSub","createdAt","id");
CREATE UNIQUE INDEX "StudyConsultation_active_recipient_key" ON "StudyConsultation"("studyUid","recipientSub") WHERE "state" IN ('Requested','Accepted');
