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

describe('request events', () => {
  it('records HTTP requests handled by node:http servers', async () => {
    const code = `const http=require('node:http');
      const s=http.createServer((q,r)=>{r.statusCode=201;r.end('ok')});
      s.listen(0,()=>{http.get({port:s.address().port,path:'/orders?x=1'},(r)=>{r.resume();r.on('end',()=>s.close())})})`;
    const r = await runWithPreload(['-e', code]);
    const file = rawFiles(r.dir).find((f) => f.endsWith('.events'))!;
    const events = readRaw(r.dir, file)
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const req = events.find((e) => e.type === 'request');
    expect(req).toMatchObject({ method: 'GET', url: '/orders', status: 201 });
    expect(req.duration).toBeGreaterThanOrEqual(0);
  });

  it('records async init/before/after links only with PACES_ASYNC=1', async () => {
    const code = `${BUSY};Promise.resolve().then(()=>busy()).then(()=>setTimeout(()=>{},5))`;
    const on = await runWithPreload(['-e', code], { PACES_ASYNC: '1' });
    const off = await runWithPreload(['-e', code]);
    const parse = (r: { dir: string }) =>
      readRaw(
        r.dir,
        rawFiles(r.dir).find((f) => f.endsWith('.events'))!,
      )
        .split('\n')
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as {
              type: string;
              phase?: string;
              asyncType?: string;
              triggerAsyncId?: number;
            },
        );
    const asyncOn = parse(on).filter((e) => e.type === 'async');
    expect(asyncOn.some((e) => e.phase === 'init' && e.asyncType === 'PROMISE')).toBe(true);
    expect(asyncOn.some((e) => e.phase === 'before')).toBe(true);
    expect(asyncOn.some((e) => e.phase === 'init' && (e.triggerAsyncId ?? 0) > 0)).toBe(true);
    expect(parse(off).filter((e) => e.type === 'async')).toHaveLength(0);
  });
});

describe('V8 deoptimization trace', () => {
  const TRACED = { PACES_V8_TRACE: '1' };

  // `add` is optimized for small integers, then fed doubles and strings.
  const DEOPTING = `function add(a,b){return a+b}
    let t=0;
    for(let i=0;i<200000;i++)t+=add(i,1);
    for(let i=0;i<200000;i++)t+=add(i,0.5);
    for(let i=0;i<200000;i++)t+=add('a',i).length;
    console.log('done')`;

  it('writes the deoptimizations of a process next to its profile, with the position of each', async () => {
    const r = await runWithPreload(['-e', DEOPTING], TRACED);
    const trace = rawFiles(r.dir).find((f) => f.endsWith('.deopt'));
    expect(trace).toBeDefined();
    const text = readRaw(r.dir, trace!);
    expect(text).toMatch(
      /\[bailout \(kind: deopt-eager, reason: [^)]+\): begin\. deoptimizing .*<JSFunction add /,
    );
    expect(text).toMatch(/;;; deoptimize at <[^>]*:\d+:\d+>/);
  });

  it('is off unless asked for, and then leaves the program output exactly as it was', async () => {
    const r = await runWithPreload(['-e', DEOPTING]);
    expect(rawFiles(r.dir).some((f) => f.endsWith('.deopt'))).toBe(false);
    expect(r.stdout).toBe('done\n');
    expect(r.stderr).toBe('');
  });

  // V8 prints the tail of "[marking dependent code ...]" with a plain PrintF, past the redirect. The
  // CLI documents this for --v8; if V8 fixes it, this test fails and the warning can go.
  it('lets V8 print the tail of its dependent-code messages to stdout (known V8 behavior)', async () => {
    const code = `function Foo(){}
      Foo.prototype.x=1;
      function get(o){return o.x}
      const o=new Foo();
      let t=0;
      for(let i=0;i<300000;i++)t+=get(o);
      Object.setPrototypeOf(Foo.prototype,{y:1});
      for(let i=0;i<300000;i++)t+=get(o);
      console.log('done')`;
    const r = await runWithPreload(['-e', code], TRACED);
    expect(r.stdout).toMatch(/^\) \(opt id \d+\) for deoptimization, reason: [^\]]+\]$/m);
    expect(r.stdout).toContain('done');
  });

  it('keeps worker deoptimizations in the process file instead of starting a second one', async () => {
    const worker = `${DEOPTING}`;
    const code = `const {Worker}=require('node:worker_threads');
      new Worker(${JSON.stringify(worker)},{eval:true}).on('exit',()=>{${DEOPTING}})`;
    const r = await runWithPreload(['-e', code], TRACED);
    expect(rawFiles(r.dir).filter((f) => f.endsWith('.deopt'))).toHaveLength(1);
  });
});
