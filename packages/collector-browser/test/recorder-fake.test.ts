// The recorder against a stand-in for the browser end of the pipe: the run's whole life (launch, join,
// attach, navigate, mark, stop, close) without a real browser. The real-browser tests in
// recorder.test.ts only have to show that a real Chromium answers the way FakeCdp does.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaunchedBrowser } from '../src/launch.js';
import { BRIDGE_NAME } from '../src/inject/entry.js';
import { FakeCdp } from './helpers/fake-cdp.js';

const launched = vi.hoisted(() => ({ browser: undefined as unknown, kill: undefined as unknown }));

vi.mock('../src/launch.js', () => ({ launchBrowser: () => launched.browser }));
vi.mock('@pacesjs/shared', () => ({ removeDetached: vi.fn(), killTree: vi.fn() }));
vi.mock('../src/attach.js', () => ({
  discoverBrowserSocket: vi.fn(async () => 'ws://127.0.0.1:9222/devtools/browser/x'),
  connectCdp: vi.fn(async () => launched.browser),
}));

const { BrowserNotSupportedError, isChromiumProduct, startRecording } =
  await import('../src/recorder.js');
import type { RecordOptions } from '../src/recorder.js';

const OPTIONS: RecordOptions = {
  url: 'https://example.test/app?token=abc#frag',
  exe: 'chrome',
  overlay: true,
  eventMarks: true,
  eventText: false,
  cacheCold: false,
  screenshots: false,
  startPaused: false,
  fullTrace: false,
  keepQuery: false,
  hiRes: false,
  flushTimeoutMs: 1000,
};

const PAGE = { type: 'page', targetId: 'T1', url: 'about:blank' };

function browser(product = 'Chrome/130.0'): { cdp: FakeCdp; kill: ReturnType<typeof vi.fn> } {
  const cdp = new FakeCdp();
  cdp.replies['Browser.getVersion'] = { product };
  cdp.replies['Target.getTargets'] = { targetInfos: [PAGE] };
  cdp.replies['Target.attachToTarget'] = { sessionId: 'S1' };
  cdp.replies['Runtime.evaluate'] = { result: { value: Date.now() } };
  const kill = vi.fn();
  const exited = Promise.resolve(0);
  launched.browser = Object.assign(cdp, {
    client: cdp,
    exited,
    kill,
    disconnect: vi.fn(),
  }) as unknown as LaunchedBrowser;
  return { cdp, kill };
}

const bridge = (cdp: FakeCdp, message: object, sessionId = 'S1'): void =>
  cdp.emit({
    method: 'Runtime.bindingCalled',
    params: { name: BRIDGE_NAME, payload: JSON.stringify(message) },
    sessionId,
  });

let stopRun: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await stopRun?.().catch(() => undefined);
  stopRun = undefined;
});

async function run(options: Partial<RecordOptions> = {}) {
  const r = await startRecording({ ...OPTIONS, ...options });
  stopRun = () => r.stop();
  return r;
}

describe('isChromiumProduct', () => {
  it.each(['Chrome/130.0', 'Edg/130.0', 'HeadlessChrome/1', 'Brave/1', 'Vivaldi/6', 'OPR/110'])(
    'accepts %s',
    (product) => expect(isChromiumProduct(product)).toBe(true),
  );
  it.each(['Firefox/130', 'Safari/17', ''])('refuses %s', (product) =>
    expect(isChromiumProduct(product)).toBe(false),
  );
});

describe('a launched browser', () => {
  it('refuses a browser that is not Chromium, and closes it', async () => {
    const { kill } = browser('Firefox/130');
    await expect(startRecording(OPTIONS)).rejects.toBeInstanceOf(BrowserNotSupportedError);
    expect(kill).toHaveBeenCalled();
  });

  it('attaches to its first page, sets it up, injects the script and navigates', async () => {
    const { cdp } = browser();
    await run();
    const methods = cdp.methods();
    expect(methods).toContain('Target.attachToTarget');
    expect(methods).toContain('Page.addScriptToEvaluateOnNewDocument');
    expect(methods).toContain('Tracing.start');
    expect(methods.indexOf('Tracing.start')).toBeLessThan(methods.indexOf('Page.navigate'));
    const navigate = cdp.calls.find((c) => c.method === 'Page.navigate');
    expect(navigate?.params).toEqual({ url: OPTIONS.url });
    expect(navigate?.sessionId).toBe('S1');
  });

  it('waits for the first page to be announced when none is listed yet', async () => {
    const { cdp } = browser();
    cdp.replies['Target.getTargets'] = { targetInfos: [] };
    const starting = run();
    await vi.waitFor(() => expect(cdp.methods()).toContain('Target.getTargets'));
    cdp.emit({ method: 'Target.targetCreated', params: { targetInfo: PAGE } });
    await starting;
    expect(cdp.methods()).toContain('Target.attachToTarget');
  });

  it('stops on request: ends the trace, closes the browser and hands back the recording', async () => {
    const { cdp, kill } = browser();
    const r = await run();
    const recording = await r.stop();
    expect(recording).toMatchObject({
      product: 'Chrome/130.0',
      url: 'https://example.test/app',
      endedBy: 'stop',
      cacheCold: false,
    });
    expect(recording.endedAt).toBeGreaterThanOrEqual(recording.startedAt);
    expect(cdp.methods()).toContain('Tracing.end');
    expect(cdp.methods()).toContain('Browser.close');
    expect(kill).toHaveBeenCalled();
  });

  it('stops once, however many times it is asked', async () => {
    const { cdp } = browser();
    const r = await run();
    const [a, b] = await Promise.all([r.stop('sigint'), r.stop('stop')]);
    expect(a).toBe(b);
    expect(a.endedBy).toBe('sigint');
    expect(cdp.methods().filter((m) => m === 'Tracing.end')).toHaveLength(1);
  });

  it('resolves done with the same recording', async () => {
    browser();
    const r = await run();
    const recording = await r.stop();
    await expect(r.done).resolves.toBe(recording);
  });

  it('ends by itself after the duration it was given', async () => {
    browser();
    const r = await run({ durationMs: 30 });
    expect((await r.done).endedBy).toBe('duration');
  });

  it('ends when the user closes the browser, and says so', async () => {
    const { cdp } = browser();
    const r = await run();
    cdp.close();
    expect((await r.done).endedBy).toBe('window-closed');
  });

  it('ends when the last page is destroyed, but not when one of several is', async () => {
    const { cdp } = browser();
    const r = await run();
    cdp.emit({
      method: 'Target.targetCreated',
      params: { targetInfo: { ...PAGE, targetId: 'T2' } },
    });
    await vi.waitFor(() =>
      expect(cdp.calls.filter((c) => c.method === 'Target.attachToTarget')).toHaveLength(2),
    );
    cdp.emit({ method: 'Target.targetDestroyed', params: { targetId: 'T2' } });
    cdp.emit({ method: 'Target.targetDestroyed', params: { targetId: 'unknown' } });
    expect(cdp.methods()).not.toContain('Tracing.end');
    cdp.emit({ method: 'Target.targetDestroyed', params: { targetId: 'T1' } });
    expect((await r.done).endedBy).toBe('window-closed');
  });

  it('with --until load, stops shortly after the load event of its page only', async () => {
    const { cdp } = browser();
    const r = await run({ until: 'load' });
    cdp.emit({ method: 'Page.loadEventFired', sessionId: 'other' });
    cdp.emit({ method: 'Page.loadEventFired', sessionId: 'S1' });
    expect((await r.done).endedBy).toBe('duration');
  });

  it('with --until idle, asks for lifecycle events and stops when the network goes quiet', async () => {
    const { cdp } = browser();
    const r = await run({ until: 'idle' });
    expect(cdp.methods()).toContain('Page.setLifecycleEventsEnabled');
    cdp.emit({ method: 'Page.lifecycleEvent', params: { name: 'load' }, sessionId: 'S1' });
    cdp.emit({ method: 'Page.lifecycleEvent', params: { name: 'networkIdle' }, sessionId: 'S1' });
    expect((await r.done).endedBy).toBe('duration');
  });

  it('slows the CPU and disables the cache only when asked, and records both', async () => {
    const { cdp } = browser();
    const r = await run({ throttle: 4, cacheCold: true });
    const recording = await r.stop();
    const rates = cdp.calls.filter((c) => c.method === 'Emulation.setCPUThrottlingRate');
    expect(rates.map((c) => c.params['rate'])).toEqual([4]);
    expect(cdp.methods()).toContain('Network.setCacheDisabled');
    expect(recording).toMatchObject({ throttle: 4, cacheCold: true });
  });

  it('does not slow the CPU for a factor of 1', async () => {
    const { cdp } = browser();
    await run({ throttle: 1 });
    expect(cdp.methods()).not.toContain('Emulation.setCPUThrottlingRate');
  });

  it('marks a navigation of the main frame, scrubbed, and ignores frames and blank pages', async () => {
    const { cdp } = browser();
    const r = await run();
    const nav = (frame: object): void =>
      cdp.emit({ method: 'Page.frameNavigated', params: { frame }, sessionId: 'S1' });
    nav({ url: 'https://example.test/next?secret=1' });
    nav({ url: 'https://example.test/sub', parentId: 'P' });
    nav({ url: 'about:blank' });
    cdp.emit({
      method: 'Page.navigatedWithinDocument',
      params: { url: 'https://example.test/next#section' },
      sessionId: 'S1',
    });
    const recording = await r.stop();
    expect(recording.marks.map((m) => [m.kind, m.label])).toEqual([
      ['navigate', 'https://example.test/next'],
      ['navigate', 'https://example.test/next'],
    ]);
  });

  it('does not mark navigations when event marks are off', async () => {
    const { cdp } = browser();
    const r = await run({ eventMarks: false });
    cdp.emit({
      method: 'Page.frameNavigated',
      params: { frame: { url: 'https://example.test/x' } },
      sessionId: 'S1',
    });
    expect((await r.stop()).marks).toEqual([]);
  });

  it('records what the page reports through the bridge: events, marks, pause and resume, stop', async () => {
    const { cdp } = browser();
    const r = await run();
    bridge(cdp, { t: 'hello', frame: 'top' });
    bridge(cdp, { t: 'event', kind: 'click', label: 'button.save', seq: '1', at: 5, frame: 'top' });
    bridge(cdp, { t: 'control', action: 'mark', label: 'checkpoint' });
    bridge(cdp, { t: 'control', action: 'position:top-left' });
    bridge(cdp, { t: 'control', action: 'pause' });
    await vi.waitFor(() => expect(r.controller.state().phase).toBe('paused'));
    bridge(cdp, { t: 'event', kind: 'click', label: 'while paused' });
    bridge(cdp, { t: 'control', action: 'resume' });
    await vi.waitFor(() => expect(r.controller.state().phase).toBe('recording'));
    bridge(cdp, { t: 'control', action: 'stop' });
    const recording = await r.done;
    expect(recording.endedBy).toBe('stop');
    expect(recording.marks.map((m) => m.label)).toEqual(['button.save', 'checkpoint']);
    expect(recording.segments).toHaveLength(2);
  });

  it('shows the overlay its state, at the corner the user chose, and survives a page that went away', async () => {
    const { cdp } = browser();
    await run();
    bridge(cdp, { t: 'hello', frame: 'top' });
    bridge(cdp, { t: 'control', action: 'position:top-left' });
    const states = cdp.calls.filter(
      (c) => c.method === 'Runtime.evaluate' && String(c.params['expression']).includes('.state('),
    );
    expect(String(states.at(-1)?.params['expression'])).toContain('"position":"top-left"');
    const send = cdp.send.bind(cdp);
    cdp.send = (method, params, session) =>
      method === 'Runtime.evaluate'
        ? Promise.reject(new Error('gone'))
        : send(method, params, session);
    bridge(cdp, { t: 'control', action: 'mark', label: 'after the page went' });
  });

  it('sends the overlay nothing when the overlay is off', async () => {
    const { cdp } = browser();
    await run({ overlay: false });
    bridge(cdp, { t: 'hello', frame: 'top' });
    const states = cdp.calls.filter(
      (c) => c.method === 'Runtime.evaluate' && String(c.params['expression']).includes('.state('),
    );
    expect(states).toEqual([]);
  });

  it('ignores a bridge message that is not for it', async () => {
    const { cdp } = browser();
    const r = await run();
    cdp.emit({
      method: 'Runtime.bindingCalled',
      params: { name: 'other', payload: '{}' },
      sessionId: 'S1',
    });
    cdp.emit({
      method: 'Runtime.bindingCalled',
      params: { name: BRIDGE_NAME, payload: 'nope' },
      sessionId: 'S1',
    });
    expect(r.controller.state().phase).toBe('recording');
  });

  it('takes screenshots only while recording', async () => {
    const { cdp } = browser();
    const r = await run({ screenshots: true });
    await vi.waitFor(() => expect(cdp.methods()).toContain('Page.startScreencast'));
    await r.controller.pause();
    await vi.waitFor(() => expect(cdp.methods()).toContain('Page.stopScreencast'));
  });

  it('records the targets it saw with scrubbed URLs, and keeps queries when asked', async () => {
    const { cdp } = browser();
    const r = await run();
    cdp.emit({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'S2',
        waitingForDebugger: true,
        targetInfo: { targetId: 'F1', type: 'iframe', url: 'https://ads.test/frame?id=7' },
      },
    });
    cdp.emit({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'S3', targetInfo: { targetId: 'W1', type: 'worker', url: 'https://w' } },
    });
    cdp.emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { targetId: 'F1', type: 'iframe', url: 'https://ads.test/next?id=8' } },
    });
    const recording = await r.stop();
    expect(recording.targets).toEqual([
      { id: 'T1', type: 'page', url: '' },
      { id: 'F1', type: 'iframe', url: 'https://ads.test/next' },
    ]);
  });

  it('keeps every script it saw parsed, and names its session', async () => {
    const { cdp } = browser();
    const r = await run();
    cdp.emit({
      method: 'Debugger.scriptParsed',
      params: { scriptId: '9', url: 'https://example.test/app.js?v=3', hash: 'h' },
      sessionId: 'S1',
    });
    const recording = await r.stop();
    expect(recording.scripts).toMatchObject([
      { scriptId: '9', url: 'https://example.test/app.js', session: 'S1', targetType: 'page' },
    ]);
  });

  it('reports a trace the browser never handed over, and keeps what it had', async () => {
    const { cdp } = browser();
    const r = await run();
    const send = cdp.send.bind(cdp);
    cdp.send = (method, params, session) =>
      method === 'Tracing.end'
        ? Promise.reject(new Error('closed'))
        : send(method, params, session);
    const recording = await r.stop();
    expect(recording.warnings.map((w) => w.kind)).toContain('trace-incomplete');
  });

  it('kills the browser when something fails while starting', async () => {
    const { cdp, kill } = browser();
    const send = cdp.send.bind(cdp);
    cdp.send = (method, params, session) =>
      method === 'Tracing.start'
        ? Promise.reject(new Error('no tracing'))
        : send(method, params, session);
    await expect(startRecording(OPTIONS)).rejects.toThrow('no tracing');
    expect(kill).toHaveBeenCalled();
  });

  it('gives up with a clear message when the browser opens no page', async () => {
    vi.useFakeTimers();
    try {
      const { cdp } = browser();
      cdp.replies['Target.getTargets'] = { targetInfos: [] };
      const starting = startRecording(OPTIONS);
      const failed = expect(starting).rejects.toThrow(/opened no page/);
      await vi.advanceTimersByTimeAsync(20_001);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a browser the user started', () => {
  const join = (cdp: FakeCdp): void => {
    cdp.replies['Target.getTargets'] = {
      targetInfos: [
        { type: 'page', targetId: 'DEV', url: 'devtools://devtools/bundled/inspector.html' },
        { type: 'page', targetId: 'TAB', url: 'https://example.test/open' },
      ],
    };
    cdp.replies['Target.createTarget'] = { targetId: 'NEW' };
  };

  it('opens a tab of its own for a URL, and closes only that tab afterwards', async () => {
    const { cdp } = browser();
    join(cdp);
    const r = await run({ attach: { port: 9222 } });
    expect(cdp.calls.find((c) => c.method === 'Target.attachToTarget')?.params).toMatchObject({
      targetId: 'NEW',
    });
    await r.stop();
    expect(cdp.calls.find((c) => c.method === 'Target.closeTarget')?.params).toEqual({
      targetId: 'NEW',
    });
    expect(cdp.methods()).not.toContain('Browser.close');
    expect((cdp as unknown as { disconnect: () => void }).disconnect).toHaveBeenCalled();
  });

  it('records the first ordinary tab when no URL is given, and leaves it open', async () => {
    const { cdp } = browser();
    join(cdp);
    const r = await run({ attach: { port: 9222 }, url: '' });
    expect(cdp.calls.find((c) => c.method === 'Target.attachToTarget')?.params).toMatchObject({
      targetId: 'TAB',
    });
    expect(cdp.methods()).not.toContain('Page.navigate');
    await r.stop();
    expect(cdp.methods()).not.toContain('Target.closeTarget');
  });

  it('puts the tab back as it found it: no slowdown, cache on', async () => {
    const { cdp } = browser();
    join(cdp);
    const r = await run({ attach: { port: 9222 }, throttle: 6, cacheCold: true });
    await r.stop();
    const rates = cdp.calls.filter((c) => c.method === 'Emulation.setCPUThrottlingRate');
    expect(rates.map((c) => c.params['rate'])).toEqual([6, 1]);
    const cache = cdp.calls.filter((c) => c.method === 'Network.setCacheDisabled');
    expect(cache.map((c) => c.params['cacheDisabled'])).toEqual([true, false]);
  });
});
