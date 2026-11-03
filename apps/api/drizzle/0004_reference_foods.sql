CREATE TABLE "app"."reference_foods" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"serving_qty" double precision NOT NULL,
	"serving_unit" text NOT NULL,
	"kcal_per_serving" double precision NOT NULL,
	"protein_g" double precision NOT NULL,
	"carb_g" double precision NOT NULL,
	"fat_g" double precision NOT NULL,
	"fiber_g" double precision,
	"source" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."reference_foods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "reference_foods_read" ON "app"."reference_foods" AS PERMISSIVE FOR SELECT TO public USING (true);