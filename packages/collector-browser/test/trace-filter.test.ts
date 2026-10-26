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
});
