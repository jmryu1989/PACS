CREATE TABLE "TechNoteRevision" (
  "studyUid" TEXT NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "text" VARCHAR(10000) NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "author" TEXT NOT NULL,
  "authorSub" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TechNoteRevision_pkey" PRIMARY KEY ("studyUid", "version"),
  CONSTRAINT "TechNoteRevision_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE RESTRICT ON UPDATE CASCADE
);
