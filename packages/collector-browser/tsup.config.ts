import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  // shared is bundled so the published package keeps zero runtime dependencies.
  noExternal: ['@pacesjs/shared'],
  clean: true,
});
