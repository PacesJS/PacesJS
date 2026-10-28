import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { readSession } from '../packages/format/dist/index.js';
import { ROOT, openAndClose, removeDir, runPaces, tempDir } from './helpers/cli.js';

// Live Node profiling, once, through the built CLI. What the profile holds for each kind of program
// (wrappers, workers, findings) is tested below this level, on real captures.
test('profiles a Node program through the built CLI and saves a session that finds its bottleneck', async () => {
  const dir = tempDir();
  const out = join(dir, 'hot-regex.paces');
  const command = ['node', 'zoo/apps/hot-regex.cjs'];
  try {
    const run = await runPaces(['--no-open', '--out', out, '--', ...command], {
      onUrl: async (url) => void (await openAndClose(url)),
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(out);

    const session = readSession(new Uint8Array(readFileSync(out)));
    expect(session.manifest.command).toEqual(command);
    expect(session.manifest.tracks).toHaveLength(1);
    expect(session.capture.tracks.every((t) => (t.cpuProfile?.samples.length ?? 0) > 0)).toBe(true);
    expect(session.capture.meta.cwd).toBe(ROOT);

    const summary = await runPaces(['summary', out, '--json']);
    const parsed = JSON.parse(summary.stdout) as { findings: Array<{ kind: string }> };
    // Live timings vary with load; that this app yields only its finding is asserted on committed captures.
    expect(parsed.findings.map((f) => f.kind)).toContain('hot-function');
  } finally {
    removeDir(dir);
  }
});
