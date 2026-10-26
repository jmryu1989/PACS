-- E_ROUTE R244-02: the 의료법 제23조④ access record of viewing is the study delivery (one B2 provide-prepared event per
-- requester, session and manifest version, closed by one terminal event), not every HTTP frame response. Each response
-- row now names the delivery's event it was provided under and the HTTP request it answered. Rows written before this
-- migration are their own record: their event_id is the B2 event and delivery_event_id stays NULL. Nothing is rewritten.
BEGIN;
ALTER TABLE emr_image.preparation
  ADD COLUMN delivery_event_id uuid,
  ADD COLUMN request_id text;
CREATE INDEX preparation_delivery ON emr_image.preparation(delivery_event_id);
COMMIT;
