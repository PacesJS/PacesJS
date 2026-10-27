import { describe, expect, it } from 'vitest';
import { createSessionController } from '../src/session-controller.js';
import type { ControllerOptions } from '../src/session-controller.js';
import type { TraceEvent } from '../src/trace.js';
import { FakeCdp } from './helpers/fake-cdp.js';

const OPTIONS: ControllerOptions = {
  screenshots: true,
  startPaused: false,
  fullTrace: false,
  keepQuery: false,
  hiRes: false,
};

const ev = (name: string, ts: number, extra: Partial<TraceEvent> = {}): TraceEvent => ({
  name,
  cat: 'devtools.timeline',
  ph: 'X',
  ts,
  dur: 1,
  pid: 1,
  tid: 1,
  ...extra,
});

const jpeg = (n: number): Uint8Array => Uint8Array.from([0xff, 0xd8, n, 0xff, 0xd9]);

function setup(overrides: Partial<ControllerOptions> = {}) {
  const cdp = new FakeCdp();
  const phases: string[] = [];
  let epoch = 1_000_000;
  const controller = createSessionController({
    cdp,
    options: { ...OPTIONS, ...overrides },
    syncClock: (n) => Promise.resolve(n * 10 + 5),
    now: () => (epoch += 100),
    onChange: (state) => phases.push(state.phase),
  });
  return { cdp, controller, phases };
}

const startedWith = (cdp: FakeCdp): Record<string, unknown> | undefined =>
  cdp.calls.find((c) => c.method === 'Tracing.start')?.params;

describe('createSessionController', () => {
  it('starts tracing on the browser, not on a page, so it outlives the page', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    const call = cdp.calls.find((c) => c.method === 'Tracing.start');
    expect(call).toBeDefined();
    expect(call?.sessionId).toBeUndefined();
    expect(controller.state().phase).toBe('recording');
  });

  it('never asks the trace for screenshots: the screencast takes them', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    const config = startedWith(cdp)?.traceConfig as { includedCategories: string[] };
    expect(config.includedCategories.join(',')).not.toMatch(/screenshot/);
  });

  it('never asks for the toplevel category', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    const config = startedWith(cdp)?.traceConfig as { includedCategories: string[] };
    expect(config.includedCategories).not.toContain('toplevel');
  });

  it('records the clock sync that follows each tracing start', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    cdp.nextTrace = [ev('Layout', 50), ev('Paint', 90)];
    const recording = await controller.stop();
    expect(recording.segments).toHaveLength(1);
    expect(recording.segments[0]?.syncs).toEqual([{ n: 1, epochMs: 15 }]);
  });

  it('bounds a segment by the first and last event it collected', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    cdp.nextTrace = [ev('Layout', 50), ev('Paint', 90, { dur: 10 })];
    const recording = await controller.stop();
    expect(recording.segments[0]).toMatchObject({ startUs: 50, endUs: 100 });
  });

  it('leaves out events stamped long before tracing started, which are not part of the segment', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    cdp.nextTrace = [
      ev('BeginFrame', 20_000, { ph: 'I', dur: 0 }),
      ev('TracingStartedInBrowser', 10_000_000, { ph: 'I', dur: 0 }),
      ev('Layout', 10_050_000),
      ev('Paint', 10_090_000, { dur: 10_000 }),
    ];
    const recording = await controller.stop();
    expect(recording.segments[0]).toMatchObject({ startUs: 10_000_000, endUs: 10_100_000 });
    expect(recording.events.map((e) => e.name)).not.toContain('BeginFrame');
  });

  it('pausing ends tracing and the controller reports paused only after the flush', async () => {
    const { cdp, controller, phases } = setup();
    await controller.start();
    cdp.nextTrace = [ev('Layout', 10)];
    await controller.pause();
    expect(cdp.methods()).toContain('Tracing.end');
    expect(controller.state().phase).toBe('paused');
    expect(phases).toContain('pausing');
  });

  it('resuming starts a new segment', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    cdp.nextTrace = [ev('Layout', 10)];
    await controller.pause();
    await controller.resume();
    cdp.nextTrace = [ev('Layout', 500)];
    const recording = await controller.stop();
    expect(recording.segments.map((s) => s.startUs)).toEqual([10, 500]);
    expect(cdp.methods().filter((m) => m === 'Tracing.start')).toHaveLength(2);
  });

  it('keeps a screenshot taken while recording', async () => {
    const { controller } = setup();
    await controller.start();
    controller.addScreenshot(1_000_100, jpeg(1));
    const recording = await controller.stop();
    expect(recording.screenshots.frames.map((f) => f.epochMs)).toEqual([1_000_100]);
  });

  it('keeps no screenshot taken while paused, or before the first start', async () => {
    const { cdp, controller } = setup({ startPaused: true });
    await controller.start();
    controller.addScreenshot(1, jpeg(1));
    await controller.resume();
    cdp.nextTrace = [ev('Layout', 10)];
    await controller.pause();
    controller.addScreenshot(2, jpeg(2));
    await controller.resume();
    controller.addScreenshot(3, jpeg(3));
    cdp.nextTrace = [];
    const recording = await controller.stop();
    expect(recording.screenshots.frames.map((f) => f.epochMs)).toEqual([3]);
  });

  it('keeps no screenshot when screenshots are switched off', async () => {
    const { controller } = setup({ screenshots: false });
    await controller.start();
    controller.addScreenshot(1, jpeg(1));
    expect((await controller.stop()).screenshots.frames).toEqual([]);
  });

  it('starting paused starts no tracing until the first resume', async () => {
    const { cdp, controller } = setup({ startPaused: true });
    await controller.start();
    expect(cdp.methods()).not.toContain('Tracing.start');
    expect(controller.state().phase).toBe('ready');
    await controller.resume();
    expect(cdp.methods()).toContain('Tracing.start');
    expect(controller.state().phase).toBe('recording');
  });

  it('treats pause and resume as idempotent', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    await Promise.all([controller.pause(), controller.pause()]);
    await Promise.all([controller.resume(), controller.resume()]);
    expect(cdp.methods().filter((m) => m === 'Tracing.end')).toHaveLength(1);
    expect(cdp.methods().filter((m) => m === 'Tracing.start')).toHaveLength(2);
  });

  it('stopping a paused run starts no tracing and ends none', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    cdp.nextTrace = [ev('Layout', 10)];
    await controller.pause();
    const recording = await controller.stop();
    expect(cdp.methods().filter((m) => m === 'Tracing.end')).toHaveLength(1);
    expect(recording.segments).toHaveLength(1);
  });

  it('keeps manual marks added while paused', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    cdp.nextTrace = [];
    await controller.pause();
    controller.mark('after login');
    const recording = await controller.stop();
    expect(recording.marks.map((m) => [m.label, m.kind])).toEqual([['after login', 'manual']]);
  });

  it('labels a blank mark with its number', async () => {
    const { controller } = setup();
    await controller.start();
    controller.mark('');
    controller.mark('  ');
    const recording = await controller.stop();
    expect(recording.marks.map((m) => m.label)).toEqual(['Mark 1', 'Mark 2']);
  });

  it('filters collected events and reports what it dropped', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    cdp.nextTrace = [ev('Layout', 10), ev('V8.BytecodeBudgetInterrupt', 11)];
    const recording = await controller.stop();
    expect(recording.events.map((e) => e.name)).toEqual(['Layout']);
    expect(recording.filter.droppedByName['V8.BytecodeBudgetInterrupt']).toBe(1);
  });

  it('ignores a request to start tracing twice', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    await controller.start();
    expect(cdp.methods().filter((m) => m === 'Tracing.start')).toHaveLength(1);
  });

  it('hands back what it has collected so far when the browser goes away', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    cdp.nextTrace = [ev('Layout', 10)];
    await controller.pause();
    controller.mark('before');
    expect(controller.partial().segments).toHaveLength(1);
    expect(controller.partial().marks.map((m) => m.label)).toEqual(['before']);
  });
});
