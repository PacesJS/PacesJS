import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// The real-browser tests open windows. Side by side they cover each other, and a covered window
// stops rendering, so a real mouse press in it is never seen: run the files one after the other.
// `*.browser.test.ts` run in Chromium through Vitest browser mode (the injected script is page code).
export default defineConfig({
  test: {
    testTimeout: 30_000,
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.browser.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['test/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
