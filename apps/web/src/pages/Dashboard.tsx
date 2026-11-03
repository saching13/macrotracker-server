import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type Schemas, unwrap } from '../api/client';
import { MacroGrid } from '../components/MacroGrid';
import { TrendChart } from '../components/TrendChart';
import { OrbLoader, Section, Sheet } from '../components/ui';
import { energyLabel, formatEnergyNumber, formatWeight, today, weekdayLetter } from '../format';

export function DashboardPage() {
  const date = today();
  const status = useQuery({
    queryKey: ['status', date],
    queryFn: () => unwrap(api.GET('/v1/status', { params: { query: { today: date } } })),
  });
  const [checkIn, setCheckIn] = useState(false);

  if (status.isPending) return <OrbLoader message="Loading your dashboard…" />;
  if (status.isError) return <p className="error">{status.error.message}</p>;
  const s = status.data;
  const mass = s.profile?.unit_mass ?? 'kg';
  const energy = s.profile?.unit_energy ?? 'kcal';

  return (
    <>
      <h1>Dashboard</h1>
      {!s.profile && (
        <Section footer="Set up your profile and plan in the MacroTracker app; it syncs here.">
          <div className="row">No profile yet.</div>
        </Section>
      )}

      <Section header="Today">
        <MacroGrid totals={s.today_totals} targets={s.today_targets} energy={energy} />
        <Link className="row" to="/diary">
          <span className="grow">Open the diary</span>
          <span aria-hidden="true">›</span>
        </Link>
      </Section>

      {s.estimate && (
        <Section
          header="Weight & expenditure"
          footer={
            s.estimate.data_driven
              ? 'Expenditure is estimated from your logged food and weight.'
              : 'Expenditure still leans on the starting formula; it learns from a few weeks of logging.'
          }
        >
          <div className="row">
            <span className="grow">Trend weight</span>
            <strong className="numeric">{formatWeight(s.estimate.trend_weight_kg, mass)}</strong>
          </div>
          <TrendChart points={s.trend} unit={mass} />
          <div className="row">
            <span className="grow">Expenditure</span>
            <strong className="numeric">
              {formatEnergyNumber(s.estimate.expenditure_kcal, energy)} {energyLabel(energy)}
            </strong>
          </div>
        </Section>
      )}

      {s.week && (
        <Section header="This week’s targets">
          <div className="week">
            {s.week.map((d) => (
              <div key={d.weekday ?? 0} className={todayWeekday(date) === d.weekday ? 'today' : undefined}>
                <div className="secondary small">{weekdayLetter(d.weekday ?? 1)}</div>
                <div className="numeric">{formatEnergyNumber(d.kcal, energy)}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {s.check_in && (
        <Section header="Check-in">
          <div className="row">
            <span className="grow">
              {s.check_in.is_due
                ? 'Your weekly check-in is due.'
                : s.check_in.days_until === 1
                  ? 'Next check-in tomorrow.'
                  : `Next check-in in ${s.check_in.days_until} days.`}
            </span>
            {(s.check_in.is_due || s.check_in.can_check_in_early) && (
              <button className="button tonal" type="button" onClick={() => setCheckIn(true)}>
                Check in
              </button>
            )}
          </div>
        </Section>
      )}
      {checkIn && <CheckInSheet date={date} energy={energy} onClose={() => setCheckIn(false)} />}
    </>
  );
}

const todayWeekday = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

function CheckInSheet({ date, energy, onClose }: { date: string; energy: string; onClose: () => void }) {
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ['check-in', date],
    queryFn: () => unwrap(api.GET('/v1/check-in', { params: { query: { today: date } } })),
  });
  const accept = useMutation({
    mutationFn: () => unwrap(api.POST('/v1/check-in', { body: { today: date } })),
    onSuccess: (status: Schemas['Status']) => {
      qc.setQueryData(['status', date], status);
      void qc.invalidateQueries({ queryKey: ['day'] });
      onClose();
    },
  });
  return (
    <Sheet title="Weekly check-in" onClose={onClose}>
      {preview.isPending ? (
        <OrbLoader message="Working out your week…" />
      ) : preview.isError ? (
        <p className="error">{preview.error.message}</p>
      ) : (
        <>
          <p className="secondary">
            Expenditure {formatEnergyNumber(preview.data.expenditure_kcal, energy)} {energyLabel(energy)}
            {preview.data.previous_expenditure_kcal != null &&
              ` (was ${formatEnergyNumber(preview.data.previous_expenditure_kcal, energy)})`}
            . {preview.data.logged_days} of the last 7 days logged, {preview.data.weigh_ins} weigh-ins.
          </p>
          <div className="card">
            <div className="week">
              {preview.data.week.map((d) => (
                <div key={d.weekday ?? 0}>
                  <div className="secondary small">{weekdayLetter(d.weekday ?? 1)}</div>
                  <div className="numeric">{formatEnergyNumber(d.kcal, energy)}</div>
                  <div className="secondary small numeric">P {Math.round(d.protein_g)}</div>
                </div>
              ))}
            </div>
          </div>
          {accept.isError && <p className="error">{accept.error.message}</p>}
          <p>
            <button
              className="button wide"
              type="button"
              disabled={accept.isPending}
              onClick={() => accept.mutate()}
            >
              {accept.isPending ? 'Saving…' : 'Use these targets'}
            </button>
          </p>
        </>
      )}
    </Sheet>
  );
}
