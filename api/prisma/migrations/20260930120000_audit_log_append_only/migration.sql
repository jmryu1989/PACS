-- S7-AUDIT-STORE (D281 OP-1 a, RA-1): AuditLog is append-only. The runtime role is the table owner and a superuser, so a
-- privilege cannot take UPDATE, DELETE or TRUNCATE away from it; a trigger refuses them for every role instead and, being
-- a schema object, travels with every backup, rehearsal and product transfer restore (their --no-privileges drops GRANTs).
-- The refusal carries SQLSTATE 42501 (insufficient_privilege), the contract value tests and operators observe. INSERT and
-- SELECT are untouched: no INSERT trigger, so writers are not serialised. Nothing is backfilled, rewritten or deleted.
-- A superuser can still disable the trigger (session_replication_role = replica, ALTER TABLE ... DISABLE TRIGGER); that
-- is detected outside the database by scripts/ops_audit_integrity.py, which seals each backup's rows and probes this guard
-- on the backup's own schema. A later migration that has to change AuditLog rows must state how it handles this guard.
BEGIN;
CREATE FUNCTION "audit_log_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only: % refused', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER "AuditLog_append_only_row" BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();
CREATE TRIGGER "AuditLog_append_only_truncate" BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_log_append_only"();
COMMIT;
