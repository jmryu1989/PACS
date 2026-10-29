-- The PostgreSQL image runs this only for a new data volume, as POSTGRES_USER (kin).
-- Existing realms and databases are left intact on subsequent starts.
CREATE DATABASE keycloak;
