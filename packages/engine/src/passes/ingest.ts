// Pass 1: CDP profiles -> raw call trees with absolute (model) timestamps, plus runtime events.

import type { EventTable, Samples } from '../model.js';
import type { CdpProfile, RawCapture, RawTrack } from '../raw.js';
import { depthsOf, subtreeEnds } from '../util/tree-columns.js';
import { alignClock } from './clock.js';
import type {
  AsyncRecords,
  FrameTable,
  IngestedTrack,
  IngestResult,
  PassContext,
  RawTicks,
  RawTree,
} from './types.js';

const PHASES = { init: 0, before: 1, after: 2, destroy: 3 } as const;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

interface FrameBuilder {
  index: Map<string, number>;
  name: number[];
  url: number[];
  line: number[];
  col: number[];
}

function emptyTree(frame: number): RawTree {
  return {
    length: 1,
    parent: Int32Array.of(-1),
    frame: Uint32Array.of(frame),
    depth: Uint16Array.of(0),
    subtreeEnd: Uint32Array.of(1),
    self: new Float64Array(1),
    total: new Float64Array(1),
    hits: new Uint32Array(1),
  };
}

function buildEvents(
  track: RawTrack,
  startedAt: number,
  ctx: PassContext,
): { events: EventTable; async: AsyncRecords } {
  const gc = track.events.filter((e) => e.type === 'gc');
  const loop = track.events.filter((e) => e.type === 'loop');
  const requests = track.events.filter((e) => e.type === 'request');
  const asyncEvents = track.events.filter((e) => e.type === 'async');
  const rel = (epochMs: number): number => (epochMs - startedAt) * 1000;
  const byTime = <T extends { time: number }>(list: T[]): T[] =>
    list
      .map((e, i) => ({ e, i }))
      .sort((a, b) => a.e.time - b.e.time || a.i - b.i)
      .map((x) => x.e);

  const gcSorted = byTime(gc);
  const loopSorted = byTime(loop);
  const reqSorted = byTime(requests);
  const asyncSorted = byTime(asyncEvents);
  const events: EventTable = {
    gc: {
      time: Float64Array.from(gcSorted, (e) => rel(e.time)),
      duration: Float64Array.from(gcSorted, (e) => e.duration * 1000),
      kind: Uint8Array.from(gcSorted, (e) => e.kind),
    },
    loop: {
      time: Float64Array.from(loopSorted, (e) => rel(e.time)),
      p50: Float64Array.from(loopSorted, (e) => e.p50 * 1000),
      p99: Float64Array.from(loopSorted, (e) => e.p99 * 1000),
      max: Float64Array.from(loopSorted, (e) => e.max * 1000),
    },
    requests: {
      time: Float64Array.from(reqSorted, (e) => rel(e.time)),
      duration: Float64Array.from(reqSorted, (e) => e.duration * 1000),
      label: Uint32Array.from(reqSorted, (e) => ctx.strings.intern(`${e.method} ${e.url}`)),
      status: Uint16Array.from(reqSorted, (e) => e.status),
    },
  };
  const async: AsyncRecords = {
    length: asyncSorted.length,
    time: Float64Array.from(asyncSorted, (e) => rel(e.time)),
    phase: Uint8Array.from(asyncSorted, (e) => PHASES[e.phase]),
    asyncId: Float64Array.from(asyncSorted, (e) => e.asyncId),
    triggerAsyncId: Float64Array.from(asyncSorted, (e) => e.triggerAsyncId),
  };
  return { events, async };
}

function buildTree(
  profile: CdpProfile,
  frameOf: (n: CdpProfile['nodes'][number]) => number,
): { tree: RawTree; indexOfId: Map<number, number>; order: number[] } {
  const nodes = profile.nodes;
  const byId = new Map<number, number>();
  nodes.forEach((n, i) => byId.set(n.id, i));
  const hasParent = new Uint8Array(nodes.length);
  for (const n of nodes) {
    for (const c of n.children ?? []) {
      const ci = byId.get(c);
      if (ci !== undefined) hasParent[ci] = 1;
    }
  }
  const rootIndex = Math.max(0, hasParent.indexOf(0));
  // Iterative preorder keeps the children in the order V8 listed them.
  const order: number[] = [];
  const parentOf: number[] = [];
  const stack: Array<[number, number]> = [[rootIndex, -1]];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    const [idx, parentPos] = entry;
    const pos = order.length;
    order.push(idx);
    parentOf.push(parentPos);
    const kids = nodes[idx]?.children ?? [];
    for (let k = kids.length - 1; k >= 0; k--) {
      const ci = byId.get(kids[k] ?? -1);
      if (ci !== undefined) stack.push([ci, pos]);
    }
  }
  const length = order.length;
  const parent = Int32Array.from(parentOf);
  const frame = new Uint32Array(length);
  const indexOfId = new Map<number, number>();
  for (let i = 0; i < length; i++) {
    const node = nodes[order[i] ?? 0];
    if (!node) continue;
    frame[i] = frameOf(node);
    indexOfId.set(node.id, i);
  }
  return {
    tree: {
      length,
      parent,
      frame,
      depth: depthsOf(parent),
      subtreeEnd: subtreeEnds(parent),
      self: new Float64Array(length),
      total: new Float64Array(length),
      hits: new Uint32Array(length),
    },
    indexOfId,
    order,
  };
}

function ingestTrack(
  track: RawTrack,
  capture: RawCapture,
  monoAtStartUs: number,
  frames: FrameBuilder,
  ctx: PassContext,
): { track: IngestedTrack; deltas: number[] } {
  const profile = track.cpuProfile;
  const { events, async } = buildEvents(track, capture.meta.startedAt, ctx);
  const frameFor = (key: string, name: string, url: string, line: number, col: number): number => {
    const found = frames.index.get(key);
    if (found !== undefined) return found;
    const id = frames.name.length;
    frames.index.set(key, id);
    frames.name.push(ctx.strings.intern(name));
    frames.url.push(ctx.strings.intern(url));
    frames.line.push(line);
    frames.col.push(col);
    return id;
  };

  if (!profile || profile.nodes.length === 0) {
    ctx.warnings.push({ kind: 'no-profile', severity: 'warn', detail: track.info.id });
    const root = frameFor('(root)||-1|-1', '(root)', '', -1, -1);
    return {
      deltas: [],
      track: {
        info: track.info,
        tree: emptyTree(root),
        samples: {
          length: 0,
          time: new Float64Array(0),
          node: new Uint32Array(0),
          dur: new Float64Array(0),
        },
        ticks: { offset: new Uint32Array(2), line: new Uint32Array(0), ticks: new Uint32Array(0) },
        events,
        async,
        scripts: track.scripts,
      },
    };
  }

  const { tree, indexOfId, order } = buildTree(profile, (n) => {
    const f = n.callFrame;
    return frameFor(
      `${f.functionName}|${f.url}|${f.lineNumber}|${f.columnNumber}`,
      f.functionName,
      f.url,
      f.lineNumber,
      f.columnNumber,
    );
  });

  const count = profile.samples.length;
  const time = new Float64Array(count);
  const node = new Uint32Array(count);
  const dur = new Float64Array(count);
  let t = profile.startTime;
  for (let i = 0; i < count; i++) {
    t += profile.timeDeltas[i] ?? 0;
    time[i] = t - monoAtStartUs;
    node[i] = indexOfId.get(profile.samples[i] ?? -1) ?? 0;
  }
  const deltas = profile.timeDeltas.slice(1).filter((d) => d > 0);
  const medianGap = median(deltas) || capture.meta.intervalUs;
  for (let i = 0; i < count; i++) {
    const next = i + 1 < count ? (time[i + 1] ?? 0) - (time[i] ?? 0) : medianGap;
    dur[i] = next > 0 ? next : 0;
  }

  for (let i = 0; i < count; i++) {
    const n = node[i] ?? 0;
    tree.self[n] = (tree.self[n] ?? 0) + (dur[i] ?? 0);
    tree.hits[n] = (tree.hits[n] ?? 0) + 1;
  }
  for (let i = tree.length - 1; i >= 0; i--) {
    tree.total[i] = (tree.total[i] ?? 0) + (tree.self[i] ?? 0);
    const p = tree.parent[i] ?? -1;
    if (p >= 0) tree.total[p] = (tree.total[p] ?? 0) + (tree.total[i] ?? 0);
  }

  const offset = new Uint32Array(tree.length + 1);
  const lines: number[] = [];
  const ticks: number[] = [];
  for (let i = 0; i < tree.length; i++) {
    offset[i] = lines.length;
    const pt = [...(profile.nodes[order[i] ?? 0]?.positionTicks ?? [])].sort(
      (a, b) => a.line - b.line,
    );
    for (const p of pt) {
      lines.push(p.line);
      ticks.push(p.ticks);
    }
  }
  offset[tree.length] = lines.length;
  const rawTicks: RawTicks = {
    offset,
    line: Uint32Array.from(lines),
    ticks: Uint32Array.from(ticks),
  };

  const samples: Samples = { length: count, time, node, dur };
  return {
    deltas,
    track: {
      info: track.info,
      tree,
      samples,
      ticks: rawTicks,
      events,
      async,
      scripts: track.scripts,
    },
  };
}

export function ingest(capture: RawCapture, ctx: PassContext): IngestResult {
  const clock = alignClock(capture);
  const frames: FrameBuilder = { index: new Map(), name: [], url: [], line: [], col: [] };
  const tracks: IngestedTrack[] = [];
  const allDeltas: number[] = [];
  for (const raw of capture.tracks) {
    const { track, deltas } = ingestTrack(raw, capture, clock.monoAtStartUs, frames, ctx);
    tracks.push(track);
    for (const d of deltas) allDeltas.push(d);
  }
  const measured = median(allDeltas);
  const frameTable: FrameTable = {
    length: frames.name.length,
    name: Uint32Array.from(frames.name),
    url: Uint32Array.from(frames.url),
    line: Int32Array.from(frames.line),
    col: Int32Array.from(frames.col),
  };
  return {
    frames: frameTable,
    tracks,
    precisionUs: Math.max(capture.meta.intervalUs, measured),
    durationUs: Math.max(0, (capture.meta.endedAt - capture.meta.startedAt) * 1000),
  };
}
