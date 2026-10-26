import { describe, expect, it } from 'vitest';
import { recordingToCapture, traceToCapture } from '../../src/trace/trace-to-capture.js';
import { cloneInput } from '../helpers/browser-fixtures.js';

const capture = (name: Parameters<typeof cloneInput>[0]) => recordingToCapture(cloneInput(name));

describe('recordingToCapture: tracks', () => {
  it('makes one page track for a single page, named for its host', () => {
    const tracks = capture('slow-click').tracks;
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.info.kind).toBe('page');
    expect(tracks[0]?.info.label).toMatch(/^Page · 127\.0\.0\.1:\d+$/);
  });

  it('names the page, the cross-site iframe and the worker, not their pids', () => {
    const labels = capture('worker-and-iframe')
      .tracks.map((t) => [t.info.kind, t.info.label.replace(/:\d+$/, ':PORT')])
      .sort();
    expect(labels).toEqual([
      ['frame', 'iframe · localhost:PORT'],
      ['page', 'Page · 127.0.0.1:PORT'],
      ['worker', 'Worker · worker.js'],
    ]);
  });

  it('puts the worker under the page that started it', () => {
    const tracks = capture('worker-and-iframe').tracks;
    const page = tracks.find((t) => t.info.kind === 'page');
    const worker = tracks.find((t) => t.info.kind === 'worker');
    expect(worker?.info.parent).toBe(page?.info.id);
  });

  it('records the document URL and origin of a page track', () => {
    const info = capture('slow-click').tracks[0]?.info;
    expect(info?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/slow-click\.html$/);
    expect(info?.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('gives every profiled thread a CPU profile with samples', () => {
    for (const t of capture('worker-and-iframe').tracks) {
      expect(t.cpuProfile?.samples.length).toBeGreaterThan(0);
    }
  });
});

describe('recordingToCapture: profiles', () => {
  it('gives call frames string script ids and -1 positions for native frames', () => {
    const nodes = capture('slow-click').tracks[0]?.cpuProfile?.nodes ?? [];
    const root = nodes.find((n) => n.callFrame.functionName === '(root)');
    expect(root?.callFrame.lineNumber).toBe(-1);
    expect(typeof nodes[0]?.callFrame.scriptId).toBe('string');
  });

  it('links children to parents', () => {
    const nodes = capture('slow-click').tracks[0]?.cpuProfile?.nodes ?? [];
    const withKids = nodes.filter((n) => (n.children?.length ?? 0) > 0);
    expect(withKids.length).toBeGreaterThan(0);
  });

  it('fills in the URL of inline page scripts from the debugger, since the trace has none', () => {
    const nodes = capture('slow-click').tracks[0]?.cpuProfile?.nodes ?? [];
    const busy = nodes.find((n) => n.callFrame.functionName === 'busy');
    expect(busy?.callFrame.url).toMatch(/\/slow-click\.html$/);
  });

  it('attributes the same script id in two processes to the right page', () => {
    const tracks = capture('worker-and-iframe').tracks;
    const frame = tracks.find((t) => t.info.kind === 'frame');
    const frameWork = frame?.cpuProfile?.nodes.find(
      (n) => n.callFrame.functionName === 'frameWork',
    );
    expect(frameWork?.callFrame.url).toMatch(/\/frame\.html$/);
    const page = tracks.find((t) => t.info.kind === 'page');
    const pageWork = page?.cpuProfile?.nodes.find((n) => n.callFrame.functionName === 'pageWork');
    expect(pageWork?.callFrame.url).toMatch(/\/worker-and-iframe\.html$/);
  });

  it('lists the scripts each track ran', () => {
    const page = capture('third-party').tracks[0];
    const urls = (page?.scripts ?? []).map((s) => s.url.replace(/:\d+/, ':PORT'));
    expect(urls).toContain('http://localhost:PORT/tracker.js');
  });

  it('keeps the injected script out of the track script list', () => {
    const urls = capture('slow-click').tracks[0]?.scripts.map((s) => s.url) ?? [];
    expect(urls.some((u) => u.startsWith('paces://'))).toBe(false);
  });

  it('hands over the source maps the host fetched', () => {
    expect(capture('slow-click').sourceMaps).toEqual({});
  });
});

describe('recordingToCapture: segments', () => {
  it('records both segments and merges their profiles into one per thread', () => {
    const c = capture('paused-resume');
    expect(c.browser?.segments).toHaveLength(2);
    expect(c.tracks).toHaveLength(1);
  });

  it('bills the pause to an idle sample, not to the last function that ran', () => {
    const profile = capture('paused-resume').tracks[0]?.cpuProfile;
    const nameOf = (id: number | undefined) =>
      profile?.nodes.find((n) => n.id === id)?.callFrame.functionName;
    // A sample lasts until the next one starts, so the long delta after the idle sample is the pause.
    const longGaps = (profile?.timeDeltas ?? [])
      .map((delta, i) => [delta, profile?.samples[i - 1]] as const)
      .filter(([delta]) => delta > 500_000);
    expect(longGaps).toHaveLength(1);
    expect(nameOf(longGaps[0]?.[1])).toBe('(idle)');
  });

  it('keeps a single segment as one profile', () => {
    expect(capture('slow-click').browser?.segments).toHaveLength(1);
  });
});

describe('recordingToCapture: timeline and page events', () => {
  it('keeps the exact events of the main thread', () => {
    const names = new Set(capture('slow-click').tracks[0]?.timeline?.map((e) => e.name));
    for (const n of ['RunTask', 'EventDispatch', 'Layout', 'Paint'])
      expect(names.has(n)).toBe(true);
  });

  it('names an event dispatch by the event type', () => {
    const dispatches = capture('slow-click').tracks[0]?.timeline?.filter(
      (e) => e.name === 'EventDispatch',
    );
    expect(dispatches?.some((e) => e.arg === 'click')).toBe(true);
  });

  it('keeps the frame pipeline and the loading milestones as page events', () => {
    const names = new Set(capture('slow-click').browser?.page.map((e) => e.name));
    for (const n of ['DrawFrame', 'firstContentfulPaint', 'navigationStart']) {
      expect(names.has(n)).toBe(true);
    }
  });

  it('carries the score of a layout shift', () => {
    const shifts = capture('layout-shift').browser?.page.filter((e) => e.name === 'LayoutShift');
    expect(shifts?.length).toBeGreaterThan(0);
    expect(shifts?.[0]?.n).toBeGreaterThan(0.1);
  });

  it('counts the layouts of a forced-layout page', () => {
    const layouts = capture('forced-layout').tracks[0]?.timeline?.filter(
      (e) => e.name === 'Layout',
    );
    expect(layouts?.length).toBeGreaterThan(100);
  });
});

describe('recordingToCapture: meta', () => {
  it('describes the run from the recording', () => {
    const c = capture('slow-click');
    expect(c.meta.command[0]).toBe('browser');
    expect(c.meta.endedBy).toBe('duration');
    expect(c.browser?.product).toMatch(/^Edg\/|^Chrome\//);
    expect(c.browser?.url).toMatch(/slow-click\.html$/);
  });

  it('turns marks into capture marks with their kind', () => {
    const marks = capture('slow-click').meta.marks ?? [];
    expect(marks.some((m) => m.kind === 'navigate')).toBe(true);
    expect(marks.some((m) => m.kind === 'click' && m.label.includes('Save'))).toBe(true);
  });

  it('places an automatic event on the trace clock when the trace has its stamp', () => {
    const input = cloneInput('slow-click');
    const c = recordingToCapture(input);
    const click = c.meta.marks?.find((m) => m.kind === 'click');
    const raw = input.marks?.find((m) => m.kind === 'click');
    expect(Math.abs((click?.at ?? 0) - (raw?.at ?? 0))).toBeLessThan(50);
  });

  it('records the filter that produced the trace', () => {
    expect(capture('slow-click').browser?.traceFilter?.version).toBe(1);
  });

  it('places a screenshot taken at a wall-clock time on the trace clock', () => {
    const input = cloneInput('slow-click');
    const at = input.startedAt + 1000;
    const c = recordingToCapture({ ...input, screenshots: [{ id: 0, epochMs: at }] });
    const shot = c.browser?.screenshots[0];
    expect(((shot?.tsUs ?? 0) + (c.browser?.clock.offsetUs ?? 0)) / 1000).toBeCloseTo(at, 3);
  });

  it('keeps a screenshot that already has a time on the trace clock', () => {
    const c = recordingToCapture({
      ...cloneInput('slow-click'),
      screenshots: [{ id: 3, tsUs: 123_456 }],
    });
    expect(c.browser?.screenshots).toEqual([{ id: 3, tsUs: 123_456 }]);
  });

  it('records the screenshot index without the bytes', () => {
    const shots = capture('slow-click').browser?.screenshots ?? [];
    expect(shots.length).toBeGreaterThan(0);
    expect(Object.keys(shots[0] ?? {}).sort()).toEqual(['id', 'tsUs']);
  });
});

describe('traceToCapture: files exported from DevTools or Node', () => {
  const options = { name: 'trace.json', cwd: '/proj', mtimeMs: 5_000_000 };

  it('reads the frame list a DevTools trace carries, naming the page, its iframe and its worker', () => {
    // A DevTools export lists its frames in TracingStartedInBrowser. The recorded trace has the
    // same frames and processes, so the list is built from them, not invented.
    const input = cloneInput('worker-and-iframe');
    const pidOf = new Map<string, number>();
    for (const e of input.events) {
      const a = e.args as { frame?: string; data?: { frame?: string } } | undefined;
      const frame = a?.frame ?? a?.data?.frame;
      if (frame && e.name === 'TimeStamp') pidOf.set(frame, e.pid);
    }
    const frames = (input.targets ?? []).map((t, i) => ({
      frame: t.id,
      url: t.url,
      processId: pidOf.get(t.id),
      isInPrimaryMainFrame: t.type === 'page',
      ...(t.type === 'page' ? {} : { parent: input.targets?.[0]?.id }),
      order: i,
    }));
    const events = [
      ...input.events,
      {
        name: 'TracingStartedInBrowser',
        ph: 'I',
        ts: 1,
        pid: 1,
        tid: 1,
        args: { data: { frames } },
      },
    ];
    const kinds = traceToCapture(events, options)
      .tracks.map((t) => t.info.kind)
      .sort();
    expect(kinds).toEqual(['frame', 'page', 'worker']);
  });

  it('says its clock is a guess, since a trace file has no wall-clock anchor', () => {
    const capture = traceToCapture(cloneInput('slow-click').events, options);
    expect(capture.browser?.clock.anchored).toBe(false);
  });

  it('ends at the age of the file and starts a run earlier', () => {
    const capture = traceToCapture(cloneInput('slow-click').events, options);
    expect(capture.meta.endedAt).toBe(5_000_000);
    expect(capture.meta.startedAt).toBeLessThan(5_000_000);
  });

  it('treats a trace with only CPU profile events as a plain profile, not a browser run', () => {
    const profileOnly = cloneInput('slow-click').events.filter(
      (e) => e.name === 'Profile' || e.name === 'ProfileChunk',
    );
    const capture = traceToCapture(profileOnly, options);
    expect(capture.browser).toBeUndefined();
    expect(capture.tracks[0]?.info.kind).toBe('process');
    expect(capture.tracks[0]?.info.label).toMatch(/^trace\.json · pid \d+ tid \d+$/);
  });
});
