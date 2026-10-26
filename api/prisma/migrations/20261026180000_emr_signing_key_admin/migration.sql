-- KEY-ADMIN: the key administrator names the doctor by the immutable B2 member ID, and the doctor's registration
-- carries that ID's verified issuer and subject. The runtime login has no table privilege in emr_access (B2 reads go
-- through definer functions), so the binding is read here; nothing is created or changed.
BEGIN;
SET LOCAL ROLE kin_emr_owner;
CREATE FUNCTION emr_access.member_identity_binding(p_id uuid) RETURNS TABLE(issuer text, subject text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET jit=off AS $$
  SELECT i.issuer, i.subject FROM emr_access.member_identity i WHERE i.id=p_id
$$;
RESET ROLE;
REVOKE ALL ON FUNCTION emr_access.member_identity_binding(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emr_access.member_identity_binding(uuid) TO kin_runtime;
COMMIT;
