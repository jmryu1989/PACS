-- CD-09a: H's destruction journal, its durable execution fence ("deleting") and the closed PostgreSQL deletion step.
-- Format 2 (contract-amendment.md): completion is operational-store deletion; recovery-only backups are supervised by
-- the two supervision kinds, which slice c writes. A's graph, deadline and purpose judgement is not copied here: the
-- functions check only what PostgreSQL alone can check at the moment of deletion - the stored execution, its started
-- journal, current holds and duties, and exact primary keys from a closed table list owned by the execution's records.
BEGIN;
GRANT USAGE ON SCHEMA public, emr_signing TO kin_emr_owner, kin_emr_retention;
GRANT USAGE ON SCHEMA emr_clinical TO kin_emr_owner;
-- The owner's deletion step needs exactly these rows; no business-table DELETE is granted to the retention login.
GRANT SELECT, DELETE ON public."Report", public."ReportVersion", emr_signing.signed_version, emr_signing.operation TO kin_emr_owner;
-- Existence census of the stores no H adapter reads yet (retention_uncovered below).
GRANT SELECT ON emr_clinical.online_command, emr_clinical.online_version, emr_clinical.online_reference,
  public."StudyQuestion", public."StudyQuestionEntry", public."StudyConsultation", public."StudyImageRequest",
  public."StudyImageRequestReceipt", public."Finding", public."FindingRevision", public."TechNoteRevision", public."ReaderAssignment",
  public."CriticalResult", public."CriticalResultEvent", public."CriticalResultReceipt", public."ViewerItem", public."ViewerRevision",
  public."ManualSr", public."ViewerJob", public."ViewerJobRevision", public."ViewerRequest", public."ReadingTemplate",
  public."UserFilter", public."UserFilterCollection", public."SharedFilterLibrary", public."WorklistColumns",
  public."ReadingPreferences", public."ReadingAppearance", public."WorkspaceLayout", public."WorkspaceShortcuts",
  public."HangingProtocolPreference", public."StudyTagCatalog", public."FavoriteWorkspace", emr_audit.fixed_copy TO kin_emr_owner;
-- The reverse references and the report projection retention_report_retainers reads for the owner.
GRANT SELECT ON public."StudyState", public."ReportDraftInsertReceipt", emr_access.order_fact, emr_audit.issuance_event TO kin_emr_owner;
-- H's inventory reads. Private keys, wrapped secrets and session credentials are not readable.
GRANT SELECT ON public."Report", public."ReportVersion", public."ReportDraft", public."ReportDraftInsertReceipt",
  public."CriticalResult", emr_signing.signed_version, emr_signing.operation, emr_signing.doctor_key TO kin_emr_retention;

SET LOCAL ROLE kin_emr_owner;
SET LOCAL default_tablespace = 'kin_emr_access';

-- The only H destruction/supervision ledger. No patient, study, record or version ID, text or content hash: units are
-- the opaque disposal IDs and operations the random execution IDs.
CREATE TABLE emr_access.retention_journal (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('operational-deletion', 'backup-generation-expired', 'restore-reapplied')),
  phase text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  disposal_unit_id text,
  occurred_at timestamptz NOT NULL,
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object' AND pg_catalog.octet_length(body::text) <= 65536),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'operational-deletion' AND phase IN ('started', 'failed', 'completed') AND disposal_unit_id IS NOT NULL)
      OR (kind = 'backup-generation-expired' AND phase IS NULL AND disposal_unit_id IS NOT NULL)
      OR (kind = 'restore-reapplied' AND phase IS NULL AND disposal_unit_id IS NULL)),
  CHECK (disposal_unit_id IS NULL OR disposal_unit_id ~ '^disposal:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
CREATE UNIQUE INDEX retention_started_once ON emr_access.retention_journal (operation_id, disposal_unit_id)
  WHERE kind = 'operational-deletion' AND phase = 'started';
CREATE UNIQUE INDEX retention_completed_once ON emr_access.retention_journal (operation_id, disposal_unit_id, revision)
  WHERE kind = 'operational-deletion' AND phase = 'completed';
CREATE UNIQUE INDEX retention_backup_expired_once ON emr_access.retention_journal (operation_id, disposal_unit_id)
  WHERE kind = 'backup-generation-expired';
CREATE UNIQUE INDEX retention_restore_once ON emr_access.retention_journal (operation_id) WHERE kind = 'restore-reapplied';

-- The stable unit ID of one source record, registered once and reused by every later sweep (never a new ID per run).
-- It re-identifies the unit, so it is deleted with the unit's rows.
CREATE TABLE emr_access.retention_unit (
  disposal_unit_id text PRIMARY KEY
    CHECK (disposal_unit_id ~ '^disposal:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  source_kind text NOT NULL CHECK (pg_catalog.length(source_kind) BETWEEN 1 AND 40),
  record_id text NOT NULL CHECK (pg_catalog.length(record_id) BETWEEN 1 AND 200),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_kind, record_id)
);
-- A row here is the "deleting" state of its records. It is removed only by the committed deletion of the same rows.
CREATE TABLE emr_access.retention_execution (
  operation_id uuid PRIMARY KEY,
  disposal_unit_ids text[] NOT NULL CHECK (cardinality(disposal_unit_ids) > 0),
  record_ids text[] NOT NULL CHECK (cardinality(record_ids) > 0),
  eligible_at timestamptz NOT NULL,
  snapshot_revision text NOT NULL CHECK (pg_catalog.length(snapshot_revision) BETWEEN 1 AND 200),
  targets jsonb NOT NULL CHECK (jsonb_typeof(targets) = 'array' AND jsonb_array_length(targets) > 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- The PostgreSQL commit marker of one execution, without source IDs: the reconciliation input after a lost response.
CREATE TABLE emr_access.retention_commit (
  operation_id uuid PRIMARY KEY,
  disposal_unit_ids text[] NOT NULL CHECK (cardinality(disposal_unit_ids) > 0),
  deleted_at timestamptz NOT NULL,
  confirmed_at timestamptz CHECK (confirmed_at IS NULL OR confirmed_at >= deleted_at)
);

-- Lock order of every party that writes, holds or deletes a fixed record (writers, hold/duty, H, reconciliation):
--   app row locks of StudyState  ->  fixed-record locks, ascending  ->  legal-fact lock (77104,2)  ->  rows of Report,
--   ReportVersion and the signing tables.
-- H holds its fixed-record locks as session locks across its separately committed steps, so no one may take a Report or
-- signing row lock before the record lock (commitReport takes lockFixedRecord before `Report FOR UPDATE`). The
-- execution-owner lock (`["emr-retention-execution",op]`) is taken before any record lock by a reconciler; the owner
-- mints it, unseen by anyone else, while it already holds the records.
CREATE FUNCTION emr_access.fixed_record_lock(p_record text) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$
  -- The same key bytes as lockFixedRecord (JSON.stringify(['emr-fixed-record', recordId])).
  SELECT pg_advisory_xact_lock(hashtextextended('["emr-fixed-record",' || to_json(p_record)::text || ']', 0));
$$;
-- True when no other session holds the execution's owner lock (its owner is gone, or this session is the owner or the
-- reconciler that took it). The key bytes are JSON.stringify(['emr-retention-execution', operationId]).
CREATE FUNCTION emr_access.retention_owner_free(p_operation uuid) RETURNS boolean
LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_try_advisory_xact_lock(hashtextextended('["emr-retention-execution",' || to_json(p_operation::text)::text || ']', 0));
$$;
-- The signed payload of a stored approval (flattened JWS, base64url). An outcome without one is an error, never "none".
CREATE FUNCTION emr_access.signed_payload(p_outcome jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE p text := p_outcome -> 'envelope' ->> 'payload';
BEGIN
  IF p IS NULL THEN RAISE EXCEPTION 'SignedPayloadUnreadable'; END IF;
  RETURN convert_from(decode(translate(p, '-_', '+/') || repeat('=', (4 - pg_catalog.length(p) % 4) % 4), 'base64'), 'UTF8')::jsonb;
END $$;

-- Registration is idempotent: the first sweep that sees a record mints its opaque ID; later sweeps receive the same one.
CREATE FUNCTION emr_access.register_retention_units(p_kind text, p_records text[])
RETURNS TABLE (record_id text, disposal_unit_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  INSERT INTO emr_access.retention_unit AS m (disposal_unit_id, source_kind, record_id)
    SELECT 'disposal:' || gen_random_uuid()::text, p_kind, r FROM (SELECT DISTINCT unnest(p_records) AS r) x
    ON CONFLICT (source_kind, record_id) DO NOTHING;
  RETURN QUERY SELECT m.record_id, m.disposal_unit_id FROM emr_access.retention_unit m
    WHERE m.source_kind = p_kind AND m.record_id = ANY(p_records) ORDER BY m.record_id;
END $$;

-- Existence only, by table name: what holds clinical or purpose payload that no H source adapter reads yet. The retention
-- login learns that a table is not empty, never its rows. A non-empty table keeps the run incomplete.
CREATE FUNCTION emr_access.retention_uncovered() RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t text; present boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_clinical.online_command', 'emr_clinical.online_version', 'emr_clinical.online_reference',
    'public."StudyQuestion"', 'public."StudyQuestionEntry"', 'public."StudyConsultation"', 'public."StudyImageRequest"',
    'public."StudyImageRequestReceipt"', 'public."Finding"', 'public."FindingRevision"', 'public."TechNoteRevision"',
    'public."ReaderAssignment"', 'public."CriticalResult"', 'public."CriticalResultEvent"', 'public."CriticalResultReceipt"',
    'public."ViewerItem"', 'public."ViewerRevision"', 'public."ManualSr"', 'public."ViewerJob"', 'public."ViewerJobRevision"',
    'public."ViewerRequest"', 'public."ReadingTemplate"', 'public."UserFilter"', 'public."UserFilterCollection"',
    'public."SharedFilterLibrary"', 'public."WorklistColumns"', 'public."ReadingPreferences"', 'public."ReadingAppearance"',
    'public."WorkspaceLayout"', 'public."WorkspaceShortcuts"', 'public."HangingProtocolPreference"', 'public."StudyTagCatalog"',
    'public."FavoriteWorkspace"', 'emr_audit.fixed_copy'] LOOP
    EXECUTE 'SELECT EXISTS (SELECT FROM ' || t || ')' INTO present;
    IF present THEN RETURN NEXT t; END IF;
  END LOOP;
  -- Signatures or report heads that belong to no stored report version are not a report unit H can judge.
  IF EXISTS (SELECT FROM emr_signing.signed_version s WHERE NOT EXISTS (SELECT FROM public."ReportVersion" v WHERE v.uid = s.record_id)) THEN
    RETURN NEXT 'emr_signing.signed_version';
  END IF;
  IF EXISTS (SELECT FROM public."Report" r WHERE (r.findings <> '' OR r.conclusion <> '' OR r.recommendation <> '')
      AND NOT EXISTS (SELECT FROM public."ReportVersion" v WHERE v.uid = r.uid)) THEN
    RETURN NEXT 'public."Report"';
  END IF;
END $$;

-- Every stored fact outside a report unit that names it, and the study's report projection, for these Study UIDs.
-- A unit with any row is not judged by H in this slice: the referrer is no A record H can build, so dropping the row
-- would ignore its retention duty (a 2019 chart incorporation of a 2015 report keeps the report). The JSON documents
-- whose shape H does not own (order facts, F issuances) count any string equal to the UID. Read under H's record locks;
-- every writer below except order facts takes the same lock first (fence triggers), and an unreadable row is an error.
CREATE FUNCTION emr_access.retention_report_retainers(p_records text[])
RETURNS TABLE (record_id text, source text, from_record text, from_part text, to_part text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH t AS (SELECT DISTINCT r FROM unnest(p_records) AS r)
  -- A CVR pins its report version (FK Restrict).
  SELECT c."studyUid", 'critical-result', c.id::text, c.revision::text, c."sourceVersion"::text
    FROM public."CriticalResult" c JOIN t ON t.r = c."studyUid"
  UNION ALL
  -- A clinician question entry records the report version it was asked against.
  SELECT q."studyUid", 'clinical-question-entry', q.id::text, e.seq::text, e."reportVersion"::text
    FROM public."StudyQuestionEntry" e JOIN public."StudyQuestion" q ON q.id = e."questionId" JOIN t ON t.r = q."studyUid"
    WHERE e."reportVersion" IS NOT NULL
  UNION ALL
  -- A Related Report insertion copied this report's approved text into another study's draft.
  SELECT i."sourceUid", 'related-report-insert', i."targetUid", i."insertRequestId"::text, i."sourceVersion"::text
    FROM public."ReportDraftInsertReceipt" i JOIN t ON t.r = i."sourceUid"
  UNION ALL
  -- A D version incorporating it (D attachment kinds exclude reports today; read, not assumed).
  SELECT o.source_record_id, 'clinical-attachment', v.record_id, o.version_id, o.source_version_id
    FROM emr_clinical.online_reference o JOIN emr_clinical.online_version v ON v.version_id = o.version_id
    JOIN t ON t.r = o.source_record_id
  UNION ALL
  -- Order facts: chart incorporation, components, inherited duties, source and fulfilment links.
  SELECT DISTINCT t.r, 'order-fact', f.record_id, f.event_id, NULL::text
    FROM emr_access.order_fact f, jsonb_path_query(f.body::jsonb, 'strict $.**') AS s(v), t
    WHERE jsonb_typeof(s.v) = 'string' AND s.v #>> '{}' = t.r AND f.record_id <> t.r
  UNION ALL
  -- Another record's signed attachments (native report signatures carry none; read, not assumed).
  SELECT a ->> 'recordId', 'signed-attachment', s.record_id, s.version_id, a ->> 'versionId'
    FROM emr_signing.signed_version s, jsonb_array_elements(emr_access.signed_payload(s.outcome) -> 'attachments') AS a, t
    WHERE a ->> 'recordId' = t.r AND s.record_id <> t.r
  UNION ALL
  -- An F issuance whose fixed copy holds it.
  SELECT DISTINCT t.r, 'issued-copy', i.issuance_id, i.sequence::text, NULL::text
    FROM emr_audit.issuance_event i, jsonb_path_query(i.body::jsonb, 'strict $.**') AS s(v), t
    WHERE jsonb_typeof(s.v) = 'string' AND s.v #>> '{}' = t.r
  UNION ALL
  -- rs/repDoc/confirm change only through commitReport (AGENTS §1-6); a deleted report under an approved or
  -- preliminary state would read as an empty approved report. The state after destruction is not designed yet.
  SELECT s.uid, 'report-projection', s.uid, s.rs, NULL::text
    FROM public."StudyState" s JOIN t ON t.r = s.uid
    WHERE s.rs <> 'W' OR s."repDoc" IS NOT NULL OR s.confirm IS NOT NULL
$$;

-- An execution whose started journal is not durable for every unit deleted nothing (deletion requires all of them), so
-- it is released for a fresh judgement. One with a complete started journal is resumed, never released. An execution
-- whose owner still holds its owner lock is live (its started records may be on their way) and is never released;
-- the caller re-reads it after taking that lock itself. Locks: records, then the legal-fact lock (order above).
CREATE FUNCTION emr_access.abandon_retention_execution(p_operation uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e emr_access.retention_execution%ROWTYPE; r text;
BEGIN
  IF NOT emr_access.retention_owner_free(p_operation) THEN RAISE EXCEPTION 'RetentionExecutionBusy'; END IF;
  SELECT * INTO e FROM emr_access.retention_execution WHERE operation_id = p_operation;
  IF NOT FOUND THEN RETURN 'absent'; END IF;
  FOR r IN SELECT DISTINCT unnest(e.record_ids) ORDER BY 1 LOOP PERFORM emr_access.fixed_record_lock(r); END LOOP;
  PERFORM pg_advisory_xact_lock(77104, 2);
  SELECT * INTO e FROM emr_access.retention_execution WHERE operation_id = p_operation FOR UPDATE;
  IF NOT FOUND THEN RETURN 'absent'; END IF;
  IF NOT EXISTS (SELECT FROM unnest(e.disposal_unit_ids) u WHERE NOT EXISTS (SELECT FROM emr_access.retention_journal j
      WHERE j.operation_id = p_operation AND j.disposal_unit_id = u AND j.kind = 'operational-deletion' AND j.phase = 'started')) THEN
    RETURN 'started';
  END IF;
  DELETE FROM emr_access.retention_execution WHERE operation_id = p_operation;
  RETURN 'released';
END $$;

-- Closed list: table -> the column naming the record the row belongs to. A target outside it, or a row of another record,
-- is refused; nothing here takes a table name, WHERE clause or row predicate from the caller.
CREATE FUNCTION emr_access.retention_target_owner(p_schema text, p_table text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE p_schema || '.' || p_table
    WHEN 'emr_signing.signed_version' THEN 'record_id'
    WHEN 'emr_signing.operation' THEN 'outcome.recordId'
    WHEN 'public.ReportVersion' THEN 'uid'
    WHEN 'public.Report' THEN 'uid'
  END;
$$;

-- Fixes the execution set under the legal-fact and record locks: every unit is registered for its record, no other
-- live execution holds a record, no active hold or open duty names one, and every target is a complete primary key of
-- a closed-list row owned by one of the records. The caller has already re-read and judged the snapshot it names.
CREATE FUNCTION emr_access.begin_retention_execution(p_operation uuid, p_units text[], p_records text[],
  p_eligible timestamptz, p_revision text, p_targets jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r text; t jsonb; owner_column text; keys text[]; supplied text[]; rel regclass; owner_value text;
BEGIN
  -- The caller (H) already holds the records as session locks and the new execution's owner lock.
  FOR r IN SELECT DISTINCT unnest(p_records) ORDER BY 1 LOOP PERFORM emr_access.fixed_record_lock(r); END LOOP;
  PERFORM pg_advisory_xact_lock(77104, 2);
  IF p_eligible > clock_timestamp() THEN RAISE EXCEPTION 'RetentionNotElapsed'; END IF;
  IF cardinality(p_units) <> cardinality(p_records) OR (SELECT count(DISTINCT u) FROM unnest(p_units) u) <> cardinality(p_units)
     OR EXISTS (SELECT FROM unnest(p_units, p_records) AS x(u, rec) WHERE NOT EXISTS
       (SELECT FROM emr_access.retention_unit m WHERE m.disposal_unit_id = x.u AND m.record_id = x.rec)) THEN
    RAISE EXCEPTION 'RetentionUnitMappingRequired';
  END IF;
  IF EXISTS (SELECT FROM emr_access.retention_execution e WHERE e.record_ids && p_records) THEN
    RAISE EXCEPTION 'RetentionExecutionActive';
  END IF;
  IF EXISTS (SELECT FROM emr_access.legal_hold_event h WHERE h.phase = 'placed' AND h.record_id = ANY(p_records)
       AND NOT EXISTS (SELECT FROM emr_access.legal_hold_event x WHERE x.hold_id = h.hold_id AND x.phase = 'released'))
     OR EXISTS (SELECT FROM emr_access.duty_request_event d WHERE d.phase = 'received'
       AND NOT EXISTS (SELECT FROM emr_access.duty_request_event x WHERE x.kind = d.kind AND x.request_id = d.request_id AND x.phase = 'resolved')
       AND EXISTS (SELECT FROM jsonb_array_elements_text(COALESCE(d.body::jsonb -> 'recordIds', '[]'::jsonb)) id WHERE id = ANY(p_records))) THEN
    RAISE EXCEPTION 'LegalDutyActive';
  END IF;
  IF jsonb_typeof(p_targets) <> 'array' OR jsonb_array_length(p_targets) = 0 THEN RAISE EXCEPTION 'RetentionTargetInvalid'; END IF;
  FOR t IN SELECT value FROM jsonb_array_elements(p_targets) LOOP
    IF jsonb_typeof(t) <> 'object' OR NOT (t ?& ARRAY['schema', 'table', 'key']) OR (SELECT count(*) FROM jsonb_object_keys(t)) <> 3
       OR jsonb_typeof(t -> 'key') <> 'object' THEN RAISE EXCEPTION 'RetentionTargetInvalid'; END IF;
    owner_column := emr_access.retention_target_owner(t ->> 'schema', t ->> 'table');
    IF owner_column IS NULL THEN RAISE EXCEPTION 'RetentionStoreUnsupported'; END IF;
    rel := format('%I.%I', t ->> 'schema', t ->> 'table')::regclass;
    SELECT array_agg(a.attname::text ORDER BY a.attname) INTO keys FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = rel AND i.indisprimary;
    SELECT array_agg(k ORDER BY k) INTO supplied FROM jsonb_object_keys(t -> 'key') k;
    IF keys IS NULL OR supplied IS DISTINCT FROM keys OR EXISTS (SELECT FROM jsonb_each(t -> 'key') kv WHERE kv.value = 'null'::jsonb) THEN
      RAISE EXCEPTION 'CompletePrimaryKeyRequired';
    END IF;
    EXECUTE format('SELECT %s FROM %s AS target WHERE %s',
      CASE WHEN owner_column = 'outcome.recordId' THEN 'target.outcome ->> ''recordId''' ELSE format('target.%I::text', owner_column) END,
      rel, (SELECT string_agg(format('target.%1$I = (jsonb_populate_record(NULL::%2$s, $1)).%1$I', k, rel), ' AND ') FROM unnest(keys) k))
      INTO owner_value USING t -> 'key';
    IF owner_value IS NULL OR NOT owner_value = ANY(p_records) THEN RAISE EXCEPTION 'RetentionTargetNotOwned'; END IF;
  END LOOP;
  INSERT INTO emr_access.retention_execution(operation_id, disposal_unit_ids, record_ids, eligible_at, snapshot_revision, targets)
    VALUES (p_operation, p_units, p_records, p_eligible, p_revision, p_targets);
END $$;

-- The last step of one execution, one transaction: rechecks the fence, its started journal and current holds/duties,
-- deletes the fixed rows child-first, proves no closed-list row of its records remains, writes the commit marker and
-- removes the unit mapping and the execution. Any error rolls the whole set back.
CREATE FUNCTION emr_access.delete_operational_rows(p_operation uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e emr_access.retention_execution%ROWTYPE; t jsonb; rel regclass; keys text[]; r text; done_at timestamptz; n bigint;
BEGIN
  -- Only the owner, or a reconciler holding the owner lock, deletes; records first, then the legal-fact lock.
  IF NOT emr_access.retention_owner_free(p_operation) THEN RAISE EXCEPTION 'RetentionExecutionBusy'; END IF;
  SELECT * INTO e FROM emr_access.retention_execution WHERE operation_id = p_operation;
  IF FOUND THEN
    FOR r IN SELECT DISTINCT unnest(e.record_ids) ORDER BY 1 LOOP PERFORM emr_access.fixed_record_lock(r); END LOOP;
  END IF;
  PERFORM pg_advisory_xact_lock(77104, 2);
  SELECT * INTO e FROM emr_access.retention_execution WHERE operation_id = p_operation FOR UPDATE;
  IF NOT FOUND THEN
    SELECT deleted_at INTO done_at FROM emr_access.retention_commit WHERE operation_id = p_operation;
    IF FOUND THEN RETURN done_at; END IF;
    RAISE EXCEPTION 'RetentionExecutionRequired';
  END IF;
  IF e.eligible_at > clock_timestamp() THEN RAISE EXCEPTION 'RetentionNotElapsed'; END IF;
  IF EXISTS (SELECT FROM unnest(e.disposal_unit_ids) u WHERE NOT EXISTS (SELECT FROM emr_access.retention_journal j
       WHERE j.operation_id = p_operation AND j.disposal_unit_id = u AND j.kind = 'operational-deletion' AND j.phase = 'started')) THEN
    RAISE EXCEPTION 'DestructionStartJournalRequired';
  END IF;
  IF EXISTS (SELECT FROM emr_access.legal_hold_event h WHERE h.phase = 'placed' AND h.record_id = ANY(e.record_ids)
       AND NOT EXISTS (SELECT FROM emr_access.legal_hold_event x WHERE x.hold_id = h.hold_id AND x.phase = 'released'))
     OR EXISTS (SELECT FROM emr_access.duty_request_event d WHERE d.phase = 'received'
       AND NOT EXISTS (SELECT FROM emr_access.duty_request_event x WHERE x.kind = d.kind AND x.request_id = d.request_id AND x.phase = 'resolved')
       AND EXISTS (SELECT FROM jsonb_array_elements_text(COALESCE(d.body::jsonb -> 'recordIds', '[]'::jsonb)) id WHERE id = ANY(e.record_ids))) THEN
    RAISE EXCEPTION 'LegalDutyActive';
  END IF;
  FOR t IN SELECT value FROM jsonb_array_elements(e.targets) LOOP
    IF emr_access.retention_target_owner(t ->> 'schema', t ->> 'table') IS NULL THEN RAISE EXCEPTION 'RetentionStoreUnsupported'; END IF;
    rel := format('%I.%I', t ->> 'schema', t ->> 'table')::regclass;
    SELECT array_agg(a.attname::text ORDER BY a.attname) INTO keys FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = rel AND i.indisprimary;
    EXECUTE format('DELETE FROM %s AS target WHERE %s', rel,
      (SELECT string_agg(format('target.%1$I = (jsonb_populate_record(NULL::%2$s, $1)).%1$I', k, rel), ' AND ') FROM unnest(keys) k)) USING t -> 'key';
    GET DIAGNOSTICS n = ROW_COUNT;
    -- The fence kept the set unchanged since it was fixed; a missing row means the inventory was not the stored state.
    IF n <> 1 THEN RAISE EXCEPTION 'RetentionTargetMissing'; END IF;
  END LOOP;
  -- Remainder proof over the whole closed list, not only the fixed targets.
  IF EXISTS (SELECT FROM emr_signing.signed_version WHERE record_id = ANY(e.record_ids))
     OR EXISTS (SELECT FROM emr_signing.operation WHERE outcome ->> 'recordId' = ANY(e.record_ids))
     OR EXISTS (SELECT FROM public."ReportVersion" WHERE uid = ANY(e.record_ids))
     OR EXISTS (SELECT FROM public."Report" WHERE uid = ANY(e.record_ids)) THEN
    RAISE EXCEPTION 'OperationalRowRemains';
  END IF;
  done_at := clock_timestamp();
  INSERT INTO emr_access.retention_commit(operation_id, disposal_unit_ids, deleted_at) VALUES (p_operation, e.disposal_unit_ids, done_at);
  DELETE FROM emr_access.retention_unit WHERE disposal_unit_id = ANY(e.disposal_unit_ids);
  DELETE FROM emr_access.retention_execution WHERE operation_id = p_operation;
  RETURN done_at;
END $$;

-- Called in a new transaction after the deletion committed: completion time is this durable confirmation, never the
-- time a statement ran inside a transaction that might not have committed. Repeated calls return the first confirmation.
CREATE FUNCTION emr_access.confirm_operational_commit(p_operation uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c emr_access.retention_commit%ROWTYPE;
BEGIN
  SELECT * INTO c FROM emr_access.retention_commit WHERE operation_id = p_operation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OperationalCommitRequired'; END IF;
  IF c.confirmed_at IS NULL THEN
    UPDATE emr_access.retention_commit SET confirmed_at = clock_timestamp() WHERE operation_id = p_operation RETURNING confirmed_at INTO c.confirmed_at;
  END IF;
  RETURN c.confirmed_at;
END $$;

-- The deleting fence of every writer that adds to a record: it waits for H's record lock, then refuses while the record
-- is in a live execution, so an interrupted deletion is never extended or revived by a new part, signature or version.
CREATE FUNCTION emr_access.refuse_while_deleting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r text := to_jsonb(NEW) ->> TG_ARGV[0];
BEGIN
  PERFORM emr_access.fixed_record_lock(r);
  IF EXISTS (SELECT FROM emr_access.retention_execution WHERE r = ANY(record_ids)) THEN
    RAISE EXCEPTION 'RetentionDeleting' USING ERRCODE = 'EB020';
  END IF;
  RETURN NEW;
END $$;

-- The fence of the writers that add a reference to a report from outside it: under the referenced record's lock they are
-- refused while it is being deleted, and a reference to a report version that no longer exists (destroyed while the
-- writer waited for that lock) is refused as the CVR foreign key refuses it. F issuances lock every manifest record.
CREATE FUNCTION emr_access.refuse_reference_while_deleting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE f jsonb := to_jsonb(NEW); ids text[]; r text; v integer;
BEGIN
  IF TG_TABLE_NAME = 'StudyQuestionEntry' THEN
    IF f ->> 'reportVersion' IS NULL THEN RETURN NEW; END IF;
    SELECT ARRAY[q."studyUid"] INTO ids FROM public."StudyQuestion" q WHERE q.id = (f ->> 'questionId')::uuid;
    v := (f ->> 'reportVersion')::integer;
  ELSIF TG_TABLE_NAME = 'ReportDraftInsertReceipt' THEN
    -- A refused receipt may name a version that never existed (the refusal is the record); only an applied one copied text.
    ids := ARRAY[f ->> 'sourceUid']; v := CASE WHEN f ->> 'state' = 'applied' THEN (f ->> 'sourceVersion')::integer END;
  ELSE
    SELECT array_agg(DISTINCT x #>> '{}') INTO ids FROM jsonb_path_query(f -> 'body', 'lax $.manifest.records[*].recordId') AS x;
  END IF;
  FOR r IN SELECT DISTINCT unnest(ids) ORDER BY 1 LOOP PERFORM emr_access.fixed_record_lock(r); END LOOP;
  IF EXISTS (SELECT FROM emr_access.retention_execution WHERE record_ids && ids) THEN
    RAISE EXCEPTION 'RetentionDeleting' USING ERRCODE = 'EB020';
  END IF;
  IF v IS NOT NULL AND NOT EXISTS (SELECT FROM public."ReportVersion" WHERE uid = ids[1] AND version = v) THEN
    RAISE EXCEPTION 'ReferencedReportVersionMissing' USING ERRCODE = 'EB021';
  END IF;
  RETURN NEW;
END $$;

-- The existing legal-fact lock now also refuses a new hold or duty on a record that is being deleted. It takes the named
-- records' locks before the legal-fact lock (the order above); writers that already hold them re-enter.
CREATE OR REPLACE FUNCTION emr_access.lock_retention_facts() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE f jsonb := to_jsonb(NEW); r text;
BEGIN
  FOR r IN SELECT DISTINCT x FROM (SELECT f ->> 'record_id' AS x WHERE TG_TABLE_NAME = 'legal_hold_event'
      UNION ALL SELECT jsonb_array_elements_text(COALESCE((f ->> 'body')::jsonb -> 'recordIds', '[]'::jsonb))
        WHERE TG_TABLE_NAME = 'duty_request_event') ids WHERE x IS NOT NULL ORDER BY 1 LOOP
    PERFORM emr_access.fixed_record_lock(r);
  END LOOP;
  PERFORM pg_advisory_xact_lock(77104,2);
  IF TG_TABLE_NAME = 'legal_hold_event' AND f ->> 'phase' = 'placed'
     AND EXISTS (SELECT FROM emr_access.retention_execution WHERE f ->> 'record_id' = ANY(record_ids)) THEN
    RAISE EXCEPTION 'RetentionDeleting' USING ERRCODE = 'EB020';
  END IF;
  IF TG_TABLE_NAME = 'duty_request_event' AND f ->> 'phase' = 'received'
     AND EXISTS (SELECT FROM emr_access.retention_execution e,
       jsonb_array_elements_text(COALESCE((f ->> 'body')::jsonb -> 'recordIds', '[]'::jsonb)) id WHERE id = ANY(e.record_ids)) THEN
    RAISE EXCEPTION 'RetentionDeleting' USING ERRCODE = 'EB020';
  END IF;
  RETURN NEW;
END $$;
RESET ROLE;

-- Trigger creation needs EXECUTE for the installer; firing runs as the definer.
GRANT EXECUTE ON FUNCTION emr_access.refuse_while_deleting() TO CURRENT_USER;
CREATE TRIGGER retention_fence BEFORE INSERT ON public."ReportVersion"
  FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_while_deleting('uid');
CREATE TRIGGER retention_fence BEFORE INSERT OR UPDATE ON public."Report"
  FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_while_deleting('uid');
CREATE TRIGGER retention_fence BEFORE INSERT ON emr_signing.signed_version
  FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_while_deleting('record_id');
CREATE TRIGGER retention_fence BEFORE INSERT ON emr_clinical.online_version
  FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_while_deleting('record_id');
-- A CVR creation or supersession pins a report version: it waits for H's record lock and is refused while deleting, so
-- a started execution is never blocked forever by a CVR made after H's re-read (the FK would refuse the deletion).
CREATE TRIGGER retention_fence BEFORE INSERT ON public."CriticalResult"
  FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_while_deleting('studyUid');
GRANT EXECUTE ON FUNCTION emr_access.refuse_reference_while_deleting() TO CURRENT_USER;
CREATE TRIGGER retention_fence BEFORE INSERT ON public."StudyQuestionEntry"
  FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_reference_while_deleting();
CREATE TRIGGER retention_fence BEFORE INSERT OR UPDATE ON public."ReportDraftInsertReceipt"
  FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_reference_while_deleting();
CREATE TRIGGER retention_fence BEFORE INSERT ON emr_audit.issuance_event
  FOR EACH ROW EXECUTE FUNCTION emr_access.refuse_reference_while_deleting();

REVOKE ALL ON emr_access.retention_journal, emr_access.retention_unit, emr_access.retention_execution, emr_access.retention_commit
  FROM PUBLIC, kin_runtime, kin_emr_reader, kin_emr_retention;
REVOKE ALL ON SEQUENCE emr_access.retention_journal_sequence_seq FROM PUBLIC, kin_runtime, kin_emr_reader, kin_emr_retention;
REVOKE EXECUTE ON FUNCTION emr_access.fixed_record_lock(text), emr_access.retention_owner_free(uuid), emr_access.signed_payload(jsonb),
  emr_access.register_retention_units(text,text[]), emr_access.retention_uncovered(), emr_access.retention_report_retainers(text[]),
  emr_access.abandon_retention_execution(uuid),
  emr_access.retention_target_owner(text,text), emr_access.begin_retention_execution(uuid,text[],text[],timestamptz,text,jsonb),
  emr_access.delete_operational_rows(uuid), emr_access.confirm_operational_commit(uuid), emr_access.refuse_while_deleting(),
  emr_access.refuse_reference_while_deleting()
  FROM PUBLIC;
GRANT SELECT, INSERT ON emr_access.retention_journal TO kin_emr_retention;
GRANT USAGE ON SEQUENCE emr_access.retention_journal_sequence_seq TO kin_emr_retention;
GRANT SELECT ON emr_access.retention_unit, emr_access.retention_execution, emr_access.retention_commit,
  emr_access.legal_hold_event, emr_access.duty_request_event TO kin_emr_retention;
GRANT EXECUTE ON FUNCTION emr_access.register_retention_units(text,text[]), emr_access.retention_uncovered(),
  emr_access.retention_report_retainers(text[]),
  emr_access.abandon_retention_execution(uuid), emr_access.begin_retention_execution(uuid,text[],text[],timestamptz,text,jsonb),
  emr_access.delete_operational_rows(uuid), emr_access.confirm_operational_commit(uuid) TO kin_emr_retention;
GRANT SELECT ON emr_access.retention_journal TO kin_emr_reader;
COMMIT;
