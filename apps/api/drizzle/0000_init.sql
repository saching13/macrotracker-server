CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
CREATE TABLE "app"."api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "app"."api_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."app_users" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_users_role_check" CHECK ("app"."app_users"."role" in ('admin', 'member'))
);
--> statement-breakpoint
ALTER TABLE "app"."app_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event" text NOT NULL,
	"user_id" uuid,
	"actor_id" uuid,
	"ip" text,
	"user_agent" text,
	"request_id" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "app"."devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."api_tokens" ADD CONSTRAINT "api_tokens_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD CONSTRAINT "devices_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "app"."api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_events_user_idx" ON "app"."audit_events" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "app"."devices" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "api_tokens_owner" ON "app"."api_tokens" AS PERMISSIVE FOR ALL TO public USING ("app"."api_tokens"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."api_tokens"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "app_users_select" ON "app"."app_users" AS PERMISSIVE FOR SELECT TO public USING ("app"."app_users"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid or coalesce(current_setting('app.is_admin', true), '') = 'on');--> statement-breakpoint
CREATE POLICY "app_users_insert" ON "app"."app_users" AS PERMISSIVE FOR INSERT TO public WITH CHECK (coalesce(current_setting('app.is_admin', true), '') = 'on');--> statement-breakpoint
CREATE POLICY "app_users_update" ON "app"."app_users" AS PERMISSIVE FOR UPDATE TO public USING ("app"."app_users"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid or coalesce(current_setting('app.is_admin', true), '') = 'on') WITH CHECK ("app"."app_users"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid or coalesce(current_setting('app.is_admin', true), '') = 'on');--> statement-breakpoint
CREATE POLICY "app_users_delete" ON "app"."app_users" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.is_admin', true), '') = 'on');--> statement-breakpoint
CREATE POLICY "audit_events_insert" ON "app"."audit_events" AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "audit_events_select" ON "app"."audit_events" AS PERMISSIVE FOR SELECT TO public USING (coalesce(current_setting('app.is_admin', true), '') = 'on' or "app"."audit_events"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "devices_owner" ON "app"."devices" AS PERMISSIVE FOR ALL TO public USING ("app"."devices"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."devices"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);