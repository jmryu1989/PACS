-- E image representations and copy/transport facts; B2 remains the success ledger.
BEGIN;
CREATE SCHEMA emr_image;
CREATE TABLE emr_image.preparation (
  event_id uuid PRIMARY KEY,
  study_uid text NOT NULL,
  source_manifest jsonb NOT NULL,
  response_manifest jsonb NOT NULL,
  staging_copies jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE emr_image.observation (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('transport', 'copies')),
  body jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Failed preparation and lost COMMIT responses still have real staging copies;
-- therefore observations cannot require a committed preparation row.
CREATE INDEX observation_event ON emr_image.observation(event_id, sequence);
GRANT USAGE ON SCHEMA emr_image TO kin_runtime;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA emr_image TO kin_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA emr_image TO kin_runtime;
COMMIT;
