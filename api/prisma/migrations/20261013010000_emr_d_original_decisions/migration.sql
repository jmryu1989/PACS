-- EMR-D R5a: compact original seeds and durable, cause-preserving rejection decisions.
-- This is forward-only: prior versions/requests are retained and old seeds are reconciled conservatively.
BEGIN;
SET LOCAL ROLE kin_emr_owner;
ALTER TABLE emr_clinical.request ADD COLUMN rejection_decision text
  CHECK (rejection_decision IS NULL OR octet_length(rejection_decision) <= 8192);
-- An original keeps only the base head and the source manifest, never another copy of the whole history.
-- The existing 512 KiB seed bound covers the 64 KiB Finding snapshot (including JSON escaping), request,
-- actor/patient facts and eight fixed sources. Question history length does not contribute to seed size.
ALTER TABLE emr_clinical.request ADD CONSTRAINT request_compact_seed CHECK (
  seed::jsonb->>'format' IS DISTINCT FROM 'emr-seed/2' OR
  (NOT (seed::jsonb ? 'unit') AND seed::jsonb ? 'base' AND jsonb_typeof(seed::jsonb->'attachments') = 'array'));

CREATE FUNCTION emr_clinical.remember_rejection(p_record text, p_actor text, p_request text,
  p_original uuid, p_epoch integer, p_decision text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r emr_clinical.request%ROWTYPE; d jsonb;
BEGIN
  PERFORM emr_clinical.require_placement();
  PERFORM emr_clinical.lock_request(p_record, p_actor, p_request);
  SELECT * INTO r FROM emr_clinical.request q
    WHERE q.record=p_record AND q.actor_id=p_actor AND q.request_id=p_request FOR UPDATE;
  IF NOT FOUND OR r.original_id<>p_original OR r.epoch<>p_epoch OR r.state<>'pending' THEN RETURN false; END IF;
  d := p_decision::jsonb;
  IF d->>'originalId' IS DISTINCT FROM p_original::text OR (d->>'epoch')::integer IS DISTINCT FROM p_epoch
    OR d->>'code' IS NULL OR d->>'code' !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
    OR d->>'noClinicalEffects' IS DISTINCT FROM 'true'
    OR d->>'evidenceId' IS NULL
    OR (r.phase='commit-dispatched' AND d->>'cause' IS DISTINCT FROM 'rollback')
    OR (r.phase<>'commit-dispatched' AND d->>'cause' IS DISTINCT FROM 'not-dispatched') THEN
    RAISE EXCEPTION 'Invalid rejection decision' USING ERRCODE='ED005';
  END IF;
  -- A decision is write-once. Recovery at a newer epoch observes and seals this same cause.
  IF r.rejection_decision IS NOT NULL THEN
    IF r.rejection_decision::jsonb->>'code' IS DISTINCT FROM d->>'code' THEN
      RAISE EXCEPTION 'Rejection decision already fixed' USING ERRCODE='ED004';
    END IF;
    RETURN true;
  END IF;
  PERFORM set_config('kin.emr_clinical','register',true);
  UPDATE emr_clinical.request q SET rejection_decision=p_decision, updated_at=clock_timestamp()
    WHERE q.record=p_record AND q.actor_id=p_actor AND q.request_id=p_request;
  PERFORM set_config('kin.emr_clinical','',true);
  RETURN true;
END $$;
CREATE FUNCTION emr_clinical.rejection_for(p_original uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT rejection_decision FROM emr_clinical.request WHERE original_id=p_original;
$$;
CREATE OR REPLACE FUNCTION emr_clinical.checkpoint(p_record text, p_actor text, p_request text, p_original uuid, p_epoch integer, p_phase text,
  p_checkpoint text, p_envelope text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r emr_clinical.request%ROWTYPE;
BEGIN
  PERFORM emr_clinical.require_placement();
  PERFORM emr_clinical.lock_request(p_record, p_actor, p_request);
  SELECT * INTO r FROM emr_clinical.request q WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request FOR UPDATE;
  IF NOT FOUND OR r.original_id <> p_original OR r.epoch <> p_epoch OR r.state <> 'pending' OR r.rejection_decision IS NOT NULL OR r.phase = 'commit-dispatched'
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

CREATE OR REPLACE FUNCTION emr_clinical.commit_version(p_record text, p_actor text, p_request text, p_original uuid, p_epoch integer,
  p_record_id text, p_study text, p_managing text, p_patient text, p_author text, p_recipient text, p_state text, p_clinical_entry boolean,
  p_sequence integer, p_version_id text, p_sha256 text, p_previous_version_id text, p_entry text, p_version text, p_signature text,
  p_terminal text, p_access_event text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r emr_clinical.request%ROWTYPE; u emr_clinical.unit%ROWTYPE; doc json; now_at timestamptz := clock_timestamp();
BEGIN
  PERFORM emr_clinical.require_placement();
  PERFORM emr_clinical.lock_request(p_record, p_actor, p_request);
  SELECT * INTO r FROM emr_clinical.request q WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request FOR UPDATE;
  IF NOT FOUND OR r.original_id <> p_original OR r.epoch <> p_epoch OR r.state <> 'pending' OR r.rejection_decision IS NOT NULL OR r.phase <> 'commit-dispatched' THEN
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

CREATE OR REPLACE FUNCTION emr_clinical.seal_rejected(p_record text, p_actor text, p_request text, p_original uuid, p_epoch integer, p_cause text,
  p_terminal text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r emr_clinical.request%ROWTYPE;
BEGIN
  PERFORM emr_clinical.require_placement();
  PERFORM emr_clinical.lock_request(p_record, p_actor, p_request);
  SELECT * INTO r FROM emr_clinical.request q WHERE q.record = p_record AND q.actor_id = p_actor AND q.request_id = p_request FOR UPDATE;
  IF NOT FOUND OR r.original_id <> p_original OR r.epoch <> p_epoch OR r.state <> 'pending' OR p_terminal IS NULL OR r.rejection_decision IS NULL
     OR r.rejection_decision::jsonb->>'code' IS DISTINCT FROM p_terminal::jsonb#>>'{proof,code}'
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

CREATE OR REPLACE FUNCTION emr_clinical.units_for(p_record_ids text[]) RETURNS TABLE (
  record_id text, record text, study_id text, managing_institution_id text, patient text, author_id text, recipient_id text, state text,
  revision integer, head_version_id text, head_sha256 text, clinical_entry boolean, sequence integer, version_id text, body text, signature text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.record_id, u.record, u.study_id, u.managing_institution_id, u.patient, u.author_id, u.recipient_id, u.state, u.revision,
    u.head_version_id, u.head_sha256, u.clinical_entry, v.sequence, v.version_id, v.body, v.signature
  FROM emr_clinical.unit u JOIN emr_clinical.version v ON v.record_id = u.record_id
  WHERE u.record_id = ANY (p_record_ids) ORDER BY u.record_id, v.sequence;
$$;

-- The response boundary resolves display facts of the same committed version. It never resolves today's recipient
-- eligibility to reconstruct yesterday's terminal, and it never exposes the unrestricted facts JSON to HTTP callers.
CREATE FUNCTION emr_clinical.response_facts(p_record text, p_versions text[]) RETURNS TABLE(version_id text, request_id text, projection text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT q.terminal::jsonb#>>'{proof,version,versionId}', q.request_id, (q.facts::jsonb->'projection')::text FROM emr_clinical.request q
  WHERE q.state='committed' AND q.record_id=p_record
    AND (q.terminal::jsonb#>>'{proof,version,versionId}')=ANY(p_versions);
$$;
REVOKE ALL ON FUNCTION emr_clinical.response_facts(text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emr_clinical.response_facts(text,text[]), emr_clinical.units_for(text[]) TO kin_runtime;

RESET ROLE;
REVOKE ALL ON FUNCTION emr_clinical.remember_rejection(text,text,text,uuid,integer,text),
  emr_clinical.rejection_for(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emr_clinical.remember_rejection(text,text,text,uuid,integer,text),
  emr_clinical.rejection_for(uuid), emr_clinical.lock_request(text,text,text) TO kin_runtime;
COMMIT;
