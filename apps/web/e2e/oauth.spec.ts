import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';

/** plan-11 S8: an MCP connector signs in through the consent page, then shows up in Settings. */
const email = process.env.E2E_EMAIL ?? 'e2e@example.test';
const password = process.env.E2E_PASSWORD ?? 'e2e-password-1234';
const redirect = 'http://localhost:9/callback';

test('consent page sends the connector back with a code', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'one run is enough');
  const reg = await request.post('/oauth/register', {
    data: { client_name: 'Test connector', redirect_uris: [redirect], token_endpoint_auth_method: 'none' },
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'abc',
  });

  await page.goto(`/oauth/authorize?${params}`);
  await expect(page.getByRole('heading', { name: 'Allow Test connector?' })).toBeVisible();
  await expect(page.getByText('Log food and weight')).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  const back = page.waitForRequest((r) => r.url().startsWith(redirect));
  await page.getByRole('button', { name: 'Sign in and allow' }).click();
  const url = new URL((await back).url());
  expect(url.searchParams.get('state')).toBe('abc');

  const tok = await request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code: url.searchParams.get('code')!,
      redirect_uri: redirect,
      client_id,
      code_verifier: verifier,
    },
  });
  expect(tok.ok(), await tok.text()).toBe(true);

  // It's listed under Settings › Connected apps, and can be disconnected.
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Settings' }).click();
  const row = page.locator('.row').filter({ hasText: 'Test connector' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Disconnect' }).click();
  await expect(row).toHaveCount(0);
});
