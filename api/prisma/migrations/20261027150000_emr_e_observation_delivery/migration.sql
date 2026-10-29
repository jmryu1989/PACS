-- E_ROUTE R244-GPT-02/03: a transport or copy observation names the study delivery's access record and the HTTP
-- request itself, so a failed preparation's copy observation (no preparation row) is still found from its record, and
-- a row the application connection refused is written when the delivery closes with the first failure's cause in
-- retained_after (NULL for a row written on the response's own path). Rows written before this migration keep NULLs
-- and are found through their preparation row as before. Nothing is rewritten.
BEGIN;
ALTER TABLE emr_image.observation
  ADD COLUMN delivery_event_id uuid,
  ADD COLUMN request_id text,
  ADD COLUMN retained_after text;
CREATE INDEX observation_delivery ON emr_image.observation(delivery_event_id);
COMMIT;
