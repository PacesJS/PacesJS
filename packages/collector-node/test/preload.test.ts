import { describe, expect, it } from 'vitest';
import { rawFiles, readRaw, runWithPreload } from './helpers/run.js';

const BUSY = 'function busy(){let x=0;for(let i=0;i<3e7;i++)x+=Math.sqrt(i);return x}';

describe('preload', () => {
  it('writes a V8 cpuprofile on normal exit', async () => {
    const r = await runWithPreload(['-e', `${BUSY};busy()`]);
    expect(r.code).toBe(0);
    const files = rawFiles(r.dir);
    const prof = files.find((f) => f.endsWith('.cpuprofile'));
    expect(prof).toBeDefined();
    const profile = JSON.parse(readRaw(r.dir, prof!));
    expect(profile.samples.length).toBeGreaterThan(10);
    expect(
      profile.nodes.some(
        (n: { callFrame: { functionName: string } }) => n.callFrame.functionName === 'busy',
      ),
    ).toBe(true);
  });

  it('flushes when the app calls process.exit()', async () => {
    const r = await runWithPreload(['-e', `${BUSY};busy();process.exit(3)`]);
    expect(r.code).toBe(3);
    expect(rawFiles(r.dir).some((f) => f.endsWith('.cpuprofile'))).toBe(true);
  });

  it('flushes and still rethrows on an uncaught exception', async () => {
    const r = await runWithPreload(['-e', `${BUSY};busy();throw new Error('boom')`]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('boom');
    expect(rawFiles(r.dir).some((f) => f.endsWith('.cpuprofile'))).toBe(true);
  });

  it('records script URLs and source map URLs', async () => {
    const r = await runWithPreload(['-e', `${BUSY};busy()`]);
    const scripts = rawFiles(r.dir).find((f) => f.endsWith('.scripts'));
    expect(scripts).toBeDefined();
    const parsed = JSON.parse(readRaw(r.dir, scripts!));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty('scriptId');
    expect(parsed[0]).toHaveProperty('url');
  });

  it('registers worker threads as separate tracks', async () => {
    const code = `${BUSY};const {Worker}=require('node:worker_threads');
      const w=new Worker(${JSON.stringify(`${BUSY};busy()`)},{eval:true});
      w.on('exit',()=>{busy()})`;
    const r = await runWithPreload(['-e', code]);
    const profiles = rawFiles(r.dir).filter((f) => f.endsWith('.cpuprofile'));
    expect(profiles.length).toBe(2);
  });

  it('does nothing when PACES_DIR is not set', async () => {
    const r = await runWithPreload(['-e', 'console.log("hi")'], { PACES_DIR: '' });
    expect(r.stdout.trim()).toBe('hi');
    expect(r.stderr).toBe('');
  });
});

describe('preload with ESM targets', () => {
  it('profiles an ES module entry point through --require alone', async () => {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { newSessionDir } = await import('./helpers/run.js');
    const app = join(newSessionDir(), 'app.mjs');
    writeFileSync(app, `${BUSY};import {sqrt} from './x.mjs';busy();`);
    writeFileSync(join(app, '..', 'x.mjs'), 'export const sqrt = Math.sqrt;');
    const r = await runWithPreload([app]);
    expect(r.code).toBe(0);
    const prof = rawFiles(r.dir).find((f) => f.endsWith('.cpuprofile'));
    expect(prof).toBeDefined();
    const scripts = JSON.parse(
      readRaw(
        r.dir,
        rawFiles(r.dir).find((f) => f.endsWith('.scripts'))!,
      ),
    );
    expect(scripts.some((s: { url: string }) => s.url.endsWith('app.mjs'))).toBe(true);
  });
});
