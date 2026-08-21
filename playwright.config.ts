import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].filter(Boolean) as string[];

const CHROMIUM_PATH = CANDIDATES.find((path) => existsSync(path));

/**
 * The app is a pure client-side PWA, so the suite runs against a production
 * preview build. Two projects cover the mobile-first target and the desktop
 * layout, since navigation and menus differ between them.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The sandbox ships a pinned Chromium that may not match this Playwright
    // build's expected revision, so point at it explicitly when it exists.
    launchOptions: { executablePath: CHROMIUM_PATH },
  },
  projects: [
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], browserName: 'chromium' },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: {
    command: 'npm run preview -- --port 4173 --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
