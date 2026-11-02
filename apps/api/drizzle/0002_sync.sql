CREATE TABLE "app"."body_metric_entries" (
	"id" text NOT NULL,
	"local_date" date NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"health_uuid" text,
	"created_at" text NOT NULL,
	"user_id" uuid NOT NULL,
	"rev" bigint NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by_device" uuid,
	"schema_version" integer NOT NULL,
	CONSTRAINT "body_metric_entries_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."body_metric_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."food_servings" (
	"id" text NOT NULL,
	"food_id" text NOT NULL,
	"label" text NOT NULL,
	"base_amount" double precision NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"user_id" uuid NOT NULL,
	"rev" bigint NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by_device" uuid,
	"schema_version" integer NOT NULL,
	CONSTRAINT "food_servings_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."food_servings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."foods" (
	"id" text NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"barcode" text,
	"serving_qty" double precision NOT NULL,
	"serving_unit" text NOT NULL,
	"kcal_per_serving" double precision NOT NULL,
	"protein_g" double precision NOT NULL,
	"carb_g" double precision NOT NULL,
	"fat_g" double precision NOT NULL,
	"fiber_g" double precision,
	"saturated_fat_g" double precision,
	"trans_fat_g" double precision,
	"cholesterol_mg" double precision,
	"sodium_mg" double precision,
	"sugar_g" double precision,
	"source" text NOT NULL,
	"is_favorite" integer DEFAULT 0 NOT NULL,
	"user_id" uuid NOT NULL,
	"rev" bigint NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by_device" uuid,
	"schema_version" integer NOT NULL,
	CONSTRAINT "foods_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "foods_user_source" CHECK ("app"."foods"."source" in ('custom', 'off', 'import'))
);
--> statement-breakpoint
ALTER TABLE "app"."foods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."goals" (
	"id" text NOT NULL,
	"goal_type" text NOT NULL,
	"start_date" date NOT NULL,
	"start_weight_kg" double precision,
	"target_weight_kg" double precision,
	"rate_value" double precision NOT NULL,
	"rate_unit" text DEFAULT 'mass_per_week' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" text NOT NULL,
	"ended_at" text,
	"user_id" uuid NOT NULL,
	"rev" bigint NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by_device" uuid,
	"schema_version" integer NOT NULL,
	CONSTRAINT "goals_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."log_entries" (
	"id" text NOT NULL,
	"local_date" date NOT NULL,
	"meal" text NOT NULL,
	"food_id" text,
	"recipe_id" text,
	"quantity" double precision NOT NULL,
	"kcal" double precision NOT NULL,
	"protein_g" double precision NOT NULL,
	"carb_g" double precision NOT NULL,
	"fat_g" double precision NOT NULL,
	"health_uuid" text,
	"created_at" text NOT NULL,
	"logged_time" text,
	"serving_label" text,
	"serving_amount" double precision,
	"user_id" uuid NOT NULL,
	"rev" bigint NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by_device" uuid,
	"schema_version" integer NOT NULL,
	CONSTRAINT "log_entries_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."log_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."programs" (
	"id" text NOT NULL,
	"goal_type" text NOT NULL,
	"rate_value" double precision NOT NULL,
	"rate_unit" text NOT NULL,
	"diet_style" text NOT NULL,
	"protein_policy" text NOT NULL,
	"custom_protein_pct" integer,
	"custom_carb_pct" integer,
	"custom_fat_pct" integer,
	"program_style" text DEFAULT 'coached' NOT NULL,
	"macro_style" text,
	"protein_level" text DEFAULT 'moderate' NOT NULL,
	"day_plan" text,
	"calorie_floor" text DEFAULT 'standard' NOT NULL,
	"training" text DEFAULT 'none' NOT NULL,
	"goal_id" text,
	"started_at" text NOT NULL,
	"active" integer DEFAULT 0 NOT NULL,
	"user_id" uuid NOT NULL,
	"rev" bigint NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by_device" uuid,
	"schema_version" integer NOT NULL,
	CONSTRAINT "programs_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."programs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."recipe_items" (
	"id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"food_id" text NOT NULL,
	"quantity" double precision NOT NULL,
	"user_id" uuid NOT NULL,
	"rev" bigint NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by_device" uuid,
	"schema_version" integer NOT NULL,
	CONSTRAINT "recipe_items_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."recipe_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."recipes" (
	"id" text NOT NULL,
	"name" text NOT NULL,
	"total_kcal" double precision NOT NULL,
	"total_protein_g" double precision NOT NULL,
	"total_carb_g" double precision NOT NULL,
	"total_fat_g" double precision NOT NULL,
	"created_at" text NOT NULL,
	"servings" double precision DEFAULT 1 NOT NULL,
	"total_weight_g" double precision,
	"user_id" uuid NOT NULL,
	"rev" bigint NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by_device" uuid,
	"schema_version" integer NOT NULL,
	CONSTRAINT "recipes_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."recipes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."server_info" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"server_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_info_single_row" CHECK ("app"."server_info"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "app"."server_info" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."sync_receipts" (
	"user_id" uuid NOT NULL,
	"change_id" uuid NOT NULL,
	"result" text NOT NULL,
	"rev" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_receipts_user_id_change_id_pk" PRIMARY KEY("user_id","change_id")
);
--> statement-breakpoint
ALTER TABLE "app"."sync_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."sync_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."sync_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."targets" (
	"id" text NOT NULL,
	"effective_date" date NOT NULL,
	"kcal" double precision NOT NULL,
	"protein_g" double precision NOT NULL,
	"carb_g" double precision NOT NULL,
	"fat_g" double precision NOT NULL,
	"expenditure_estimate" double precision NOT NULL,
	"generated_at" text NOT NULL,
	"reason" text NOT NULL,
	"weekday" integer,
	"user_id" uuid NOT NULL,
	"rev" bigint NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by_device" uuid,
	"schema_version" integer NOT NULL,
	CONSTRAINT "targets_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."user_meta" (
	"key" text NOT NULL,
	"value" text NOT NULL,
	"user_id" uuid NOT NULL,
	"rev" bigint NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by_device" uuid,
	"schema_version" integer NOT NULL,
	CONSTRAINT "user_meta_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "app"."user_meta" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."user_profile" (
	"id" text NOT NULL,
	"sex" text NOT NULL,
	"birth_date" date NOT NULL,
	"height_cm" double precision NOT NULL,
	"activity_seed" text NOT NULL,
	"unit_mass" text DEFAULT 'kg' NOT NULL,
	"unit_energy" text DEFAULT 'kcal' NOT NULL,
	"created_at" text NOT NULL,
	"user_id" uuid NOT NULL,
	"rev" bigint NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by_device" uuid,
	"schema_version" integer NOT NULL,
	CONSTRAINT "user_profile_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."user_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."weight_entries" (
	"id" text NOT NULL,
	"local_date" date NOT NULL,
	"weight_kg" double precision NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"health_uuid" text,
	"created_at" text NOT NULL,
	"user_id" uuid NOT NULL,
	"rev" bigint NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by_device" uuid,
	"schema_version" integer NOT NULL,
	CONSTRAINT "weight_entries_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."weight_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."body_metric_entries" ADD CONSTRAINT "body_metric_entries_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."food_servings" ADD CONSTRAINT "food_servings_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."foods" ADD CONSTRAINT "foods_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."goals" ADD CONSTRAINT "goals_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."log_entries" ADD CONSTRAINT "log_entries_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."programs" ADD CONSTRAINT "programs_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."recipe_items" ADD CONSTRAINT "recipe_items_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."recipes" ADD CONSTRAINT "recipes_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sync_receipts" ADD CONSTRAINT "sync_receipts_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sync_state" ADD CONSTRAINT "sync_state_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."targets" ADD CONSTRAINT "targets_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_meta" ADD CONSTRAINT "user_meta_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_profile" ADD CONSTRAINT "user_profile_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."weight_entries" ADD CONSTRAINT "weight_entries_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "body_metric_entries_rev_idx" ON "app"."body_metric_entries" USING btree ("user_id","rev");--> statement-breakpoint
CREATE INDEX "body_metric_entries_date_idx" ON "app"."body_metric_entries" USING btree ("user_id","metric","local_date");--> statement-breakpoint
CREATE INDEX "food_servings_rev_idx" ON "app"."food_servings" USING btree ("user_id","rev");--> statement-breakpoint
CREATE INDEX "food_servings_food_idx" ON "app"."food_servings" USING btree ("user_id","food_id");--> statement-breakpoint
CREATE INDEX "foods_rev_idx" ON "app"."foods" USING btree ("user_id","rev");--> statement-breakpoint
CREATE INDEX "goals_rev_idx" ON "app"."goals" USING btree ("user_id","rev");--> statement-breakpoint
CREATE INDEX "log_entries_rev_idx" ON "app"."log_entries" USING btree ("user_id","rev");--> statement-breakpoint
CREATE INDEX "log_entries_date_idx" ON "app"."log_entries" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE INDEX "programs_rev_idx" ON "app"."programs" USING btree ("user_id","rev");--> statement-breakpoint
CREATE INDEX "recipe_items_rev_idx" ON "app"."recipe_items" USING btree ("user_id","rev");--> statement-breakpoint
CREATE INDEX "recipe_items_recipe_idx" ON "app"."recipe_items" USING btree ("user_id","recipe_id");--> statement-breakpoint
CREATE INDEX "recipes_rev_idx" ON "app"."recipes" USING btree ("user_id","rev");--> statement-breakpoint
CREATE INDEX "sync_receipts_created_idx" ON "app"."sync_receipts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "targets_rev_idx" ON "app"."targets" USING btree ("user_id","rev");--> statement-breakpoint
CREATE INDEX "targets_date_idx" ON "app"."targets" USING btree ("user_id","effective_date");--> statement-breakpoint
CREATE INDEX "user_meta_rev_idx" ON "app"."user_meta" USING btree ("user_id","rev");--> statement-breakpoint
CREATE INDEX "user_profile_rev_idx" ON "app"."user_profile" USING btree ("user_id","rev");--> statement-breakpoint
CREATE INDEX "weight_entries_rev_idx" ON "app"."weight_entries" USING btree ("user_id","rev");--> statement-breakpoint
CREATE INDEX "weight_entries_date_idx" ON "app"."weight_entries" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE POLICY "body_metric_entries_owner" ON "app"."body_metric_entries" AS PERMISSIVE FOR ALL TO public USING ("app"."body_metric_entries"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."body_metric_entries"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "food_servings_owner" ON "app"."food_servings" AS PERMISSIVE FOR ALL TO public USING ("app"."food_servings"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."food_servings"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "foods_owner" ON "app"."foods" AS PERMISSIVE FOR ALL TO public USING ("app"."foods"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."foods"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "goals_owner" ON "app"."goals" AS PERMISSIVE FOR ALL TO public USING ("app"."goals"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."goals"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "log_entries_owner" ON "app"."log_entries" AS PERMISSIVE FOR ALL TO public USING ("app"."log_entries"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."log_entries"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "programs_owner" ON "app"."programs" AS PERMISSIVE FOR ALL TO public USING ("app"."programs"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."programs"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "recipe_items_owner" ON "app"."recipe_items" AS PERMISSIVE FOR ALL TO public USING ("app"."recipe_items"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."recipe_items"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "recipes_owner" ON "app"."recipes" AS PERMISSIVE FOR ALL TO public USING ("app"."recipes"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."recipes"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "server_info_read" ON "app"."server_info" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "sync_receipts_owner" ON "app"."sync_receipts" AS PERMISSIVE FOR ALL TO public USING ("app"."sync_receipts"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."sync_receipts"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sync_state_owner" ON "app"."sync_state" AS PERMISSIVE FOR ALL TO public USING ("app"."sync_state"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."sync_state"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "targets_owner" ON "app"."targets" AS PERMISSIVE FOR ALL TO public USING ("app"."targets"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."targets"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "user_meta_owner" ON "app"."user_meta" AS PERMISSIVE FOR ALL TO public USING ("app"."user_meta"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."user_meta"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "user_profile_owner" ON "app"."user_profile" AS PERMISSIVE FOR ALL TO public USING ("app"."user_profile"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."user_profile"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "weight_entries_owner" ON "app"."weight_entries" AS PERMISSIVE FOR ALL TO public USING ("app"."weight_entries"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."weight_entries"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);