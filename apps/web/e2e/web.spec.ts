import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page, test } from '@playwright/test';

/**
 * plan-11 S5 exit: sign in → log food → the dashboard updates → edit and
 * delete. The account is seeded the way a phone would (a sync bootstrap), so
 * the dashboard has a trend and the diary has targets to compare against.
 */
const email = process.env.E2E_EMAIL ?? 'e2e@example.test';
const password = process.env.E2E_PASSWORD ?? 'e2e-password-1234';

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function seed(request: APIRequestContext) {
  const login = await request.post('/v1/auth/login', {
    data: { email, password, device: { name: 'e2e phone', platform: 'other' }, client: 'app' },
  });
  expect(login.ok(), await login.text()).toBe(true);
  const { access_token } = (await login.json()) as { access_token: string };
  const now = new Date().toISOString();
  const goalId = randomUUID();
  const rows: { table: string; row: Record<string, unknown> }[] = [
    {
      table: 'user_profile',
      row: {
        id: 'me',
        sex: 'female',
        birth_date: '1990-04-12',
        height_cm: 168,
        activity_seed: 'lightly_active',
        unit_mass: 'kg',
        unit_energy: 'kcal',
        created_at: now,
      },
    },
    {
      table: 'goals',
      row: {
        id: goalId,
        goal_type: 'lose',
        start_date: daysAgo(14),
        start_weight_kg: 72,
        target_weight_kg: 66,
        rate_value: 0.5,
        rate_unit: 'mass_per_week',
        status: 'active',
        created_at: now,
        ended_at: null,
      },
    },
  ];
  for (let i = 14; i >= 1; i--) {
    rows.push({
      table: 'weight_entries',
      row: {
        id: randomUUID(),
        local_date: daysAgo(i),
        weight_kg: 72 - (14 - i) * 0.07,
        source: 'manual',
        health_uuid: null,
        created_at: now,
      },
    });
  }
  const res = await request.post('/v1/sync/bootstrap', {
    headers: { authorization: `Bearer ${access_token}` },
    data: { schema_version: 11, rows },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

/** A tab in the tab bar. */
const tab = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name }).click();

const kcalToday = (page: Page) => page.getByTestId('macro-kcal').locator('.value');

test.beforeAll(async ({ request }) => {
  await seed(request);
});

test('sign in, log a food, see the dashboard follow, edit and delete it', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('Trend weight').first()).toBeVisible();
  await expect(kcalToday(page)).toHaveText('0');

  // Log 120 g of a USDA food.
  await tab(page, 'Diary');
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await page.getByRole('button', { name: 'Log food' }).click();
  const sheet = page.getByRole('dialog', { name: 'Log food' });
  await sheet.getByPlaceholder('Search foods').fill('banana raw');
  await sheet.getByTestId('food-result').filter({ hasText: 'Bananas, raw' }).first().click();
  const amount = page.getByRole('dialog').getByLabel('Amount');
  await amount.fill('120');
  await page.getByRole('dialog').getByRole('button', { name: 'Log', exact: true }).click();

  const entry = page.getByTestId('entry').filter({ hasText: 'Bananas, raw' });
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('120 g');
  // USDA bananas: 89 kcal per 100 g.
  await expect(entry).toContainText('107');

  // The dashboard shows it.
  await tab(page, 'Dashboard');
  await expect(kcalToday(page)).toHaveText('107');

  // Double it in the diary.
  await tab(page, 'Diary');
  await page.getByTestId('entry').filter({ hasText: 'Bananas, raw' }).click();
  await page.getByRole('dialog').getByLabel('Amount').fill('240');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('entry').filter({ hasText: 'Bananas, raw' })).toContainText('214');

  // Quick add, then delete the banana.
  await page.getByRole('button', { name: 'Log food' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Quick add' }).click();
  await page.getByRole('dialog').getByLabel('Calories (kcal)').fill('300');
  await page.getByRole('dialog').getByRole('button', { name: 'Log', exact: true }).click();
  await expect(page.getByTestId('entry').filter({ hasText: 'Quick Add' })).toContainText('300');

  await page.getByTestId('entry').filter({ hasText: 'Bananas, raw' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('entry').filter({ hasText: 'Bananas, raw' })).toHaveCount(0);

  await tab(page, 'Dashboard');
  await expect(kcalToday(page)).toHaveText('300');

  // Clean up for the next project's run.
  await tab(page, 'Diary');
  await page.getByTestId('entry').filter({ hasText: 'Quick Add' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('entry')).toHaveCount(0);
});

test('a session survives a reload, and signing out ends it', async ({ page }) => {
  await signIn(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await tab(page, 'Settings');
  await page.getByRole('button', { name: 'Sign out' }).last().click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('logs a weigh-in and makes an access token', async ({ page }) => {
  await signIn(page);
  await tab(page, 'Weight');
  await page.getByLabel('Weight (kg)').fill('70.5');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('70.5 kg')).toBeVisible();
  await page.getByRole('button', { name: /Delete the weigh-in on Today/ }).click();
  await expect(page.getByText('70.5 kg')).toHaveCount(0);

  await tab(page, 'Settings');
  await page.getByLabel('Token name').fill(`e2e ${test.info().project.name}`);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('new-token')).toContainText('mt_pat_');
});
