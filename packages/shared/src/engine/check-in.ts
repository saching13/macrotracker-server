/** Port of `check_in.dart`: the weekly check-in schedule and partial-day suggestions. */
import { isPartialDay, WINDOW_DAYS } from './adaptive.js';
import { fromDay, toDay, weekdayOf } from './local-date.js';

/** How early a check-in may be done before its day. */
export const EARLY_CHECK_IN_DAYS = 2;
/** How far back check-in looks for likely partial days. */
export const PARTIAL_LOOKBACK_DAYS = 21;

export interface CheckInStatus {
  lastCheckIn: string;
  /** The check-in day that's due (when `isDue`) or coming up. */
  nextCheckIn: string;
  isDue: boolean;
  /** Days until `nextCheckIn`; 0 when due. */
  daysUntil: number;
  /** Within `EARLY_CHECK_IN_DAYS` of the next check-in. */
  canCheckInEarly: boolean;
}

/**
 * The schedule on `today`, given the last check-in (the latest targets'
 * effective date) and the check-in weekday `dow` (0 = Monday).
 */
export function checkInSchedule(a: { today: string; lastCheckIn: string; dow: number }): CheckInStatus {
  const today = toDay(a.today);
  const last = toDay(a.lastCheckIn);
  const back = (((weekdayOf(today) - 1 - a.dow) % 7) + 7) % 7;
  const lastCadence = today - back;
  // Once the latest check-in day is covered, the next is a week later.
  const nextCadence = lastCadence + 7;
  // A check-in done up to 2 days early counts for that cadence day.
  const isDue = last < lastCadence - EARLY_CHECK_IN_DAYS;
  const daysUntil = nextCadence - today;
  return {
    lastCheckIn: a.lastCheckIn,
    nextCheckIn: fromDay(isDue ? lastCadence : nextCadence),
    isDue,
    daysUntil: isDue ? 0 : daysUntil,
    canCheckInEarly:
      !isDue &&
      daysUntil > 0 &&
      daysUntil <= EARLY_CHECK_IN_DAYS &&
      // Not twice for the same upcoming check-in.
      last < nextCadence - EARLY_CHECK_IN_DAYS,
  };
}

/**
 * Logged days before `today` that look partially logged, with their logged
 * kcal; `marked` ones included so they can be shown and unmarked.
 * `lookbackDays` null = all history.
 */
export function likelyPartialDays(a: {
  intakes: Readonly<Record<string, number>>;
  marked: ReadonlySet<string>;
  today: string;
  lookbackDays?: number | null;
}): { date: string; kcal: number; marked: boolean }[] {
  const today = toDay(a.today);
  const keys = Object.keys(a.intakes).sort();
  const lookback = a.lookbackDays === undefined ? PARTIAL_LOOKBACK_DAYS : a.lookbackDays;
  const span = lookback ?? (keys.length === 0 ? 0 : today - toDay(keys[0]!));
  const out: { date: string; kcal: number; marked: boolean }[] = [];
  for (let i = span; i >= 1; i--) {
    const day = today - i;
    const key = fromDay(day);
    const kcal = a.intakes[key];
    if (kcal === undefined) continue;
    // Judge against the complete days in the two weeks before it.
    const recent: number[] = [];
    for (let j = 1; j <= WINDOW_DAYS; j++) {
      const k = fromDay(day - j);
      const v = a.intakes[k];
      if (v !== undefined && !a.marked.has(k)) recent.push(v);
    }
    const isMarked = a.marked.has(key);
    if (isMarked || isPartialDay(kcal, recent)) out.push({ date: key, kcal, marked: isMarked });
  }
  return out;
}
