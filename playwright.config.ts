import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4788',
    browserName: 'chromium',
    ...(process.env.CLEANSAVE_CHROME
      ? { launchOptions: { executablePath: process.env.CLEANSAVE_CHROME } }
      : {}),
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --import tsx tests/browser-server.ts',
    url: 'http://127.0.0.1:4788/health',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    timeout: 30000,
  },
});
