// Regenerates engine test fixtures by running every zoo app under the real collector.
// Usage: pnpm fixtures [app-name ...]   (builds packages first: pnpm build)
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const zoo = join(root, 'zoo');
const outDir = join(root, 'packages', 'engine', 'test', 'fixtures');
const collector = join(root, 'packages', 'collector-node', 'dist');
const { readCaptureDir } = await import(pathToFileURL(join(collector, 'index.js')).href);
const esbuild = createRequire(join(zoo, 'package.json'))('esbuild');

const only = process.argv.slice(2);
const forward = (p) => p.replaceAll('\\', '/');

// Apps: [name, entry file, build step]
const apps = [
  { name: 'orders-server', entry: join(zoo, 'orders-server', 'dist', 'server.js'), build: true },
  ...readdirSync(join(zoo, 'apps'))
    .filter((f) => f.endsWith('.cjs') && !f.startsWith('_'))
    .map((f) => ({ name: f.replace(/\.cjs$/, ''), entry: join(zoo, 'apps', f) })),
  // The same app with async hooks on: exact continuation edges.
  {
    name: 'async-chain-hooks',
    entry: join(zoo, 'apps', 'async-chain.cjs'),
    env: { PACES_ASYNC: '1' },
  },
];

async function buildOrdersServer() {
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    sourcemap: 'linked',
    outdir: join(zoo, 'orders-server', 'dist'),
    // Bundled output keeps real package paths in the source map, like a production build.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: 'warning',
  };
  await esbuild.build({
    ...common,
    entryPoints: [
      join(zoo, 'orders-server', 'src', 'server.ts'),
      join(zoo, 'orders-server', 'src', 'worker.ts'),
    ],
  });
}

// The collector writes argv and cwd to <track>.info; readCaptureDir does not surface them yet.
function surfaceArgv(capture, dir) {
  for (const track of capture.tracks) {
    const file = join(dir, 'raw', track.info.id + '.info');
    if (!existsSync(file)) continue;
    const info = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(info.argv)) track.info.argv = info.argv;
    if (typeof info.cwd === 'string') track.info.cwd = info.cwd;
  }
}

function redact(text) {
  // Order matters: the file URL form contains the forward-slash form.
  let out = text.replaceAll(pathToFileURL(root).href, 'file:///project');
  out = out.replaceAll(forward(root), '/project');
  return out.replaceAll(root.replaceAll('\\', '\\\\'), '/project');
}

mkdirSync(outDir, { recursive: true });
await buildOrdersServer();

for (const app of apps) {
  if (only.length && !only.includes(app.name)) continue;
  const dir = mkdtempSync(join(tmpdir(), `paces-fixture-${app.name}-`));
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [app.entry], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--require "${forward(join(collector, 'preload.cjs'))}"`,
      PACES_DIR: dir,
      PACES_SESSION: app.name,
      ...(app.env ?? {}),
    },
    stdio: 'inherit',
  });
  const endedAt = Date.now();
  if (result.status !== 0) throw new Error(`${app.name} exited with ${result.status}`);
  const capture = readCaptureDir(dir, {
    command: ['node', forward(app.entry).replace(forward(root), '.')],
    cwd: root,
    nodeVersion: process.version,
    platform: process.platform,
    mode: 'default',
    intervalUs: 1000,
    startedAt,
    endedAt,
    endedBy: 'exit',
    projectRoot: root,
  });
  surfaceArgv(capture, dir);
  const text = redact(JSON.stringify(capture));
  const file = join(outDir, `${app.name}.capture.json.gz`);
  writeFileSync(file, gzipSync(text, { level: 9 }));
  const tracks = capture.tracks.length;
  console.log(
    `${app.name}: ${tracks} track(s), ${(text.length / 1024).toFixed(0)} KB json, ${endedAt - startedAt} ms`,
  );
  rmSync(dir, { recursive: true, force: true });
}
