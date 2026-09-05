-- CreateTable
CREATE TABLE "AuthSession" (
    "sid" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "atExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("sid")
);

-- CreateTable
CREATE TABLE "Institution" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'hospital',
    "dicomNames" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Institution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudyState" (
    "uid" TEXT NOT NULL,
    "institutionId" TEXT,
    "teleInstitutionId" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'dicom',
    "rs" TEXT NOT NULL DEFAULT 'W',
    "holdReason" TEXT,
    "ss" TEXT NOT NULL DEFAULT 'Verified',
    "em" TEXT NOT NULL DEFAULT 'N',
    "ts" TEXT NOT NULL DEFAULT 'none',
    "matched" TEXT NOT NULL DEFAULT 'U',
    "ward" TEXT NOT NULL DEFAULT '',
    "reqHosp" TEXT NOT NULL DEFAULT 'KIN',
    "repDoc" TEXT,
    "confirm" TEXT,
    "preDoc" TEXT,
    "preReviewer" TEXT,
    "ov" TEXT,
    "orig" TEXT,
    "orderOid" TEXT,
    "holder" TEXT,
    "heldAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudyState_pkey" PRIMARY KEY ("uid")
);

-- CreateTable
CREATE TABLE "Report" (
    "uid" TEXT NOT NULL,
    "findings" TEXT NOT NULL DEFAULT '',
    "conclusion" TEXT NOT NULL DEFAULT '',
    "recommendation" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("uid")
);

-- CreateTable
CREATE TABLE "ReportDraft" (
    "uid" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "findings" TEXT NOT NULL DEFAULT '',
    "conclusion" TEXT NOT NULL DEFAULT '',
    "recommendation" TEXT NOT NULL DEFAULT '',
    "baseVersion" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportDraft_pkey" PRIMARY KEY ("uid","author")
);

-- CreateTable
CREATE TABLE "ReportVersion" (
    "id" SERIAL NOT NULL,
    "uid" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "findings" TEXT NOT NULL DEFAULT '',
    "conclusion" TEXT NOT NULL DEFAULT '',
    "recommendation" TEXT NOT NULL DEFAULT '',
    "reason" TEXT,
    "author" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "oid" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL DEFAULT 'hallym',
    "patientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sex" TEXT NOT NULL,
    "birth" TEXT NOT NULL,
    "sched" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "descr" TEXT NOT NULL,
    "ward" TEXT NOT NULL,
    "reqDoc" TEXT NOT NULL,
    "matched" TEXT NOT NULL DEFAULT 'U',
    "studyUid" TEXT,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("oid")
);

-- CreateTable
CREATE TABLE "UserFilter" (
    "id" SERIAL NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'Radiology',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "quick" TEXT NOT NULL DEFAULT '',
    "days" INTEGER NOT NULL DEFAULT -1,
    "cols" TEXT NOT NULL DEFAULT '{}',
    "sortKey" TEXT,
    "sortDir" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserFilter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadingTemplate" (
    "id" SERIAL NOT NULL,
    "owner" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "shortcut" TEXT NOT NULL DEFAULT '',
    "modality" TEXT NOT NULL DEFAULT '',
    "bodypart" TEXT NOT NULL DEFAULT '',
    "findings" TEXT NOT NULL DEFAULT '',
    "conclusion" TEXT NOT NULL DEFAULT '',
    "recommendation" TEXT NOT NULL DEFAULT '',
    "ord" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReadingTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthSession_sub_idx" ON "AuthSession"("sub");

-- CreateIndex
CREATE UNIQUE INDEX "StudyState_orderOid_key" ON "StudyState"("orderOid");

-- CreateIndex
CREATE INDEX "StudyState_institutionId_idx" ON "StudyState"("institutionId");

-- CreateIndex
CREATE INDEX "StudyState_teleInstitutionId_idx" ON "StudyState"("teleInstitutionId");

-- CreateIndex
CREATE INDEX "ReportDraft_uid_idx" ON "ReportDraft"("uid");

-- CreateIndex
CREATE INDEX "ReportVersion_uid_idx" ON "ReportVersion"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_uid_version_key" ON "ReportVersion"("uid", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Order_studyUid_key" ON "Order"("studyUid");

-- CreateIndex
CREATE INDEX "Order_institutionId_idx" ON "Order"("institutionId");

-- CreateIndex
CREATE INDEX "UserFilter_owner_idx" ON "UserFilter"("owner");

-- CreateIndex
CREATE UNIQUE INDEX "UserFilter_owner_name_key" ON "UserFilter"("owner", "name");

-- CreateIndex
CREATE INDEX "ReadingTemplate_owner_idx" ON "ReadingTemplate"("owner");

-- CreateIndex
CREATE INDEX "AuditLog_target_idx" ON "AuditLog"("target");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_uid_fkey" FOREIGN KEY ("uid") REFERENCES "StudyState"("uid") ON DELETE CASCADE ON UPDATE CASCADE;
