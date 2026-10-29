-- Digests of each stored archive file, made when the study arrives (or by its first opening) so that a later first
-- opening joins them instead of reading every original and frame again. Keyed by the stored file: Orthanc writes
-- changed bytes to a new file (new FileUuid), so a row never stands for other bytes, and a row of a file that is no
-- longer listed is simply not joined. Not a record: E still hashes every byte it stages against the manifest.
BEGIN;
CREATE TABLE emr_image.object_digest (
  instance_id text NOT NULL,
  file_uuid text NOT NULL,
  sop_instance_uid text NOT NULL,
  transfer_syntax_uid text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  frames jsonb NOT NULL CHECK (jsonb_typeof(frames) = 'array'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (instance_id, file_uuid)
);
GRANT SELECT, INSERT ON emr_image.object_digest TO kin_runtime;
COMMIT;
