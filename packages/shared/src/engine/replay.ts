/** Port of `replay.dart`: the full-history replay the app's orchestrator runs. */
import { currentEstimate, ingest } from './adaptive.js';
import { fromDay, isoMidnight, toDay } from './local-date.js';
import { type EngineState, type Estimate, hasTrend, initialState } from './models.js';
import { mifflinSeedTdee } from './program.js';

/** The profile fields the engine needs. */
export interface EngineProfile {
  sex: string;
  /** `YYYY-MM-DD`. */
  birthDate: string;
  heightCm: number;
  activitySeed: string;
}

/** One replayed day (from the first weigh-in on). */
export interface ReplayDay {
  date: string;
  /** Average of that day's weigh-ins; null on days without one. */
  scaleKg: number | null;
  trendKg: number;
  /** 1σ of scale readings around the trend. */
  trendSdKg: number;
  expenditureKcal: number;
  /** 1σ of the expenditure estimate. */
  expenditureSdKcal: number;
  /** False while the estimate still leans on the formula seed. */
  dataDriven: boolean;
}

export interface EngineReplay {
  state: EngineState;
  estimate: Estimate;
  days: ReplayDay[];
}

/**
 * Replays the full history from the first weigh-in through `today`.
 * `weights`: average weigh-in per `YYYY-MM-DD`; `intakes`: logged kcal per
 * day. Today's intake and `partialDays` count as unlogged. Null without a
 * weigh-in.
 */
export function replayHistory(a: {
  profile: EngineProfile;
  weights: Readonly<Record<string, number>>;
  intakes: Readonly<Record<string, number>>;
  partialDays: ReadonlySet<string>;
  today: string;
}): EngineReplay | null {
  const keys = Object.keys(a.weights);
  if (keys.length === 0) return null;
  const today = toDay(a.today);
  const firstKey = keys.reduce((x, y) => (x <= y ? x : y));
  const first = toDay(firstKey);

  const seed = mifflinSeedTdee({
    sex: a.profile.sex,
    ageYears: ageYears(a.profile.birthDate, a.today),
    heightCm: a.profile.heightCm,
    weightKg: a.weights[firstKey]!,
    activitySeed: a.profile.activitySeed,
  });

  let state = initialState(seed);
  const days: ReplayDay[] = [];
  for (let d = first; d <= today; d++) {
    const key = fromDay(d);
    const scale = a.weights[key] ?? null;
    state = ingest(state, {
      localDate: key,
      scaleWeightKg: scale,
      intakeKcal: d === today || a.partialDays.has(key) ? null : (a.intakes[key] ?? null),
    });
    if (hasTrend(state)) {
      const est = currentEstimate(state);
      days.push({
        date: key,
        scaleKg: scale,
        trendKg: state.trendWeightKg,
        trendSdKg: Math.sqrt(state.trendVariance),
        expenditureKcal: est.expenditureKcal,
        expenditureSdKcal: est.confidenceBandKcal,
        dataDriven: est.isDataDriven,
      });
    }
  }
  return { state, estimate: currentEstimate(state), days };
}

/** Age in years on `today` (both `YYYY-MM-DD`). */
export function ageYears(birthDate: string, today: string): number {
  return (toDay(today) - toDay(birthDate)) / 365.25;
}

/** The state as the app persists it (`EngineState.toJson`), dates as UTC midnight. */
export function stateToJson(s: EngineState) {
  return {
    trendWeightKg: s.trendWeightKg,
    trendVariance: s.trendVariance,
    seedExpenditureKcal: s.seedExpenditureKcal,
    expenditureKcal: s.expenditureKcal,
    daysIngested: s.daysIngested,
    weighInsInWindow: s.weighInsInWindow,
    loggedDaysInWindow: s.loggedDaysInWindow,
    lastUpdated: s.lastUpdated === null ? null : isoMidnight(toDay(s.lastUpdated)),
    recentObservations: s.recentObservations.map((o) => ({
      localDate: isoMidnight(toDay(o.localDate)),
      scaleWeightKg: o.scaleWeightKg,
      intakeKcal: o.intakeKcal,
    })),
    recentTrendKg: s.recentTrendKg,
    filter: s.filter,
  };
}
