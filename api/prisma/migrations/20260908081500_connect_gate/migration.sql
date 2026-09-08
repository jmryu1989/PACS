-- Additive evidence/request records. No existing rows or access grants change.
CREATE TABLE "TransferBasis" (
 "id" UUID NOT NULL PRIMARY KEY, "studyUid" TEXT NOT NULL, "institutionId" TEXT NOT NULL,
 "kind" TEXT NOT NULL, "reference" VARCHAR(1000) NOT NULL, "obtainedAt" TIMESTAMP(3) NOT NULL,
 "expiresAt" TIMESTAMP(3), "recordedBy" TEXT NOT NULL, "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "revokedBy" TEXT, "revokedAt" TIMESTAMP(3), "revokeReason" VARCHAR(1000),
 CONSTRAINT "TransferBasis_kind_check" CHECK ("kind" IN ('PATIENT_CONSENT','LEGAL_BASIS')),
 CONSTRAINT "TransferBasis_reference_check" CHECK (length(btrim("reference")) > 0),
 CONSTRAINT "TransferBasis_dates_check" CHECK ("expiresAt" IS NULL OR "expiresAt" > "obtainedAt"),
 CONSTRAINT "TransferBasis_revoke_check" CHECK (("revokedAt" IS NULL AND "revokedBy" IS NULL AND "revokeReason" IS NULL) OR
   ("revokedAt" IS NOT NULL AND "revokedBy" IS NOT NULL AND "revokeReason" IS NOT NULL AND length(btrim("revokeReason")) > 0)),
 CONSTRAINT "TransferBasis_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "TransferBasis_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "ProcessingAgreement" (
 "id" UUID NOT NULL PRIMARY KEY, "fromInstitutionId" TEXT NOT NULL, "toInstitutionId" TEXT NOT NULL,
 "kind" TEXT NOT NULL, "reference" VARCHAR(1000) NOT NULL, "validFrom" TIMESTAMP(3) NOT NULL, "validTo" TIMESTAMP(3),
 "status" TEXT NOT NULL DEFAULT 'active', "recordedBy" TEXT NOT NULL, "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "terminatedBy" TEXT, "terminatedAt" TIMESTAMP(3), "terminationReason" VARCHAR(1000),
 CONSTRAINT "ProcessingAgreement_kind_check" CHECK ("kind" = 'CONTRACT'),
 CONSTRAINT "ProcessingAgreement_reference_check" CHECK (length(btrim("reference")) > 0),
 CONSTRAINT "ProcessingAgreement_pair_check" CHECK ("fromInstitutionId" <> "toInstitutionId"),
 CONSTRAINT "ProcessingAgreement_dates_check" CHECK ("validTo" IS NULL OR "validTo" > "validFrom"),
 CONSTRAINT "ProcessingAgreement_status_check" CHECK (("status"='active' AND "terminatedAt" IS NULL AND "terminatedBy" IS NULL AND "terminationReason" IS NULL) OR
   ("status"='terminated' AND "terminatedAt" IS NOT NULL AND "terminatedBy" IS NOT NULL AND "terminationReason" IS NOT NULL AND length(btrim("terminationReason")) > 0)),
 CONSTRAINT "ProcessingAgreement_fromInstitutionId_fkey" FOREIGN KEY ("fromInstitutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProcessingAgreement_toInstitutionId_fkey" FOREIGN KEY ("toInstitutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "Transfer" (
 "id" UUID NOT NULL PRIMARY KEY, "studyUid" TEXT NOT NULL, "fromInstitutionId" TEXT NOT NULL, "toInstitutionId" TEXT NOT NULL,
 "basisId" UUID NOT NULL, "agreementId" UUID NOT NULL, "status" TEXT NOT NULL, "sourcePatientKey" TEXT NOT NULL,
 "requestedBy" TEXT NOT NULL, "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3) NOT NULL,
 "decidedBy" TEXT, "decidedAt" TIMESTAMP(3), "decisionReason" VARCHAR(1000), "localPatientId" TEXT,
 "importRequestedAt" TIMESTAMP(3), "importRequestedBy" TEXT, "importedAt" TIMESTAMP(3),
 CONSTRAINT "Transfer_status_check" CHECK ("status" IN ('OPEN','ACCEPTED','REJECTED','REVOKED','EXPIRED')),
 CONSTRAINT "Transfer_pair_check" CHECK ("fromInstitutionId" <> "toInstitutionId"),
 CONSTRAINT "Transfer_dates_check" CHECK ("expiresAt" > "requestedAt"),
 CONSTRAINT "Transfer_source_check" CHECK (length("sourcePatientKey") > 0),
 CONSTRAINT "Transfer_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "Transfer_basisId_fkey" FOREIGN KEY ("basisId") REFERENCES "TransferBasis"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "Transfer_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "ProcessingAgreement"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "Transfer_fromInstitutionId_fkey" FOREIGN KEY ("fromInstitutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "Transfer_toInstitutionId_fkey" FOREIGN KEY ("toInstitutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "TransferBasis_studyUid_id_idx" ON "TransferBasis"("studyUid","id");
CREATE INDEX "ProcessingAgreement_fromInstitutionId_toInstitutionId_status_idx" ON "ProcessingAgreement"("fromInstitutionId","toInstitutionId","status");
CREATE INDEX "Transfer_studyUid_idx" ON "Transfer"("studyUid");
CREATE INDEX "Transfer_fromInstitutionId_id_idx" ON "Transfer"("fromInstitutionId","id");
CREATE INDEX "Transfer_toInstitutionId_status_idx" ON "Transfer"("toInstitutionId","status");
-- A concurrent retry must not create two live requests, even outside this process.
CREATE UNIQUE INDEX "Transfer_one_open_destination" ON "Transfer"("studyUid","toInstitutionId") WHERE "status" IN ('OPEN','ACCEPTED');
