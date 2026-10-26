import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { readSession } from '../packages/format/dist/index.js';
import { ROOT, ZOO, openAndClose, removeDir, runPaces, tempDir } from './helpers/cli.js';
import { engineReady } from './helpers/engine.js';

interface ZooApp {
  name: string;
  command: string[];
  minTracks: number;
  /** Finding kind the app is built to trigger (the engine owns the final word). */
  finding: string;
}

// Planted problems per the zoo README names; replace with the engine's decision if it differs.
function findingFor(): Record<string, string> {
  return {
    'hot-regex': 'hot-function',
    'sync-io': 'sync-io',
    'rxjs-chain': 'async-overhead',
    'gc-heavy': 'gc-pressure',
    'worker-imbalance': 'hot-function',
    'late-require': 'late-module-loading',
  };
}
const FINDING_BY_APP = findingFor();

// Servers that run until stopped by hand. `paces` prints the session URL only after the target
// exits, and a test cannot stop one on Windows (SIGINT kills it), so these cannot be driven here.
const INTERACTIVE = new Set(['api-server']);

const apps: ZooApp[] = [
  ...readdirSync(join(ZOO, 'apps'))
    .filter((f) => f.endsWith('.cjs') && !f.startsWith('_'))
    .filter((f) => !INTERACTIVE.has(f.replace(/\.cjs$/, '')))
    .map((f) => f.replace(/\.cjs$/, ''))
    .map((name) => ({
      name,
      command: ['node', `zoo/apps/${name}.cjs`],
      minTracks: name === 'worker-imbalance' ? 3 : 1,
      finding: FINDING_BY_APP[name] ?? 'unknown',
    })),
  {
    name: 'orders-server',
    command: ['node', 'zoo/orders-server/dist/server.js'],
    minTracks: 2,
    finding: FINDING_BY_APP['orders-server'] ?? 'unknown',
  },
];

let ready = false;
test.beforeAll(async () => {
  ready = await engineReady();
});

for (const app of apps) {
  test.describe(app.name, () => {
    test.skip(
      app.name === 'orders-server' && !existsSync(join(ZOO, 'orders-server', 'dist', 'server.js')),
      'run `pnpm fixtures` to build zoo/orders-server',
    );

    test('profiles through the CLI and saves a session with the expected tracks', async () => {
      const dir = tempDir();
      const out = join(dir, `${app.name}.paces`);
      try {
        const run = await runPaces(['--no-open', '--out', out, '--', ...app.command], {
          onUrl: async (url) => {
            await openAndClose(url);
          },
        });
        expect(run.code, run.stderr).toBe(0);
        expect(existsSync(out)).toBe(true);
        const session = readSession(new Uint8Array(readFileSync(out)));
        expect(session.manifest.tracks.length).toBeGreaterThanOrEqual(app.minTracks);
        expect(session.manifest.command).toEqual(app.command);
        expect(session.capture.tracks.every((t) => (t.cpuProfile?.samples.length ?? 0) > 0)).toBe(
          true,
        );
        expect(run.stderr).toContain(out);
      } finally {
        removeDir(dir);
      }
    });

    test('summary reports the planted finding', async () => {
      test.skip(!ready, 'the engine does not export analyze/serializeModel/buildAgentSummary yet');
      test.skip(app.finding === 'unknown', 'no single planted finding is defined for this app');
      const dir = tempDir();
      const out = join(dir, `${app.name}.paces`);
      try {
        await runPaces(['--no-open', '--out', out, '--', ...app.command], {
          onUrl: async (url) => {
            await openAndClose(url);
          },
        });
        const summary = await runPaces(['summary', out, '--json']);
        expect(summary.code, summary.stderr).toBe(0);
        const parsed = JSON.parse(summary.stdout) as { findings: Array<{ kind: string }> };
        // Live timings vary with machine load, so extra findings can appear near a threshold.
        // That every app yields ONLY its finding is asserted on committed captures in the engine tests.
        expect(parsed.findings.map((f) => f.kind)).toContain(app.finding);
      } finally {
        removeDir(dir);
      }
    });
  });
}

test('the repo root is the project root recorded for zoo runs', async () => {
  const dir = tempDir();
  const out = join(dir, 'x.paces');
  try {
    await runPaces(['--no-open', '--out', out, '--', 'node', 'zoo/apps/hot-regex.cjs'], {
      onUrl: async (url) => {
        await openAndClose(url);
      },
    });
    const session = readSession(new Uint8Array(readFileSync(out)));
    expect(session.manifest.projectRoot.replaceAll('\\', '/').toLowerCase()).toBe(
      ROOT.replaceAll('\\', '/').toLowerCase(),
    );
  } finally {
    removeDir(dir);
  }
});
