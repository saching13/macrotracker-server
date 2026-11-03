CREATE TABLE "app"."oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"auth_method" text NOT NULL,
	"secret_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."oauth_clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."oauth_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"refresh_hash" text NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "oauth_grants_refresh_hash_unique" UNIQUE("refresh_hash")
);
--> statement-breakpoint
ALTER TABLE "app"."oauth_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."api_tokens" ADD COLUMN "grant_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "app"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "app"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_grants_user_idx" ON "app"."oauth_grants" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "app"."api_tokens" ADD CONSTRAINT "api_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "app"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "oauth_clients_read" ON "app"."oauth_clients" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "oauth_clients_register" ON "app"."oauth_clients" AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "oauth_codes_owner" ON "app"."oauth_codes" AS PERMISSIVE FOR ALL TO public USING ("app"."oauth_codes"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."oauth_codes"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "oauth_grants_owner" ON "app"."oauth_grants" AS PERMISSIVE FOR ALL TO public USING ("app"."oauth_grants"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."oauth_grants"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);