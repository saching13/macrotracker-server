import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

/** Open sign-up (the e2e stack runs with SIGNUP=open): create an account from the sign-in page. */
test('create an account from the web page', async ({ page }) => {
  const email = `signup-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name (optional)').fill('New Person');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('a-long-password-1');
  await page.getByLabel('Confirm password').fill('a-long-password-2');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toHaveText('The passwords don’t match.');

  await page.getByLabel('Confirm password').fill('a-long-password-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  // Signed in: the app's navigation shows up.
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();

  // The same email can't sign up twice.
  await page.context().clearCookies();
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('a-long-password-1');
  await page.getByLabel('Confirm password').fill('a-long-password-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('already exists');
});
