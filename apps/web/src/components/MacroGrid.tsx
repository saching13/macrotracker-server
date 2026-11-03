import { energyLabel, formatEnergyNumber } from '../format';

interface Macros {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
}

/** Eaten against target, always kcal → P → C → F, each with its color and a label. */
export function MacroGrid({
  totals,
  targets,
  energy,
}: {
  totals: Macros;
  targets: Macros | null;
  energy: string;
}) {
  const items = [
    {
      key: 'kcal',
      label: energyLabel(energy),
      color: 'var(--kcal)',
      eaten: totals.kcal,
      target: targets?.kcal,
      show: (x: number) => formatEnergyNumber(x, energy),
    },
    {
      key: 'protein',
      label: 'Protein',
      color: 'var(--protein)',
      eaten: totals.protein_g,
      target: targets?.protein_g,
      show: (x: number) => `${Math.round(x)} g`,
    },
    {
      key: 'carb',
      label: 'Carbs',
      color: 'var(--carb)',
      eaten: totals.carb_g,
      target: targets?.carb_g,
      show: (x: number) => `${Math.round(x)} g`,
    },
    {
      key: 'fat',
      label: 'Fat',
      color: 'var(--fat)',
      eaten: totals.fat_g,
      target: targets?.fat_g,
      show: (x: number) => `${Math.round(x)} g`,
    },
  ];
  return (
    <div className="macro-grid">
      {items.map((m) => (
        <div className="macro" key={m.key} data-testid={`macro-${m.key}`}>
          <span className="secondary small">
            <span className="dot" style={{ background: m.color }} aria-hidden="true" />
            {m.label}
          </span>
          <span className="value numeric">{m.show(m.eaten)}</span>
          {m.target != null && (
            <>
              <div
                className="meter"
                role="meter"
                aria-label={`${m.label} eaten of target`}
                aria-valuemin={0}
                aria-valuemax={Math.round(m.target)}
                aria-valuenow={Math.round(m.eaten)}
              >
                <div
                  style={{
                    width: `${Math.min(100, (m.eaten / Math.max(m.target, 1)) * 100)}%`,
                    background: m.color,
                  }}
                />
              </div>
              <span className="secondary small numeric">of {m.show(m.target)}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
