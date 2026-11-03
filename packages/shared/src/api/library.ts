import { z } from 'zod';

/**
 * The shared recipe library (plan-11 S7): recipes people on this server
 * publish, for everyone else to browse and copy into their own recipes.
 */

export const sharedIngredient = z.object({
  name: z.string(),
  /** Base units of the food (g/ml). */
  quantity: z.number(),
  food: z.object({
    id: z.string(),
    /** A USDA food every app has; otherwise copied as the recipe is added. */
    reference: z.boolean(),
    name: z.string(),
    brand: z.string().nullable(),
    serving_qty: z.number(),
    serving_unit: z.string(),
    kcal_per_serving: z.number(),
    protein_g: z.number(),
    carb_g: z.number(),
    fat_g: z.number(),
    fiber_g: z.number().nullable(),
  }),
});

export const sharedRecipe = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /** Who shared it, as they're known on this server. */
    shared_by: z.string(),
    servings: z.number(),
    total_weight_g: z.number().nullable(),
    total_kcal: z.number(),
    total_protein_g: z.number(),
    total_carb_g: z.number(),
    total_fat_g: z.number(),
    ingredients: z.array(sharedIngredient),
    /** Bumped each time the owner republishes it. */
    version: z.number().int(),
    updated_at: z.string(),
    /** Yours: you can update or remove it. */
    mine: z.boolean(),
    /** Yours: the recipe of yours it was shared from. */
    from_recipe_id: z.string().nullable(),
    /** The recipe of yours it was copied into, if you've added it. */
    added_as: z.string().nullable(),
  })
  .meta({ id: 'SharedRecipe' });
export type SharedRecipe = z.infer<typeof sharedRecipe>;

export const libraryQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const publishBody = z.object({
  /** One of your recipes. Publishing it again updates the library copy. */
  recipe_id: z.string().min(1).max(128),
});

export const copyResponse = z
  .object({
    /** Your new recipe. */
    recipe_id: z.string(),
    /** Foods of yours created for its ingredients (USDA ones are reused). */
    foods_created: z.number().int(),
  })
  .meta({ id: 'LibraryCopy' });
