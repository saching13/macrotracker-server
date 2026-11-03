import { formatWeight } from '../format';

interface Point {
  date: string;
  trend_kg: number;
  scale_kg: number | null;
}

/** Trend line with the day's scale readings as dots; the summary is read instead of the marks. */
export function TrendChart({ points, unit }: { points: Point[]; unit: string }) {
  if (points.length < 2) return null;
  const values = points.flatMap((p) => (p.scale_kg == null ? [p.trend_kg] : [p.trend_kg, p.scale_kg]));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(hi - lo, 0.5);
  const w = 600;
  const h = 160;
  const pad = 12;
  const x = (i: number) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - ((v - lo) / span) * (h - pad * 2);
  const first = points[0]!;
  const last = points.at(-1)!;
  const change = last.trend_kg - first.trend_kg;
  const summary = `Trend weight from ${formatWeight(first.trend_kg, unit)} to ${formatWeight(last.trend_kg, unit)} over ${points.length} days (${change >= 0 ? 'up' : 'down'} ${formatWeight(Math.abs(change), unit)}).`;
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={summary}
    >
      {points.map((p, i) =>
        p.scale_kg == null ? null : (
          <circle key={p.date} className="scale" cx={x(i)} cy={y(p.scale_kg)} r={3.5} />
        ),
      )}
      <polyline className="trend" points={points.map((p, i) => `${x(i)},${y(p.trend_kg)}`).join(' ')} />
    </svg>
  );
}
