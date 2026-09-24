-- S4-U2: the order side gains a nullable accession for the engineering-only order reconciliation.
-- Additive only: no default and no backfill. Every order that exists today is a code seed without an
-- accession, and NULL is exactly that - "not comparable", never a value that could pair with a study.
-- Inventing a value here would create pairs that no site order source ever stated.
BEGIN;
ALTER TABLE "Order" ADD COLUMN "accession" TEXT;
COMMIT;
