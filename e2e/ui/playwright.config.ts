import { defineConfig } from '@playwright/test';

// UI end-to-end config: the one test that needs a real browser's layout. Screenshots are the visual
// suite (visual/playwright.config.ts). Run with `pnpm --filter @pacesjs/ui test:e2e`.
export default defineConfig({
  testDir: '.',
  testIgnore: 'visual/**',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1, // parallel workers contend for CPU and make canvas and ELK timing flaky
  reporter: [['list']],
  use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
});
