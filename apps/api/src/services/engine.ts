import { createHash } from 'node:crypto';
import { engine } from '@macrotracker/shared';
import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';

/** RFC 4122 name-based (SHA-1) UUID, as Dart's `Uuid().v5`. */
export function uuidv5(name: string, namespace: string): string {
  const h = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** The RFC 4122 URL namespace, which the app uses for targets ids. */
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/**
 * The id of `effectiveDate`'s targets row for `weekday`, as the app makes it
 * (`EngineOrchestrator.targetsId`): a check-in done on the web and one done
 * on a phone the same day write the same rows.
 */
export const targetsId = (effectiveDate: string, weekday: number) =>
  uuidv5(`macrotracker:targets:${effectiveDate}:${weekday}`, URL_NAMESPACE);

export type TargetsRow = typeof s.targets.$inferSelect;

export interface AccountEngine {
  profile: typeof s.userProfile.$inferSelect | null;
  replay: engine.EngineReplay | null;
  weights: Record<string, number>;
  intakes: Record<string, number>;
  partialDays: Set<string>;
  /** Check-in weekday, 0 = Monday. */
  checkInDow: number;
}

/** The account's rows that aren't tombstones. */
export const live = (t: { userId: PgColumn; deletedAt: PgColumn }, userId: string) =>
  and(eq(t.userId, userId), isNull(t.deletedAt));

/**
 * Runs the account's history through the TypeScript engine, the way the
 * app's `EngineOrchestrator.recompute` does on the phone: a full replay from
 * the first weigh-in, with today's intake and partial days left out. Cheap
 * (a year is ~365 small steps), and always consistent with edits.
 */
export async function replayAccount(tx: Tx, userId: string, today: string): Promise<AccountEngine> {
  const [profile] = await tx
    .select()
    .from(s.userProfile)
    .where(and(live(s.userProfile, userId), eq(s.userProfile.id, 'me')));
  const weightRows = await tx
    .select({ date: s.weightEntries.localDate, kg: sql<number>`avg(${s.weightEntries.weightKg})::float8` })
    .from(s.weightEntries)
    .where(live(s.weightEntries, userId))
    .groupBy(s.weightEntries.localDate);
  const intakeRows = await tx
    .select({ date: s.logEntries.localDate, kcal: sql<number>`sum(${s.logEntries.kcal})::float8` })
    .from(s.logEntries)
    .where(live(s.logEntries, userId))
    .groupBy(s.logEntries.localDate);
  const meta = await tx.select().from(s.userMeta).where(live(s.userMeta, userId));
  const metaValue = (key: string) => meta.find((m) => m.key === key)?.value;

  const weights = Object.fromEntries(weightRows.map((r) => [r.date, Number(r.kg)]));
  const intakes = Object.fromEntries(intakeRows.map((r) => [r.date, Number(r.kcal)]));
  let partialDays = new Set<string>();
  try {
    const parsed = JSON.parse(metaValue('partial_days') ?? '[]') as unknown;
    if (Array.isArray(parsed))
      partialDays = new Set(parsed.filter((d): d is string => typeof d === 'string'));
  } catch {
    // A malformed value counts as none.
  }
  const dow = Number.parseInt(metaValue('targets_update_dow') ?? '', 10);

  const replay =
    profile == null
      ? null
      : engine.replayHistory({
          profile: {
            sex: profile.sex,
            birthDate: profile.birthDate,
            heightCm: profile.heightCm,
            activitySeed: profile.activitySeed,
          },
          weights,
          intakes,
          partialDays,
          today,
        });
  return {
    profile: profile ?? null,
    replay,
    weights,
    intakes,
    partialDays,
    checkInDow: Number.isInteger(dow) && dow >= 0 && dow <= 6 ? dow : 0,
  };
}

/** The active program as the engine sees it (with the goal's target weight), or null. */
export async function activeProgram(
  tx: Tx,
  userId: string,
  sex: string | null,
): Promise<engine.Program | null> {
  const [p] = await tx
    .select()
    .from(s.programs)
    .where(and(live(s.programs, userId), eq(s.programs.active, 1)))
    .orderBy(desc(s.programs.startedAt))
    .limit(1);
  if (!p) return null;
  let maintainTargetKg: number | null = null;
  if (p.goalId) {
    const [g] = await tx
      .select({ target: s.goals.targetWeightKg })
      .from(s.goals)
      .where(and(live(s.goals, userId), eq(s.goals.id, p.goalId)));
    maintainTargetKg = g?.target ?? null;
  }
  return engine.programFromCodes(
    {
      id: p.id,
      goal_type: p.goalType,
      rate_value: p.rateValue,
      rate_unit: p.rateUnit,
      diet_style: p.dietStyle,
      protein_policy: p.proteinPolicy,
      custom_protein_pct: p.customProteinPct,
      custom_carb_pct: p.customCarbPct,
      custom_fat_pct: p.customFatPct,
      program_style: p.programStyle,
      macro_style: p.macroStyle,
      protein_level: p.proteinLevel,
      day_plan: p.dayPlan,
      calorie_floor: p.calorieFloor,
      training: p.training,
    },
    { sex, maintainTargetKg },
  );
}

/** The newest targets rows: the latest effective date, Monday first. */
export async function latestWeek(tx: Tx, userId: string): Promise<TargetsRow[]> {
  const [latest] = await tx
    .select({ date: s.targets.effectiveDate })
    .from(s.targets)
    .where(live(s.targets, userId))
    .orderBy(desc(s.targets.effectiveDate), desc(s.targets.generatedAt))
    .limit(1);
  if (!latest) return [];
  return tx
    .select()
    .from(s.targets)
    .where(and(live(s.targets, userId), eq(s.targets.effectiveDate, latest.date)))
    .orderBy(asc(s.targets.weekday), desc(s.targets.generatedAt));
}

/**
 * Targets in effect on `localDate`: the latest effective date on or before
 * it, among rows for that weekday or for every day (the app's `targetsFor`).
 */
export async function targetsOn(tx: Tx, userId: string, localDate: string): Promise<TargetsRow | null> {
  const weekday = engine.weekdayOf(engine.toDay(localDate));
  const [row] = await tx
    .select()
    .from(s.targets)
    .where(
      and(
        live(s.targets, userId),
        lte(s.targets.effectiveDate, localDate),
        sql`(${s.targets.weekday} is null or ${s.targets.weekday} = ${weekday})`,
      ),
    )
    .orderBy(desc(s.targets.effectiveDate), desc(s.targets.generatedAt))
    .limit(1);
  return row ?? null;
}
