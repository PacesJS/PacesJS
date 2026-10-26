import { defineConfig } from 'vitest/config';

// The transport test spawns processes; a cold CI runner needs more than 5 s.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 } });
