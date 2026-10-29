-- H delta after #244: image delivery details have the lifetime of their access
-- records (access-safety art.8(1)(2), Privacy Act art.21). The existing expiry
-- function owns the period, record-history evidence and legal-duty/hold checks.
-- Do not expire an opening's details while its terminal or another stream lives.
BEGIN;
CREATE INDEX access_entry_related_event ON emr_access.access_entry
  ((payload::jsonb->>'relatedEventId')) TABLESPACE kin_emr_access;

-- A later delivery's preparation may expire before its terminal. Keep only the
-- opening link until that delivery's last access record expires, including holds.
CREATE TABLE emr_image.expiring_delivery_link (
  delivery_event_id text PRIMARY KEY,
  opening_event_id text NOT NULL
);
CREATE INDEX expiring_delivery_opening ON emr_image.expiring_delivery_link(opening_event_id);

CREATE FUNCTION emr_image.expire_delivery_details() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE delivery text; opening text; candidate text; manifests text[];
BEGIN
  IF OLD.payload::jsonb->>'action' = 'provide-prepared' THEN
    delivery := OLD.event_id;
    opening := OLD.payload::jsonb->>'relatedEventId';
    IF opening IS NOT NULL THEN
      INSERT INTO emr_image.expiring_delivery_link VALUES (delivery, opening)
        ON CONFLICT (delivery_event_id) DO NOTHING;
    END IF;
  ELSIF OLD.payload::jsonb->>'action' IN ('transfer-ended','transfer-aborted') THEN
    delivery := OLD.payload::jsonb->>'relatedEventId';
  ELSE
    RETURN OLD;
  END IF;
  IF delivery IS NULL
    OR EXISTS (SELECT FROM emr_access.access_entry WHERE stream IN ('viewing','history') AND event_id=delivery)
    OR EXISTS (SELECT FROM emr_access.access_entry WHERE payload::jsonb->>'relatedEventId'=delivery) THEN
    RETURN OLD;
  END IF;
  DELETE FROM emr_image.expiring_delivery_link WHERE delivery_event_id=delivery
    RETURNING opening_event_id INTO opening;
  FOREACH candidate IN ARRAY ARRAY[delivery, opening] LOOP
    -- Non-image events can have non-UUID identifiers; they have no E delivery rows.
    IF candidate IS NULL OR candidate !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      OR EXISTS (SELECT FROM emr_access.access_entry WHERE stream IN ('viewing','history') AND event_id=candidate)
      OR EXISTS (SELECT FROM emr_access.access_entry WHERE payload::jsonb->>'relatedEventId'=candidate)
      OR EXISTS (SELECT FROM emr_image.expiring_delivery_link WHERE opening_event_id=candidate) THEN
      CONTINUE;
    END IF;
    SELECT array_agg(DISTINCT source_manifest_body) INTO manifests
      FROM emr_image.preparation WHERE delivery_event_id=candidate::uuid;
    -- A failed preparation can still have observations; do not join through it.
    DELETE FROM emr_image.observation WHERE delivery_event_id=candidate::uuid;
    DELETE FROM emr_image.preparation WHERE delivery_event_id=candidate::uuid;
    DELETE FROM emr_image.source_manifest m WHERE m.body_sha256=ANY(manifests)
      AND NOT EXISTS (SELECT FROM emr_image.preparation p WHERE p.source_manifest_body=m.body_sha256);
  END LOOP;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION emr_image.expire_delivery_details() FROM PUBLIC;
CREATE TRIGGER access_expire_image_details AFTER DELETE ON emr_access.access_entry
  FOR EACH ROW EXECUTE FUNCTION emr_image.expire_delivery_details();
COMMIT;
