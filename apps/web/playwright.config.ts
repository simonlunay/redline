import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the static export (run `npm run build -w apps/web` first), served
 * the way GitHub Pages serves it. Nothing here calls a paid API; the site can't.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // The score appears after the page, its fonts and images have loaded and the browser is idle;
  // on a busy machine that can take more than the default 5 s. A wait, never a result tolerance.
  expect: { timeout: 15_000 },
  fullyParallel: true,
  // One retry in CI only: a single unreproduced failure was seen locally once (see the phase 6 report).
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4174', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      testIgnore: /mobile.spec.ts/,
    },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: 'node scripts/serve-static.mjs 4174',
    url: 'http://localhost:4174/',
    reuseExistingServer: !process.env.CI,
  },
});
