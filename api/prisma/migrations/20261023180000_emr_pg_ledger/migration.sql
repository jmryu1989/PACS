-- REQ-B2R-01/02/03/05/07. D1770 replaces the chain; existing B events are carried forward.
-- PostgreSQL owns finality. Hashes below compare accidental duplicate content;
-- they are neither a chain nor an independent integrity/rollback witness.
BEGIN;
-- Public session schema belongs to the installer, not the ledger owner.
-- Authentication events must never retain a cookie, token or session credential.
ALTER TABLE public."AuthSession" ADD COLUMN "auditRef" text NOT NULL DEFAULT ('authref:' || gen_random_uuid()::text);
CREATE UNIQUE INDEX "AuthSession_auditRef_key" ON public."AuthSession"("auditRef");
SET LOCAL ROLE kin_emr_owner;
SET LOCAL default_tablespace = 'kin_emr_access';

-- A B access/history row is one event and becomes one committed operation below.
-- An expiry checkpoint has no event, and its deleted prefix cannot be rebuilt;
-- neither can an event whose streams disagree. Those still refuse the upgrade.
DO $$
BEGIN
  LOCK TABLE emr_access.access_entry, emr_access.commit_marker,
    emr_access.access_target, emr_access.audit_projection IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT FROM emr_access.access_entry WHERE kind = 'expiry')
    OR EXISTS (SELECT FROM emr_access.access_entry e
      WHERE e.payload::jsonb #>> '{event,eventId}' IS DISTINCT FROM e.event_id
        OR e.payload::jsonb #> '{event,userId}' IS NULL
        OR jsonb_typeof(e.payload::jsonb #> '{event,targets}') IS DISTINCT FROM 'array')
    OR EXISTS (SELECT FROM emr_access.access_entry h WHERE h.stream = 'history' AND NOT EXISTS (
      SELECT FROM emr_access.access_entry v WHERE v.stream = 'viewing' AND v.event_id = h.event_id
        AND v.statutory_act = h.statutory_act AND (v.payload::json -> 'event')::text = (h.payload::json -> 'event')::text)) THEN
    RAISE EXCEPTION 'EmrCleanInstallRequired: existing events preserved' USING ERRCODE = 'EB010';
  END IF;
END $$;
-- New payloads hold the inner event only, as later readers parse it. json (not
-- jsonb) keeps the stored bytes of that event. Chain hashes and commit markers
-- are not carried (D1770). Held only until the new tables exist.
CREATE TABLE emr_access.carried_event AS
  SELECT gen_random_uuid() AS operation_id, gen_random_uuid() AS attempt_id, v.sequence AS position,
    v.event_id, v.statutory_act, (v.payload::json -> 'event')::text AS payload, v.occurred_at,
    v.stored_at, h.stored_at AS history_stored_at
  FROM emr_access.access_entry v
  LEFT JOIN emr_access.access_entry h ON h.stream = 'history' AND h.event_id = v.event_id
  WHERE v.stream = 'viewing';

DROP TRIGGER access_commit_marker ON emr_access.access_entry;
DROP FUNCTION emr_access.require_commit_marker();
DROP FUNCTION emr_access.append_reserved(text,text,text,text,text,text);
DROP FUNCTION emr_access.expire_reserved(bigint,text,text);
DROP FUNCTION emr_access.bind_commit(text,text,bigint,text);
DROP FUNCTION emr_access.stage_commit(text,bigint,text,text);
DROP FUNCTION emr_access.commit_marker_for_slot(text,bigint);
DROP FUNCTION emr_access.commit_marker_for_attempt(text,text);
DROP FUNCTION emr_access.lock_chain(text);
DROP FUNCTION emr_access.enter_writer();
DROP FUNCTION emr_access.fence_writers();
DROP FUNCTION emr_access.append_access(text,text,text,text);
DROP FUNCTION emr_access.expire_prefix(bigint);
DROP FUNCTION emr_access.retention_view(bigint,integer);
DROP FUNCTION emr_access.chain_tail(text);
DROP FUNCTION emr_access.entries_after(text,bigint,integer);
DROP FUNCTION emr_access.entry_for_event(text,text);
DROP FUNCTION emr_access.chain_hash(bigint,text,text);
DROP TABLE emr_access.commit_marker;
DROP TABLE emr_access.access_target;
DROP TABLE emr_access.access_entry;
DROP TABLE emr_access.chain_head;

CREATE TABLE emr_access.ledger_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installation_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  schema_version text NOT NULL DEFAULT 'pg-ledger-1' CHECK (schema_version = 'pg-ledger-1')
);
INSERT INTO emr_access.ledger_metadata DEFAULT VALUES;

-- This row is also the operation lock. Only pending is a mutable projection.
-- The event key survives payload expiry, so a new transport attempt cannot
-- execute an old clinical mutation again.
CREATE TABLE emr_access.operation (
  operation_id uuid PRIMARY KEY,
  event_id text NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 200),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  actor_sha256 text NOT NULL CHECK (actor_sha256 ~ '^[0-9a-f]{64}$'),
  streams text[] NOT NULL CHECK (streams IN (ARRAY['viewing'], ARRAY['viewing','history'])),
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  pending boolean NOT NULL DEFAULT true,
  UNIQUE (operation_id, event_id)
);
CREATE INDEX operation_pending ON emr_access.operation (admitted_at, operation_id) WHERE pending;

CREATE TABLE emr_access.attempt (
  stream text NOT NULL CHECK (stream IN ('viewing','history')),
  attempt_id uuid NOT NULL,
  operation_id uuid NOT NULL REFERENCES emr_access.operation,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (stream, attempt_id),
  UNIQUE (operation_id, stream, attempt_id)
);
CREATE INDEX attempt_operation ON emr_access.attempt(operation_id);

CREATE TABLE emr_access.attempt_outcome (
  operation_id uuid PRIMARY KEY REFERENCES emr_access.operation,
  outcome text NOT NULL CHECK (outcome IN ('committed','negative')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- A reference only; clinical response bodies remain in their own tables.
  result_kind text,
  result_id text,
  result_version text,
  CHECK ((result_kind IS NULL) = (result_id IS NULL)),
  CHECK (outcome = 'committed' OR (result_kind IS NULL AND result_id IS NULL AND result_version IS NULL))
);

-- Minimal immutable receipt bindings survive deletion of legal event payloads.
CREATE TABLE emr_access.entry_receipt (
  entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES emr_access.attempt_outcome DEFERRABLE INITIALLY DEFERRED,
  stream text NOT NULL,
  event_id text NOT NULL,
  attempt_id uuid NOT NULL,
  UNIQUE (stream, event_id),
  UNIQUE (operation_id, stream),
  UNIQUE (entry_id, operation_id, stream, event_id),
  FOREIGN KEY (operation_id, event_id) REFERENCES emr_access.operation(operation_id, event_id),
  FOREIGN KEY (operation_id, stream, attempt_id) REFERENCES emr_access.attempt(operation_id, stream, attempt_id)
);
CREATE TABLE emr_access.access_entry (
  entry_id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  operation_id uuid NOT NULL,
  stream text NOT NULL,
  event_id text NOT NULL,
  payload text NOT NULL CHECK (octet_length(payload) <= 65536),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  statutory_act text NOT NULL CHECK (statutory_act IN ('기재','추가기재','수정','열람','none')),
  retention_class text NOT NULL CHECK (retention_class IN ('viewing2y','rights3y','record-history')),
  UNIQUE (stream, event_id),
  FOREIGN KEY (entry_id, operation_id, stream, event_id)
    REFERENCES emr_access.entry_receipt(entry_id, operation_id, stream, event_id),
  CHECK ((stream = 'history') = (retention_class = 'record-history'))
);
CREATE INDEX access_entry_review ON emr_access.access_entry (sequence);
CREATE INDEX access_entry_retention ON emr_access.access_entry (retention_class, occurred_at);
CREATE TABLE emr_access.access_target (
  entry_id uuid NOT NULL REFERENCES emr_access.access_entry ON DELETE CASCADE,
  target_index integer NOT NULL CHECK (target_index >= 0),
  target_kind text NOT NULL,
  record_id text,
  version_id text,
  PRIMARY KEY (entry_id, target_index)
);
CREATE INDEX access_target_record ON emr_access.access_target(record_id, version_id);

CREATE TABLE emr_access.failure_entry (
  failure_id uuid PRIMARY KEY,
  operation_id uuid REFERENCES emr_access.operation,
  event_id text,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cause text NOT NULL CHECK (cause IN ('business-rollback','ledger-refused','ledger-unreachable','commit-unknown','cancelled','capacity'))
);
CREATE TABLE emr_access.disposal_fact (
  disposal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid UNIQUE REFERENCES emr_access.entry_receipt,
  failure_id uuid UNIQUE,
  failure_binding text,
  disposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  basis text NOT NULL CHECK (basis = 'retention-elapsed'),
  -- D1794: row DELETE closes this database copy. Older backup copies age out
  -- through the existing rotation; this fact contains no clinical payload.
  CHECK (num_nonnulls(entry_id,failure_id)=1),
  CHECK ((failure_id IS NULL) = (failure_binding IS NULL))
);

-- The carried events, written as append_operation below writes a committed
-- operation; the B store time stands in for admission and commit.
INSERT INTO emr_access.operation(operation_id,event_id,content_sha256,actor_sha256,streams,admitted_at,pending)
  SELECT operation_id,event_id,encode(sha256(convert_to(statutory_act || ':' || payload,'UTF8')),'hex'),
    encode(sha256(convert_to((payload::jsonb->'userId')::text,'UTF8')),'hex'),
    CASE WHEN history_stored_at IS NULL THEN ARRAY['viewing'] ELSE ARRAY['viewing','history'] END,stored_at,false
  FROM emr_access.carried_event;
INSERT INTO emr_access.attempt(stream,attempt_id,operation_id,admitted_at)
  SELECT s.stream,c.attempt_id,c.operation_id,c.stored_at
  FROM emr_access.carried_event c CROSS JOIN (VALUES ('viewing'),('history')) s(stream)
  WHERE s.stream = 'viewing' OR c.history_stored_at IS NOT NULL;
INSERT INTO emr_access.attempt_outcome(operation_id,outcome,recorded_at)
  SELECT operation_id,'committed',GREATEST(stored_at,history_stored_at) FROM emr_access.carried_event;
WITH receipt AS (
  INSERT INTO emr_access.entry_receipt(operation_id,stream,event_id,attempt_id)
    SELECT c.operation_id,s.stream,c.event_id,c.attempt_id
    FROM emr_access.carried_event c CROSS JOIN (VALUES ('viewing'),('history')) s(stream)
    WHERE s.stream = 'viewing' OR c.history_stored_at IS NOT NULL
    RETURNING entry_id,operation_id,stream)
INSERT INTO emr_access.access_entry(entry_id,operation_id,stream,event_id,payload,occurred_at,recorded_at,statutory_act,retention_class)
  SELECT r.entry_id,c.operation_id,r.stream,c.event_id,c.payload,c.occurred_at,
    CASE WHEN r.stream = 'history' THEN c.history_stored_at ELSE c.stored_at END,c.statutory_act,
    CASE WHEN r.stream = 'history' THEN 'record-history'
      WHEN c.payload::jsonb->>'result' = 'succeeded' AND c.statutory_act IN ('기재','추가기재','수정') AND EXISTS
        (SELECT FROM jsonb_array_elements(c.payload::jsonb->'targets') t WHERE t->>'kind' = 'identity-access') THEN 'rights3y'
      ELSE 'viewing2y' END
  FROM receipt r JOIN emr_access.carried_event c USING (operation_id)
  ORDER BY c.position, r.stream = 'history';
INSERT INTO emr_access.access_target(entry_id,target_index,target_kind,record_id,version_id)
  SELECT e.entry_id,(t.ordinality-1)::integer,t.value->>'kind',
    CASE WHEN t.value->'recordId'->>'status' = 'known' THEN t.value->'recordId'->>'value' END,
    CASE WHEN t.value->'versionId'->>'status' = 'known' THEN t.value->'versionId'->>'value' END
  FROM emr_access.access_entry e CROSS JOIN LATERAL jsonb_array_elements(e.payload::jsonb->'targets') WITH ORDINALITY t(value,ordinality);
DROP TABLE emr_access.carried_event;

CREATE FUNCTION emr_access.event_streams(p_event jsonb, p_act text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p_act IN ('기재','추가기재','수정') AND p_event->>'result' = 'succeeded'
    AND EXISTS (SELECT FROM jsonb_array_elements(p_event->'targets') t
      WHERE t->>'kind' NOT IN ('preferences','reading-template','institution','identity-access','authentication-session','system-operation'))
    THEN ARRAY['viewing','history'] ELSE ARRAY['viewing'] END;
$$;

CREATE FUNCTION emr_access.admit_operation(p_operation uuid, p_attempt uuid, p_payload text, p_act text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e jsonb := p_payload::jsonb; o emr_access.operation%ROWTYPE; s text;
  content_hash text := encode(sha256(convert_to(p_act || ':' || p_payload,'UTF8')),'hex');
  actor_hash text := encode(sha256(convert_to((e->'userId')::text,'UTF8')),'hex');
  stream_set text[];
BEGIN
  PERFORM emr_access.require_placement();
  IF octet_length(p_payload) > 65536 OR jsonb_typeof(e) IS DISTINCT FROM 'object'
    OR e->>'eventId' IS NULL OR e->>'occurredAt' IS NULL OR e->'userId' IS NULL
    OR p_act IS NULL OR p_act NOT IN ('기재','추가기재','수정','열람','none')
    OR jsonb_typeof(e->'targets') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'AccessPayloadInvalid' USING ERRCODE = 'EB003';
  END IF;
  stream_set := emr_access.event_streams(e,p_act);
  -- Serialize only admission's bounded pending counter, not clinical work.
  PERFORM 1 FROM emr_access.ledger_metadata FOR UPDATE;
  SELECT * INTO o FROM emr_access.operation WHERE event_id = e->>'eventId' FOR UPDATE;
  IF NOT FOUND THEN
    IF (SELECT count(*) FROM emr_access.operation WHERE pending) >= 128 THEN
      RAISE EXCEPTION 'PendingCapacity' USING ERRCODE = 'EB011';
    END IF;
    INSERT INTO emr_access.operation(operation_id,event_id,content_sha256,actor_sha256,streams)
      VALUES (p_operation,e->>'eventId',content_hash,actor_hash,stream_set) RETURNING * INTO o;
  END IF;
  IF o.content_sha256 <> content_hash OR o.actor_sha256 <> actor_hash OR o.streams <> stream_set
    OR EXISTS (SELECT FROM emr_access.operation WHERE operation_id = p_operation AND operation_id <> o.operation_id) THEN
    RAISE EXCEPTION 'AccessEventIdConflict' USING ERRCODE = 'EB002';
  END IF;
  -- Operation first, then stream attempts in the declared fixed order.
  FOREACH s IN ARRAY o.streams LOOP
    INSERT INTO emr_access.attempt(stream,attempt_id,operation_id) VALUES (s,p_attempt,o.operation_id)
      ON CONFLICT (stream,attempt_id) DO NOTHING;
    IF NOT EXISTS (SELECT FROM emr_access.attempt WHERE stream=s AND attempt_id=p_attempt AND operation_id=o.operation_id) THEN
      RAISE EXCEPTION 'AttemptBindingConflict' USING ERRCODE = 'EB002';
    END IF;
  END LOOP;
  RETURN o.operation_id;
END $$;

CREATE FUNCTION emr_access.lock_operation(p_operation uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE result text;
BEGIN
  PERFORM 1 FROM emr_access.operation WHERE operation_id=p_operation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OperationMissing' USING ERRCODE='EB003'; END IF;
  SELECT outcome INTO result FROM emr_access.attempt_outcome WHERE operation_id=p_operation;
  RETURN COALESCE(result,'pending');
END $$;

CREATE FUNCTION emr_access.operation_result(p_operation uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('operationId',o.operation_id,'eventId',o.event_id,
    'outcome',COALESCE(t.outcome,'pending'),'durableAt',t.recorded_at,
    'result',CASE WHEN t.result_id IS NULL THEN NULL ELSE jsonb_build_object(
      'kind',t.result_kind,'id',t.result_id,'version',t.result_version) END,
    'entries',COALESCE((SELECT jsonb_agg(jsonb_build_object('entryId',r.entry_id,'stream',r.stream,
      'attemptId',r.attempt_id,'expired',NOT EXISTS(SELECT FROM emr_access.access_entry e WHERE e.entry_id=r.entry_id))
      ORDER BY r.stream) FROM emr_access.entry_receipt r WHERE r.operation_id=o.operation_id),'[]'::jsonb))
  FROM emr_access.operation o LEFT JOIN emr_access.attempt_outcome t USING(operation_id) WHERE o.operation_id=p_operation;
$$;

CREATE FUNCTION emr_access.append_operation(p_operation uuid, p_attempt uuid, p_payload text, p_act text,
  p_result_kind text, p_result_id text, p_result_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o emr_access.operation%ROWTYPE; e jsonb := p_payload::jsonb; s text; entry uuid; state text;
BEGIN
  state := emr_access.lock_operation(p_operation);
  SELECT * INTO STRICT o FROM emr_access.operation WHERE operation_id=p_operation;
  IF o.content_sha256 <> encode(sha256(convert_to(p_act || ':' || p_payload,'UTF8')),'hex')
    OR o.streams <> emr_access.event_streams(e,p_act) THEN
    RAISE EXCEPTION 'AccessEventIdConflict' USING ERRCODE='EB002';
  END IF;
  IF state <> 'pending' THEN RETURN emr_access.operation_result(p_operation); END IF;
  PERFORM emr_access.require_placement();
  FOREACH s IN ARRAY o.streams LOOP
    IF NOT EXISTS(SELECT FROM emr_access.attempt WHERE stream=s AND attempt_id=p_attempt AND operation_id=p_operation) THEN
      RAISE EXCEPTION 'AttemptMissing' USING ERRCODE='EB003';
    END IF;
    INSERT INTO emr_access.entry_receipt(operation_id,stream,event_id,attempt_id)
      VALUES(p_operation,s,o.event_id,p_attempt) RETURNING entry_id INTO entry;
    INSERT INTO emr_access.access_entry(entry_id,operation_id,stream,event_id,payload,occurred_at,statutory_act,retention_class)
      VALUES(entry,p_operation,s,o.event_id,p_payload,(e->>'occurredAt')::timestamptz,p_act,
        CASE WHEN s='history' THEN 'record-history'
          WHEN e->>'result'='succeeded' AND p_act IN ('기재','추가기재','수정') AND EXISTS
            (SELECT FROM jsonb_array_elements(e->'targets') t WHERE t->>'kind'='identity-access') THEN 'rights3y'
          ELSE 'viewing2y' END);
    INSERT INTO emr_access.access_target(entry_id,target_index,target_kind,record_id,version_id)
      SELECT entry,(ordinality-1)::integer,t->>'kind',
        CASE WHEN t->'recordId'->>'status'='known' THEN t->'recordId'->>'value' END,
        CASE WHEN t->'versionId'->>'status'='known' THEN t->'versionId'->>'value' END
      FROM jsonb_array_elements(e->'targets') WITH ORDINALITY a(t,ordinality);
  END LOOP;
  INSERT INTO emr_access.attempt_outcome(operation_id,outcome,result_kind,result_id,result_version)
    VALUES(p_operation,'committed',p_result_kind,p_result_id,p_result_version);
  UPDATE emr_access.operation SET pending=false WHERE operation_id=p_operation;
  RETURN emr_access.operation_result(p_operation);
END $$;

-- The same operation lock waits out a transaction with a lost COMMIT reply.
-- A timeout rolls this transaction back; it cannot manufacture a negative.
CREATE FUNCTION emr_access.settle_operation(p_operation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF emr_access.lock_operation(p_operation)='pending' THEN
    INSERT INTO emr_access.attempt_outcome(operation_id,outcome) VALUES(p_operation,'negative');
    UPDATE emr_access.operation SET pending=false WHERE operation_id=p_operation;
  END IF;
  RETURN emr_access.operation_result(p_operation);
END $$;

CREATE FUNCTION emr_access.pending_operations(p_limit integer) RETURNS TABLE(operation_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT operation_id FROM emr_access.operation WHERE pending ORDER BY admitted_at,operation_id
    LIMIT LEAST(GREATEST(p_limit,0),128);
$$;

CREATE FUNCTION emr_access.record_failure(p_id uuid,p_operation uuid,p_event text,p_at timestamptz,p_cause text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- A delayed outage-spool retry cannot resurrect an expired failure payload.
  -- This comparison key serves delivery recovery until H closes its copy lineage.
  PERFORM pg_advisory_xact_lock(77104,2);
  IF EXISTS (SELECT FROM emr_access.disposal_fact WHERE failure_id=p_id) THEN
    IF NOT EXISTS (SELECT FROM emr_access.disposal_fact WHERE failure_id=p_id AND failure_binding=
      encode(sha256(convert_to(jsonb_build_array(p_operation,p_event,extract(epoch FROM p_at),p_cause)::text,'UTF8')),'hex')) THEN
      RAISE EXCEPTION 'FailureBindingConflict' USING ERRCODE='EB002';
    END IF;
    RETURN;
  END IF;
  INSERT INTO emr_access.failure_entry(failure_id,operation_id,event_id,occurred_at,cause)
    VALUES(p_id,p_operation,p_event,p_at,p_cause) ON CONFLICT(failure_id) DO NOTHING;
  IF NOT EXISTS (SELECT FROM emr_access.failure_entry WHERE failure_id=p_id
    AND operation_id IS NOT DISTINCT FROM p_operation AND event_id IS NOT DISTINCT FROM p_event
    AND occurred_at=p_at AND cause=p_cause) THEN
    RAISE EXCEPTION 'FailureBindingConflict' USING ERRCODE='EB002';
  END IF;
END $$;

CREATE FUNCTION emr_access.entries_after(p_after bigint,p_limit integer)
RETURNS SETOF emr_access.access_entry LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM emr_access.access_entry WHERE sequence>p_after ORDER BY sequence LIMIT LEAST(GREATEST(p_limit,0),1000);
$$;
CREATE FUNCTION emr_access.entry_for_event(p_stream text,p_event text)
RETURNS SETOF emr_access.access_entry LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM emr_access.access_entry WHERE stream=p_stream AND event_id=p_event;
$$;

-- Hold/duty writers and expiry share one transaction lock. This is the existing
-- legal-duty boundary, including a hold arriving while expiry is running.
CREATE FUNCTION emr_access.lock_retention_facts() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(77104,2);
  RETURN NEW;
END $$;
CREATE TRIGGER hold_retention_lock BEFORE INSERT ON emr_access.legal_hold_event
  FOR EACH ROW EXECUTE FUNCTION emr_access.lock_retention_facts();
CREATE TRIGGER duty_retention_lock BEFORE INSERT ON emr_access.duty_request_event
  FOR EACH ROW EXECUTE FUNCTION emr_access.lock_retention_facts();

-- H supplies the actual record/version endings. Missing or incomplete endings
-- never become permission to remove history. The access floor applies as well.
CREATE FUNCTION emr_access.expire_entry(p_entry uuid, p_record_ends jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e emr_access.access_entry%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(77104,2);
  SELECT * INTO e FROM emr_access.access_entry WHERE entry_id=p_entry FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF e.retention_class='record-history' THEN
    IF p_record_ends IS NULL OR jsonb_typeof(p_record_ends)<>'array' THEN
      RAISE EXCEPTION 'RecordEndingEvidenceRequired' USING ERRCODE='EB004';
    END IF;
    IF EXISTS (WITH targets AS (SELECT * FROM emr_access.access_target WHERE entry_id=p_entry
        AND target_kind NOT IN ('preferences','reading-template','institution','identity-access','authentication-session','system-operation'))
      SELECT 1 WHERE NOT EXISTS (SELECT FROM targets)
      OR jsonb_array_length(p_record_ends)<>(SELECT count(*) FROM targets)
      OR EXISTS (SELECT FROM targets t WHERE
        (SELECT count(*) FROM jsonb_array_elements(p_record_ends) r WHERE r->>'recordId'=t.record_id
          AND r->>'versionId'=t.version_id AND r->>'kind'=t.target_kind
          AND length(r->>'evidenceId')>0 AND (r->>'endsAt')::timestamptz<=clock_timestamp())<>1)) THEN
      RAISE EXCEPTION 'RecordEndingEvidenceRequired' USING ERRCODE='EB004';
    END IF;
  END IF;
  IF emr_access.civil_period_end(e.occurred_at,CASE WHEN e.retention_class='rights3y' THEN 3 ELSE 2 END)>clock_timestamp() THEN
    RAISE EXCEPTION 'RetentionNotElapsed' USING ERRCODE='EB004';
  END IF;
  IF EXISTS (SELECT FROM emr_access.legal_hold_event h WHERE h.phase='placed'
      AND (h.record_id=e.event_id OR h.record_id IN (SELECT record_id FROM emr_access.access_target WHERE entry_id=p_entry))
      AND NOT EXISTS (SELECT FROM emr_access.legal_hold_event r WHERE r.hold_id=h.hold_id AND r.phase='released'))
    OR EXISTS (SELECT FROM emr_access.duty_request_event d WHERE d.phase='received'
      AND NOT EXISTS (SELECT FROM emr_access.duty_request_event r WHERE r.kind=d.kind AND r.request_id=d.request_id AND r.phase='resolved')
      AND EXISTS (SELECT FROM jsonb_array_elements_text(d.body::jsonb->'recordIds') id
        WHERE id=e.event_id OR id IN (SELECT record_id FROM emr_access.access_target WHERE entry_id=p_entry))) THEN
    RAISE EXCEPTION 'LegalDutyActive' USING ERRCODE='EB005';
  END IF;
  INSERT INTO emr_access.disposal_fact(entry_id,basis) VALUES(p_entry,'retention-elapsed');
  DELETE FROM emr_access.access_entry WHERE entry_id=p_entry;
  RETURN true;
END $$;

CREATE FUNCTION emr_access.expire_entry(p_entry uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT emr_access.expire_entry(p_entry,NULL::jsonb)
$$;

CREATE FUNCTION emr_access.expire_failure(p_failure uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE f emr_access.failure_entry%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(77104,2);
  SELECT * INTO f FROM emr_access.failure_entry WHERE failure_id=p_failure FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF emr_access.civil_period_end(f.occurred_at,2)>clock_timestamp() THEN
    RAISE EXCEPTION 'RetentionNotElapsed' USING ERRCODE='EB004';
  END IF;
  IF EXISTS (SELECT FROM emr_access.legal_hold_event h WHERE h.phase='placed'
      AND (h.record_id=f.event_id OR h.record_id IN (SELECT t.record_id FROM emr_access.access_target t
        JOIN emr_access.access_entry e USING(entry_id) WHERE e.operation_id=f.operation_id))
      AND NOT EXISTS (SELECT FROM emr_access.legal_hold_event r WHERE r.hold_id=h.hold_id AND r.phase='released'))
    OR EXISTS (SELECT FROM emr_access.duty_request_event d WHERE d.phase='received'
      AND NOT EXISTS (SELECT FROM emr_access.duty_request_event r WHERE r.kind=d.kind AND r.request_id=d.request_id AND r.phase='resolved')
      AND EXISTS (SELECT FROM jsonb_array_elements_text(d.body::jsonb->'recordIds') id
        WHERE id=f.event_id OR id IN (SELECT t.record_id FROM emr_access.access_target t
          JOIN emr_access.access_entry e USING(entry_id) WHERE e.operation_id=f.operation_id))) THEN
    RAISE EXCEPTION 'LegalDutyActive' USING ERRCODE='EB005';
  END IF;
  INSERT INTO emr_access.disposal_fact(failure_id,failure_binding,basis) VALUES(p_failure,
    encode(sha256(convert_to(jsonb_build_array(f.operation_id,f.event_id,extract(epoch FROM f.occurred_at),f.cause)::text,'UTF8')),'hex'),
    'retention-elapsed');
  DELETE FROM emr_access.failure_entry WHERE failure_id=p_failure;
  RETURN true;
END $$;

-- D1796: a private restored copy reuses the ordinary checked row expiry.
-- Record-history still needs H's actual ending evidence; age alone cannot
-- establish its lifetime. The receipt reports that unfinished work explicitly.
CREATE FUNCTION emr_access.restore_expiry_sweep(p_history_endings jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record; entries bigint:=0; failures bigint:=0; held bigint:=0; unknown_history bigint:=0;
BEGIN
  IF p_history_endings IS NULL OR jsonb_typeof(p_history_endings)<>'object' THEN
    RAISE EXCEPTION 'RecordEndingEvidenceRequired' USING ERRCODE='EB004';
  END IF;
  PERFORM pg_advisory_xact_lock(77104,2);
  FOR r IN SELECT entry_id,retention_class FROM emr_access.access_entry
    WHERE emr_access.civil_period_end(occurred_at,CASE WHEN retention_class='rights3y' THEN 3 ELSE 2 END)<=clock_timestamp()
  LOOP
    IF r.retention_class='record-history' AND NOT p_history_endings ? r.entry_id::text THEN
      unknown_history:=unknown_history+1;
      CONTINUE;
    END IF;
    BEGIN
      IF emr_access.expire_entry(r.entry_id,p_history_endings->r.entry_id::text) THEN entries:=entries+1; END IF;
    EXCEPTION WHEN SQLSTATE 'EB005' THEN held:=held+1;
    END;
  END LOOP;
  FOR r IN SELECT failure_id FROM emr_access.failure_entry
    WHERE emr_access.civil_period_end(occurred_at,2)<=clock_timestamp()
  LOOP
    BEGIN
      IF emr_access.expire_failure(r.failure_id) THEN failures:=failures+1; END IF;
    EXCEPTION WHEN SQLSTATE 'EB005' THEN held:=held+1;
    END;
  END LOOP;
  RETURN jsonb_build_object('ran',true,'checkedAt',clock_timestamp(),'deletedEntries',entries,
    'deletedFailures',failures,'retainedByDutyOrHold',held,'historyRetainedUnknownLifetime',unknown_history,
    'complete',true);
END $$;

RESET ROLE;
REVOKE ALL ON ALL TABLES IN SCHEMA emr_access FROM PUBLIC,kin_runtime,kin_emr_retention;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA emr_access FROM PUBLIC,kin_runtime,kin_emr_retention;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA emr_access FROM PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA emr_access TO kin_emr_reader;
GRANT EXECUTE ON FUNCTION emr_access.admit_operation(uuid,uuid,text,text),
  emr_access.lock_operation(uuid),emr_access.append_operation(uuid,uuid,text,text,text,text,text),
  emr_access.settle_operation(uuid),emr_access.operation_result(uuid),emr_access.pending_operations(integer),
  emr_access.record_failure(uuid,uuid,text,timestamptz,text),emr_access.entries_after(bigint,integer),
  emr_access.entry_for_event(text,text) TO kin_runtime;
GRANT EXECUTE ON FUNCTION emr_access.entries_after(bigint,integer),emr_access.entry_for_event(text,text)
  TO kin_emr_reader;
GRANT EXECUTE ON FUNCTION emr_access.expire_entry(uuid),emr_access.expire_entry(uuid,jsonb),
  emr_access.expire_failure(uuid),emr_access.restore_expiry_sweep(jsonb) TO kin_emr_retention;
COMMIT;
