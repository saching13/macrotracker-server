/**
 * Ports of `mifflin_seed.dart` and `program_codes.dart`: the seed TDEE and
 * the engine's view of a stored `programs` row.
 */
import type {
  CalorieFloor,
  DayPlan,
  MacroStyle,
  Program,
  ProgramStyle,
  ProteinLevel,
  Training,
} from './models.js';

/** Activity multipliers for the Mifflin-St Jeor seed, keyed by `user_profile.activity_seed`. */
export const ACTIVITY_MULTIPLIERS: Record<string, number> = {
  sedentary: 1.2,
  lightly_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
};

/** Estimated TDEE in kcal/day, used until logged data can take over. */
export function mifflinSeedTdee(a: {
  sex: string;
  ageYears: number;
  heightCm: number;
  weightKg: number;
  activitySeed: string;
}): number {
  const base = 10 * a.weightKg + 6.25 * a.heightCm - 5 * a.ageYears;
  // 'other' (prefer not to say): midway between the two equations.
  const bmr = a.sex === 'male' ? base + 5 : a.sex === 'female' ? base - 161 : base - 78;
  return bmr * (ACTIVITY_MULTIPLIERS[a.activitySeed] ?? 1.375);
}

/** Coached calorie floor by sex. */
export function calorieFloorFor(sex: string | null | undefined): number {
  return sex === 'male' ? 1500 : 1200;
}

/** The `programs` columns the engine reads (snake_case, as synced). */
export interface ProgramCodes {
  id: string;
  goal_type: string;
  rate_value: number;
  rate_unit: string;
  diet_style: string;
  protein_policy: string;
  custom_protein_pct?: number | null;
  custom_carb_pct?: number | null;
  custom_fat_pct?: number | null;
  program_style?: string | null;
  macro_style?: string | null;
  protein_level?: string | null;
  day_plan?: string | null;
  calorie_floor?: string | null;
  training?: string | null;
}

const PROGRAM_STYLES: Record<string, ProgramStyle> = { collaborative: 'collaborative', manual: 'manual' };
const MACRO_STYLES: Record<string, MacroStyle> = {
  balanced: 'balanced',
  high_carb: 'highCarb',
  low_carb: 'lowCarb',
  keto: 'keto',
  custom: 'custom',
};
const PROTEIN_LEVELS: Record<string, ProteinLevel> = { low: 'low', high: 'high', very_high: 'veryHigh' };
const CALORIE_FLOORS: Record<string, CalorieFloor> = { low: 'low', none: 'none' };
const TRAININGS: Record<string, Training> = { cardio: 'cardio', lifting: 'lifting', both: 'both' };

const pick = <T>(table: Record<string, T>, code: string | null | undefined, fallback: T): T =>
  code != null && Object.hasOwn(table, code) ? table[code]! : fallback;

/**
 * The engine's view of a stored program. `sex` sets the standard floor;
 * `maintainTargetKg` is the maintenance goal's target trend weight.
 */
export function programFromCodes(
  c: ProgramCodes,
  ctx: { sex?: string | null; maintainTargetKg?: number | null } = {},
): Program {
  return {
    id: c.id,
    goalType: c.goal_type,
    rateValue: c.rate_value,
    rateUnit: c.rate_unit,
    dietStyle: c.diet_style,
    proteinPolicy: c.protein_policy,
    customProteinPct: c.custom_protein_pct ?? null,
    customCarbPct: c.custom_carb_pct ?? null,
    customFatPct: c.custom_fat_pct ?? null,
    style: pick(PROGRAM_STYLES, c.program_style, 'coached'),
    macroStyle: pick<MacroStyle | null>(MACRO_STYLES, c.macro_style, null),
    proteinLevel: pick(PROTEIN_LEVELS, c.protein_level, 'moderate'),
    dayPlans: decodeDayPlans(c.day_plan ?? null),
    calorieFloorKcal: calorieFloorFor(ctx.sex),
    calorieFloor: pick(CALORIE_FLOORS, c.calorie_floor, 'standard'),
    training: pick(TRAININGS, c.training, 'none'),
    maintainTargetKg: c.goal_type === 'maintain' ? (ctx.maintainTargetKg ?? null) : null,
  };
}

interface StoredDay {
  share?: number;
  carb?: number;
  fixed?: { kcal: number; p: number; c: number; f: number } | null;
}

/** `[{ "share": 1.0, "carb": 0.5, "fixed": {"kcal":…,"p":…,"c":…,"f":…} }, …]`; null unless 7 days. */
export function decodeDayPlans(json: string | null): DayPlan[] | null {
  if (json === null) return null;
  const list = JSON.parse(json) as StoredDay[];
  if (!Array.isArray(list) || list.length !== 7) return null;
  return list.map((raw) => ({
    calorieShare: raw.share ?? 1,
    carbShare: raw.carb ?? 0.5,
    fixed:
      raw.fixed == null
        ? null
        : {
            kcal: raw.fixed.kcal,
            proteinG: raw.fixed.p,
            carbG: raw.fixed.c,
            fatG: raw.fixed.f,
            effectiveDate: null,
          },
  }));
}

export function encodeDayPlans(days: readonly DayPlan[]): string {
  return JSON.stringify(
    days.map((d) => ({
      share: d.calorieShare,
      carb: d.carbShare,
      ...(d.fixed && {
        fixed: { kcal: d.fixed.kcal, p: d.fixed.proteinG, c: d.fixed.carbG, f: d.fixed.fatG },
      }),
    })),
  );
}
