import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const version = (path: string): string =>
  (JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version: string }).version;

// Everything is bundled so `npx @pacesjs/paces` installs with zero runtime dependencies (R5).
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  noExternal: [/.*/],
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __PACES_VERSION__: JSON.stringify(version('./package.json')),
    __ENGINE_VERSION__: JSON.stringify(version('../engine/package.json')),
  },
  onSuccess: 'node ../../scripts/copy-paces-assets.mjs',
});
