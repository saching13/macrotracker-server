/**
 * Port of the app's `lib/core/engine/adaptive_coach_engine.dart`: an EWMA
 * trend weight for display and a Kalman filter over (true weight, TDEE) for
 * expenditure. Keep it in step with the Dart engine: the golden vectors in
 * fixtures/engine/ (written by the app) must reproduce exactly, so arithmetic
 * follows the Dart code operation for operation.
 */
import { toDay } from './local-date.js';
import {
  type CalorieFloor,
  type DailyObservation,
  type EngineState,
  type EngineTargets,
  type Estimate,
  type ExpenditureFilter,
  type MacroStyle,
  type Program,
  type WeekPlan,
  effectiveMacroStyle,
  hasCustomSplit,
  PROTEIN_LEVEL_G_PER_KG,
  TRAINING_PROTEIN_ADJUST_G_PER_KG,
} from './models.js';

/** EWMA smoothing factor for trend weight (≈10-day time constant). */
export const TREND_ALPHA = 0.1;
/** Energy per kg of body-mass change. Fixed for v1. */
export const KCAL_PER_KG = 7700;
/** Rolling window for data-sufficiency counts and imputing missing intake. */
export const WINDOW_DAYS = 14;

// Expenditure filter tuning (see the Dart constants for what each means).
export const SCALE_NOISE_KG = 0.5;
export const TDEE_DRIFT_KCAL = 25;
export const INTAKE_NOISE_KCAL = 150;
export const UNLOGGED_INTAKE_KCAL = 400;
export const SEED_UNCERTAINTY_KCAL = 350;

/**
 * Pause rule: expenditure only updates while at least 4 of the last 7 days
 * have intake logged; otherwise it holds and the filter's weight follows the
 * scale.
 */
export const PAUSE_WINDOW_DAYS = 7;
export const MIN_LOGGED_DAYS_TO_UPDATE = 4;

export const PARTIAL_FRACTION = 0.5;
export const PARTIAL_FLOOR_KCAL = 500;
export const PARTIAL_MIN_HISTORY = 3;

/** True when `intakeKcal` looks like a partly logged day given recent complete days. */
export function isPartialDay(intakeKcal: number, recent: readonly number[]): boolean {
  if (recent.length < PARTIAL_MIN_HISTORY) return intakeKcal < PARTIAL_FLOOR_KCAL;
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = Math.trunc(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return intakeKcal < PARTIAL_FRACTION * median;
}

export const MIN_WEIGH_INS_IN_WINDOW = 4;
export const MIN_LOGGED_DAYS_IN_WINDOW = 7;
export const MIN_TARGET_KCAL = 1200;
export const PROTEIN_G_PER_KG = 2.0;
export const MIN_FAT_G_PER_KG = 0.5;
export const KETO_CARB_CAP_G = 30;
export const LOW_CARB_MAX_SHARE = 0.3;
export const LOW_CARB_CAP_G = 200;
export const LOW_FLOOR_PROTEIN_G_PER_KG = 0.8;
export const LOW_FLOOR_CARB_G = 130;
export const MAINTAIN_BAND_SHARE = 0.009;
export const MAINTAIN_CORRECTION_SHARE = 0.0015;
export const MIN_PROTEIN_G_PER_KG = 1.2;

const CARB_SHARE_BY_STYLE: Partial<Record<MacroStyle, number>> = {
  balanced: 0.5,
  highCarb: 0.65,
  lowCarb: 0.3,
};

/** The band around a maintenance target. */
export function maintenanceRange(targetKg: number): { low: number; high: number } {
  return { low: targetKg * (1 - MAINTAIN_BAND_SHARE), high: targetKg * (1 + MAINTAIN_BAND_SHARE) };
}

/** -1 (slow loss) above the band, +1 (slow gain) below it, 0 inside. */
export function maintenanceDirection(trendKg: number, targetKg: number): number {
  const r = maintenanceRange(targetKg);
  return trendKg > r.high ? -1 : trendKg < r.low ? 1 : 0;
}

/** The individual "low" calorie floor for `weightKg`. */
export function lowFloorKcal(weightKg: number): number {
  return (LOW_FLOOR_PROTEIN_G_PER_KG * 4 + MIN_FAT_G_PER_KG * 9) * weightKg + LOW_FLOOR_CARB_G * 4;
}

/** Dart's `roundToDouble`: halves round away from zero. */
export function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

export function ingest(prior: EngineState, obs: DailyObservation): EngineState {
  // Trend weight (EWMA).
  let trend = prior.trendWeightKg;
  let variance = prior.trendVariance;
  const w = obs.scaleWeightKg;
  if (w !== null) {
    if (!(prior.trendWeightKg > 0)) {
      trend = w;
      variance = 0;
    } else {
      const residual = w - trend;
      trend = TREND_ALPHA * w + (1 - TREND_ALPHA) * trend;
      variance = (1 - TREND_ALPHA) * (variance + TREND_ALPHA * residual * residual);
    }
  }

  // Rolling window (last WINDOW_DAYS calendar days, incl. today).
  const today = toDay(obs.localDate);
  const cutoff = today - WINDOW_DAYS;
  const observations: DailyObservation[] = [];
  const trends: number[] = [];
  prior.recentObservations.forEach((o, i) => {
    if (toDay(o.localDate) > cutoff) {
      observations.push(o);
      trends.push(prior.recentTrendKg[i]!);
    }
  });
  observations.push(obs);
  trends.push(trend);

  const weighIns = observations.filter((o) => o.scaleWeightKg !== null).length;
  const logged = observations.filter((o) => o.intakeKcal !== null).length;
  const daysIngested = prior.daysIngested + 1;

  // Expenditure: morning weight on day t reflects intake through day t−1, so
  // predict across each elapsed day with that day's intake, then correct
  // with today's weigh-in.
  const loggedThisWeek = observations.filter(
    (o) => o.intakeKcal !== null && toDay(o.localDate) > today - PAUSE_WINDOW_DAYS,
  ).length;
  const paused = loggedThisWeek < MIN_LOGGED_DAYS_TO_UPDATE;

  let filter = prior.filter;
  if (filter !== null && paused) {
    // Hold expenditure; keep the weight state on the scale.
    filter = {
      weightKg: w ?? filter.weightKg,
      kcal: filter.kcal,
      pWW: w === null ? filter.pWW : SCALE_NOISE_KG * SCALE_NOISE_KG,
      pWE: 0,
      pEE: filter.pEE,
    };
  } else if (filter !== null && prior.lastUpdated !== null) {
    const elapsed = today - toDay(prior.lastUpdated);
    const last = prior.recentObservations.at(-1);
    const lastIntake = last === undefined ? null : last.intakeKcal;
    const fallbackIntake = meanIntake(prior.recentObservations);
    for (let d = 0; d < elapsed; d++) {
      filter = predict(filter, d === 0 ? lastIntake : null, fallbackIntake);
    }
  }
  if (w !== null && !(paused && filter !== null)) {
    filter =
      filter === null
        ? {
            weightKg: w,
            kcal: prior.seedExpenditureKcal,
            pWW: SCALE_NOISE_KG * SCALE_NOISE_KG,
            pWE: 0,
            pEE: SEED_UNCERTAINTY_KCAL * SEED_UNCERTAINTY_KCAL,
          }
        : update(filter, w);
  }

  // Report an estimate once the window has had enough data at least once.
  const enoughData = weighIns >= MIN_WEIGH_INS_IN_WINDOW && logged >= MIN_LOGGED_DAYS_IN_WINDOW;
  const expenditure = filter !== null && (enoughData || prior.expenditureKcal !== null) ? filter.kcal : null;

  return {
    trendWeightKg: trend,
    trendVariance: variance,
    seedExpenditureKcal: prior.seedExpenditureKcal,
    expenditureKcal: expenditure,
    daysIngested,
    weighInsInWindow: weighIns,
    loggedDaysInWindow: logged,
    lastUpdated: obs.localDate,
    recentObservations: observations,
    recentTrendKg: trends,
    filter,
  };
}

function predict(
  f: ExpenditureFilter,
  intake: number | null,
  fallbackIntake: number | null,
): ExpenditureFilter {
  // Unlogged day: assume the recent average (or maintenance) with extra uncertainty.
  const u = intake ?? fallbackIntake ?? f.kcal;
  const uSigma = intake !== null ? INTAKE_NOISE_KCAL : UNLOGGED_INTAKE_KCAL;
  // x' = F x + B u with F = [[1, −1/K], [0, 1]], B = [1/K, 0].
  const k = 1 / KCAL_PER_KG;
  const weight = f.weightKg + (u - f.kcal) * k;
  // P' = F P Fᵀ + Q
  const pWW = f.pWW - 2 * k * f.pWE + k * k * f.pEE + uSigma * k * (uSigma * k);
  const pWE = f.pWE - k * f.pEE;
  const pEE = f.pEE + TDEE_DRIFT_KCAL * TDEE_DRIFT_KCAL;
  return { weightKg: weight, kcal: f.kcal, pWW, pWE, pEE };
}

function update(f: ExpenditureFilter, scaleKg: number): ExpenditureFilter {
  // Observe weight only: H = [1, 0].
  const s = f.pWW + SCALE_NOISE_KG * SCALE_NOISE_KG;
  const kW = f.pWW / s;
  const kE = f.pWE / s;
  const residual = scaleKg - f.weightKg;
  return {
    weightKg: f.weightKg + kW * residual,
    kcal: f.kcal + kE * residual,
    pWW: (1 - kW) * f.pWW,
    pWE: (1 - kW) * f.pWE,
    pEE: f.pEE - kE * f.pWE,
  };
}

function meanIntake(obs: readonly DailyObservation[]): number | null {
  const xs = obs.map((o) => o.intakeKcal).filter((x): x is number => x !== null);
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b) / xs.length;
}

export function currentEstimate(state: EngineState): Estimate {
  return {
    trendWeightKg: state.trendWeightKg,
    expenditureKcal: state.expenditureKcal ?? state.seedExpenditureKcal,
    // 1σ of the filter's TDEE estimate (seed uncertainty before that).
    confidenceBandKcal: state.filter === null ? SEED_UNCERTAINTY_KCAL : Math.sqrt(state.filter.pEE),
    isDataDriven: state.expenditureKcal !== null && state.daysIngested >= 2 * WINDOW_DAYS,
  };
}

/** The week's targets (Monday first): a weekly budget shaped by the day plan and macro style. */
export function computeWeekPlan(state: EngineState, program: Program): WeekPlan {
  const weight = state.trendWeightKg;
  const plans = program.dayPlans?.length === 7 ? program.dayPlans : null;

  // Manual: the user's own numbers, untouched.
  if (program.style === 'manual' && plans !== null && plans.every((d) => d.fixed !== null)) {
    return plans.map((d) => d.fixed!);
  }

  // Weekly budget = 7 × (expenditure ± the goal's daily change).
  const average = dailyBudget(state, program);
  const coached = program.style === 'coached';
  const floor = !coached ? 0 : floorKcal(program.calorieFloor, program.calorieFloorKcal, weight);
  const avgKcal = Math.max(average, floor);

  // Spread by the day plan, keeping the week's total.
  const shares = Array.from({ length: 7 }, (_, i) => (plans === null ? 1 : plans[i]!.calorieShare));
  const sum = shares.reduce((a, b) => a + b, 0);
  let kcal = shares.map((s) => (avgKcal * 7 * s) / sum);
  if (coached) kcal = applyFloor(kcal, floor);

  const protein =
    program.style === 'coached' || program.style === 'collaborative'
      ? Math.max(
          PROTEIN_LEVEL_G_PER_KG[program.proteinLevel] + TRAINING_PROTEIN_ADJUST_G_PER_KG[program.training],
          MIN_PROTEIN_G_PER_KG,
        ) * weight
      : PROTEIN_G_PER_KG * weight;
  const style = effectiveMacroStyle(program);

  return kcal.map((k, i) =>
    dayTargets({
      kcal: k,
      proteinG: protein,
      style,
      carbShare: program.style === 'collaborative' && plans !== null ? plans[i]!.carbShare : null,
      minFatG: coached ? MIN_FAT_G_PER_KG * weight : 0,
      program,
      effectiveDate: state.lastUpdated,
    }),
  );
}

function floorKcal(kind: CalorieFloor, standardKcal: number, weightKg: number): number {
  switch (kind) {
    case 'standard':
      return standardKcal;
    case 'low':
      return lowFloorKcal(weightKg);
    case 'none':
      return 0;
  }
}

function dailyBudget(state: EngineState, program: Program): number {
  const e = state.expenditureKcal ?? state.seedExpenditureKcal;
  const target = program.maintainTargetKg;
  if (program.goalType === 'maintain' && target !== null) {
    const move = maintenanceDirection(state.trendWeightKg, target);
    return e + (move * MAINTAIN_CORRECTION_SHARE * state.trendWeightKg * KCAL_PER_KG) / 7;
  }
  return e + goalDelta(state, program);
}

/** The goal's daily calorie change: sign × kg per week × 7700 / 7. */
function goalDelta(state: EngineState, program: Program): number {
  const sign = program.goalType === 'lose' ? -1 : program.goalType === 'gain' ? 1 : 0;
  const kgPerWeek =
    program.rateUnit === 'pct_per_week' ? (program.rateValue / 100) * state.trendWeightKg : program.rateValue;
  return (sign * kgPerWeek * KCAL_PER_KG) / 7;
}

/**
 * Raises days below `floor` to it, taking the difference from the days above
 * it so the week's total is unchanged (when that's possible).
 */
function applyFloor(kcal: readonly number[], floor: number): number[] {
  const out = [...kcal];
  for (let pass = 0; pass < 7; pass++) {
    const short = out.reduce((a, k) => a + Math.max(floor - k, 0), 0);
    if (short <= 0) break;
    const spare = out.reduce((a, k) => a + Math.max(k - floor, 0), 0);
    for (let i = 0; i < 7; i++) {
      if (out[i]! < floor) {
        out[i] = floor;
      } else if (spare > 0) {
        out[i] = out[i]! - ((out[i]! - floor) / spare) * Math.min(short, spare);
      }
    }
  }
  return out;
}

function dayTargets(a: {
  kcal: number;
  proteinG: number;
  style: MacroStyle;
  carbShare: number | null;
  minFatG: number;
  program: Program;
  effectiveDate: string | null;
}): EngineTargets {
  const { kcal, style, carbShare, program } = a;
  let protein = a.proteinG;
  let carb: number;
  let fat: number;
  if (style === 'custom' && hasCustomSplit(program)) {
    protein = ((program.customProteinPct! / 100) * kcal) / 4;
    carb = ((program.customCarbPct! / 100) * kcal) / 4;
    fat = ((program.customFatPct! / 100) * kcal) / 9;
  } else {
    // Protein first (capped so it can't exceed the day), then the rest.
    protein = Math.min(protein, (kcal * 0.6) / 4);
    const rest = kcal - protein * 4;
    if (style === 'keto' && carbShare === null) {
      carb = Math.min(KETO_CARB_CAP_G, rest / 4);
      fat = (rest - carb * 4) / 9;
    } else {
      const share = carbShare ?? CARB_SHARE_BY_STYLE[style] ?? 0.5;
      carb = (rest * share) / 4;
      if (style === 'lowCarb' && carbShare === null) {
        carb = Math.min(carb, Math.min((LOW_CARB_MAX_SHARE * kcal) / 4, LOW_CARB_CAP_G));
      }
      fat = (rest - carb * 4) / 9;
    }
    // Coached safeguard: fat minimum, taken from carbs.
    if (fat < a.minFatG) {
      const need = (a.minFatG - fat) * 9;
      fat = a.minFatG;
      carb = Math.max(carb - need / 4, 0);
    }
  }
  return {
    kcal: roundHalfAway(kcal),
    proteinG: roundHalfAway(protein),
    carbG: roundHalfAway(Math.max(carb, 0)),
    fatG: roundHalfAway(Math.max(fat, 0)),
    effectiveDate: a.effectiveDate,
  };
}

/** Older single-day targets from `dietStyle` (programs before week plans). */
export function computeTargets(state: EngineState, program: Program): EngineTargets {
  const e = state.expenditureKcal ?? state.seedExpenditureKcal;
  const kcal = Math.max(e + goalDelta(state, program), MIN_TARGET_KCAL);

  const policyProtein = PROTEIN_G_PER_KG * state.trendWeightKg;
  let protein: number;
  let fat: number;
  let carb: number;
  if (program.dietStyle === 'high_protein') {
    protein = policyProtein;
    fat = (0.25 * kcal) / 9;
    carb = (kcal - protein * 4 - fat * 9) / 4;
  } else if (program.dietStyle === 'keto') {
    protein = policyProtein;
    carb = 20;
    fat = (kcal - protein * 4 - carb * 4) / 9;
  } else if (program.dietStyle === 'custom' && hasCustomSplit(program)) {
    protein = ((program.customProteinPct! / 100) * kcal) / 4;
    fat = ((program.customFatPct! / 100) * kcal) / 9;
    carb = ((program.customCarbPct! / 100) * kcal) / 4;
  } else {
    // Balanced (also an incomplete custom split).
    protein = (0.3 * kcal) / 4;
    fat = (0.3 * kcal) / 9;
    carb = (kcal - protein * 4 - fat * 9) / 4;
  }
  return {
    kcal: roundHalfAway(kcal),
    proteinG: roundHalfAway(protein),
    carbG: roundHalfAway(Math.max(carb, 0)),
    fatG: roundHalfAway(Math.max(fat, 0)),
    effectiveDate: state.lastUpdated,
  };
}
