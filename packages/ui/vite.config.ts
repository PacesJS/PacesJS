import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { pacesDevHost } from './dev/host-plugin.ts';

// Two kinds of test. `unit` is plain logic and runs in Node. `browser` renders React with Testing
// Library inside a real Chromium (Vitest browser mode), so layout, canvas, focus and hit testing are
// the browser's own: every `*.test.tsx` and every `*.browser.test.ts`.
const BROWSER_TESTS = ['test/**/*.test.tsx', 'test/**/*.browser.test.ts'];

export default defineConfig({
  base: './',
  plugins: [react(), pacesDevHost()],
  worker: { format: 'es' },
  build: { outDir: 'dist', sourcemap: true },
  preview: { port: 4173, strictPort: true },
  test: {
    // The golden screens render whole views; a cold CI runner needs more than 5 s.
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.browser.test.ts'],
        },
      },
      {
        extends: true,
        // The Node helper reads fixtures from disk; the browser one fetches them.
        resolve: {
          alias: [{ find: /(^|\/)real-model$/, replacement: '$1real-model.browser' }],
        },
        test: {
          name: 'browser',
          include: BROWSER_TESTS,
          setupFiles: ['./test/setup.browser.ts'],
          browser: {
            enabled: true,
            // Headless Chromium hides scrollbars by default; the gutters are part of what is tested.
            provider: playwright({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } }),
            headless: true,
            viewport: { width: 1440, height: 900 },
            commands: {
              goldenWrite: () => process.env['GOLDEN_WRITE'] === '1',
              // Re-records a golden file (GOLDEN_WRITE=1): a browser test cannot write to disk.
              writeGolden: (_context, name: string, text: string) =>
                writeFileSync(resolve(import.meta.dirname, 'test/baseline', name), text),
            },
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
