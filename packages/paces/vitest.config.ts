import { defineConfig } from 'vitest/config';

// Tests spawn node and powershell and analyze large captures; a cold CI runner needs more than 5 s.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 } });
