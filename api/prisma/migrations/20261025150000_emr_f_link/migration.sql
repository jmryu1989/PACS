-- JSON preserves the accepted F manifest byte ordering across reloads.
-- F's append-only administrative facts. Clinical originals and outcomes remain
-- in D/C2 and B1. These rows introduce no second commit authority.
BEGIN;
CREATE SCHEMA emr_audit;
CREATE TABLE emr_audit.grantor (
  institution_id text NOT NULL, subject_id text NOT NULL,
  capacity text NOT NULL CHECK (capacity IN ('privacy-officer','institution-representative')),
  basis_document_id text NOT NULL,
  PRIMARY KEY (institution_id,subject_id)
);
CREATE TABLE emr_audit.roster_event (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grant_id text NOT NULL, institution_id text NOT NULL, subject_id text NOT NULL, body json NOT NULL
);
CREATE INDEX roster_subject ON emr_audit.roster_event(subject_id,sequence);
CREATE TABLE emr_audit.issuance_event (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issuance_id text NOT NULL, institution_id text NOT NULL, body json NOT NULL
);
CREATE INDEX issuance_history ON emr_audit.issuance_event(issuance_id,sequence);
CREATE TABLE emr_audit.fixed_copy (
  issuance_id text PRIMARY KEY, body bytea NOT NULL, sha256 text NOT NULL
);
CREATE TABLE emr_audit.request_event (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id text NOT NULL, institution_id text NOT NULL, body json NOT NULL
);
CREATE INDEX request_history ON emr_audit.request_event(request_id,sequence);
GRANT USAGE ON SCHEMA emr_audit TO kin_runtime,kin_emr_owner;
GRANT SELECT ON emr_audit.grantor TO kin_runtime;
GRANT SELECT,INSERT ON emr_audit.roster_event,emr_audit.issuance_event,emr_audit.fixed_copy,emr_audit.request_event TO kin_runtime;
GRANT SELECT ON emr_audit.request_event TO kin_emr_owner;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA emr_audit TO kin_runtime;

SET LOCAL ROLE kin_emr_owner;
-- Parse once when deriving the institution, including large audit-export chunks.
CREATE FUNCTION emr_access.investigation_institution(p_payload text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
DECLARE event jsonb := p_payload::jsonb;
BEGIN
  RETURN CASE WHEN event #>> '{managingInstitution,status}'='known'
    THEN event #>> '{managingInstitution,value}' ELSE event #>> '{actingInstitution,value}' END;
END $$;
-- Build the same target conjunction for both counting and reading pages.
CREATE FUNCTION emr_access.investigation_match(p_filters jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE event_match jsonb := '{}'; target_match jsonb := '{}'; field text;
BEGIN
  IF p_filters->>'actorId' IS NOT NULL THEN
    event_match := event_match || jsonb_build_object('userId',jsonb_build_object('status','known','value',jsonb_build_object('id',p_filters->>'actorId')));
  END IF;
  IF p_filters->>'address' IS NOT NULL THEN
    event_match := event_match || jsonb_build_object('trustedProxyIp',jsonb_build_object('status','known','value',jsonb_build_object('address',p_filters->>'address')));
  END IF;
  IF p_filters->>'patient' IS NOT NULL THEN
    target_match := target_match || jsonb_build_object('patientLinkSnapshot',jsonb_build_object('status','known','value',p_filters->'patient'));
  END IF;
  FOREACH field IN ARRAY ARRAY['studyId','recordId','versionId','sourcePatientId'] LOOP
    IF p_filters->>field IS NOT NULL THEN
      target_match := target_match || jsonb_build_object(field,jsonb_build_object('status','known','value',p_filters->>field));
    END IF;
  END LOOP;
  IF target_match <> '{}'::jsonb THEN event_match := event_match || jsonb_build_object('targets',jsonb_build_array(target_match)); END IF;
  RETURN event_match;
END $$;
REVOKE ALL ON FUNCTION emr_access.investigation_institution(text),emr_access.investigation_match(jsonb) FROM PUBLIC;
CREATE INDEX access_entry_investigation ON emr_access.access_entry(stream,
  emr_access.investigation_institution(payload),sequence) TABLESPACE kin_emr_access;
-- F preserves the independent record-change and viewing streams. Only matching
-- candidates cross into the API; a small display limit does not shrink a scan.
CREATE FUNCTION emr_access.investigation_entries(p_stream text,p_institution text,p_from timestamptz,p_until timestamptz,
  p_top bigint,p_before bigint,p_limit integer,p_filters jsonb DEFAULT '{}')
RETURNS TABLE(sequence bigint,payload text,recorded_at timestamptz,snapshot_top bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET jit=off AS $$
DECLARE ceiling bigint := p_top; event_match jsonb := emr_access.investigation_match(p_filters);
BEGIN
  IF ceiling IS NULL THEN
    SELECT e.sequence INTO ceiling FROM emr_access.access_entry e
    WHERE e.stream=p_stream AND e.occurred_at>=p_from AND e.occurred_at<p_until
      AND emr_access.investigation_institution(e.payload)=p_institution
    ORDER BY e.sequence DESC LIMIT 1;
  END IF;
  RETURN QUERY SELECT e.sequence,e.payload,e.recorded_at,COALESCE(ceiling,0)
    FROM emr_access.access_entry e
    -- OFFSET prevents inlining so the text is parsed once, even with several filters.
    CROSS JOIN LATERAL (SELECT e.payload::jsonb AS event OFFSET 0) parsed
    WHERE e.stream=p_stream AND e.sequence<=COALESCE(ceiling,0)
      AND e.sequence<COALESCE(p_before,9223372036854775807)
      AND e.occurred_at>=p_from AND e.occurred_at<p_until
      AND emr_access.investigation_institution(e.payload)=p_institution
      AND parsed.event @> event_match
      AND (p_filters->>'actions' IS NULL OR p_filters->'actions' ? (parsed.event->>'action'))
      AND (p_filters->>'results' IS NULL OR p_filters->'results' ? (parsed.event->>'result'))
    ORDER BY e.sequence DESC LIMIT GREATEST(p_limit,0);
END $$;

CREATE FUNCTION emr_access.investigation_count(p_stream text,p_institution text,p_from timestamptz,p_until timestamptz,
  p_top bigint,p_filters jsonb) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET jit=off AS $$
DECLARE event_match jsonb := emr_access.investigation_match(p_filters); answer bigint;
BEGIN
  SELECT count(*) INTO answer FROM emr_access.access_entry e
  CROSS JOIN LATERAL (SELECT e.payload::jsonb AS event OFFSET 0) parsed
  WHERE e.stream=p_stream AND e.sequence<=p_top AND e.occurred_at>=p_from AND e.occurred_at<p_until
    AND emr_access.investigation_institution(e.payload)=p_institution
    AND parsed.event @> event_match
    AND (p_filters->>'actions' IS NULL OR p_filters->'actions' ? (parsed.event->>'action'))
    AND (p_filters->>'results' IS NULL OR p_filters->'results' ? (parsed.event->>'result'));
  RETURN answer;
END $$;

-- Designation selects a person who has already signed in; it never enrolls a typo.
CREATE FUNCTION emr_access.existing_member_identity(p_issuer text,p_subject text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET jit=off AS $$
  SELECT id FROM emr_access.member_identity WHERE issuer=p_issuer AND subject=p_subject
$$;

-- A/H keep reading their existing B1 ports. F's latest jointly committed
-- request/hold snapshot supplies the extended due; the original rows survive.
CREATE OR REPLACE FUNCTION emr_access.holds_for(p_record_id text) RETURNS TABLE(hold_id text,phase text,body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET jit=off AS $$
  WITH latest AS (SELECT DISTINCT ON(request_id) body FROM emr_audit.request_event ORDER BY request_id,sequence DESC),
  current_holds AS (SELECT h FROM latest l CROSS JOIN LATERAL jsonb_array_elements(l.body::jsonb->'holds') h
    WHERE h->>'recordId'=p_record_id)
  SELECT e.hold_id,e.phase,COALESCE((SELECT CASE WHEN e.phase='placed' THEN jsonb_set(h,'{release}','null'::jsonb)::text ELSE jsonb_set(h,'{release}',e.body::jsonb->'release')::text END FROM current_holds WHERE h->>'holdId'=e.hold_id),e.body)
  FROM emr_access.legal_hold_event e WHERE e.record_id=p_record_id ORDER BY e.hold_id,e.phase DESC
$$;
CREATE OR REPLACE FUNCTION emr_access.duty_requests(p_kind text,p_request_id text) RETURNS TABLE(phase text,body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET jit=off AS $$
  WITH latest AS (SELECT body::jsonb->'facts' AS f FROM emr_audit.request_event
    WHERE request_id=p_request_id AND body->>'kind'=p_kind ORDER BY sequence DESC LIMIT 1)
  SELECT r.phase,COALESCE((SELECT jsonb_build_object('requestId',f->'requestId','recordIds',f->'recordIds',
    'receivedAt',f->'receivedAt','responseDueAt',COALESCE(f->'extensions'->-1->'dueAt',f->'initialDueAt'),
    'resolution',CASE WHEN r.phase='resolved' THEN r.body::jsonb->'resolution' ELSE f->'resolution' END)::text FROM latest),r.body)
  FROM emr_access.duty_request_event r WHERE r.kind=p_kind AND r.request_id=p_request_id ORDER BY r.phase DESC
$$;
RESET ROLE;
REVOKE ALL ON FUNCTION emr_access.investigation_entries(text,text,timestamptz,timestamptz,bigint,bigint,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emr_access.investigation_entries(text,text,timestamptz,timestamptz,bigint,bigint,integer,jsonb) TO kin_runtime;
REVOKE ALL ON FUNCTION emr_access.investigation_count(text,text,timestamptz,timestamptz,bigint,jsonb),
  emr_access.existing_member_identity(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emr_access.investigation_count(text,text,timestamptz,timestamptz,bigint,jsonb),
  emr_access.existing_member_identity(text,text) TO kin_runtime;
COMMIT;
