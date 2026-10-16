import { defineConfig } from 'tsup';

// Everything is bundled so `npx paces` installs with zero runtime dependencies (R5).
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  noExternal: [/.*/],
  clean: true,
});
