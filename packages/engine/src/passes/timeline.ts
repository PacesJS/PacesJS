// Pass 7b (browser pages): the exact side of the timeline. Rendering work, the user's input, frames,
// loading milestones, the filmstrip and the pauses come from trace events, not from samples, so
// they carry no `~`.

import { INPUT_KIND_NAMES } from '../model.js';
import type {
  FrameTimings,
  InputTable,
  PageTimeline,
  RenderTable,
  ScreenshotTable,
  TaskTable,
  TimeRanges,
  VitalTable,
} from '../model.js';
import type { BrowserInfo, CaptureMeta, PageEvent, TimelineEvent } from '../raw.js';
import { lowerBound } from '../util/search.js';
import type { PassContext } from './types.js';

const STYLE = 0;
const LAYOUT = 1;
const PAINT = 2;
const COMPOSITE = 3;
const PARSE = 4;
const SCRIPT = 5;

const RENDER_PHASE: Record<string, number> = {
  UpdateLayoutTree: STYLE,
  Layout: LAYOUT,
  PrePaint: PAINT,
  Paint: PAINT,
  Layerize: COMPOSITE,
  Commit: COMPOSITE,
  ParseHTML: PARSE,
  EvaluateScript: SCRIPT,
  FunctionCall: SCRIPT,
};
const JS = new Set(['EvaluateScript', 'FunctionCall']);
/** Input whose result the user waits for. */
const WAITED_ON = new Set(['click', 'submit', 'change', 'key']);
const TYPING = /\((\d+) keys?, ([\d.]+) s\)/;
const TYPING_QUIET_US = 500_000;

/** Rendering and script work of one thread, in model time. Style and layout run from script are forced. */
export function buildRender(events: TimelineEvent[], monoAtStartUs: number): RenderTable {
  const rows: Array<{ start: number; dur: number; phase: number; forced: number }> = [];
  const open: number[] = [];
  for (const e of events) {
    const phase = RENDER_PHASE[e.name];
    if (phase === undefined) continue;
    const start = e.ts - monoAtStartUs;
    while (open.length > 0 && (open[open.length - 1] ?? 0) <= start) open.pop();
    const inScript = open.length > 0;
    if (JS.has(e.name)) {
      // Only the outermost script event: a FunctionCall inside an EvaluateScript is the same time.
      if (!inScript) rows.push({ start, dur: e.dur, phase, forced: 0 });
      open.push(start + e.dur);
      continue;
    }
    rows.push({
      start,
      dur: e.dur,
      phase,
      forced: inScript && (phase === STYLE || phase === LAYOUT) ? 1 : 0,
    });
  }
  return {
    length: rows.length,
    start: Float64Array.from(rows, (r) => r.start),
    dur: Float64Array.from(rows, (r) => r.dur),
    phase: Uint8Array.from(rows, (r) => r.phase),
    forced: Uint8Array.from(rows, (r) => r.forced),
  };
}

/**
 * What the user did, as the page reported it. A click or key press runs from the start of its mark
 * to the end of the handler; the latency is the time until the next paint.
 */
export function buildInputs(
  marks: NonNullable<CaptureMeta['marks']>,
  startedAt: number,
  events: TimelineEvent[],
  monoAtStartUs: number,
  tasks: TaskTable,
  ctx: PassContext,
): InputTable {
  const dispatches = events
    .filter((e) => e.name === 'EventDispatch')
    .map((e) => ({ start: e.ts - monoAtStartUs, end: e.ts - monoAtStartUs + e.dur }));
  const paints = events
    .filter((e) => e.name === 'Paint')
    .map((e) => ({ start: e.ts - monoAtStartUs, end: e.ts - monoAtStartUs + e.dur }))
    .sort((a, b) => a.start - b.start);
  const paintStarts = Float64Array.from(paints, (p) => p.start);

  const rows: Array<{
    start: number;
    end: number;
    kind: number;
    label: string;
    task: number;
    latency: number;
  }> = [];
  for (const m of marks) {
    const kind = INPUT_KIND_NAMES.indexOf(
      (m.kind ?? 'manual') as (typeof INPUT_KIND_NAMES)[number],
    );
    if (kind < 0) continue;
    const at = (m.at - startedAt) * 1000;
    let start = at;
    let end = at;
    let latency = -1;
    const kindName = INPUT_KIND_NAMES[kind] ?? '';
    if (kindName === 'typing') {
      const typed = TYPING.exec(m.label);
      const burst = typed ? Number(typed[2]) * 1e6 : 0;
      end = at - TYPING_QUIET_US;
      start = end - burst;
    } else if (WAITED_ON.has(kindName)) {
      // The smallest handler that was running when the page reported the event.
      let best: { start: number; end: number } | undefined;
      for (const d of dispatches) {
        if (
          d.start - 1000 <= at &&
          at <= d.end &&
          (!best || d.end - d.start < best.end - best.start)
        ) {
          best = d;
        }
      }
      if (best) end = best.end;
      const next = lowerBound(paintStarts, best ? best.start : at);
      const paint = paints[next];
      if (paint) latency = paint.end - at;
    }
    let task = -1;
    for (let k = 0; k < tasks.length; k++) {
      if ((tasks.start[k] ?? 0) - 1000 <= at && at <= (tasks.end[k] ?? 0)) {
        task = k;
        break;
      }
    }
    rows.push({ start, end, kind, label: m.label, task, latency });
  }
  rows.sort((a, b) => a.start - b.start || a.kind - b.kind);
  return {
    length: rows.length,
    start: Float64Array.from(rows, (r) => r.start),
    end: Float64Array.from(rows, (r) => r.end),
    kind: Uint8Array.from(rows, (r) => r.kind),
    label: Uint32Array.from(rows, (r) => ctx.strings.intern(r.label)),
    task: Int32Array.from(rows, (r) => r.task),
    latency: Float64Array.from(rows, (r) => r.latency),
  };
}

const VITAL_OF: Record<string, number> = {
  navigationStart: 0,
  domContentLoadedEventEnd: 1,
  loadEventEnd: 2,
  firstContentfulPaint: 3,
  'largestContentfulPaint::Candidate': 4,
  LayoutShift: 5,
};

/** Two navigation or load events this close are one: a document and its initial blank one. */
const SAME_MOMENT_US = 50_000;
const ONCE_PER_DOCUMENT = new Set(['navigationStart', 'domContentLoadedEventEnd', 'loadEventEnd']);

/**
 * The milestones of the page itself: its main frame only (an iframe or an ad has its own loading story),
 * each once, and only the last largest-paint candidate of a navigation, since earlier ones were replaced.
 */
function milestoneEvents(events: PageEvent[]): PageEvent[] {
  const all = events.filter((e) => VITAL_OF[e.name] !== undefined);
  const main = all.find((e) => e.name === 'navigationStart')?.arg;
  const own = all.filter((e) => main === undefined || e.arg === undefined || e.arg === main);
  const out: PageEvent[] = [];
  const lastOf = new Map<string, number>();
  const navigations = own.filter((e) => e.name === 'navigationStart').map((e) => e.ts);
  const navigationOf = (ts: number): number => {
    let at = -1;
    for (const n of navigations) if (n <= ts) at = n;
    return at;
  };
  const lcp = new Map<number, PageEvent>();
  for (const e of own) {
    if (e.name === 'largestContentfulPaint::Candidate') {
      lcp.set(navigationOf(e.ts), e);
      continue;
    }
    if (ONCE_PER_DOCUMENT.has(e.name)) {
      const before = lastOf.get(e.name);
      if (before !== undefined && e.ts - before < SAME_MOMENT_US) continue;
      lastOf.set(e.name, e.ts);
    }
    out.push(e);
  }
  return [...out, ...lcp.values()];
}

/** Frames, loading milestones, the filmstrip and the stretches that were and were not recorded. */
export function buildPageTimeline(
  browser: BrowserInfo,
  pid: number | undefined,
  monoAtStartUs: number,
): PageTimeline {
  const mine = browser.page.filter((e) => pid === undefined || e.pid === pid);
  const rel = (ts: number): number => ts - monoAtStartUs;

  const begins = mine.filter((e) => e.name === 'BeginMainThreadFrame').map((e) => rel(e.ts));
  const dropped = mine.filter((e) => e.name === 'DroppedFrame').map((e) => rel(e.ts));
  const draws = mine.filter((e) => e.name === 'DrawFrame').map((e) => rel(e.ts));
  const frames: FrameTimings = {
    length: draws.length,
    start: new Float64Array(draws.length),
    end: Float64Array.from(draws),
    dropped: new Uint8Array(draws.length),
  };
  draws.forEach((end, i) => {
    const before = lowerBound(Float64Array.from(begins), end) - 1;
    const begin = begins[before];
    frames.start[i] = begin !== undefined && end - begin < 100_000 ? begin : end;
    const previous = draws[i - 1] ?? Number.NEGATIVE_INFINITY;
    frames.dropped[i] = dropped.some((d) => d > previous && d <= end) ? 1 : 0;
  });

  const vitalRows = milestoneEvents(mine)
    .map((e) => ({ time: rel(e.ts), kind: VITAL_OF[e.name] ?? 0, value: e.n ?? 0 }))
    .sort((a, b) => a.time - b.time || a.kind - b.kind);
  const vitals: VitalTable = {
    length: vitalRows.length,
    time: Float64Array.from(vitalRows, (v) => v.time),
    kind: Uint8Array.from(vitalRows, (v) => v.kind),
    value: Float64Array.from(vitalRows, (v) => v.value),
  };

  const shots = [...browser.screenshots].sort((a, b) => a.tsUs - b.tsUs || a.id - b.id);
  const screenshots: ScreenshotTable = {
    length: shots.length,
    time: Float64Array.from(shots, (s) => rel(s.tsUs)),
    id: Uint32Array.from(shots, (s) => s.id),
  };

  const segs = [...browser.segments].sort((a, b) => a.startUs - b.startUs);
  const recorded: TimeRanges = {
    length: segs.length,
    start: Float64Array.from(segs, (s) => rel(s.startUs)),
    end: Float64Array.from(segs, (s) => rel(s.endUs)),
  };
  const gaps: Array<[number, number]> = [];
  for (let i = 1; i < segs.length; i++) {
    gaps.push([rel(segs[i - 1]?.endUs ?? 0), rel(segs[i]?.startUs ?? 0)]);
  }
  const paused: TimeRanges = {
    length: gaps.length,
    start: Float64Array.from(gaps, (g) => g[0]),
    end: Float64Array.from(gaps, (g) => g[1]),
  };
  return { frames, vitals, screenshots, recorded, paused };
}
