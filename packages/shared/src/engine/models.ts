/**
 * Port of the app's `lib/core/engine/models.dart`. Field names follow the
 * Dart classes; dates are `YYYY-MM-DD` local calendar days.
 */

export interface DailyObservation {
  localDate: string;
  scaleWeightKg: number | null;
  intakeKcal: number | null;
}

/**
 * Kalman filter state over (true body weight, TDEE): the expenditure
 * estimator. `p*` is the 2×2 covariance (symmetric, so three entries).
 */
export interface ExpenditureFilter {
  weightKg: number;
  kcal: number;
  pWW: number;
  pWE: number;
  pEE: number;
}

export interface EngineState {
  trendWeightKg: number;
  trendVariance: number;
  seedExpenditureKcal: number;
  expenditureKcal: number | null;
  daysIngested: number;
  weighInsInWindow: number;
  loggedDaysInWindow: number;
  lastUpdated: string | null;
  /** Observations from the rolling window (last 14 days), oldest first. */
  recentObservations: DailyObservation[];
  /** Trend weight after ingesting each of `recentObservations`. */
  recentTrendKg: number[];
  /** Null until the first weigh-in. */
  filter: ExpenditureFilter | null;
}

export function initialState(seedExpenditureKcal: number): EngineState {
  return {
    trendWeightKg: 0,
    trendVariance: 0,
    seedExpenditureKcal,
    expenditureKcal: null,
    daysIngested: 0,
    weighInsInWindow: 0,
    loggedDaysInWindow: 0,
    lastUpdated: null,
    recentObservations: [],
    recentTrendKg: [],
    filter: null,
  };
}

/** False until the first weigh-in initializes the trend. */
export const hasTrend = (s: EngineState) => s.trendWeightKg > 0;

export interface Estimate {
  trendWeightKg: number;
  expenditureKcal: number;
  confidenceBandKcal: number;
  isDataDriven: boolean;
}

export interface EngineTargets {
  kcal: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  effectiveDate: string | null;
}

/** How targets are produced (MacroFactor's program styles). */
export type ProgramStyle = 'coached' | 'collaborative' | 'manual';

/** How non-protein calories are split between carbs and fat. */
export type MacroStyle = 'balanced' | 'highCarb' | 'lowCarb' | 'keto' | 'custom';

/** Daily protein, in g per kg of trend weight. */
export const PROTEIN_LEVEL_G_PER_KG = { low: 1.4, moderate: 1.8, high: 2.2, veryHigh: 2.6 } as const;
export type ProteinLevel = keyof typeof PROTEIN_LEVEL_G_PER_KG;

/** Coached safeguard: how low daily calories may go. */
export type CalorieFloor = 'standard' | 'low' | 'none';

/** The exercise habits a program is built for; added to the protein level. */
export const TRAINING_PROTEIN_ADJUST_G_PER_KG = { none: 0, cardio: 0.1, lifting: 0.2, both: 0.2 } as const;
export type Training = keyof typeof TRAINING_PROTEIN_ADJUST_G_PER_KG;

/** One weekday in a program's plan. */
export interface DayPlan {
  /** Relative calories for the day (1 = average). */
  calorieShare: number;
  /** Collaborative: share of non-protein calories from carbs, 0–1. */
  carbShare: number;
  /** Manual: the day's targets as entered. */
  fixed: EngineTargets | null;
}

/** Seven days of targets, Monday first. */
export type WeekPlan = EngineTargets[];

export interface Program {
  id: string;
  goalType: string;
  rateValue: number;
  rateUnit: string;
  dietStyle: string;
  proteinPolicy: string;
  customProteinPct: number | null;
  customCarbPct: number | null;
  customFatPct: number | null;
  style: ProgramStyle;
  /** Null: derived from `dietStyle` (older programs). */
  macroStyle: MacroStyle | null;
  proteinLevel: ProteinLevel;
  /** Monday first, 7 entries; null = every day the same. */
  dayPlans: DayPlan[] | null;
  calorieFloorKcal: number;
  calorieFloor: CalorieFloor;
  training: Training;
  /** Maintenance goals: the trend weight to hold. */
  maintainTargetKg: number | null;
}

export function hasCustomSplit(p: Program): boolean {
  return (
    p.customProteinPct !== null &&
    p.customCarbPct !== null &&
    p.customFatPct !== null &&
    p.customProteinPct + p.customCarbPct + p.customFatPct === 100
  );
}

/** `macroStyle`, or the equivalent of an older `dietStyle`. */
export function effectiveMacroStyle(p: Program): MacroStyle {
  if (p.macroStyle !== null) return p.macroStyle;
  if (p.dietStyle === 'keto') return 'keto';
  if (p.dietStyle === 'custom' && hasCustomSplit(p)) return 'custom';
  return 'balanced';
}
