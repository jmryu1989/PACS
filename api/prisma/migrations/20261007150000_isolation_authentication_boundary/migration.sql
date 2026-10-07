-- Forward-only: existing isolation remains blocking; completed membership changes survive reactivation.
ALTER TABLE "MemberIsolation" ADD COLUMN "credentialsPending" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "MemberCredential" (
    "sub" TEXT NOT NULL,
    "groups" TEXT[] NOT NULL,
    "roles" TEXT[] NOT NULL,
    CONSTRAINT "MemberCredential_pkey" PRIMARY KEY ("sub")
);
