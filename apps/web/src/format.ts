import { fromDay, localToday, toDay } from '@macrotracker/shared/engine';
import { energyLabel, formatEnergyNumber, formatWeight } from '@macrotracker/shared/units';

export { energyLabel, formatEnergyNumber, formatWeight };

/** The browser's local date: the diary day. */
export const today = () => localToday(new Date());

export const addDays = (date: string, n: number) => fromDay(toDay(date) + n);

const dayFormat = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const shortDay = new Intl.DateTimeFormat('en-US', { weekday: 'narrow', timeZone: 'UTC' });

export function dayLabel(date: string): string {
  const t = today();
  if (date === t) return 'Today';
  if (date === addDays(t, -1)) return 'Yesterday';
  if (date === addDays(t, 1)) return 'Tomorrow';
  return dayFormat.format(new Date(`${date}T00:00:00Z`));
}

export const weekdayLetter = (weekday: number) =>
  // 2024-01-01 was a Monday.
  shortDay.format(new Date(Date.UTC(2024, 0, weekday)));

export const grams = (g: number) => `${Math.round(g)} g`;

/** "250 g", "2 jar", "1.5 serving". */
export function amountText(e: {
  quantity: number;
  serving_label: string | null;
  serving_amount: number | null;
}) {
  if (e.serving_label && e.serving_amount != null) return `${trim(e.serving_amount)} ${e.serving_label}`;
  return `${trim(e.quantity)} g`;
}

export const trim = (x: number) => String(Math.round(x * 100) / 100);
