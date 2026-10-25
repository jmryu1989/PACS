-- D1860: reader allocation changes stay in viewing without becoming clinical history.
-- Preserve existing ledger entries; change classification for subsequent admissions/appends.
CREATE OR REPLACE FUNCTION emr_access.event_streams(p_event jsonb, p_act text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p_act IN ('기재','추가기재','수정') AND p_event->>'result' = 'succeeded'
    AND EXISTS (SELECT FROM jsonb_array_elements(p_event->'targets') t
      WHERE t->>'kind' NOT IN ('preferences','reading-template','institution','identity-access','authentication-session','system-operation','assignment'))
    THEN ARRAY['viewing','history'] ELSE ARRAY['viewing'] END;
$$;
