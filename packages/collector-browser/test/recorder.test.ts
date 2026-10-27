import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRecording } from '../src/recorder.js';
import type { BrowserRecording, RecordOptions } from '../src/recorder.js';
// @ts-expect-error the zoo server is plain JavaScript
import { startZoo } from '../../../zoo/browser/server.mjs';

// Needs a real Chromium: PACES_BROWSER=<path to chrome.exe | msedge.exe | chrome>.
const exe = process.env.PACES_BROWSER;

interface Zoo {
  url(page: string): string;
  close(): Promise<unknown>;
}

describe.runIf(exe)('startRecording (real browser)', () => {
  let zoo: Zoo;
  beforeAll(async () => {
    zoo = (await startZoo()) as Zoo;
  });
  afterAll(async () => {
    await zoo.close();
  });

  const record = async (
    page: string,
    extra: Partial<RecordOptions> = {},
  ): Promise<BrowserRecording> => {
    const run = await startRecording({
      url: zoo.url(page),
      exe: exe ?? '',
      screenshots: true,
      startPaused: false,
      fullTrace: false,
      keepQuery: false,
      hiRes: false,
      overlay: true,
      eventMarks: true,
      eventText: true,
      cacheCold: false,
      durationMs: 2500,
      ...extra,
    });
    return run.done;
  };

  it('records CPU samples, parsed scripts and the page click, with the page intact', async () => {
    const recording = await record('slow-click');
    const chunks = recording.events.filter((e) => e.name === 'ProfileChunk');
    expect(chunks.length).toBeGreaterThan(0);
    expect(recording.scripts.some((s) => s.url.endsWith('/slow-click.html'))).toBe(true);
    expect(recording.marks.some((m) => m.kind === 'click' && m.label.includes('Save'))).toBe(true);
    expect(recording.endedBy).toBe('duration');
  }, 60_000);

  it('starts the run when the trace has started, not before it was asked for', async () => {
    let tracingSince = 0;
    const recording = await record('slow-click', {
      onState: (s) => {
        if (s.phase === 'recording' && tracingSince === 0) tracingSince = Date.now();
      },
    });
    expect(tracingSince).toBeGreaterThan(0);
    expect(recording.startedAt).toBeGreaterThanOrEqual(tracingSince);
  }, 60_000);

  it('never records the injected script as a page script', async () => {
    const recording = await record('slow-click');
    expect(recording.scripts.some((s) => s.url.startsWith('paces://'))).toBe(false);
  }, 60_000);

  it('embeds the source text of page scripts', async () => {
    const recording = await record('slow-click');
    expect(recording.sources.some((s) => s.text.includes('busy(220)'))).toBe(true);
  }, 60_000);

  it('records no query strings or fragments in the stored URLs', async () => {
    const recording = await record('slow-click');
    const navigations = recording.marks.filter((m) => m.kind === 'navigate').map((m) => m.label);
    const urls = [recording.url, ...recording.scripts.map((s) => s.url), ...navigations];
    expect(urls.filter((u) => /[?#]/.test(u))).toEqual([]);
  }, 60_000);

  it('starts no tracing when started paused', async () => {
    const recording = await record('slow-click', { startPaused: true });
    expect(recording.segments).toEqual([]);
    expect(recording.events.filter((e) => e.name === 'ProfileChunk')).toEqual([]);
  }, 60_000);

  it('keeps a secret typed into a field out of everything it recorded', async () => {
    const recording = await record('privacy');
    const typed = recording.marks.filter((m) => m.kind === 'typing');
    expect(typed.length).toBeGreaterThan(0);
    expect(JSON.stringify(recording)).not.toContain('hunter2');
  }, 60_000);

  it('pauses and resumes into two segments that leave a gap', async () => {
    const run = await startRecording({
      url: zoo.url('slow-click'),
      exe: exe ?? '',
      screenshots: true,
      startPaused: false,
      fullTrace: false,
      keepQuery: false,
      hiRes: false,
      overlay: true,
      eventMarks: true,
      eventText: true,
      cacheCold: false,
    });
    await run.controller.pause();
    expect(run.controller.state().phase).toBe('paused');
    run.controller.mark('while paused');
    await run.controller.resume();
    const recording = await run.stop();
    expect(recording.segments).toHaveLength(2);
    const [first, second] = recording.segments;
    expect(second?.startUs).toBeGreaterThan(first?.endUs ?? Infinity);
    expect(recording.marks.map((m) => m.label)).toContain('while paused');
  }, 60_000);

  it('stops by itself shortly after the page has loaded when asked to wait for load', async () => {
    const started = Date.now();
    const recording = await record('slow-click', { durationMs: undefined, until: 'load' });
    expect(recording.endedBy).toBe('duration');
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(recording.events.some((e) => e.name === 'loadEventEnd')).toBe(true);
  }, 60_000);

  it('stops after the network goes quiet when asked to wait for idle', async () => {
    const recording = await record('slow-click', { durationMs: undefined, until: 'idle' });
    expect(recording.endedBy).toBe('duration');
    expect(recording.events.some((e) => e.name === 'loadEventEnd')).toBe(true);
  }, 60_000);

  it('applies a pause, a resume and a mark that the page sends through the same bridge as the overlay', async () => {
    const recording = await record('controls', { durationMs: 5000 });
    expect(recording.segments).toHaveLength(2);
    expect(recording.marks.filter((m) => m.kind === 'manual').map((m) => m.label)).toEqual([
      'from the page',
    ]);
    const [first, second] = recording.segments;
    expect((second?.startUs ?? 0) - (first?.endUs ?? 0)).toBeGreaterThan(500_000);
  }, 60_000);

  it('keeps the trace when the user closes the window, and says that is how it ended', async () => {
    const run = await startRecording({
      url: zoo.url('slow-click'),
      exe: exe ?? '',
      screenshots: true,
      startPaused: false,
      fullTrace: false,
      keepQuery: false,
      hiRes: false,
      overlay: true,
      eventMarks: true,
      eventText: true,
      cacheCold: false,
    });
    // Wait for the page's own click (a mark), then close every page as the user closing the window does.
    const end = Date.now() + 20_000;
    while (!run.controller.state().marks && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
      if (run.controller.state().elapsedMs > 3000) break;
    }
    const { targetInfos } = (await run.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string }>;
    };
    for (const t of targetInfos.filter((x) => x.type === 'page')) {
      await run.cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
    }
    const recording = await run.done;
    expect(recording.endedBy).toBe('window-closed');
    expect(recording.events.filter((e) => e.name === 'ProfileChunk').length).toBeGreaterThan(0);
    expect(recording.warnings.map((w) => w.kind)).not.toContain('trace-incomplete');
    expect(recording.sources.some((x) => x.text.includes('busy(220)'))).toBe(true);
  }, 60_000);
});
