-- CD10-CONTRACT-3: reuse an existing study read without exposing ledger rows to the runtime role.
BEGIN;
SET LOCAL ROLE kin_emr_owner;
CREATE FUNCTION emr_access.access_seen(p_issuer text, p_subject text, p_study_uid text,
  p_since timestamptz, p_session text DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET jit = off AS $$
  SELECT EXISTS (
    SELECT 1 FROM emr_access.access_entry e
    JOIN emr_access.access_target t ON t.entry_id = e.entry_id AND t.record_id = p_study_uid
    WHERE e.stream = 'viewing' AND e.statutory_act = '열람' AND e.occurred_at >= p_since
      AND e.payload::jsonb #>> '{userId,value,issuer}' = p_issuer
      AND e.payload::jsonb #>> '{userId,value,subject}' = p_subject
      AND e.payload::jsonb @> jsonb_build_object('targets', jsonb_build_array(
        jsonb_build_object('studyId', jsonb_build_object('status', 'known', 'value', p_study_uid))))
      -- V1 has no session field; its timestamp is bounded by the current authentication session.
      -- V2 already stores a non-credential session reference, so use its exact binding when available.
      AND (p_session IS NULL OR e.payload::jsonb -> 'session' IS NULL
        OR e.payload::jsonb #>> '{session,sessionRef}' = p_session)
  );
$$;
RESET ROLE;
REVOKE EXECUTE ON FUNCTION emr_access.access_seen(text,text,text,timestamptz,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emr_access.access_seen(text,text,text,timestamptz,text) TO kin_runtime;
COMMIT;
