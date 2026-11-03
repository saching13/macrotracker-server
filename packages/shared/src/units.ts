/**
 * Port of the app's `lib/core/units/unit_converter.dart`. Every unit
 * conversion goes through here; storage is always kg, kcal, cm, and g or ml.
 */

export type UnitMass = 'kg' | 'lb';
export type UnitEnergy = 'kcal' | 'kj';

export const LB_PER_KG = 2.20462;
export const KJ_PER_KCAL = 4.184;
const CM_PER_INCH = 2.54;

export const kgToDisplay = (kg: number, unit: string) => (unit === 'lb' ? kg * LB_PER_KG : kg);
export const displayToKg = (value: number, unit: string) => (unit === 'lb' ? value / LB_PER_KG : value);
export const kcalToDisplay = (kcal: number, unit: string) => (unit === 'kj' ? kcal * KJ_PER_KCAL : kcal);
export const displayToKcal = (value: number, unit: string) => (unit === 'kj' ? value / KJ_PER_KCAL : value);

export const massLabel = (unit: string) => (unit === 'lb' ? 'lb' : 'kg');
export const energyLabel = (unit: string) => (unit === 'kj' ? 'kJ' : 'kcal');

const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** "71.3 kg" / "157.2 lb". */
export const formatWeight = (kg: number, unit: string) =>
  `${kgToDisplay(kg, unit).toFixed(1)} ${massLabel(unit)}`;

/** Grouped whole number only, e.g. "2,150"; pair with `energyLabel`. */
export const formatEnergyNumber = (kcal: number, unit: string) =>
  grouped.format(Math.round(kcalToDisplay(kcal, unit)));

export const formatEnergy = (kcal: number, unit: string) =>
  `${formatEnergyNumber(kcal, unit)} ${energyLabel(unit)}`;

// Food amounts: foods are stored per 100 g or 100 ml; these are the standard
// units offered next to a food's own servings (US customary).
export const GRAMS_PER_OUNCE = 28.349523125;
export const ML_PER_FLUID_OUNCE = 29.5735295625;
export const ML_PER_CUP = 236.5882365;
export const ML_PER_TABLESPOON = 14.78676478125;
export const ML_PER_TEASPOON = 4.92892159375;
export const ML_PER_LITER = 1000;
export const GRAMS_PER_POUND = 453.59237;
export const GRAMS_PER_KILOGRAM = 1000;

/** Units a serving's weight or volume can be given in, in picker order: [unit, base, base units per unit]. */
export const SERVING_WEIGHT_UNITS: readonly (readonly [string, 'g' | 'ml', number])[] = [
  ['g', 'g', 1],
  ['ml', 'ml', 1],
  ['oz', 'g', GRAMS_PER_OUNCE],
  ['fl oz', 'ml', ML_PER_FLUID_OUNCE],
  ['cup', 'ml', ML_PER_CUP],
  ['tbsp', 'ml', ML_PER_TABLESPOON],
  ['tsp', 'ml', ML_PER_TEASPOON],
  ['lb', 'g', GRAMS_PER_POUND],
  ['kg', 'g', GRAMS_PER_KILOGRAM],
  ['L', 'ml', ML_PER_LITER],
];

/** `amount` of `unit` (from `SERVING_WEIGHT_UNITS`) in its base unit. */
export function servingToBase(amount: number, unit: string): { amount: number; base: 'g' | 'ml' } {
  const u = SERVING_WEIGHT_UNITS.find((e) => e[0] === unit);
  if (!u) throw new RangeError(`unknown serving unit: ${unit}`);
  return { amount: amount * u[2], base: u[1] };
}

// Height and body measurements: stored in cm; imperial ('lb') users see
// feet + inches, or inches.
export const isImperial = (unitMass: string) => unitMass === 'lb';

/** Whole feet and inches (rounded to the nearest inch, never 12 in). */
export function cmToFeetInches(cm: number): [feet: number, inches: number] {
  const totalInches = Math.round(cm / CM_PER_INCH);
  return [Math.trunc(totalInches / 12), totalInches % 12];
}

export const feetInchesToCm = (feet: number, inches: number) => (feet * 12 + inches) * CM_PER_INCH;
export const cmToDisplayLength = (cm: number, unitMass: string) =>
  isImperial(unitMass) ? cm / CM_PER_INCH : cm;
export const displayLengthToCm = (value: number, unitMass: string) =>
  isImperial(unitMass) ? value * CM_PER_INCH : value;
export const lengthLabel = (unitMass: string) => (isImperial(unitMass) ? 'in' : 'cm');

/** "81.5 cm" / "32.1 in". */
export const formatLength = (cm: number, unitMass: string) =>
  `${cmToDisplayLength(cm, unitMass).toFixed(1)} ${lengthLabel(unitMass)}`;

export function formatHeight(cm: number, unitMass: string): string {
  if (!isImperial(unitMass)) return `${Math.round(cm)} cm`;
  const [ft, inch] = cmToFeetInches(cm);
  return `${ft} ft ${inch} in`;
}
