import { defineConfig } from 'vitest/config';

// The real-browser tests open windows. Side by side they cover each other, and a covered window
// stops rendering, so a real mouse press in it is never seen: run the files one after the other.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, fileParallelism: false },
});
