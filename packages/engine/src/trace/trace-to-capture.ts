// Turns a Chrome trace (live from the capture host, or exported from DevTools) into the common
// capture shapes: one CPU profile per profiled thread, the exact events beside it, the page-level
// events (frames, loading milestones, layout shifts) and a clock anchor.

import type {
  BrowserInfo,
  CaptureMeta,
  CdpCallFrame,
  CdpProfile,
  CdpProfileNode,
  PageEvent,
  RawCapture,
  RawMark,
  RawTrack,
  ScriptInfo,
  TimelineEvent,
  TrackInfo,
  TrackKind,
} from '../raw.js';
import { anchorClock } from './clock-sync.js';
import type { BrowserRecordingInput, RecordedScript, TraceEventIn } from './types.js';

const THREAD_EVENTS = new Set([
  'RunTask',
  'EventDispatch',
  'FunctionCall',
  'EvaluateScript',
  'UpdateLayoutTree',
  'Layout',
  'PrePaint',
  'Paint',
  'Layerize',
  'Commit',
  'TimerFire',
  'FireAnimationFrame',
  'ParseHTML',
  'RunMicrotasks',
  'ResourceSendRequest',
]);

const PAGE_EVENTS = new Set([
  'DrawFrame',
  'BeginMainThreadFrame',
  'DroppedFrame',
  'navigationStart',
  'domContentLoadedEventEnd',
  'loadEventEnd',
  'firstPaint',
  'firstContentfulPaint',
  'largestContentfulPaint::Candidate',
  'LayoutShift',
]);

interface FrameInfo {
  url: string;
  parent: string | undefined;
  primary: boolean;
}

interface ProfileSegment {
  id: string;
  startTime: number;
  nodes: Array<{ id: number; parent?: number; callFrame: Record<string, unknown> }>;
  samples: number[];
  deltas: number[];
  /** Source line (1-based) of each sample, 0 when V8 gave none; aligned with `samples`. */
  lines: number[];
  firstTs: number;
}

interface ThreadProfile {
  pid: number;
  tid: number;
  segments: Map<string, ProfileSegment>;
}

const dataOf = (e: TraceEventIn): Record<string, unknown> =>
  ((e.args as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<
    string,
    unknown
  >;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const URL_PARTS = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;

function hostOf(url: string): string {
  return URL_PARTS.exec(url)?.[2] ?? '';
}

function originOf(url: string): string {
  const m = URL_PARTS.exec(url);
  return m && m[2] ? `${m[1]}://${m[2]}` : '';
}

function baseName(url: string): string {
  const path = url.split(/[?#]/)[0] ?? '';
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

/** One CPU profile from the profiles a thread recorded, one per trace segment. */
function mergeProfile(
  thread: ThreadProfile,
  scriptUrl: (scriptId: string) => string,
): CdpProfile | undefined {
  const segments = [...thread.segments.values()]
    .filter((s) => s.samples.length > 0)
    .sort((a, b) => a.startTime - b.startTime || a.firstTs - b.firstTs);
  if (segments.length === 0) return undefined;

  const nodes: CdpProfileNode[] = [];
  const byKey = new Map<string, number>();
  let nextId = 1;
  let rootId = 0;
  let idleId = 0;
  const samples: number[] = [];
  const deltas: number[] = [];
  const ticks = new Map<number, Map<number, number>>();
  const startTime = segments[0]?.startTime ?? 0;
  let clock = startTime;
  const interval = median(segments.flatMap((s) => s.deltas.filter((d) => d > 0))) || 1000;

  const addNode = (seg: ProfileSegment, raw: ProfileSegment['nodes'][number]): number => {
    const frame = raw.callFrame;
    const functionName = String(frame.functionName ?? '');
    const isRoot = functionName === '(root)' && raw.parent === undefined;
    const id = isRoot && rootId !== 0 ? rootId : nextId++;
    const scriptId = String(frame.scriptId ?? '0');
    const url = String(frame.url ?? '') || scriptUrl(scriptId);
    const callFrame: CdpCallFrame = {
      functionName,
      scriptId,
      url,
      lineNumber: typeof frame.lineNumber === 'number' ? frame.lineNumber : -1,
      columnNumber: typeof frame.columnNumber === 'number' ? frame.columnNumber : -1,
    };
    if (isRoot) {
      if (rootId === 0) {
        rootId = id;
        nodes.push({ id, callFrame });
      }
      byKey.set(`${seg.id}:${raw.id}`, rootId);
      return rootId;
    }
    byKey.set(`${seg.id}:${raw.id}`, id);
    nodes.push({ id, callFrame });
    return id;
  };

  const link = (parentId: number, childId: number): void => {
    const parent = nodes.find((n) => n.id === parentId);
    if (!parent) return;
    const kids = parent.children ?? (parent.children = []);
    if (!kids.includes(childId)) kids.push(childId);
  };

  segments.forEach((seg, index) => {
    for (const raw of seg.nodes) addNode(seg, raw);
    for (const raw of seg.nodes) {
      const child = byKey.get(`${seg.id}:${raw.id}`);
      const parent = raw.parent === undefined ? undefined : byKey.get(`${seg.id}:${raw.parent}`);
      if (child !== undefined && parent !== undefined && child !== parent) link(parent, child);
    }
    if (index > 0 && samples.length > 0) {
      // The gap between segments was paused: bill it to idle, not to the last function that ran.
      if (idleId === 0) {
        idleId = nextId++;
        nodes.push({
          id: idleId,
          callFrame: {
            functionName: '(idle)',
            scriptId: '0',
            url: '',
            lineNumber: -1,
            columnNumber: -1,
          },
        });
        link(rootId, idleId);
      }
      samples.push(idleId);
      deltas.push(interval);
      clock += interval;
    }
    let t = seg.startTime;
    seg.samples.forEach((sample, i) => {
      t += seg.deltas[i] ?? 0;
      const node = byKey.get(`${seg.id}:${sample}`) ?? rootId;
      samples.push(node);
      deltas.push(t - clock);
      clock = t;
      const line = seg.lines[i] ?? 0;
      if (line > 0) {
        const perLine = ticks.get(node) ?? new Map<number, number>();
        perLine.set(line, (perLine.get(line) ?? 0) + 1);
        ticks.set(node, perLine);
      }
    });
  });
  // The trace names a line for every sample; the engine reads them as V8's per-line ticks.
  for (const node of nodes) {
    const perLine = ticks.get(node.id);
    if (perLine) {
      node.positionTicks = [...perLine]
        .sort((a, b) => a[0] - b[0])
        .map(([line, n]) => ({ line, ticks: n }));
    }
  }
  return { nodes, startTime, endTime: clock, samples, timeDeltas: deltas };
}

interface Built {
  frames: Map<string, FrameInfo>;
  framePids: Map<string, Set<number>>;
}

export function recordingToCapture(input: BrowserRecordingInput): RawCapture {
  const events = input.events;
  const procName = new Map<number, string>();
  const threadName = new Map<string, string>();
  const known: Built = { frames: new Map(), framePids: new Map() };
  // A ProfileChunk is emitted by the profiler's own thread; the Profile event names the thread that
  // was profiled, so chunks are grouped by process and profile id and the thread comes from Profile.
  const segmentsByProfile = new Map<string, ProfileSegment>();
  const profileThread = new Map<string, { pid: number; tid: number; exact: boolean }>();
  const threadEvents = new Map<string, TimelineEvent[]>();
  const pageEvents: PageEvent[] = [];
  const stamps = new Map<string, number>();

  const noteFrame = (frame: Record<string, unknown>): void => {
    const id = String(frame.frame ?? '');
    if (!id) return;
    known.frames.set(id, {
      url: String(frame.url ?? ''),
      parent: typeof frame.parent === 'string' ? frame.parent : undefined,
      primary: frame.isInPrimaryMainFrame === true,
    });
    if (typeof frame.processId === 'number') {
      const pids = known.framePids.get(id) ?? new Set<number>();
      pids.add(frame.processId);
      known.framePids.set(id, pids);
    }
  };

  // A trace started on the browser has no frame list; the frames its events name tell which process
  // runs each one.
  const noteFramePid = (frame: unknown, pid: number): void => {
    if (typeof frame !== 'string' || frame === '') return;
    const pids = known.framePids.get(frame) ?? new Set<number>();
    pids.add(pid);
    known.framePids.set(frame, pids);
  };

  for (const e of events) {
    const data = dataOf(e);
    if (e.ph === 'M') {
      const name = String((e.args as { name?: unknown } | undefined)?.name ?? '');
      if (e.name === 'process_name') procName.set(e.pid, name);
      else if (e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, name);
      continue;
    }
    {
      const a = e.args as { frame?: unknown; beginData?: { frame?: unknown } } | undefined;
      noteFramePid(
        a?.frame ??
          data.frame ??
          a?.beginData?.frame ??
          (data.beginData as { frame?: unknown } | undefined)?.frame,
        e.pid,
      );
    }
    if (e.name === 'TracingStartedInBrowser') {
      const frames = data.frames;
      if (Array.isArray(frames)) for (const f of frames) noteFrame(f as Record<string, unknown>);
    } else if (e.name === 'FrameCommittedInBrowser') noteFrame(data);
    else if (e.name === 'Profile' || e.name === 'ProfileChunk') {
      const id = e.id ?? '0x0';
      const sid = `${e.pid}:${id}`;
      const seg: ProfileSegment = segmentsByProfile.get(sid) ?? {
        id,
        startTime: 0,
        nodes: [],
        samples: [],
        deltas: [],
        lines: [],
        firstTs: e.ts,
      };
      segmentsByProfile.set(sid, seg);
      const known = profileThread.get(sid);
      if (e.name === 'Profile') profileThread.set(sid, { pid: e.pid, tid: e.tid, exact: true });
      else if (!known) profileThread.set(sid, { pid: e.pid, tid: e.tid, exact: false });
      if (e.name === 'Profile' && typeof data.startTime === 'number')
        seg.startTime = data.startTime;
      const cpu = data.cpuProfile as
        { nodes?: ProfileSegment['nodes']; samples?: number[] } | undefined;
      if (cpu?.nodes) seg.nodes.push(...cpu.nodes);
      if (cpu?.samples) {
        seg.samples.push(...cpu.samples);
        const lines = Array.isArray(data.lines) ? (data.lines as number[]) : [];
        for (let i = 0; i < cpu.samples.length; i++) seg.lines.push(lines[i] ?? 0);
      }
      if (Array.isArray(data.timeDeltas)) seg.deltas.push(...(data.timeDeltas as number[]));
    } else if (e.name === 'TimeStamp') {
      const message = typeof data.message === 'string' ? data.message : '';
      const seq = /^paces:(?!sync:)(.+)$/.exec(message);
      if (seq?.[1] && !stamps.has(seq[1])) stamps.set(seq[1], e.ts);
    }
    if (THREAD_EVENTS.has(e.name) && (e.ph === 'X' || e.ph === 'I')) {
      const key = `${e.pid}:${e.tid}`;
      const list = threadEvents.get(key) ?? [];
      threadEvents.set(key, list);
      const before = (data.beginData ?? {}) as Record<string, unknown>;
      const arg =
        e.name === 'EventDispatch'
          ? String(data.type ?? '')
          : e.name === 'FunctionCall'
            ? String(data.functionName ?? '')
            : e.name === 'ResourceSendRequest'
              ? String(data.url ?? '')
              : '';
      const n =
        e.name === 'Layout'
          ? Number(before.dirtyObjects ?? 0)
          : e.name === 'UpdateLayoutTree'
            ? Number((e.args as { elementCount?: unknown } | undefined)?.elementCount ?? 0)
            : undefined;
      list.push({
        name: e.name,
        ts: e.ts,
        dur: e.dur ?? 0,
        ...(arg ? { arg } : {}),
        ...(n !== undefined ? { n } : {}),
      });
    } else if (PAGE_EVENTS.has(e.name)) {
      const frame =
        typeof (e.args as { frame?: unknown } | undefined)?.frame === 'string'
          ? String((e.args as { frame?: unknown }).frame)
          : '';
      const n =
        e.name === 'LayoutShift'
          ? Number(data.score ?? 0)
          : e.name === 'largestContentfulPaint::Candidate'
            ? Number(data.size ?? 0)
            : undefined;
      pageEvents.push({
        name: e.name,
        ts: e.ts,
        dur: e.dur ?? 0,
        pid: e.pid,
        ...(frame ? { arg: frame } : {}),
        ...(n !== undefined ? { n } : {}),
      });
    }
  }

  const profiles = new Map<string, ThreadProfile>();
  for (const [sid, seg] of segmentsByProfile) {
    const owner = profileThread.get(sid);
    if (!owner) continue;
    const key = `${owner.pid}:${owner.tid}`;
    const thread = profiles.get(key) ?? { pid: owner.pid, tid: owner.tid, segments: new Map() };
    profiles.set(key, thread);
    thread.segments.set(sid, seg);
  }

  const segments = input.segments ?? [];
  const sampleTimes = [...profiles.values()].flatMap((p) =>
    [...p.segments.values()].map((s) => s.startTime).filter((t) => t > 0),
  );
  const firstTs = sampleTimes.length > 0 ? Math.min(...sampleTimes) : (events[0]?.ts ?? 0);
  const clock = anchorClock(
    events,
    segments,
    input.unanchored ? { startedAt: input.startedAt, firstTs } : undefined,
  );

  const scripts: RecordedScript[] = input.scripts ?? [];
  const pagePids = new Set<number>();
  for (const thread of profiles.values()) {
    if (threadName.get(`${thread.pid}:${thread.tid}`) === 'CrRendererMain')
      pagePids.add(thread.pid);
  }

  const scriptsFor = (pid: number, worker: boolean): RecordedScript[] =>
    scripts.filter((s) => {
      if (worker) return (s.targetType ?? '').includes('worker');
      if (s.targetType !== 'page' && s.targetType !== 'iframe') return false;
      return s.targetId !== undefined && (known.framePids.get(s.targetId)?.has(pid) ?? false);
    });

  // The recorded targets name the frames; the processes that ran them are the page's own.
  for (const target of input.targets ?? []) {
    known.frames.set(target.id, {
      url: target.url,
      parent: target.type === 'page' ? undefined : 'target',
      primary: target.type === 'page',
    });
  }
  const ownPids = new Set<number>();
  for (const target of input.targets ?? []) {
    for (const pid of known.framePids.get(target.id) ?? []) ownPids.add(pid);
  }

  const tracks: RawTrack[] = [];
  for (const thread of profiles.values()) {
    // Another tab, an extension, a browser page: in the trace, but not what was profiled.
    if (ownPids.size > 0 && !ownPids.has(thread.pid)) continue;
    const name = threadName.get(`${thread.pid}:${thread.tid}`) ?? '';
    const isWorker = /worker/i.test(name);
    const isMain = name === 'CrRendererMain';
    const mine = scriptsFor(thread.pid, isWorker);
    const byId = new Map<string, RecordedScript>();
    for (const s of mine) byId.set(s.scriptId, s);
    const cpuProfile = mergeProfile(thread, (id) => byId.get(id)?.url ?? '');
    if (!cpuProfile) continue;

    const used = new Set(cpuProfile.nodes.map((n) => n.callFrame.scriptId));
    const trackScripts: ScriptInfo[] = mine
      .filter((s) => used.has(s.scriptId))
      .map((s) => ({
        scriptId: s.scriptId,
        url: s.url,
        sourceMapURL: s.sourceMapURL,
        hash: s.hash,
      }));

    const frameIds = [...known.framePids]
      .filter(([, pids]) => pids.has(thread.pid))
      .map(([f]) => f);
    const frames = frameIds.map((f) => ({ id: f, ...(known.frames.get(f) as FrameInfo) }));
    const primary = frames.filter((f) => f.primary).pop();
    const sub = frames.filter((f) => f.parent !== undefined).pop();
    let kind: TrackKind = 'process';
    let label = input.name
      ? `${input.name} · pid ${thread.pid} tid ${thread.tid}`
      : name || `thread ${thread.tid}`;
    let url = '';
    let frameId: string | undefined;
    if (isWorker) {
      kind = 'worker';
      const counts = new Map<string, number>();
      for (const n of cpuProfile.nodes) {
        const u = n.callFrame.url;
        if (u && !u.startsWith('paces://')) counts.set(u, (counts.get(u) ?? 0) + 1);
      }
      url = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      label = url ? `Worker · ${baseName(url)}` : `Worker · thread ${thread.tid}`;
    } else if (isMain) {
      const chosen = primary ?? sub ?? frames[frames.length - 1];
      url = chosen?.url ?? '';
      frameId = chosen?.id;
      const host = hostOf(url);
      if (url.startsWith('chrome-extension://')) {
        kind = 'extension';
        label = `Extension · ${host}`;
      } else if (!primary && sub) {
        kind = 'frame';
        label = `iframe · ${host}`;
      } else {
        kind = 'page';
        label = host ? `Page · ${host}` : 'Page';
      }
    }
    const info: TrackInfo = {
      id: `browser-${thread.pid}-${thread.tid}`,
      kind,
      label,
      pid: thread.pid,
      threadId: thread.tid,
      ...(url ? { url, origin: originOf(url) } : {}),
      ...(frameId ? { frameId } : {}),
    };
    const timeline = (threadEvents.get(`${thread.pid}:${thread.tid}`) ?? []).sort(
      (a, b) => a.ts - b.ts || b.dur - a.dur,
    );
    tracks.push({ info, cpuProfile, scripts: trackScripts, events: [], timeline });
  }

  const order: Record<string, number> = { page: 0, frame: 1, extension: 2, worker: 3, process: 4 };
  tracks.sort(
    (a, b) =>
      (order[a.info.kind] ?? 9) - (order[b.info.kind] ?? 9) ||
      (a.info.pid ?? 0) - (b.info.pid ?? 0) ||
      (a.info.threadId ?? 0) - (b.info.threadId ?? 0),
  );
  for (const t of tracks) {
    if (t.info.kind !== 'worker') continue;
    const page = tracks.find((p) => p.info.kind === 'page' && p.info.pid === t.info.pid);
    if (page) t.info.parent = page.info.id;
  }

  const marks: RawMark[] = (input.marks ?? []).map((m) => {
    const ts = m.seq !== undefined ? stamps.get(m.seq) : undefined;
    const at = ts !== undefined ? Math.round(((ts + clock.offsetUs) / 1000) * 1000) / 1000 : m.at;
    return {
      at,
      label: m.label,
      kind: m.kind,
      ...(m.seq !== undefined ? { seq: m.seq } : {}),
      ...(m.frame ? { frame: m.frame } : {}),
    };
  });

  const profiled = tracks.filter((t) => t.cpuProfile);
  const intervalUs =
    median(
      profiled.flatMap((t) => (t.cpuProfile?.timeDeltas ?? []).slice(1).filter((d) => d > 0)),
    ) || 1000;
  const meta: CaptureMeta = {
    command: ['browser', input.url],
    cwd: input.cwd ?? '',
    nodeVersion: input.product,
    platform: input.platform ?? 'browser',
    mode: 'default',
    intervalUs: Math.round(intervalUs),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    endedBy: input.endedBy,
    projectRoot: input.cwd ?? '',
    ...(marks.length > 0 ? { marks } : {}),
  };

  // A trace with no browser in it (a Node profile saved as a trace) is a plain profile.
  const isBrowser = known.frames.size > 0 || [...threadName.values()].includes('CrRendererMain');
  const browser: BrowserInfo = {
    product: input.product,
    url: input.url,
    firstParty: input.firstParty ?? [],
    clock,
    segments: segments.map((s) => ({ startUs: s.startUs, endUs: s.endUs })),
    ...(input.throttle ? { throttle: input.throttle } : {}),
    ...(input.cacheCold ? { cacheCold: true } : {}),
    page: pageEvents
      .filter((e) => pagePids.has(e.pid))
      .sort((a, b) => a.ts - b.ts || a.name.localeCompare(b.name)),
    screenshots: (input.screenshots ?? []).map((s) => ({
      id: s.id,
      tsUs: s.tsUs ?? (s.epochMs ?? 0) * 1000 - clock.offsetUs,
    })),
    ...(input.filter ? { traceFilter: input.filter } : {}),
  };
  return { meta, ...(isBrowser ? { browser } : {}), tracks, sourceMaps: input.sourceMaps ?? {} };
}

/**
 * A trace exported from the DevTools Performance panel: the same conversion, but nothing in the
 * file ties the trace clock to wall-clock time, so the start is a guess from the file's age.
 */
export function traceToCapture(
  events: TraceEventIn[],
  options: { name: string; cwd: string; mtimeMs: number; platform?: string },
): RawCapture {
  const stamps = events.filter((e) => e.ph !== 'M').map((e) => e.ts);
  const first = stamps.length > 0 ? Math.min(...stamps) : 0;
  const last = stamps.length > 0 ? Math.max(...stamps) : 0;
  const durationMs = (last - first) / 1000;
  return recordingToCapture({
    product: 'unknown',
    url: '',
    startedAt: Math.round(options.mtimeMs - durationMs),
    endedAt: Math.round(options.mtimeMs),
    endedBy: 'stop',
    events,
    segments: [{ startUs: first, endUs: last, hostStartMs: 0, syncs: [] }],
    cwd: options.cwd,
    name: options.name,
    ...(options.platform ? { platform: options.platform } : {}),
    unanchored: true,
  });
}
