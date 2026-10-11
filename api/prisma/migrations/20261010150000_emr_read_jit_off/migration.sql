-- REQ-D949 / RISK-EMR-NESTED-JIT: SECURITY DEFINER SQL bodies can use
-- generic plans whose cost grows with retained rows independently of the
-- bounded outer verification plan. Keep these reads free of per-call JIT.
-- ALTER preserves ownership, grants, search_path and append-only contracts.
BEGIN;
ALTER FUNCTION emr_access.civil_period_end(timestamptz, integer) SET jit = off;
ALTER FUNCTION emr_access.access_retention_floor(timestamptz) SET jit = off;
ALTER FUNCTION emr_access.storage_placement() SET jit = off;
ALTER FUNCTION emr_access.require_placement() SET jit = off;
ALTER FUNCTION emr_access.chain_hash(bigint, text, text) SET jit = off;
ALTER FUNCTION emr_access.chain_tail(text) SET jit = off;
ALTER FUNCTION emr_access.entries_after(text, bigint, integer) SET jit = off;
ALTER FUNCTION emr_access.entry_for_event(text, text) SET jit = off;
ALTER FUNCTION emr_access.retention_view(bigint, integer) SET jit = off;
ALTER FUNCTION emr_access.append_fact_checked(text, text[]) SET jit = off;
ALTER FUNCTION emr_access.holds_for(text) SET jit = off;
ALTER FUNCTION emr_access.duty_requests(text, text) SET jit = off;
ALTER FUNCTION emr_access.clause_versions(text) SET jit = off;
-- This read is VOLATILE because it acquires an advisory lock.
ALTER FUNCTION emr_access.order_facts_for(text) SET jit = off;
ALTER FUNCTION emr_access.commit_marker_for_slot(text, bigint) SET jit = off;
ALTER FUNCTION emr_access.commit_marker_for_attempt(text, text) SET jit = off;
COMMIT;
