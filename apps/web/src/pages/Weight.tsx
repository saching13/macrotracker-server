import { displayToKg, kgToDisplay, massLabel } from '@macrotracker/shared/units';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, unwrap } from '../api/client';
import { TrendChart } from '../components/TrendChart';
import { OrbLoader, Section } from '../components/ui';
import { addDays, dayLabel, formatWeight, today } from '../format';

export function WeightPage() {
  const qc = useQueryClient();
  const date = today();
  const from = addDays(date, -59);
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => unwrap(api.GET('/v1/profile')) });
  const unit = profile.data?.profile?.unit_mass ?? 'kg';
  const weights = useQuery({
    queryKey: ['weights', from, date],
    queryFn: () => unwrap(api.GET('/v1/weights', { params: { query: { from, to: date } } })),
  });
  const status = useQuery({
    queryKey: ['status', date],
    queryFn: () => unwrap(api.GET('/v1/status', { params: { query: { today: date } } })),
  });
  const [value, setValue] = useState('');
  const [day, setDay] = useState(date);
  const refresh = () =>
    Promise.all(['weights', 'status'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/v1/weights', {
          body: { date: day, weight_kg: displayToKg(Number(value.replace(',', '.')), unit) },
        }),
      ),
    onSuccess: async () => {
      setValue('');
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/v1/weights/{id}', { params: { path: { id } } })),
    onSuccess: refresh,
  });
  const n = Number(value.replace(',', '.'));
  const ok = Number.isFinite(n) && n > 0;

  return (
    <>
      <h1>Weight</h1>
      {status.data?.estimate && (
        <Section header="Trend">
          <div className="row">
            <span className="grow">Trend weight</span>
            <strong className="numeric">{formatWeight(status.data.estimate.trend_weight_kg, unit)}</strong>
          </div>
          <TrendChart points={status.data.trend} unit={unit} />
        </Section>
      )}
      <Section header="Log a weigh-in">
        <form
          className="row"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (ok) add.mutate();
          }}
        >
          <input
            className="input"
            type="date"
            value={day}
            max={date}
            onChange={(e) => setDay(e.target.value)}
            aria-label="Day"
          />
          <input
            className="input"
            inputMode="decimal"
            placeholder={massLabel(unit)}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`Weight (${massLabel(unit)})`}
          />
          <button className="button" type="submit" disabled={!ok || add.isPending}>
            Add
          </button>
        </form>
      </Section>
      {add.isError && <p className="error">{add.error.message}</p>}
      <Section header="Last 60 days">
        {weights.isPending ? (
          <OrbLoader message="Loading weigh-ins…" />
        ) : (
          [...(weights.data?.weights ?? [])].reverse().map((w) => (
            <div className="row" key={w.id}>
              <span className="grow">{dayLabel(w.date)}</span>
              <span className="numeric">
                {kgToDisplay(w.weight_kg, unit).toFixed(1)} {massLabel(unit)}
              </span>
              <button
                className="button danger"
                type="button"
                aria-label={`Delete the weigh-in on ${dayLabel(w.date)}`}
                onClick={() => remove.mutate(w.id)}
              >
                Delete
              </button>
            </div>
          ))
        )}
        {weights.data?.weights.length === 0 && <div className="row secondary">No weigh-ins yet.</div>}
      </Section>
    </>
  );
}
