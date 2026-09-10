BEGIN;
CREATE TABLE "StudyAccessPolicy" (
  institution VARCHAR(256) NOT NULL,
  subject VARCHAR(256) NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  policy JSONB NOT NULL CHECK ((jsonb_typeof(policy) = 'object' AND policy->'version' = '1'::jsonb AND jsonb_typeof(policy->'restricted') = 'boolean' AND jsonb_typeof(policy->'rules') = 'array') IS TRUE),
  reason VARCHAR(2000) NOT NULL CHECK (length(btrim(reason)) > 0),
  "updatedBy" VARCHAR(256) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudyAccessPolicy_pkey" PRIMARY KEY (institution,subject),
  CONSTRAINT "StudyAccessPolicy_institution_fkey" FOREIGN KEY (institution) REFERENCES "Institution"(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "StudyAccessRevision" (
  institution VARCHAR(256) NOT NULL,
  subject VARCHAR(256) NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  policy JSONB NOT NULL CHECK ((jsonb_typeof(policy) = 'object' AND policy->'version' = '1'::jsonb AND jsonb_typeof(policy->'restricted') = 'boolean' AND jsonb_typeof(policy->'rules') = 'array') IS TRUE),
  reason VARCHAR(2000) NOT NULL CHECK (length(btrim(reason)) > 0),
  "authorSub" VARCHAR(256) NOT NULL,
  author VARCHAR(256) NOT NULL,
  "requestId" UUID NOT NULL,
  fingerprint TEXT NOT NULL,
  at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudyAccessRevision_pkey" PRIMARY KEY (institution,subject,revision),
  CONSTRAINT "StudyAccessRevision_request_key" UNIQUE (institution,subject,"requestId"),
  CONSTRAINT "StudyAccessRevision_policy_fkey" FOREIGN KEY (institution,subject) REFERENCES "StudyAccessPolicy"(institution,subject) ON DELETE RESTRICT ON UPDATE RESTRICT
);
COMMIT;
