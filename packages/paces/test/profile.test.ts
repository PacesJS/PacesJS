import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultBrowserFlags, defaultReportFlags } from '../src/args.js';
import type { Flags } from '../src/args.js';
import { nodeOptionsWith, runProfile } from '../src/profile.js';
import type { ProfileControls } from '../src/profile.js';

const preload = createRequire(import.meta.url).resolve('@pacesjs/collector-node/preload.cjs');
const flags = (over: Partial<Flags> = {}): Flags => ({
  async: false,
  v8: false,
  embedSources: false,
  browser: defaultBrowserFlags(),
  noOpen: false,
  include: [],
  exclude: [],
  json: false,
  focus: [],
  report: defaultReportFlags(),
  ...over,
});
const base = { cwd: resolve(import.meta.dirname, '..'), preload };
const node = (code: string) => ['node', '-e', code];
const busy = 'let x=0;const t=Date.now();while(Date.now()-t<60){x+=Math.sqrt(x+1)}';

describe('nodeOptionsWith', () => {
  it('appends to existing NODE_OPTIONS and quotes the path with forward slashes', () => {
    expect(nodeOptionsWith('--max-old-space-size=512', 'C:\\Program Files\\p\\preload.cjs')).toBe(
      '--max-old-space-size=512 --require "C:/Program Files/p/preload.cjs"',
    );
  });

  it('sets NODE_OPTIONS when there is none', () => {
    expect(nodeOptionsWith(undefined, '/p/preload.cjs')).toBe('--require "/p/preload.cjs"');
  });
});

describe('runProfile with --v8', () => {
  // `add` is optimized for small integers, then fed doubles and strings.
  const deopting = `function add(a,b){return a+b}
    let t=0;
    for(let i=0;i<200000;i++)t+=add(i,1);
    for(let i=0;i<200000;i++)t+=add(i,0.5);
    for(let i=0;i<200000;i++)t+=add('a',i).length`;

  it('records the V8 deoptimization trace of the process', async () => {
    const r = await runProfile({ ...base, command: node(deopting), flags: flags({ v8: true }) });
    expect(r.capture.tracks[0]?.deoptTrace).toContain(';;; deoptimize at');
  }, 30_000);

  it('still reports a traced process that was killed as lost, with no track of its own', async () => {
    // Yield first: a process killed before its event loop turns never got to register with paces.
    const child = `setTimeout(()=>{${deopting};process.kill(process.pid,'SIGKILL')},400)`;
    const code = `require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'})`;
    const r = await runProfile({ ...base, command: node(code), flags: flags({ v8: true }) });
    expect(r.capture.tracks).toHaveLength(1);
    expect(r.capture.meta.lostTracks ?? []).toHaveLength(1);
  }, 30_000);

  it('records none unless asked, whatever the caller environment says', async () => {
    const before = process.env.PACES_V8_TRACE;
    process.env.PACES_V8_TRACE = '1';
    try {
      const r = await runProfile({ ...base, command: node(deopting), flags: flags() });
      expect(r.capture.tracks[0]).not.toHaveProperty('deoptTrace');
    } finally {
      if (before === undefined) delete process.env.PACES_V8_TRACE;
      else process.env.PACES_V8_TRACE = before;
    }
  }, 30_000);
});

describe('runProfile and killed processes', () => {
  const killed = resolve(import.meta.dirname, 'fixtures', 'killed-children.cjs');

  it('records the processes and workers that were killed before they could write a profile', async () => {
    const r = await runProfile({ ...base, command: ['node', killed], flags: flags() });
    expect(r.exitCode).toBe(0);
    expect(r.capture.tracks).toHaveLength(1);
    const lost = r.capture.meta.lostTracks ?? [];
    expect(lost).toHaveLength(3);
    expect(lost.filter((l) => l.kind === 'worker')).toHaveLength(1);
    expect(lost.every((l) => typeof l.pid === 'number' && l.label)).toBe(true);
  }, 30_000);

  it('leaves lostTracks unset when every process wrote its profile', async () => {
    const r = await runProfile({ ...base, command: node(busy), flags: flags() });
    expect(r.capture.meta.lostTracks).toBeUndefined();
  });
});

describe('runProfile with the program output redirected', () => {
  it('sends the program stdout to the given file descriptor, not to ours', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'paces-out-')), 'out.txt');
    const fd = openSync(file, 'w');
    try {
      await runProfile({
        ...base,
        command: node(`${busy};console.log('from the program')`),
        flags: flags(),
        stdoutFd: fd,
      });
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(file, 'utf8')).toContain('from the program');
  });
});

describe('runProfile', () => {
  it('captures one track from a plain node command and mirrors exit code 0', async () => {
    const r = await runProfile({ ...base, command: node(busy), flags: flags() });
    expect(r.exitCode).toBe(0);
    expect(r.capture.tracks).toHaveLength(1);
    expect(r.capture.tracks[0]?.cpuProfile?.samples.length).toBeGreaterThan(0);
    expect(r.capture.meta).toMatchObject({ mode: 'default', intervalUs: 1000, endedBy: 'exit' });
  });

  it('mirrors a non-zero exit code and still flushes the profile', async () => {
    const r = await runProfile({
      ...base,
      command: node(`${busy};process.exit(7)`),
      flags: flags(),
    });
    expect(r.exitCode).toBe(7);
    expect(r.capture.tracks[0]?.cpuProfile).toBeDefined();
  });

  it('records fine mode for a short interval', async () => {
    const r = await runProfile({ ...base, command: node(busy), flags: flags({ interval: 100 }) });
    expect(r.capture.meta).toMatchObject({ mode: 'fine', intervalUs: 100 });
  });

  it('keeps an existing NODE_OPTIONS in the child', async () => {
    const r = await runProfile({
      ...base,
      command: node(
        `process.exit(process.env.NODE_OPTIONS.includes('--max-old-space-size=300') ? 0 : 9)`,
      ),
      flags: flags(),
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=300' },
    });
    expect(r.exitCode).toBe(0);
  });

  it('registers a child process tree as separate linked tracks', async () => {
    const child = `require('child_process').spawnSync(process.execPath,['-e','${busy}'],{stdio:'inherit'})`;
    const r = await runProfile({ ...base, command: node(child), flags: flags() });
    const tracks = r.capture.tracks.map((t) => t.info);
    expect(tracks).toHaveLength(2);
    expect(tracks.filter((t) => t.parent !== undefined)).toHaveLength(1);
  });

  it('drops processes matching --exclude and keeps the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paces-excl-'));
    writeFileSync(join(dir, 'child.js'), busy);
    writeFileSync(
      join(dir, 'parent.js'),
      `require('child_process').spawnSync(process.execPath,[require('path').join(__dirname,'child.js')],{stdio:'inherit'});${busy}`,
    );
    const r = await runProfile({
      ...base,
      command: ['node', join(dir, 'parent.js')],
      flags: flags({ exclude: ['**/child.js'] }),
    });
    expect(r.capture.tracks).toHaveLength(1);
    expect(r.capture.tracks[0]?.info.parent).toBeUndefined();
  });

  it('promotes a track to root when its parent was filtered out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paces-orphan-'));
    writeFileSync(join(dir, 'child.js'), busy);
    writeFileSync(
      join(dir, 'parent.js'),
      `require('child_process').spawnSync(process.execPath,[require('path').join(__dirname,'child.js')],{stdio:'inherit'});${busy}`,
    );
    const r = await runProfile({
      ...base,
      command: ['node', join(dir, 'parent.js')],
      flags: flags({ exclude: ['**/parent.js'] }),
    });
    expect(r.capture.tracks).toHaveLength(1);
    expect(r.capture.tracks[0]?.info.parent).toBeUndefined();
  });

  it('fails clearly when no Node process registers', async () => {
    const command = process.platform === 'win32' ? ['cmd', '/c', 'exit', '0'] : ['true'];
    await expect(runProfile({ ...base, command, flags: flags() })).rejects.toThrow(
      /No Node process loaded the profiler/,
    );
  });

  it('fails clearly when the command does not exist', async () => {
    await expect(
      runProfile({ ...base, command: ['definitely-not-a-command-xyz'], flags: flags() }),
    ).rejects.toThrow(/not found/);
  });

  it('on interrupt: flushes, then runs the app own SIGINT handler and mirrors its exit code', async () => {
    const app = `
      process.on('SIGINT', () => { setTimeout(() => process.exit(42), 10); });
      const t = setInterval(() => { let x = 0; for (let i = 0; i < 1e5; i++) x += i; }, 5);
      require('fs').writeFileSync(process.env.READY, '1');`;
    const ready = join(mkdtempSync(join(tmpdir(), 'paces-ready-')), 'ready');
    let trigger: () => void = () => {};
    const result = runProfile({
      ...base,
      command: node(app),
      flags: flags(),
      env: { ...process.env, READY: ready },
      onInterrupt: (h) => {
        trigger = h;
        return () => {};
      },
    });
    await waitFor(() => existsSync(ready), 15);
    trigger();
    const r = await result;
    expect(r.exitCode).toBe(42);
    expect(r.capture.meta.endedBy).toBe('sigint');
    expect(r.capture.tracks[0]?.cpuProfile?.samples.length).toBeGreaterThan(0);
  }, 20_000);

  it('with --duration: stops profiling after the window and leaves the app running', async () => {
    const app = `setInterval(() => { let x = 0; for (let i = 0; i < 1e5; i++) x += i; }, 5);`;
    const r = await runProfile({ ...base, command: node(app), flags: flags({ duration: 1 }) });
    expect(r.capture.meta.endedBy).toBe('duration');
    expect(r.capture.tracks[0]?.cpuProfile?.samples.length).toBeGreaterThan(0);
    expect(r.child).toBeDefined();
    await r.child?.stop();
  }, 20_000);

  it.runIf(process.platform !== 'win32')(
    'with --start-on: waits for the signal',
    async () => {
      let fire: () => void = () => {};
      const app = `setInterval(() => { let x = 0; for (let i = 0; i < 1e5; i++) x += i; }, 5); setTimeout(() => process.exit(0), 1500);`;
      const run = runProfile({
        ...base,
        command: node(app),
        flags: flags({ startOn: 'SIGUSR2' }),
        onSignal: (_s, h) => {
          fire = h;
          return () => {};
        },
      });
      await new Promise((r) => setImmediate(r));
      fire();
      const r = await run;
      expect(r.capture.tracks[0]?.cpuProfile?.samples.length).toBeGreaterThan(0);
    },
    20_000,
  );

  it.runIf(process.platform === 'win32')(
    'refuses --start-on on Windows with a way forward',
    async () => {
      await expect(
        runProfile({ ...base, command: node(busy), flags: flags({ startOn: 'SIGUSR2' }) }),
      ).rejects.toThrow(/--duration/);
    },
  );
});

describe('runProfile controls', () => {
  const spin = `setInterval(() => { let x = 0; for (let i = 0; i < 1e5; i++) x += i; }, 5);`;
  const readyFile = (): string => join(mkdtempSync(join(tmpdir(), 'paces-ready-')), 'ready');
  const withReady = (body: string): string =>
    `${body} require('fs').writeFileSync(process.env.READY, String(process.pid));`;

  function attached() {
    const box: { controls?: ProfileControls; detached: boolean } = { detached: false };
    return {
      box,
      attach: (c: ProfileControls) => {
        box.controls = c;
        return () => {
          box.detached = true;
        };
      },
    };
  }

  it('records the marks the user adds, numbered and in order, inside the run', async () => {
    const ready = readyFile();
    const a = attached();
    const run = runProfile({
      ...base,
      command: node(withReady(`${spin} setTimeout(() => process.exit(0), 1200);`)),
      flags: flags(),
      env: { ...process.env, READY: ready },
      attach: a.attach,
    });
    await waitFor(() => existsSync(ready), 15);
    const first = a.box.controls?.mark();
    await new Promise((r) => setTimeout(r, 50));
    const second = a.box.controls?.mark();
    const r = await run;
    expect(first?.label).toBe('Mark 1');
    expect(second?.label).toBe('Mark 2');
    expect(r.capture.meta.marks).toEqual([first, second]);
    const [m1, m2] = r.capture.meta.marks ?? [];
    expect(m1?.at).toBeGreaterThanOrEqual(r.capture.meta.startedAt);
    expect(m2?.at).toBeGreaterThan(m1?.at ?? Infinity);
    expect(m2?.at).toBeLessThanOrEqual(r.capture.meta.endedAt);
    expect(a.box.detached).toBe(true);
  }, 20_000);

  it('leaves meta.marks unset when none were added', async () => {
    const r = await runProfile({ ...base, command: node(busy), flags: flags() });
    expect(r.capture.meta.marks).toBeUndefined();
  });

  it('reports how many processes have registered and how many marks there are', async () => {
    const ready = readyFile();
    const a = attached();
    const run = runProfile({
      ...base,
      command: node(withReady(`${spin} setTimeout(() => process.exit(0), 1200);`)),
      flags: flags(),
      env: { ...process.env, READY: ready },
      attach: a.attach,
    });
    await waitFor(() => (a.box.controls?.state().processes ?? 0) > 0, 15);
    a.box.controls?.mark();
    expect(a.box.controls?.state()).toEqual({ processes: 1, marks: 1 });
    await run;
  }, 20_000);

  it('stops profiling and ends the program at once on stop, keeping what was collected', async () => {
    const ready = readyFile();
    const a = attached();
    const run = runProfile({
      ...base,
      command: node(withReady(spin)),
      flags: flags(),
      env: { ...process.env, READY: ready },
      attach: a.attach,
    });
    await waitFor(() => (a.box.controls?.state().processes ?? 0) > 0, 15);
    await new Promise((r) => setTimeout(r, 200));
    a.box.controls?.stop();
    const r = await run;
    expect(r.capture.meta.endedBy).toBe('stop');
    expect(r.exitCode).toBe(0);
    expect(r.capture.tracks[0]?.cpuProfile?.samples.length).toBeGreaterThan(0);
    const pid = Number(readFileSync(ready, 'utf8'));
    await waitFor(() => !isAlive(pid), 5);
  }, 30_000);

  it('says when a profiled program reads process.stdin, once', async () => {
    const ready = readyFile();
    const a = attached();
    const run = runProfile({
      ...base,
      command: node(
        withReady(
          `process.stdin.on('data', () => {}); ${spin} setTimeout(() => process.exit(0), 1500);`,
        ),
      ),
      flags: flags(),
      env: { ...process.env, READY: ready },
      attach: (c) => {
        a.attach(c);
        c.onStdinUsed(() => {
          used++;
        });
        return () => {};
      },
    });
    let used = 0;
    await waitFor(() => a.box.controls?.stdinUsed() === true, 15);
    await run;
    expect(used).toBe(1);
  }, 20_000);

  it('reports a program that reads stdin through readline', async () => {
    const a = attached();
    const run = runProfile({
      ...base,
      command: node(
        `require('readline').createInterface({ input: process.stdin }); ${spin} setTimeout(() => process.exit(0), 1000);`,
      ),
      flags: flags(),
      attach: a.attach,
    });
    await waitFor(() => a.box.controls?.stdinUsed() === true, 15);
    await run;
  }, 20_000);

  it('does not report a program that only looks at process.stdin without reading it', async () => {
    const a = attached();
    const run = runProfile({
      ...base,
      command: node(`process.stdin.isTTY; ${spin} setTimeout(() => process.exit(0), 800);`),
      flags: flags(),
      attach: a.attach,
    });
    await run;
    expect(a.box.controls?.stdinUsed()).toBe(false);
  }, 20_000);

  it('gives the program an empty stdin, not the keyboard, when paces holds it for the hotkeys', async () => {
    // A program waiting on the keyboard would never end; with no stdin it sees the end at once.
    const result = await runProfile({
      ...base,
      command: node(
        `process.stdin.on('end', () => process.exit(7)); process.stdin.resume(); ${spin}`,
      ),
      flags: flags(),
      holdStdin: true,
    });
    expect(result.exitCode).toBe(7);
  }, 20_000);

  it('does not report stdin use for a program that never touches it', async () => {
    const a = attached();
    const run = runProfile({
      ...base,
      command: node(`${spin} setTimeout(() => process.exit(0), 800);`),
      flags: flags(),
      attach: a.attach,
    });
    await run;
    expect(a.box.controls?.stdinUsed()).toBe(false);
  }, 20_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs * 1000;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
