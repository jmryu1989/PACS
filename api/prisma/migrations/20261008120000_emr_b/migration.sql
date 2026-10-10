-- EMR-B1 (REQ-EMR-01/02/06/07/19/20, D589/D591/D596): the protected access ledger and its legal-duty records.
--
-- Storage boundary. Everything lives in schema emr_access, owned by the non-login role kin_emr_owner, in the same
-- PostgreSQL database as the business tables, so a business change and its ledger append commit in one transaction
-- (a second database written in sequence is not one commit). The objects are placed in the dedicated tablespace
-- kin_emr_access on its own volume. CREATE TABLESPACE cannot run inside a transaction, so it is an installation step
-- (scripts/emr-compose.py provision, which runs outside this file); when it is absent this migration still applies and
-- the relations sit in the database default, but every ledger write refuses with EmrStoragePlacementRequired until
-- provisioning has moved them - there is no silent public fallback.
--
-- Credentials. This file runs with the installer credential only (prisma migrate deploy in the migration process). It
-- creates the four EMR roles if absent and never gives them a password; provisioning grants LOGIN and the secrets. The
-- application runtime kin_runtime gets business DML and EXECUTE on the verified append functions, never INSERT/UPDATE/
-- DELETE on a ledger table, ownership, membership of an owner, SET ROLE or any elevated attribute. kin_emr_reader reads
-- the ledger, kin_emr_retention can only call expire_prefix. A role found with an elevated attribute or a membership
-- stops the migration instead of being trusted.
--
-- Chains. Two streams (D-1): 'viewing' (every event, its own floor, prefix expiry) and 'history' (record changes, kept
-- with the changed record). append_access computes sequence, previousHash and SHA-256 under the stream's head row lock,
-- over exactly the bytes A's chainEntry hashes: '{"sequence":N,"previousHash":"<hex>","payload":' || payload || '}'. The
-- payload text is the server's JSON.stringify of A's parsed event and is stored verbatim (text, not jsonb, so the hashed
-- bytes survive). Retries of the same event ID with the same payload return the stored entry; the same ID with other
-- content is refused. Deletion exists only in expire_prefix, for the viewing stream: an expired, unheld prefix and its
-- non-personal checkpoint commit together; the history stream goes with its record's destruction set (unit H).
-- Retention (commander D727, legal register §5-11): no deadline is stored. It is computed when destruction is considered,
-- by one rule (contract.ts accessDeadline) over the entry's own time - a viewing entry ends at the floor declared once
-- below (access_retention_floor) unless held - and, for a history entry, the retention of the records bound in access_target.
BEGIN;

DO $$
DECLARE
  emr_roles constant text[] := ARRAY['kin_emr_owner', 'kin_runtime', 'kin_emr_reader', 'kin_emr_retention'];
  r text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'EMR-B migration requires the installer credential' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH r IN ARRAY emr_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ANY (emr_roles)
             AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'EMR roles must not hold elevated attributes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kin_emr_owner' AND rolcanlogin) THEN
    RAISE EXCEPTION 'kin_emr_owner must not log in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
             JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid JOIN pg_catalog.pg_roles member ON member.oid = m.member
             WHERE granted.rolname = ANY (emr_roles) OR member.rolname = ANY (emr_roles)) THEN
    RAISE EXCEPTION 'EMR roles must not be members of or granted to any role' USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;

-- The application runtime: business DML only. AuditLog stays insert/select (its trigger refuses the rest for everyone);
-- the migration history is not the runtime's. Later migrations of the installer keep the same grants by default.
GRANT USAGE ON SCHEMA public TO kin_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kin_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO kin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON public."AuditLog" FROM kin_runtime;
DO $$ BEGIN
  IF pg_catalog.to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public._prisma_migrations FROM kin_runtime';
  END IF;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kin_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO kin_runtime;

CREATE SCHEMA emr_access AUTHORIZATION kin_emr_owner;
REVOKE ALL ON SCHEMA emr_access FROM PUBLIC;
GRANT USAGE ON SCHEMA emr_access TO kin_runtime, kin_emr_reader, kin_emr_retention;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_tablespace WHERE spcname = 'kin_emr_access') THEN
    EXECUTE 'SET LOCAL default_tablespace = kin_emr_access';
  END IF;
END $$;
SET LOCAL ROLE kin_emr_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA emr_access REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Two streams (D-1, legal register 2026-10-09 §5-11, commander D727). 'viewing' holds every access event for its own floor
-- (열람 events, events about no EMR record, and the floor remainder of every change) and is the only stream with prefix
-- expiry. 'history' holds the change history of EMR records - a succeeded 기재·추가기재·수정 about at least one record - kept
-- with the changed record and removed only with that record's destruction set (unit H; this unit has no such deletion).
-- Each stream is its own chain with its own head and identity.
CREATE TABLE emr_access.chain_head (
  stream text PRIMARY KEY CHECK (stream IN ('viewing', 'history')),
  chain_id uuid NOT NULL UNIQUE,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$')
);
INSERT INTO emr_access.chain_head (stream, chain_id, sequence, hash) VALUES
  ('viewing', pg_catalog.gen_random_uuid(), 0, pg_catalog.repeat('0', 64)),
  ('history', pg_catalog.gen_random_uuid(), 0, pg_catalog.repeat('0', 64));

-- No deadline is stored: it is computed when destruction is considered (api/src/emr-runtime/contract.ts accessDeadline).
-- statutory_act is A's 의료법 제23조④ mapping of the event's action, bound with it.
CREATE TABLE emr_access.access_entry (
  stream text NOT NULL CHECK (stream IN ('viewing', 'history')),
  sequence bigint NOT NULL CHECK (sequence >= 1),
  previous_hash text NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  hash text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('access', 'expiry', 'history')),
  statutory_act text CHECK (statutory_act IN ('기재', '추가기재', '수정', '열람', 'none')),
  event_id text CHECK (event_id IS NULL OR (pg_catalog.length(event_id) BETWEEN 1 AND 200)),
  payload text NOT NULL CHECK (pg_catalog.octet_length(payload) <= 65536),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  stored_at timestamptz NOT NULL,
  PRIMARY KEY (stream, sequence),
  UNIQUE (stream, event_id),
  CHECK ((stream = 'viewing' AND kind IN ('access', 'expiry')) OR (stream = 'history' AND kind = 'history')),
  CHECK ((kind = 'expiry') = (event_id IS NULL)),
  CHECK ((kind = 'expiry') = (statutory_act IS NULL)),
  CHECK (stream = 'viewing' OR statutory_act IN ('기재', '추가기재', '수정'))
);

-- Each record target of an event (every target A did not mark non-record, in payload order), derived by append_access from
-- the chained payload itself: the record and version an event is about, which unit H reads to build a destruction set.
CREATE TABLE emr_access.access_target (
  stream text NOT NULL,
  sequence bigint NOT NULL,
  target_index integer NOT NULL CHECK (target_index >= 0),
  event_id text NOT NULL,
  target_kind text NOT NULL CHECK (pg_catalog.length(target_kind) BETWEEN 1 AND 100),
  record_id text CHECK (record_id IS NULL OR pg_catalog.length(record_id) BETWEEN 1 AND 200),
  version_id text CHECK (version_id IS NULL OR pg_catalog.length(version_id) BETWEEN 1 AND 200),
  PRIMARY KEY (stream, sequence, target_index),
  FOREIGN KEY (stream, sequence) REFERENCES emr_access.access_entry (stream, sequence)
);
CREATE INDEX access_target_record ON emr_access.access_target (record_id, version_id);

-- Unit B2 records here the one legacy AuditLog row that projects each new original event (eventId <-> Int id, once).
CREATE TABLE emr_access.audit_projection (
  event_id text PRIMARY KEY,
  audit_log_id integer NOT NULL UNIQUE,
  recorded_at timestamptz NOT NULL
);

-- The immutable internal member ID is bound to the verified issuer and subject only; names and e-mail are display values.
CREATE TABLE emr_access.member_identity (
  id uuid PRIMARY KEY,
  issuer text NOT NULL CHECK (pg_catalog.length(issuer) BETWEEN 1 AND 512),
  subject text NOT NULL CHECK (pg_catalog.length(subject) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL,
  UNIQUE (issuer, subject)
);

-- Legal holds, access/correction requests and the reviewed clause history are append-only facts. A release is a second
-- fact of the same hold; nothing is rewritten, and a complete listing returns placed, ended and released holds alike.
CREATE TABLE emr_access.legal_hold_event (
  hold_id text NOT NULL CHECK (pg_catalog.length(hold_id) BETWEEN 1 AND 200),
  phase text NOT NULL CHECK (phase IN ('placed', 'released')),
  record_id text NOT NULL CHECK (pg_catalog.length(record_id) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (pg_catalog.octet_length(body) <= 65536),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (hold_id, phase)
);
CREATE INDEX legal_hold_event_record ON emr_access.legal_hold_event (record_id);
-- D-24 order facts are append-only evidence, distinct from the C unit's mutable registration projection.
CREATE TABLE emr_access.order_fact (
  record_id text NOT NULL CHECK (length(record_id) BETWEEN 1 AND 200),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  sequence bigint NOT NULL CHECK (sequence > 0),
  previous_event_id text,
  body text NOT NULL CHECK (octet_length(body) <= 65536),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (record_id, sequence), UNIQUE (record_id, event_id)
);
CREATE TABLE emr_access.duty_request_event (
  kind text NOT NULL CHECK (kind IN ('access-request', 'correction-request')),
  request_id text NOT NULL CHECK (pg_catalog.length(request_id) BETWEEN 1 AND 200),
  phase text NOT NULL CHECK (phase IN ('received', 'resolved')),
  body text NOT NULL CHECK (pg_catalog.octet_length(body) <= 65536),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (kind, request_id, phase)
);
CREATE TABLE emr_access.clause_version (
  clause_id text NOT NULL CHECK (pg_catalog.length(clause_id) BETWEEN 1 AND 200),
  publication text NOT NULL CHECK (pg_catalog.length(publication) BETWEEN 1 AND 100),
  law text NOT NULL CHECK (pg_catalog.length(law) BETWEEN 1 AND 100),
  article text NOT NULL CHECK (pg_catalog.length(article) BETWEEN 1 AND 100),
  published_at date NOT NULL,
  effective_at date NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (clause_id, publication),
  UNIQUE (clause_id, effective_at),
  CHECK (published_at <= effective_at)
);

-- Append-only for every role, the owner included. The two deliberate changes - the head row moved by an append and an
-- expired prefix removed by expire_prefix - mark their own transaction first; privileges, not these markers, keep the
-- runtime out (it holds no UPDATE/DELETE/TRUNCATE on any of these tables).
CREATE FUNCTION emr_access.refuse_change() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'chain_head' AND current_setting('kin.emr_append', true) = 'head' THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('access_entry', 'access_target', 'audit_projection') AND current_setting('kin.emr_expiry', true) = 'prefix' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'emr_access is append-only: % on % refused', TG_OP, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER chain_head_guard BEFORE UPDATE OR DELETE ON emr_access.chain_head FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER chain_head_truncate BEFORE TRUNCATE ON emr_access.chain_head FOR EACH STATEMENT EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER access_entry_guard BEFORE UPDATE OR DELETE ON emr_access.access_entry FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER access_entry_truncate BEFORE TRUNCATE ON emr_access.access_entry FOR EACH STATEMENT EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER access_target_guard BEFORE UPDATE OR DELETE ON emr_access.access_target FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER access_target_truncate BEFORE TRUNCATE ON emr_access.access_target FOR EACH STATEMENT EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER audit_projection_guard BEFORE UPDATE OR DELETE ON emr_access.audit_projection FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER audit_projection_truncate BEFORE TRUNCATE ON emr_access.audit_projection FOR EACH STATEMENT EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER member_identity_guard BEFORE UPDATE OR DELETE ON emr_access.member_identity FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER member_identity_truncate BEFORE TRUNCATE ON emr_access.member_identity FOR EACH STATEMENT EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER legal_hold_event_guard BEFORE UPDATE OR DELETE ON emr_access.legal_hold_event FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER legal_hold_event_truncate BEFORE TRUNCATE ON emr_access.legal_hold_event FOR EACH STATEMENT EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER duty_request_event_guard BEFORE UPDATE OR DELETE ON emr_access.duty_request_event FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER duty_request_event_truncate BEFORE TRUNCATE ON emr_access.duty_request_event FOR EACH STATEMENT EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER clause_version_guard BEFORE UPDATE OR DELETE ON emr_access.clause_version FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER clause_version_truncate BEFORE TRUNCATE ON emr_access.clause_version FOR EACH STATEMENT EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER order_fact_guard BEFORE UPDATE OR DELETE ON emr_access.order_fact FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_change();
CREATE TRIGGER order_fact_truncate BEFORE TRUNCATE ON emr_access.order_fact FOR EACH STATEMENT EXECUTE FUNCTION emr_access.refuse_change();

-- A's civilPeriodEnd: Asia/Seoul civil days at the fixed +09:00 offset; the first day is the starting event's civil day
-- (D-21, 행정기본법 제6조②1); the period ends with the day before the corresponding day of the last year, weekends and
-- holidays included; a 29 February start ends with 28 February (민법 제159·160조). The exclusive boundary, in UTC.
CREATE FUNCTION emr_access.civil_period_end(p_at timestamptz, p_years integer) RETURNS timestamptz
  LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  local_time timestamp := (p_at AT TIME ZONE 'UTC') + interval '9 hours';
  midnight timestamp := date_trunc('day', local_time);
  start_day date;
  y integer; m integer; d integer; target date;
BEGIN
  IF p_years < 1 THEN RAISE EXCEPTION 'Whole positive calendar years required' USING ERRCODE = 'invalid_parameter_value'; END IF;
  -- D-21 (행정기본법 제6조②1): the first day is the civil day of the starting event, whatever its time.
  start_day := midnight::date;
  y := extract(year FROM start_day)::integer + p_years;
  m := extract(month FROM start_day)::integer;
  d := extract(day FROM start_day)::integer;
  IF m = 2 AND d = 29 AND NOT ((y % 4 = 0 AND y % 100 <> 0) OR y % 400 = 0) THEN target := make_date(y, 3, 1);
  ELSE target := make_date(y, m, d);
  END IF;
  RETURN (target::timestamp - interval '9 hours') AT TIME ZONE 'UTC';
END
$$;

-- The database's one declaration of the access-chain retention floor, the counterpart of B's single rule
-- (api/src/emr-runtime/contract.ts ACCESS_RETENTION / accessRetentionFloor, from A's classification row for access
-- records): the end for an entry about no EMR record, and the least end of any entry. The contract and live suites hold
-- the two equal. expire_prefix reads it here.
CREATE FUNCTION emr_access.access_retention_floor(p_at timestamptz) RETURNS timestamptz
-- SQL-standard body binds the one floor to its calendar dependency at creation (and prevents dropping it).
  LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp
  RETURN emr_access.civil_period_end(p_at, 2);

-- Every ledger relation, its indexes and TOAST storage must be in kin_emr_access; otherwise nothing is written.
CREATE FUNCTION emr_access.storage_placement() RETURNS TABLE (relation text, relkind text, tablespace text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH own AS (
    SELECT c.oid, c.relname::text AS relation, c.relkind::text AS relkind, c.reltablespace, c.reltoastrelid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'emr_access' AND c.relkind IN ('r', 'i')
  ), toast AS (
    SELECT t.oid, own.relation || ':toast' AS relation, 't'::text AS relkind, t.reltablespace FROM own JOIN pg_class t ON t.oid = own.reltoastrelid
    UNION ALL
    SELECT i.oid, own.relation || ':toast-index', 'i', i.reltablespace FROM own JOIN pg_index x ON x.indrelid = own.reltoastrelid JOIN pg_class i ON i.oid = x.indexrelid
  )
  SELECT p.relation, p.relkind, COALESCE((SELECT spcname::text FROM pg_tablespace s WHERE s.oid = p.reltablespace), 'database-default')
  FROM (SELECT relation, relkind, reltablespace FROM own UNION ALL SELECT relation, relkind, reltablespace FROM toast) p
  ORDER BY 1;
$$;
CREATE FUNCTION emr_access.require_placement() RETURNS void
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tablespace WHERE spcname = 'kin_emr_access')
     OR EXISTS (SELECT 1 FROM emr_access.storage_placement() p WHERE p.tablespace <> 'kin_emr_access') THEN
    RAISE EXCEPTION 'EmrStoragePlacementRequired' USING ERRCODE = 'EB001';
  END IF;
END
$$;

CREATE FUNCTION emr_access.chain_hash(p_sequence bigint, p_previous text, p_payload text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(sha256(convert_to('{"sequence":' || p_sequence::text || ',"previousHash":"' || p_previous || '","payload":' || p_payload || '}', 'UTF8')), 'hex');
$$;

CREATE FUNCTION emr_access.append_access(p_stream text, p_event_id text, p_payload text, p_statutory_act text)
  RETURNS TABLE (chain_id uuid, sequence bigint, previous_hash text, hash text, stored_at timestamptz, replay boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  head emr_access.chain_head%ROWTYPE;
  existing emr_access.access_entry%ROWTYPE;
  doc json;
  occurred timestamptz;
  entry_kind text := CASE p_stream WHEN 'viewing' THEN 'access' WHEN 'history' THEN 'history' END;
  next_sequence bigint;
  next_hash text;
  stored timestamptz := clock_timestamp();
BEGIN
  PERFORM emr_access.require_placement();
  BEGIN
    doc := p_payload::json;
    occurred := (doc -> 'event' ->> 'occurredAt')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'AccessPayloadInvalid' USING ERRCODE = 'EB003';
  END;
  IF entry_kind IS NULL OR p_event_id IS NULL OR doc ->> 'kind' IS DISTINCT FROM entry_kind
     OR doc -> 'event' ->> 'eventId' IS DISTINCT FROM p_event_id
     OR occurred IS NULL OR pg_catalog.json_typeof(doc -> 'event' -> 'targets') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM pg_catalog.json_array_elements(doc -> 'event' -> 'targets') t(value)
                WHERE pg_catalog.json_typeof(t.value) IS DISTINCT FROM 'object' OR t.value ->> 'kind' IS NULL)
     OR p_statutory_act IS NULL OR p_statutory_act NOT IN ('기재', '추가기재', '수정', '열람', 'none')
     -- The history stream is a record's change history: a change act about at least one record target.
     OR (p_stream = 'history' AND (p_statutory_act NOT IN ('기재', '추가기재', '수정') OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.json_array_elements(doc -> 'event' -> 'targets') t(value)
           WHERE (t.value -> 'recordId' ->> 'status') IS DISTINCT FROM 'not-applicable'))) THEN
    RAISE EXCEPTION 'AccessPayloadInvalid' USING ERRCODE = 'EB003';
  END IF;
  SELECT * INTO head FROM emr_access.chain_head h WHERE h.stream = p_stream FOR UPDATE;
  SELECT * INTO existing FROM emr_access.access_entry e WHERE e.stream = p_stream AND e.event_id = p_event_id;
  IF FOUND THEN
    IF existing.payload = p_payload AND existing.statutory_act = p_statutory_act THEN
      RETURN QUERY SELECT head.chain_id, existing.sequence, existing.previous_hash, existing.hash, existing.stored_at, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'AccessEventIdConflict' USING ERRCODE = 'EB002';
  END IF;
  next_sequence := head.sequence + 1;
  next_hash := emr_access.chain_hash(next_sequence, head.hash, p_payload);
  INSERT INTO emr_access.access_entry (stream, sequence, previous_hash, hash, kind, statutory_act, event_id, payload, content_sha256, occurred_at, stored_at)
    VALUES (p_stream, next_sequence, head.hash, next_hash, entry_kind, p_statutory_act, p_event_id, p_payload,
            encode(sha256(convert_to(p_payload, 'UTF8')), 'hex'), occurred, stored);
  -- Its record targets, from the same bytes: A marks a non-record target's record fact 'not-applicable'; every other
  -- target is about an EMR record (its record and version IDs when known, NULL when the event could not resolve them).
  INSERT INTO emr_access.access_target (stream, sequence, target_index, event_id, target_kind, record_id, version_id)
  SELECT p_stream, next_sequence, (t.position - 1)::integer, p_event_id, t.value ->> 'kind',
         CASE WHEN t.value -> 'recordId' ->> 'status' = 'known' THEN t.value -> 'recordId' ->> 'value' END,
         CASE WHEN t.value -> 'versionId' ->> 'status' = 'known' THEN t.value -> 'versionId' ->> 'value' END
  FROM pg_catalog.json_array_elements(doc -> 'event' -> 'targets') WITH ORDINALITY AS t(value, position)
  WHERE (t.value -> 'recordId' ->> 'status') IS DISTINCT FROM 'not-applicable';
  PERFORM set_config('kin.emr_append', 'head', true);
  UPDATE emr_access.chain_head h SET sequence = next_sequence, hash = next_hash WHERE h.stream = p_stream;
  PERFORM set_config('kin.emr_append', '', true);
  RETURN QUERY SELECT head.chain_id, next_sequence, head.hash, next_hash, stored, false;
END
$$;

CREATE FUNCTION emr_access.chain_tail(p_stream text) RETURNS TABLE (chain_id uuid, sequence bigint, hash text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT h.chain_id, h.sequence, h.hash FROM emr_access.chain_head h WHERE h.stream = p_stream;
$$;
CREATE FUNCTION emr_access.entries_after(p_stream text, p_after bigint, p_limit integer)
  RETURNS TABLE (sequence bigint, previous_hash text, hash text, kind text, statutory_act text, event_id text, payload text, content_sha256 text, stored_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.sequence, e.previous_hash, e.hash, e.kind, e.statutory_act, e.event_id, e.payload, e.content_sha256, e.stored_at
  FROM emr_access.access_entry e WHERE e.stream = p_stream AND e.sequence > p_after ORDER BY e.sequence LIMIT least(greatest(p_limit, 1), 1000);
$$;
CREATE FUNCTION emr_access.entry_for_event(p_stream text, p_event_id text)
  RETURNS TABLE (sequence bigint, previous_hash text, hash text, kind text, statutory_act text, event_id text, payload text, content_sha256 text, stored_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.sequence, e.previous_hash, e.hash, e.kind, e.statutory_act, e.event_id, e.payload, e.content_sha256, e.stored_at
  FROM emr_access.access_entry e WHERE e.stream = p_stream AND e.event_id = p_event_id;
$$;

-- What the retention job may know of the viewing stream: positions, each entry's own time and whether an unreleased hold
-- exists - no payload. The job computes each end with the one retention rule.
CREATE FUNCTION emr_access.retention_view(p_after bigint, p_limit integer)
  RETURNS TABLE (sequence bigint, hash text, kind text, occurred_at timestamptz, held boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.sequence, e.hash, e.kind, e.occurred_at, EXISTS (
    SELECT 1 FROM emr_access.legal_hold_event placed WHERE placed.record_id = e.event_id AND placed.phase = 'placed'
      AND NOT EXISTS (SELECT 1 FROM emr_access.legal_hold_event released WHERE released.hold_id = placed.hold_id AND released.phase = 'released'))
  FROM emr_access.access_entry e WHERE e.stream = 'viewing' AND e.sequence > p_after ORDER BY e.sequence LIMIT least(greatest(p_limit, 1), 1000);
$$;

-- Retention role only; the viewing stream only. The prefix up to p_through must be past every entry's floor and free of any
-- unreleased hold; it, its targets and projections are deleted and the checkpoint appended in this one transaction, or
-- nothing happens. The history stream is never touched here.
CREATE FUNCTION emr_access.expire_prefix(p_through bigint)
  RETURNS TABLE (deleted_count bigint, checkpoint_sequence bigint, checkpoint_hash text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  head emr_access.chain_head%ROWTYPE;
  anchor emr_access.access_entry%ROWTYPE;
  removed bigint;
  now_at timestamptz := date_trunc('milliseconds', clock_timestamp());
  at_text text;
  checkpoint text;
  next_sequence bigint;
  next_hash text;
BEGIN
  PERFORM emr_access.require_placement();
  SELECT * INTO head FROM emr_access.chain_head h WHERE h.stream = 'viewing' FOR UPDATE;
  SELECT * INTO anchor FROM emr_access.access_entry e WHERE e.stream = 'viewing' AND e.sequence = p_through;
  IF NOT FOUND THEN RAISE EXCEPTION 'ExpiryPrefixInvalid' USING ERRCODE = 'EB006'; END IF;
  IF EXISTS (SELECT 1 FROM emr_access.access_entry e WHERE e.stream = 'viewing' AND e.sequence <= p_through
             AND emr_access.access_retention_floor(e.occurred_at) > now_at) THEN
    RAISE EXCEPTION 'RetentionNotElapsed' USING ERRCODE = 'EB004';
  END IF;
  IF EXISTS (SELECT 1 FROM emr_access.access_entry e JOIN emr_access.legal_hold_event placed
               ON placed.record_id = e.event_id AND placed.phase = 'placed'
             WHERE e.stream = 'viewing' AND e.sequence <= p_through AND NOT EXISTS (
               SELECT 1 FROM emr_access.legal_hold_event released WHERE released.hold_id = placed.hold_id AND released.phase = 'released')) THEN
    RAISE EXCEPTION 'LegalHoldActive' USING ERRCODE = 'EB005';
  END IF;
  SELECT count(*) INTO removed FROM emr_access.access_entry e WHERE e.stream = 'viewing' AND e.sequence <= p_through;
  PERFORM set_config('kin.emr_expiry', 'prefix', true);
  -- A projection belongs to the event's viewing entry; an event still in the history stream keeps no projection.
  DELETE FROM emr_access.audit_projection p USING emr_access.access_entry e
    WHERE e.stream = 'viewing' AND e.sequence <= p_through AND p.event_id = e.event_id;
  DELETE FROM emr_access.access_target t WHERE t.stream = 'viewing' AND t.sequence <= p_through;
  DELETE FROM emr_access.access_entry e WHERE e.stream = 'viewing' AND e.sequence <= p_through;
  PERFORM set_config('kin.emr_expiry', '', true);
  at_text := to_char(now_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  checkpoint := '{"kind":"expiry","at":"' || at_text || '","deletedThrough":' || p_through::text || ',"deletedCount":' || removed::text ||
                ',"anchorHash":"' || anchor.hash || '"}';
  next_sequence := head.sequence + 1;
  next_hash := emr_access.chain_hash(next_sequence, head.hash, checkpoint);
  INSERT INTO emr_access.access_entry (stream, sequence, previous_hash, hash, kind, statutory_act, event_id, payload, content_sha256, occurred_at, stored_at)
    VALUES ('viewing', next_sequence, head.hash, next_hash, 'expiry', NULL, NULL, checkpoint, encode(sha256(convert_to(checkpoint, 'UTF8')), 'hex'),
            now_at, clock_timestamp());
  PERFORM set_config('kin.emr_append', 'head', true);
  UPDATE emr_access.chain_head h SET sequence = next_sequence, hash = next_hash WHERE h.stream = 'viewing';
  PERFORM set_config('kin.emr_append', '', true);
  RETURN QUERY SELECT removed, next_sequence, next_hash;
END
$$;

CREATE FUNCTION emr_access.resolve_member_identity(p_issuer text, p_subject text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE found_id uuid;
BEGIN
  PERFORM emr_access.require_placement();
  INSERT INTO emr_access.member_identity (id, issuer, subject, created_at)
    VALUES (gen_random_uuid(), p_issuer, p_subject, clock_timestamp()) ON CONFLICT (issuer, subject) DO NOTHING;
  SELECT i.id INTO found_id FROM emr_access.member_identity i WHERE i.issuer = p_issuer AND i.subject = p_subject;
  RETURN found_id;
END
$$;

CREATE FUNCTION emr_access.record_projection(p_event_id text, p_audit_log_id integer) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE existing integer;
BEGIN
  PERFORM emr_access.require_placement();
  IF NOT EXISTS (SELECT 1 FROM emr_access.access_entry e WHERE e.stream = 'viewing' AND e.event_id = p_event_id) THEN
    RAISE EXCEPTION 'ProjectionWithoutEvent' USING ERRCODE = 'EB007';
  END IF;
  SELECT p.audit_log_id INTO existing FROM emr_access.audit_projection p WHERE p.event_id = p_event_id;
  IF FOUND THEN
    IF existing = p_audit_log_id THEN RETURN; END IF;
    RAISE EXCEPTION 'ProjectionConflict' USING ERRCODE = 'EB002';
  END IF;
  INSERT INTO emr_access.audit_projection (event_id, audit_log_id, recorded_at) VALUES (p_event_id, p_audit_log_id, clock_timestamp());
END
$$;

CREATE FUNCTION emr_access.append_fact_checked(p_body text, p_keys text[]) RETURNS json
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE doc json; key text;
BEGIN
  BEGIN doc := p_body::json; EXCEPTION WHEN others THEN RAISE EXCEPTION 'DutyFactInvalid' USING ERRCODE = 'EB003'; END;
  IF json_typeof(doc) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'DutyFactInvalid' USING ERRCODE = 'EB003'; END IF;
  FOREACH key IN ARRAY p_keys LOOP
    IF doc -> key IS NULL THEN RAISE EXCEPTION 'DutyFactInvalid' USING ERRCODE = 'EB003'; END IF;
  END LOOP;
  RETURN doc;
END
$$;
CREATE FUNCTION emr_access.place_hold(p_hold_id text, p_record_id text, p_body text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE doc json := emr_access.append_fact_checked(p_body, ARRAY['holdId', 'recordId', 'basis', 'actorId', 'at', 'release']); existing text;
BEGIN
  PERFORM emr_access.require_placement();
  IF doc ->> 'holdId' IS DISTINCT FROM p_hold_id OR doc ->> 'recordId' IS DISTINCT FROM p_record_id OR json_typeof(doc -> 'release') <> 'null' THEN
    RAISE EXCEPTION 'DutyFactInvalid' USING ERRCODE = 'EB003';
  END IF;
  SELECT body INTO existing FROM emr_access.legal_hold_event WHERE hold_id = p_hold_id AND phase = 'placed';
  IF FOUND THEN
    IF existing = p_body THEN RETURN; END IF;
    RAISE EXCEPTION 'HoldConflict' USING ERRCODE = 'EB002';
  END IF;
  INSERT INTO emr_access.legal_hold_event (hold_id, phase, record_id, body, recorded_at) VALUES (p_hold_id, 'placed', p_record_id, p_body, clock_timestamp());
END
$$;
CREATE FUNCTION emr_access.release_hold(p_hold_id text, p_body text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE doc json := emr_access.append_fact_checked(p_body, ARRAY['holdId', 'recordId', 'basis', 'actorId', 'at', 'release']);
  placed emr_access.legal_hold_event%ROWTYPE; existing text;
BEGIN
  PERFORM emr_access.require_placement();
  SELECT * INTO placed FROM emr_access.legal_hold_event WHERE hold_id = p_hold_id AND phase = 'placed';
  IF NOT FOUND OR doc ->> 'holdId' IS DISTINCT FROM p_hold_id OR doc ->> 'recordId' IS DISTINCT FROM placed.record_id
     OR json_typeof(doc -> 'release') <> 'object' THEN
    RAISE EXCEPTION 'DutyFactInvalid' USING ERRCODE = 'EB003';
  END IF;
  SELECT body INTO existing FROM emr_access.legal_hold_event WHERE hold_id = p_hold_id AND phase = 'released';
  IF FOUND THEN
    IF existing = p_body THEN RETURN; END IF;
    RAISE EXCEPTION 'HoldConflict' USING ERRCODE = 'EB002';
  END IF;
  INSERT INTO emr_access.legal_hold_event (hold_id, phase, record_id, body, recorded_at) VALUES (p_hold_id, 'released', placed.record_id, p_body, clock_timestamp());
END
$$;
CREATE FUNCTION emr_access.holds_for(p_record_id text) RETURNS TABLE (hold_id text, phase text, body text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT h.hold_id, h.phase, h.body FROM emr_access.legal_hold_event h WHERE h.record_id = p_record_id ORDER BY h.hold_id, h.phase DESC;
$$;
CREATE FUNCTION emr_access.record_duty_request(p_kind text, p_request_id text, p_phase text, p_body text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE doc json := emr_access.append_fact_checked(p_body, ARRAY['requestId', 'recordIds', 'receivedAt', 'responseDueAt', 'resolution']); existing text;
BEGIN
  PERFORM emr_access.require_placement();
  IF doc ->> 'requestId' IS DISTINCT FROM p_request_id OR (p_phase = 'received') <> (json_typeof(doc -> 'resolution') = 'null')
     OR (p_phase = 'resolved' AND NOT EXISTS (SELECT 1 FROM emr_access.duty_request_event r WHERE r.kind = p_kind AND r.request_id = p_request_id AND r.phase = 'received')) THEN
    RAISE EXCEPTION 'DutyFactInvalid' USING ERRCODE = 'EB003';
  END IF;
  SELECT body INTO existing FROM emr_access.duty_request_event r WHERE r.kind = p_kind AND r.request_id = p_request_id AND r.phase = p_phase;
  IF FOUND THEN
    IF existing = p_body THEN RETURN; END IF;
    RAISE EXCEPTION 'DutyRequestConflict' USING ERRCODE = 'EB002';
  END IF;
  INSERT INTO emr_access.duty_request_event (kind, request_id, phase, body, recorded_at) VALUES (p_kind, p_request_id, p_phase, p_body, clock_timestamp());
END
$$;
CREATE FUNCTION emr_access.duty_requests(p_kind text, p_request_id text) RETURNS TABLE (phase text, body text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.phase, r.body FROM emr_access.duty_request_event r WHERE r.kind = p_kind AND r.request_id = p_request_id ORDER BY r.phase DESC;
$$;
-- The reviewed clause history (EMR-A L5-02): installed by the installer credential only, read by the runtime.
CREATE FUNCTION emr_access.record_clause_version(p_clause_id text, p_law text, p_article text, p_publication text, p_published_at date, p_effective_at date)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE existing emr_access.clause_version%ROWTYPE;
BEGIN
  PERFORM emr_access.require_placement();
  SELECT * INTO existing FROM emr_access.clause_version c WHERE c.clause_id = p_clause_id AND c.publication = p_publication;
  IF FOUND THEN
    IF existing.law = p_law AND existing.article = p_article AND existing.published_at = p_published_at AND existing.effective_at = p_effective_at THEN RETURN; END IF;
    RAISE EXCEPTION 'ClauseVersionConflict' USING ERRCODE = 'EB002';
  END IF;
  INSERT INTO emr_access.clause_version (clause_id, publication, law, article, published_at, effective_at, recorded_at)
    VALUES (p_clause_id, p_publication, p_law, p_article, p_published_at, p_effective_at, clock_timestamp());
END
$$;
CREATE FUNCTION emr_access.clause_versions(p_clause_id text)
  RETURNS TABLE (law text, article text, publication text, published_at date, effective_at date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.law, c.article, c.publication, c.published_at, c.effective_at FROM emr_access.clause_version c
  WHERE c.clause_id = p_clause_id ORDER BY c.effective_at;
$$;

CREATE FUNCTION emr_access.order_facts_for(p_record_id text) RETURNS TABLE (body text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('emr-order:' || p_record_id, 0));
  RETURN QUERY SELECT f.body FROM emr_access.order_fact f WHERE f.record_id = p_record_id ORDER BY f.sequence;
END
$$;
CREATE FUNCTION emr_access.record_order_fact(p_record_id text, p_event_id text, p_previous text, p_body text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE doc json := emr_access.append_fact_checked(p_body, ARRAY['recordId', 'eventId', 'previousEventId', 'facts', 'event']);
  previous emr_access.order_fact%ROWTYPE; existing text;
BEGIN
  PERFORM emr_access.require_placement();
  PERFORM pg_advisory_xact_lock(hashtextextended('emr-order:' || p_record_id, 0));
  IF doc ->> 'recordId' IS DISTINCT FROM p_record_id OR doc ->> 'eventId' IS DISTINCT FROM p_event_id
     OR doc ->> 'previousEventId' IS DISTINCT FROM p_previous OR json_typeof(doc -> 'facts') <> 'object'
     OR doc #>> '{facts,statusEvent,eventId}' IS DISTINCT FROM p_event_id OR doc #>> '{event,recordId}' IS DISTINCT FROM p_record_id THEN
    RAISE EXCEPTION 'OrderFactInvalid' USING ERRCODE = 'EB003';
  END IF;
  SELECT f.body INTO existing FROM emr_access.order_fact f WHERE f.record_id = p_record_id AND f.event_id = p_event_id;
  IF FOUND THEN
    IF existing = p_body THEN RETURN; END IF;
    RAISE EXCEPTION 'OrderEventIdConflict' USING ERRCODE = 'EB002';
  END IF;
  SELECT * INTO previous FROM emr_access.order_fact f WHERE f.record_id = p_record_id ORDER BY f.sequence DESC LIMIT 1;
  IF previous.event_id IS DISTINCT FROM p_previous THEN RAISE EXCEPTION 'OrderHistoryIncomplete' USING ERRCODE = 'EB003'; END IF;
  INSERT INTO emr_access.order_fact VALUES (p_record_id, p_event_id, coalesce(previous.sequence, 0) + 1, p_previous, p_body, clock_timestamp());
END
$$;

RESET ROLE;
SET LOCAL default_tablespace = '';

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA emr_access FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA emr_access FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  emr_access.append_access(text, text, text, text), emr_access.chain_tail(text), emr_access.entries_after(text, bigint, integer),
  emr_access.entry_for_event(text, text), emr_access.storage_placement(), emr_access.civil_period_end(timestamptz, integer),
  emr_access.resolve_member_identity(text, text), emr_access.record_projection(text, integer),
  emr_access.place_hold(text, text, text), emr_access.release_hold(text, text), emr_access.holds_for(text),
  emr_access.record_duty_request(text, text, text, text), emr_access.duty_requests(text, text), emr_access.clause_versions(text)
  , emr_access.order_facts_for(text), emr_access.record_order_fact(text,text,text,text) TO kin_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA emr_access TO kin_emr_reader;
GRANT EXECUTE ON FUNCTION
  emr_access.chain_tail(text), emr_access.entries_after(text, bigint, integer), emr_access.entry_for_event(text, text), emr_access.storage_placement(),
  emr_access.civil_period_end(timestamptz, integer), emr_access.holds_for(text), emr_access.duty_requests(text, text),
  emr_access.clause_versions(text)
  , emr_access.order_facts_for(text) TO kin_emr_reader;
GRANT EXECUTE ON FUNCTION emr_access.expire_prefix(bigint), emr_access.retention_view(bigint, integer), emr_access.chain_tail(text),
  emr_access.storage_placement() TO kin_emr_retention;
COMMIT;
