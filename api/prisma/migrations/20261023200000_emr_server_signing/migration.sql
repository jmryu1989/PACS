-- C2 core only. Integration must include the schema/catalog/restore owner handoff.
-- The ledger is B2-owned; no ledger or role framework is created here.
CREATE SCHEMA emr_signing;
REVOKE ALL ON SCHEMA emr_signing FROM PUBLIC;

CREATE TABLE emr_signing.doctor_key (
  kid text PRIMARY KEY,
  institution_id text NOT NULL,
  doctor_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','suspended','revoked')),
  registration jsonb NOT NULL
);
CREATE UNIQUE INDEX doctor_one_active_signing_key ON emr_signing.doctor_key(institution_id,doctor_id) WHERE status='active';
CREATE TABLE emr_signing.private_key (
  kid text PRIMARY KEY REFERENCES emr_signing.doctor_key(kid),
  wrapped jsonb NOT NULL
);
CREATE TABLE emr_signing.key_history (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kid text NOT NULL REFERENCES emr_signing.doctor_key(kid),
  event jsonb NOT NULL
);
CREATE TABLE emr_signing.operation (
  operation_id text PRIMARY KEY,
  fingerprint text NOT NULL,
  outcome jsonb
);
CREATE TABLE emr_signing.signed_version (
  record_id text NOT NULL,
  version_id text NOT NULL,
  kid text NOT NULL REFERENCES emr_signing.doctor_key(kid),
  outcome jsonb NOT NULL,
  PRIMARY KEY(record_id,version_id)
);
-- Deployment grants private_key only to the signing service/custodian. Routine query/export
-- roles receive the public registry/history as needed. Wrapping secrets are outside PostgreSQL.
REVOKE ALL ON ALL TABLES IN SCHEMA emr_signing FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA emr_signing FROM PUBLIC;
-- Reuse the existing API/signing transaction credential and read-only legal-log credential.
GRANT USAGE ON SCHEMA emr_signing TO kin_runtime, kin_emr_reader;
GRANT SELECT, INSERT, UPDATE ON emr_signing.doctor_key, emr_signing.operation TO kin_runtime;
GRANT SELECT, INSERT ON emr_signing.private_key, emr_signing.key_history, emr_signing.signed_version TO kin_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA emr_signing TO kin_runtime;
GRANT SELECT ON emr_signing.doctor_key, emr_signing.key_history TO kin_emr_reader;
