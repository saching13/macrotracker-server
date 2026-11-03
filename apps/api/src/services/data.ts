import { randomUUID } from 'node:crypto';
import {
  type CreateEntryBody,
  type CreateFoodBody,
  type Entry,
  type Food,
  type Status,
  type UpdateEntryBody,
  engine,
  foodMacros,
  type Macros,
  mealForTime,
  recipeMacros,
  sumMacros,
} from '@macrotracker/shared';
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { withContext, type Db, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { AppError } from '../errors.js';
import {
  activeProgram,
  latestWeek,
  live,
  replayAccount,
  targetsId,
  targetsOn,
  type TargetsRow,
} from './engine.js';
import { type ServerWrite, type SyncActor, SyncService, wireRow } from './sync.js';

const QUICK_ADD = 'Quick Add';

const missing = (message: string, code: string) => new AppError(404, code, message);

type FoodRow = typeof s.foods.$inferSelect;
type RefRow = typeof s.referenceFoods.$inferSelect;
type EntryRow = typeof s.logEntries.$inferSelect;

/** What a food looks like to the macro math, from either table. */
interface FoodFacts {
  name: string;
  serving_qty: number;
  kcal_per_serving: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
}

const factsOf = (f: FoodRow | RefRow): FoodFacts => ({
  name: f.name,
  serving_qty: f.servingQty,
  kcal_per_serving: f.kcalPerServing,
  protein_g: f.proteinG,
  carb_g: f.carbG,
  fat_g: f.fatG,
});

const targetsOut = (t: TargetsRow) => ({
  kcal: t.kcal,
  protein_g: t.proteinG,
  carb_g: t.carbG,
  fat_g: t.fatG,
  effective_date: t.effectiveDate,
  weekday: t.weekday,
});

/** Every term must appear in one of `cols` (name, brand), as the app's search does. */
function termsMatch(q: string, ...cols: PgColumn[]): SQL | undefined {
  const like = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return and(
    ...q
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => or(...cols.map((c) => ilike(c, like(t))))),
  );
}

/**
 * The account's data for the web app and agents. Reads query the synced
 * tables (live rows only); every write goes through `SyncService.write`, so
 * it takes a rev and reaches the phones like any other change.
 */
export class DataService {
  private readonly sync: SyncService;

  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.sync = new SyncService(db, clock);
  }

  private read<T>(actor: SyncActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withContext(this.db, { userId: actor.userId }, fn, { isolationLevel: 'repeatable read' });
  }

  private now(): string {
    return this.clock().toISOString();
  }

  // ── Diary ──

  async day(actor: SyncActor, date: string) {
    return this.read(actor, async (tx) => {
      const rows = await tx
        .select()
        .from(s.logEntries)
        .where(and(live(s.logEntries, actor.userId), eq(s.logEntries.localDate, date)))
        .orderBy(asc(s.logEntries.loggedTime), asc(s.logEntries.createdAt));
      const entries = await this.entriesOut(tx, actor.userId, rows);
      const targets = await targetsOn(tx, actor.userId, date);
      const { partialDays } = await this.metaOnly(tx, actor.userId);
      return {
        date,
        entries,
        totals: sumMacros(entries),
        targets: targets ? targetsOut(targets) : null,
        partial: partialDays.has(date),
      };
    });
  }

  private async metaOnly(tx: Tx, userId: string) {
    const [row] = await tx
      .select({ value: s.userMeta.value })
      .from(s.userMeta)
      .where(and(live(s.userMeta, userId), eq(s.userMeta.key, 'partial_days')));
    let partialDays = new Set<string>();
    try {
      const parsed = JSON.parse(row?.value ?? '[]') as unknown;
      if (Array.isArray(parsed))
        partialDays = new Set(parsed.filter((d): d is string => typeof d === 'string'));
    } catch {
      // Malformed: none.
    }
    return { partialDays };
  }

  /** Entries with their food or recipe names. */
  private async entriesOut(tx: Tx, userId: string, rows: EntryRow[]): Promise<Entry[]> {
    const foodIds = [...new Set(rows.map((r) => r.foodId).filter((x): x is string => x != null))];
    const recipeIds = [...new Set(rows.map((r) => r.recipeId).filter((x): x is string => x != null))];
    const names = new Map<string, string>();
    if (foodIds.length > 0) {
      for (const f of await tx
        .select({ id: s.foods.id, name: s.foods.name })
        .from(s.foods)
        .where(and(live(s.foods, userId), inArray(s.foods.id, foodIds)))) {
        names.set(`f:${f.id}`, f.name);
      }
      for (const f of await tx
        .select({ id: s.referenceFoods.id, name: s.referenceFoods.name })
        .from(s.referenceFoods)
        .where(inArray(s.referenceFoods.id, foodIds))) {
        names.set(`f:${f.id}`, f.name);
      }
    }
    if (recipeIds.length > 0) {
      for (const r of await tx
        .select({ id: s.recipes.id, name: s.recipes.name })
        .from(s.recipes)
        .where(and(live(s.recipes, userId), inArray(s.recipes.id, recipeIds)))) {
        names.set(`r:${r.id}`, r.name);
      }
    }
    return rows.map((r) => ({
      id: r.id,
      date: r.localDate,
      time: r.loggedTime,
      meal: r.meal,
      food_id: r.foodId,
      recipe_id: r.recipeId,
      name:
        (r.foodId && names.get(`f:${r.foodId}`)) ||
        (r.recipeId && names.get(`r:${r.recipeId}`)) ||
        (r.foodId || r.recipeId ? 'Deleted food' : QUICK_ADD),
      quantity: r.quantity,
      serving_label: r.servingLabel,
      serving_amount: r.servingAmount,
      kcal: r.kcal,
      protein_g: r.proteinG,
      carb_g: r.carbG,
      fat_g: r.fatG,
      created_at: r.createdAt,
    }));
  }

  private async findFood(tx: Tx, userId: string, id: string): Promise<FoodFacts | null> {
    const [mine] = await tx
      .select()
      .from(s.foods)
      .where(and(live(s.foods, userId), eq(s.foods.id, id)));
    if (mine) return factsOf(mine);
    const [ref] = await tx.select().from(s.referenceFoods).where(eq(s.referenceFoods.id, id));
    return ref ? factsOf(ref) : null;
  }

  private async findRecipe(tx: Tx, userId: string, id: string) {
    const [r] = await tx
      .select()
      .from(s.recipes)
      .where(and(live(s.recipes, userId), eq(s.recipes.id, id)));
    return r ?? null;
  }

  /** The macros an entry gets, snapshotted at log time (never recomputed later). */
  private async snapshot(
    tx: Tx,
    userId: string,
    b: { food_id?: string | null; recipe_id?: string | null; quantity: number },
  ): Promise<Macros> {
    if (b.food_id) {
      const food = await this.findFood(tx, userId, b.food_id);
      if (!food) throw missing('No such food', 'food_not_found');
      return foodMacros(food, b.quantity);
    }
    const recipe = await this.findRecipe(tx, userId, b.recipe_id!);
    if (!recipe) throw missing('No such recipe', 'recipe_not_found');
    return recipeMacros(
      {
        servings: recipe.servings,
        total_kcal: recipe.totalKcal,
        total_protein_g: recipe.totalProteinG,
        total_carb_g: recipe.totalCarbG,
        total_fat_g: recipe.totalFatG,
      },
      b.quantity,
    );
  }

  async createEntry(actor: SyncActor, b: CreateEntryBody): Promise<Entry> {
    const id = randomUUID();
    const row = await this.read(actor, async (tx) => {
      const time = b.time ?? '12:00';
      const quick = b.kcal !== undefined;
      const quantity = b.recipe_id ? (b.quantity ?? 1) : quick ? 1 : b.quantity!;
      const m = quick
        ? { kcal: b.kcal!, protein_g: b.protein_g ?? 0, carb_g: b.carb_g ?? 0, fat_g: b.fat_g ?? 0 }
        : await this.snapshot(tx, actor.userId, { food_id: b.food_id, recipe_id: b.recipe_id, quantity });
      return {
        id,
        local_date: b.date,
        meal: mealForTime(time),
        food_id: b.food_id ?? null,
        recipe_id: b.recipe_id ?? null,
        quantity,
        ...m,
        health_uuid: null,
        created_at: this.now(),
        logged_time: time,
        serving_label: quick ? null : (b.serving_label ?? (b.recipe_id ? 'serving' : null)),
        serving_amount: quick ? null : (b.serving_amount ?? (b.recipe_id ? quantity : null)),
      };
    });
    await this.sync.write(actor, [{ table: 'log_entries', id, op: 'insert', row }]);
    return this.entry(actor, id);
  }

  async entry(actor: SyncActor, id: string): Promise<Entry> {
    return this.read(actor, async (tx) => {
      const [row] = await tx
        .select()
        .from(s.logEntries)
        .where(and(live(s.logEntries, actor.userId), eq(s.logEntries.id, id)));
      if (!row) throw missing('No such entry', 'entry_not_found');
      return (await this.entriesOut(tx, actor.userId, [row]))[0]!;
    });
  }

  async updateEntry(actor: SyncActor, id: string, b: UpdateEntryBody): Promise<Entry> {
    const row = await this.read(actor, async (tx) => {
      const [current] = await tx
        .select()
        .from(s.logEntries)
        .where(and(live(s.logEntries, actor.userId), eq(s.logEntries.id, id)));
      if (!current) throw missing('No such entry', 'entry_not_found');
      const wire = wireRow('log_entries', current);
      const quick = current.foodId == null && current.recipeId == null;
      if (b.date) wire.local_date = b.date;
      if (b.time) {
        wire.logged_time = b.time;
        wire.meal = mealForTime(b.time);
        // The phone rewrites Health with the new time.
        wire.health_uuid = null;
      }
      if (quick) {
        if (b.quantity !== undefined || b.serving_amount !== undefined) {
          throw new AppError(422, 'invalid_change', 'A quick-add entry has no amount; change its macros');
        }
        for (const k of ['kcal', 'protein_g', 'carb_g', 'fat_g'] as const) {
          if (b[k] !== undefined) {
            wire[k] = b[k];
            wire.health_uuid = null;
          }
        }
      } else {
        if (
          b.kcal !== undefined ||
          b.protein_g !== undefined ||
          b.carb_g !== undefined ||
          b.fat_g !== undefined
        ) {
          throw new AppError(422, 'invalid_change', 'Change the amount; macros follow the food');
        }
        // Like the app: the amount can be given in its serving, which keeps
        // the serving's size.
        let quantity = b.quantity;
        if (quantity === undefined && b.serving_amount !== undefined && current.servingAmount) {
          quantity = (b.serving_amount * current.quantity) / current.servingAmount;
        }
        if (quantity !== undefined && quantity !== current.quantity) {
          Object.assign(
            wire,
            await this.snapshot(tx, actor.userId, {
              food_id: current.foodId,
              recipe_id: current.recipeId,
              quantity,
            }),
          );
          wire.quantity = quantity;
          wire.health_uuid = null;
          if (current.servingAmount != null) {
            wire.serving_amount = b.serving_amount ?? (quantity * current.servingAmount) / current.quantity;
          }
        }
      }
      return wire;
    });
    await this.sync.write(actor, [{ table: 'log_entries', id, op: 'update', row }]);
    return this.entry(actor, id);
  }

  async deleteEntry(actor: SyncActor, id: string): Promise<void> {
    await this.entry(actor, id);
    await this.sync.write(actor, [{ table: 'log_entries', id, op: 'delete' }]);
  }

  // ── Foods ──

  async searchFoods(actor: SyncActor, q: string, limit: number): Promise<Food[]> {
    return this.read(actor, async (tx) => {
      const mine = await tx
        .select()
        .from(s.foods)
        .where(and(live(s.foods, actor.userId), termsMatch(q, s.foods.name, s.foods.brand)))
        .orderBy(desc(s.foods.isFavorite), asc(s.foods.name))
        .limit(limit);
      const refs =
        mine.length >= limit
          ? []
          : await tx.select().from(s.referenceFoods).where(termsMatch(q, s.referenceFoods.name)).limit(500);
      // Shorter (more generic) names first, as in the app.
      refs.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
      const out = await this.foodsOut(tx, actor.userId, mine);
      return [...out, ...refs.slice(0, limit - out.length).map((r) => this.refOut(r))];
    });
  }

  private refOut(r: RefRow): Food {
    return {
      id: r.id,
      name: r.name,
      brand: null,
      barcode: null,
      serving_qty: r.servingQty,
      serving_unit: r.servingUnit,
      kcal_per_serving: r.kcalPerServing,
      protein_g: r.proteinG,
      carb_g: r.carbG,
      fat_g: r.fatG,
      fiber_g: r.fiberG,
      source: r.source,
      is_favorite: false,
      reference: true,
      servings: [],
    };
  }

  private async foodsOut(tx: Tx, userId: string, rows: FoodRow[]): Promise<Food[]> {
    const ids = rows.map((r) => r.id);
    const servings =
      ids.length === 0
        ? []
        : await tx
            .select()
            .from(s.foodServings)
            .where(and(live(s.foodServings, userId), inArray(s.foodServings.foodId, ids)))
            .orderBy(asc(s.foodServings.sortOrder));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      brand: r.brand,
      barcode: r.barcode,
      serving_qty: r.servingQty,
      serving_unit: r.servingUnit,
      kcal_per_serving: r.kcalPerServing,
      protein_g: r.proteinG,
      carb_g: r.carbG,
      fat_g: r.fatG,
      fiber_g: r.fiberG,
      source: r.source,
      is_favorite: r.isFavorite === 1,
      reference: false,
      servings: servings
        .filter((sv) => sv.foodId === r.id)
        .map((sv) => ({ id: sv.id, label: sv.label, base_amount: sv.baseAmount })),
    }));
  }

  async food(actor: SyncActor, id: string): Promise<Food> {
    return this.read(actor, async (tx) => {
      const [mine] = await tx
        .select()
        .from(s.foods)
        .where(and(live(s.foods, actor.userId), eq(s.foods.id, id)));
      if (mine) return (await this.foodsOut(tx, actor.userId, [mine]))[0]!;
      const [ref] = await tx.select().from(s.referenceFoods).where(eq(s.referenceFoods.id, id));
      if (!ref) throw missing('No such food', 'food_not_found');
      return this.refOut(ref);
    });
  }

  /** Foods from the most recent entries, newest first. */
  async recentFoods(actor: SyncActor, limit: number): Promise<Food[]> {
    const ids = await this.read(actor, async (tx) => {
      const rows = await tx
        .select({ foodId: s.logEntries.foodId })
        .from(s.logEntries)
        .where(live(s.logEntries, actor.userId))
        .orderBy(desc(s.logEntries.localDate), desc(s.logEntries.createdAt))
        .limit(200);
      return [...new Set(rows.map((r) => r.foodId).filter((x): x is string => x != null))].slice(0, limit);
    });
    const out: Food[] = [];
    for (const id of ids) {
      try {
        out.push(await this.food(actor, id));
      } catch (err) {
        if (!(err instanceof AppError) || err.statusCode !== 404) throw err;
      }
    }
    return out;
  }

  async createFood(actor: SyncActor, b: CreateFoodBody): Promise<Food> {
    const id = randomUUID();
    const writes: ServerWrite[] = [
      {
        table: 'foods',
        id,
        op: 'insert',
        row: {
          id,
          name: b.name,
          brand: b.brand ?? null,
          barcode: b.barcode ?? null,
          serving_qty: b.serving_qty,
          serving_unit: b.serving_unit,
          kcal_per_serving: b.kcal_per_serving,
          protein_g: b.protein_g,
          carb_g: b.carb_g,
          fat_g: b.fat_g,
          fiber_g: b.fiber_g ?? null,
          saturated_fat_g: null,
          trans_fat_g: null,
          cholesterol_mg: null,
          sodium_mg: null,
          sugar_g: null,
          source: 'custom',
          is_favorite: 0,
        },
      },
      ...(b.servings ?? []).map((sv, i): ServerWrite => {
        const sid = randomUUID();
        return {
          table: 'food_servings',
          id: sid,
          op: 'insert',
          row: { id: sid, food_id: id, label: sv.label, base_amount: sv.base_amount, sort_order: i },
        };
      }),
    ];
    await this.sync.write(actor, writes);
    return this.food(actor, id);
  }

  async recipes(actor: SyncActor) {
    return this.read(actor, async (tx) =>
      (
        await tx.select().from(s.recipes).where(live(s.recipes, actor.userId)).orderBy(asc(s.recipes.name))
      ).map((r) => ({
        id: r.id,
        name: r.name,
        servings: r.servings,
        total_weight_g: r.totalWeightG,
        total_kcal: r.totalKcal,
        total_protein_g: r.totalProteinG,
        total_carb_g: r.totalCarbG,
        total_fat_g: r.totalFatG,
      })),
    );
  }

  // ── Weight ──

  async weights(actor: SyncActor, from: string, to: string) {
    return this.read(actor, async (tx) =>
      (
        await tx
          .select()
          .from(s.weightEntries)
          .where(
            and(
              live(s.weightEntries, actor.userId),
              gte(s.weightEntries.localDate, from),
              lte(s.weightEntries.localDate, to),
            ),
          )
          .orderBy(asc(s.weightEntries.localDate), asc(s.weightEntries.createdAt))
      ).map((w) => ({ id: w.id, date: w.localDate, weight_kg: w.weightKg, source: w.source })),
    );
  }

  async addWeight(actor: SyncActor, date: string, weightKg: number) {
    const id = randomUUID();
    await this.sync.write(actor, [
      {
        table: 'weight_entries',
        id,
        op: 'insert',
        row: {
          id,
          local_date: date,
          weight_kg: weightKg,
          source: 'manual',
          health_uuid: null,
          created_at: this.now(),
        },
      },
    ]);
    return { id, date, weight_kg: weightKg, source: 'manual' };
  }

  async deleteWeight(actor: SyncActor, id: string): Promise<void> {
    const found = await this.read(actor, async (tx) =>
      tx
        .select({ id: s.weightEntries.id })
        .from(s.weightEntries)
        .where(and(live(s.weightEntries, actor.userId), eq(s.weightEntries.id, id))),
    );
    if (found.length === 0) throw missing('No such weigh-in', 'weight_not_found');
    await this.sync.write(actor, [{ table: 'weight_entries', id, op: 'delete' }]);
  }

  // ── Profile ──

  async profile(actor: SyncActor) {
    const p = await this.read(actor, async (tx) => {
      const [row] = await tx
        .select()
        .from(s.userProfile)
        .where(and(live(s.userProfile, actor.userId), eq(s.userProfile.id, 'me')));
      return row ?? null;
    });
    return p && this.profileOut(p);
  }

  private profileOut(p: typeof s.userProfile.$inferSelect) {
    return {
      sex: p.sex,
      birth_date: p.birthDate,
      height_cm: p.heightCm,
      activity_seed: p.activitySeed,
      unit_mass: p.unitMass === 'lb' ? ('lb' as const) : ('kg' as const),
      unit_energy: p.unitEnergy === 'kj' ? ('kj' as const) : ('kcal' as const),
    };
  }

  async updateProfile(actor: SyncActor, b: { unit_mass?: 'kg' | 'lb'; unit_energy?: 'kcal' | 'kj' }) {
    const row = await this.read(actor, async (tx) => {
      const [p] = await tx
        .select()
        .from(s.userProfile)
        .where(and(live(s.userProfile, actor.userId), eq(s.userProfile.id, 'me')));
      if (!p) throw missing('Set up a profile in the app first', 'no_profile');
      return { ...wireRow('user_profile', p), ...b };
    });
    await this.sync.write(actor, [{ table: 'user_profile', id: 'me', op: 'update', row }]);
    return (await this.profile(actor))!;
  }

  // ── Status and check-ins ──

  async status(actor: SyncActor, today: string): Promise<Status> {
    return this.read(actor, async (tx) => {
      const acc = await replayAccount(tx, actor.userId, today);
      const todayRows = await tx
        .select()
        .from(s.logEntries)
        .where(and(live(s.logEntries, actor.userId), eq(s.logEntries.localDate, today)));
      const totals = sumMacros(
        todayRows.map((r) => ({ kcal: r.kcal, protein_g: r.proteinG, carb_g: r.carbG, fat_g: r.fatG })),
      );
      const todayTargets = await targetsOn(tx, actor.userId, today);
      const week = await latestWeek(tx, actor.userId);
      const est = acc.replay?.estimate;
      const lastCheckIn = week[0]?.effectiveDate;
      return {
        today,
        profile: acc.profile && this.profileOut(acc.profile),
        estimate: est
          ? {
              trend_weight_kg: est.trendWeightKg,
              expenditure_kcal: est.expenditureKcal,
              expenditure_sd_kcal: est.confidenceBandKcal,
              data_driven: est.isDataDriven,
            }
          : null,
        today_totals: totals,
        today_targets: todayTargets ? targetsOut(todayTargets) : null,
        week: week.length > 0 ? week.map(targetsOut) : null,
        check_in: lastCheckIn
          ? checkInOut(engine.checkInSchedule({ today, lastCheckIn, dow: acc.checkInDow }))
          : null,
        trend: (acc.replay?.days ?? []).slice(-30).map((d) => ({
          date: d.date,
          trend_kg: d.trendKg,
          scale_kg: d.scaleKg,
        })),
      };
    });
  }

  /** What a check-in would set, written nowhere (the app's `previewCheckIn`). */
  async checkInPreview(actor: SyncActor, today: string) {
    return this.read(actor, async (tx) => {
      const { acc, plan } = await this.plan(tx, actor.userId, today);
      const t = engine.toDay(today);
      const days = Array.from({ length: 7 }, (_, i) => engine.fromDay(t - 7 + i));
      const logged = days.map((d) => acc.intakes[d]).filter((k): k is number => k !== undefined);
      const trend = new Map(acc.replay!.days.map((d) => [d.date, d.trendKg]));
      const start = trend.get(engine.fromDay(t - 8));
      const end = trend.get(days[6]!);
      const week = await latestWeek(tx, actor.userId);
      return {
        week: plan.map((p, i) => ({ ...macrosOut(p), effective_date: today, weekday: i + 1 })),
        expenditure_kcal: acc.replay!.estimate.expenditureKcal,
        previous_expenditure_kcal: week[0]?.expenditureEstimate ?? null,
        data_driven: acc.replay!.estimate.isDataDriven,
        trend_kg: acc.replay!.estimate.trendWeightKg,
        trend_change_kg: start === undefined || end === undefined ? null : end - start,
        average_intake_kcal: logged.length === 0 ? null : logged.reduce((a, b) => a + b, 0) / logged.length,
        logged_days: logged.length,
        weigh_ins: days.filter((d) => d in acc.weights).length,
      };
    });
  }

  /** Accepts this week's check-in: the week's targets, effective today. */
  async completeCheckIn(actor: SyncActor, today: string) {
    const writes = await this.read(actor, async (tx) => {
      const { acc, plan } = await this.plan(tx, actor.userId, today);
      const generatedAt = this.now();
      return plan.map((p, i): ServerWrite => {
        const id = targetsId(today, i + 1);
        return {
          table: 'targets',
          id,
          op: 'insert',
          row: {
            id,
            effective_date: today,
            ...macrosOut(p),
            expenditure_estimate: acc.replay!.estimate.expenditureKcal,
            generated_at: generatedAt,
            reason: 'check_in',
            weekday: i + 1,
          },
        };
      });
    });
    await this.sync.write(actor, writes);
    return this.status(actor, today);
  }

  private async plan(tx: Tx, userId: string, today: string) {
    const acc = await replayAccount(tx, userId, today);
    if (!acc.replay) throw new AppError(409, 'no_data', 'Needs a profile and a weigh-in first');
    const program = await activeProgram(tx, userId, acc.profile?.sex ?? null);
    if (!program) throw new AppError(409, 'no_program', 'Set up a program in the app first');
    return { acc, plan: engine.computeWeekPlan(acc.replay.state, program) };
  }
}

const macrosOut = (t: engine.EngineTargets) => ({
  kcal: t.kcal,
  protein_g: t.proteinG,
  carb_g: t.carbG,
  fat_g: t.fatG,
});

const checkInOut = (c: engine.CheckInStatus) => ({
  last_check_in: c.lastCheckIn,
  next_check_in: c.nextCheckIn,
  is_due: c.isDue,
  days_until: c.daysUntil,
  can_check_in_early: c.canCheckInEarly,
});
