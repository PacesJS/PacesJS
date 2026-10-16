// Overhead benchmark: runs CPU-bound and promise-heavy workloads with and without the collector.
// The collector is injected exactly as the CLI does (NODE_OPTIONS --require preload + PACES_* env).
// Reports the median in-process work time (what the budget is about) and total process time
// (adds start-up and the exit-flush that writes the profile).
// Usage: node scripts/bench-overhead.mjs [--runs N] [--json]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const preload = join(root, 'packages', 'collector-node', 'dist', 'preload.cjs').replaceAll(
  '\\',
  '/',
);
const workload = join(import.meta.dirname, 'bench-workload.cjs');
const args = process.argv.slice(2);
const runs = Number(args[args.indexOf('--runs') + 1]) || 9;
const asJson = args.includes('--json');
const WARMUP = 2;

const modes = [
  {
    name: 'default (1 ms)',
    budget: 5,
    workloads: ['cpu', 'promise'],
    env: { PACES_INTERVAL: '1000' },
  },
  {
    name: '--interval 100',
    budget: 15,
    workloads: ['cpu', 'promise'],
    env: { PACES_INTERVAL: '100' },
  },
  {
    name: '--async',
    budget: 20,
    workloads: ['promise', 'cpu'],
    env: { PACES_INTERVAL: '1000', PACES_ASYNC: '1' },
  },
];

function once(kind, env) {
  const dir = env ? mkdtempSync(join(tmpdir(), 'paces-bench-')) : undefined;
  const started = performance.now();
  const r = spawnSync(process.execPath, [workload, kind], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(env
        ? { NODE_OPTIONS: `--require "${preload}"`, PACES_DIR: dir, PACES_SESSION: 'bench', ...env }
        : { NODE_OPTIONS: '' }),
    },
  });
  const totalMs = performance.now() - started;
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`workload failed: ${r.stderr}`);
  return { workMs: JSON.parse(r.stdout.trim().split('\n').at(-1)).workMs, totalMs };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const results = [];
for (const mode of modes) {
  for (const kind of mode.workloads) {
    const base = [];
    const tool = [];
    for (let i = 0; i < WARMUP + runs; i++) {
      // Interleave so thermal and background noise hits both sides equally.
      const b = once(kind);
      const t = once(kind, mode.env);
      if (i >= WARMUP) {
        base.push(b);
        tool.push(t);
      }
    }
    const work = median(tool.map((x) => x.workMs)) / median(base.map((x) => x.workMs)) - 1;
    const total = median(tool.map((x) => x.totalMs)) / median(base.map((x) => x.totalMs)) - 1;
    results.push({
      mode: mode.name,
      workload: kind,
      budgetPct: mode.budget,
      baseWorkMs: Math.round(median(base.map((x) => x.workMs))),
      toolWorkMs: Math.round(median(tool.map((x) => x.workMs))),
      workOverheadPct: Number((work * 100).toFixed(1)),
      totalOverheadPct: Number((total * 100).toFixed(1)),
      withinBudget: work * 100 <= mode.budget,
      runs,
    });
  }
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(
    `Node ${process.version} on ${process.platform}, median of ${runs} runs after ${WARMUP} warm-ups\n`,
  );
  console.log(
    'mode             workload  base ms  tool ms  work overhead  total overhead  budget  verdict',
  );
  for (const r of results) {
    console.log(
      [
        r.mode.padEnd(16),
        r.workload.padEnd(9),
        String(r.baseWorkMs).padStart(7),
        String(r.toolWorkMs).padStart(8),
        `${r.workOverheadPct}%`.padStart(13),
        `${r.totalOverheadPct}%`.padStart(15),
        `${r.budgetPct}%`.padStart(7),
        r.withinBudget ? '  within' : '  OVER',
      ].join(' '),
    );
  }
}
