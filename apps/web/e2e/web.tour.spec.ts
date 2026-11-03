import { expect, test } from '@playwright/test';

/**
 * A visual tour for reviewing the design (light and dark, phone width):
 * `SCREENSHOTS=1 make e2e` writes them to test-results/screens/. Runs after
 * web.spec.ts has seeded the account.
 */
test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1');

for (const scheme of ['light', 'dark'] as const) {
  test(`screens (${scheme})`, async ({ page }, info) => {
    test.skip(info.project.name !== 'phone');
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    await page.getByLabel('Email').fill(process.env.E2E_EMAIL!);
    await page.getByLabel('Password').fill(process.env.E2E_PASSWORD!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Sections' });
    const shot = (name: string) =>
      page.screenshot({ path: `test-results/screens/${scheme}-${name}.png`, fullPage: true });
    await shot('dashboard');
    await nav.getByRole('link', { name: 'Diary' }).click();
    await page.getByRole('button', { name: 'Log food' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Quick add' }).click();
    await page.getByRole('dialog').getByLabel('Calories (kcal)').fill('420');
    await page.getByRole('dialog').getByRole('button', { name: 'Log', exact: true }).click();
    await page.getByRole('button', { name: 'Log food' }).click();
    await page.getByRole('dialog').getByPlaceholder('Search foods').fill('oats');
    await expect(page.getByTestId('food-result').first()).toBeVisible();
    await shot('log-food');
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await shot('diary');
    await nav.getByRole('link', { name: 'Weight' }).click();
    await expect(page.getByText('Last 60 days')).toBeVisible();
    await shot('weight');
    await nav.getByRole('link', { name: 'Settings' }).click();
    await shot('settings');
  });
}
