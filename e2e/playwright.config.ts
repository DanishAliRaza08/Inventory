import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a running stack (API on :4000 with DEMO_MODE=true and the demo
 * seed, web on :3000). See docs/08-delivery-plan-and-testing.md.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: process.env.CHROMIUM_PATH } } },
  ],
});
