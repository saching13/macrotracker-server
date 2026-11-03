-- OAuth lookups that happen before the caller is known (so before app.user_id
-- is set): redeeming a code and finding a refresh token. Like lookup_api_token,
-- they run as the schema owner and return only the matching row.
CREATE FUNCTION "app"."oauth_take_code"(p_hash text)
RETURNS TABLE (client_id text, user_id uuid, redirect_uri text, code_challenge text, scopes text[])
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  UPDATE app.oauth_codes c SET used_at = now()
  WHERE c.code_hash = p_hash AND c.used_at IS NULL AND c.expires_at > now()
  RETURNING c.client_id, c.user_id, c.redirect_uri, c.code_challenge, c.scopes;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."oauth_take_code"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."oauth_take_code"(text) TO mt_api;
--> statement-breakpoint
CREATE FUNCTION "app"."oauth_find_refresh"(p_hash text)
RETURNS TABLE (id uuid, user_id uuid, client_id text, scopes text[], refresh_expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT g.id, g.user_id, g.client_id, g.scopes, g.refresh_expires_at, g.revoked_at
  FROM app.oauth_grants g
  WHERE g.refresh_hash = p_hash;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."oauth_find_refresh"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."oauth_find_refresh"(text) TO mt_api;
