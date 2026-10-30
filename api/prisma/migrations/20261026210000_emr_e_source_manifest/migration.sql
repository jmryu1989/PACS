-- E_ROUTE R244-02: a preparation names the exact study-manifest body it was prepared from. That body is kept once
-- (keyed by the SHA-256 of its exact JSON text) instead of once per delivered response: a 200-slice CT repeated the
-- same whole-study body, about 160 KB, for every frame inside the B2 commit transaction. Rows written before this
-- migration keep their own copy; nothing is rewritten.
BEGIN;
CREATE TABLE emr_image.source_manifest (
  body_sha256 text PRIMARY KEY CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  study_uid text NOT NULL,
  body jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (body->>'studyUid' = study_uid AND body->>'sha256' ~ '^[0-9a-f]{64}$')
);
ALTER TABLE emr_image.preparation
  ALTER COLUMN source_manifest DROP NOT NULL,
  ADD COLUMN source_manifest_body text REFERENCES emr_image.source_manifest(body_sha256),
  ADD CONSTRAINT preparation_one_source_manifest CHECK ((source_manifest IS NULL) <> (source_manifest_body IS NULL));
GRANT SELECT, INSERT ON emr_image.source_manifest TO kin_runtime;
COMMIT;
