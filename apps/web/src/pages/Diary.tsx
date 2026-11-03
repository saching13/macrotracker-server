import { mealForTime, MEAL_DEFAULT_TIMES, type Meal } from '@macrotracker/shared/diary';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api, type Schemas, unwrap } from '../api/client';
import { MacroGrid } from '../components/MacroGrid';
import { Icon, OrbLoader, Section, Sheet, SmallOrb } from '../components/ui';
import { addDays, amountText, dayLabel, energyLabel, formatEnergyNumber, today, trim } from '../format';

type Entry = Schemas['Entry'];
type Food = Schemas['Food'];

const MEALS: Meal[] = ['breakfast', 'lunch', 'snack', 'dinner'];
const MEAL_NAMES: Record<Meal, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  snack: 'Snacks',
  dinner: 'Dinner',
};

function useEnergyUnit() {
  const profile = useQuery({
    queryKey: ['profile'],
    queryFn: () => unwrap(api.GET('/v1/profile')),
  });
  return profile.data?.profile?.unit_energy ?? 'kcal';
}

/** Mutations change the day, the dashboard and recent foods. */
function useInvalidate() {
  const qc = useQueryClient();
  return () => Promise.all(['day', 'status', 'recent'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

export function DiaryPage() {
  const { date: param } = useSearch({ from: '/diary' });
  const date = param ?? today();
  const navigate = useNavigate();
  const energy = useEnergyUnit();
  const day = useQuery({
    queryKey: ['day', date],
    queryFn: () => unwrap(api.GET('/v1/day', { params: { query: { date } } })),
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Entry | null>(null);
  const go = (d: string) => void navigate({ to: '/diary', search: { date: d === today() ? undefined : d } });

  return (
    <>
      <div className="date-nav">
        <button
          className="icon-button"
          type="button"
          aria-label="Previous day"
          onClick={() => go(addDays(date, -1))}
        >
          <Icon name="back" />
        </button>
        <h1 className="label" style={{ margin: 0 }}>
          {dayLabel(date)}
        </h1>
        <button
          className="icon-button"
          type="button"
          aria-label="Next day"
          onClick={() => go(addDays(date, 1))}
        >
          <Icon name="forward" />
        </button>
      </div>

      {day.isPending ? (
        <OrbLoader message="Loading the day…" />
      ) : day.isError ? (
        <p className="error">{day.error.message}</p>
      ) : (
        <>
          <Section
            footer={day.data.partial ? 'Marked as partly logged: left out of your expenditure.' : undefined}
          >
            <MacroGrid totals={day.data.totals} targets={day.data.targets} energy={energy} />
          </Section>
          {MEALS.map((meal) => {
            const entries = day.data.entries.filter((e) => e.meal === meal);
            if (entries.length === 0) return null;
            return (
              <Section key={meal} header={MEAL_NAMES[meal]}>
                {entries.map((e) => (
                  <button
                    key={e.id}
                    className="row"
                    type="button"
                    onClick={() => setEditing(e)}
                    data-testid="entry"
                  >
                    <span className="grow">
                      <div className="name">{e.name}</div>
                      <div className="secondary small">
                        {e.food_id || e.recipe_id ? amountText(e) : 'quick add'}
                        {e.time && ` · ${e.time}`}
                      </div>
                    </span>
                    <span className="numeric">
                      {formatEnergyNumber(e.kcal, energy)}{' '}
                      <span className="secondary small">{energyLabel(energy)}</span>
                    </span>
                  </button>
                ))}
              </Section>
            );
          })}
          {day.data.entries.length === 0 && <p className="secondary">Nothing logged on this day.</p>}
          <p>
            <button className="button wide" type="button" onClick={() => setAdding(true)}>
              <Icon name="add" /> Log food
            </button>
          </p>
        </>
      )}
      {adding && <AddSheet date={date} energy={energy} onClose={() => setAdding(false)} />}
      {editing && <EditSheet entry={editing} energy={energy} onClose={() => setEditing(null)} />}
    </>
  );
}

/** Time to file a new entry under: now on today, else the meal's usual time. */
function defaultTime(date: string): string {
  if (date !== today()) return MEAL_DEFAULT_TIMES.lunch;
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function AddSheet({ date, energy, onClose }: { date: string; energy: string; onClose: () => void }) {
  const [mode, setMode] = useState<'search' | 'quick'>('search');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Food | null>(null);
  const search = useQuery({
    queryKey: ['foods', q.trim()],
    enabled: q.trim().length >= 2,
    queryFn: () => unwrap(api.GET('/v1/foods/search', { params: { query: { q: q.trim(), limit: 25 } } })),
  });
  const recent = useQuery({
    queryKey: ['recent'],
    queryFn: () => unwrap(api.GET('/v1/foods/recent', { params: { query: { limit: 15 } } })),
  });

  if (picked) {
    return (
      <AmountSheet
        food={picked}
        date={date}
        energy={energy}
        onBack={() => setPicked(null)}
        onDone={onClose}
      />
    );
  }
  const list = q.trim().length >= 2 ? search.data?.foods : recent.data?.foods;
  return (
    <Sheet title="Log food" onClose={onClose}>
      <div className="segmented" role="group" aria-label="How to log">
        <button type="button" aria-pressed={mode === 'search'} onClick={() => setMode('search')}>
          Search
        </button>
        <button type="button" aria-pressed={mode === 'quick'} onClick={() => setMode('quick')}>
          Quick add
        </button>
      </div>
      {mode === 'quick' ? (
        <QuickAdd date={date} onDone={onClose} />
      ) : (
        <>
          <label className="field">
            <span className="visually-hidden">Search foods</span>
            <input
              className="input"
              type="search"
              placeholder="Search foods"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <h2 className="section-header">{q.trim().length >= 2 ? 'Results' : 'Recent'}</h2>
          {search.isFetching && <SmallOrb label="Searching" />}
          <div className="card">
            {(list ?? []).map((f) => (
              <button
                key={f.id}
                className="row"
                type="button"
                onClick={() => setPicked(f)}
                data-testid="food-result"
              >
                <span className="grow">
                  <div className="name">{f.name}</div>
                  <div className="secondary small">
                    {f.brand ? `${f.brand} · ` : ''}
                    {formatEnergyNumber(f.kcal_per_serving, energy)} {energyLabel(energy)} /{' '}
                    {trim(f.serving_qty)} {f.serving_unit}
                    {f.reference ? ' · USDA' : ''}
                  </div>
                </span>
              </button>
            ))}
            {list?.length === 0 && (
              <div className="row secondary">
                {q.trim().length >= 2 ? 'No foods found.' : 'Foods you log show up here.'}
              </div>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}

function AmountSheet({
  food,
  date,
  energy,
  onBack,
  onDone,
}: {
  food: Food;
  date: string;
  energy: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const invalidate = useInvalidate();
  const units = [
    { label: food.serving_unit, base: 1 },
    ...food.servings.map((s) => ({ label: s.label, base: s.base_amount })),
  ];
  const [unit, setUnit] = useState(units.length > 1 ? 1 : 0);
  const [amount, setAmount] = useState(units.length > 1 ? '1' : String(food.serving_qty));
  const [time, setTime] = useState(defaultTime(date));
  const qty = Number(amount) * units[unit]!.base;
  const ok = Number.isFinite(qty) && qty > 0;
  const log = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/v1/entries', {
          body: {
            date,
            time,
            food_id: food.id,
            quantity: qty,
            serving_label: units[unit]!.label,
            serving_amount: Number(amount),
          },
        }),
      ),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  const kcal = ok ? (food.kcal_per_serving * qty) / food.serving_qty : 0;
  return (
    <Sheet title={food.name} onClose={onDone}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (ok) log.mutate();
        }}
      >
        <div style={{ display: 'flex', gap: 'var(--space-m)' }}>
          <label className="field" style={{ flex: 1 }}>
            <span>Amount</span>
            <input
              className="input"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
              aria-label="Amount"
            />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Unit</span>
            <select className="input" value={unit} onChange={(e) => setUnit(Number(e.target.value))}>
              {units.map((u, i) => (
                <option key={u.label} value={i}>
                  {u.label}
                  {i > 0 ? ` (${trim(u.base)} ${food.serving_unit})` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Time</span>
          <input
            className="input"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            required
          />
        </label>
        <p className="secondary">
          {formatEnergyNumber(kcal, energy)} {energyLabel(energy)} · {mealLabel(time)}
        </p>
        {log.isError && <p className="error">{log.error.message}</p>}
        <div style={{ display: 'flex', gap: 'var(--space-m)' }}>
          <button className="button tonal" type="button" onClick={onBack}>
            Back
          </button>
          <button className="button wide" type="submit" disabled={!ok || log.isPending}>
            {log.isPending ? 'Logging…' : 'Log'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

const mealLabel = (time: string) => (/^\d\d:\d\d$/.test(time) ? MEAL_NAMES[mealForTime(time)] : '');

function QuickAdd({ date, onDone }: { date: string; onDone: () => void }) {
  const invalidate = useInvalidate();
  const [v, setV] = useState({ kcal: '', protein_g: '', carb_g: '', fat_g: '' });
  const [time, setTime] = useState(defaultTime(date));
  const num = (s: string) => (s.trim() === '' ? 0 : Number(s));
  const ok = v.kcal.trim() !== '' && Object.values(v).every((x) => Number.isFinite(num(x)) && num(x) >= 0);
  const log = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/v1/entries', {
          body: {
            date,
            time,
            kcal: num(v.kcal),
            protein_g: num(v.protein_g),
            carb_g: num(v.carb_g),
            fat_g: num(v.fat_g),
          },
        }),
      ),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  const field = (key: keyof typeof v, label: string) => (
    <label className="field" style={{ flex: 1 }}>
      <span>{label}</span>
      <input
        className="input"
        inputMode="decimal"
        value={v[key]}
        onChange={(e) => setV({ ...v, [key]: e.target.value.replace(',', '.') })}
      />
    </label>
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) log.mutate();
      }}
    >
      {field('kcal', 'Calories (kcal)')}
      <div style={{ display: 'flex', gap: 'var(--space-m)' }}>
        {field('protein_g', 'Protein (g)')}
        {field('carb_g', 'Carbs (g)')}
        {field('fat_g', 'Fat (g)')}
      </div>
      <label className="field">
        <span>Time</span>
        <input
          className="input"
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          required
        />
      </label>
      {log.isError && <p className="error">{log.error.message}</p>}
      <p>
        <button className="button wide" type="submit" disabled={!ok || log.isPending}>
          {log.isPending ? 'Logging…' : 'Log'}
        </button>
      </p>
    </form>
  );
}

function EditSheet({ entry, energy, onClose }: { entry: Entry; energy: string; onClose: () => void }) {
  const invalidate = useInvalidate();
  const quick = !entry.food_id && !entry.recipe_id;
  const inServings = entry.serving_amount != null && entry.serving_label != null;
  const [amount, setAmount] = useState(trim(inServings ? entry.serving_amount! : entry.quantity));
  const [kcal, setKcal] = useState(trim(entry.kcal));
  const [time, setTime] = useState(entry.time ?? MEAL_DEFAULT_TIMES[entry.meal as Meal] ?? '12:00');
  const save = useMutation({
    mutationFn: () => {
      const body: { time?: string; kcal?: number; quantity?: number; serving_amount?: number } = {};
      if (time !== entry.time) body.time = time;
      if (quick) {
        if (Number(kcal) !== entry.kcal) body.kcal = Number(kcal);
      } else {
        const a = Number(amount);
        if (inServings && a !== entry.serving_amount) body.serving_amount = a;
        if (!inServings && a !== entry.quantity) body.quantity = a;
      }
      return unwrap(api.PATCH('/v1/entries/{id}', { params: { path: { id: entry.id } }, body }));
    },
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/v1/entries/{id}', { params: { path: { id: entry.id } } })),
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });
  return (
    <Sheet title={entry.name} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <p className="secondary">
          {formatEnergyNumber(entry.kcal, energy)} {energyLabel(energy)} · P {Math.round(entry.protein_g)} · C{' '}
          {Math.round(entry.carb_g)} · F {Math.round(entry.fat_g)}
        </p>
        {quick ? (
          <label className="field">
            <span>Calories (kcal)</span>
            <input
              className="input"
              inputMode="decimal"
              value={kcal}
              onChange={(e) => setKcal(e.target.value)}
            />
          </label>
        ) : (
          <label className="field">
            <span>Amount ({inServings ? entry.serving_label : 'g'})</span>
            <input
              className="input"
              inputMode="decimal"
              value={amount}
              aria-label="Amount"
              onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
            />
          </label>
        )}
        <label className="field">
          <span>Time</span>
          <input
            className="input"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            required
          />
        </label>
        {(save.isError || remove.isError) && <p className="error">{(save.error ?? remove.error)!.message}</p>}
        <div style={{ display: 'flex', gap: 'var(--space-m)', marginTop: 'var(--space-l)' }}>
          <button
            className="button danger"
            type="button"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            Delete
          </button>
          <button className="button wide" type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
