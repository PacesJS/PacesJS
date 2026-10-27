import { describe, expect, it } from 'vitest';
import { TRACE_NOISE_NAMES, createTraceFilter, scrubUrl } from '../src/trace-filter.js';
import type { TraceEvent } from '../src/trace.js';

const ev = (name: string, pid = 1, extra: Partial<TraceEvent> = {}): TraceEvent => ({
  name,
  cat: 'devtools.timeline',
  ph: 'X',
  ts: 10,
  dur: 5,
  pid,
  tid: 1,
  ...extra,
});

const meta = (pid: number, name: string): TraceEvent => ({
  name: 'process_name',
  ph: 'M',
  ts: 0,
  pid,
  tid: 0,
  args: { name },
});

describe('scrubUrl', () => {
  it('drops the query string and fragment', () => {
    expect(scrubUrl('https://a.test/p/q?token=abc#frag')).toBe('https://a.test/p/q');
  });

  it('leaves a URL with neither alone, and non-URLs untouched', () => {
    expect(scrubUrl('https://a.test/p')).toBe('https://a.test/p');
    expect(scrubUrl('click button "Save"')).toBe('click button "Save"');
  });
});

describe('createTraceFilter: response headers', () => {
  const response = (): TraceEvent =>
    ev('ResourceReceiveResponse', 1, {
      args: {
        data: {
          requestId: 'r1',
          statusCode: 200,
          headers: [{ name: 'set-cookie', value: 'session=hunter2' }],
        },
      },
    });

  it('drops the headers of a response and keeps the rest of it', () => {
    const [kept] = createTraceFilter({ keepQuery: false, full: false }).push([response()]);
    const data = (kept?.args as { data: Record<string, unknown> }).data;
    expect(data.headers).toBeUndefined();
    expect(data.statusCode).toBe(200);
  });

  it('drops them in a full trace too: nothing reads them and they can hold cookies', () => {
    const [kept] = createTraceFilter({ keepQuery: false, full: true }).push([response()]);
    expect(JSON.stringify(kept)).not.toContain('hunter2');
  });
});

describe('createTraceFilter', () => {
  it('drops events on the noise list and counts them by name', () => {
    const filter = createTraceFilter({ keepQuery: false, full: false });
    const kept = filter.push([
      ev('Layout'),
      ev('V8.BytecodeBudgetInterrupt'),
      ev('V8.BytecodeBudgetInterrupt'),
    ]);
    expect(kept.map((e) => e.name)).toEqual(['Layout']);
    expect(filter.stats()).toMatchObject({
      keptEvents: 1,
      droppedEvents: 2,
      droppedByName: { 'V8.BytecodeBudgetInterrupt': 2 },
    });
  });

  it('drops whole families of bookkeeping events by prefix', () => {
    const filter = createTraceFilter({ keepQuery: false, full: false });
    const kept = filter.push([
      ev('FrameLoader:state_snapshot'),
      ev('DocumentLoader::CommitData'),
      ev('Paint'),
    ]);
    expect(kept.map((e) => e.name)).toEqual(['Paint']);
  });

  it('drops RunTask events too short to matter, and keeps the others', () => {
    const filter = createTraceFilter({ keepQuery: false, full: false });
    const kept = filter.push([ev('RunTask', 1, { dur: 40 }), ev('RunTask', 1, { dur: 400 })]);
    expect(kept.map((e) => e.dur)).toEqual([400]);
    expect(filter.stats().droppedByName).toEqual({ RunTask: 1 });
  });

  it('the noise list names each event once', () => {
    expect(TRACE_NOISE_NAMES.length).toBeGreaterThan(0);
    expect(new Set(TRACE_NOISE_NAMES).size).toBe(TRACE_NOISE_NAMES.length);
  });

  it('always keeps metadata events', () => {
    const filter = createTraceFilter({ keepQuery: false, full: false });
    expect(filter.push([meta(1, 'Browser')])).toHaveLength(1);
  });

  it('keeps everything from renderers and only allowlisted events from other processes', () => {
    const filter = createTraceFilter({ keepQuery: false, full: false });
    const kept = filter.push([
      meta(1, 'Renderer'),
      meta(2, 'GPU Process'),
      ev('Layout', 1),
      ev('Layout', 2),
      ev('DrawFrame', 2),
    ]);
    expect(kept.filter((e) => e.ph !== 'M').map((e) => `${e.pid}:${e.name}`)).toEqual([
      '1:Layout',
      '2:DrawFrame',
    ]);
  });

  it('keeps events from a process whose role is not known yet', () => {
    const filter = createTraceFilter({ keepQuery: false, full: false });
    expect(filter.push([ev('Layout', 9)])).toHaveLength(1);
  });

  it('removes query strings and fragments from URLs in event arguments', () => {
    const filter = createTraceFilter({ keepQuery: false, full: false });
    const [kept] = filter.push([
      ev('ResourceSendRequest', 1, { args: { data: { url: 'https://a.test/x?secret=1#h' } } }),
    ]);
    expect(kept?.args).toEqual({ data: { url: 'https://a.test/x' } });
  });

  it('keeps query strings when asked to', () => {
    const filter = createTraceFilter({ keepQuery: true, full: false });
    const [kept] = filter.push([
      ev('ResourceSendRequest', 1, { args: { data: { url: 'https://a.test/x?k=1' } } }),
    ]);
    expect(kept?.args).toEqual({ data: { url: 'https://a.test/x?k=1' } });
  });

  it('keeps every event, noise and all, in full-trace mode', () => {
    const filter = createTraceFilter({ keepQuery: true, full: true });
    expect(
      filter.push([ev('V8.BytecodeBudgetInterrupt'), meta(2, 'GPU Process'), ev('Layout', 2)]),
    ).toHaveLength(3);
  });

  describe('with the frames that were recorded', () => {
    const own = new Set(['F-OURS']);
    const framed = (pid: number, frame: string, name = 'Layout'): TraceEvent =>
      ev(name, pid, { args: { data: { frame } } });

    it('drops the events of a renderer that runs none of them, once it knows which one does', () => {
      const filter = createTraceFilter({ keepQuery: false, full: false, ownFrames: () => own });
      const kept = filter.push([
        meta(1, 'Renderer'),
        meta(2, 'Extension Renderer'),
        framed(1, 'F-OURS'),
        framed(2, 'F-OTHER'),
        ev('Paint', 2),
        ev('Paint', 1),
      ]);
      expect(kept.filter((e) => e.ph !== 'M').map((e) => `${e.pid}:${e.name}`)).toEqual([
        '1:Layout',
        '1:Paint',
      ]);
    });

    it('counts what it dropped by name', () => {
      const filter = createTraceFilter({ keepQuery: false, full: false, ownFrames: () => own });
      filter.push([meta(1, 'Renderer'), meta(2, 'Renderer'), framed(1, 'F-OURS'), ev('Paint', 2)]);
      expect(filter.stats().droppedByName).toEqual({ Paint: 1 });
    });

    it('keeps every renderer while it does not yet know which one runs the frames', () => {
      const filter = createTraceFilter({ keepQuery: false, full: false, ownFrames: () => own });
      const kept = filter.push([meta(2, 'Renderer'), ev('Paint', 2)]);
      expect(kept.map((e) => e.name)).toEqual(['process_name', 'Paint']);
    });

    it('learns a renderer that gets one of the frames later, such as a new tab', () => {
      const frames = new Set(['F-OURS']);
      const filter = createTraceFilter({ keepQuery: false, full: false, ownFrames: () => frames });
      filter.push([meta(1, 'Renderer'), meta(3, 'Renderer'), framed(1, 'F-OURS')]);
      frames.add('F-TAB');
      const kept = filter.push([framed(3, 'F-TAB'), ev('Paint', 3)]);
      expect(kept.map((e) => e.name)).toEqual(['Layout', 'Paint']);
    });

    it('keeps everything in full-trace mode', () => {
      const filter = createTraceFilter({ keepQuery: true, full: true, ownFrames: () => own });
      const kept = filter.push([meta(2, 'Renderer'), framed(1, 'F-OURS'), ev('Paint', 2)]);
      expect(kept).toHaveLength(3);
    });
  });
});
