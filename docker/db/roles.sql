-- Runs once, as the superuser, when the data volume is first initialized.
-- Supabase's reserved roles get the cluster password (GoTrue logs in as
-- supabase_auth_admin); our own roles get their own passwords.
\set pgpass `echo "$POSTGRES_PASSWORD"`
\set owner_pass `echo "$MT_OWNER_PASSWORD"`
\set api_pass `echo "$MT_API_PASSWORD"`
\set jwt_exp `echo "$JWT_EXP"`

ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';

-- mt_owner owns the app schema and runs migrations. mt_api is what the API
-- connects as at runtime: no ownership, so row-level security applies to it.
CREATE ROLE mt_owner LOGIN PASSWORD :'owner_pass' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE mt_api LOGIN PASSWORD :'api_pass' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;

CREATE SCHEMA app AUTHORIZATION mt_owner;
-- The migrator issues CREATE SCHEMA IF NOT EXISTS, which needs this even when app exists.
GRANT CREATE ON DATABASE postgres TO mt_owner;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO mt_api;
ALTER DEFAULT PRIVILEGES FOR ROLE mt_owner IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mt_api;
ALTER DEFAULT PRIVILEGES FOR ROLE mt_owner IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO mt_api;
ALTER DEFAULT PRIVILEGES FOR ROLE mt_owner IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO mt_api;

-- App rows reference GoTrue's users so deleting an account cascades.
GRANT USAGE ON SCHEMA auth TO mt_owner;
GRANT REFERENCES, SELECT ON auth.users TO mt_owner;
