/**
 * Calendar days. The engine works in local calendar days (`YYYY-MM-DD`, the
 * user's timezone at entry time); arithmetic uses day numbers (days since
 * 1970-01-01), which is exact where Dart uses UTC-midnight DateTimes.
 */

const MS_PER_DAY = 86_400_000;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` → day number. */
export function toDay(localDate: string): number {
  const m = LOCAL_DATE.exec(localDate);
  if (!m) throw new RangeError(`not a YYYY-MM-DD date: ${localDate}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY;
}

/** Day number → `YYYY-MM-DD`. */
export function fromDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** 1 = Monday … 7 = Sunday (Dart's `DateTime.weekday`). */
export function weekdayOf(day: number): number {
  // 1970-01-01 was a Thursday.
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

/** UTC midnight in Dart's `toIso8601String` form, as the app persists dates. */
export function isoMidnight(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString();
}

/** Day number of an ISO timestamp's UTC calendar date. */
export function dayOfIso(iso: string): number {
  return toDay(iso.slice(0, 10));
}

/** Today's local calendar day for a clock reading in `timeZone` (IANA name). */
export function localToday(now: Date, timeZone?: string): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
