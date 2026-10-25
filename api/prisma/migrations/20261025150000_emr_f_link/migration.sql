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
CREATE INDEX access_entry_investigation ON emr_access.access_entry(stream,
  (CASE WHEN payload::jsonb #>> '{managingInstitution,status}'='known'
    THEN payload::jsonb #>> '{managingInstitution,value}'
    ELSE payload::jsonb #>> '{actingInstitution,value}' END),sequence) TABLESPACE kin_emr_access;
-- F preserves the independent record-change and viewing streams.
CREATE FUNCTION emr_access.investigation_entries(p_stream text,p_institution text,p_from timestamptz,p_until timestamptz,
  p_top bigint,p_before bigint,p_limit integer)
RETURNS TABLE(sequence bigint,payload text,recorded_at timestamptz,snapshot_top bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET jit=off AS $$
DECLARE ceiling bigint := p_top;
BEGIN
  -- Find the snapshot once; subsequent keyset pages use the stream/sequence index.
  IF ceiling IS NULL THEN
    SELECT e.sequence INTO ceiling FROM emr_access.access_entry e
    WHERE e.stream=p_stream AND e.occurred_at>=p_from AND e.occurred_at<p_until
      AND CASE WHEN e.payload::jsonb #>> '{managingInstitution,status}'='known'
        THEN e.payload::jsonb #>> '{managingInstitution,value}'
        ELSE e.payload::jsonb #>> '{actingInstitution,value}' END=p_institution
    ORDER BY e.sequence DESC LIMIT 1;
  END IF;
  RETURN QUERY SELECT e.sequence,e.payload,e.recorded_at,COALESCE(ceiling,0)
    FROM emr_access.access_entry e
    WHERE e.stream=p_stream AND e.sequence<=COALESCE(ceiling,0)
      AND e.sequence<COALESCE(p_before,9223372036854775807)
      AND e.occurred_at>=p_from AND e.occurred_at<p_until
      AND CASE WHEN e.payload::jsonb #>> '{managingInstitution,status}'='known'
        THEN e.payload::jsonb #>> '{managingInstitution,value}'
        ELSE e.payload::jsonb #>> '{actingInstitution,value}' END=p_institution
    ORDER BY e.sequence DESC LIMIT GREATEST(p_limit,0);
END
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
REVOKE ALL ON FUNCTION emr_access.investigation_entries(text,text,timestamptz,timestamptz,bigint,bigint,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emr_access.investigation_entries(text,text,timestamptz,timestamptz,bigint,bigint,integer) TO kin_runtime;
COMMIT;
