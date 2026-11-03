import { randomUUID } from 'node:crypto';
import type { SharedRecipe } from '@macrotracker/shared';
import { and, asc, eq, ilike, inArray, or } from 'drizzle-orm';
import { withContext, type Db, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { AppError } from '../errors.js';
import { live } from './engine.js';
import { type ServerWrite, type SyncActor, SyncService } from './sync.js';

type SharedRow = typeof s.sharedRecipes.$inferSelect;

const missing = () => new AppError(404, 'shared_recipe_not_found', 'No such recipe in the library');

/**
 * The shared recipe library. Publishing snapshots one of the caller's
 * synced recipes with each ingredient's facts embedded; copying writes a new
 * recipe (and the ingredient foods it needs) into the caller's own synced
 * data, so it reaches their phones like any other change.
 *
 * Only foods the server holds can be published: the owner's synced foods and
 * the USDA reference foods. INDB foods never sync, so a recipe using one
 * can't be shared (INDB may not be redistributed).
 */
export class LibraryService {
  private readonly sync: SyncService;

  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.sync = new SyncService(db, clock);
  }

  private tx<T>(actor: SyncActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withContext(this.db, { userId: actor.userId }, fn);
  }

  async list(actor: SyncActor, q: string | undefined, limit: number): Promise<SharedRecipe[]> {
    return this.tx(actor, async (tx) => {
      const terms = (q ?? '').split(/\s+/).filter(Boolean);
      const like = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = await tx
        .select()
        .from(s.sharedRecipes)
        .where(
          terms.length === 0
            ? undefined
            : and(
                ...terms.map((t) =>
                  or(ilike(s.sharedRecipes.name, like(t)), ilike(s.sharedRecipes.ownerName, like(t))),
                ),
              ),
        )
        .orderBy(asc(s.sharedRecipes.name))
        .limit(limit);
      return this.out(tx, actor, rows);
    });
  }

  async get(actor: SyncActor, id: string): Promise<SharedRecipe> {
    return this.tx(actor, async (tx) => {
      const [row] = await tx.select().from(s.sharedRecipes).where(eq(s.sharedRecipes.id, id));
      if (!row) throw missing();
      return (await this.out(tx, actor, [row]))[0]!;
    });
  }

  private async out(tx: Tx, actor: SyncActor, rows: SharedRow[]): Promise<SharedRecipe[]> {
    const ids = rows.map((r) => r.id);
    const copies =
      ids.length === 0
        ? []
        : await tx
            .select()
            .from(s.sharedRecipeCopies)
            .where(
              and(
                eq(s.sharedRecipeCopies.userId, actor.userId),
                inArray(s.sharedRecipeCopies.sharedRecipeId, ids),
              ),
            );
    // A copy counts while its recipe still exists.
    const liveRecipes = new Set(
      copies.length === 0
        ? []
        : (
            await tx
              .select({ id: s.recipes.id })
              .from(s.recipes)
              .where(
                and(
                  live(s.recipes, actor.userId),
                  inArray(
                    s.recipes.id,
                    copies.map((c) => c.recipeId),
                  ),
                ),
              )
          ).map((r) => r.id),
    );
    return rows.map((r) => {
      const copy = copies.find((c) => c.sharedRecipeId === r.id);
      return {
        id: r.id,
        name: r.name,
        shared_by: r.ownerName,
        servings: r.servings,
        total_weight_g: r.totalWeightG,
        total_kcal: r.totalKcal,
        total_protein_g: r.totalProteinG,
        total_carb_g: r.totalCarbG,
        total_fat_g: r.totalFatG,
        ingredients: r.ingredients,
        version: r.version,
        updated_at: r.updatedAt.toISOString(),
        mine: r.ownerId === actor.userId,
        from_recipe_id: r.ownerId === actor.userId ? r.sourceRecipeId : null,
        added_as: copy && liveRecipes.has(copy.recipeId) ? copy.recipeId : null,
      };
    });
  }

  /** Publishes one of the caller's recipes, or updates its library copy. */
  async publish(actor: SyncActor, recipeId: string, email?: string): Promise<SharedRecipe> {
    const id = await this.tx(actor, async (tx) => {
      const [recipe] = await tx
        .select()
        .from(s.recipes)
        .where(and(live(s.recipes, actor.userId), eq(s.recipes.id, recipeId)));
      if (!recipe) throw new AppError(404, 'recipe_not_found', 'No such recipe (has it synced yet?)');
      const items = await tx
        .select()
        .from(s.recipeItems)
        .where(and(live(s.recipeItems, actor.userId), eq(s.recipeItems.recipeId, recipeId)));
      if (items.length === 0) throw new AppError(422, 'empty_recipe', 'This recipe has no ingredients');

      const foodIds = [...new Set(items.map((i) => i.foodId))];
      const mine = await tx
        .select()
        .from(s.foods)
        .where(and(live(s.foods, actor.userId), inArray(s.foods.id, foodIds)));
      const refs = await tx.select().from(s.referenceFoods).where(inArray(s.referenceFoods.id, foodIds));
      const ingredients: s.SharedIngredient[] = [];
      let unavailable = 0;
      for (const item of items) {
        const own = mine.find((f) => f.id === item.foodId);
        const ref = refs.find((f) => f.id === item.foodId);
        const f = own ?? ref;
        if (!f) {
          unavailable++;
          continue;
        }
        ingredients.push({
          name: f.name,
          quantity: item.quantity,
          food: {
            id: f.id,
            reference: !own,
            name: f.name,
            brand: own?.brand ?? null,
            serving_qty: f.servingQty,
            serving_unit: f.servingUnit,
            kcal_per_serving: f.kcalPerServing,
            protein_g: f.proteinG,
            carb_g: f.carbG,
            fat_g: f.fatG,
            fiber_g: f.fiberG,
          },
        });
      }
      if (unavailable > 0) {
        throw new AppError(
          422,
          'not_shareable',
          `${unavailable} ingredient${unavailable === 1 ? ' isn’t' : 's aren’t'} on the server. INDB foods can never be shared; other foods sync from the app first.`,
        );
      }

      const [user] = await tx
        .select({ name: s.appUsers.displayName })
        .from(s.appUsers)
        .where(eq(s.appUsers.userId, actor.userId));
      const [existing] = await tx
        .select()
        .from(s.sharedRecipes)
        .where(and(eq(s.sharedRecipes.ownerId, actor.userId), eq(s.sharedRecipes.sourceRecipeId, recipeId)));
      const ownerName = user?.name ?? email?.split('@')[0] ?? existing?.ownerName ?? 'Someone on this server';
      const values = {
        ownerName,
        name: recipe.name,
        servings: recipe.servings,
        totalWeightG: recipe.totalWeightG,
        totalKcal: recipe.totalKcal,
        totalProteinG: recipe.totalProteinG,
        totalCarbG: recipe.totalCarbG,
        totalFatG: recipe.totalFatG,
        ingredients,
      };
      if (existing) {
        await tx
          .update(s.sharedRecipes)
          .set({ ...values, version: existing.version + 1, updatedAt: this.clock() })
          .where(eq(s.sharedRecipes.id, existing.id));
        return existing.id;
      }
      const [row] = await tx
        .insert(s.sharedRecipes)
        .values({ ...values, ownerId: actor.userId, sourceRecipeId: recipeId })
        .returning({ id: s.sharedRecipes.id });
      return row!.id;
    });
    return this.get(actor, id);
  }

  /** Removes a recipe from the library (copies people made stay theirs). */
  async unpublish(actor: SyncActor, id: string, isAdmin = false): Promise<void> {
    await withContext(this.db, { userId: actor.userId, isAdmin }, async (tx) => {
      const gone = await tx
        .delete(s.sharedRecipes)
        .where(eq(s.sharedRecipes.id, id))
        .returning({ id: s.sharedRecipes.id });
      if (gone.length === 0) throw missing();
    });
  }

  /**
   * Copies a library recipe into the caller's own recipes: a new recipe, and
   * new foods for ingredients that aren't USDA reference foods. Adding the
   * same version twice returns the earlier copy.
   */
  async copy(actor: SyncActor, id: string): Promise<{ recipe_id: string; foods_created: number }> {
    const plan = await this.tx(actor, async (tx) => {
      const shared = (
        await this.out(tx, actor, await tx.select().from(s.sharedRecipes).where(eq(s.sharedRecipes.id, id)))
      )[0];
      if (!shared) throw missing();
      if (shared.mine) throw new AppError(409, 'own_recipe', 'This recipe is already yours');
      if (shared.added_as) {
        const [copy] = await tx
          .select()
          .from(s.sharedRecipeCopies)
          .where(
            and(eq(s.sharedRecipeCopies.userId, actor.userId), eq(s.sharedRecipeCopies.sharedRecipeId, id)),
          );
        if (copy?.version === shared.version) return { shared, existing: shared.added_as };
      }
      return { shared, existing: null };
    });
    if (plan.existing) return { recipe_id: plan.existing, foods_created: 0 };

    const { shared } = plan;
    const recipeId = randomUUID();
    const now = this.clock().toISOString();
    const writes: ServerWrite[] = [];
    const foodIds = new Map<string, string>();
    for (const ing of shared.ingredients) {
      if (ing.food.reference || foodIds.has(ing.food.id)) continue;
      const fid = randomUUID();
      foodIds.set(ing.food.id, fid);
      writes.push({
        table: 'foods',
        id: fid,
        op: 'insert',
        row: {
          id: fid,
          name: ing.food.name,
          brand: ing.food.brand,
          barcode: null,
          serving_qty: ing.food.serving_qty,
          serving_unit: ing.food.serving_unit,
          kcal_per_serving: ing.food.kcal_per_serving,
          protein_g: ing.food.protein_g,
          carb_g: ing.food.carb_g,
          fat_g: ing.food.fat_g,
          fiber_g: ing.food.fiber_g,
          saturated_fat_g: null,
          trans_fat_g: null,
          cholesterol_mg: null,
          sodium_mg: null,
          sugar_g: null,
          // Came from elsewhere, like an imported food (a synced source).
          source: 'import',
          is_favorite: 0,
        },
      });
    }
    writes.push({
      table: 'recipes',
      id: recipeId,
      op: 'insert',
      row: {
        id: recipeId,
        name: shared.name,
        total_kcal: shared.total_kcal,
        total_protein_g: shared.total_protein_g,
        total_carb_g: shared.total_carb_g,
        total_fat_g: shared.total_fat_g,
        created_at: now,
        servings: shared.servings,
        total_weight_g: shared.total_weight_g,
      },
    });
    const itemIds = new Set<string>();
    for (const ing of shared.ingredients) {
      const foodId = foodIds.get(ing.food.id) ?? ing.food.id;
      // The app's item id; repeated ingredients get a suffix.
      let itemId = `${recipeId}_${foodId}`;
      for (let n = 2; itemIds.has(itemId); n++) itemId = `${recipeId}_${foodId}_${n}`;
      itemIds.add(itemId);
      writes.push({
        table: 'recipe_items',
        id: itemId,
        op: 'insert',
        row: { id: itemId, recipe_id: recipeId, food_id: foodId, quantity: ing.quantity },
      });
    }
    await this.sync.write(actor, writes);
    await this.tx(actor, (tx) =>
      tx
        .insert(s.sharedRecipeCopies)
        .values({ userId: actor.userId, sharedRecipeId: id, recipeId, version: shared.version })
        .onConflictDoUpdate({
          target: [s.sharedRecipeCopies.userId, s.sharedRecipeCopies.sharedRecipeId],
          set: { recipeId, version: shared.version, createdAt: this.clock() },
        }),
    );
    return { recipe_id: recipeId, foods_created: foodIds.size };
  }
}
