-- ACCESS-REVIEW: the runtime reads only the requested institution and period.
-- Reuse B2's function boundary; no table grant or second ledger connection.
BEGIN;
SET LOCAL ROLE kin_emr_owner;
CREATE FUNCTION emr_access.review_entries(p_institution text, p_from timestamptz, p_until timestamptz,
  p_files boolean, p_top bigint, p_before bigint, p_limit integer)
RETURNS TABLE(entry_id uuid, sequence bigint, event_id text, occurred_at timestamptz,
  recorded_at timestamptz, statutory_act text, payload text, snapshot_top bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH scoped AS (
    SELECT e.*, e.payload::jsonb AS event FROM emr_access.access_entry e
    WHERE e.occurred_at >= p_from AND e.occurred_at < p_until
      AND e.payload::jsonb #>> '{managingInstitution,status}' = 'known'
      AND e.payload::jsonb #>> '{managingInstitution,value}' = p_institution
      AND (p_top IS NULL OR e.sequence <= p_top)
      AND p_limit > 0
  ), ceiling AS (
    SELECT COALESCE(p_top, max(s.sequence), 0) AS top FROM scoped s
  ), events AS (
    -- Keep a history entry if its viewing copy has expired; a pair is one event.
    SELECT DISTINCT ON (s.event_id) s.* FROM scoped s
    WHERE NOT p_files OR s.event->>'action' IN ('download','pdf','copy','disclosure')
      OR s.event->>'surface' LIKE '%original-downloads%'
      OR EXISTS (SELECT FROM jsonb_array_elements(s.event->'targets') t
        WHERE t->>'kind' IN ('download','pdf','copy','disclosure'))
    ORDER BY s.event_id, s.sequence
  )
  SELECT e.entry_id, e.sequence, e.event_id, e.occurred_at, e.recorded_at, e.statutory_act, e.payload, c.top
  FROM events e CROSS JOIN ceiling c
  WHERE (p_before IS NULL OR e.sequence < p_before)
  ORDER BY e.sequence DESC LIMIT GREATEST(p_limit, 0)
$$;
RESET ROLE;
REVOKE ALL ON FUNCTION emr_access.review_entries(text,timestamptz,timestamptz,boolean,bigint,bigint,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emr_access.review_entries(text,timestamptz,timestamptz,boolean,bigint,bigint,integer) TO kin_runtime;
COMMIT;
