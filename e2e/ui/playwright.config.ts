import { defineConfig } from '@playwright/test';

// UI end-to-end config: screenshots live in e2e/__screenshots__ as <name>.png (light and dark,
// 1440 px wide). Run with `pnpm --filter @pacesjs/ui test:e2e`.
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1, // parallel workers contend for CPU and make canvas and ELK timing flaky
  reporter: [['list']],
  snapshotPathTemplate: '{testDir}/../__screenshots__/{arg}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' } },
  use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
});
