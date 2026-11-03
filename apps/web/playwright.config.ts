import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a running server (API + built web app). Run with
 * `make e2e`, which starts a throwaway stack and an account first; it passes
 * E2E_URL, E2E_EMAIL and E2E_PASSWORD.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // One account for every test: run them one at a time.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
