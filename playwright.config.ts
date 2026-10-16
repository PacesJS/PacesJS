import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testIgnore: 'ui/**', // UI specs run from e2e/ui/playwright.config.ts (own server, own snapshot dir)
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
});
