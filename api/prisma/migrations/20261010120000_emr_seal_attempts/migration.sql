-- D867: transaction finality metadata, not an independent COMMIT witness.
-- Old chain/payload bytes remain unchanged. Installer applies this with all writers stopped.
BEGIN;
SET LOCAL ROLE kin_emr_owner;
SET LOCAL default_tablespace = 'kin_emr_access';

CREATE TABLE emr_access.commit_marker (
  stream text NOT NULL,
  chain_id uuid NOT NULL,
  attempt_id text NOT NULL,
  bundle_id text NOT NULL,
  kind text NOT NULL,
  event_id text,
  sequence bigint NOT NULL,
  previous_hash text NOT NULL,
  hash text NOT NULL,
  content_sha256 text NOT NULL,
  generation bigint NOT NULL DEFAULT 0,
  proof_digest text,
  transaction_id bigint NOT NULL DEFAULT txid_current(),
  PRIMARY KEY (stream, sequence),
  UNIQUE (stream, attempt_id),
  FOREIGN KEY (stream, sequence) REFERENCES emr_access.access_entry(stream, sequence) ON DELETE CASCADE,
  CHECK (generation >= 0),
  CHECK (kind IN ('access', 'history', 'expiry'))
);

-- Already retained bytes are not re-authored. A v2 seal must independently verify this entire
-- committed prefix before its frontier can be upgraded; these rows alone never authorize it.
INSERT INTO emr_access.commit_marker(stream,chain_id,attempt_id,bundle_id,kind,event_id,sequence,previous_hash,hash,content_sha256,generation)
  SELECT e.stream,h.chain_id,'legacy:'||e.stream||':'||e.sequence,'legacy-v2-upgrade',e.kind,e.event_id,e.sequence,
    e.previous_hash,e.hash,e.content_sha256,e.sequence
  FROM emr_access.access_entry e JOIN emr_access.chain_head h ON h.stream=e.stream;

-- Admission precedes intent publication. The exclusive fence waits for every old transaction,
-- including separate retention workers and response-unknown transactions, to finish.
CREATE FUNCTION emr_access.enter_writer() RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_advisory_xact_lock_shared(77104, 1);
$$;
CREATE FUNCTION emr_access.fence_writers() RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_advisory_xact_lock(77104, 1);
$$;
CREATE FUNCTION emr_access.lock_chain(p_stream text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM emr_access.enter_writer();
  PERFORM 1 FROM emr_access.chain_head WHERE stream = p_stream FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'UnknownStream' USING ERRCODE = 'EB003'; END IF;
END
$$;
CREATE FUNCTION emr_access.commit_marker_for_slot(p_stream text, p_sequence bigint)
  RETURNS SETOF emr_access.commit_marker LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM emr_access.commit_marker WHERE stream = p_stream AND sequence = p_sequence;
$$;
CREATE FUNCTION emr_access.commit_marker_for_attempt(p_stream text, p_attempt text)
  RETURNS SETOF emr_access.commit_marker LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM emr_access.commit_marker WHERE stream = p_stream AND attempt_id = p_attempt;
$$;
CREATE FUNCTION emr_access.stage_commit(p_stream text, p_sequence bigint, p_attempt text, p_bundle text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_attempt IS NULL OR length(p_attempt) < 16 OR p_bundle IS NULL OR length(p_bundle) < 16 THEN
    RAISE EXCEPTION 'AttemptRequired' USING ERRCODE = 'EB003';
  END IF;
  INSERT INTO emr_access.commit_marker(stream, chain_id, attempt_id, bundle_id, kind, event_id, sequence, previous_hash, hash, content_sha256)
    SELECT e.stream, h.chain_id, p_attempt, p_bundle, e.kind, e.event_id, e.sequence, e.previous_hash, e.hash, e.content_sha256
    FROM emr_access.access_entry e JOIN emr_access.chain_head h ON h.stream = e.stream
    WHERE e.stream = p_stream AND e.sequence = p_sequence;
END
$$;
CREATE FUNCTION emr_access.append_reserved(p_stream text, p_event text, p_payload text, p_act text, p_attempt text, p_bundle text)
  RETURNS TABLE (chain_id uuid, sequence bigint, previous_hash text, hash text, stored_at timestamptz, replay boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record;
BEGIN
  PERFORM emr_access.enter_writer();
  SELECT * INTO r FROM emr_access.append_access(p_stream, p_event, p_payload, p_act);
  IF NOT r.replay THEN PERFORM emr_access.stage_commit(p_stream, r.sequence, p_attempt, p_bundle); END IF;
  RETURN QUERY SELECT r.chain_id, r.sequence, r.previous_hash, r.hash, r.stored_at, r.replay;
END
$$;
CREATE FUNCTION emr_access.expire_reserved(p_through bigint, p_attempt text, p_bundle text)
  RETURNS TABLE (deleted_count bigint, checkpoint_sequence bigint, checkpoint_hash text, chain_id uuid, previous_hash text, content_sha256 text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record;
BEGIN
  PERFORM emr_access.enter_writer();
  SELECT * INTO r FROM emr_access.expire_prefix(p_through);
  PERFORM emr_access.stage_commit('viewing', r.checkpoint_sequence, p_attempt, p_bundle);
  RETURN QUERY SELECT r.deleted_count, r.checkpoint_sequence, r.checkpoint_hash, m.chain_id, m.previous_hash, m.content_sha256
    FROM emr_access.commit_marker m WHERE m.stream = 'viewing' AND m.attempt_id = p_attempt;
END
$$;
CREATE FUNCTION emr_access.bind_commit(p_stream text, p_attempt text, p_generation bigint, p_proof text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_generation < 1 THEN RAISE EXCEPTION 'ReservationRequired' USING ERRCODE = 'EB008'; END IF;
  UPDATE emr_access.commit_marker SET generation = p_generation, proof_digest = p_proof
    WHERE stream = p_stream AND attempt_id = p_attempt AND transaction_id = txid_current() AND generation = 0
      AND ((kind = 'expiry' AND p_proof ~ '^[0-9a-f]{64}$') OR (kind <> 'expiry' AND p_proof IS NULL));
  IF NOT FOUND THEN RAISE EXCEPTION 'CommitBindingRefused' USING ERRCODE = 'EB008'; END IF;
END
$$;
CREATE FUNCTION emr_access.require_commit_marker() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM emr_access.commit_marker m JOIN emr_access.chain_head h ON h.stream = m.stream
    WHERE m.stream = NEW.stream AND m.sequence = NEW.sequence AND m.chain_id = h.chain_id AND m.generation > 0
      AND m.event_id IS NOT DISTINCT FROM NEW.event_id AND m.kind = NEW.kind AND m.hash = NEW.hash
      AND m.previous_hash = NEW.previous_hash AND m.content_sha256 = NEW.content_sha256
      AND m.transaction_id = txid_current()) THEN
    RAISE EXCEPTION 'CommitMarkerRequired' USING ERRCODE = 'EB008';
  END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER access_commit_marker AFTER INSERT ON emr_access.access_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION emr_access.require_commit_marker();

RESET ROLE;
REVOKE ALL ON emr_access.commit_marker FROM PUBLIC, kin_runtime, kin_emr_retention;
GRANT SELECT ON emr_access.commit_marker TO kin_emr_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA emr_access FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION emr_access.append_access(text,text,text,text) FROM kin_runtime;
REVOKE EXECUTE ON FUNCTION emr_access.expire_prefix(bigint) FROM kin_emr_retention;
GRANT EXECUTE ON FUNCTION emr_access.append_reserved(text,text,text,text,text,text),
  emr_access.bind_commit(text,text,bigint,text) TO kin_runtime;
GRANT EXECUTE ON FUNCTION emr_access.expire_reserved(bigint,text,text), emr_access.lock_chain(text),
  emr_access.bind_commit(text,text,bigint,text) TO kin_emr_retention;
GRANT EXECUTE ON FUNCTION emr_access.enter_writer(), emr_access.fence_writers(),
  emr_access.commit_marker_for_slot(text,bigint), emr_access.commit_marker_for_attempt(text,text)
  TO kin_runtime, kin_emr_reader, kin_emr_retention;
COMMIT;
