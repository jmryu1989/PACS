-- S7-U5 (review N-1 of c282c6b) the isolation's generation is never reused. An Activate deletes the member's
-- MemberIsolation row and the next Suspend creates a new one whose "attempts" counts again from 0, so a claim number held
-- by a stalled finisher of the earlier isolation could match the new isolation. "epoch" is the row's own number from a
-- sequence: a re-created row never gets the number of an earlier row, and the generation is (epoch, attempts).
-- Existing rows take distinct numbers from the sequence. No other table or row changes; AuditLog is not touched.
BEGIN;
ALTER TABLE "MemberIsolation" ADD COLUMN "epoch" SERIAL NOT NULL;
CREATE UNIQUE INDEX "MemberIsolation_epoch_key" ON "MemberIsolation"("epoch");
COMMIT;
