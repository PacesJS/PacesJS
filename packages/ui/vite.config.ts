import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { pacesDevHost } from './dev/host-plugin.ts';

export default defineConfig({
  base: './',
  plugins: [react(), pacesDevHost()],
  worker: { format: 'es' },
  build: { outDir: 'dist', sourcemap: true },
  preview: { port: 4173, strictPort: true },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    // The golden screens render whole views in jsdom; a cold CI runner needs more than 5 s.
    testTimeout: 30_000,
  },
});
