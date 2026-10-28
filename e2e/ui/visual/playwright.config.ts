import { defineConfig } from '@playwright/test';

// The visual suite: screenshots live in e2e/__screenshots__ as <name>.png (light and dark, 1440 px
// wide). Run with `pnpm test:visual`. Update them intentionally, with a note in the commit.
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1, // parallel workers contend for CPU and make canvas and ELK timing flaky
  reporter: [['list']],
  snapshotPathTemplate: '{testDir}/../../__screenshots__/{arg}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' } },
  use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
});
