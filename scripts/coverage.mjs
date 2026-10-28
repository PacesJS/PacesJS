// Runs each package's unit tests with V8 coverage and prints one table.
//   pnpm coverage                  every package
//   pnpm coverage engine ui        only these (folder names under packages/)
// Per-package HTML reports: packages/<name>/coverage/index.html.
// Only code run inside the test process is measured. The CLI and the collectors are mostly
// exercised in child processes (and the e2e suites), so their numbers undercount.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const all = readdirSync(join(root, 'packages')).filter(
  (n) =>
    existsSync(join(root, 'packages', n, 'vitest.config.ts')) ||
    existsSync(join(root, 'packages', n, 'vite.config.ts')),
);
const wanted = process.argv.slice(2);
const unknown = wanted.filter((n) => !all.includes(n));
if (unknown.length > 0) {
  console.error(`Unknown package: ${unknown.join(', ')}. Choose from: ${all.join(', ')}.`);
  process.exit(2);
}
const names = wanted.length > 0 ? wanted : all;

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const build = spawnSync(pnpm, ['build'], { cwd: root, stdio: 'inherit', shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const rows = [];
let failed = false;
for (const name of names) {
  const cwd = join(root, 'packages', name);
  const run = spawnSync(
    pnpm,
    [
      'exec',
      'vitest',
      'run',
      '--coverage',
      '--coverage.provider=v8',
      '--coverage.include=src/**',
      '--coverage.reporter=json-summary',
      '--coverage.reporter=html',
    ],
    { cwd, stdio: ['ignore', 'inherit', 'inherit'], shell: true },
  );
  if (run.status !== 0) failed = true;
  const file = join(cwd, 'coverage', 'coverage-summary.json');
  if (!existsSync(file)) continue;
  const total = JSON.parse(readFileSync(file, 'utf8')).total;
  rows.push({ name, ...pick(total) });
}

function pick(t) {
  return {
    lines: t.lines.pct,
    branches: t.branches.pct,
    functions: t.functions.pct,
    statements: t.statements.pct,
  };
}

const pad = (s, n) => String(s).padStart(n);
console.log(`\n${'package'.padEnd(18)}${pad('lines', 8)}${pad('branch', 8)}${pad('funcs', 8)}`);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(18)}${pad(`${r.lines}%`, 8)}${pad(`${r.branches}%`, 8)}${pad(`${r.functions}%`, 8)}`,
  );
}
console.log('\nHTML reports: packages/<name>/coverage/index.html');
process.exit(failed ? 1 : 0);
