import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readCaptureDir } from '../src/capture-dir.js';
import { newSessionDir, rawFiles, runWithPreload } from './helpers/run.js';

const BUSY = 'function busy(){let x=0;for(let i=0;i<2e7;i++)x+=Math.sqrt(i);return x}';
const META = {
  command: ['node', 'app.js'],
  cwd: process.cwd(),
  nodeVersion: process.version,
  platform: process.platform,
  mode: 'default' as const,
  intervalUs: 1000,
  startedAt: Date.now(),
  endedAt: Date.now() + 100,
  endedBy: 'exit' as const,
  projectRoot: process.cwd(),
};

describe('readCaptureDir', () => {
  it('builds tracks for a process and its worker thread, linked by parent', async () => {
    const code = `${BUSY};const {Worker}=require('node:worker_threads');
      new Worker(${JSON.stringify(`${BUSY};busy()`)},{eval:true}).on('exit',()=>busy())`;
    const r = await runWithPreload(['-e', code]);
    const capture = readCaptureDir(r.dir, META);
    expect(capture.tracks).toHaveLength(2);
    const main = capture.tracks.find((t) => t.info.kind === 'process')!;
    const worker = capture.tracks.find((t) => t.info.kind === 'worker')!;
    expect(worker.info.parent).toBe(main.info.id);
    expect(worker.info.threadId).toBeGreaterThan(0);
    expect(main.cpuProfile?.samples.length).toBeGreaterThan(5);
    expect(main.scripts.length).toBeGreaterThan(0);
  });

  it('links a child process to the process that spawned it', async () => {
    const code = `${BUSY};require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(`${BUSY};busy()`)}],{stdio:'inherit'});busy()`;
    const r = await runWithPreload(['-e', code]);
    const capture = readCaptureDir(r.dir, META);
    expect(capture.tracks).toHaveLength(2);
    const child = capture.tracks.find((t) => t.info.parent !== undefined)!;
    expect(capture.tracks.some((t) => t.info.id === child.info.parent)).toBe(true);
  });

  it('reads source maps referenced by file next to the script, and ignores missing ones', () => {
    const dir = newSessionDir();
    const raw = join(dir, 'raw');
    mkdirSync(raw, { recursive: true });
    const src = join(dir, 'app.js');
    writeFileSync(src, '//# sourceMappingURL=app.js.map');
    writeFileSync(
      join(dir, 'app.js.map'),
      '{"version":3,"sources":["a.ts"],"names":[],"mappings":"AAAA"}',
    );
    const url = pathToFileURL(src).href;
    writeFileSync(
      join(raw, 'p1.scripts'),
      JSON.stringify([
        { scriptId: '1', url, sourceMapURL: 'app.js.map', hash: 'h' },
        { scriptId: '2', url: 'file:///nowhere/x.js', sourceMapURL: 'x.js.map', hash: 'h' },
      ]),
    );
    writeFileSync(
      join(raw, 'p1.info'),
      JSON.stringify({ pid: 1, threadId: 0, argv: [], cwd: dir }),
    );
    const capture = readCaptureDir(dir, META);
    expect(Object.keys(capture.sourceMaps)).toEqual([url]);
    expect(rawFiles(dir)).toContain('p1.info');
  });
});
