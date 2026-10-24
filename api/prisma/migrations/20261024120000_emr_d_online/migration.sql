-- Original command bytes are pending work, never an independent success ledger.
BEGIN;
CREATE SCHEMA emr_clinical;
CREATE TABLE emr_clinical.online_command (
  record_type text NOT NULL,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  operation_id uuid NOT NULL UNIQUE,
  body text NOT NULL,
  PRIMARY KEY (record_type, actor_id, request_id)
);
CREATE TABLE emr_clinical.online_version (
  record_type text NOT NULL,
  record_id text NOT NULL,
  version_id text PRIMARY KEY,
  sequence integer NOT NULL CHECK (sequence > 0),
  operation_id uuid NOT NULL UNIQUE REFERENCES emr_clinical.online_command(operation_id),
  body text NOT NULL,
  signature text,
  UNIQUE (record_type, record_id, sequence)
);
CREATE TABLE emr_clinical.online_reference (
  version_id text NOT NULL REFERENCES emr_clinical.online_version(version_id),
  source_kind text NOT NULL,
  source_record_id text NOT NULL,
  source_version_id text NOT NULL,
  source_sha256 text NOT NULL,
  PRIMARY KEY (version_id, source_kind, source_record_id, source_version_id)
);
GRANT USAGE ON SCHEMA emr_clinical TO kin_runtime;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA emr_clinical TO kin_runtime;
COMMIT;
