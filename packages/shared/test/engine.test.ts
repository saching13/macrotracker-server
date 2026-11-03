import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type ProgramCodes,
  checkInSchedule,
  computeTargets,
  computeWeekPlan,
  decodeDayPlans,
  encodeDayPlans,
  fromDay,
  isPartialDay,
  likelyPartialDays,
  localToday,
  mifflinSeedTdee,
  programFromCodes,
  replayHistory,
  stateToJson,
  toDay,
  weekdayOf,
} from '../src/engine/index.js';

/**
 * Golden vectors written by the Dart engine (app repo: `make golden-engine`,
 * then scripts/sync-engine-fixtures.sh here). The port follows the Dart
 * arithmetic operation for operation, so doubles match bit for bit. If a
 * future change uses functions whose last bit may differ between Dart and
 * V8 (pow, exp, log), loosen REL rather than the arithmetic.
 */
const vectors = JSON.parse(
  readFileSync(new URL('../../../fixtures/engine/engine_vectors.json', import.meta.url), 'utf8'),
) as Vectors;

const REL = 0;

/** Deep equality with a relative tolerance on numbers. */
function expectClose(actual: unknown, expected: unknown, path = '$'): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const tol = REL * Math.max(1, Math.abs(expected));
    if (!(Math.abs(actual - expected) <= tol)) {
      throw new Error(`${path}: expected ${expected}, got ${actual}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw new Error(
        `${path}: expected ${expected.length} items, got ${JSON.stringify(actual)?.slice(0, 200)}`,
      );
    }
    expected.forEach((e, i) => expectClose(actual[i], e, `${path}[${i}]`));
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object')
      throw new Error(`${path}: expected an object, got ${actual}`);
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      expectClose(
        (actual as Record<string, unknown>)[k],
        (expected as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
    }
    return;
  }
  if (actual !== expected)
    throw new Error(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

interface TargetsJson {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  effective_date: string | null;
}
interface Vectors {
  version: number;
  mifflin: {
    sex: string;
    age_years: number;
    height_cm: number;
    weight_kg: number;
    activity_seed: string;
    kcal: number;
  }[];
  partial_day: { intake_kcal: number; recent: number[]; partial: boolean }[];
  check_in: {
    today: string;
    last_check_in: string;
    dow: number;
    next_check_in: string;
    is_due: boolean;
    days_until: number;
    can_check_in_early: boolean;
  }[];
  likely_partial: {
    today: string;
    intakes: Record<string, number>;
    marked: string[];
    lookback_days: number | null;
    days: { date: string; kcal: number; marked: boolean }[];
  }[];
  legacy_targets: { state: StateJson; program: ProgramCodes; targets: TargetsJson }[];
  scenarios: {
    name: string;
    profile: { sex: string; birth_date: string; height_cm: number; activity_seed: string };
    today: string;
    weights: Record<string, number>;
    intakes: Record<string, number>;
    partial_days: string[];
    days: {
      date: string;
      scale_kg: number | null;
      trend_kg: number;
      trend_sd_kg: number;
      expenditure_kcal: number;
      expenditure_sd_kcal: number;
      data_driven: boolean;
    }[];
    state: StateJson;
    estimate: {
      trend_weight_kg: number;
      expenditure_kcal: number;
      confidence_band_kcal: number;
      is_data_driven: boolean;
    };
    programs: {
      program: ProgramCodes;
      context: { sex: string; maintain_target_kg: number | null };
      targets: TargetsJson;
      week: TargetsJson[];
    }[];
  }[];
}
type StateJson = ReturnType<typeof stateToJson>;

const targetsJson = (t: {
  kcal: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  effectiveDate: string | null;
}): TargetsJson => ({
  kcal: t.kcal,
  protein_g: t.proteinG,
  carb_g: t.carbG,
  fat_g: t.fatG,
  effective_date: t.effectiveDate,
});

/** The Dart state JSON back into the engine's state (dates as `YYYY-MM-DD`). */
const stateFromJson = (j: StateJson) => ({
  ...j,
  lastUpdated: j.lastUpdated === null ? null : j.lastUpdated.slice(0, 10),
  recentObservations: j.recentObservations.map((o) => ({ ...o, localDate: o.localDate.slice(0, 10) })),
});

describe('golden vectors', () => {
  it('has the expected format', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.scenarios.length).toBeGreaterThanOrEqual(10);
  });

  it('mifflin seed', () => {
    for (const v of vectors.mifflin) {
      expectClose(
        mifflinSeedTdee({
          sex: v.sex,
          ageYears: v.age_years,
          heightCm: v.height_cm,
          weightKg: v.weight_kg,
          activitySeed: v.activity_seed,
        }),
        v.kcal,
      );
    }
  });

  it('partial-day test', () => {
    for (const v of vectors.partial_day)
      expect(isPartialDay(v.intake_kcal, v.recent), JSON.stringify(v)).toBe(v.partial);
  });

  it('check-in schedule', () => {
    for (const v of vectors.check_in) {
      expect(
        checkInSchedule({ today: v.today, lastCheckIn: v.last_check_in, dow: v.dow }),
        JSON.stringify(v),
      ).toEqual({
        lastCheckIn: v.last_check_in,
        nextCheckIn: v.next_check_in,
        isDue: v.is_due,
        daysUntil: v.days_until,
        canCheckInEarly: v.can_check_in_early,
      });
    }
  });

  it('likely partial days', () => {
    for (const v of vectors.likely_partial) {
      expectClose(
        likelyPartialDays({
          intakes: v.intakes,
          marked: new Set(v.marked),
          today: v.today,
          lookbackDays: v.lookback_days,
        }),
        v.days,
      );
    }
  });

  it('legacy single-day targets', () => {
    for (const v of vectors.legacy_targets) {
      expectClose(
        targetsJson(computeTargets(stateFromJson(v.state), programFromCodes(v.program))),
        v.targets,
      );
    }
  });

  describe.each(vectors.scenarios.map((s) => [s.name, s] as const))('scenario %s', (_name, s) => {
    const replay = replayHistory({
      profile: {
        sex: s.profile.sex,
        birthDate: s.profile.birth_date,
        heightCm: s.profile.height_cm,
        activitySeed: s.profile.activity_seed,
      },
      weights: s.weights,
      intakes: s.intakes,
      partialDays: new Set(s.partial_days),
      today: s.today,
    });

    it('replays every day', () => {
      expect(replay).not.toBeNull();
      expectClose(
        replay!.days.map((d) => ({
          date: d.date,
          scale_kg: d.scaleKg,
          trend_kg: d.trendKg,
          trend_sd_kg: d.trendSdKg,
          expenditure_kcal: d.expenditureKcal,
          expenditure_sd_kcal: d.expenditureSdKcal,
          data_driven: d.dataDriven,
        })),
        s.days,
      );
    });

    it('ends in the same state and estimate', () => {
      expectClose(stateToJson(replay!.state), s.state);
      expectClose(
        {
          trend_weight_kg: replay!.estimate.trendWeightKg,
          expenditure_kcal: replay!.estimate.expenditureKcal,
          confidence_band_kcal: replay!.estimate.confidenceBandKcal,
          is_data_driven: replay!.estimate.isDataDriven,
        },
        s.estimate,
      );
    });

    it('computes the same targets and week plans', () => {
      for (const p of s.programs) {
        const program = programFromCodes(p.program, {
          sex: p.context.sex,
          maintainTargetKg: p.context.maintain_target_kg,
        });
        expectClose(
          targetsJson(computeTargets(replay!.state, program)),
          p.targets,
          `${p.program.id}.targets`,
        );
        expectClose(computeWeekPlan(replay!.state, program).map(targetsJson), p.week, `${p.program.id}.week`);
      }
    });
  });
});

describe('local dates', () => {
  it('round-trips and knows weekdays', () => {
    expect(fromDay(toDay('2026-11-02'))).toBe('2026-11-02');
    expect(weekdayOf(toDay('2026-11-02'))).toBe(1); // Monday
    expect(weekdayOf(toDay('2026-11-08'))).toBe(7);
    expect(weekdayOf(toDay('1969-12-31'))).toBe(3);
    expect(() => toDay('2026-1-2')).toThrow(RangeError);
  });

  it('finds the local calendar day in a timezone', () => {
    const now = new Date('2026-11-02T03:00:00Z');
    expect(localToday(now, 'UTC')).toBe('2026-11-02');
    expect(localToday(now, 'America/Los_Angeles')).toBe('2026-11-01');
    expect(localToday(now, 'Asia/Kolkata')).toBe('2026-11-02');
  });
});

describe('day plans', () => {
  it('decode what encode writes and ignore incomplete weeks', () => {
    const json = '[{"share":1.2,"carb":0.4},{},{},{},{},{"fixed":{"kcal":1800,"p":140,"c":180,"f":60}},{}]';
    const days = decodeDayPlans(json)!;
    expect(days[0]).toEqual({ calorieShare: 1.2, carbShare: 0.4, fixed: null });
    expect(days[5]!.fixed).toMatchObject({ kcal: 1800, proteinG: 140 });
    expect(decodeDayPlans(encodeDayPlans(days))).toEqual(days);
    expect(decodeDayPlans('[{"share":1}]')).toBeNull();
    expect(decodeDayPlans(null)).toBeNull();
  });
});
