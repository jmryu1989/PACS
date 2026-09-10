CREATE TABLE "UserFilterCollection" (
    "owner" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "folders" JSONB NOT NULL DEFAULT '[]',
    CONSTRAINT "UserFilterCollection_pkey" PRIMARY KEY ("owner")
);
