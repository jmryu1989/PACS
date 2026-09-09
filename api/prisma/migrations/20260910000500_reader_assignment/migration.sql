CREATE TABLE "ReaderAssignment" (
 "studyUid" TEXT NOT NULL,
 "institutionId" VARCHAR(256) NOT NULL,
 "revision" INTEGER NOT NULL,
 "readerSub" VARCHAR(256),
 "readerActor" VARCHAR(256),
 "readerName" VARCHAR(256),
 "changedBy" VARCHAR(256) NOT NULL,
 "lastRequest" UUID NOT NULL,
 "lastFingerprint" TEXT NOT NULL,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ReaderAssignment_pkey" PRIMARY KEY ("studyUid")
);
