-- EMR-D round 2 (REQ-EMR-01/03/04/05/07/10/17, D589/D591/D593/D603): the clinical attached-record version store.
--
-- Storage boundary. Schema emr_clinical holds the append-only versions of questions, answers, consultations, findings,
-- image requests, reader assignments and manual SR adoptions, beside the access ledger (schema emr_access, EMR-B1) in the
-- same PostgreSQL database: a clinical version, its request register row and its access event commit in ONE transaction
-- (api/src/emr-clinical/store.ts runs this schema's functions and B1's append inside AccessLedgerStore.withAppendTransaction).
-- Everything is owned by the non-login role kin_emr_owner and placed in the protected tablespace kin_emr_access, which
-- the EMR-B provisioning creates before migrations (scripts/emr-compose.py provision). When the tablespace is absent the
-- relations sit in the database default and every write refuses with EmrClinicalPlacementRequired (ED001): there is no
-- silent public fallback.
--
-- Authority. The runtime role kin_runtime holds only EXECUTE on the functions below, never INSERT/UPDATE/DELETE on a
-- table, ownership or membership. Versions, attachment references, the attempt journal, SR adoptions and SR purpose ends
-- are append-only for every role, the owner included. The unit projection row moves only inside commit_version and the
-- request register only inside its own functions (each marks its transaction first). No deletion exists here: a
-- version leaves only with its record's destruction set (unit H), through a later reviewed path.
--
-- Request register (B1/B2 handover of api/src/emr-clinical/records.ts ClinicalStorePort). One row per (record, actor,
-- request ID) fixes the fingerprint, the original ID, the epoch and the exact seed of the first admission; later
-- calls with the same key are observations, another meaning under the key is RequestIdReused (ED002). A checkpoint or
-- commit with a fenced epoch changes nothing; commit_version refuses unless the row is at commit-dispatched for exactly
-- that original and epoch (ED004), and refuses a version that does not extend the stored head (ED003). Recovery takes
-- the row lock - which a running commit holds - so a dispatched original still pending under the lock committed
-- nothing; recovery then fences it and seals StorageFailed. Elapsed time alone never decides anything here.
BEGIN;

DO $$
DECLARE
  emr_roles constant text[] := ARRAY['kin_emr_owner', 'kin_runtime', 'kin_emr_reader', 'kin_emr_retention'];
  r text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'EMR-D migration requires the installer credential' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH r IN ARRAY emr_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      RAISE EXCEPTION 'EMR-D requires the EMR-B roles (migration 20261008120000_emr_b)' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ANY (emr_roles)
             AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'EMR roles must not hold elevated attributes' USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;

CREATE SCHEMA emr_clinical AUTHORIZATION kin_emr_owner;
REVOKE ALL ON SCHEMA emr_clinical FROM PUBLIC;
GRANT USAGE ON SCHEMA emr_clinical TO kin_runtime, kin_emr_reader;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_tablespace WHERE spcname = 'kin_emr_access') THEN
    EXECUTE 'SET LOCAL default_tablespace = kin_emr_access';
  END IF;
END $$;
SET LOCAL ROLE kin_emr_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA emr_clinical REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- The projection of one clinical unit: always the fold of its versions (records.ts projectUnit re-derives and checks it
-- on every load). The permission-deciding parties are those of the opening version.
CREATE TABLE emr_clinical.unit (
  record_id text PRIMARY KEY CHECK (pg_catalog.length(record_id) BETWEEN 1 AND 200),
  record text NOT NULL CHECK (record IN ('question', 'consultation', 'finding', 'image-request', 'assignment', 'tech-note')),
  study_id text NOT NULL CHECK (pg_catalog.length(study_id) BETWEEN 1 AND 200),
  managing_institution_id text NOT NULL CHECK (pg_catalog.length(managing_institution_id) BETWEEN 1 AND 256),
  patient text NOT NULL CHECK (pg_catalog.octet_length(patient) <= 4096),
  author_id text NOT NULL CHECK (pg_catalog.length(author_id) BETWEEN 1 AND 200),
  recipient_id text CHECK (recipient_id IS NULL OR pg_catalog.length(recipient_id) BETWEEN 1 AND 200),
  state text NOT NULL CHECK (pg_catalog.length(state) BETWEEN 1 AND 32),
  revision integer NOT NULL CHECK (revision >= 1),
  head_version_id text NOT NULL CHECK (pg_catalog.length(head_version_id) BETWEEN 1 AND 200),
  head_sha256 text NOT NULL CHECK (head_sha256 ~ '^[0-9a-f]{64}$'),
  clinical_entry boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX unit_study ON emr_clinical.unit (study_id, record);

-- One immutable version: the exact JSON text records.ts planned (its sha256 is the version digest of that object), and
-- the signature C verified for it (envelope, evidence and C's signed-payload facts), or NULL when the version is not a
-- clinical entry.
CREATE TABLE emr_clinical.version (
  record_id text NOT NULL REFERENCES emr_clinical.unit (record_id),
  sequence integer NOT NULL CHECK (sequence >= 1),
  version_id text NOT NULL CHECK (pg_catalog.length(version_id) BETWEEN 1 AND 200),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  entry text NOT NULL CHECK (entry IN ('clinical-entry', 'operational-note', 'state-change', 'assignment')),
  body text NOT NULL CHECK (pg_catalog.octet_length(body) <= 262144),
  signature text CHECK (signature IS NULL OR pg_catalog.octet_length(signature) <= 65536),
  committed_at timestamptz NOT NULL,
  PRIMARY KEY (record_id, sequence),
  UNIQUE (record_id, version_id),
  -- A clinical entry is never stored without the signature verified for it; nothing else carries one.
  CHECK ((entry = 'clinical-entry') = (signature IS NOT NULL))
);

-- The fixed attachment references of each version, from the same version text: the reference index unit H and the
-- manual SR clean-up read to find what a retained record incorporates.
CREATE TABLE emr_clinical.attachment (
  record_id text NOT NULL,
  sequence integer NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  kind text NOT NULL CHECK (pg_catalog.length(kind) BETWEEN 1 AND 100),
  ref_record_id text NOT NULL CHECK (pg_catalog.length(ref_record_id) BETWEEN 1 AND 200),
  ref_version_id text NOT NULL CHECK (pg_catalog.length(ref_version_id) BETWEEN 1 AND 200),
  ref_sha256 text NOT NULL CHECK (ref_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (record_id, sequence, position),
  FOREIGN KEY (record_id, sequence) REFERENCES emr_clinical.version (record_id, sequence)
);
CREATE INDEX attachment_reference ON emr_clinical.attachment (ref_record_id, kind);

-- The request register (records.ts ClinicalStorePort K/F/O). seed and checkpoint hold the original input and the planned
-- work (with its clinical text) so that recovery resumes exactly the original intent; terminal holds the observation
-- that answers every later lookup. access_event is the exact change event appended with the commit; confirmed turns
-- true only after its durable ledger receipt was obtained.
CREATE TABLE emr_clinical.request (
  record text NOT NULL CHECK (record IN ('question', 'consultation', 'finding', 'image-request', 'assignment', 'tech-note')),
  actor_id text NOT NULL CHECK (pg_catalog.length(actor_id) BETWEEN 1 AND 200),
  request_id text NOT NULL CHECK (pg_catalog.length(request_id) BETWEEN 1 AND 200),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  original_id uuid NOT NULL UNIQUE,
  epoch integer NOT NULL CHECK (epoch >= 1),
  phase text NOT NULL CHECK (phase IN ('admitted', 'prepared', 'signed', 'commit-dispatched')),
  state text NOT NULL CHECK (state IN ('pending', 'committed', 'rejected')),
  seed text NOT NULL CHECK (pg_catalog.octet_length(seed) <= 524288),
  facts text NOT NULL CHECK (pg_catalog.octet_length(facts) <= 65536),
  envelope text CHECK (envelope IS NULL OR pg_catalog.octet_length(envelope) <= 65536),
  checkpoint text CHECK (checkpoint IS NULL OR pg_catalog.octet_length(checkpoint) <= 1048576),
  terminal text CHECK (terminal IS NULL OR pg_catalog.octet_length(terminal) <= 1048576),
  record_id text CHECK (record_id IS NULL OR pg_catalog.length(record_id) BETWEEN 1 AND 200),
  access_event text CHECK (access_event IS NULL OR pg_catalog.octet_length(access_event) <= 65536),
  confirmed boolean NOT NULL DEFAULT false,
  admitted_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (record, actor_id, request_id),
  CHECK ((state = 'pending') = (terminal IS NULL)),
  CHECK (state = 'committed' OR NOT confirmed),
  CHECK ((state = 'committed') = (access_event IS NOT NULL AND record_id IS NOT NULL))
);
CREATE INDEX request_open ON emr_clinical.request (admitted_at) WHERE state = 'pending' OR (state = 'committed' AND NOT confirmed);

-- The attempt journal (J): one row per attempt and closed code, never a clinical body.
CREATE TABLE emr_clinical.attempt (
  attempt_id text NOT NULL CHECK (pg_catalog.length(attempt_id) BETWEEN 1 AND 200),
  code text NOT NULL CHECK (code ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  record text,
  actor_id text,
  request_id text,
  original_id uuid,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (attempt_id, code)
);

-- A manual SR store intent is its author's signed adoption of the exact DICOM bytes and SOP (records.ts
-- planManualSrAdoption). One adoption per prepared SR; the bytes stay in "ManualSr" and must hash to bytes_sha256.
CREATE TABLE emr_clinical.sr_adoption (
  record_id text PRIMARY KEY CHECK (pg_catalog.length(record_id) BETWEEN 1 AND 200),
  version_id text NOT NULL CHECK (pg_catalog.length(version_id) BETWEEN 1 AND 200),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes_sha256 text NOT NULL CHECK (bytes_sha256 ~ '^[0-9a-f]{64}$'),
  sop_instance_uid text NOT NULL CHECK (pg_catalog.length(sop_instance_uid) BETWEEN 1 AND 64),
  study_id text NOT NULL CHECK (pg_catalog.length(study_id) BETWEEN 1 AND 200),
  managing_institution_id text NOT NULL CHECK (pg_catalog.length(managing_institution_id) BETWEEN 1 AND 256),
  body text NOT NULL CHECK (pg_catalog.octet_length(body) <= 65536),
  signature text NOT NULL CHECK (pg_catalog.octet_length(signature) <= 65536),
  access_event text NOT NULL CHECK (pg_catalog.octet_length(access_event) <= 65536),
  confirmed boolean NOT NULL DEFAULT false,
  committed_at timestamptz NOT NULL
);

-- The 24-hour preparation window ended for an unattempted, unadopted, unreferenced, unheld copy Orthanc confirmed it does
-- not hold (records.ts planManualSrCleanup). This is the hand-over to unit H's purpose-end destruction, which removes the
-- bytes; D itself never erases them.
CREATE TABLE emr_clinical.sr_purpose_end (
  record_id text PRIMARY KEY CHECK (pg_catalog.length(record_id) BETWEEN 1 AND 200),
  bytes_sha256 text NOT NULL CHECK (bytes_sha256 ~ '^[0-9a-f]{64}$'),
  purpose_end text NOT NULL CHECK (purpose_end IN ('preparation-window-ended')),
  observed_at timestamptz NOT NULL
);

CREATE FUNCTION emr_clinical.refuse_change() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Row fields are read only for the one table that has them (a statement-level TRUNCATE trigger has no row at all).
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'unit' AND current_setting('kin.emr_clinical', true) = 'commit' THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'request' AND current_setting('kin.emr_clinical', true) IN ('register', 'commit') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'sr_adoption' AND current_setting('kin.emr_clinical', true) = 'register' THEN
      IF NEW.confirmed AND NOT OLD.confirmed AND (to_jsonb(NEW) - 'confirmed') = (to_jsonb(OLD) - 'confirmed') THEN RETURN NEW; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'emr_clinical is append-only: % on % refused', TG_OP, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER unit_guard BEFORE UPDATE OR DELETE ON emr_clinical.unit FOR EACH ROW EXECUTE FUNCTION emr_clinical.refuse_change();
CREATE TRIGGER unit_truncate BEFORE TRUNCATE ON emr_clinical.unit FOR EACH STATEMENT EXECUTE FUNCTION emr_clinical.refuse_change();
CREATE TRIGGER version_guard BEFORE UPDATE OR DELETE ON emr_clinical.version FOR EACH ROW EXECUTE FUNCTION emr_clinical.refuse_change();
CREATE TRIGGER version_truncate BEFORE TRUNCATE ON emr_clinical.version FOR EACH STATEMENT EXECUTE FUNCTION emr_clinical.refuse_change();
CREATE TRIGGER attachment_guard BEFORE UPDATE OR DELETE ON emr_clinical.attachment FOR EACH ROW EXECUTE FUNCTION emr_clinical.refuse_change();
CREATE TRIGGER attachment_truncate BEFORE TRUNCATE ON emr_clinical.attachment FOR EACH STATEMENT EXECUTE FUNCTION emr_clinical.refuse_change();
CREATE TRIGGER request_guard BEFORE UPDATE OR DELETE ON emr_clinical.request FOR EACH ROW EXECUTE FUNCTION emr_clinical.refuse_change();
CREATE TRIGGER request_truncate BEFORE TRUNCATE ON emr_clinical.request FOR EACH STATEMENT EXECUTE FUNCTION emr_clinical.refuse_change();
CREATE TRIGGER attempt_guard BEFORE UPDATE OR DELETE ON emr_clinical.attempt FOR EACH ROW EXECUTE FUNCTION emr_clinical.refuse_change();
CREATE TRIGGER attempt_truncate BEFORE TRUNCATE ON emr_clinical.attempt FOR EACH STATEMENT EXECUTE FUNCTION emr_clinical.refuse_change();
CREATE TRIGGER sr_adoption_guard BEFORE UPDATE OR DELETE ON emr_clinical.sr_adoption FOR EACH ROW EXECUTE FUNCTION emr_clinical.refuse_change();
CREATE TRIGGER sr_adoption_truncate BEFORE TRUNCATE ON emr_clinical.sr_adoption FOR EACH STATEMENT EXECUTE FUNCTION emr_clinical.refuse_change();
CREATE TRIGGER sr_purpose_end_guard BEFORE UPDATE OR DELETE ON emr_clinical.sr_purpose_end FOR EACH ROW EXECUTE FUNCTION emr_clinical.refuse_change();
CREATE TRIGGER sr_purpose_end_truncate BEFORE TRUNCATE ON emr_clinical.sr_purpose_end FOR EACH STATEMENT EXECUTE FUNCTION emr_clinical.refuse_change();

-- Every relation of this schema, its indexes and TOAST storage must be in kin_emr_access; otherwise nothing is written.
CREATE FUNCTION emr_clinical.storage_placement() RETURNS TABLE (relation text, relkind text, tablespace text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH own AS (
    SELECT c.oid, c.relname::text AS relation, c.relkind::text AS relkind, c.reltablespace, c.reltoastrelid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'emr_clinical' AND c.relkind IN ('r', 'i')
  ), toast AS (
    SELECT t.oid, own.relation || ':toast' AS relation, 't'::text AS relkind, t.reltablespace FROM own JOIN pg_class t ON t.oid = own.reltoastrelid
    UNION ALL
    SELECT i.oid, own.relation || ':toast-index', 'i', i.reltablespace FROM own JOIN pg_index x ON x.indrelid = own.reltoastrelid JOIN pg_class i ON i.oid = x.indexrelid
  )
  SELECT p.relation, p.relkind, COALESCE((SELECT spcname::text FROM pg_tablespace s WHERE s.oid = p.reltablespace), 'database-default')
  FROM (SELECT relation, relkind, reltablespace FROM own UNION ALL SELECT relation, relkind, reltablespace FROM toast) p
  ORDER BY 1;
$$;
CREATE FUNCTION emr_clinical.require_placement() RETURNS void
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tablespace WHERE spcname = 'kin_emr_access')
     OR EXISTS (SELECT 1 FROM emr_clinical.storage_placement() p WHERE p.tablespace <> 'kin_emr_access') THEN
    RAISE EXCEPTION 'EmrClinicalPlacementRequired' USING ERRCODE = 'ED001';
  END IF;
END
$$;

-- One transaction lock per register key: admission, checkpoints, sealing, recovery and the commit serialize on it.
CREATE FUNCTION emr_clinical.lock_request(p_record text, p_actor text, p_request text) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('emr-clinical-request:' || p_record || chr(0) || p_actor || chr(0) || p_request, 0));
$$;

-- The register row as one result shape for admission, observation and recovery.
CREATE FUNCTION emr_clinical.request_view(r emr_clinical.request, p_kind text) RETURNS TABLE (
  kind text, original_id uuid, epoch integer, phase text, state text, seed text, facts text, envelope text, checkpoint text,
  terminal text, record_id text, access_event text, confirmed boolean)
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_kind, r.original_id, r.epoch, r.phase, r.state, r.seed, r.facts, r.envelope, r.checkpoint, r.terminal, r.record_id, r.access_event, r.confirmed;
$$;

CREATE FUNCTION emr_clinical.admit(p_record text, p_actor text, p_request text, p_fingerprint text, p_seed text, p_facts text,
  p_envelope text, p_attempt text)
  RETURNS TABLE (kind text, original_id uuid, epoch integer, phase text, state text, seed text, facts text, envelope text, checkpoint text,
    terminal text, record_id text, access_event text, confirmed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r emr_clinical.request%ROWTYPE; now_at timestamptz := clock_timestamp();
BEGIN
  PERFORM emr_clinical.require_placement();
  PERFORM emr_clinical.lock_request(p_record, p_actor, p_request);
  SELECT * INTO r FROM emr_clinical.request q WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request FOR UPDATE;
  IF FOUND THEN
    IF r.fingerprint IS DISTINCT FROM p_fingerprint THEN RAISE EXCEPTION 'RequestIdReused' USING ERRCODE = 'ED002'; END IF;
    -- An existing key is an observation (service-job O); it never starts a second original.
    INSERT INTO emr_clinical.attempt VALUES (p_attempt, 'Observed', p_record, p_actor, p_request, r.original_id, now_at) ON CONFLICT DO NOTHING;
    RETURN QUERY SELECT * FROM emr_clinical.request_view(r, 'observer');
    RETURN;
  END IF;
  INSERT INTO emr_clinical.request (record, actor_id, request_id, fingerprint, original_id, epoch, phase, state, seed, facts, envelope,
    admitted_at, updated_at)
    VALUES (p_record, p_actor, p_request, p_fingerprint, pg_catalog.gen_random_uuid(), 1, 'admitted', 'pending', p_seed, p_facts, p_envelope,
      now_at, now_at)
    RETURNING * INTO r;
  RETURN QUERY SELECT * FROM emr_clinical.request_view(r, 'owner');
END
$$;

CREATE FUNCTION emr_clinical.observe(p_record text, p_actor text, p_request text, p_fingerprint text, p_attempt text, p_external boolean)
  RETURNS TABLE (kind text, original_id uuid, epoch integer, phase text, state text, seed text, facts text, envelope text, checkpoint text,
    terminal text, record_id text, access_event text, confirmed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r emr_clinical.request%ROWTYPE;
BEGIN
  SELECT * INTO r FROM emr_clinical.request q WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request;
  IF NOT FOUND THEN RETURN; END IF;
  IF r.fingerprint IS DISTINCT FROM p_fingerprint THEN RAISE EXCEPTION 'RequestIdReused' USING ERRCODE = 'ED002'; END IF;
  IF p_external THEN
    PERFORM emr_clinical.require_placement();
    INSERT INTO emr_clinical.attempt VALUES (p_attempt, 'Observed', p_record, p_actor, p_request, r.original_id, clock_timestamp()) ON CONFLICT DO NOTHING;
  END IF;
  RETURN QUERY SELECT * FROM emr_clinical.request_view(r, 'observer');
END
$$;

CREATE FUNCTION emr_clinical.checkpoint(p_record text, p_actor text, p_request text, p_original uuid, p_epoch integer, p_phase text,
  p_checkpoint text, p_envelope text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r emr_clinical.request%ROWTYPE;
BEGIN
  PERFORM emr_clinical.require_placement();
  PERFORM emr_clinical.lock_request(p_record, p_actor, p_request);
  SELECT * INTO r FROM emr_clinical.request q WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request FOR UPDATE;
  IF NOT FOUND OR r.original_id <> p_original OR r.epoch <> p_epoch OR r.state <> 'pending' OR r.phase = 'commit-dispatched'
     OR p_phase NOT IN ('prepared', 'signed', 'commit-dispatched') OR p_checkpoint IS NULL THEN
    RETURN false;
  END IF;
  PERFORM pg_catalog.set_config('kin.emr_clinical', 'register', true);
  UPDATE emr_clinical.request q SET phase = p_phase, checkpoint = p_checkpoint, envelope = COALESCE(p_envelope, q.envelope), updated_at = clock_timestamp()
    WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request;
  PERFORM pg_catalog.set_config('kin.emr_clinical', '', true);
  RETURN true;
END
$$;

-- The one commit of an original, run inside the caller's business transaction together with the legacy projection and
-- the B1 access append. p_version is the planned version text; the projection columns are its fold.
CREATE FUNCTION emr_clinical.commit_version(p_record text, p_actor text, p_request text, p_original uuid, p_epoch integer,
  p_record_id text, p_study text, p_managing text, p_patient text, p_author text, p_recipient text, p_state text, p_clinical_entry boolean,
  p_sequence integer, p_version_id text, p_sha256 text, p_previous_version_id text, p_entry text, p_version text, p_signature text,
  p_terminal text, p_access_event text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r emr_clinical.request%ROWTYPE; u emr_clinical.unit%ROWTYPE; doc json; now_at timestamptz := clock_timestamp();
BEGIN
  PERFORM emr_clinical.require_placement();
  PERFORM emr_clinical.lock_request(p_record, p_actor, p_request);
  SELECT * INTO r FROM emr_clinical.request q WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request FOR UPDATE;
  IF NOT FOUND OR r.original_id <> p_original OR r.epoch <> p_epoch OR r.state <> 'pending' OR r.phase <> 'commit-dispatched' THEN
    RAISE EXCEPTION 'PermitFenced' USING ERRCODE = 'ED004';
  END IF;
  BEGIN
    doc := p_version::json;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'ClinicalVersionInvalid' USING ERRCODE = 'ED005';
  END;
  IF doc ->> 'recordId' IS DISTINCT FROM p_record_id OR doc ->> 'versionId' IS DISTINCT FROM p_version_id
     OR (doc ->> 'sequence')::integer IS DISTINCT FROM p_sequence OR doc ->> 'sha256' IS DISTINCT FROM p_sha256
     OR doc ->> 'record' IS DISTINCT FROM p_record OR doc ->> 'entry' IS DISTINCT FROM p_entry
     OR doc ->> 'studyId' IS DISTINCT FROM p_study OR doc ->> 'managingInstitutionId' IS DISTINCT FROM p_managing
     OR doc #>> '{state,to}' IS DISTINCT FROM p_state OR doc #>> '{previousVersion,versionId}' IS DISTINCT FROM p_previous_version_id
     OR pg_catalog.json_typeof(doc -> 'attachments') IS DISTINCT FROM 'array'
     OR (p_entry = 'clinical-entry') <> (p_signature IS NOT NULL) THEN
    RAISE EXCEPTION 'ClinicalVersionInvalid' USING ERRCODE = 'ED005';
  END IF;
  SELECT * INTO u FROM emr_clinical.unit x WHERE x.record_id = p_record_id FOR UPDATE;
  IF p_sequence = 1 THEN
    IF FOUND OR p_previous_version_id IS NOT NULL THEN RAISE EXCEPTION 'StaleHead' USING ERRCODE = 'ED003'; END IF;
    INSERT INTO emr_clinical.unit (record_id, record, study_id, managing_institution_id, patient, author_id, recipient_id, state, revision,
      head_version_id, head_sha256, clinical_entry, created_at, updated_at)
      VALUES (p_record_id, p_record, p_study, p_managing, p_patient, p_author, p_recipient, p_state, 1, p_version_id, p_sha256, p_clinical_entry, now_at, now_at);
  ELSE
    IF NOT FOUND OR u.record <> p_record OR u.revision <> p_sequence - 1 OR u.head_version_id IS DISTINCT FROM p_previous_version_id
       OR u.study_id <> p_study OR u.managing_institution_id <> p_managing OR u.patient <> p_patient OR u.author_id <> p_author
       OR u.recipient_id IS DISTINCT FROM p_recipient OR (u.clinical_entry AND NOT p_clinical_entry) THEN
      RAISE EXCEPTION 'StaleHead' USING ERRCODE = 'ED003';
    END IF;
    PERFORM pg_catalog.set_config('kin.emr_clinical', 'commit', true);
    UPDATE emr_clinical.unit x SET state = p_state, revision = p_sequence, head_version_id = p_version_id, head_sha256 = p_sha256,
      clinical_entry = p_clinical_entry, updated_at = now_at WHERE x.record_id = p_record_id;
  END IF;
  INSERT INTO emr_clinical.version (record_id, sequence, version_id, sha256, entry, body, signature, committed_at)
    VALUES (p_record_id, p_sequence, p_version_id, p_sha256, p_entry, p_version, p_signature, now_at);
  INSERT INTO emr_clinical.attachment (record_id, sequence, position, kind, ref_record_id, ref_version_id, ref_sha256)
    SELECT p_record_id, p_sequence, (a.position - 1)::integer, a.value ->> 'kind', a.value ->> 'recordId', a.value ->> 'versionId', a.value ->> 'sha256'
    FROM pg_catalog.json_array_elements(doc -> 'attachments') WITH ORDINALITY a(value, position);
  PERFORM pg_catalog.set_config('kin.emr_clinical', 'commit', true);
  UPDATE emr_clinical.request q SET state = 'committed', terminal = p_terminal, record_id = p_record_id, access_event = p_access_event,
    updated_at = now_at WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request;
  PERFORM pg_catalog.set_config('kin.emr_clinical', '', true);
END
$$;

-- Terminal rejection of a pending original. Before dispatch only a not-dispatched cause; after dispatch only the
-- caller's observed rollback (the row is still pending under its lock, so the dispatched commit committed nothing).
CREATE FUNCTION emr_clinical.seal_rejected(p_record text, p_actor text, p_request text, p_original uuid, p_epoch integer, p_cause text,
  p_terminal text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r emr_clinical.request%ROWTYPE;
BEGIN
  PERFORM emr_clinical.require_placement();
  PERFORM emr_clinical.lock_request(p_record, p_actor, p_request);
  SELECT * INTO r FROM emr_clinical.request q WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request FOR UPDATE;
  IF NOT FOUND OR r.original_id <> p_original OR r.epoch <> p_epoch OR r.state <> 'pending' OR p_terminal IS NULL
     OR (r.phase = 'commit-dispatched' AND p_cause IS DISTINCT FROM 'rollback')
     OR (r.phase <> 'commit-dispatched' AND p_cause IS DISTINCT FROM 'not-dispatched') THEN
    RETURN false;
  END IF;
  PERFORM pg_catalog.set_config('kin.emr_clinical', 'register', true);
  UPDATE emr_clinical.request q SET state = 'rejected', terminal = p_terminal, updated_at = clock_timestamp()
    WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request;
  PERFORM pg_catalog.set_config('kin.emr_clinical', '', true);
  RETURN true;
END
$$;

-- Recovery under the register lock (which a running commit holds). A terminal answers as it is. Any pending original is
-- given the next epoch, which fences every earlier owner: a late checkpoint or commit of an older epoch changes nothing.
-- A dispatched original still pending under the lock committed nothing; it comes back as 'fenced' and the caller seals
-- it StorageFailed with this new epoch (seal_rejected, cause rollback). Any earlier phase comes back as a new owner.
CREATE FUNCTION emr_clinical.recover(p_record text, p_actor text, p_request text, p_fingerprint text)
  RETURNS TABLE (kind text, original_id uuid, epoch integer, phase text, state text, seed text, facts text, envelope text, checkpoint text,
    terminal text, record_id text, access_event text, confirmed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r emr_clinical.request%ROWTYPE;
BEGIN
  PERFORM emr_clinical.require_placement();
  PERFORM emr_clinical.lock_request(p_record, p_actor, p_request);
  SELECT * INTO r FROM emr_clinical.request q WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF r.fingerprint IS DISTINCT FROM p_fingerprint THEN RAISE EXCEPTION 'RequestIdReused' USING ERRCODE = 'ED002'; END IF;
  IF r.state <> 'pending' THEN RETURN QUERY SELECT * FROM emr_clinical.request_view(r, 'observer'); RETURN; END IF;
  PERFORM pg_catalog.set_config('kin.emr_clinical', 'register', true);
  UPDATE emr_clinical.request q SET epoch = r.epoch + 1, updated_at = clock_timestamp()
    WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request RETURNING * INTO r;
  PERFORM pg_catalog.set_config('kin.emr_clinical', '', true);
  RETURN QUERY SELECT * FROM emr_clinical.request_view(r, CASE WHEN r.phase = 'commit-dispatched' THEN 'fenced' ELSE 'owner' END);
END
$$;

CREATE FUNCTION emr_clinical.confirm_request(p_record text, p_actor text, p_request text, p_original uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM emr_clinical.require_placement();
  PERFORM pg_catalog.set_config('kin.emr_clinical', 'register', true);
  UPDATE emr_clinical.request q SET confirmed = true, updated_at = clock_timestamp()
    WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request AND q.original_id = p_original AND q.state = 'committed';
  PERFORM pg_catalog.set_config('kin.emr_clinical', '', true);
  RETURN FOUND;
END
$$;

CREATE FUNCTION emr_clinical.note_attempt(p_attempt text, p_code text, p_record text, p_actor text, p_request text, p_original uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM emr_clinical.require_placement();
  INSERT INTO emr_clinical.attempt VALUES (p_attempt, p_code, p_record, p_actor, p_request, p_original, clock_timestamp()) ON CONFLICT DO NOTHING;
END
$$;

-- Originals that the restart scan resumes: pending ones and committed ones whose ledger receipt is not yet durable.
CREATE FUNCTION emr_clinical.open_requests(p_limit integer) RETURNS TABLE (record text, actor_id text, request_id text, fingerprint text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT q.record, q.actor_id, q.request_id, q.fingerprint FROM emr_clinical.request q
  WHERE q.state = 'pending' OR (q.state = 'committed' AND NOT q.confirmed)
  ORDER BY q.admitted_at, q.original_id LIMIT GREATEST(1, LEAST(p_limit, 1000));
$$;

-- One unit with its complete version history, in sequence order, as stored text.
CREATE FUNCTION emr_clinical.unit_for(p_record_id text) RETURNS TABLE (
  record text, study_id text, managing_institution_id text, patient text, author_id text, recipient_id text, state text, revision integer,
  head_version_id text, head_sha256 text, clinical_entry boolean, sequence integer, version_id text, body text, signature text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.record, u.study_id, u.managing_institution_id, u.patient, u.author_id, u.recipient_id, u.state, u.revision, u.head_version_id,
    u.head_sha256, u.clinical_entry, v.sequence, v.version_id, v.body, v.signature
  FROM emr_clinical.unit u JOIN emr_clinical.version v ON v.record_id = u.record_id
  WHERE u.record_id = p_record_id ORDER BY v.sequence;
$$;

-- What retained versions incorporate or cite a record (the reference index).
CREATE FUNCTION emr_clinical.references_to(p_record_id text) RETURNS TABLE (record_id text, version_id text, sha256 text, kind text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.record_id, v.version_id, v.sha256, a.kind FROM emr_clinical.attachment a
  JOIN emr_clinical.version v ON v.record_id = a.record_id AND v.sequence = a.sequence
  WHERE a.ref_record_id = p_record_id ORDER BY a.record_id, a.sequence, a.position;
$$;

CREATE FUNCTION emr_clinical.adopt_sr(p_record_id text, p_version_id text, p_sha256 text, p_bytes_sha256 text, p_sop text, p_study text,
  p_managing text, p_body text, p_signature text, p_access_event text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE existing emr_clinical.sr_adoption%ROWTYPE;
BEGIN
  PERFORM emr_clinical.require_placement();
  PERFORM pg_advisory_xact_lock(hashtextextended('emr-clinical-sr:' || p_record_id, 0));
  SELECT * INTO existing FROM emr_clinical.sr_adoption s WHERE s.record_id = p_record_id;
  IF FOUND THEN RAISE EXCEPTION 'SrAlreadyAdopted' USING ERRCODE = 'ED006'; END IF;
  INSERT INTO emr_clinical.sr_adoption (record_id, version_id, sha256, bytes_sha256, sop_instance_uid, study_id, managing_institution_id, body,
    signature, access_event, committed_at)
    VALUES (p_record_id, p_version_id, p_sha256, p_bytes_sha256, p_sop, p_study, p_managing, p_body, p_signature, p_access_event, clock_timestamp());
  RETURN true;
END
$$;
CREATE FUNCTION emr_clinical.confirm_sr(p_record_id text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM emr_clinical.require_placement();
  PERFORM pg_catalog.set_config('kin.emr_clinical', 'register', true);
  UPDATE emr_clinical.sr_adoption s SET confirmed = true WHERE s.record_id = p_record_id AND NOT s.confirmed;
  PERFORM pg_catalog.set_config('kin.emr_clinical', '', true);
  RETURN FOUND;
END
$$;
CREATE FUNCTION emr_clinical.open_sr_adoptions(p_limit integer) RETURNS TABLE (record_id text, access_event text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.record_id, s.access_event FROM emr_clinical.sr_adoption s WHERE NOT s.confirmed
  ORDER BY s.committed_at, s.record_id LIMIT GREATEST(1, LEAST(p_limit, 1000));
$$;
CREATE FUNCTION emr_clinical.sr_adoption_for(p_record_id text) RETURNS TABLE (version_id text, sha256 text, bytes_sha256 text,
  sop_instance_uid text, study_id text, managing_institution_id text, body text, signature text, access_event text, confirmed boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.version_id, s.sha256, s.bytes_sha256, s.sop_instance_uid, s.study_id, s.managing_institution_id, s.body, s.signature, s.access_event, s.confirmed
  FROM emr_clinical.sr_adoption s WHERE s.record_id = p_record_id;
$$;
CREATE FUNCTION emr_clinical.record_sr_purpose_end(p_record_id text, p_bytes_sha256 text, p_purpose_end text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM emr_clinical.require_placement();
  IF EXISTS (SELECT 1 FROM emr_clinical.sr_adoption s WHERE s.record_id = p_record_id) THEN
    RAISE EXCEPTION 'SrAdopted' USING ERRCODE = 'ED006';
  END IF;
  INSERT INTO emr_clinical.sr_purpose_end (record_id, bytes_sha256, purpose_end, observed_at)
    VALUES (p_record_id, p_bytes_sha256, p_purpose_end, clock_timestamp()) ON CONFLICT (record_id) DO NOTHING;
END
$$;
CREATE FUNCTION emr_clinical.sr_purpose_ends(p_record_ids text[]) RETURNS TABLE (record_id text, bytes_sha256 text, purpose_end text, observed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.record_id, p.bytes_sha256, p.purpose_end, p.observed_at FROM emr_clinical.sr_purpose_end p
  WHERE p.record_id = ANY (p_record_ids) ORDER BY p.record_id;
$$;

RESET ROLE;
SET LOCAL default_tablespace = '';

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA emr_clinical FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA emr_clinical FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  emr_clinical.storage_placement(), emr_clinical.admit(text, text, text, text, text, text, text, text),
  emr_clinical.observe(text, text, text, text, text, boolean),
  emr_clinical.checkpoint(text, text, text, uuid, integer, text, text, text),
  emr_clinical.commit_version(text, text, text, uuid, integer, text, text, text, text, text, text, text, boolean, integer, text, text, text, text, text, text, text, text),
  emr_clinical.seal_rejected(text, text, text, uuid, integer, text, text), emr_clinical.recover(text, text, text, text),
  emr_clinical.confirm_request(text, text, text, uuid), emr_clinical.note_attempt(text, text, text, text, text, uuid),
  emr_clinical.open_requests(integer), emr_clinical.unit_for(text), emr_clinical.references_to(text),
  emr_clinical.adopt_sr(text, text, text, text, text, text, text, text, text, text), emr_clinical.confirm_sr(text), emr_clinical.open_sr_adoptions(integer),
  emr_clinical.sr_adoption_for(text), emr_clinical.record_sr_purpose_end(text, text, text), emr_clinical.sr_purpose_ends(text[])
  TO kin_runtime;
-- The reader sees the retained clinical record (units, versions, references, SR adoptions and purpose ends), never the
-- request register's working copies or the attempt journal.
GRANT SELECT ON emr_clinical.unit, emr_clinical.version, emr_clinical.attachment, emr_clinical.sr_adoption, emr_clinical.sr_purpose_end
  TO kin_emr_reader;
GRANT EXECUTE ON FUNCTION emr_clinical.storage_placement(), emr_clinical.unit_for(text), emr_clinical.references_to(text),
  emr_clinical.sr_adoption_for(text), emr_clinical.sr_purpose_ends(text[]) TO kin_emr_reader;
COMMIT;
