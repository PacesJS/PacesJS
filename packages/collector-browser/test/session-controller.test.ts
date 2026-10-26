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

const shot = (ts: number, n: number): TraceEvent =>
  ev('Screenshot', ts, {
    cat: 'disabled-by-default-devtools.screenshot',
    ph: 'O',
    args: { snapshot: Buffer.from([0xff, 0xd8, n, 0xff, 0xd9]).toString('base64') },
  });

function setup(overrides: Partial<ControllerOptions> = {}) {
  const cdp = new FakeCdp();
  const phases: string[] = [];
  let epoch = 1_000_000;
  const controller = createSessionController({
    cdp,
    session: 'page-1',
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
  it('starts tracing on the page session and reports recording', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    const call = cdp.calls.find((c) => c.method === 'Tracing.start');
    expect(call?.sessionId).toBe('page-1');
    expect(controller.state().phase).toBe('recording');
  });

  it('requests the screenshot category only when screenshots are wanted', async () => {
    const withShots = setup();
    await withShots.controller.start();
    const without = setup({ screenshots: false });
    await without.controller.start();
    const included = (c: FakeCdp): string[] =>
      (startedWith(c)?.traceConfig as { includedCategories: string[] }).includedCategories;
    expect(included(withShots.cdp)).toContain('disabled-by-default-devtools.screenshot');
    expect(included(without.cdp)).not.toContain('disabled-by-default-devtools.screenshot');
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

  it('collects no screenshots while paused', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    cdp.nextTrace = [ev('Layout', 10), shot(11, 1)];
    await controller.pause();
    cdp.emit({
      method: 'Tracing.dataCollected',
      params: { value: [shot(20, 2)] },
      sessionId: 'page-1',
    });
    cdp.nextTrace = [];
    const recording = await controller.stop();
    expect(recording.screenshots.frames.map((f) => f.tsUs)).toEqual([11]);
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

  it('keeps the Screenshot events out of the trace and in the store', async () => {
    const { cdp, controller } = setup();
    await controller.start();
    cdp.nextTrace = [ev('Layout', 10), shot(20, 7)];
    const recording = await controller.stop();
    expect(recording.events.map((e) => e.name)).toEqual(['Layout']);
    expect(recording.screenshots.frames).toHaveLength(1);
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
