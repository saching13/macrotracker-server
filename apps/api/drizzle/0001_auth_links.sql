-- Hand-written: things drizzle-kit can't express.

-- Deleting a GoTrue user removes their app rows (and, through app_users, their
-- devices and tokens). Referential actions bypass row-level security.
ALTER TABLE "app"."app_users"
  ADD CONSTRAINT "app_users_user_id_auth_users_fk"
  FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- Members may edit their own row (display name) but never their role.
CREATE FUNCTION "app"."guard_role_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
     AND coalesce(current_setting('app.is_admin', true), '') <> 'on' THEN
    RAISE EXCEPTION 'only an admin can change a role' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "app_users_guard_role" BEFORE UPDATE ON "app"."app_users"
  FOR EACH ROW EXECUTE FUNCTION "app"."guard_role_change"();
--> statement-breakpoint

-- Personal access tokens are looked up before we know whose they are, which
-- row-level security would otherwise hide. This returns only the one row whose
-- hash matches, so it reveals nothing to a caller without the token.
CREATE FUNCTION "app"."lookup_api_token"(p_hash text)
RETURNS TABLE (id uuid, user_id uuid, scopes text[], expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT t.id, t.user_id, t.scopes, t.expires_at, t.revoked_at
  FROM app.api_tokens t
  WHERE t.token_hash = p_hash;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."lookup_api_token"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."lookup_api_token"(text) TO mt_api;
