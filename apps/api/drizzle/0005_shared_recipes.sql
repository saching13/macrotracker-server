CREATE TABLE "app"."shared_recipe_copies" (
	"user_id" uuid NOT NULL,
	"shared_recipe_id" uuid NOT NULL,
	"recipe_id" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_recipe_copies_user_id_shared_recipe_id_pk" PRIMARY KEY("user_id","shared_recipe_id")
);
--> statement-breakpoint
ALTER TABLE "app"."shared_recipe_copies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."shared_recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_name" text NOT NULL,
	"source_recipe_id" text NOT NULL,
	"name" text NOT NULL,
	"servings" double precision NOT NULL,
	"total_weight_g" double precision,
	"total_kcal" double precision NOT NULL,
	"total_protein_g" double precision NOT NULL,
	"total_carb_g" double precision NOT NULL,
	"total_fat_g" double precision NOT NULL,
	"ingredients" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."shared_recipes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."shared_recipe_copies" ADD CONSTRAINT "shared_recipe_copies_user_id_app_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."shared_recipe_copies" ADD CONSTRAINT "shared_recipe_copies_shared_recipe_id_shared_recipes_id_fk" FOREIGN KEY ("shared_recipe_id") REFERENCES "app"."shared_recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."shared_recipes" ADD CONSTRAINT "shared_recipes_owner_id_app_users_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."app_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shared_recipes_source_idx" ON "app"."shared_recipes" USING btree ("owner_id","source_recipe_id");--> statement-breakpoint
CREATE INDEX "shared_recipes_name_idx" ON "app"."shared_recipes" USING btree ("name");--> statement-breakpoint
CREATE POLICY "shared_recipe_copies_owner" ON "app"."shared_recipe_copies" AS PERMISSIVE FOR ALL TO public USING ("app"."shared_recipe_copies"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."shared_recipe_copies"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "shared_recipes_read" ON "app"."shared_recipes" AS PERMISSIVE FOR SELECT TO public USING (nullif(current_setting('app.user_id', true), '')::uuid is not null);--> statement-breakpoint
CREATE POLICY "shared_recipes_insert" ON "app"."shared_recipes" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("app"."shared_recipes"."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "shared_recipes_update" ON "app"."shared_recipes" AS PERMISSIVE FOR UPDATE TO public USING ("app"."shared_recipes"."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("app"."shared_recipes"."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "shared_recipes_delete" ON "app"."shared_recipes" AS PERMISSIVE FOR DELETE TO public USING ("app"."shared_recipes"."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid or coalesce(current_setting('app.is_admin', true), '') = 'on');