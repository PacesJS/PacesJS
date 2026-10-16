import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', preload: 'src/preload.ts' },
  format: ['esm', 'cjs'],
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
});
