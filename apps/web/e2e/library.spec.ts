import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

/**
 * plan-11 S7 on the web: one person shares a recipe, another finds it in the
 * library, adds it to their recipes and logs it.
 */
const password = process.env.E2E_PASSWORD ?? 'e2e-password-1234';
const cook = process.env.E2E_EMAIL ?? 'e2e@example.test';
const friend = process.env.E2E_EMAIL_2 ?? 'friend@example.test';
const recipeName = `Lentil soup ${randomUUID().slice(0, 6)}`;

test.beforeAll(async ({ request }) => {
  // The cook's phone synced a recipe made of their own food.
  const login = await request.post('/v1/auth/login', {
    data: { email: cook, password, device: { name: 'e2e phone', platform: 'other' }, client: 'app' },
  });
  const { access_token } = (await login.json()) as { access_token: string };
  const foodId = randomUUID();
  const recipeId = randomUUID();
  const now = new Date().toISOString();
  const res = await request.post('/v1/sync/bootstrap', {
    headers: { authorization: `Bearer ${access_token}` },
    data: {
      schema_version: 11,
      rows: [
        {
          table: 'foods',
          row: {
            id: foodId,
            name: 'Red lentils, cooked',
            brand: null,
            barcode: null,
            serving_qty: 100,
            serving_unit: 'g',
            kcal_per_serving: 116,
            protein_g: 9,
            carb_g: 20,
            fat_g: 0.4,
            fiber_g: 8,
            saturated_fat_g: null,
            trans_fat_g: null,
            cholesterol_mg: null,
            sodium_mg: null,
            sugar_g: null,
            source: 'custom',
            is_favorite: 0,
          },
        },
        {
          table: 'recipes',
          row: {
            id: recipeId,
            name: recipeName,
            total_kcal: 696,
            total_protein_g: 54,
            total_carb_g: 120,
            total_fat_g: 2.4,
            created_at: now,
            servings: 3,
            total_weight_g: 600,
          },
        },
        {
          table: 'recipe_items',
          row: { id: `${recipeId}_${foodId}`, recipe_id: recipeId, food_id: foodId, quantity: 600 },
        },
      ],
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
});

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Recipes' }).click();
}

test('share a recipe, then another account adds and logs it', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'one run is enough: it changes shared state');
  const cookPage = await (await browser.newContext()).newPage();
  await signIn(cookPage, cook);
  const row = cookPage.locator('.row').filter({ hasText: recipeName });
  await row.getByRole('button', { name: 'Share' }).click();
  await expect(row.getByRole('button', { name: 'Update shared' })).toBeVisible();

  const page = await (await browser.newContext()).newPage();
  await signIn(page, friend);
  await page.getByLabel('Search the shared library').fill(recipeName);
  const shared = page.getByTestId('shared-recipe').filter({ hasText: recipeName });
  await expect(shared).toContainText('by e2e');
  await shared.click();
  await expect(page.getByRole('dialog')).toContainText('Red lentils, cooked');
  await page.getByRole('dialog').getByRole('button', { name: 'Add to my recipes' }).click();
  await expect(page.locator('.row').filter({ hasText: recipeName }).first()).toContainText(
    '232 kcal per serving',
  );

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Diary' }).click();
  await page.getByRole('button', { name: 'Log food' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Recipes' }).click();
  await page.getByTestId('recipe-result').filter({ hasText: recipeName }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Log', exact: true }).click();
  const entry = page.getByTestId('entry').filter({ hasText: recipeName });
  await expect(entry).toContainText('232');
  await entry.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(entry).toHaveCount(0);
});
