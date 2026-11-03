/**
 * Diary rules shared by the app, the API and the web app. Ports of the app's
 * `lib/core/diary/entry_time.dart` and its logging math (`logger/basket.dart`).
 */

export type Meal = 'breakfast' | 'lunch' | 'snack' | 'dinner';

/** `HH:mm`, local time. */
export const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The meal a time of day belongs to (kept on each entry for Health and backups). */
export function mealForTime(hm: string): Meal {
  const hour = Number(hm.slice(0, 2));
  if (hour >= 4 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 15) return 'lunch';
  if (hour >= 17 && hour < 22) return 'dinner';
  return 'snack';
}

/** Typical times for entries that only know their meal. */
export const MEAL_DEFAULT_TIMES: Record<Meal, string> = {
  breakfast: '08:00',
  lunch: '12:30',
  snack: '15:30',
  dinner: '19:00',
};

export interface Macros {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
}

/** A food's macros for `quantity` of its base unit (it stores them per `serving_qty`). */
export function foodMacros(
  food: { serving_qty: number; kcal_per_serving: number; protein_g: number; carb_g: number; fat_g: number },
  quantity: number,
): Macros {
  const ratio = quantity / food.serving_qty;
  return {
    kcal: food.kcal_per_serving * ratio,
    protein_g: food.protein_g * ratio,
    carb_g: food.carb_g * ratio,
    fat_g: food.fat_g * ratio,
  };
}

/** `servings` of a recipe: its totals ÷ its servings, each. */
export function recipeMacros(
  recipe: {
    servings: number;
    total_kcal: number;
    total_protein_g: number;
    total_carb_g: number;
    total_fat_g: number;
  },
  servings: number,
): Macros {
  const f = servings / (recipe.servings <= 0 ? 1 : recipe.servings);
  return {
    kcal: recipe.total_kcal * f,
    protein_g: recipe.total_protein_g * f,
    carb_g: recipe.total_carb_g * f,
    fat_g: recipe.total_fat_g * f,
  };
}

export function sumMacros(rows: readonly Macros[]): Macros {
  return rows.reduce(
    (a, r) => ({
      kcal: a.kcal + r.kcal,
      protein_g: a.protein_g + r.protein_g,
      carb_g: a.carb_g + r.carb_g,
      fat_g: a.fat_g + r.fat_g,
    }),
    { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 },
  );
}
