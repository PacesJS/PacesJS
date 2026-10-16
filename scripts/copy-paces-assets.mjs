// Copies what the CLI serves or injects next to dist/cli.js: the preload and the UI bundle.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const pkg = resolve(import.meta.dirname, '..', 'packages', 'paces');
const dist = join(pkg, 'dist');
mkdirSync(dist, { recursive: true });

const preload = join(pkg, '..', 'collector-node', 'dist', 'preload.cjs');
if (!existsSync(preload)) throw new Error('Build @pacesjs/collector-node first (pnpm build).');
cpSync(preload, join(dist, 'preload.cjs'));

const ui = join(pkg, '..', 'ui', 'dist');
rmSync(join(dist, 'ui'), { recursive: true, force: true });
if (existsSync(join(ui, 'index.html'))) cpSync(ui, join(dist, 'ui'), { recursive: true });
else console.warn('paces: packages/ui has no build yet; the CLI will serve a placeholder page.');
