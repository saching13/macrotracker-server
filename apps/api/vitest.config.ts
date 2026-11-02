import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/int/**/*.test.ts'],
          globalSetup: ['test/int/global-setup.ts'],
          testTimeout: 20_000,
          hookTimeout: 30_000,
          // One shared database; files run one at a time.
          fileParallelism: false,
        },
      },
    ],
  },
});
